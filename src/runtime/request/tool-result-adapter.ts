import type { ToolCallResult } from '../../tools/types.js';
import type { BoundResultFeature } from './feature-contracts.js';

/** Selection never changes the order of the bound session table. */
export function adaptToolCallResultForRequestPolicy<Feature extends string>(
  result: ToolCallResult,
  enabledFeatures: readonly Feature[],
  features: readonly BoundResultFeature<Feature>[],
): ToolCallResult {
  let adapted = result;

  for (const { feature, apply } of features) {
    if (enabledFeatures.includes(feature)) {
      adapted = apply(adapted);
    }
  }

  return adapted;
}
