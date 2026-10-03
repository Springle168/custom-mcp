import express, { type Express, type Request } from 'express';
import type { ConfigStore } from '../application/config-store.js';
import type { ToolCallDiagnosticSink, ToolCallLogger } from '../invocation/tool-call-handler.js';
import type { WorkspaceToolService } from '../../tools/index.js';
import { generateMcpSessionId } from './mcp-identifiers.js';
import {
  handleMcpPostRequest,
  safeInfo,
  type McpPostLogger,
  type McpPostSession,
} from './mcp-post-handler.js';
import { createMCPServer } from './mcp-server.js';
import { InitializationTrackingTransport } from './initialization-tracking-transport.js';
import { createPendingSession, type McpPendingSession } from './pending-session.js';
import type { RuntimeExtensions } from '../runtime-extensions.js';

export interface CreateMcpHttpAppOptions {
  readonly configStore: ConfigStore;
  readonly toolService: WorkspaceToolService;
  readonly logger: ToolCallLogger & McpPostLogger;
  readonly sessions: Map<string, McpPostSession>;
  readonly pendingSessions: Set<McpPendingSession>;
  readonly isAcceptingNewSessions: () => boolean;
  readonly closeSession: (sessionId: string) => Promise<void>;
  readonly onToolCallDiagnostic?: ToolCallDiagnosticSink;
  readonly extensions?: RuntimeExtensions;
}

/** Wires HTTP transport sessions to the application-owned workspace service and lifecycle. */
export function createMcpHttpApp(options: CreateMcpHttpAppOptions): Express {
  const { configStore, toolService, logger, sessions, pendingSessions } = options;
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    await handleMcpPostRequest({
      req,
      res,
      sessions,
      pendingSessions,
      logger,
      defaultSessionOptions: { toolService },
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
      isAcceptingNewSessions: options.isAcceptingNewSessions,
      createSession: (settings, requestId) => {
        const server = createMCPServer({
          configStore,
          logger,
          toolService: settings.toolService,
          instructions: settings.instructions,
          ...(options.extensions?.prepareToolResult === undefined
            ? {}
            : { prepareToolResult: options.extensions.prepareToolResult }),
          ...(options.onToolCallDiagnostic === undefined
            ? {}
            : { onToolCallDiagnostic: options.onToolCallDiagnostic }),
        });
        const transport = new InitializationTrackingTransport(
          {
            sessionIdGenerator: generateMcpSessionId,
          },
          requestId,
        );
        const session = createPendingSession(server, transport, () => {
          const sid = transport.sessionId;
          // Unpublished SDK ids stay out of logs and routing.
          if (sid && sessions.get(sid) === session) {
            sessions.delete(sid);
            safeInfo(logger, `Session disconnected: ${sid}`);
          }
        });
        return session;
      },
    });
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = getMcpSessionId(req);
    if (!sessionId) {
      res.status(400).json({ error: 'Missing session ID' });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      // A 404 prompts Streamable HTTP clients to reinitialize stale sessions.
      safeInfo(logger, `Unknown MCP session on GET: ${sessionId}`);
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }
    await session.transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = getMcpSessionId(req);
    if (!sessionId) {
      res.status(400).json({ error: 'Missing session ID' });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      safeInfo(logger, `Unknown MCP session on DELETE: ${sessionId}`);
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }
    await session.transport.handleRequest(req, res);
    await options.closeSession(sessionId);
    safeInfo(logger, `Session closed: ${sessionId}`);
  });

  return app;
}

function getMcpSessionId(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}
