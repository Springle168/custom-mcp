import type { JsonValue, ToolCallResult } from './types.js';

export interface TextResultOptions {
  readonly structuredPayload?: JsonValue;
}

function textToolResult(
  text: string,
  isError: boolean,
  options?: TextResultOptions,
): ToolCallResult {
  const result: ToolCallResult = {
    content: [{ type: 'text', text }],
    isError,
  };

  if (options?.structuredPayload !== undefined) {
    result.structuredPayload = options.structuredPayload;
  }

  return result;
}

export function textResult(text: string, options?: TextResultOptions): ToolCallResult {
  return textToolResult(text, false, options);
}

export function textErrorResult(text: string, options?: TextResultOptions): ToolCallResult {
  return textToolResult(text, true, options);
}
