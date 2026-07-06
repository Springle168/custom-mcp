import type { ToolRuntimeContext } from '../runtime/tool-context.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
  structuredPayload?: JsonValue;
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
    context: ToolRuntimeContext,
  ) => Promise<ToolCallResult>;
}
