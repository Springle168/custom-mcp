import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ConfigStore } from './config-store.js';
import {
  createToolCallRequestHandler,
  type ToolCallLogger,
} from './tool-call-handler.js';
import type { WorkspaceToolService } from '../tools/index.js';

export interface CreateMCPServerOptions {
  readonly configStore: ConfigStore;
  readonly logger: ToolCallLogger;
  readonly toolService: WorkspaceToolService;
  readonly getSessionId: () => string | undefined;
}

export function createMCPServer(options: CreateMCPServerOptions): Server {
  const server = new Server(
    { name: 'custom-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...options.toolService.getDefinitions()],
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    createToolCallRequestHandler({
      configStore: options.configStore,
      logger: options.logger,
      routeToolCall: options.toolService.routeToolCall,
      getSessionId: options.getSessionId,
    }),
  );

  return server;
}
