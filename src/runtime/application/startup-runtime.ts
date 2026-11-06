import {
  loadRuntimeConfigWithIdentity,
  type LoadedRuntimeConfig,
  type LoadRuntimeConfigOptions,
} from '../../config.js';
import {
  bindWorkspaceToolCatalog,
  prepareWorkspaceToolCatalog,
  type CompiledWorkspaceToolCatalog,
} from '../../tools/catalog.js';
import { loadCustomToolConfig } from '../../tools/custom-tool-config.js';
import { compileCustomToolDefinitions } from '../../tools/definition-compiler.js';
import {
  loadExternalRoutingConfig,
  type CompiledExternalRoutingConfig,
} from '../../tools/external-routing/config.js';
import {
  createExternalRoutingExecutor,
  type CreatedExternalRoutingExecutor,
} from '../../tools/external-routing/executor.js';
import type { ExternalRoutingProcessorDrainDiagnostic } from '../../tools/external-routing/strategy-adapter.js';
import type { McpConnectionDiagnostic } from '../../tools/external-routing/mcp-connection-manager.js';
import { getCompiledBuiltInTools } from '../../tools/index.js';

const CLOSED_APPLICATION_RUNTIME = Promise.resolve();

export interface LoadApplicationRuntimeOptions extends LoadRuntimeConfigOptions {
  readonly onExternalProcessorDrain?: (
    diagnostic: ExternalRoutingProcessorDrainDiagnostic,
  ) => void | Promise<void>;
  readonly onMcpConnectionDiagnostic?: (
    diagnostic: McpConnectionDiagnostic,
  ) => void | Promise<void>;
}

export interface LoadedApplicationRuntime extends LoadedRuntimeConfig {
  readonly toolCatalog: CompiledWorkspaceToolCatalog;
  readonly externalRouting?: CreatedExternalRoutingExecutor;
  readonly externalRoutingConfig?: CompiledExternalRoutingConfig;
  warmUp(): Promise<void>;
  close(): Promise<void>;
}

export interface StartupRuntimeDependencies {
  readonly createExternalRouting: typeof createExternalRoutingExecutor;
}

/** Validates every startup artifact before constructing application-owned resources. */
export async function loadApplicationRuntime(
  options: LoadApplicationRuntimeOptions,
  dependencies: StartupRuntimeDependencies = {
    createExternalRouting: createExternalRoutingExecutor,
  },
): Promise<LoadedApplicationRuntime> {
  const loadedConfig = loadRuntimeConfigWithIdentity(options);
  const builtInTools = getCompiledBuiltInTools();
  const toolConfigFile = loadedConfig.workspaceTools.toolConfigFile;
  const loadedTools =
    toolConfigFile === undefined ? undefined : loadCustomToolConfig(toolConfigFile);
  const customDefinitions = compileCustomToolDefinitions(
    loadedTools?.definitions ?? [],
    builtInTools,
  );
  const externalRoutingConfig =
    loadedTools?.externalRoutingConfigFilePath === undefined
      ? undefined
      : loadExternalRoutingConfig(
          loadedTools.externalRoutingConfigFilePath,
          customDefinitions.map((custom) =>
            Object.freeze({
              definitionId: custom.source.referenceId,
              toolName: custom.stableName,
              builtIn: custom.kind === 'built-in-override',
            }),
          ),
        );

  // Preparation retains route identities, not endpoint/server configuration or
  // executors. Hidden definitions and routes are validated before resources exist.
  const preparedCatalog = prepareWorkspaceToolCatalog({
    builtInTools,
    customDefinitions,
    exposure: loadedConfig.workspaceTools.exposure,
    workspaceConfigFilePath: loadedConfig.snapshot.workspaceConfigFilePath,
    externalRouteDefinitionIds: new Set(externalRoutingConfig?.routesByDefinitionId.keys()),
  });
  if (
    externalRoutingConfig === undefined ||
    externalRoutingConfig.routesByDefinitionId.size === 0
  ) {
    return Object.freeze({
      ...loadedConfig,
      toolCatalog: bindWorkspaceToolCatalog(preparedCatalog),
      ...(externalRoutingConfig === undefined ? {} : { externalRoutingConfig }),
      warmUp: () => CLOSED_APPLICATION_RUNTIME,
      close: () => CLOSED_APPLICATION_RUNTIME,
    });
  }

  const externalRouting = dependencies.createExternalRouting(externalRoutingConfig, {
    ...(options.onExternalProcessorDrain === undefined
      ? {}
      : { onProcessorDrain: options.onExternalProcessorDrain }),
    ...(options.onMcpConnectionDiagnostic === undefined
      ? {}
      : { onMcpConnectionDiagnostic: options.onMcpConnectionDiagnostic }),
  });
  let toolCatalog: CompiledWorkspaceToolCatalog;
  try {
    toolCatalog = bindWorkspaceToolCatalog(preparedCatalog, externalRouting.bindingsByDefinitionId);
  } catch (error: unknown) {
    // A binding omission is a startup failure, never an unavailable route. Wait
    // for the resource owner to drain before allowing startup rejection to escape.
    try {
      await externalRouting.executor.close();
    } catch (closeError: unknown) {
      throw new AggregateError(
        [error, closeError],
        'Catalog binding and external runtime cleanup failed.',
        { cause: closeError },
      );
    }
    throw error;
  }

  return Object.freeze({
    ...loadedConfig,
    toolCatalog,
    externalRouting,
    externalRoutingConfig,
    warmUp: () => externalRouting.executor.warmUp(),
    close: () => externalRouting.executor.close(),
  });
}
