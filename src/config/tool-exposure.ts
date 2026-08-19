import { ConfigError } from './errors.js';
import { readTypedString } from './value-policy.js';
import { isToolName, TOOL_NAMES, type ToolName } from '../tools/names.js';

export type RuntimeToolExposure =
  | { readonly mode: 'all' }
  | { readonly mode: 'enable'; readonly names: readonly ToolName[] }
  | { readonly mode: 'disable'; readonly names: readonly ToolName[] };

export interface ReadOptionalToolExposureConfigOptions {
  readonly configFilePath: string;
  readonly fieldPath: string;
}

const TOOL_EXPOSURE_FIELDS = new Set(['enabled', 'disabled']);

export function readOptionalToolExposureConfig(
  value: unknown,
  options: ReadOptionalToolExposureConfigOptions,
): RuntimeToolExposure {
  if (value === undefined) {
    return { mode: 'all' };
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(options, options.fieldPath, `${options.fieldPath} must be a JSON object when configured.`);
  }

  const rawExposure = value as Record<string, unknown>;
  for (const key of Object.keys(rawExposure)) {
    if (!TOOL_EXPOSURE_FIELDS.has(key)) {
      const fieldPath = `${options.fieldPath}.${key}`;
      fail(options, fieldPath, `Unknown config field ${fieldPath}. Only enabled and disabled are supported.`);
    }
  }

  const hasEnabled = hasOwn(rawExposure, 'enabled');
  const hasDisabled = hasOwn(rawExposure, 'disabled');
  if (hasEnabled === hasDisabled) {
    fail(
      options,
      options.fieldPath,
      `${options.fieldPath} must configure exactly one of enabled or disabled. Configure only enabled or only disabled.`,
    );
  }

  const mode = hasEnabled ? 'enable' : 'disable';
  const key = hasEnabled ? 'enabled' : 'disabled';
  const fieldPath = `${options.fieldPath}.${key}`;
  const rawNames = rawExposure[key];
  if (!Array.isArray(rawNames)) {
    fail(options, fieldPath, `${fieldPath} must be an array of tool names.`);
  }

  return {
    mode,
    names: readToolNames(rawNames, options, fieldPath),
  };
}

function readToolNames(
  values: readonly unknown[],
  options: ReadOptionalToolExposureConfigOptions,
  fieldPath: string,
): ToolName[] {
  const names: ToolName[] = [];
  const seen = new Set<ToolName>();

  for (let index = 0; index < values.length; index++) {
    const itemPath = `${fieldPath}[${index}]`;
    const result = readTypedString(values[index], { fieldPath: itemPath });
    if (!result.ok) {
      fail(options, result.error.fieldPath, result.error.message);
    }

    const name = result.value;
    if (!isToolName(name)) {
      fail(
        options,
        itemPath,
        `Unknown tool name "${name}". Valid tool names are: ${TOOL_NAMES.join(', ')}.`,
      );
    }

    if (seen.has(name)) {
      fail(options, itemPath, `Duplicate tool name "${name}". Remove duplicate entries.`);
    }

    seen.add(name);
    names.push(name);
  }

  return names;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(
  options: ReadOptionalToolExposureConfigOptions,
  fieldPath: string,
  message: string,
): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: options.configFilePath,
    fieldPath,
    message,
    suggestion: `Fix ${fieldPath} in ${options.configFilePath} and restart the server.`,
  });
}
