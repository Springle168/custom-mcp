import type { ToolCallResult } from '../tools/types.js';
import type { RequestHeaderPolicy } from './request-header-policy.js';

export function adaptToolCallResultForRequestPolicy(
  result: ToolCallResult,
  policy: RequestHeaderPolicy,
): ToolCallResult {
  if (!policy.enabledFeatures.includes('structuredContentDup')) {
    return result;
  }

  return {
    ...result,
    structuredContent: {
      content: result.content,
      isError: result.isError === true,
    },
  };
}
