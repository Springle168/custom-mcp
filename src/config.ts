import { readFileSync, statSync } from 'node:fs';
import {
  buildRuntimeConfigSnapshot,
  type RuntimeConfigSnapshot,
} from './config/runtime-snapshot.js';
import { applyEnvOverridesToWorkspace } from './config/env-overrides.js';
import { compileWorkspaceFileAccessPolicy } from './config/file-access-policy.js';
import { ConfigError } from './config/errors.js';
import {
  getDefaultGlobalConfigPath,
  getDefaultGlobalLogsDir,
  type DefaultGlobalConfigPathOptions,
} from './config/global-config-path.js';
import { parseGlobalConfig } from './config/global-config-schema.js';
import { parseWorkspaceConfig } from './config/schema.js';
import {
  createRuntimeConfigIdentity,
  selectWorkspaceReference,
  type RuntimeConfigIdentity,
} from './config/workspace-selection.js';
import type { PathSafetyContext } from './utils/paths.js';

export { ConfigError, isConfigError } from './config/errors.js';
export type { ConfigErrorCode } from './config/errors.js';
export type { RuntimeToolExposure } from './config/tool-exposure.js';
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
export {
  createEmptyRuntimeRulesConfig,
} from './config/request-header-rules.js';
export type {
  RuntimeRequestFeature,
  RuntimeRequestHeaderMatchCondition,
  RuntimeRequestHeaderRule,
  RuntimeRulesConfig,
} from './config/request-header-rules.js';

export interface LoadRuntimeConfigOptions extends DefaultGlobalConfigPathOptions {
  readonly workspaceId: string;
  /** Environment values considered only for the selected workspace allowlist. */
  readonly env?: NodeJS.ProcessEnv;
  readonly snapshotVersion?: number;
}

export interface LoadedRuntimeConfig {
  readonly snapshot: RuntimeConfigSnapshot;
  readonly identity: RuntimeConfigIdentity;
}

const MINIMAL_GLOBAL_CONFIG_EXAMPLE = `{
  "version": 2,
  "workspaces": [
    {
      "id": "your-workspace",
      "configFile": "C:/Users/username/.custom-mcp/workspaces/your-workspace.json"
    }
  ]
}`;

export function getPathSafetyContext(config: {
  pathSafetyContext: PathSafetyContext;
}): PathSafetyContext {
  return config.pathSafetyContext;
}

export function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions,
): RuntimeConfigSnapshot {
  return loadRuntimeConfigWithIdentity(options).snapshot;
}

export function loadRuntimeConfigWithIdentity(
  options: LoadRuntimeConfigOptions,
): LoadedRuntimeConfig {
  const location = getDefaultGlobalConfigPath(options);
  const defaultLogsDir = getDefaultGlobalLogsDir(options);
  const globalConfig = parseGlobalConfig(
    readJsonConfigFile(location.configFilePath, 'global'),
    { configFilePath: location.configFilePath },
  );
  const reference = selectWorkspaceReference({
    globalConfigFilePath: location.configFilePath,
    workspaces: globalConfig.workspaces,
    workspaceId: options.workspaceId,
  });
  const parsedWorkspace = parseWorkspaceConfig(
    readJsonConfigFile(reference.configFile, 'workspace'),
    { configFilePath: reference.configFile },
  );

  try {
    const compiledWorkspace = compileWorkspaceFileAccessPolicy(
      reference.configFile,
      reference.id,
      parsedWorkspace,
    );
    const identity = createRuntimeConfigIdentity({
      globalConfigFilePath: location.configFilePath,
      workspaceConfigFilePath: reference.configFile,
      workspaceId: reference.id,
      workspace: compiledWorkspace,
    });
    const workspaceWithOverrides = applyEnvOverridesToWorkspace({
      configFilePath: reference.configFile,
      workspace: compiledWorkspace,
      env: options.env,
    });
    const workspace = {
      ...workspaceWithOverrides,
      compiledFileAccessPolicy: compiledWorkspace.compiledFileAccessPolicy,
    };
    const snapshot = buildRuntimeConfigSnapshot({
      globalConfigFilePath: location.configFilePath,
      workspaceConfigFilePath: reference.configFile,
      workspaceId: reference.id,
      workspace,
      defaultLogsDir,
      snapshotVersion: options.snapshotVersion ?? 1,
    });

    return Object.freeze({ snapshot, identity });
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: reference.configFile,
      message,
      suggestion: `Fix the configuration in ${reference.configFile} and restart the server.`,
      cause: err,
    });
  }
}

function readJsonConfigFile(
  configFilePath: string,
  kind: 'global' | 'workspace',
): unknown {
  const label = kind === 'global' ? 'Global config file' : 'Workspace config file';

  let raw: Buffer;
  try {
    const stats = statSync(configFilePath);
    if (!stats.isFile()) {
      throw new ConfigError({
        code: 'config_file_read_failed',
        configFilePath,
        message: `${label} must be a regular file: ${configFilePath}`,
        suggestion: 'Point the configuration reference to a readable JSON file.',
      });
    }
    raw = readFileSync(configFilePath);
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      throw err;
    }

    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      throw new ConfigError({
        code: 'config_file_not_found',
        configFilePath,
        message: `${label} does not exist: ${configFilePath}`,
        suggestion: kind === 'global'
          ? `Create ${configFilePath}.\nMinimum global config:\n${MINIMAL_GLOBAL_CONFIG_EXAMPLE}`
          : `Create the referenced workspace config file at ${configFilePath}, or fix its configFile entry in the global config.`,
        cause: err,
      });
    }

    throw new ConfigError({
      code: 'config_file_read_failed',
      configFilePath,
      message: `Failed to read ${label.toLowerCase()} at ${configFilePath}: ${error.message}`,
      suggestion: 'Check that the file exists, is a regular file, and that the current user can read it.',
      cause: err,
    });
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch (err: unknown) {
    throw new ConfigError({
      code: 'config_file_read_failed',
      configFilePath,
      message: `${label} must contain valid UTF-8 text: ${configFilePath}`,
      suggestion: 'Save the JSON file as UTF-8 and restart the server.',
      cause: err,
    });
  }

  try {
    return JSON.parse(text);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError({
      code: 'config_json_invalid',
      configFilePath,
      message: `${label} contains invalid JSON: ${message}`,
      suggestion: `Fix the JSON syntax in ${configFilePath} and restart the server.`,
      cause: err,
    });
  }
}
