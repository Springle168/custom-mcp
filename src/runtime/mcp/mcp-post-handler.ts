import type { Request, Response } from 'express';
import {
  InitializeRequestSchema,
  JSONRPCRequestSchema,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeRulesConfig } from '../../config.js';
import {
  evaluateInitializeHeaderPolicy,
  InitializeHeaderPolicyError,
  type InitializeHeaderSettings,
} from '../request/initialize-header-policy.js';
import { runWithRequestHeaderContext } from '../request/request-context.js';
import { createStrictRequestHeaderView } from '../request/request-header-view.js';
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
  readonly rules: RuntimeRulesConfig;
  readonly createSession: (
    settings: InitializeHeaderSettings,
    requestId?: RequestId,
  ) => McpPendingSession;
  readonly isAcceptingNewSessions?: () => boolean;
}

/** SDK owns protocol validation; this entry owns policy selection and publication. */
export async function handleMcpPostRequest(
  options: HandleMcpPostRequestOptions,
): Promise<void> {
  const { req, res, sessions, logger } = options;
  const sessionId = getMcpSessionId(req);
  const view = createStrictRequestHeaderView(req.rawHeaders);
  const handle = (transport: McpPostTransport) => runWithRequestHeaderContext(
    view, () => transport.handleRequest(req, res, req.body),
  );

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
  let policy: ReturnType<typeof evaluateInitializeHeaderPolicy> | undefined;
  if (requestId !== undefined) {
    try {
      policy = evaluateInitializeHeaderPolicy(options.rules, view);
    } catch (error: unknown) {
      if (!(error instanceof InitializeHeaderPolicyError)) {
        sendInternalError(res, requestId);
        return;
      }
      safeInfo(logger, `Initialize policy rejected: ${error.ruleLocation}; ${error.category}`);
      res.status(400).json({
        jsonrpc: '2.0', id: requestId,
        error: { code: -32602, message: error.message },
      });
      return;
    }
  }

  const http = observeInitializationHttpCompletion(req, res);
  let session: McpPendingSession | undefined;
  let published = false;
  try {
    session = options.createSession(policy?.settings ?? {}, requestId);
    options.pendingSessions.add(session);
    // Ownership is registered before the first asynchronous connect. Close and
    // HTTP interruption or send rejection can terminate the entry even if the
    // SDK leaves handleRequest or its HTTP stream pending.
    const stopped = Promise.race([
      http.interrupted,
      session.closed,
      session.transport.initializationSendRejected,
    ]).then(() => false);
    if (!await Promise.race([session.connect().then(() => true), stopped])) {
      return;
    }
    if (!await Promise.race([Promise.resolve(handle(session.transport)).then(() => true), stopped])) {
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
    if (policy?.metadata.rulesConfigured) {
      const applied = policy.metadata.appliedRules;
      const summary = applied.length === 0
        ? 'none'
        : applied.map((rule) => `${rule.ruleLocation}: ${rule.feature}`).join(', ');
      safeInfo(logger, `Session policy: ${sid}; ${summary}`);
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
      jsonrpc: '2.0', id: requestId ?? null,
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
