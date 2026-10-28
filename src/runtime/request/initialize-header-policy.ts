import type { RuntimeInitializeRequestFeature, RuntimeRulesConfig } from '../../config.js';
import type { InitializeContribution, RequestHeaderFeatureRegistry } from './feature-contracts.js';
import { INITIALIZE_HEADER_FEATURES } from './feature-registry.js';
import {
  InitializeHeaderPolicyError,
  type InitializeHeaderPolicyErrorCategory,
} from './initialize-header-errors.js';
import type { StrictRequestHeaderView } from './request-header-view.js';

export interface AppliedInitializeHeaderRule {
  readonly ruleLocation: string;
  readonly feature: RuntimeInitializeRequestFeature;
}

export interface InitializeHeaderPolicy {
  readonly contributions: readonly InitializeContribution[];
  readonly metadata: InitializeHeaderPolicyLogMetadata;
}

export interface InitializeHeaderPolicyLogMetadata {
  readonly rulesConfigured: boolean;
  readonly appliedRules: readonly AppliedInitializeHeaderRule[];
}

/** Read and validate every configured parameter before any contribution is prepared. */
export function evaluateInitializeHeaderPolicy(
  rules: RuntimeRulesConfig,
  view: StrictRequestHeaderView | undefined,
  parsers: RequestHeaderFeatureRegistry['initialize'] = INITIALIZE_HEADER_FEATURES,
): InitializeHeaderPolicy {
  const bindings = rules.requestHeaders.onInitialize;
  const appliedRules: AppliedInitializeHeaderRule[] = [];
  const contributions: InitializeContribution[] = [];

  for (const [index, binding] of bindings.entries()) {
    const ruleLocation = `rules.requestHeaders.onInitialize[${index}]`;
    function fail(code: InitializeHeaderPolicyErrorCategory, field?: string): never {
      throw new InitializeHeaderPolicyError(code, ruleLocation, binding.apply, field);
    }
    if (view === undefined || view.kind === 'invalid') {
      fail('invalid_header_view');
    }

    const state = view.headers.get(binding.readHeader);
    if (state === undefined) {
      continue;
    }
    if (state.kind === 'duplicate') {
      fail('duplicate_header');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(state.value);
    } catch {
      // JSON.parse errors can include input fragments; deliberately discard them.
      fail('invalid_json');
    }
    contributions.push(parsers[binding.apply](payload, (field) => fail('invalid_payload', field)));
    appliedRules.push(Object.freeze({ ruleLocation, feature: binding.apply }));
  }

  return Object.freeze({
    contributions: Object.freeze(contributions),
    metadata: Object.freeze({
      rulesConfigured: bindings.length > 0,
      appliedRules: Object.freeze(appliedRules),
    }),
  });
}
