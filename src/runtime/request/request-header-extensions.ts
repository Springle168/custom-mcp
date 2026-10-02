import type { RuntimeRulesConfig } from '../../config.js';
import type { RuntimeExtensions } from '../runtime-extensions.js';
import { createInitializeHeaderExtension } from './initialize-header-extension.js';
import { runWithRequestHeaderContext } from './request-context.js';
import { createStrictRequestHeaderView } from './request-header-view.js';
import { prepareRequestHeaderToolResult } from './tool-result-header-extension.js';

/** Binds only configured stages; core runtime paths remain usable without policy. */
export function createRequestHeaderExtensions(
  rules: RuntimeRulesConfig,
  logger: { info(message: string): void },
): RuntimeExtensions {
  return {
    ...(rules.requestHeaders.onInitialize.length === 0
      ? {}
      : { prepareSession: createInitializeHeaderExtension(rules, logger) }),
    ...(rules.requestHeaders.onCallToolResult.length === 0
      ? {}
      : {
        prepareToolResult: prepareRequestHeaderToolResult,
        runWithPostContext: <T>(rawHeaders: readonly string[], action: () => T): T =>
          runWithRequestHeaderContext(createStrictRequestHeaderView(rawHeaders), action),
      }),
  };
}
