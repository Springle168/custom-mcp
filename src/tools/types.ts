import type {
  CallToolResult as MCPCallToolResult,
  ImageContent,
  TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolRuntimeContext } from '../runtime/invocation/tool-context.js';
import type { ToolInvocationContext } from '../runtime/invocation/tool-invocation-context.js';
import type { ToolName } from './names.js';

export type ToolResultContent = TextContent | ImageContent;

export type ToolCallResult = Omit<MCPCallToolResult, 'content' | 'isError'> & {
  content: ToolResultContent[];
  isError: boolean;
};

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
  invocation: ToolInvocationContext,
) => Promise<ToolCallResult>;

export interface MCPTool {
  readonly definition: ToolDefinition & { readonly name: ToolName };
  readonly handler: ToolExecutor;
}
