import type { RuntimeConfigSnapshot } from '../../config.js';
import type { PreparedToolResult, PrepareToolResult } from '../runtime-extensions.js';
import type { BoundResultFeature, ResultFeatureBinding } from './feature-contracts.js';
import { TOOL_RESULT_FEATURES } from './feature-registry.js';
import { getCurrentRequestHeaderView } from './request-context.js';
import {
  evaluateRequestHeaderPolicy,
  toRequestHeaderPolicyLogMetadata,
} from './request-header-policy.js';
import { formatRequestHeaderPolicyLogSummary } from './request-header-policy-logging.js';
import { adaptToolCallResultForRequestPolicy } from './tool-result-adapter.js';

/** Replace implementations by identity, retaining the default table's static order. */
export function bindResultFeatures<Feature extends string>(
  features: readonly BoundResultFeature<Feature>[],
  bindings: readonly ResultFeatureBinding<Feature>[],
): readonly BoundResultFeature<Feature>[] {
  if (bindings.length === 0) {
    return features;
  }
  const registered = new Set(features.map(({ feature }) => feature));
  const overrides = new Map<Feature, ResultFeatureBinding<Feature>>();
  for (const binding of bindings) {
    if (!registered.has(binding.feature) || overrides.has(binding.feature)) {
      throw new Error('Invalid initialization result binding ownership.');
    }
    overrides.set(binding.feature, binding);
  }

  return Object.freeze(
    features.map((entry) => {
      const binding = overrides.get(entry.feature);
      return binding === undefined
        ? entry
        : Object.freeze({ feature: entry.feature, apply: binding.bind() });
    }),
  );
}

/** Bind session implementations without granting any per-call enablement. */
export function createRequestHeaderToolResultPreparer(
  features: readonly BoundResultFeature[],
): PrepareToolResult {
  return (snapshot) => prepareToolResult(snapshot, features);
}

/** Shared stateless defaults also serve callers that have no initialization stage. */
export const prepareRequestHeaderToolResult =
  createRequestHeaderToolResultPreparer(TOOL_RESULT_FEATURES);

/** Capture this POST's policy before CALL logging or execution can yield. */
function prepareToolResult(
  snapshot: RuntimeConfigSnapshot,
  features: readonly BoundResultFeature[],
): PreparedToolResult {
  const policy = evaluateRequestHeaderPolicy(snapshot.rules, getCurrentRequestHeaderView());
  const enabledFeatures = policy.enabledFeatures;
  const metadata = toRequestHeaderPolicyLogMetadata(policy);

  return {
    adaptResult: (result) => adaptToolCallResultForRequestPolicy(result, enabledFeatures, features),
    // Formatting belongs in the protected RESULT logging path. This supplier
    // retains only safe metadata, not the raw header view or configuration.
    getLogSummary: () => formatRequestHeaderPolicyLogSummary(metadata),
  };
}
