import { ConfigError } from '../config/errors.js';
import type { JsonObject } from '../config/json-file.js';

/** File syntax before built-in inheritance and the public name are resolved. */
export interface CustomToolDefinitionDeclaration {
  readonly name: string;
  readonly $alias?: string;
  readonly description?: string;
  readonly $inheritTopDescription?: boolean;
  readonly inputSchema?: JsonObject;
  readonly $inheritInputSchema?: boolean;
}

export interface CustomToolDefinitionSourceMetadata {
  readonly toolConfigFilePath: string;
  readonly definitionIndex: number;
  readonly referenceId: string;
  readonly toolDefinitionFilePath: string;
}

export interface LoadedCustomToolDefinition {
  readonly declaration: CustomToolDefinitionDeclaration;
  readonly source: CustomToolDefinitionSourceMetadata;
}

export function failToolDefinition(
  source: CustomToolDefinitionSourceMetadata,
  fieldPath: string | undefined,
  message: string,
  cause?: unknown,
): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: source.toolDefinitionFilePath,
    ...(fieldPath === undefined ? {} : { fieldPath }),
    message: `Definition reference "${source.referenceId}": ${message}`,
    suggestion: `Fix ${fieldPath ?? 'the Tool definition'} in ${source.toolDefinitionFilePath} and restart the server.`,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Snapshot JSON-owned data without freezing or retaining the caller's objects. */
export function freezeDefinitionValueCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
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
