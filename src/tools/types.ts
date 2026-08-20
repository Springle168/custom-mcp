import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { ToolName } from './names.js';

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
) => Promise<ToolCallResult>;

export interface MCPTool {
  readonly definition: ToolDefinition & { readonly name: ToolName };
  readonly handler: ToolExecutor;
}
