import type { Request, Response } from 'express';
import { runWithRequestHeaderContext } from './request-context.js';
import { createStrictRequestHeaderView } from './request-header-view.js';

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
}

export interface McpPostLogger {
  info(message: string): void;
}

export interface HandleMcpPostRequestOptions {
  readonly req: Request;
  readonly res: Response;
  readonly sessions: Map<string, McpPostSession>;
  readonly logger: McpPostLogger;
  readonly createSession: () => Promise<McpPostSession> | McpPostSession;
}

export async function handleMcpPostRequest(
  options: HandleMcpPostRequestOptions,
): Promise<void> {
  const { req, res, sessions, logger } = options;
  const sessionId = getMcpSessionId(req);

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      await handleTransportRequestWithHeaderContext(session.transport, req, res);
      return;
    }

    logger.info(`Unknown MCP session on POST: ${sessionId}`);
    res.status(404).end();
    return;
  }

  const session = await options.createSession();
  await handleTransportRequestWithHeaderContext(session.transport, req, res);

  if (session.transport.sessionId) {
    sessions.set(session.transport.sessionId, session);
    logger.info(`New session: ${session.transport.sessionId}`);
  }
}

function getMcpSessionId(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

async function handleTransportRequestWithHeaderContext(
  transport: McpPostTransport,
  req: Request,
  res: Response,
): Promise<void> {
  const view = createStrictRequestHeaderView(req.rawHeaders);
  await runWithRequestHeaderContext(view, () => transport.handleRequest(req, res, req.body));
}
