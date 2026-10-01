import { CliError } from '../../cli.js';
import type { ConfigError } from '../../config.js';

/** Keeps actionable CLI/config diagnostics separate from unexpected startup exceptions. */
export function formatStartupError(error: CliError | ConfigError): string {
  const lines = [
    error instanceof CliError
      ? 'Failed to parse command line arguments.'
      : 'Failed to load configuration.',
    `Reason: ${error.message}`,
  ];

  if (!(error instanceof CliError)) {
    if (error.configFilePath) {
      lines.push(`Config file: ${error.configFilePath}`);
    }
    if (error.fieldPath) {
      lines.push(`Field: ${error.fieldPath}`);
    }
  }

  if (error.suggestion) {
    const suggestion = error.suggestion
      .split(/\r?\n/)
      .map((line) => `  ${line}`)
      .join('\n');
    lines.push('', 'Next step:', suggestion);
  }

  return lines.join('\n');
}
