import express from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, type Config } from './config.js';
import { getAllToolDefinitions, routeToolCall } from './tools/index.js';
import { Logger } from './utils/logger.js';

// ================
// MCP Server Factory
// ================

function createMCPServer(config: Config, logger: Logger): Server {
  const server = new Server(
    { name: 'custom-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAllToolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, unknown>;
    const startTime = Date.now();

    logger.logToolCall(name, safeArgs);

    const result = await routeToolCall(name, safeArgs, config);

    logger.logToolResult(name, result, Date.now() - startTime);
    return result;
  });

  return server;
}

// ================
// HTTP + Session Management
// ================

async function main() {
  const config = loadConfig();
  const logger = new Logger();

  const app = express();
  app.use(express.json());

  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  // POST /mcp — JSON-RPC 请求
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        logger.info(`Session disconnected: ${sid}`);
        sessions.delete(sid);
      }
    };

    const server = createMCPServer(config, logger);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    if (transport.sessionId) {
      sessions.set(transport.sessionId, { transport, server });
      logger.info(`New session: ${transport.sessionId}`);
    }
  });

  // GET /mcp — SSE 通道
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    await sessions.get(sessionId)!.transport.handleRequest(req, res);
  });

  // DELETE /mcp — 会话终止
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
    await session.server.close();
    sessions.delete(sessionId);
    logger.info(`Session closed: ${sessionId}`);
  });

  // 启动
  app.listen(config.port, () => {
    logger.info('MCP Replace Server started');
    logger.info(`  Endpoint: http://localhost:${config.port}/mcp`);
    logger.info(`  Root dir: ${config.rootDir}`);
    logger.info(`  Line ending: ${config.lineEnding}`);
    logger.info(`  Log file: ${logger.logFile}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});