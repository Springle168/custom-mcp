import { ConfigError } from '../config/errors.js';
import { readJsonFile, type JsonObject, type JsonValue } from '../config/json-file.js';
import { readLocalAbsolutePath } from '../config/path-policy.js';
import type { ValuePolicyResult } from '../config/value-policy.js';
import {
  failToolDefinition,
  freezeDefinitionValueCopy,
  type CustomToolDefinitionDeclaration,
  type CustomToolDefinitionSourceMetadata,
  type LoadedCustomToolDefinition,
} from './custom-tool-definition.js';

export type {
  CustomToolDefinitionDeclaration,
  CustomToolDefinitionSourceMetadata,
  LoadedCustomToolDefinition,
} from './custom-tool-definition.js';

export interface LoadedCustomToolConfig {
  readonly toolConfigFilePath: string;
  readonly definitions: readonly LoadedCustomToolDefinition[];
  readonly externalRoutingConfigFilePath?: string;
}

interface DefinitionReference {
  readonly id: string;
  readonly toolDefinitionFile: string;
  readonly index: number;
}

interface ParsedToolConfig {
  readonly references: readonly DefinitionReference[];
  readonly externalRoutingConfigFilePath?: string;
}

const TOOL_CONFIG_FIELDS = new Set(['version', 'definitions', 'externalRoutingConfigFile']);
const DEFINITION_REFERENCE_FIELDS = new Set(['id', 'toolDefinitionFile']);
const TOOL_DEFINITION_FIELDS = new Set([
  'name',
  '$alias',
  'description',
  '$inheritTopDescription',
  'inputSchema',
  '$inheritInputSchema',
]);
const TOOL_IDENTITY_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Loads strict source declarations without resolving inheritance, schemas, or routes. */
export function loadCustomToolConfig(toolConfigFilePath: string): LoadedCustomToolConfig {
  const validatedConfigPath = unwrapPathPolicy(
    toolConfigFilePath,
    readLocalAbsolutePath(toolConfigFilePath, { fieldPath: 'toolConfigFile' }),
  );
  const rawConfig = readJsonFile(validatedConfigPath, { label: 'Tool config file' });
  const parsedConfig = parseToolConfig(rawConfig, validatedConfigPath);
  const definitions = parsedConfig.references.map((reference) =>
    loadDefinition(validatedConfigPath, reference),
  );

  assertUniqueDefinitionNames(validatedConfigPath, definitions);

  return Object.freeze({
    toolConfigFilePath: validatedConfigPath,
    definitions: Object.freeze(definitions),
    ...(parsedConfig.externalRoutingConfigFilePath === undefined
      ? {}
      : { externalRoutingConfigFilePath: parsedConfig.externalRoutingConfigFilePath }),
  });
}

function parseToolConfig(value: JsonValue, toolConfigFilePath: string): ParsedToolConfig {
  const rawConfig = readObject(value, () =>
    failConfig(toolConfigFilePath, undefined, 'Tool config file must contain a JSON object.'),
  );
  assertKnownFields(rawConfig, TOOL_CONFIG_FIELDS, (fieldPath) =>
    failConfig(
      toolConfigFilePath,
      fieldPath,
      `Unknown tool config field ${fieldPath}. Remove it or update the config schema.`,
    ),
  );

  if (rawConfig.version !== 2) {
    failConfig(
      toolConfigFilePath,
      'version',
      'version must be the number 2. The server only supports Tool config schema version 2.',
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

  const externalRoutingConfigFilePath = Object.prototype.hasOwnProperty.call(
    rawConfig,
    'externalRoutingConfigFile',
  )
    ? unwrapConfigPathPolicy(
        toolConfigFilePath,
        readLocalAbsolutePath(rawConfig.externalRoutingConfigFile, {
          fieldPath: 'externalRoutingConfigFile',
        }),
      )
    : undefined;

  return Object.freeze({
    references: Object.freeze(references),
    ...(externalRoutingConfigFilePath === undefined ? {} : { externalRoutingConfigFilePath }),
  });
}

function parseDefinitionReference(
  value: JsonValue,
  index: number,
  toolConfigFilePath: string,
): DefinitionReference {
  const fieldPath = `definitions[${index}]`;
  const rawReference = readObject(value, () =>
    failConfig(toolConfigFilePath, fieldPath, `${fieldPath} must be a JSON object.`),
  );
  assertKnownFields(rawReference, DEFINITION_REFERENCE_FIELDS, (unknownField) =>
    failConfig(
      toolConfigFilePath,
      `${fieldPath}.${unknownField}`,
      `Unknown definition reference field ${fieldPath}.${unknownField}. Remove it.`,
    ),
  );

  const idPath = `${fieldPath}.id`;
  const definitionFilePath = `${fieldPath}.toolDefinitionFile`;
  assertRequired(rawReference, 'id', () =>
    failConfig(toolConfigFilePath, idPath, `${idPath} is required.`),
  );
  assertRequired(rawReference, 'toolDefinitionFile', () =>
    failConfig(toolConfigFilePath, definitionFilePath, `${definitionFilePath} is required.`),
  );

  if (typeof rawReference.id !== 'string' || !TOOL_IDENTITY_RE.test(rawReference.id)) {
    failConfig(toolConfigFilePath, idPath, `${idPath} must match ^[A-Za-z0-9._-]{1,128}$.`);
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
): LoadedCustomToolDefinition {
  const source = Object.freeze({
    toolConfigFilePath,
    definitionIndex: reference.index,
    referenceId: reference.id,
    toolDefinitionFilePath: reference.toolDefinitionFile,
  });
  const rawDefinition = readJsonFile(reference.toolDefinitionFile, {
    label: 'Tool definition file',
    referenceId: reference.id,
  });
  const declaration = parseToolDefinition(rawDefinition, source);
  return Object.freeze({ declaration, source });
}

function parseToolDefinition(
  value: JsonValue,
  source: CustomToolDefinitionSourceMetadata,
): CustomToolDefinitionDeclaration {
  const rawDefinition = readObject(value, () =>
    failToolDefinition(source, undefined, 'Tool definition file must contain a JSON object.'),
  );
  assertKnownFields(rawDefinition, TOOL_DEFINITION_FIELDS, (fieldPath) =>
    failToolDefinition(source, fieldPath, `Unknown Tool definition field ${fieldPath}. Remove it.`),
  );
  assertRequired(rawDefinition, 'name', () =>
    failToolDefinition(source, 'name', 'name is required.'),
  );

  for (const key of ['name', '$alias'] as const) {
    if (
      Object.hasOwn(rawDefinition, key) &&
      (typeof rawDefinition[key] !== 'string' || !TOOL_IDENTITY_RE.test(rawDefinition[key]))
    ) {
      failToolDefinition(source, key, `${key} must match ^[A-Za-z0-9._-]{1,128}$.`);
    }
  }
  if (
    Object.hasOwn(rawDefinition, 'description') &&
    (typeof rawDefinition.description !== 'string' || rawDefinition.description.trim().length === 0)
  ) {
    failToolDefinition(
      source,
      'description',
      'description must be a string containing at least one non-whitespace character.',
    );
  }
  for (const key of ['$inheritTopDescription', '$inheritInputSchema'] as const) {
    if (Object.hasOwn(rawDefinition, key) && typeof rawDefinition[key] !== 'boolean') {
      failToolDefinition(source, key, `${key} must be a boolean.`);
    }
  }
  if (Object.hasOwn(rawDefinition, 'inputSchema') && !isJsonObject(rawDefinition.inputSchema)) {
    failToolDefinition(source, 'inputSchema', 'inputSchema must be a JSON object.');
  }

  // The strict shell above establishes the declaration type; combinations and
  // schema semantics belong exclusively to the pure compiler.
  return freezeDefinitionValueCopy(rawDefinition) as unknown as CustomToolDefinitionDeclaration;
}

function assertUniqueDefinitionNames(
  toolConfigFilePath: string,
  definitions: readonly LoadedCustomToolDefinition[],
): void {
  const firstByName = new Map<string, LoadedCustomToolDefinition>();
  for (const loadedDefinition of definitions) {
    const name = loadedDefinition.declaration.name;
    const first = firstByName.get(name);
    if (first !== undefined) {
      failConfig(
        toolConfigFilePath,
        `definitions[${loadedDefinition.source.definitionIndex}].toolDefinitionFile`,
        `Custom tool name "${name}" is duplicated by definition references ` +
          `"${first.source.referenceId}" and "${loadedDefinition.source.referenceId}". ` +
          'Custom definitions cannot override one another.',
      );
    }
    firstByName.set(name, loadedDefinition);
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

function assertRequired(value: JsonObject, key: string, fail: () => never): void {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    fail();
  }
}

function unwrapPathPolicy(configFilePath: string, result: ValuePolicyResult<string>): string {
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
