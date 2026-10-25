import type { ToolCallResult } from '../../../tools/types.js';

/** Replace structuredContent with a view of the validated result, without mutating it. */
export function duplicateStructuredContent(result: ToolCallResult): ToolCallResult {
  return {
    ...result,
    structuredContent: {
      content: result.content,
      isError: result.isError,
    },
  };
}
