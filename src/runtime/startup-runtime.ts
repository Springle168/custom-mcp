import {
  loadRuntimeConfigWithIdentity,
  type LoadedRuntimeConfig,
  type LoadRuntimeConfigOptions,
} from '../config.js';
import { ConfigError } from '../config/errors.js';
import {
  compileWorkspaceToolCatalog,
  type CompiledWorkspaceToolCatalog,
} from '../tools/catalog.js';
import {
  loadCustomToolConfig,
  type CompiledCustomToolDefinition,
  type LoadedCustomToolConfig,
} from '../tools/custom-tool-config.js';
import {
  createExternalRoutingExecutor,
  type CreatedExternalRoutingExecutor,
} from '../tools/external-routing/executor.js';
import type { ExternalRoutingProcessorDrainDiagnostic } from '../tools/external-routing/strategy-adapter.js';
import { getCompiledBuiltInTools } from '../tools/index.js';

const CLOSED_APPLICATION_RUNTIME = Promise.resolve();

export interface LoadApplicationRuntimeOptions extends LoadRuntimeConfigOptions {
  readonly onExternalProcessorDrain?: (
    diagnostic: ExternalRoutingProcessorDrainDiagnostic,
  ) => void | Promise<void>;
}

export interface LoadedApplicationRuntime extends LoadedRuntimeConfig {
  readonly toolCatalog: CompiledWorkspaceToolCatalog;
  readonly externalRouting?: CreatedExternalRoutingExecutor;
  close(): Promise<void>;
}

/** Loads and compiles every startup artifact before the HTTP listener is created. */
export function loadApplicationRuntime(
  options: LoadApplicationRuntimeOptions,
): LoadedApplicationRuntime {
  const loadedConfig = loadRuntimeConfigWithIdentity(options);
  const loadedTools = loadConfiguredTools(
    loadedConfig.workspaceTools.toolConfigFile,
  );
  const builtInTools = getCompiledBuiltInTools();
  const catalogOptions = {
    builtInTools,
    customDefinitions: loadedTools?.definitions ?? [],
    exposure: loadedConfig.workspaceTools.exposure,
    workspaceConfigFilePath: loadedConfig.snapshot.workspaceConfigFilePath,
  } as const;

  // Complete pure catalog validation before constructing application-owned
  // runner and Agent resources that would otherwise need asynchronous cleanup.
  const validatedCatalog = compileWorkspaceToolCatalog(catalogOptions);
  if (loadedTools?.externalRouting === undefined) {
    return Object.freeze({
      ...loadedConfig,
      toolCatalog: validatedCatalog,
      close: () => CLOSED_APPLICATION_RUNTIME,
    });
  }

  assertExternalRouteHasCustomOnlyDefinition(loadedTools, builtInTools);
  const externalRouting = createExternalRoutingExecutor(loadedTools.externalRouting, {
    ...(options.onExternalProcessorDrain === undefined
      ? {}
      : { onProcessorDrain: options.onExternalProcessorDrain }),
  });
  const toolCatalog = compileWorkspaceToolCatalog({
    builtInTools,
    customDefinitions: loadedTools.definitions,
    exposure: catalogOptions.exposure,
    workspaceConfigFilePath: catalogOptions.workspaceConfigFilePath,
    externalExecutor: externalRouting.executor,
  });

  return Object.freeze({
    ...loadedConfig,
    toolCatalog,
    externalRouting,
    close: () => externalRouting.executor.close(),
  });
}

function loadConfiguredTools(
  toolConfigFile: string | undefined,
): LoadedCustomToolConfig | undefined {
  if (toolConfigFile === undefined) {
    return undefined;
  }
  return loadCustomToolConfig(toolConfigFile);
}

function assertExternalRouteHasCustomOnlyDefinition(
  loadedTools: LoadedCustomToolConfig,
  builtInTools: readonly { readonly definition: { readonly name: string } }[],
): void {
  const builtInNames = new Set(builtInTools.map((tool) => tool.definition.name));
  if (loadedTools.definitions.some(
    (definition: CompiledCustomToolDefinition) =>
      !builtInNames.has(definition.definition.name),
  )) {
    return;
  }

  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: loadedTools.toolConfigFilePath,
    fieldPath: 'processorConfigFile',
    message:
      'processorConfigFile requires at least one custom-only Tool definition.',
    suggestion:
      `Add a definition whose name does not override a built-in Tool, or remove processorConfigFile from ${loadedTools.toolConfigFilePath}, then restart the server.`,
  });
}
