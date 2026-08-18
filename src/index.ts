#!/usr/bin/env node

import express, { type Request } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CliError, parseCliArgs } from './cli.js';
import { ConfigError, loadRuntimeConfigWithIdentity } from './config.js';
import { createConfigStore, type ConfigStore } from './runtime/config-store.js';
import { createMCPServer } from './runtime/mcp-server.js';
import {
  handleMcpPostRequest,
  type McpPostSession,
} from './runtime/mcp-post-handler.js';
import { generateMcpSessionId } from './runtime/mcp-identifiers.js';
import { formatFileAccessPolicyStartupLines } from './runtime/startup-logging.js';
import { createWorkspaceToolService } from './tools/index.js';
import { registerAskUserRoutes } from './tools/ask-user-routes.js';
import { Logger } from './utils/logger.js';
import { buildHttpUrl, formatHostPort } from './utils/http-url.js';

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

async function main() {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  const initialConfig = loadRuntimeConfigWithIdentity({
    workspaceId: cliOptions.workspaceId,
  });
  const initialSnapshot = initialConfig.snapshot;
  const configStore = createConfigStore(initialConfig);
  const toolService = createWorkspaceToolService(initialSnapshot.toolExposure);
  const logger = new Logger(initialSnapshot.logsDir, {
    workspaceId: initialSnapshot.workspaceId,
  });

  const app = express();
  app.use(express.json());
  registerAskUserRoutes(app);

  const sessions = new Map<string, McpPostSession>();

  app.post('/mcp', async (req, res) => {
    await handleMcpPostRequest({
      req,
      res,
      sessions,
      logger,
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
          getSessionId: () => transport.sessionId,
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
    await session.server.close();
    sessions.delete(sessionId);
    logger.info(`Session closed: ${sessionId}`);
  });

  app.listen(initialSnapshot.port, initialSnapshot.host, () => {
    logger.info('MCP Replace Server started');
    logger.info(`  Bind address: ${formatHostPort(initialSnapshot.host, initialSnapshot.port)}`);
    logger.info(`  Endpoint: ${buildHttpUrl(initialSnapshot.host, initialSnapshot.port, '/mcp')}`);
    logger.info(`  Workspace id: ${initialSnapshot.workspaceId}`);
    logger.info(`  Snapshot version: ${initialSnapshot.snapshotVersion}`);
    logger.info(`  Global config file: ${initialSnapshot.globalConfigFilePath}`);
    logger.info(`  Workspace config file: ${initialSnapshot.workspaceConfigFilePath}`);
    logWorkspaceRoots(configStore, logger);
    for (const line of formatFileAccessPolicyStartupLines(
      initialSnapshot.fileAccessPolicyFiles,
    )) {
      logger.info(line);
    }
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
