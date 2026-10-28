import type { RuntimeInitializeRequestFeature } from '../../config.js';

export type InitializeHeaderPolicyErrorCategory =
  'invalid_header_view' | 'duplicate_header' | 'invalid_json' | 'invalid_payload';

/** Safe protocol diagnostic containing only locations and trusted feature field names. */
export class InitializeHeaderPolicyError extends Error {
  readonly category: InitializeHeaderPolicyErrorCategory;
  readonly ruleLocation: string;
  readonly feature: RuntimeInitializeRequestFeature;
  readonly field?: string;

  constructor(
    code: InitializeHeaderPolicyErrorCategory,
    ruleLocation: string,
    feature: RuntimeInitializeRequestFeature,
    field?: string,
  ) {
    super(
      `Invalid initialization header parameter at ${ruleLocation}: ${code}${field === undefined ? '' : ` (${field})`}.`,
    );
    this.name = 'InitializeHeaderPolicyError';
    this.category = code;
    this.ruleLocation = ruleLocation;
    this.feature = feature;
    this.field = field;
  }
}

export function toInitializeHeaderPolicyErrorLogMetadata(error: InitializeHeaderPolicyError): {
  readonly ruleLocation: string;
  readonly category: InitializeHeaderPolicyErrorCategory;
} {
  return Object.freeze({ ruleLocation: error.ruleLocation, category: error.category });
}
