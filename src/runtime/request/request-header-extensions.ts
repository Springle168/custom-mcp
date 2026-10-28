import type { RuntimeRulesConfig } from '../../config.js';
import type { RuntimeExtensions } from '../runtime-extensions.js';
import type { RequestHeaderFeatureRegistry } from './feature-contracts.js';
import { REQUEST_HEADER_FEATURE_REGISTRY } from './feature-registry.js';
import { createInitializeHeaderExtension } from './initialize-header-extension.js';
import { runWithRequestHeaderContext } from './request-context.js';
import { createStrictRequestHeaderView } from './request-header-view.js';
import { createRequestHeaderToolResultPreparer } from './tool-result-header-extension.js';

/** Binds only configured stages; core runtime paths remain usable without policy. */
export function createRequestHeaderExtensions(
  rules: RuntimeRulesConfig,
  logger: { info(message: string): void | Promise<void> },
  registry: RequestHeaderFeatureRegistry = REQUEST_HEADER_FEATURE_REGISTRY,
): RuntimeExtensions {
  return {
    ...(rules.requestHeaders.onInitialize.length === 0
      ? {}
      : { prepareSession: createInitializeHeaderExtension(rules, logger, registry) }),
    ...(rules.requestHeaders.onCallToolResult.length === 0
      ? {}
      : {
          defaultSessionOptions: Object.freeze({
            prepareToolResult: createRequestHeaderToolResultPreparer(registry.results),
          }),
          runWithPostContext: <T>(rawHeaders: readonly string[], action: () => T): T =>
            runWithRequestHeaderContext(createStrictRequestHeaderView(rawHeaders), action),
        }),
  };
}
