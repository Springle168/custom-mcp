import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from './config/errors.js';
import {
  getDefaultGlobalConfigPath,
  type DefaultGlobalConfigPathOptions,
} from './config/global-config-path.js';
import {
  parseGlobalConfig,
  type ParsedWorkspaceConfig,
} from './config/schema.js';
import {
  createValidatedPathSafetyContext,
  type PathSafetyContext,
} from './utils/paths.js';

export { ConfigError, isConfigError } from './config/errors.js';
export type { ConfigErrorCode } from './config/errors.js';
export { getDefaultGlobalConfigPath } from './config/global-config-path.js';
export type {
  DefaultGlobalConfigPathOptions,
  GlobalConfigLocation,
} from './config/global-config-path.js';

export type LineEnding = 'auto' | 'lf' | 'crlf';

export interface RuntimeAndroidConfig {
  readonly workspaceRoot: string;
  readonly javaHome: string;
  readonly buildTimeoutMs: number;
  readonly maxErrorBlockChars: number;
  readonly maxLogTailChars: number;
}

export interface RuntimeConfigSnapshot {
  readonly snapshotVersion: number;
  readonly configFilePath: string;
  readonly workspaceId: string;
  readonly rootDir: string;
  readonly otherRootDirs: readonly string[];
  readonly port: number;
  readonly lineEnding: LineEnding;
  readonly android?: RuntimeAndroidConfig;
  readonly pathSafetyContext: PathSafetyContext;
}

export interface RuntimeConfigSnapshotInput {
  readonly snapshotVersion?: number;
  readonly configFilePath: string;
  readonly workspaceId: string;
  readonly rootDir: string;
  readonly otherRootDirs?: readonly string[];
  readonly port: number;
  readonly lineEnding: LineEnding;
  readonly android?: RuntimeAndroidConfig;
}

export interface LoadRuntimeConfigOptions extends DefaultGlobalConfigPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly snapshotVersion?: number;
}

interface Phase3RuntimeWorkspace {
  readonly id: string;
  readonly rootDir: string;
  readonly otherRootDirs: readonly string[];
  readonly port: number;
  readonly lineEnding: LineEnding;
  readonly android?: RuntimeAndroidConfig;
}

const DEFAULT_ANDROID_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_ANDROID_MAX_ERROR_BLOCK_CHARS = 2500;
const DEFAULT_ANDROID_MAX_LOG_TAIL_CHARS = 4000;

const MINIMAL_GLOBAL_CONFIG_EXAMPLE = `{
  "version": 1,
  "workspaces": [
    {
      "id": "your-workspace",
      "rootDir": "E:/Workspace/YourProject",
      "port": 3100,
      "lineEnding": "auto"
    }
  ]
}`;

export function getPathSafetyContext(config: {
  pathSafetyContext: PathSafetyContext;
}): PathSafetyContext {
  return config.pathSafetyContext;
}

export function createRuntimeConfigSnapshot(
  input: RuntimeConfigSnapshotInput,
): RuntimeConfigSnapshot {
  const otherRootDirs = [...(input.otherRootDirs ?? [])];
  const pathSafetyContext = createValidatedPathSafetyContext(
    input.rootDir,
    otherRootDirs,
  );

  const snapshot: RuntimeConfigSnapshot = {
    snapshotVersion: input.snapshotVersion ?? 1,
    configFilePath: input.configFilePath,
    workspaceId: input.workspaceId,
    rootDir: input.rootDir,
    otherRootDirs,
    port: input.port,
    lineEnding: input.lineEnding,
    ...(input.android ? { android: { ...input.android } } : {}),
    pathSafetyContext,
  };

  return deepFreeze(snapshot);
}

export function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions = {},
): RuntimeConfigSnapshot {
  const location = getDefaultGlobalConfigPath(options);
  const raw = readConfigFile(location.configFilePath);
  const parsed = parseConfigFile(raw, location.configFilePath);

  try {
    const globalConfig = parseGlobalConfig(parsed, {
      configFilePath: location.configFilePath,
    });
    const workspace = applyPhase3LegacyEnvOverrides(
      selectPhase3Workspace(globalConfig.workspaces, location.configFilePath),
      options.env ?? process.env,
    );

    return createRuntimeConfigSnapshot({
      configFilePath: location.configFilePath,
      workspaceId: workspace.id,
      rootDir: workspace.rootDir,
      otherRootDirs: workspace.otherRootDirs,
      port: workspace.port,
      lineEnding: workspace.lineEnding,
      ...(workspace.android ? { android: workspace.android } : {}),
      snapshotVersion: options.snapshotVersion ?? 1,
    });
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: location.configFilePath,
      message,
      suggestion: `Fix the configuration in ${location.configFilePath} and restart the server.`,
      cause: err,
    });
  }
}

function selectPhase3Workspace(
  workspaces: readonly ParsedWorkspaceConfig[],
  configFilePath: string,
): ParsedWorkspaceConfig {
  const workspace = workspaces[0];
  if (workspace) {
    return workspace;
  }

  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath,
    fieldPath: 'workspaces',
    message: 'workspaces must contain at least one workspace.',
    suggestion: `Add at least one workspace to ${configFilePath} and restart the server.`,
  });
}

function applyPhase3LegacyEnvOverrides(
  workspace: ParsedWorkspaceConfig,
  env: NodeJS.ProcessEnv,
): Phase3RuntimeWorkspace {
  // Phase 5 will replace this compatibility bridge with workspace allowlisted env overrides.
  const lineEndingOverride = readOptionalEnvString(env, 'MCP_LINE_ENDING');

  return {
    id: workspace.id,
    rootDir: readOptionalEnvString(env, 'MCP_ROOT_DIR') ?? workspace.rootDir,
    otherRootDirs: workspace.otherRootDirs,
    port: readOptionalEnvString(env, 'MCP_PORT') === undefined
      ? workspace.port
      : readPositiveInteger('MCP_PORT', readOptionalEnvString(env, 'MCP_PORT'), {
        max: 65535,
        rangeDescription: 'between 1 and 65535',
      }),
    lineEnding: lineEndingOverride === undefined
      ? workspace.lineEnding
      : readLineEnding('MCP_LINE_ENDING', lineEndingOverride),
    ...buildPhase3LegacyAndroidConfig(workspace.android, env),
  };
}

function buildPhase3LegacyAndroidConfig(
  android: RuntimeAndroidConfig | undefined,
  env: NodeJS.ProcessEnv,
): { readonly android?: RuntimeAndroidConfig } {
  const workspaceRoot = readOptionalEnvString(env, 'ANDROID_WORKSPACE_ROOT') ?? android?.workspaceRoot;
  const javaHome = readOptionalEnvString(env, 'ANDROID_JAVA_HOME') ?? android?.javaHome;
  const hasAndroidEnvOverrides = [
    'ANDROID_WORKSPACE_ROOT',
    'ANDROID_JAVA_HOME',
    'ANDROID_BUILD_TIMEOUT_MS',
    'ANDROID_MAX_ERROR_BLOCK_CHARS',
    'ANDROID_MAX_LOG_TAIL_CHARS',
  ].some((name) => readOptionalEnvString(env, name) !== undefined);

  if (android === undefined && !hasAndroidEnvOverrides) {
    return {};
  }

  if (!workspaceRoot || !javaHome) {
    return {};
  }

  return {
    android: {
      workspaceRoot: resolve(workspaceRoot),
      javaHome: resolve(javaHome),
      buildTimeoutMs: readPositiveInteger(
        'ANDROID_BUILD_TIMEOUT_MS',
        readOptionalEnvString(env, 'ANDROID_BUILD_TIMEOUT_MS') ?? android?.buildTimeoutMs,
        { fallback: DEFAULT_ANDROID_BUILD_TIMEOUT_MS },
      ),
      maxErrorBlockChars: readPositiveInteger(
        'ANDROID_MAX_ERROR_BLOCK_CHARS',
        readOptionalEnvString(env, 'ANDROID_MAX_ERROR_BLOCK_CHARS') ?? android?.maxErrorBlockChars,
        { fallback: DEFAULT_ANDROID_MAX_ERROR_BLOCK_CHARS },
      ),
      maxLogTailChars: readPositiveInteger(
        'ANDROID_MAX_LOG_TAIL_CHARS',
        readOptionalEnvString(env, 'ANDROID_MAX_LOG_TAIL_CHARS') ?? android?.maxLogTailChars,
        { fallback: DEFAULT_ANDROID_MAX_LOG_TAIL_CHARS },
      ),
    },
  };
}

function readOptionalEnvString(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readLineEnding(name: string, value: unknown): LineEnding {
  if (value === 'auto' || value === 'lf' || value === 'crlf') {
    return value;
  }

  throw new Error(`${name} must be one of: auto, lf, crlf.`);
}

function readPositiveInteger(
  name: string,
  value: unknown,
  options: {
    readonly fallback?: number;
    readonly max?: number;
    readonly rangeDescription?: string;
  } = {},
): number {
  if (value === undefined || value === null || value === '') {
    if (options.fallback !== undefined) {
      return options.fallback;
    }
    throw new Error(`${name} must be a positive integer${describeRange(options)}.`);
  }

  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    throw new Error(`${name} must be a positive integer${describeRange(options)}.`);
  }

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer${describeRange(options)}.`);
  }

  if (options.max !== undefined && parsed > options.max) {
    throw new Error(`${name} must be a positive integer ${options.rangeDescription ?? `no greater than ${options.max}`}.`);
  }

  return parsed;
}

function describeRange(options: { readonly rangeDescription?: string }): string {
  return options.rangeDescription ? ` ${options.rangeDescription}` : '';
}

function readConfigFile(configFilePath: string): string {
  try {
    return readFileSync(configFilePath, 'utf-8');
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;

    if (error.code === 'ENOENT') {
      throw new ConfigError({
        code: 'config_file_not_found',
        configFilePath,
        message: `Global config file does not exist: ${configFilePath}`,
        suggestion:
          `Create ${configFilePath}. The server no longer reads config.json from the repository root.\n` +
          `Minimum global config:\n${MINIMAL_GLOBAL_CONFIG_EXAMPLE}`,
        cause: err,
      });
    }

    throw new ConfigError({
      code: 'config_file_read_failed',
      configFilePath,
      message: `Failed to read global config file at ${configFilePath}: ${error.message}`,
      suggestion: 'Check that the file exists and that the current user can read it.',
      cause: err,
    });
  }
}

function parseConfigFile(raw: string, configFilePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError({
      code: 'config_json_invalid',
      configFilePath,
      message: `Config file contains invalid JSON: ${message}`,
      suggestion: `Fix the JSON syntax in ${configFilePath} and restart the server.`,
      cause: err,
    });
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const propertyValue of Object.values(value as Record<string, unknown>)) {
    deepFreeze(propertyValue);
  }

  return Object.freeze(value);
}
