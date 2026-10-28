import type { InitializeFeatureParser } from '../feature-contracts.js';

export const parseSetInstructions: InitializeFeatureParser = (payload, invalid) => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return invalid('instructions');
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'instructions' || typeof record.instructions !== 'string') {
    return invalid('instructions');
  }

  return Object.freeze({ instructions: record.instructions });
};
