import type { ToolCallResult } from './types.js';

export function textErrorResult(text: string): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}
