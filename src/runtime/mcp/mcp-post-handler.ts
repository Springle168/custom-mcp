import type { Request, Response } from 'express';
import {
  InitializeRequestSchema,
  JSONRPCRequestSchema,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  McpSessionOptions,
  RuntimeExtensions,
  SessionPreparation,
} from '../runtime-extensions.js';
import { observeInitializationHttpCompletion } from './initialization-http-completion.js';
import type { McpPendingSession } from './pending-session.js';

export interface McpPostTransport {
  readonly sessionId?: string;
  handleRequest(req: Request, res: Response, body?: unknown): Promise<void> | void;
}

export interface McpPostServer {
  close(): Promise<void> | void;
}

export interface McpPostSession {
  readonly transport: McpPostTransport;
  readonly server: McpPostServer;
  close?(): Promise<void>;
}

export interface McpPostLogger {
  info(message: string): void;
}

export interface HandleMcpPostRequestOptions {
  readonly req: Request;
  readonly res: Response;
  readonly sessions: Map<string, McpPostSession>;
  readonly pendingSessions: Set<McpPendingSession>;
  readonly logger: McpPostLogger;
  readonly defaultSessionOptions: McpSessionOptions;
  readonly extensions?: RuntimeExtensions;
  readonly createSession: (settings: McpSessionOptions, requestId?: RequestId) => McpPendingSession;
  readonly isAcceptingNewSessions?: () => boolean;
}

/** SDK owns protocol validation; this entry owns session preparation and publication. */
export async function handleMcpPostRequest(options: HandleMcpPostRequestOptions): Promise<void> {
  const { req, res, sessions, logger } = options;
  const sessionId = getMcpSessionId(req);
  const handle = (transport: McpPostTransport) => {
    const action = () => transport.handleRequest(req, res, req.body);
    return options.extensions?.runWithPostContext
      ? options.extensions.runWithPostContext(req.rawHeaders, action)
      : action();
  };

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      await handle(session.transport);
    } else {
      safeInfo(logger, `Unknown MCP session on POST: ${sessionId}`);
      res.status(404).end();
    }
    return;
  }
  if (options.isAcceptingNewSessions?.() === false) {
    res.status(503).end();
    return;
  }

  const requestId = getInitializeRequestId(req.body);
  let preparation: Extract<SessionPreparation, { accepted: true }> = {
    accepted: true,
    options: options.defaultSessionOptions,
  };
  if (requestId !== undefined && options.extensions?.prepareSession) {
    try {
      const result = options.extensions.prepareSession(
        req.rawHeaders,
        options.defaultSessionOptions,
      );
      if (!result.accepted) {
        res.status(400).json({
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32602, message: result.message },
        });
        return;
      }
      preparation = result;
    } catch {
      sendInternalError(res, requestId);
      return;
    }
  }

  const http = observeInitializationHttpCompletion(req, res);
  let session: McpPendingSession | undefined;
  let published = false;
  try {
    session = options.createSession(preparation.options, requestId);
    options.pendingSessions.add(session);
    // Ownership is registered before the first asynchronous connect. Close and
    // HTTP interruption or send rejection can terminate the entry even if the
    // SDK leaves handleRequest or its HTTP stream pending.
    const stopped = Promise.race([
      http.interrupted,
      session.closed,
      session.transport.initializationSendRejected,
    ]).then(() => false);
    if (!(await Promise.race([session.connect().then(() => true), stopped]))) {
      return;
    }
    if (
      !(await Promise.race([Promise.resolve(handle(session.transport)).then(() => true), stopped]))
    ) {
      return;
    }
    const normalHttp = await Promise.race([http.completed, stopped]);
    if (!normalHttp || requestId === undefined) {
      return;
    }
    const committed = await Promise.race([session.transport.waitForInitialization(), stopped]);
    const sid = session.transport.sessionId;
    if (!committed || !sid || session.isClosed || options.isAcceptingNewSessions?.() === false) {
      return;
    }

    // No await between the admission check and pending -> routable transfer.
    options.pendingSessions.delete(session);
    sessions.set(sid, session);
    published = true;
    session.transport.stopInitializationTracking();
    safeInfo(logger, `New session: ${sid}`);
    if (preparation.onPublished) {
      try {
        void Promise.resolve(preparation.onPublished(sid)).catch(() => {});
      } catch {
        // Observation cannot block the handshake or undo published ownership.
      }
    }
  } catch {
    // SDK exceptions and logger failures never reflect arbitrary objects or
    // client input into the initialize response.
    sendInternalError(res, requestId);
  } finally {
    http.dispose();
    if (session !== undefined && !published) {
      if (!res.writableEnded && !res.destroyed) {
        if (!res.headersSent) {
          res.status(options.isAcceptingNewSessions?.() === false ? 503 : 500);
        }
        res.end();
      }
      try {
        await session.close();
      } catch {
        safeInfo(logger, 'Failed to close unpublished MCP session.');
      } finally {
        options.pendingSessions.delete(session);
      }
    }
  }
}

function getInitializeRequestId(body: unknown): RequestId | undefined {
  const candidate = Array.isArray(body) && body.length === 1 ? body[0] : body;
  const envelope = JSONRPCRequestSchema.safeParse(candidate);
  return envelope.success && InitializeRequestSchema.safeParse(candidate).success
    ? envelope.data.id
    : undefined;
}

function getMcpSessionId(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

function sendInternalError(res: Response, requestId: RequestId | undefined): void {
  if (!res.headersSent && !res.destroyed) {
    res.status(500).json({
      jsonrpc: '2.0',
      id: requestId ?? null,
      error: { code: -32603, message: 'Internal initialization error' },
    });
  } else if (!res.writableEnded) {
    res.end();
  }
}

export function safeInfo(logger: McpPostLogger, message: string): void {
  try {
    void Promise.resolve(logger.info(message)).catch(() => {});
  } catch {
    // Logging is observational, including during publication and cleanup.
  }
}
