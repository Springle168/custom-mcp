import type { RequestHeaderFeatureRegistry } from './feature-contracts.js';
import { parseSetInstructions } from './features/set-instructions.js';
import { parseSetToolList } from './features/set-tool-list.js';
import { duplicateStructuredContent } from './features/structured-content-dup.js';

export const INITIALIZE_HEADER_FEATURES = Object.freeze({
  setToolList: parseSetToolList,
  setInstructions: parseSetInstructions,
} satisfies RequestHeaderFeatureRegistry['initialize']);

/** Static order controls execution; configuration only selects enabled features. */
export const TOOL_RESULT_FEATURES = Object.freeze([
  Object.freeze({ feature: 'structuredContentDup', apply: duplicateStructuredContent }),
] as const satisfies RequestHeaderFeatureRegistry['results']);

export const REQUEST_HEADER_FEATURE_REGISTRY: RequestHeaderFeatureRegistry = Object.freeze({
  initialize: INITIALIZE_HEADER_FEATURES,
  results: TOOL_RESULT_FEATURES,
});
