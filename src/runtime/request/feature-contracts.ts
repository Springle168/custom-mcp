import type { RuntimeInitializeRequestFeature, RuntimeRequestFeature } from '../../config.js';
import type { WorkspaceToolService } from '../../tools/index.js';
import type { ToolCallResult } from '../../tools/types.js';

export type ResultTransform = (result: ToolCallResult) => ToolCallResult;

export interface BoundResultFeature<Feature extends string = RuntimeRequestFeature> {
  readonly feature: Feature;
  readonly apply: ResultTransform;
}

export interface ResultFeatureBinding<Feature extends string = RuntimeRequestFeature> {
  readonly feature: Feature;
  readonly bind: () => ResultTransform;
}

/** Validated, resource-free contributions; preparation waits for all parsers to succeed. */
export interface InitializeContribution {
  readonly prepareToolService?: (base: WorkspaceToolService) => WorkspaceToolService;
  readonly instructions?: string;
  readonly resultBindings?: readonly ResultFeatureBinding[];
}

/** Field names come from trusted feature code, never unknown JSON keys. */
export type InvalidInitializePayload = (field?: string) => never;

export type InitializeFeatureParser = (
  payload: unknown,
  invalid: InvalidInitializePayload,
) => InitializeContribution;

/** Explicit assembly dependencies, not a mutable runtime registration API. */
export interface RequestHeaderFeatureRegistry {
  readonly initialize: Readonly<Record<RuntimeInitializeRequestFeature, InitializeFeatureParser>>;
  readonly results: readonly BoundResultFeature[];
}
