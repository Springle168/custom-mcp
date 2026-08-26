import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ConfigStore } from './config-store.js';
import {
  createToolCallRequestHandler,
  type ToolCallDiagnosticSink,
  type ToolCallLogger,
} from './tool-call-handler.js';
import type { WorkspaceToolService } from '../tools/index.js';

function loadPackageVersion(): string {
  // Package metadata is the release-version source, so runtime code does not duplicate it.
  const manifest = createRequire(import.meta.url)('../../package.json') as {
    readonly version?: unknown;
  };

  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('package.json must define a non-empty version string.');
  }

  return manifest.version;
}

const MCP_SERVER_VERSION = loadPackageVersion();

export interface CreateMCPServerOptions {
  readonly configStore: ConfigStore;
  readonly logger: ToolCallLogger;
  readonly toolService: WorkspaceToolService;
  readonly onToolCallDiagnostic?: ToolCallDiagnosticSink;
}

export function createMCPServer(options: CreateMCPServerOptions): Server {
  const server = new Server(
    { name: 'custom-mcp', version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...options.toolService.getDefinitions()],
  }));

  const handleToolCall = createToolCallRequestHandler({
    configStore: options.configStore,
    logger: options.logger,
    routeToolCall: options.toolService.routeToolCall,
    ...(options.onToolCallDiagnostic === undefined
      ? {}
      : { onDiagnostic: options.onToolCallDiagnostic }),
  });
  server.setRequestHandler(
    CallToolRequestSchema,
    (request, extra) => handleToolCall(request, extra),
  );

  return server;
}
