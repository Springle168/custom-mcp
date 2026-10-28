import type { RuntimeRulesConfig } from '../../config.js';
import type { McpSessionOptions, RuntimeExtensions } from '../runtime-extensions.js';
import type {
  InitializeContribution,
  RequestHeaderFeatureRegistry,
  ResultFeatureBinding,
} from './feature-contracts.js';
import { REQUEST_HEADER_FEATURE_REGISTRY } from './feature-registry.js';
import { InitializeHeaderPolicyError } from './initialize-header-errors.js';
import { evaluateInitializeHeaderPolicy } from './initialize-header-policy.js';
import { createStrictRequestHeaderView } from './request-header-view.js';
import {
  bindResultFeatures,
  createRequestHeaderToolResultPreparer,
} from './tool-result-header-extension.js';

/** Adapts initialization parameters without taking ownership of session resources. */
export function createInitializeHeaderExtension(
  rules: RuntimeRulesConfig,
  logger: { info(message: string): void | Promise<void> },
  registry: RequestHeaderFeatureRegistry = REQUEST_HEADER_FEATURE_REGISTRY,
): NonNullable<RuntimeExtensions['prepareSession']> {
  const resultsConfigured = rules.requestHeaders.onCallToolResult.length > 0;
  return (rawHeaders, defaults) => {
    let policy: ReturnType<typeof evaluateInitializeHeaderPolicy>;
    try {
      policy = evaluateInitializeHeaderPolicy(
        rules,
        createStrictRequestHeaderView(rawHeaders),
        registry.initialize,
      );
    } catch (error: unknown) {
      if (!(error instanceof InitializeHeaderPolicyError)) {
        throw error;
      }
      safeInfo(
        logger,
        () => `Initialize policy rejected: ${error.ruleLocation}; ${error.category}`,
      );
      return { accepted: false, message: error.message };
    }

    const options = prepareContributions(
      policy.contributions,
      defaults,
      registry,
      resultsConfigured,
    );
    // Publication retains only safe metadata, not payloads or preparation closures.
    const metadata = policy.metadata;
    return {
      accepted: true,
      options,
      ...(metadata.rulesConfigured
        ? {
            onPublished: (sessionId: string) => {
              safeInfo(logger, () => {
                const applied = metadata.appliedRules;
                const summary =
                  applied.length === 0
                    ? '  Applied: none'
                    : [
                        '  Applied:',
                        ...applied.map((rule) => `    ${rule.ruleLocation}: ${rule.feature}`),
                      ].join('\n');
                return `Session policy:\n  Session: ${sessionId}\n${summary}`;
              });
            },
          }
        : {}),
    };
  };
}

/** Ownership conflicts are internal errors and must precede all preparation effects. */
function prepareContributions(
  contributions: readonly InitializeContribution[],
  defaults: McpSessionOptions,
  registry: RequestHeaderFeatureRegistry,
  resultsConfigured: boolean,
): McpSessionOptions {
  let prepareToolService: InitializeContribution['prepareToolService'];
  let instructions: string | undefined;
  const bindings: ResultFeatureBinding[] = [];
  const boundFeatures = new Set<string>();
  const registeredFeatures = new Set(registry.results.map(({ feature }) => feature));

  for (const contribution of contributions) {
    if (contribution.prepareToolService !== undefined) {
      if (prepareToolService !== undefined) {
        throw new Error('Conflicting initialization tool service ownership.');
      }
      prepareToolService = contribution.prepareToolService;
    }
    if (contribution.instructions !== undefined) {
      if (instructions !== undefined) {
        throw new Error('Conflicting initialization instructions ownership.');
      }
      instructions = contribution.instructions;
    }
    for (const binding of contribution.resultBindings ?? []) {
      if (!registeredFeatures.has(binding.feature) || boundFeatures.has(binding.feature)) {
        throw new Error('Invalid initialization result binding ownership.');
      }
      boundFeatures.add(binding.feature);
      bindings.push(binding);
    }
  }

  return Object.freeze({
    ...defaults,
    ...(prepareToolService === undefined
      ? {}
      : { toolService: prepareToolService(defaults.toolService) }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(resultsConfigured && bindings.length > 0
      ? {
          prepareToolResult: createRequestHeaderToolResultPreparer(
            bindResultFeatures(registry.results, bindings),
          ),
        }
      : {}),
  });
}

function safeInfo(
  logger: { info(message: string): void | Promise<void> },
  message: () => string,
): void {
  try {
    void Promise.resolve(logger.info(message())).catch(() => {});
  } catch {
    // Policy summaries and logging are observational, never parameter rejection.
  }
}
