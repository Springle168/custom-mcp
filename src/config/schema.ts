import { ConfigError } from './errors.js';
import { readExistingDirectoryPath } from './path-policy.js';
import {
  readJsonPositiveInteger,
  readLineEndingToken,
  readTypedString,
  readWorkspaceIdToken,
  type ValuePolicyResult,
} from './value-policy.js';
import { validateWorkspaceRootPathSet } from '../utils/paths.js';

export type ParsedLineEnding = 'auto' | 'lf' | 'crlf';

export interface ParsedAndroidConfig {
  readonly workspaceRoot: string;
  readonly javaHome: string;
  readonly buildTimeoutMs: number;
  readonly maxErrorBlockChars: number;
  readonly maxLogTailChars: number;
}

export const ENV_OVERRIDE_FIELD_ENV_VARS = {
  lineEnding: 'MCP_LINE_ENDING',
  logsDir: 'MCP_LOGS_DIR',
  'android.workspaceRoot': 'ANDROID_WORKSPACE_ROOT',
  'android.javaHome': 'ANDROID_JAVA_HOME',
  'android.buildTimeoutMs': 'ANDROID_BUILD_TIMEOUT_MS',
  'android.maxErrorBlockChars': 'ANDROID_MAX_ERROR_BLOCK_CHARS',
  'android.maxLogTailChars': 'ANDROID_MAX_LOG_TAIL_CHARS',
} as const;

export type ParsedEnvOverrideField = keyof typeof ENV_OVERRIDE_FIELD_ENV_VARS;

export interface ParsedEnvOverridesConfig {
  readonly allowedFields: readonly ParsedEnvOverrideField[];
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
const MAX_PORT = 65535;
const ENV_OVERRIDE_FIELD_NAMES = Object.keys(ENV_OVERRIDE_FIELD_ENV_VARS) as ParsedEnvOverrideField[];
const ENV_OVERRIDE_FIELDS = new Set<ParsedEnvOverrideField>(ENV_OVERRIDE_FIELD_NAMES);
const ENV_VAR_SELECTOR_HINTS = new Map<string, string>([
  ...ENV_OVERRIDE_FIELD_NAMES.map((field) => [ENV_OVERRIDE_FIELD_ENV_VARS[field], field] as const),
  ['MCP_ROOT_DIR', 'rootDir'],
  ['MCP_PORT', 'port'],
]);
const FORBIDDEN_ENV_OVERRIDE_FIELDS = new Set([
  'version',
  'workspaces',
  'id',
  'rootDir',
  'port',
  'otherRootDirs',
  'rules',
]);

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

  validateGlobalWorkspaceRoots(context, workspaces);

  return {
    version: 1,
    workspaces,
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

  const android = readOptionalAndroidConfig(context, rawWorkspace.android, `${fieldPath}.android`);
  const envOverrides = readOptionalEnvOverridesConfig(
    context,
    rawWorkspace.envOverrides,
    `${fieldPath}.envOverrides`,
    android !== undefined,
  );

  return {
    id: readRequiredWorkspaceId(context, rawWorkspace, 'id', fieldPath),
    rootDir: readRequiredExistingDirectoryPath(context, rawWorkspace, 'rootDir', fieldPath),
    port: readRequiredPositiveInteger(context, rawWorkspace, 'port', fieldPath, {
      max: MAX_PORT,
      rangeDescription: `between 1 and ${MAX_PORT}`,
    }),
    lineEnding: readRequiredLineEnding(context, rawWorkspace, 'lineEnding', fieldPath),
    ...readOptionalLogsDir(context, rawWorkspace.logsDir, `${fieldPath}.logsDir`),
    otherRootDirs: readOptionalExistingDirectoryPathArray(context, rawWorkspace.otherRootDirs, `${fieldPath}.otherRootDirs`),
    ...(android !== undefined ? { android } : {}),
    ...(envOverrides !== undefined ? { envOverrides } : {}),
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

  return { logsDir: readConfigExistingDirectoryPath(context, value, fieldPath) };
}

function readOptionalAndroidConfig(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
): ParsedAndroidConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  const rawAndroid = readObject(
    context,
    value,
    fieldPath,
    `${fieldPath} must be a JSON object when configured.`,
  );
  assertKnownFields(context, rawAndroid, ANDROID_FIELDS, fieldPath);

  return {
    workspaceRoot: readRequiredExistingDirectoryPath(context, rawAndroid, 'workspaceRoot', fieldPath),
    javaHome: readRequiredExistingDirectoryPath(context, rawAndroid, 'javaHome', fieldPath),
    buildTimeoutMs: readRequiredPositiveInteger(context, rawAndroid, 'buildTimeoutMs', fieldPath),
    maxErrorBlockChars: readRequiredPositiveInteger(context, rawAndroid, 'maxErrorBlockChars', fieldPath),
    maxLogTailChars: readRequiredPositiveInteger(context, rawAndroid, 'maxLogTailChars', fieldPath),
  };
}

function readOptionalEnvOverridesConfig(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
  hasAndroidConfig: boolean,
): ParsedEnvOverridesConfig | undefined {
  if (value === undefined) {
    return undefined;
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
    allowedFields: readAllowedFields(
      context,
      rawEnvOverrides.allowedFields,
      `${fieldPath}.allowedFields`,
      hasAndroidConfig,
    ),
  };
}

function readAllowedFields(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
  hasAndroidConfig: boolean,
): ParsedEnvOverrideField[] {
  if (!Array.isArray(value)) {
    fail(context, fieldPath, `${fieldPath} must be an array of non-empty strings.`);
  }

  const seen = new Set<ParsedEnvOverrideField>();
  return value.map((item, index) => {
    const itemPath = `${fieldPath}[${index}]`;
    const selector = unwrapPolicy(context, readTypedString(item, { fieldPath: itemPath }));
    const envVarSelectorHint = ENV_VAR_SELECTOR_HINTS.get(selector);

    if (envVarSelectorHint !== undefined) {
      fail(
        context,
        itemPath,
        `envOverrides.allowedFields contains environment variable name "${selector}". Use config field selector "${envVarSelectorHint}" instead.`,
      );
    }

    if (FORBIDDEN_ENV_OVERRIDE_FIELDS.has(selector)) {
      fail(
        context,
        itemPath,
        `envOverrides.allowedFields contains forbidden field "${selector}". Boundary fields cannot be overridden by environment variables.`,
      );
    }

    if (!isEnvOverrideField(selector)) {
      fail(
        context,
        itemPath,
        `envOverrides.allowedFields contains unknown field "${selector}". Allowed fields are: ${ENV_OVERRIDE_FIELD_NAMES.join(', ')}.`,
      );
    }

    if (seen.has(selector)) {
      fail(
        context,
        itemPath,
        `envOverrides.allowedFields contains duplicate field "${selector}". Remove duplicate allowlist entries.`,
      );
    }
    seen.add(selector);

    if (selector.startsWith('android.') && !hasAndroidConfig) {
      fail(
        context,
        itemPath,
        `envOverrides.allowedFields contains Android field "${selector}", but the same workspace android is not configured. Android env overrides can only override an existing complete android config block.`,
      );
    }

    return selector;
  });
}

function validateGlobalWorkspaceRoots(
  context: ParseContext,
  workspaces: readonly ParsedWorkspaceConfig[],
): void {
  try {
    validateWorkspaceRootPathSet(
      workspaces.map((workspace, index) => ({
        label: `workspaces[${index}].rootDir`,
        rootDir: workspace.rootDir,
      })),
    );
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

function readRequiredWorkspaceId(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
): string {
  const fieldPath = joinFieldPath(parentPath, key);
  assertRequired(context, value, key, fieldPath);
  return unwrapPolicy(context, readWorkspaceIdToken(value[key], { fieldPath }));
}

function readRequiredExistingDirectoryPath(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
): string {
  const fieldPath = joinFieldPath(parentPath, key);
  assertRequired(context, value, key, fieldPath);
  return readConfigExistingDirectoryPath(context, value[key], fieldPath);
}

function readConfigExistingDirectoryPath(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
): string {
  return unwrapPolicy(context, readExistingDirectoryPath(value, { fieldPath }));
}

function readOptionalExistingDirectoryPathArray(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    fail(context, fieldPath, `${fieldPath} must be an array of non-empty strings.`);
  }

  return value.map((item, index) =>
    readConfigExistingDirectoryPath(context, item, `${fieldPath}[${index}]`)
  );
}

function readRequiredLineEnding(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
): ParsedLineEnding {
  const fieldPath = joinFieldPath(parentPath, key);
  assertRequired(context, value, key, fieldPath);
  return unwrapPolicy(context, readLineEndingToken(value[key], { fieldPath }));
}

function readRequiredPositiveInteger(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  parentPath: string,
  options: { readonly max?: number; readonly rangeDescription?: string } = {},
): number {
  const fieldPath = joinFieldPath(parentPath, key);
  assertRequired(context, value, key, fieldPath);
  return unwrapPolicy(context, readJsonPositiveInteger(value[key], { fieldPath, ...options }));
}

function assertRequired(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  fieldPath: string,
): void {
  if (!hasOwn(value, key)) {
    fail(context, fieldPath, `${fieldPath} is required.`);
  }
}

function unwrapPolicy<T>(context: ParseContext, result: ValuePolicyResult<T>): T {
  if (!result.ok) {
    fail(context, result.error.fieldPath, result.error.message);
  }

  return result.value;
}

function isEnvOverrideField(field: string): field is ParsedEnvOverrideField {
  return ENV_OVERRIDE_FIELDS.has(field as ParsedEnvOverrideField);
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
