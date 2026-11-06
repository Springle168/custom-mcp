import { ConfigError } from '../config/errors.js';
import type { ParsedToolExposure } from '../config/tool-exposure.js';
import type { ToolRuntimeContext } from '../runtime/invocation/tool-context.js';
import type { ToolInvocationContext } from '../runtime/invocation/tool-invocation-context.js';
import type { CustomToolDefinitionSourceMetadata } from './custom-tool-definition.js';
import type { CompiledCustomToolDefinition } from './definition-compiler.js';
import type { InputSchemaValidationIssue, InputSchemaValidator } from './input-schema-validator.js';
import { textErrorResult } from './results.js';
import type { ToolCallResult, ToolDefinition, ToolExecutor } from './types.js';

export type ToolDefinitionSourceMetadata =
  | { readonly kind: 'built-in' }
  | (CustomToolDefinitionSourceMetadata & { readonly kind: 'custom' });

export interface CompiledBuiltInTool {
  readonly definition: ToolDefinition;
  readonly implementationValidator: InputSchemaValidator;
  readonly executor: ToolExecutor;
}

export interface ExternalToolInvocation {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

/**
 * Catalog-facing subset of the application-owned external routing executor.
 * External routes deliberately do not receive workspace runtime capability.
 */
export interface ExternalToolExecutor {
  execute(invocation: ExternalToolInvocation): Promise<ToolCallResult>;
}

interface WorkspaceToolCatalogEntryBase {
  readonly stableName: string;
  readonly definition: ToolDefinition;
  readonly effectiveValidator: InputSchemaValidator;
  readonly source: ToolDefinitionSourceMetadata;
}

export interface BuiltInWorkspaceToolCatalogEntry extends WorkspaceToolCatalogEntryBase {
  readonly binding: 'built-in';
  readonly implementationValidator: InputSchemaValidator;
  readonly executor: ToolExecutor;
}

export interface ExternalWorkspaceToolCatalogEntry extends WorkspaceToolCatalogEntryBase {
  readonly binding: 'external';
  readonly externalExecutor: ExternalToolExecutor;
}

export interface UnavailableWorkspaceToolCatalogEntry extends WorkspaceToolCatalogEntryBase {
  readonly binding: 'unavailable';
}

export type WorkspaceToolCatalogEntry =
  | BuiltInWorkspaceToolCatalogEntry
  | ExternalWorkspaceToolCatalogEntry
  | UnavailableWorkspaceToolCatalogEntry;

export interface CompiledWorkspaceToolCatalog {
  readonly effectiveEntries: readonly WorkspaceToolCatalogEntry[];
  readonly exposedEntries: readonly WorkspaceToolCatalogEntry[];
  readonly definitions: readonly ToolDefinition[];
  routeToolCall(
    name: string,
    args: unknown,
    context: ToolRuntimeContext,
    invocationContext: ToolInvocationContext,
  ): Promise<ToolCallResult>;
}

export interface PrepareWorkspaceToolCatalogOptions {
  readonly builtInTools: readonly CompiledBuiltInTool[];
  readonly customDefinitions: readonly CompiledCustomToolDefinition[];
  readonly exposure: ParsedToolExposure;
  readonly workspaceConfigFilePath: string;
  /** Validated route identities; endpoint/server configuration stays outside the catalog. */
  readonly externalRouteDefinitionIds?: ReadonlySet<string>;
}

export interface CompileWorkspaceToolCatalogOptions extends PrepareWorkspaceToolCatalogOptions {
  readonly externalBindingsByDefinitionId?: ReadonlyMap<string, ExternalToolExecutor>;
}

export interface PreparedExternalToolCatalogEntry extends WorkspaceToolCatalogEntryBase {
  readonly binding: 'external';
  readonly referenceId: string;
}

export type PreparedWorkspaceToolCatalogEntry =
  | BuiltInWorkspaceToolCatalogEntry
  | UnavailableWorkspaceToolCatalogEntry
  | PreparedExternalToolCatalogEntry;

export interface PreparedWorkspaceToolCatalog {
  readonly effectiveEntries: readonly PreparedWorkspaceToolCatalogEntry[];
  readonly exposedEntries: readonly PreparedWorkspaceToolCatalogEntry[];
  readonly definitions: readonly ToolDefinition[];
}

/** Convenience assembly for callers that already own all route-bound executors. */
export function compileWorkspaceToolCatalog(
  options: CompileWorkspaceToolCatalogOptions,
): CompiledWorkspaceToolCatalog {
  return bindWorkspaceToolCatalog(
    prepareWorkspaceToolCatalog({
      ...options,
      externalRouteDefinitionIds:
        options.externalRouteDefinitionIds ??
        new Set(options.externalBindingsByDefinitionId?.keys()),
    }),
    options.externalBindingsByDefinitionId,
  );
}

/** Validates identity, exposure and call names before external resources exist. */
export function prepareWorkspaceToolCatalog(
  options: PrepareWorkspaceToolCatalogOptions,
): PreparedWorkspaceToolCatalog {
  const customByName = new Map(
    options.customDefinitions
      .filter((custom) => custom.kind === 'built-in-override')
      .map((custom) => [custom.stableName, custom] as const),
  );
  const effectiveEntries: PreparedWorkspaceToolCatalogEntry[] = options.builtInTools.map(
    (builtIn) => {
      const custom = customByName.get(builtIn.definition.name);
      if (custom === undefined) {
        return freezeEntry({
          binding: 'built-in',
          stableName: builtIn.definition.name,
          definition: builtIn.definition,
          effectiveValidator: builtIn.implementationValidator,
          implementationValidator: builtIn.implementationValidator,
          executor: builtIn.executor,
          source: Object.freeze({ kind: 'built-in' as const }),
        });
      }

      return freezeEntry({
        binding: 'built-in',
        stableName: custom.stableName,
        definition: custom.definition,
        effectiveValidator: custom.validator,
        implementationValidator: builtIn.implementationValidator,
        executor: builtIn.executor,
        source: Object.freeze({
          kind: 'custom' as const,
          ...custom.source,
        }),
      });
    },
  );

  for (const custom of options.customDefinitions) {
    if (custom.kind === 'built-in-override') {
      continue;
    }

    const source = Object.freeze({
      kind: 'custom' as const,
      ...custom.source,
    });
    if (!options.externalRouteDefinitionIds?.has(custom.source.referenceId)) {
      effectiveEntries.push(
        freezeEntry({
          binding: 'unavailable',
          stableName: custom.stableName,
          definition: custom.definition,
          effectiveValidator: custom.validator,
          source,
        }),
      );
      continue;
    }

    effectiveEntries.push(
      freezeEntry({
        binding: 'external',
        stableName: custom.stableName,
        definition: custom.definition,
        effectiveValidator: custom.validator,
        referenceId: custom.source.referenceId,
        source,
      }),
    );
  }

  const effectiveNames = new Set(effectiveEntries.map((entry) => entry.stableName));
  validateExposureMembers(options.exposure, effectiveNames, options.workspaceConfigFilePath);
  const configuredNames = new Set(options.exposure.mode === 'all' ? [] : options.exposure.names);
  const exposedEntries = effectiveEntries.filter((entry) => {
    if (options.exposure.mode === 'all') {
      return true;
    }
    const selected = configuredNames.has(entry.stableName);
    return options.exposure.mode === 'enable' ? selected : !selected;
  });
  validateExposedCallNames(exposedEntries);

  return Object.freeze({
    effectiveEntries: Object.freeze(effectiveEntries),
    exposedEntries: Object.freeze(exposedEntries),
    definitions: Object.freeze(exposedEntries.map((entry) => entry.definition)),
  });
}

/** Only fills validated execution intents; it never reclassifies or recompiles entries. */
export function bindWorkspaceToolCatalog(
  prepared: PreparedWorkspaceToolCatalog,
  externalBindingsByDefinitionId: ReadonlyMap<string, ExternalToolExecutor> = new Map(),
): CompiledWorkspaceToolCatalog {
  const boundByEntry = new Map<PreparedWorkspaceToolCatalogEntry, WorkspaceToolCatalogEntry>();
  const effectiveEntries = Object.freeze(
    prepared.effectiveEntries.map((entry) => {
      let bound: WorkspaceToolCatalogEntry;
      if (entry.binding !== 'external') {
        bound = entry;
      } else {
        const externalExecutor = externalBindingsByDefinitionId.get(entry.referenceId);
        if (externalExecutor === undefined) {
          throw new Error(
            `Missing external executor for definition reference "${entry.referenceId}".`,
          );
        }
        bound = freezeEntry({
          binding: 'external',
          stableName: entry.stableName,
          definition: entry.definition,
          effectiveValidator: entry.effectiveValidator,
          source: entry.source,
          externalExecutor,
        });
      }
      boundByEntry.set(entry, bound);
      return bound;
    }),
  );
  const exposedEntries = Object.freeze(
    prepared.exposedEntries.map((entry) => {
      const bound = boundByEntry.get(entry);
      if (bound === undefined) {
        throw new Error('Prepared exposed entry is not part of the effective catalog.');
      }
      return bound;
    }),
  );
  const routeMap = new Map(exposedEntries.map((entry) => [entry.definition.name, entry] as const));

  return Object.freeze({
    effectiveEntries,
    exposedEntries,
    definitions: prepared.definitions,
    routeToolCall: async (
      name: string,
      args: unknown,
      context: ToolRuntimeContext,
      invocationContext: ToolInvocationContext,
    ): Promise<ToolCallResult> => {
      const entry = routeMap.get(name);
      if (entry === undefined) {
        return textErrorResult(`Unknown tool: ${name}`);
      }

      const effectiveResult = entry.effectiveValidator.validate(args);
      if (!effectiveResult.valid) {
        return textErrorResult(
          `Tool "${name}" arguments do not satisfy its configured input schema: ` +
            formatValidationIssues(effectiveResult.errors),
        );
      }

      if (
        entry.binding === 'built-in' &&
        entry.implementationValidator !== entry.effectiveValidator
      ) {
        const implementationResult = entry.implementationValidator.validate(args);
        if (!implementationResult.valid) {
          return textErrorResult(
            `Tool "${name}" arguments satisfy its configured schema, but are not supported by its current executor: ` +
              formatValidationIssues(implementationResult.errors),
          );
        }
      }

      if (entry.binding === 'built-in') {
        if (invocationContext.signal.aborted) {
          return textErrorResult('The tool call was cancelled before execution started.');
        }

        return entry.executor(args as Record<string, unknown>, context, invocationContext);
      }

      if (entry.binding === 'external') {
        return entry.externalExecutor.execute({
          callId: invocationContext.callId,
          name: entry.stableName,
          arguments: args as Readonly<Record<string, unknown>>,
          signal: invocationContext.signal,
        });
      }

      return textErrorResult(
        `Tool "${name}" is exposed, but no execution route is configured for it.`,
      );
    },
  });
}

function validateExposedCallNames(entries: readonly PreparedWorkspaceToolCatalogEntry[]): void {
  const firstByName = new Map<string, PreparedWorkspaceToolCatalogEntry>();
  for (const entry of entries) {
    const name = entry.definition.name;
    const first = firstByName.get(name);
    if (first === undefined) {
      firstByName.set(name, entry);
      continue;
    }

    // Built-in identities are unique; at least one side of a call-name collision
    // therefore has a custom reference that can own the configuration diagnostic.
    const source = entry.source.kind === 'custom' ? entry.source : first.source;
    if (source.kind !== 'custom') {
      throw new Error(`Duplicate built-in call name "${name}".`);
    }
    const fieldPath = `definitions[${source.definitionIndex}].toolDefinitionFile`;
    const describe = (candidate: PreparedWorkspaceToolCatalogEntry): string =>
      `"${candidate.stableName}" (${
        candidate.source.kind === 'custom'
          ? `reference "${candidate.source.referenceId}"`
          : 'unmodified built-in'
      })`;
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: source.toolConfigFilePath,
      fieldPath,
      message: `Duplicate exposed tool call name "${name}" for stable names ${describe(first)} and ${describe(entry)}.`,
      suggestion: `Fix ${fieldPath} in ${source.toolConfigFilePath}, or adjust workspace exposure using stable names, then restart the server.`,
    });
  }
}

function validateExposureMembers(
  exposure: ParsedToolExposure,
  effectiveNames: ReadonlySet<string>,
  workspaceConfigFilePath: string,
): void {
  if (exposure.mode === 'all') {
    return;
  }

  const selector = exposure.mode === 'enable' ? 'enabled' : 'disabled';
  for (let index = 0; index < exposure.names.length; index++) {
    const name = exposure.names[index];
    if (name !== undefined && effectiveNames.has(name)) {
      continue;
    }

    const fieldPath = `tools.${selector}[${index}]`;
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: workspaceConfigFilePath,
      fieldPath,
      message: `Unknown effective tool name "${name ?? ''}" at ${fieldPath}.`,
      suggestion:
        `Fix ${fieldPath} in ${workspaceConfigFilePath}. ` +
        'Selectors use stable names, not aliases. Use a built-in stable name or a stable name provided by the selected workspace tool config, then restart the server.',
    });
  }
}

function freezeEntry<T extends PreparedWorkspaceToolCatalogEntry | WorkspaceToolCatalogEntry>(
  entry: T,
): T {
  return Object.freeze(entry);
}

function formatValidationIssues(errors: readonly InputSchemaValidationIssue[]): string {
  const displayed = errors.slice(0, 5).map((error) => {
    const location = error.instancePath === '' ? '<root>' : error.instancePath;
    const detail = formatValidationIssueDetail(error);
    return `${location} ${error.message}${detail} [${error.keyword}]`;
  });
  const omitted = errors.length - displayed.length;
  if (omitted > 0) {
    displayed.push(`${omitted} additional validation issue(s) omitted`);
  }
  return displayed.join('; ');
}

function formatValidationIssueDetail(error: InputSchemaValidationIssue): string {
  if (error.keyword !== 'additionalProperties') {
    return '';
  }

  const propertyName = error.params.additionalProperty;
  return typeof propertyName === 'string'
    ? ` (unexpected property ${JSON.stringify(propertyName)})`
    : '';
}
