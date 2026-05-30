import type { ToolCallResult } from './types.js';

function textToolResult(text: string, isError: boolean): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

export function textResult(text: string): ToolCallResult {
  return textToolResult(text, false);
}

export function textErrorResult(text: string): ToolCallResult {
  return textToolResult(text, true);
}
