import { ConfigError } from './errors.js';
import { normalizeLogsDirPath } from './path-validation.js';
import { validateWorkspaceRootPathSet } from '../utils/paths.js';

export type ParsedLineEnding = 'auto' | 'lf' | 'crlf';

export interface ParsedAndroidConfig {
  readonly workspaceRoot: string;
  readonly javaHome: string;
  readonly buildTimeoutMs: number;
  readonly maxErrorBlockChars: number;
  readonly maxLogTailChars: number;
}

export interface ParsedEnvOverridesConfig {
  readonly allowedFields: readonly string[];
}

export interface ParsedWorkspaceConfig {
  readonly id: string;
  readonly rootDir: string;
  readonly port: number;
  readonly lineEnding: ParsedLineEnding;
  readonly logsDir?: string;
  readonly otherRootDirs: readonly string[];
  readonly android?: ParsedAndroidConfig;
  readonly envOverrides?: ParsedEnvOverridesConfig;
}

export interface ParsedGlobalConfig {
  readonly version: 1;
  readonly workspaces: readonly ParsedWorkspaceConfig[];
}

export interface ParseGlobalConfigOptions {
  readonly configFilePath: string;
}

interface ParseContext {
  readonly configFilePath: string;
}

const TOP_LEVEL_FIELDS = new Set(['version', 'workspaces']);
const WORKSPACE_FIELDS = new Set([
  'id',
  'rootDir',
  'port',
  'lineEnding',
  'logsDir',
  'otherRootDirs',
  'android',
  'envOverrides',
]);
const ANDROID_FIELDS = new Set([
  'workspaceRoot',
  'javaHome',
  'buildTimeoutMs',
  'maxErrorBlockChars',
  'maxLogTailChars',
]);
const ENV_OVERRIDES_FIELDS = new Set(['allowedFields']);
const LINE_ENDINGS = new Set<ParsedLineEnding>(['auto', 'lf', 'crlf']);
const MAX_PORT = 65535;

export function parseGlobalConfig(
  value: unknown,
  options: ParseGlobalConfigOptions,
): ParsedGlobalConfig {
  const context: ParseContext = { configFilePath: options.configFilePath };
  const rawConfig = readObject(context, value, undefined, 'Config file must contain a JSON object.');

  assertKnownFields(context, rawConfig, TOP_LEVEL_FIELDS, undefined);

  if (rawConfig.version !== 1) {
    fail(
      context,
      'version',
      'version must be the number 1. The current server only supports global config schema version 1.',
    );
  }

  const rawWorkspaces = rawConfig.workspaces;
  if (!Array.isArray(rawWorkspaces)) {
    fail(context, 'workspaces', 'workspaces must be a non-empty array.');
  }

  if (rawWorkspaces.length === 0) {
    fail(context, 'workspaces', 'workspaces must contain at least one workspace.');
  }

  const seenIds = new Set<string>();
  const seenPorts = new Set<number>();
  const workspaces = rawWorkspaces.map((rawWorkspace, index) => {
    const workspace = parseWorkspace(context, rawWorkspace, index);

    if (seenIds.has(workspace.id)) {
      fail(
        context,
        `workspaces[${index}].id`,
        `workspace id "${workspace.id}" must be unique across workspaces.`,
      );
    }
    seenIds.add(workspace.id);

    if (seenPorts.has(workspace.port)) {
      fail(
        context,
        `workspaces[${index}].port`,
        `workspace port ${workspace.port} must be unique across workspaces.`,
      );
    }
    seenPorts.add(workspace.port);

    return workspace;
  });

  const normalizedWorkspaceRoots = validateGlobalWorkspaceRoots(context, workspaces);

  return {
    version: 1,
    workspaces: workspaces.map((workspace, index) => ({
      ...workspace,
      rootDir: normalizedWorkspaceRoots[index],
    })),
  };
}

function parseWorkspace(
  context: ParseContext,
  value: unknown,
  index: number,
): ParsedWorkspaceConfig {
  const fieldPath = `workspaces[${index}]`;
  const rawWorkspace = readObject(
    context,
    value,
    fieldPath,
    `${fieldPath} must be a JSON object.`,
  );

  assertKnownFields(context, rawWorkspace, WORKSPACE_FIELDS, fieldPath);

  return {
    id: readRequiredString(context, rawWorkspace, 'id', fieldPath),
    rootDir: readRequiredString(context, rawWorkspace, 'rootDir', fieldPath),
    port: readRequiredPositiveInteger(context, rawWorkspace, 'port', fieldPath, {
      max: MAX_PORT,
      rangeDescription: `between 1 and ${MAX_PORT}`,
    }),
    lineEnding: readRequiredLineEnding(context, rawWorkspace, 'lineEnding', fieldPath),
    ...readOptionalLogsDir(context, rawWorkspace.logsDir, `${fieldPath}.logsDir`),
    otherRootDirs: readOptionalStringArray(context, rawWorkspace.otherRootDirs, `${fieldPath}.otherRootDirs`),
    ...readOptionalAndroidConfig(context, rawWorkspace.android, `${fieldPath}.android`),
    ...readOptionalEnvOverridesConfig(context, rawWorkspace.envOverrides, `${fieldPath}.envOverrides`),
  };
}

function readOptionalLogsDir(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
): { readonly logsDir?: string } {
  if (value === undefined) {
    return {};
  }

  if (typeof value !== 'string') {
    fail(context, fieldPath, `${fieldPath} must be a non-empty string.`);
  }

  try {
    return { logsDir: normalizeLogsDirPath(value, fieldPath) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    fail(context, fieldPath, message);
  }
}

function readOptionalAndroidConfig(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
): { readonly android?: ParsedAndroidConfig } {
  if (value === undefined) {
    return {};
  }

  const rawAndroid = readObject(
    context,
    value,
    fieldPath,
    `${fieldPath} must be a JSON object when configured.`,
  );
  assertKnownFields(context, rawAndroid, ANDROID_FIELDS, fieldPath);

  return {
    android: {
      workspaceRoot: readRequiredString(context, rawAndroid, 'workspaceRoot', fieldPath),
      javaHome: readRequiredString(context, rawAndroid, 'javaHome', fieldPath),
      buildTimeoutMs: readRequiredPositiveInteger(context, rawAndroid, 'buildTimeoutMs', fieldPath),
      maxErrorBlockChars: readRequiredPositiveInteger(context, rawAndroid, 'maxErrorBlockChars', fieldPath),
      maxLogTailChars: readRequiredPositiveInteger(context, rawAndroid, 'maxLogTailChars', fieldPath),
    },
  };
}

function readOptionalEnvOverridesConfig(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
): { readonly envOverrides?: ParsedEnvOverridesConfig } {
  if (value === undefined) {
    return {};
  }

  const rawEnvOverrides = readObject(
    context,
    value,
    fieldPath,
    `${fieldPath} must be a JSON object when configured.`,
  );
  assertKnownFields(context, rawEnvOverrides, ENV_OVERRIDES_FIELDS, fieldPath);

  if (!hasOwn(rawEnvOverrides, 'allowedFields')) {
    fail(context, `${fieldPath}.allowedFields`, `${fieldPath}.allowedFields is required when envOverrides is configured.`);
  }

  return {
    envOverrides: {
      allowedFields: readStringArray(context, rawEnvOverrides.allowedFields, `${fieldPath}.allowedFields`),
    },
  };
}

function validateGlobalWorkspaceRoots(
  context: ParseContext,
  workspaces: readonly ParsedWorkspaceConfig[],
): string[] {
  try {
    return validateWorkspaceRootPathSet(
      workspaces.map((workspace, index) => ({
        label: `workspaces[${index}].rootDir`,
        rootDir: workspace.rootDir,
      })),
    ).map((root) => root.rootDir);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: context.configFilePath,
      fieldPath: inferWorkspaceRootFieldPath(message),
      message,
      suggestion:
        'Fix workspace rootDir values so each one is an existing absolute local directory, and no workspace root duplicates or contains another workspace root.',
      cause: err,
    });
  }
}

function inferWorkspaceRootFieldPath(message: string): string {
  return message.match(/workspaces\[\d+\]\.rootDir/)?.[0] ?? 'workspaces';
}

function readObject(
  context: ParseContext,
  value: unknown,
  fieldPath: string | undefined,
  message: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(context, fieldPath, message);
  }

  return value as Record<string, unknown>;
}

function assertKnownFields(
  context: ParseContext,
  value: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
  parentPath: string | undefined,
): void {
  for (const key of Object.keys(value)) {
    if (!knownFields.has(key)) {
      fail(
        context,
        joinFieldPath(parentPath, key),
        `Unknown config field ${joinFieldPath(parentPath, key)}. Remove it or update the config schema.`,
      );
    }
  }
}

function readRequiredString(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
): string {
  const fieldPath = joinFieldPath(parentPath, key);
  if (!hasOwn(value, key)) {
    fail(context, fieldPath, `${fieldPath} is required.`);
  }

  const rawValue = value[key];
  if (typeof rawValue !== 'string') {
    fail(context, fieldPath, `${fieldPath} must be a non-empty string.`);
  }

  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    fail(context, fieldPath, `${fieldPath} must be a non-empty string.`);
  }

  return trimmed;
}

function readOptionalStringArray(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
): string[] {
  if (value === undefined) {
    return [];
  }

  return readStringArray(context, value, fieldPath);
}

function readStringArray(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
): string[] {
  if (!Array.isArray(value)) {
    fail(context, fieldPath, `${fieldPath} must be an array of non-empty strings.`);
  }

  return value.map((item, index) => {
    const itemPath = `${fieldPath}[${index}]`;
    if (typeof item !== 'string') {
      fail(context, itemPath, `${itemPath} must be a non-empty string.`);
    }

    const trimmed = item.trim();
    if (trimmed.length === 0) {
      fail(context, itemPath, `${itemPath} must be a non-empty string.`);
    }

    return trimmed;
  });
}

function readRequiredLineEnding(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
): ParsedLineEnding {
  const fieldPath = joinFieldPath(parentPath, key);
  if (!hasOwn(value, key)) {
    fail(context, fieldPath, `${fieldPath} is required.`);
  }

  const rawValue = value[key];
  if (rawValue === 'auto' || rawValue === 'lf' || rawValue === 'crlf') {
    return rawValue;
  }

  fail(
    context,
    fieldPath,
    `${fieldPath} must be one of: ${Array.from(LINE_ENDINGS).join(', ')}.`,
  );
}

function readRequiredPositiveInteger(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
  options: { readonly max?: number; readonly rangeDescription?: string } = {},
): number {
  const fieldPath = joinFieldPath(parentPath, key);
  if (!hasOwn(value, key)) {
    fail(context, fieldPath, `${fieldPath} is required.`);
  }

  return readPositiveInteger(context, value[key], fieldPath, options);
}

function readPositiveInteger(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
  options: { readonly max?: number; readonly rangeDescription?: string } = {},
): number {
  let parsed: number;

  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    fail(context, fieldPath, `${fieldPath} must be a positive integer${describeRange(options)}.`);
  }

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(context, fieldPath, `${fieldPath} must be a positive integer${describeRange(options)}.`);
  }

  if (options.max !== undefined && parsed > options.max) {
    fail(context, fieldPath, `${fieldPath} must be a positive integer ${options.rangeDescription ?? `no greater than ${options.max}`}.`);
  }

  return parsed;
}

function describeRange(options: { readonly rangeDescription?: string }): string {
  return options.rangeDescription ? ` ${options.rangeDescription}` : '';
}

function joinFieldPath(parentPath: string | undefined, key: string): string {
  return parentPath ? `${parentPath}.${key}` : key;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(
  context: ParseContext,
  fieldPath: string | undefined,
  message: string,
): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: context.configFilePath,
    ...(fieldPath ? { fieldPath } : {}),
    message,
    suggestion: `Fix ${fieldPath ?? 'the configuration'} in ${context.configFilePath} and restart the server.`,
  });
}
