import { ConfigError } from './errors.js';
import { readLocalAbsolutePath } from './path-policy.js';
import { readTypedString } from './value-policy.js';

export type ParsedToolExposure =
  | { readonly mode: 'all' }
  | { readonly mode: 'enable'; readonly names: readonly string[] }
  | { readonly mode: 'disable'; readonly names: readonly string[] };

export interface ParsedWorkspaceToolsConfig {
  readonly toolConfigFile?: string;
  readonly exposure: ParsedToolExposure;
}

export interface ReadOptionalWorkspaceToolsConfigOptions {
  readonly configFilePath: string;
  readonly fieldPath: string;
}

const TOOL_FIELDS = new Set(['toolConfigFile', 'enabled', 'disabled']);
const TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function readOptionalWorkspaceToolsConfig(
  value: unknown,
  options: ReadOptionalWorkspaceToolsConfigOptions,
): ParsedWorkspaceToolsConfig {
  if (value === undefined) {
    return Object.freeze({ exposure: Object.freeze({ mode: 'all' }) });
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(options, options.fieldPath, `${options.fieldPath} must be a JSON object when configured.`);
  }

  const rawTools = value as Record<string, unknown>;
  for (const key of Object.keys(rawTools)) {
    if (!TOOL_FIELDS.has(key)) {
      const fieldPath = `${options.fieldPath}.${key}`;
      fail(
        options,
        fieldPath,
        `Unknown config field ${fieldPath}. Only toolConfigFile, enabled, and disabled are supported.`,
      );
    }
  }

  const hasEnabled = hasOwn(rawTools, 'enabled');
  const hasDisabled = hasOwn(rawTools, 'disabled');
  if (hasEnabled && hasDisabled) {
    fail(
      options,
      options.fieldPath,
      `${options.fieldPath} cannot configure enabled and disabled at the same time. Configure at most one selector.`,
    );
  }

  const toolConfigFile = readOptionalToolConfigFile(
    rawTools.toolConfigFile,
    options,
  );
  const exposure = hasEnabled || hasDisabled
    ? readExposure(rawTools, hasEnabled ? 'enabled' : 'disabled', options)
    : Object.freeze({ mode: 'all' as const });

  return Object.freeze({
    ...(toolConfigFile === undefined ? {} : { toolConfigFile }),
    exposure,
  });
}

function readOptionalToolConfigFile(
  value: unknown,
  options: ReadOptionalWorkspaceToolsConfigOptions,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const fieldPath = `${options.fieldPath}.toolConfigFile`;
  const result = readLocalAbsolutePath(value, { fieldPath });
  if (!result.ok) {
    fail(options, result.error.fieldPath, result.error.message);
  }

  return result.value;
}

function readExposure(
  rawTools: Record<string, unknown>,
  key: 'enabled' | 'disabled',
  options: ReadOptionalWorkspaceToolsConfigOptions,
): ParsedToolExposure {
  const fieldPath = `${options.fieldPath}.${key}`;
  const rawNames = rawTools[key];
  if (!Array.isArray(rawNames)) {
    fail(options, fieldPath, `${fieldPath} must be an array of tool names.`);
  }

  return Object.freeze({
    mode: key === 'enabled' ? 'enable' : 'disable',
    names: Object.freeze(readToolNames(rawNames, options, fieldPath)),
  });
}

function readToolNames(
  values: readonly unknown[],
  options: ReadOptionalWorkspaceToolsConfigOptions,
  fieldPath: string,
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < values.length; index++) {
    const itemPath = `${fieldPath}[${index}]`;
    const result = readTypedString(values[index], { fieldPath: itemPath });
    if (!result.ok) {
      fail(options, result.error.fieldPath, result.error.message);
    }

    const name = result.value;
    if (!TOOL_NAME_PATTERN.test(name)) {
      fail(
        options,
        itemPath,
        `${itemPath} must match ${TOOL_NAME_PATTERN} and contain at most 128 characters.`,
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
  options: ReadOptionalWorkspaceToolsConfigOptions,
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
