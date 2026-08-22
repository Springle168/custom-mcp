import { ConfigError } from '../config/errors.js';
import {
  readJsonFile,
  type JsonObject,
  type JsonValue,
} from '../config/json-file.js';
import { readLocalAbsolutePath } from '../config/path-policy.js';
import type { ValuePolicyResult } from '../config/value-policy.js';
import {
  compileInputSchemaValidator,
  InputSchemaCompilationError,
  type InputSchemaValidator,
} from './input-schema-validator.js';
import {
  loadExternalRoutingSpec,
  type ExternalRoutingSpec,
} from './external-routing/config.js';

export interface CustomToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface CustomToolDefinitionSourceMetadata {
  readonly toolConfigFilePath: string;
  readonly definitionIndex: number;
  readonly referenceId: string;
  readonly toolDefinitionFilePath: string;
}

export interface CompiledCustomToolDefinition {
  readonly definition: CustomToolDefinition;
  readonly validator: InputSchemaValidator;
  readonly source: CustomToolDefinitionSourceMetadata;
}

export interface LoadedCustomToolConfig {
  readonly toolConfigFilePath: string;
  readonly definitions: readonly CompiledCustomToolDefinition[];
  readonly externalRouting?: ExternalRoutingSpec;
}

interface DefinitionReference {
  readonly id: string;
  readonly toolDefinitionFile: string;
  readonly index: number;
}

interface ParsedToolConfig {
  readonly references: readonly DefinitionReference[];
  readonly processorConfigFilePath?: string;
}

const TOOL_CONFIG_FIELDS = new Set(['version', 'definitions', 'processorConfigFile']);
const DEFINITION_REFERENCE_FIELDS = new Set(['id', 'toolDefinitionFile']);
const TOOL_DEFINITION_FIELDS = new Set(['name', 'description', 'inputSchema']);
const TOOL_IDENTITY_RE = /^[A-Za-z0-9._-]{1,128}$/;
const DRAFT_2020_12_URI = 'https://json-schema.org/draft/2020-12/schema';

/** Loads, validates, and compiles all custom definitions before runtime use. */
export function loadCustomToolConfig(toolConfigFilePath: string): LoadedCustomToolConfig {
  const validatedConfigPath = unwrapPathPolicy(
    toolConfigFilePath,
    readLocalAbsolutePath(toolConfigFilePath, { fieldPath: 'toolConfigFile' }),
  );
  const rawConfig = readJsonFile(validatedConfigPath, { label: 'Tool config file' });
  const parsedConfig = parseToolConfig(rawConfig, validatedConfigPath);
  const definitions = parsedConfig.references.map((reference) =>
    loadDefinition(validatedConfigPath, reference)
  );

  assertUniqueDefinitionNames(validatedConfigPath, definitions);
  const externalRouting = parsedConfig.processorConfigFilePath === undefined
    ? undefined
    : loadExternalRoutingSpec(parsedConfig.processorConfigFilePath);

  return Object.freeze({
    toolConfigFilePath: validatedConfigPath,
    definitions: Object.freeze(definitions),
    ...(externalRouting === undefined ? {} : { externalRouting }),
  });
}

function parseToolConfig(
  value: JsonValue,
  toolConfigFilePath: string,
): ParsedToolConfig {
  const rawConfig = readObject(
    value,
    () => failConfig(
      toolConfigFilePath,
      undefined,
      'Tool config file must contain a JSON object.',
    ),
  );
  assertKnownFields(
    rawConfig,
    TOOL_CONFIG_FIELDS,
    (fieldPath) => failConfig(
      toolConfigFilePath,
      fieldPath,
      `Unknown tool config field ${fieldPath}. Remove it or update the config schema.`,
    ),
  );

  if (rawConfig.version !== 1) {
    failConfig(
      toolConfigFilePath,
      'version',
      'version must be the number 1. The current server only supports tool config schema version 1.',
    );
  }
  if (!Array.isArray(rawConfig.definitions)) {
    failConfig(toolConfigFilePath, 'definitions', 'definitions must be an array.');
  }

  const seenIds = new Set<string>();
  const references = rawConfig.definitions.map((value, index) => {
    const reference = parseDefinitionReference(value, index, toolConfigFilePath);
    if (seenIds.has(reference.id)) {
      failConfig(
        toolConfigFilePath,
        `definitions[${index}].id`,
        `Definition reference id "${reference.id}" must be unique within this tool config.`,
      );
    }
    seenIds.add(reference.id);
    return Object.freeze(reference);
  });

  const processorConfigFilePath = Object.prototype.hasOwnProperty.call(
    rawConfig,
    'processorConfigFile',
  )
    ? unwrapConfigPathPolicy(
      toolConfigFilePath,
      readLocalAbsolutePath(rawConfig.processorConfigFile, {
        fieldPath: 'processorConfigFile',
      }),
    )
    : undefined;

  return Object.freeze({
    references: Object.freeze(references),
    ...(processorConfigFilePath === undefined ? {} : { processorConfigFilePath }),
  });
}

function parseDefinitionReference(
  value: JsonValue,
  index: number,
  toolConfigFilePath: string,
): DefinitionReference {
  const fieldPath = `definitions[${index}]`;
  const rawReference = readObject(
    value,
    () => failConfig(
      toolConfigFilePath,
      fieldPath,
      `${fieldPath} must be a JSON object.`,
    ),
  );
  assertKnownFields(
    rawReference,
    DEFINITION_REFERENCE_FIELDS,
    (unknownField) => failConfig(
      toolConfigFilePath,
      `${fieldPath}.${unknownField}`,
      `Unknown definition reference field ${fieldPath}.${unknownField}. Remove it.`,
    ),
  );

  const idPath = `${fieldPath}.id`;
  const definitionFilePath = `${fieldPath}.toolDefinitionFile`;
  assertRequired(rawReference, 'id', () =>
    failConfig(toolConfigFilePath, idPath, `${idPath} is required.`));
  assertRequired(rawReference, 'toolDefinitionFile', () =>
    failConfig(toolConfigFilePath, definitionFilePath, `${definitionFilePath} is required.`));

  if (typeof rawReference.id !== 'string' || !TOOL_IDENTITY_RE.test(rawReference.id)) {
    failConfig(
      toolConfigFilePath,
      idPath,
      `${idPath} must match ^[A-Za-z0-9._-]{1,128}$.`,
    );
  }

  return {
    id: rawReference.id,
    toolDefinitionFile: unwrapConfigPathPolicy(
      toolConfigFilePath,
      readLocalAbsolutePath(rawReference.toolDefinitionFile, {
        fieldPath: definitionFilePath,
      }),
    ),
    index,
  };
}

function loadDefinition(
  toolConfigFilePath: string,
  reference: DefinitionReference,
): CompiledCustomToolDefinition {
  const rawDefinition = readJsonFile(reference.toolDefinitionFile, {
    label: 'Tool definition file',
    referenceId: reference.id,
  });
  const definition = parseToolDefinition(rawDefinition, reference);

  let validator: InputSchemaValidator;
  try {
    validator = compileInputSchemaValidator(definition.inputSchema);
  } catch (error: unknown) {
    if (!(error instanceof InputSchemaCompilationError)) {
      throw error;
    }
    failDefinition(
      reference,
      'inputSchema',
      `inputSchema could not be compiled: ${error.message}`,
      error,
    );
  }

  const source = Object.freeze({
    toolConfigFilePath,
    definitionIndex: reference.index,
    referenceId: reference.id,
    toolDefinitionFilePath: reference.toolDefinitionFile,
  });

  return Object.freeze({ definition, validator, source });
}

function parseToolDefinition(
  value: JsonValue,
  reference: DefinitionReference,
): CustomToolDefinition {
  const rawDefinition = readObject(
    value,
    () => failDefinition(reference, undefined, 'Tool definition file must contain a JSON object.'),
  );
  assertKnownFields(
    rawDefinition,
    TOOL_DEFINITION_FIELDS,
    (fieldPath) => failDefinition(
      reference,
      fieldPath,
      `Unknown Tool definition field ${fieldPath}. Remove it.`,
    ),
  );

  for (const key of TOOL_DEFINITION_FIELDS) {
    assertRequired(rawDefinition, key, () =>
      failDefinition(reference, key, `${key} is required.`));
  }

  if (typeof rawDefinition.name !== 'string' || !TOOL_IDENTITY_RE.test(rawDefinition.name)) {
    failDefinition(
      reference,
      'name',
      'name must match ^[A-Za-z0-9._-]{1,128}$.',
    );
  }
  if (
    typeof rawDefinition.description !== 'string' ||
    rawDefinition.description.trim().length === 0
  ) {
    failDefinition(
      reference,
      'description',
      'description must be a string containing at least one non-whitespace character.',
    );
  }

  const inputSchema = readObject(
    rawDefinition.inputSchema,
    () => failDefinition(
      reference,
      'inputSchema',
      'inputSchema must be a JSON object.',
    ),
  );
  assertInputSchemaProtocolShape(inputSchema, reference);

  return Object.freeze({
    name: rawDefinition.name,
    description: rawDefinition.description,
    inputSchema: deepFreeze(inputSchema),
  });
}

function assertInputSchemaProtocolShape(
  inputSchema: JsonObject,
  reference: DefinitionReference,
): void {
  if (inputSchema.type !== 'object') {
    failDefinition(
      reference,
      'inputSchema.type',
      'inputSchema.type must be exactly the string "object".',
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(inputSchema, '$schema') &&
    inputSchema.$schema !== DRAFT_2020_12_URI
  ) {
    failDefinition(
      reference,
      'inputSchema.$schema',
      `inputSchema.$schema must be exactly "${DRAFT_2020_12_URI}" when present.`,
    );
  }

  if (!Object.prototype.hasOwnProperty.call(inputSchema, 'properties')) {
    return;
  }
  const properties = readObject(
    inputSchema.properties,
    () => failDefinition(
      reference,
      'inputSchema.properties',
      'inputSchema.properties must be a JSON object when present.',
    ),
  );

  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    if (!isJsonObject(propertySchema)) {
      failDefinition(
        reference,
        `inputSchema.properties[${JSON.stringify(propertyName)}]`,
        `The direct schema for property "${propertyName}" must use JSON object form; boolean schemas are not accepted by the MCP Tool boundary.`,
      );
    }
  }
}

function assertUniqueDefinitionNames(
  toolConfigFilePath: string,
  definitions: readonly CompiledCustomToolDefinition[],
): void {
  const firstByName = new Map<string, CompiledCustomToolDefinition>();
  for (const compiledDefinition of definitions) {
    const name = compiledDefinition.definition.name;
    const first = firstByName.get(name);
    if (first !== undefined) {
      failConfig(
        toolConfigFilePath,
        `definitions[${compiledDefinition.source.definitionIndex}].toolDefinitionFile`,
        `Custom tool name "${name}" is duplicated by definition references ` +
          `"${first.source.referenceId}" and "${compiledDefinition.source.referenceId}". ` +
          'Custom definitions cannot override one another.',
      );
    }
    firstByName.set(name, compiledDefinition);
  }
}

function readObject(value: JsonValue | undefined, fail: () => never): JsonObject {
  if (!isJsonObject(value)) {
    return fail();
  }
  return value;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownFields(
  value: JsonObject,
  knownFields: ReadonlySet<string>,
  fail: (fieldPath: string) => never,
): void {
  for (const key of Object.keys(value)) {
    if (!knownFields.has(key)) {
      fail(key);
    }
  }
}

function assertRequired(
  value: JsonObject,
  key: string,
  fail: () => never,
): void {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    fail();
  }
}

function unwrapPathPolicy(
  configFilePath: string,
  result: ValuePolicyResult<string>,
): string {
  if (!result.ok) {
    failConfig(configFilePath, result.error.fieldPath, result.error.message);
  }
  return result.value;
}

function unwrapConfigPathPolicy(
  toolConfigFilePath: string,
  result: ValuePolicyResult<string>,
): string {
  if (!result.ok) {
    failConfig(toolConfigFilePath, result.error.fieldPath, result.error.message);
  }
  return result.value;
}

function failDefinition(
  reference: DefinitionReference,
  fieldPath: string | undefined,
  message: string,
  cause?: unknown,
): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: reference.toolDefinitionFile,
    ...(fieldPath === undefined ? {} : { fieldPath }),
    message: `Definition reference "${reference.id}": ${message}`,
    suggestion: `Fix ${fieldPath ?? 'the Tool definition'} in ${reference.toolDefinitionFile} and restart the server.`,
    ...(cause === undefined ? {} : { cause }),
  });
}

function failConfig(
  toolConfigFilePath: string,
  fieldPath: string | undefined,
  message: string,
): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: toolConfigFilePath,
    ...(fieldPath === undefined ? {} : { fieldPath }),
    message,
    suggestion: `Fix ${fieldPath ?? 'the tool config'} in ${toolConfigFilePath} and restart the server.`,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const propertyValue of Object.values(value as Record<string, unknown>)) {
    deepFreeze(propertyValue);
  }
  return Object.freeze(value);
}
