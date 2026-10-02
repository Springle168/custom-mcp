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
import { readJsonFile } from './config/json-file.js';
import { parseWorkspaceConfig } from './config/schema.js';
import type { ParsedWorkspaceToolsConfig } from './config/tool-exposure.js';
import {
  createRuntimeConfigIdentity,
  selectWorkspaceReference,
  type RuntimeConfigIdentity,
} from './config/workspace-selection.js';
import type { PathSafetyContext } from './utils/paths.js';

export { ConfigError, isConfigError } from './config/errors.js';
export type { ConfigErrorCode } from './config/errors.js';
export type {
  ParsedToolExposure,
  ParsedWorkspaceToolsConfig,
} from './config/tool-exposure.js';
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
  RuntimeInitializeRequestFeature,
  RuntimeInitializeRequestHeaderRule,
  RuntimeRequestFeature,
  RuntimeRequestHeaderRules,
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
  readonly workspaceTools: ParsedWorkspaceToolsConfig;
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
    readJsonFile(location.configFilePath, {
      label: 'Global config file',
      notFoundSuggestion: `Create ${location.configFilePath}.\nMinimum global config:\n${MINIMAL_GLOBAL_CONFIG_EXAMPLE}`,
    }),
    { configFilePath: location.configFilePath },
  );
  const reference = selectWorkspaceReference({
    globalConfigFilePath: location.configFilePath,
    workspaces: globalConfig.workspaces,
    workspaceId: options.workspaceId,
  });
  const parsedWorkspace = parseWorkspaceConfig(
    readJsonFile(reference.configFile, {
      label: 'Workspace config file',
      notFoundSuggestion: `Create the referenced workspace config file at ${reference.configFile}, or fix its configFile entry in the global config.`,
    }),
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

    return Object.freeze({
      snapshot,
      identity,
      workspaceTools: parsedWorkspace.tools,
    });
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
