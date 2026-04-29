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

interface RawAndroidConfig {
  workspaceRoot?: unknown;
  javaHome?: unknown;
  buildTimeoutMs?: unknown;
  maxErrorBlockChars?: unknown;
  maxLogTailChars?: unknown;
}

interface RawConfig {
  rootDir?: unknown;
  lineEnding?: unknown;
  port?: unknown;
  android?: RawAndroidConfig;
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

function buildAndroidConfig(raw: RawAndroidConfig | undefined): AndroidConfig | undefined {
  const workspaceRoot = readOptionalString(
    process.env.ANDROID_WORKSPACE_ROOT ?? raw?.workspaceRoot,
  );
  const javaHome = readOptionalString(
    process.env.ANDROID_JAVA_HOME ?? raw?.javaHome,
  );

  const buildTimeoutMsSource =
    process.env.ANDROID_BUILD_TIMEOUT_MS ?? raw?.buildTimeoutMs;
  const maxErrorBlockCharsSource =
    process.env.ANDROID_MAX_ERROR_BLOCK_CHARS ?? raw?.maxErrorBlockChars;
  const maxLogTailCharsSource =
    process.env.ANDROID_MAX_LOG_TAIL_CHARS ?? raw?.maxLogTailChars;

  const hasAndroidConfig =
    raw !== undefined ||
    workspaceRoot !== undefined ||
    javaHome !== undefined ||
    buildTimeoutMsSource !== undefined ||
    maxErrorBlockCharsSource !== undefined ||
    maxLogTailCharsSource !== undefined;

  if (!hasAndroidConfig) {
    return undefined;
  }

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

export function loadConfig(): Config {
  let fileConfig: RawConfig = {};

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    fileConfig = JSON.parse(raw) as RawConfig;
  } catch (err) {
    console.error(`Failed to read config file at ${CONFIG_PATH}`);
    console.error(err);
    process.exit(1);
  }

  try {
    const config: Config = {
      rootDir: readRequiredString(
        process.env.MCP_ROOT_DIR ?? fileConfig.rootDir,
      ),
      lineEnding: readLineEnding(
        process.env.MCP_LINE_ENDING ?? fileConfig.lineEnding,
      ),
      port: readPositiveInt('MCP_PORT', process.env.MCP_PORT ?? fileConfig.port, 3100),
      android: buildAndroidConfig(fileConfig.android),
    };

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
