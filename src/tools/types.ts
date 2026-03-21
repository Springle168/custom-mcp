import type { Config } from '../config.js';

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown; 
}

export interface MCPTool {
  definition: {
    name: string;
    description: string;
    inputSchema: object;
  };
  handler: (
    args: Record<string, unknown>,
    config: Config,
  ) => Promise<ToolCallResult>;
}
