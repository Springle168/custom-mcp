import { readFileSync } from 'node:fs';
import {
  buildRuntimeConfigSnapshot,
  type RuntimeConfigSnapshot,
} from './config/runtime-snapshot.js';
import { applyEnvOverridesToWorkspace } from './config/env-overrides.js';
import { ConfigError } from './config/errors.js';
import {
  getDefaultGlobalConfigPath,
  getDefaultGlobalLogsDir,
  type DefaultGlobalConfigPathOptions,
} from './config/global-config-path.js';
import { parseGlobalConfig } from './config/schema.js';
import {
  selectRuntimeWorkspace,
  type RuntimeConfigIdentity,
} from './config/workspace-selection.js';
import type { PathSafetyContext } from './utils/paths.js';

export { ConfigError, isConfigError } from './config/errors.js';
export type { ConfigErrorCode } from './config/errors.js';
export { getDefaultGlobalConfigPath, getDefaultGlobalLogsDir } from './config/global-config-path.js';
export type {
  DefaultGlobalConfigPathOptions,
  GlobalConfigLocation,
} from './config/global-config-path.js';
export type {
  LineEnding,
  RuntimeAndroidConfig,
  RuntimeConfigSnapshot,
} from './config/runtime-snapshot.js';

export interface LoadRuntimeConfigOptions extends DefaultGlobalConfigPathOptions {
  readonly workspaceId?: string;
  readonly cwd?: string;
  /** Environment values considered only for the selected workspace allowlist. */
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

export function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions = {},
): RuntimeConfigSnapshot {
  return loadRuntimeConfigWithIdentity(options).snapshot;
}

export function loadRuntimeConfigWithIdentity(
  options: LoadRuntimeConfigOptions = {},
): LoadedRuntimeConfig {
  const location = getDefaultGlobalConfigPath(options);
  const defaultLogsDir = getDefaultGlobalLogsDir(options);
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
    const selectedWorkspaceIndex = getSelectedWorkspaceIndex(
      globalConfig.workspaces,
      selection.identity.workspaceId,
      location.configFilePath,
    );
    const workspace = applyEnvOverridesToWorkspace({
      configFilePath: location.configFilePath,
      workspace: selection.workspace,
      workspaceIndex: selectedWorkspaceIndex,
      env: options.env,
    });
    const snapshot = buildRuntimeConfigSnapshot({
      configFilePath: location.configFilePath,
      workspace,
      workspaceIndex: selectedWorkspaceIndex,
      defaultLogsDir,
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

function getSelectedWorkspaceIndex(
  workspaces: readonly { readonly id: string }[],
  workspaceId: string,
  configFilePath: string,
): number {
  const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
  if (index !== -1) {
    return index;
  }

  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath,
    fieldPath: 'workspace',
    message: `Selected workspace "${workspaceId}" was not found after workspace selection.`,
    suggestion: 'Restart the server and choose a workspace id that exists in the global config workspaces array.',
  });
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
