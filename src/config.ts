import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from './config/errors.js';
import {
  getDefaultGlobalConfigPath,
  type DefaultGlobalConfigPathOptions,
} from './config/global-config-path.js';
import {
  parseGlobalConfig,
} from './config/schema.js';
import {
  selectRuntimeWorkspace,
  type RuntimeConfigIdentity,
} from './config/workspace-selection.js';
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
export type {
  RuntimeConfigIdentity,
  RuntimeConfigSelectionMode,
  RuntimeWorkspaceSelection,
  SelectRuntimeWorkspaceOptions,
} from './config/workspace-selection.js';

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
  readonly workspaceId?: string;
  readonly cwd?: string;
  /** Reserved for phase 5 allowlisted env overrides; phase 4 intentionally ignores legacy env values. */
  readonly env?: NodeJS.ProcessEnv;
  readonly snapshotVersion?: number;
}

export interface LoadedRuntimeConfig {
  readonly snapshot: RuntimeConfigSnapshot;
  readonly identity: RuntimeConfigIdentity;
}

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
  return loadRuntimeConfigWithIdentity(options).snapshot;
}

export function loadRuntimeConfigWithIdentity(
  options: LoadRuntimeConfigOptions = {},
): LoadedRuntimeConfig {
  const location = getDefaultGlobalConfigPath(options);
  const raw = readConfigFile(location.configFilePath);
  const parsed = parseConfigFile(raw, location.configFilePath);

  try {
    const globalConfig = parseGlobalConfig(parsed, {
      configFilePath: location.configFilePath,
    });
    const selection = selectRuntimeWorkspace({
      configFilePath: location.configFilePath,
      workspaces: globalConfig.workspaces,
      ...(options.workspaceId !== undefined ? { workspaceId: options.workspaceId } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    });
    const workspace = selection.workspace;
    const snapshot = createRuntimeConfigSnapshot({
      configFilePath: location.configFilePath,
      workspaceId: workspace.id,
      rootDir: workspace.rootDir,
      otherRootDirs: workspace.otherRootDirs,
      port: workspace.port,
      lineEnding: workspace.lineEnding,
      ...normalizeRuntimeAndroidConfig(workspace.android),
      snapshotVersion: options.snapshotVersion ?? 1,
    });

    return Object.freeze({
      snapshot,
      identity: selection.identity,
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

function normalizeRuntimeAndroidConfig(
  android: RuntimeAndroidConfig | undefined,
): { readonly android?: RuntimeAndroidConfig } {
  if (android === undefined) {
    return {};
  }

  return {
    android: {
      ...android,
      workspaceRoot: resolve(android.workspaceRoot),
      javaHome: resolve(android.javaHome),
    },
  };
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
