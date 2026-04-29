import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AndroidConfig {
  workspaceRoot?: string;
  javaHome?: string;
  buildTimeoutMs: number;
  maxErrorBlockChars: number;
  maxLogTailChars: number;
}

export interface Config {
  rootDir: string;
  lineEnding: 'auto' | 'lf' | 'crlf';
  port: number;
  android?: AndroidConfig;
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
  lineEnding?: unknown;
  port?: unknown;
  android?: AndroidConfigSource;
}

const DEFAULT_ANDROID_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_ANDROID_MAX_ERROR_BLOCK_CHARS = 2500;
const DEFAULT_ANDROID_MAX_LOG_TAIL_CHARS = 4000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');

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

function readLineEnding(value: unknown): Config['lineEnding'] {
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
  return {
    rootDir: readRequiredString(
      getConfiguredValue(env, 'MCP_ROOT_DIR', fileConfig.rootDir),
    ),
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

export function loadConfig(): Config {
  let fileConfig: ConfigSource = {};

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    fileConfig = JSON.parse(raw) as ConfigSource;
  } catch (err) {
    console.error(`Failed to read config file at ${CONFIG_PATH}`);
    console.error(err);
    process.exit(1);
  }

  try {
    const config = buildConfig(fileConfig);

    if (!config.rootDir) {
      console.error(
        'Error: rootDir is not configured.\n' +
          `Please set it in ${CONFIG_PATH} or via MCP_ROOT_DIR environment variable.`,
      );
      process.exit(1);
    }

    return config;
  } catch (err) {
    console.error(`Invalid config in ${CONFIG_PATH}`);
    console.error(err);
    process.exit(1);
  }
}
