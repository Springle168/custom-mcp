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
  type LoadedCustomToolConfig,
} from '../tools/custom-tool-config.js';
import type { CompiledExternalRoutingConfig } from '../tools/external-routing/config.js';
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
  readonly externalRoutingConfig?: CompiledExternalRoutingConfig;
  close(): Promise<void>;
}

/** Loads and compiles every startup artifact before the HTTP listener is created. */
export function loadApplicationRuntime(
  options: LoadApplicationRuntimeOptions,
): LoadedApplicationRuntime {
  const loadedConfig = loadRuntimeConfigWithIdentity(options);
  const builtInTools = getCompiledBuiltInTools();
  const builtInToolNames = new Set(
    builtInTools.map((tool) => tool.definition.name),
  );
  const loadedTools = loadConfiguredTools(
    loadedConfig.workspaceTools.toolConfigFile,
    builtInToolNames,
  );
  const catalogOptions = {
    builtInTools,
    customDefinitions: loadedTools?.definitions ?? [],
    exposure: loadedConfig.workspaceTools.exposure,
    workspaceConfigFilePath: loadedConfig.snapshot.workspaceConfigFilePath,
  } as const;

  // Complete all config, cross-file binding, and exposure validation before
  // constructing application-owned runner and Agent resources.
  const validatedCatalog = compileWorkspaceToolCatalog(catalogOptions);
  const externalRoutingConfig = loadedTools?.externalRouting;
  if (
    externalRoutingConfig === undefined ||
    externalRoutingConfig.routesByDefinitionId.size === 0
  ) {
    return Object.freeze({
      ...loadedConfig,
      toolCatalog: validatedCatalog,
      ...(externalRoutingConfig === undefined ? {} : { externalRoutingConfig }),
      close: () => CLOSED_APPLICATION_RUNTIME,
    });
  }

  const externalRouting = createExternalRoutingExecutor(externalRoutingConfig, {
    ...(options.onExternalProcessorDrain === undefined
      ? {}
      : { onProcessorDrain: options.onExternalProcessorDrain }),
  });
  const toolCatalog = compileWorkspaceToolCatalog({
    ...catalogOptions,
    externalBindingsByDefinitionId: externalRouting.bindingsByDefinitionId,
  });

  return Object.freeze({
    ...loadedConfig,
    toolCatalog,
    externalRouting,
    externalRoutingConfig,
    close: () => externalRouting.executor.close(),
  });
}

function loadConfiguredTools(
  toolConfigFile: string | undefined,
  builtInToolNames: ReadonlySet<string>,
): LoadedCustomToolConfig | undefined {
  if (toolConfigFile === undefined) {
    return undefined;
  }
  return loadCustomToolConfig(toolConfigFile, builtInToolNames);
}
