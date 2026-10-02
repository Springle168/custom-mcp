import type { RuntimeRulesConfig } from '../../config.js';
import { createSessionToolService } from '../mcp/session-tool-service.js';
import type { RuntimeExtensions } from '../runtime-extensions.js';
import {
  evaluateInitializeHeaderPolicy,
  InitializeHeaderPolicyError,
} from './initialize-header-policy.js';
import { createStrictRequestHeaderView } from './request-header-view.js';

/** Adapts initialization parameters without taking ownership of session resources. */
export function createInitializeHeaderExtension(
  rules: RuntimeRulesConfig,
  logger: { info(message: string): void },
): NonNullable<RuntimeExtensions['prepareSession']> {
  return (rawHeaders, defaults) => {
    let policy: ReturnType<typeof evaluateInitializeHeaderPolicy>;
    try {
      policy = evaluateInitializeHeaderPolicy(rules, createStrictRequestHeaderView(rawHeaders));
    } catch (error: unknown) {
      if (!(error instanceof InitializeHeaderPolicyError)) {
        throw error;
      }
      safeInfo(logger, () => `Initialize policy rejected: ${error.ruleLocation}; ${error.category}`);
      return { accepted: false, message: error.message };
    }

    const { requestedToolNames, instructions } = policy.settings;
    return {
      accepted: true,
      options: {
        ...defaults,
        ...(requestedToolNames === undefined
          ? {}
          : { toolService: createSessionToolService(defaults.toolService, requestedToolNames) }),
        ...(instructions === undefined ? {} : { instructions }),
      },
      ...(policy.metadata.rulesConfigured ? {
        onPublished: (sessionId: string) => {
          safeInfo(logger, () => {
            const applied = policy.metadata.appliedRules;
            const summary = applied.length === 0
              ? 'none'
              : applied.map((rule) => `${rule.ruleLocation}: ${rule.feature}`).join(', ');
            return `Session policy: ${sessionId}; ${summary}`;
          });
        },
      } : {}),
    };
  };
}

function safeInfo(logger: { info(message: string): void }, message: () => string): void {
  try {
    void Promise.resolve(logger.info(message())).catch(() => {});
  } catch {
    // Policy summaries and logging are observational, never parameter rejection.
  }
}
