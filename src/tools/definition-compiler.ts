import type { JsonObject } from '../config/json-file.js';
import {
  failToolDefinition,
  freezeDefinitionValueCopy,
  type CustomToolDefinitionSourceMetadata,
  type LoadedCustomToolDefinition,
} from './custom-tool-definition.js';
import {
  compileInputSchemaValidator,
  InputSchemaCompilationError,
  type InputSchemaValidator,
} from './input-schema-validator.js';
import type { ToolDefinition } from './types.js';

/** Original built-in contracts only; no registry, executor, or runtime ownership. */
export interface BuiltInToolDefinitionContract {
  readonly definition: ToolDefinition;
  readonly implementationValidator: InputSchemaValidator;
}

export interface CompiledCustomToolDefinition {
  readonly stableName: string;
  readonly kind: 'built-in-override' | 'custom-only';
  readonly definition: ToolDefinition;
  readonly validator: InputSchemaValidator;
  readonly source: CustomToolDefinitionSourceMetadata;
}

const DRAFT_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Resolves loaded declarations against original built-in contracts without I/O.
 * Inherited schemas reuse their trusted implementation validator; explicit schemas
 * compile exactly once here, regardless of later exposure or session selection.
 */
export function compileCustomToolDefinitions(
  definitions: readonly LoadedCustomToolDefinition[],
  builtInContracts: readonly BuiltInToolDefinitionContract[],
): readonly CompiledCustomToolDefinition[] {
  const builtInByName = new Map(
    builtInContracts.map((contract) => [contract.definition.name, contract]),
  );
  return Object.freeze(definitions.map((loaded) => compileDefinition(loaded, builtInByName)));
}

function compileDefinition(
  { declaration, source }: LoadedCustomToolDefinition,
  builtInByName: ReadonlyMap<string, BuiltInToolDefinitionContract>,
): CompiledCustomToolDefinition {
  const builtIn = builtInByName.get(declaration.name);
  if (declaration.description !== undefined && declaration.$inheritTopDescription === true) {
    failToolDefinition(
      source,
      '$inheritTopDescription',
      'description and $inheritTopDescription: true are mutually exclusive.',
    );
  }
  if (declaration.inputSchema !== undefined && declaration.$inheritInputSchema === true) {
    failToolDefinition(
      source,
      '$inheritInputSchema',
      'inputSchema and $inheritInputSchema: true are mutually exclusive.',
    );
  }
  for (const key of ['$inheritTopDescription', '$inheritInputSchema'] as const) {
    if (declaration[key] === true && builtIn === undefined) {
      failToolDefinition(
        source,
        key,
        `${key}: true requires an original built-in definition with stable name "${declaration.name}"; custom-only tools cannot inherit.`,
      );
    }
  }

  const description =
    declaration.$inheritTopDescription === true
      ? builtIn?.definition.description
      : declaration.description;
  let inputSchema: Readonly<Record<string, unknown>>;
  let validator: InputSchemaValidator;
  if (declaration.$inheritInputSchema === true && builtIn !== undefined) {
    inputSchema = freezeDefinitionValueCopy(builtIn.definition.inputSchema);
    validator = builtIn.implementationValidator;
  } else {
    if (declaration.inputSchema === undefined) {
      failToolDefinition(
        source,
        'inputSchema',
        'inputSchema is required unless $inheritInputSchema is true.',
      );
    }
    assertInputSchemaProtocolShape(declaration.inputSchema, source);
    inputSchema = freezeDefinitionValueCopy(declaration.inputSchema);
    try {
      validator = compileInputSchemaValidator(inputSchema);
    } catch (error: unknown) {
      if (!(error instanceof InputSchemaCompilationError)) {
        throw error;
      }
      failToolDefinition(
        source,
        'inputSchema',
        `inputSchema could not be compiled: ${error.message}`,
        error,
      );
    }
  }

  const definition = Object.freeze({
    name: declaration.$alias ?? declaration.name,
    ...(description === undefined ? {} : { description }),
    inputSchema,
  });
  return Object.freeze({
    stableName: declaration.name,
    kind: builtIn === undefined ? 'custom-only' : 'built-in-override',
    definition,
    validator,
    source: freezeDefinitionValueCopy(source),
  });
}

function assertInputSchemaProtocolShape(
  inputSchema: JsonObject,
  source: CustomToolDefinitionSourceMetadata,
): void {
  if (inputSchema.type !== 'object') {
    failToolDefinition(
      source,
      'inputSchema.type',
      'inputSchema.type must be exactly the string "object".',
    );
  }
  if (Object.hasOwn(inputSchema, '$schema') && inputSchema.$schema !== DRAFT_2020_12_URI) {
    failToolDefinition(
      source,
      'inputSchema.$schema',
      `inputSchema.$schema must be exactly "${DRAFT_2020_12_URI}" when present.`,
    );
  }
  if (!Object.hasOwn(inputSchema, 'properties')) {
    return;
  }
  const properties = inputSchema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    failToolDefinition(
      source,
      'inputSchema.properties',
      'inputSchema.properties must be a JSON object when present.',
    );
  }
  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    if (
      typeof propertySchema !== 'object' ||
      propertySchema === null ||
      Array.isArray(propertySchema)
    ) {
      failToolDefinition(
        source,
        `inputSchema.properties[${JSON.stringify(propertyName)}]`,
        `The direct schema for property "${propertyName}" must use JSON object form; boolean schemas are not accepted by the MCP Tool boundary.`,
      );
    }
  }
}
