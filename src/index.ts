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
import { pendingQuestions, generateQuestionForm } from './tools/ask-user.js';

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

function logWorkspaceRoots(config: Config, logger: Logger): void {
  const primaryRoot = config.pathSafetyContext?.primaryRoot.rootDir ?? config.rootDir;
  const additionalRoots = config.pathSafetyContext
    ? config.pathSafetyContext.allowedRoots
        .filter((root) => root.kind === 'additional')
        .map((root) => root.rootDir)
    : config.otherRootDirs ?? [];

  logger.info(`  Primary root: ${primaryRoot}`);

  if (additionalRoots.length === 0) {
    logger.info('  Additional roots: none');
    return;
  }

  logger.info('  Additional roots:');
  for (const rootDir of additionalRoots) {
    logger.info(`    - ${rootDir}`);
  }
}

// ================
// HTTP + Session Management
// ================

async function main() {
  const config = loadConfig();
  const logger = new Logger();

  const app = express();
  app.use(express.json());
  // 解析表单数据
  app.use(express.urlencoded({ extended: true }));

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

  // ================
  // ask_user 路由
  // ================

  // GET /ask/:sessionId — 渲染问题表单
  app.get('/ask/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const pending = pendingQuestions.get(sessionId);

    if (!pending) {
      res.status(404).send('<h1>Session not found or expired</h1>');
      return;
    }

    const html = generateQuestionForm(sessionId, pending.questions);
    res.send(html);
  });

  // POST /answer/:sessionId — 接收答案
  app.post('/answer/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const pending = pendingQuestions.get(sessionId);

    if (!pending) {
      res.status(404).send('<h1>Session not found or expired</h1>');
      return;
    }

    // 解析答案
    const answers: Record<string, { answer: string; note?: string }> = {};

    for (let i = 0; i < pending.questions.length; i++) {
      const question = pending.questions[i];
      const answerKey = `question_${i}`;
      const noteKey = `note_${i}`;

      let answerValue: string;

      if (question.type === 'choice' && question.multiSelect) {
        // 多选：可能是数组或单个值
        const values = req.body[answerKey];
        if (Array.isArray(values)) {
          answerValue = values.join('\n');
        } else {
          answerValue = values || '';
        }
      } else {
        // 单选或文本
        answerValue = req.body[answerKey] || '';
      }

      const noteValue = req.body[noteKey]?.trim();

      answers[i.toString()] = {
        answer: answerValue,
        ...(noteValue && { note: noteValue }),
      };
    }

    // Resolve Promise
    pending.resolve({ answers });

    res.send(`
      <h1>Submitted</h1>
      <p>Your answers have been recorded. You can close this window.</p>
    `);
  });

  // POST /cancel/:sessionId — 取消
  app.post('/cancel/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const pending = pendingQuestions.get(sessionId);

    if (!pending) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Resolve with null
    pending.resolve(null);

    res.json({ success: true });
  });

  // 启动
  app.listen(config.port, () => {
    logger.info('MCP Replace Server started');
    logger.info(`  Endpoint: http://localhost:${config.port}/mcp`);
    logWorkspaceRoots(config, logger);
    logger.info(`  Line ending: ${config.lineEnding}`);
    logger.info(`  Log file: ${logger.logFile}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
