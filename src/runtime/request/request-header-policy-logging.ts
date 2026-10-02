import chalk from 'chalk';
import type { ToolResultLogSummary } from '../invocation/tool-call-log-context.js';
import type { RequestHeaderPolicyLogMetadata } from './request-header-policy.js';

/** Formats only policy-owned safe metadata, never raw headers or configuration. */
export function formatRequestHeaderPolicyLogSummary(
  metadata: RequestHeaderPolicyLogMetadata,
): ToolResultLogSummary | undefined {
  if (!metadata.rulesConfigured) {
    return undefined;
  }

  if (metadata.matchedRuleLocations.length === 0) {
    return {
      fileText: 'Rules: no match',
      consoleText: `${chalk.cyan('Rules:')} ${chalk.dim('no match')}`,
    };
  }

  const matchedLocations = metadata.matchedRuleLocations.join(chalk.dim(', '));
  const enabledFeatures = metadata.enabledFeatures
    .map((feature) => chalk.magenta(feature))
    .join(chalk.dim(', '));

  return {
    fileText: `Rules: matched ${metadata.matchedRuleLocations.join(', ')}; enabled ${metadata.enabledFeatures.join(', ')}`,
    consoleText: `${chalk.cyan('Rules:')} ${chalk.green('matched')} ${matchedLocations}; ${chalk.cyan('enabled')} ${enabledFeatures}`,
  };
}
