import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { ToolName } from './names.js';

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
  [key: string]: unknown;
}

export interface MCPTool {
  readonly definition: {
    readonly name: ToolName;
    readonly description: string;
    readonly inputSchema: object;
  };
  readonly handler: (
    args: Record<string, unknown>,
    context: ToolRuntimeContext,
  ) => Promise<ToolCallResult>;
}
