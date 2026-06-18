#!/usr/bin/env node

import express, { type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CliError, parseCliArgs } from './cli.js';
import { ConfigError, loadRuntimeConfigWithIdentity } from './config.js';
import { createConfigStore, type ConfigStore } from './runtime/config-store.js';
import { createToolCallRequestHandler } from './runtime/tool-call-handler.js';
import { getAllToolDefinitions, routeToolCall } from './tools/index.js';
import { Logger } from './utils/logger.js';
import { pendingQuestions, generateQuestionForm } from './tools/ask-user.js';

// ================
// MCP Server Factory
// ================

function createMCPServer(configStore: ConfigStore, logger: Logger): Server {
  const server = new Server(
    { name: 'custom-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAllToolDefinitions(),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    createToolCallRequestHandler({ configStore, logger, routeToolCall }),
  );

  return server;
}

function logWorkspaceRoots(configStore: ConfigStore, logger: Logger): void {
  const { pathSafetyContext } = configStore.getSnapshot();
  const primaryRoot = pathSafetyContext.primaryRoot.rootDir;
  const additionalRoots = pathSafetyContext.allowedRoots
    .filter((root) => root.kind === 'additional')
    .map((root) => root.rootDir);

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

function getMcpSessionId(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

function formatConfigStartupError(error: ConfigError): string {
  const lines = ['Failed to load configuration.', `Reason: ${error.message}`];

  if (error.configFilePath) {
    lines.push(`Config file: ${error.configFilePath}`);
  }

  if (error.fieldPath) {
    lines.push(`Field: ${error.fieldPath}`);
  }

  if (error.suggestion) {
    lines.push('', 'Next step:', indentBlock(error.suggestion));
  }

  return lines.join('\n');
}

function formatCliStartupError(error: CliError): string {
  const lines = ['Failed to parse command line arguments.', `Reason: ${error.message}`];

  if (error.suggestion) {
    lines.push('', 'Next step:', indentBlock(error.suggestion));
  }

  return lines.join('\n');
}

function indentBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join('\n');
}

// ================
// HTTP + Session Management
// ================

async function main() {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  const initialConfig = loadRuntimeConfigWithIdentity({
    ...(cliOptions.workspaceId !== undefined ? { workspaceId: cliOptions.workspaceId } : {}),
  });
  const initialSnapshot = initialConfig.snapshot;
  const configStore = createConfigStore(initialConfig);
  const logger = new Logger(initialSnapshot.logsDir, {
    workspaceId: initialSnapshot.workspaceId,
  });

  const app = express();
  app.use(express.json());
  // 解析表单数据
  app.use(express.urlencoded({ extended: true }));

  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  // Unknown session IDs return 404 so Streamable HTTP clients can treat them as
  // stale and reinitialize after a server restart.

  // POST /mcp — JSON-RPC 请求
  app.post('/mcp', async (req, res) => {
    const sessionId = getMcpSessionId(req);

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) {
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      logger.info(`Unknown MCP session on POST: ${sessionId}`);
      res.status(404).end();
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

    const server = createMCPServer(configStore, logger);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    if (transport.sessionId) {
      sessions.set(transport.sessionId, { transport, server });
      logger.info(`New session: ${transport.sessionId}`);
    }
  });

  // GET /mcp — SSE 通道
  app.get('/mcp', async (req, res) => {
    const sessionId = getMcpSessionId(req);
    if (!sessionId) {
      res.status(400).json({ error: 'Missing session ID' });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      logger.info(`Unknown MCP session on GET: ${sessionId}`);
      res.status(404).json({ error: 'Session not found or expired' });
      return;
    }
    await session.transport.handleRequest(req, res);
  });

  // DELETE /mcp — 会话终止
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
  app.listen(initialSnapshot.port, () => {
    logger.info('MCP Replace Server started');
    logger.info(`  Endpoint: http://localhost:${initialSnapshot.port}/mcp`);
    logger.info(`  Workspace id: ${initialSnapshot.workspaceId}`);
    logger.info(`  Selection mode: ${initialConfig.identity.selectionMode}`);
    logger.info(`  Snapshot version: ${initialSnapshot.snapshotVersion}`);
    logger.info(`  Config file: ${initialSnapshot.configFilePath}`);
    logWorkspaceRoots(configStore, logger);
    logger.info(`  Line ending: ${initialSnapshot.lineEnding}`);
    logger.info(`  Log file: ${logger.logFile}`);
  });
}

main().catch((err) => {
  if (err instanceof CliError) {
    console.error(formatCliStartupError(err));
  } else if (err instanceof ConfigError) {
    console.error(formatConfigStartupError(err));
  } else {
    console.error('Failed to start server:', err);
  }

  process.exit(1);
});
