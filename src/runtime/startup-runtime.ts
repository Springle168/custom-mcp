import {
  loadRuntimeConfigWithIdentity,
  type LoadedRuntimeConfig,
  type LoadRuntimeConfigOptions,
} from '../config.js';
import {
  compileWorkspaceToolCatalog,
  type CompiledWorkspaceToolCatalog,
} from '../tools/catalog.js';
import {
  loadCustomToolConfig,
  type CompiledCustomToolDefinition,
} from '../tools/custom-tool-config.js';
import { getCompiledBuiltInTools } from '../tools/index.js';

export interface LoadedApplicationRuntime extends LoadedRuntimeConfig {
  readonly toolCatalog: CompiledWorkspaceToolCatalog;
}

/** Loads and compiles every startup artifact before the HTTP listener is created. */
export function loadApplicationRuntime(
  options: LoadRuntimeConfigOptions,
): LoadedApplicationRuntime {
  const loadedConfig = loadRuntimeConfigWithIdentity(options);
  const customDefinitions = loadConfiguredDefinitions(
    loadedConfig.workspaceTools.toolConfigFile,
  );
  const toolCatalog = compileWorkspaceToolCatalog({
    builtInTools: getCompiledBuiltInTools(),
    customDefinitions,
    exposure: loadedConfig.workspaceTools.exposure,
    workspaceConfigFilePath: loadedConfig.snapshot.workspaceConfigFilePath,
  });

  return Object.freeze({ ...loadedConfig, toolCatalog });
}

function loadConfiguredDefinitions(
  toolConfigFile: string | undefined,
): readonly CompiledCustomToolDefinition[] {
  if (toolConfigFile === undefined) {
    return Object.freeze([]);
  }
  return loadCustomToolConfig(toolConfigFile).definitions;
}
