import express, { type Express, type Request } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ConfigStore } from '../application/config-store.js';
import type { ToolCallDiagnosticSink, ToolCallLogger } from '../invocation/tool-call-handler.js';
import type { WorkspaceToolService } from '../../tools/index.js';
import { generateMcpSessionId } from './mcp-identifiers.js';
import { handleMcpPostRequest, type McpPostLogger, type McpPostSession } from './mcp-post-handler.js';
import { createMCPServer } from './mcp-server.js';

export interface CreateMcpHttpAppOptions {
  readonly configStore: ConfigStore;
  readonly toolService: WorkspaceToolService;
  readonly logger: ToolCallLogger & McpPostLogger;
  readonly sessions: Map<string, McpPostSession>;
  readonly isAcceptingNewSessions: () => boolean;
  readonly closeSession: (sessionId: string) => Promise<void>;
  readonly onToolCallDiagnostic?: ToolCallDiagnosticSink;
}

/** Wires HTTP transport sessions to the application-owned workspace service and lifecycle. */
export function createMcpHttpApp(options: CreateMcpHttpAppOptions): Express {
  const { configStore, toolService, logger, sessions } = options;
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    await handleMcpPostRequest({
      req,
      res,
      sessions,
      logger,
      isAcceptingNewSessions: options.isAcceptingNewSessions,
      createSession: async () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: generateMcpSessionId,
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            logger.info(`Session disconnected: ${sid}`);
            sessions.delete(sid);
          }
        };

        const server = createMCPServer({
          configStore,
          logger,
          toolService,
          ...(options.onToolCallDiagnostic === undefined
            ? {}
            : { onToolCallDiagnostic: options.onToolCallDiagnostic }),
        });
        await server.connect(transport);
        return { transport, server };
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
      logger.info(`Unknown MCP session on GET: ${sessionId}`);
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
      logger.info(`Unknown MCP session on DELETE: ${sessionId}`);
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }
    await session.transport.handleRequest(req, res);
    await options.closeSession(sessionId);
    logger.info(`Session closed: ${sessionId}`);
  });

  return app;
}

function getMcpSessionId(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}
