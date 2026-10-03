import type { RuntimeRequestFeature, RuntimeRulesConfig } from '../../config.js';
import type { StrictRequestHeaderView } from './request-header-view.js';

export interface RequestHeaderPolicy {
  readonly rulesConfigured: boolean;
  readonly matchedRuleIndexes: readonly number[];
  readonly enabledFeatures: readonly RuntimeRequestFeature[];
}

export interface RequestHeaderPolicyLogMetadata {
  readonly rulesConfigured: boolean;
  readonly matchedRuleLocations: readonly string[];
  readonly enabledFeatures: readonly RuntimeRequestFeature[];
}

export function evaluateRequestHeaderPolicy(
  rules: RuntimeRulesConfig,
  view: StrictRequestHeaderView | undefined,
): RequestHeaderPolicy {
  const resultRules = rules.requestHeaders.onCallToolResult;
  const rulesConfigured = resultRules.length > 0;
  if (!rulesConfigured || view === undefined || view.kind === 'invalid') {
    return freezePolicy({
      rulesConfigured,
      matchedRuleIndexes: [],
      enabledFeatures: [],
    });
  }

  const matchedRuleIndexes: number[] = [];
  const enabledFeatures: RuntimeRequestFeature[] = [];
  const seenFeatures = new Set<RuntimeRequestFeature>();

  resultRules.forEach((rule, index) => {
    const matched = rule.match.every((condition) => {
      const state = view.headers.get(condition.name);
      return state?.kind === 'single' && state.value === condition.value;
    });

    if (!matched) {
      return;
    }

    matchedRuleIndexes.push(index);
    for (const feature of rule.enable) {
      if (seenFeatures.has(feature)) {
        continue;
      }

      seenFeatures.add(feature);
      enabledFeatures.push(feature);
    }
  });

  return freezePolicy({
    rulesConfigured,
    matchedRuleIndexes,
    enabledFeatures,
  });
}

export function toRequestHeaderPolicyLogMetadata(
  policy: RequestHeaderPolicy,
): RequestHeaderPolicyLogMetadata {
  const matchedRuleLocations = policy.matchedRuleIndexes.map(
    (index) => `rules.requestHeaders.onCallToolResult[${index}]`,
  );
  const enabledFeatures = [...policy.enabledFeatures];

  Object.freeze(matchedRuleLocations);
  Object.freeze(enabledFeatures);
  return Object.freeze({
    rulesConfigured: policy.rulesConfigured,
    matchedRuleLocations,
    enabledFeatures,
  });
}

function freezePolicy(policy: {
  readonly rulesConfigured: boolean;
  readonly matchedRuleIndexes: number[];
  readonly enabledFeatures: RuntimeRequestFeature[];
}): RequestHeaderPolicy {
  Object.freeze(policy.matchedRuleIndexes);
  Object.freeze(policy.enabledFeatures);
  return Object.freeze(policy);
}
