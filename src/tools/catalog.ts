import { ConfigError } from '../config/errors.js';
import type { ParsedToolExposure } from '../config/tool-exposure.js';
import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { ToolInvocationContext } from '../runtime/tool-invocation-context.js';
import type { CompiledCustomToolDefinition } from './custom-tool-config.js';
import type { InputSchemaValidationIssue, InputSchemaValidator } from './input-schema-validator.js';
import { textErrorResult } from './results.js';
import type { ToolCallResult, ToolDefinition, ToolExecutor } from './types.js';

export type ToolDefinitionSourceMetadata =
  | { readonly kind: 'built-in' }
  | {
      readonly kind: 'custom';
      readonly referenceId: string;
      readonly definitionFilePath: string;
    };

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

export interface CompileWorkspaceToolCatalogOptions {
  readonly builtInTools: readonly CompiledBuiltInTool[];
  readonly customDefinitions: readonly CompiledCustomToolDefinition[];
  readonly exposure: ParsedToolExposure;
  readonly workspaceConfigFilePath: string;
  /**
   * Shared application-owned executor used only for custom-only definitions.
   * When absent, those definitions compile for validation/exposure but retain
   * the deterministic unavailable route.
   */
  readonly externalExecutor?: ExternalToolExecutor;
}

export function compileWorkspaceToolCatalog(
  options: CompileWorkspaceToolCatalogOptions,
): CompiledWorkspaceToolCatalog {
  const customByName = new Map(
    options.customDefinitions.map((custom) => [custom.definition.name, custom] as const),
  );
  const builtInNames = new Set(options.builtInTools.map((tool) => tool.definition.name));
  const effectiveEntries: WorkspaceToolCatalogEntry[] = options.builtInTools.map((builtIn) => {
    const custom = customByName.get(builtIn.definition.name);
    if (custom === undefined) {
      return freezeEntry({
        binding: 'built-in',
        definition: builtIn.definition,
        effectiveValidator: builtIn.implementationValidator,
        implementationValidator: builtIn.implementationValidator,
        executor: builtIn.executor,
        source: Object.freeze({ kind: 'built-in' as const }),
      });
    }

    return freezeEntry({
      binding: 'built-in',
      definition: custom.definition,
      effectiveValidator: custom.validator,
      implementationValidator: builtIn.implementationValidator,
      executor: builtIn.executor,
      source: Object.freeze({
        kind: 'custom' as const,
        referenceId: custom.source.referenceId,
        definitionFilePath: custom.source.toolDefinitionFilePath,
      }),
    });
  });

  for (const custom of options.customDefinitions) {
    if (builtInNames.has(custom.definition.name)) {
      continue;
    }

    const source = Object.freeze({
      kind: 'custom' as const,
      referenceId: custom.source.referenceId,
      definitionFilePath: custom.source.toolDefinitionFilePath,
    });
    if (options.externalExecutor === undefined) {
      effectiveEntries.push(freezeEntry({
        binding: 'unavailable',
        definition: custom.definition,
        effectiveValidator: custom.validator,
        source,
      }));
      continue;
    }

    effectiveEntries.push(freezeEntry({
      binding: 'external',
      definition: custom.definition,
      effectiveValidator: custom.validator,
      externalExecutor: options.externalExecutor,
      source,
    }));
  }

  const effectiveNames = new Set(effectiveEntries.map((entry) => entry.definition.name));
  validateExposureMembers(options.exposure, effectiveNames, options.workspaceConfigFilePath);
  const configuredNames = new Set(
    options.exposure.mode === 'all' ? [] : options.exposure.names,
  );
  const exposedEntries = effectiveEntries.filter((entry) => {
    if (options.exposure.mode === 'all') {
      return true;
    }
    const selected = configuredNames.has(entry.definition.name);
    return options.exposure.mode === 'enable' ? selected : !selected;
  });
  const frozenEffectiveEntries = Object.freeze([...effectiveEntries]);
  const frozenExposedEntries = Object.freeze([...exposedEntries]);
  const definitions = Object.freeze(exposedEntries.map((entry) => entry.definition));
  const routeMap = new Map(exposedEntries.map((entry) => [entry.definition.name, entry] as const));

  return Object.freeze({
    effectiveEntries: frozenEffectiveEntries,
    exposedEntries: frozenExposedEntries,
    definitions,
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
        entry.binding === 'built-in'
        && entry.implementationValidator !== entry.effectiveValidator
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
        return entry.executor(args as Record<string, unknown>, context);
      }

      if (entry.binding === 'external') {
        return entry.externalExecutor.execute({
          callId: invocationContext.callId,
          name,
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
        'Use a built-in tool name or a name provided by the selected workspace tool config, then restart the server.',
    });
  }
}

function freezeEntry<T extends WorkspaceToolCatalogEntry>(entry: T): T {
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
