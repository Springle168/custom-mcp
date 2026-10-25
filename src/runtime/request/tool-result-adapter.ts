import type { RuntimeRequestFeature } from '../../config.js';
import type { ToolCallResult } from '../../tools/types.js';
import { duplicateStructuredContent } from './tool-result-features/structured-content-dup.js';

/** Registry order defines execution order, not the order of configured rules or features. */
export const TOOL_RESULT_FEATURES = [
  {
    feature: 'structuredContentDup',
    apply: duplicateStructuredContent,
  },
] as const satisfies readonly {
  feature: RuntimeRequestFeature;
  apply: (result: ToolCallResult) => ToolCallResult;
}[];

export function adaptToolCallResultForRequestPolicy(
  result: ToolCallResult,
  enabledFeatures: readonly RuntimeRequestFeature[],
): ToolCallResult {
  let adapted = result;

  for (const { feature, apply } of TOOL_RESULT_FEATURES) {
    if (enabledFeatures.includes(feature)) {
      adapted = apply(adapted);
    }
  }

  return adapted;
}
