import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from './config/errors.js';
import {
  getDefaultGlobalConfigPath,
  type DefaultGlobalConfigPathOptions,
} from './config/global-config-path.js';
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

export interface AndroidConfig {
  workspaceRoot?: string;
  javaHome?: string;
  buildTimeoutMs: number;
  maxErrorBlockChars: number;
  maxLogTailChars: number;
}

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

export interface Config {
  rootDir: string;
  otherRootDirs?: string[];
  lineEnding: LineEnding;
  port: number;
  android?: AndroidConfig;
  pathSafetyContext?: PathSafetyContext;
}

export interface AndroidConfigSource {
  workspaceRoot?: unknown;
  javaHome?: unknown;
  buildTimeoutMs?: unknown;
  maxErrorBlockChars?: unknown;
  maxLogTailChars?: unknown;
}

export interface ConfigSource {
  rootDir?: unknown;
  otherRootDirs?: unknown;
  lineEnding?: unknown;
  port?: unknown;
  android?: AndroidConfigSource;
}

const DEFAULT_ANDROID_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_ANDROID_MAX_ERROR_BLOCK_CHARS = 2500;
const DEFAULT_ANDROID_MAX_LOG_TAIL_CHARS = 4000;
const MINIMAL_TRANSITIONAL_CONFIG_EXAMPLE = `{
  "rootDir": "E:/Workspace/YourProject",
  "port": 3100,
  "lineEnding": "auto"
}`;

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(value: unknown): string {
  return readOptionalString(value) || '';
}

function readOptionalStringArray(
  name: string,
  value: unknown,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of non-empty strings.`);
  }

  if (value.length === 0) {
    return undefined;
  }

  return value.map((item, index) => {
    const parsed = readOptionalString(item);
    if (parsed === undefined) {
      throw new Error(`${name}[${index}] must be a non-empty string.`);
    }
    return parsed;
  });
}

function readLineEnding(value: unknown): LineEnding {
  if (value === undefined) {
    return 'auto';
  }

  if (value === 'auto' || value === 'lf' || value === 'crlf') {
    return value;
  }

  throw new Error(
    `Invalid lineEnding: ${String(value)}. Expected one of: auto, lf, crlf.`,
  );
}

function readPositiveInt(
  name: string,
  value: unknown,
  fallback: number,
): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed =
    typeof value === 'number' ? value : Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function getEnvOverride(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  return readOptionalString(env[name]);
}

function getConfiguredValue(
  env: NodeJS.ProcessEnv,
  envName: string,
  fileValue: unknown,
): unknown {
  return getEnvOverride(env, envName) ?? fileValue;
}

function hasAndroidEnvOverrides(env: NodeJS.ProcessEnv): boolean {
  return (
    getEnvOverride(env, 'ANDROID_WORKSPACE_ROOT') !== undefined ||
    getEnvOverride(env, 'ANDROID_JAVA_HOME') !== undefined ||
    getEnvOverride(env, 'ANDROID_BUILD_TIMEOUT_MS') !== undefined ||
    getEnvOverride(env, 'ANDROID_MAX_ERROR_BLOCK_CHARS') !== undefined ||
    getEnvOverride(env, 'ANDROID_MAX_LOG_TAIL_CHARS') !== undefined
  );
}

function buildAndroidConfig(
  raw: AndroidConfigSource | undefined,
  env: NodeJS.ProcessEnv,
): AndroidConfig | undefined {
  const workspaceRootSource = getConfiguredValue(
    env,
    'ANDROID_WORKSPACE_ROOT',
    raw?.workspaceRoot,
  );
  const javaHomeSource = getConfiguredValue(
    env,
    'ANDROID_JAVA_HOME',
    raw?.javaHome,
  );
  const buildTimeoutMsSource = getConfiguredValue(
    env,
    'ANDROID_BUILD_TIMEOUT_MS',
    raw?.buildTimeoutMs,
  );
  const maxErrorBlockCharsSource = getConfiguredValue(
    env,
    'ANDROID_MAX_ERROR_BLOCK_CHARS',
    raw?.maxErrorBlockChars,
  );
  const maxLogTailCharsSource = getConfiguredValue(
    env,
    'ANDROID_MAX_LOG_TAIL_CHARS',
    raw?.maxLogTailChars,
  );

  const hasAndroidConfig = raw !== undefined || hasAndroidEnvOverrides(env);

  if (!hasAndroidConfig) {
    return undefined;
  }

  const workspaceRoot = readOptionalString(workspaceRootSource);
  const javaHome = readOptionalString(javaHomeSource);

  return {
    workspaceRoot: workspaceRoot ? resolve(workspaceRoot) : undefined,
    javaHome: javaHome ? resolve(javaHome) : undefined,
    buildTimeoutMs: readPositiveInt(
      'ANDROID_BUILD_TIMEOUT_MS',
      buildTimeoutMsSource,
      DEFAULT_ANDROID_BUILD_TIMEOUT_MS,
    ),
    maxErrorBlockChars: readPositiveInt(
      'ANDROID_MAX_ERROR_BLOCK_CHARS',
      maxErrorBlockCharsSource,
      DEFAULT_ANDROID_MAX_ERROR_BLOCK_CHARS,
    ),
    maxLogTailChars: readPositiveInt(
      'ANDROID_MAX_LOG_TAIL_CHARS',
      maxLogTailCharsSource,
      DEFAULT_ANDROID_MAX_LOG_TAIL_CHARS,
    ),
  };
}

export function buildConfig(
  fileConfig: ConfigSource = {},
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const rootDir = readRequiredString(
    getConfiguredValue(env, 'MCP_ROOT_DIR', fileConfig.rootDir),
  );
  const otherRootDirs = readOptionalStringArray(
    'otherRootDirs',
    fileConfig.otherRootDirs,
  );

  return {
    rootDir,
    ...(otherRootDirs ? { otherRootDirs } : {}),
    lineEnding: readLineEnding(
      getConfiguredValue(env, 'MCP_LINE_ENDING', fileConfig.lineEnding),
    ),
    port: readPositiveInt(
      'MCP_PORT',
      getConfiguredValue(env, 'MCP_PORT', fileConfig.port),
      3100,
    ),
    android: buildAndroidConfig(fileConfig.android, env),
  };
}

export function attachValidatedPathSafetyContext(
  config: Config,
): Config & { pathSafetyContext: PathSafetyContext } {
  return {
    ...config,
    pathSafetyContext: createValidatedPathSafetyContext(
      config.rootDir,
      config.otherRootDirs ?? [],
    ),
  };
}

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
  const fileConfig = parseConfigFile(raw, location.configFilePath);

  try {
    const config = buildConfig(fileConfig, options.env ?? process.env);

    if (!config.rootDir) {
      throw new ConfigError({
        code: 'config_validation_failed',
        configFilePath: location.configFilePath,
        fieldPath: 'rootDir',
        message: 'rootDir is not configured.',
        suggestion:
          `Set rootDir in ${location.configFilePath}. ` +
          'The server no longer reads config.json from the repository root.',
      });
    }

    const android = toRuntimeAndroidConfig(config.android);

    return createRuntimeConfigSnapshot({
      configFilePath: location.configFilePath,
      workspaceId: 'default',
      rootDir: config.rootDir,
      otherRootDirs: config.otherRootDirs ?? [],
      port: config.port,
      lineEnding: config.lineEnding,
      ...(android ? { android } : {}),
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
          `Minimum config for the current migration step:\n${MINIMAL_TRANSITIONAL_CONFIG_EXAMPLE}`,
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

function parseConfigFile(raw: string, configFilePath: string): ConfigSource {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
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

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath,
      message: 'Config file must contain a JSON object.',
      suggestion: `Replace ${configFilePath} with a JSON object configuration.`,
    });
  }

  return parsed as ConfigSource;
}

function toRuntimeAndroidConfig(
  androidConfig: AndroidConfig | undefined,
): RuntimeAndroidConfig | undefined {
  if (!androidConfig?.workspaceRoot || !androidConfig.javaHome) {
    return undefined;
  }

  return {
    workspaceRoot: androidConfig.workspaceRoot,
    javaHome: androidConfig.javaHome,
    buildTimeoutMs: androidConfig.buildTimeoutMs,
    maxErrorBlockChars: androidConfig.maxErrorBlockChars,
    maxLogTailChars: androidConfig.maxLogTailChars,
  };
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
