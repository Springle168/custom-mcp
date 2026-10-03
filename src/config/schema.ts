import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { ConfigError } from './errors.js';
import {
  readOptionalWorkspaceToolsConfig,
  type ParsedWorkspaceToolsConfig,
} from './tool-exposure.js';
import { readExistingDirectoryPath } from './path-policy.js';
import {
  readIpAddress,
  readJsonPositiveInteger,
  readLineEndingToken,
  readSelectorToken,
  type ValuePolicyResult,
} from './value-policy.js';
import { readOptionalRulesConfig, type RuntimeRulesConfig } from './request-header-rules.js';

export type ParsedLineEnding = 'auto' | 'lf' | 'crlf';
const DEFAULT_WORKSPACE_HOST = '127.0.0.1';

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

export interface ParsedRootFileAccessConfig {
  readonly ignoreFiles: readonly string[];
  readonly denyFiles: readonly string[];
}

export interface ParsedFileAccessConfig {
  readonly rootDir: ParsedRootFileAccessConfig;
  readonly otherRootDirs: Readonly<Record<string, ParsedRootFileAccessConfig>>;
}

export interface ParsedWorkspaceConfig {
  readonly version: 2;
  readonly rootDir: string;
  readonly host: string;
  readonly port: number;
  readonly lineEnding: ParsedLineEnding;
  readonly logsDir?: string;
  readonly otherRootDirs: readonly string[];
  readonly android?: ParsedAndroidConfig;
  readonly envOverrides?: ParsedEnvOverridesConfig;
  readonly tools: ParsedWorkspaceToolsConfig;
  readonly rules: RuntimeRulesConfig;
  readonly fileAccess?: ParsedFileAccessConfig;
}

export interface ParseWorkspaceConfigOptions {
  readonly configFilePath: string;
}

interface ParseContext {
  readonly configFilePath: string;
}

const WORKSPACE_FIELDS = new Set([
  'version',
  'rootDir',
  'host',
  'port',
  'lineEnding',
  'logsDir',
  'otherRootDirs',
  'android',
  'envOverrides',
  'tools',
  'rules',
  'fileAccess',
]);
const ANDROID_FIELDS = new Set([
  'workspaceRoot',
  'javaHome',
  'buildTimeoutMs',
  'maxErrorBlockChars',
  'maxLogTailChars',
]);
const ENV_OVERRIDES_FIELDS = new Set(['allowedFields']);
const FILE_ACCESS_FIELDS = new Set(['rootDir', 'otherRootDirs']);
const ROOT_FILE_ACCESS_FIELDS = new Set(['ignoreFiles', 'denyFiles']);
const MAX_PORT = 65535;
const ENV_OVERRIDE_FIELD_NAMES = Object.keys(
  ENV_OVERRIDE_FIELD_ENV_VARS,
) as ParsedEnvOverrideField[];
const ENV_OVERRIDE_FIELDS = new Set<ParsedEnvOverrideField>(ENV_OVERRIDE_FIELD_NAMES);
const ENV_VAR_SELECTOR_HINTS = new Map<string, string>([
  ...ENV_OVERRIDE_FIELD_NAMES.map((field) => [ENV_OVERRIDE_FIELD_ENV_VARS[field], field] as const),
  ['MCP_ROOT_DIR', 'rootDir'],
  ['MCP_HOST', 'host'],
  ['MCP_PORT', 'port'],
]);
const FORBIDDEN_ENV_OVERRIDE_FIELDS = new Set([
  'version',
  'workspaces',
  'id',
  'rootDir',
  'host',
  'port',
  'otherRootDirs',
  'rules',
]);

export function parseWorkspaceConfig(
  value: unknown,
  options: ParseWorkspaceConfigOptions,
): ParsedWorkspaceConfig {
  const context: ParseContext = { configFilePath: options.configFilePath };
  const fieldPath = undefined;
  const rawWorkspace = readObject(
    context,
    value,
    fieldPath,
    'Workspace config file must contain a JSON object.',
  );

  assertKnownFields(context, rawWorkspace, WORKSPACE_FIELDS, fieldPath);
  if (rawWorkspace.version !== 2) {
    fail(
      context,
      'version',
      'version must be the number 2. The current server only supports workspace config schema version 2.',
    );
  }

  const android = readOptionalAndroidConfig(context, rawWorkspace.android, 'android');
  const envOverrides = readOptionalEnvOverridesConfig(
    context,
    rawWorkspace.envOverrides,
    'envOverrides',
    android !== undefined,
  );
  const rootDir = readRequiredExistingDirectoryPath(context, rawWorkspace, 'rootDir', fieldPath);
  const otherRootDirs = readOptionalExistingDirectoryPathArray(
    context,
    rawWorkspace.otherRootDirs,
    'otherRootDirs',
  );

  return deepFreezeParsedConfig({
    version: 2,
    rootDir,
    host: readOptionalHost(context, rawWorkspace.host, 'host'),
    port: readRequiredPositiveInteger(context, rawWorkspace, 'port', fieldPath, {
      max: MAX_PORT,
      rangeDescription: `between 1 and ${MAX_PORT}`,
    }),
    lineEnding: readRequiredLineEnding(context, rawWorkspace, 'lineEnding', fieldPath),
    ...readOptionalLogsDir(context, rawWorkspace.logsDir, 'logsDir'),
    otherRootDirs,
    ...(android !== undefined ? { android } : {}),
    ...(envOverrides !== undefined ? { envOverrides } : {}),
    tools: readOptionalWorkspaceToolsConfig(rawWorkspace.tools, {
      configFilePath: context.configFilePath,
      fieldPath: 'tools',
    }),
    rules: readOptionalRulesConfig(context, rawWorkspace.rules, 'rules'),
    fileAccess: readOptionalFileAccessConfig(
      context,
      rawWorkspace.fileAccess,
      'fileAccess',
      rootDir,
      otherRootDirs,
    ),
  });
}

function readOptionalFileAccessConfig(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
  primaryRoot: string,
  additionalRoots: readonly string[],
): ParsedFileAccessConfig {
  if (value === undefined) {
    return emptyFileAccessConfig();
  }

  const rawFileAccess = readObject(
    context,
    value,
    fieldPath,
    `${fieldPath} must be a JSON object when configured.`,
  );
  assertKnownFields(context, rawFileAccess, FILE_ACCESS_FIELDS, fieldPath);

  return {
    rootDir: readOptionalRootFileAccessConfig(
      context,
      rawFileAccess.rootDir,
      `${fieldPath}.rootDir`,
    ),
    otherRootDirs: readAdditionalRootFileAccessConfigs(
      context,
      rawFileAccess.otherRootDirs,
      `${fieldPath}.otherRootDirs`,
      primaryRoot,
      additionalRoots,
    ),
  };
}

function readOptionalRootFileAccessConfig(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
): ParsedRootFileAccessConfig {
  if (value === undefined) return emptyRootFileAccessConfig();

  const rawPolicy = readObject(
    context,
    value,
    fieldPath,
    `${fieldPath} must be a JSON object when configured.`,
  );
  assertKnownFields(context, rawPolicy, ROOT_FILE_ACCESS_FIELDS, fieldPath);

  return {
    ignoreFiles: readOptionalStringArray(
      context,
      rawPolicy.ignoreFiles,
      `${fieldPath}.ignoreFiles`,
    ),
    denyFiles: readOptionalStringArray(context, rawPolicy.denyFiles, `${fieldPath}.denyFiles`),
  };
}

function readAdditionalRootFileAccessConfigs(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
  primaryRoot: string,
  additionalRoots: readonly string[],
): Readonly<Record<string, ParsedRootFileAccessConfig>> {
  if (value === undefined) return Object.freeze({});

  const rawPolicies = readObject(
    context,
    value,
    fieldPath,
    `${fieldPath} must be a JSON object when configured.`,
  );
  const result: Record<string, ParsedRootFileAccessConfig> = {};
  const associatedRoots = new Set<string>();

  for (const [rootKey, rawPolicy] of Object.entries(rawPolicies)) {
    const keyPath = `${fieldPath}[${JSON.stringify(rootKey)}]`;
    const validatedKey = readConfigExistingDirectoryPath(context, rootKey, keyPath);
    if (areLexicallySamePath(validatedKey, primaryRoot)) {
      fail(context, keyPath, `${keyPath} must identify an entry in otherRootDirs, not rootDir.`);
    }

    const associatedRoot = additionalRoots.find((root) => areLexicallySamePath(root, validatedKey));
    if (associatedRoot === undefined) {
      fail(
        context,
        keyPath,
        `${keyPath} must lexically identify exactly one configured otherRootDirs entry.`,
      );
    }
    if (associatedRoots.has(associatedRoot)) {
      fail(
        context,
        keyPath,
        `${keyPath} duplicates another key for the same configured additional root.`,
      );
    }

    try {
      if (!areLexicallySamePath(realpathSync(validatedKey), realpathSync(associatedRoot))) {
        fail(context, keyPath, `${keyPath} realpath must match its configured additional root.`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      fail(
        context,
        keyPath,
        `${keyPath} could not be associated with its configured additional root. ${message}`,
      );
    }

    associatedRoots.add(associatedRoot);
    result[associatedRoot] = readOptionalRootFileAccessConfig(context, rawPolicy, keyPath);
  }

  return Object.freeze(result);
}

function readOptionalStringArray(
  context: ParseContext,
  value: unknown,
  fieldPath: string,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    fail(context, fieldPath, `${fieldPath} must be an array of non-empty strings.`);
  }

  return Object.freeze(
    value.map((item, index) => {
      const itemPath = `${fieldPath}[${index}]`;
      if (typeof item !== 'string' || item.length === 0 || item.trim() !== item) {
        fail(
          context,
          itemPath,
          `${itemPath} must be a non-empty string without leading or trailing whitespace.`,
        );
      }
      return item;
    }),
  );
}

function emptyFileAccessConfig(): ParsedFileAccessConfig {
  return {
    rootDir: emptyRootFileAccessConfig(),
    otherRootDirs: Object.freeze({}),
  };
}

function emptyRootFileAccessConfig(): ParsedRootFileAccessConfig {
  return {
    ignoreFiles: Object.freeze([]),
    denyFiles: Object.freeze([]),
  };
}

function areLexicallySamePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function readOptionalHost(context: ParseContext, value: unknown, fieldPath: string): string {
  if (value === undefined) {
    return DEFAULT_WORKSPACE_HOST;
  }

  return unwrapPolicy(context, readIpAddress(value, { fieldPath }));
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
    workspaceRoot: readRequiredExistingDirectoryPath(
      context,
      rawAndroid,
      'workspaceRoot',
      fieldPath,
    ),
    javaHome: readRequiredExistingDirectoryPath(context, rawAndroid, 'javaHome', fieldPath),
    buildTimeoutMs: readRequiredPositiveInteger(context, rawAndroid, 'buildTimeoutMs', fieldPath),
    maxErrorBlockChars: readRequiredPositiveInteger(
      context,
      rawAndroid,
      'maxErrorBlockChars',
      fieldPath,
    ),
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
    fail(
      context,
      `${fieldPath}.allowedFields`,
      `${fieldPath}.allowedFields is required when envOverrides is configured.`,
    );
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
    const selector = unwrapPolicy(context, readSelectorToken(item, { fieldPath: itemPath }));
    const envVarSelectorHint = ENV_VAR_SELECTOR_HINTS.get(selector);

    if (envVarSelectorHint !== undefined) {
      fail(
        context,
        itemPath,
        `envOverrides.allowedFields contains environment variable name "${selector}". Use config field selector "${envVarSelectorHint}" instead.`,
      );
    }

    if (isForbiddenEnvOverrideField(selector)) {
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

function readRequiredExistingDirectoryPath(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  parentPath: string | undefined,
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
    readConfigExistingDirectoryPath(context, item, `${fieldPath}[${index}]`),
  );
}

function readRequiredLineEnding(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  parentPath: string | undefined,
): ParsedLineEnding {
  const fieldPath = joinFieldPath(parentPath, key);
  assertRequired(context, value, key, fieldPath);
  return unwrapPolicy(context, readLineEndingToken(value[key], { fieldPath }));
}

function readRequiredPositiveInteger(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  parentPath: string | undefined,
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

function isForbiddenEnvOverrideField(selector: string): boolean {
  return (
    FORBIDDEN_ENV_OVERRIDE_FIELDS.has(selector) ||
    selector === 'rules' ||
    selector.startsWith('rules.') ||
    selector === 'tools' ||
    selector.startsWith('tools.') ||
    selector === 'fileAccess' ||
    selector.startsWith('fileAccess.')
  );
}

function joinFieldPath(parentPath: string | undefined, key: string): string {
  return parentPath ? `${parentPath}.${key}` : key;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(context: ParseContext, fieldPath: string | undefined, message: string): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: context.configFilePath,
    ...(fieldPath ? { fieldPath } : {}),
    message,
    suggestion: `Fix ${fieldPath ?? 'the configuration'} in ${context.configFilePath} and restart the server.`,
  });
}

function deepFreezeParsedConfig<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const propertyValue of Object.values(value as Record<string, unknown>)) {
    deepFreezeParsedConfig(propertyValue);
  }

  return Object.freeze(value);
}
