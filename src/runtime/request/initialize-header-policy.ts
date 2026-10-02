import type { RuntimeInitializeRequestFeature, RuntimeRulesConfig } from '../../config.js';
import type { StrictRequestHeaderView } from './request-header-view.js';

export interface AppliedInitializeHeaderRule {
  readonly ruleLocation: string;
  readonly feature: RuntimeInitializeRequestFeature;
}

/** Settings are published only after every configured parameter has been validated. */
export interface InitializeHeaderSettings {
  readonly requestedToolNames?: readonly string[];
  readonly instructions?: string;
}

export interface InitializeHeaderPolicy {
  readonly settings: InitializeHeaderSettings;
  readonly metadata: InitializeHeaderPolicyLogMetadata;
}

export interface InitializeHeaderPolicyLogMetadata {
  readonly rulesConfigured: boolean;
  readonly appliedRules: readonly AppliedInitializeHeaderRule[];
}

export type InitializeHeaderPolicyErrorCategory =
  | 'invalid_header_view'
  | 'duplicate_header'
  | 'invalid_json'
  | 'invalid_payload';

/** Safe to adapt to a protocol error: no request values or JSON.parse exception escape. */
export class InitializeHeaderPolicyError extends Error {
  readonly category: InitializeHeaderPolicyErrorCategory;
  readonly ruleLocation: string;
  readonly feature: RuntimeInitializeRequestFeature;
  readonly field?: 'toolList' | 'instructions';

  constructor(
    code: InitializeHeaderPolicyErrorCategory,
    ruleLocation: string,
    feature: RuntimeInitializeRequestFeature,
    field?: 'toolList' | 'instructions',
  ) {
    super(`Invalid initialization header parameter at ${ruleLocation}: ${code}${field === undefined ? '' : ` (${field})`}.`);
    this.name = 'InitializeHeaderPolicyError';
    this.category = code;
    this.ruleLocation = ruleLocation;
    this.feature = feature;
    this.field = field;
  }
}

const TOOL_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function evaluateInitializeHeaderPolicy(
  rules: RuntimeRulesConfig,
  view: StrictRequestHeaderView | undefined,
): InitializeHeaderPolicy {
  const bindings = rules.requestHeaders.onInitialize;
  const appliedRules: AppliedInitializeHeaderRule[] = [];
  let requestedToolNames: readonly string[] | undefined;
  let instructions: string | undefined;

  for (const [index, binding] of bindings.entries()) {
    const ruleLocation = `rules.requestHeaders.onInitialize[${index}]`;
    function fail(code: InitializeHeaderPolicyErrorCategory, field?: 'toolList' | 'instructions'): never {
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
    const field = binding.apply === 'setToolList' ? 'toolList' : 'instructions';
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      fail('invalid_payload', field);
    }
    const record = payload as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 1 || keys[0] !== field) {
      // Never interpolate unknown keys, including control characters or secrets.
      fail('invalid_payload', field);
    }

    if (binding.apply === 'setToolList') {
      const names = record.toolList;
      if (!Array.isArray(names)) {
        fail('invalid_payload', 'toolList');
      }
      const seen = new Set<string>();
      const parsedNames: string[] = [];
      for (const name of names) {
        if (typeof name !== 'string' || !TOOL_NAME_RE.test(name) || seen.has(name)) {
          fail('invalid_payload', 'toolList');
        }
        seen.add(name);
        parsedNames.push(name);
      }
      requestedToolNames = Object.freeze(parsedNames);
    } else {
      const text = record.instructions;
      if (typeof text !== 'string') {
        fail('invalid_payload', 'instructions');
      }
      instructions = text;
    }
    appliedRules.push(Object.freeze({ ruleLocation, feature: binding.apply }));
  }

  return Object.freeze({
    settings: Object.freeze({
      ...(requestedToolNames === undefined ? {} : { requestedToolNames }),
      ...(instructions === undefined ? {} : { instructions }),
    }),
    metadata: Object.freeze({
      rulesConfigured: bindings.length > 0,
      appliedRules: Object.freeze(appliedRules),
    }),
  });
}

export function toInitializeHeaderPolicyErrorLogMetadata(
  error: InitializeHeaderPolicyError,
): { readonly ruleLocation: string; readonly category: InitializeHeaderPolicyErrorCategory } {
  return Object.freeze({ ruleLocation: error.ruleLocation, category: error.category });
}
