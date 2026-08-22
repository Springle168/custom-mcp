import { statSync } from 'node:fs';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import * as path from 'node:path';
import { MIMEType } from 'node:util';
import { ConfigError } from '../../config/errors.js';
import {
  readJsonFile,
  type JsonObject,
  type JsonValue,
} from '../../config/json-file.js';
import {
  readExistingDirectoryPath,
  readLocalAbsolutePath,
} from '../../config/path-policy.js';
import {
  readJsonPositiveInteger,
  readTypedString,
  type ValuePolicyResult,
} from '../../config/value-policy.js';

export type ExternalProcessorExecutable =
  | { readonly resolution: 'absolute-path'; readonly path: string }
  | { readonly resolution: 'path-search'; readonly command: string };

export interface ExternalProcessorDefinition {
  readonly name: string;
  readonly executable: ExternalProcessorExecutable;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly timeoutMs: number;
}

export type ExternalRequestRoutingStrategy =
  | { readonly strategy: 'request-to-external'; readonly mode: 'direct' }
  | {
      readonly strategy: 'request-to-external';
      readonly mode: 'canonical-filter';
      readonly processor: string;
    }
  | {
      readonly strategy: 'request-to-external';
      readonly mode: 'body-encoder';
      readonly processor: string;
      readonly contentType: string;
    };

export type ExternalResponseRoutingStrategy =
  | { readonly strategy: 'response-from-external'; readonly mode: 'direct' }
  | {
      readonly strategy: 'response-from-external';
      readonly mode: 'canonical-filter';
      readonly processor: string;
    }
  | {
      readonly strategy: 'response-from-external';
      readonly mode: 'body-decoder';
      readonly processor: string;
    };

export interface ExternalHttpEndpointConfig {
  readonly url: string;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Fully validated, startup-stable routing input shared by custom-only Tools.
 * Paths retain their configured spelling; runtime code must use this snapshot
 * rather than rereading any of the referenced configuration files.
 */
export interface ExternalRoutingSpec {
  readonly processorConfigFilePath: string;
  readonly httpEndpointConfigFilePath: string;
  readonly endpoint: ExternalHttpEndpointConfig;
  readonly processors: readonly ExternalProcessorDefinition[];
  readonly requestStrategy: ExternalRequestRoutingStrategy;
  readonly responseStrategy: ExternalResponseRoutingStrategy;
}

interface ParsedStrategy {
  readonly index: number;
  readonly value: ExternalRequestRoutingStrategy | ExternalResponseRoutingStrategy;
}

interface ParsedProcessorConfig {
  readonly httpEndpointConfigFilePath: string;
  readonly processors: readonly ExternalProcessorDefinition[];
  readonly requestStrategy: ExternalRequestRoutingStrategy;
  readonly responseStrategy: ExternalResponseRoutingStrategy;
}

const PROCESSOR_CONFIG_FIELDS = new Set([
  'version',
  'httpEndpointConfigFile',
  'processors',
  'routingStrategy',
]);
const ENDPOINT_CONFIG_FIELDS = new Set(['version', 'url', 'timeoutMs', 'headers']);
const PROCESSOR_FIELDS = new Set([
  'name',
  'executable',
  'arguments',
  'workingDirectory',
  'timeoutMs',
]);
const ABSOLUTE_EXECUTABLE_FIELDS = new Set(['resolution', 'path']);
const PATH_SEARCH_EXECUTABLE_FIELDS = new Set(['resolution', 'command']);
const DIRECT_STRATEGY_FIELDS = new Set(['strategy', 'mode']);
const PROCESSOR_STRATEGY_FIELDS = new Set(['strategy', 'mode', 'processor']);
const BODY_ENCODER_STRATEGY_FIELDS = new Set([
  'strategy',
  'mode',
  'processor',
  'contentType',
]);
const PROCESSOR_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PATH_SEARCH_COMMAND_RE = /^[^/\\]+$/;
const MAX_TIMEOUT_MS = 2_147_483_647;
const FORBIDDEN_ENDPOINT_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'accept-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
]);

/** Loads and validates the Processor and endpoint config artifacts at startup. */
export function loadExternalRoutingSpec(
  processorConfigFilePath: string,
): ExternalRoutingSpec {
  const validatedProcessorConfigFilePath = unwrapValuePolicy(
    processorConfigFilePath,
    readLocalAbsolutePath(processorConfigFilePath, { fieldPath: 'processorConfigFile' }),
  );
  const rawProcessorConfig = readJsonFile(validatedProcessorConfigFilePath, {
    label: 'External routing Processor config file',
  });
  const processorConfig = parseProcessorConfig(
    rawProcessorConfig,
    validatedProcessorConfigFilePath,
  );
  const endpointConfigFilePath = processorConfig.httpEndpointConfigFilePath;
  const rawEndpointConfig = readJsonFile(endpointConfigFilePath, {
    label: 'External routing HTTP endpoint config file',
  });
  const endpoint = parseEndpointConfig(rawEndpointConfig, endpointConfigFilePath);

  return deepFreeze({
    processorConfigFilePath: validatedProcessorConfigFilePath,
    httpEndpointConfigFilePath: endpointConfigFilePath,
    endpoint,
    processors: processorConfig.processors,
    requestStrategy: processorConfig.requestStrategy,
    responseStrategy: processorConfig.responseStrategy,
  });
}

function parseProcessorConfig(
  value: JsonValue,
  processorConfigFilePath: string,
): ParsedProcessorConfig {
  const rawConfig = readObject(value, () => failConfig(
    processorConfigFilePath,
    undefined,
    'External routing Processor config file must contain a JSON object.',
  ));
  assertKnownFields(rawConfig, PROCESSOR_CONFIG_FIELDS, (fieldPath) => failConfig(
    processorConfigFilePath,
    fieldPath,
    `Unknown Processor config field ${fieldPath}. Remove it.`,
  ));
  assertRequiredFields(rawConfig, PROCESSOR_CONFIG_FIELDS, (fieldPath) => failConfig(
    processorConfigFilePath,
    fieldPath,
    `${fieldPath} is required.`,
  ));

  if (rawConfig.version !== 1) {
    failConfig(
      processorConfigFilePath,
      'version',
      'version must be the number 1. The current server only supports external routing schema version 1.',
    );
  }
  const httpEndpointConfigFilePath = unwrapValuePolicy(
    processorConfigFilePath,
    readLocalAbsolutePath(rawConfig.httpEndpointConfigFile, {
      fieldPath: 'httpEndpointConfigFile',
    }),
  );
  if (!Array.isArray(rawConfig.processors)) {
    failConfig(processorConfigFilePath, 'processors', 'processors must be an array.');
  }
  if (!Array.isArray(rawConfig.routingStrategy)) {
    failConfig(processorConfigFilePath, 'routingStrategy', 'routingStrategy must be an array.');
  }

  const processors = rawConfig.processors.map((processor, index) =>
    parseProcessorDefinition(processor, index, processorConfigFilePath)
  );
  assertUniqueProcessorNames(processors, processorConfigFilePath);
  const strategies = rawConfig.routingStrategy.map((strategy, index) => Object.freeze({
    index,
    value: parseRoutingStrategy(strategy, index, processorConfigFilePath),
  }));
  const routing = selectRoutingStrategies(strategies, processorConfigFilePath);
  assertProcessorReferences(processors, routing, processorConfigFilePath);

  return deepFreeze({
    httpEndpointConfigFilePath,
    processors,
    requestStrategy: routing.request.value,
    responseStrategy: routing.response.value,
  });
}

function parseProcessorDefinition(
  value: JsonValue,
  index: number,
  processorConfigFilePath: string,
): ExternalProcessorDefinition {
  const fieldPath = `processors[${index}]`;
  const rawProcessor = readObject(value, () => failConfig(
    processorConfigFilePath,
    fieldPath,
    `${fieldPath} must be a JSON object.`,
  ));
  assertKnownFields(rawProcessor, PROCESSOR_FIELDS, (field) => failConfig(
    processorConfigFilePath,
    `${fieldPath}.${field}`,
    `Unknown Processor definition field ${fieldPath}.${field}. Remove it.`,
  ));
  assertRequiredFields(rawProcessor, PROCESSOR_FIELDS, (field) => failConfig(
    processorConfigFilePath,
    `${fieldPath}.${field}`,
    `${fieldPath}.${field} is required.`,
  ));

  const name = readProcessorName(rawProcessor.name, `${fieldPath}.name`, processorConfigFilePath);
  const executable = parseExecutable(
    rawProcessor.executable,
    `${fieldPath}.executable`,
    processorConfigFilePath,
  );
  if (!Array.isArray(rawProcessor.arguments)) {
    failConfig(
      processorConfigFilePath,
      `${fieldPath}.arguments`,
      `${fieldPath}.arguments must be an array of strings.`,
    );
  }
  const argumentsList = rawProcessor.arguments.map((argument, argumentIndex) => {
    if (typeof argument !== 'string') {
      failConfig(
        processorConfigFilePath,
        `${fieldPath}.arguments[${argumentIndex}]`,
        `${fieldPath}.arguments[${argumentIndex}] must be a string.`,
      );
    }
    return argument;
  });
  const workingDirectory = unwrapValuePolicy(
    processorConfigFilePath,
    readExistingDirectoryPath(rawProcessor.workingDirectory, {
      fieldPath: `${fieldPath}.workingDirectory`,
    }),
  );
  const timeoutMs = unwrapValuePolicy(
    processorConfigFilePath,
    readJsonPositiveInteger(rawProcessor.timeoutMs, {
      fieldPath: `${fieldPath}.timeoutMs`,
      max: MAX_TIMEOUT_MS,
      rangeDescription: `in the range 1..${MAX_TIMEOUT_MS}`,
      label: `${fieldPath}.timeoutMs`,
    }),
  );

  return deepFreeze({
    name,
    executable,
    arguments: argumentsList,
    workingDirectory,
    timeoutMs,
  });
}

function parseExecutable(
  value: JsonValue | undefined,
  fieldPath: string,
  processorConfigFilePath: string,
): ExternalProcessorExecutable {
  const rawExecutable = readObject(value, () => failConfig(
    processorConfigFilePath,
    fieldPath,
    `${fieldPath} must be a JSON object.`,
  ));
  if (!Object.prototype.hasOwnProperty.call(rawExecutable, 'resolution')) {
    failConfig(
      processorConfigFilePath,
      `${fieldPath}.resolution`,
      `${fieldPath}.resolution is required.`,
    );
  }

  if (rawExecutable.resolution === 'absolute-path') {
    assertKnownFields(rawExecutable, ABSOLUTE_EXECUTABLE_FIELDS, (field) => failConfig(
      processorConfigFilePath,
      `${fieldPath}.${field}`,
      `Unknown absolute-path executable field ${fieldPath}.${field}. Remove it.`,
    ));
    assertRequiredFields(rawExecutable, ABSOLUTE_EXECUTABLE_FIELDS, (field) => failConfig(
      processorConfigFilePath,
      `${fieldPath}.${field}`,
      `${fieldPath}.${field} is required.`,
    ));
    return deepFreeze({
      resolution: 'absolute-path' as const,
      path: readExistingRegularFilePath(
        rawExecutable.path,
        `${fieldPath}.path`,
        processorConfigFilePath,
      ),
    });
  }

  if (rawExecutable.resolution === 'path-search') {
    assertKnownFields(rawExecutable, PATH_SEARCH_EXECUTABLE_FIELDS, (field) => failConfig(
      processorConfigFilePath,
      `${fieldPath}.${field}`,
      `Unknown path-search executable field ${fieldPath}.${field}. Remove it.`,
    ));
    assertRequiredFields(rawExecutable, PATH_SEARCH_EXECUTABLE_FIELDS, (field) => failConfig(
      processorConfigFilePath,
      `${fieldPath}.${field}`,
      `${fieldPath}.${field} is required.`,
    ));
    const command = unwrapValuePolicy(
      processorConfigFilePath,
      readTypedString(rawExecutable.command, { fieldPath: `${fieldPath}.command` }),
    );
    if (!PATH_SEARCH_COMMAND_RE.test(command)) {
      failConfig(
        processorConfigFilePath,
        `${fieldPath}.command`,
        `${fieldPath}.command must be a bare command name without path separators.`,
      );
    }
    return deepFreeze({ resolution: 'path-search' as const, command });
  }

  failConfig(
    processorConfigFilePath,
    `${fieldPath}.resolution`,
    `${fieldPath}.resolution must be exactly "absolute-path" or "path-search".`,
  );
}

function parseRoutingStrategy(
  value: JsonValue,
  index: number,
  processorConfigFilePath: string,
): ExternalRequestRoutingStrategy | ExternalResponseRoutingStrategy {
  const fieldPath = `routingStrategy[${index}]`;
  const rawStrategy = readObject(value, () => failConfig(
    processorConfigFilePath,
    fieldPath,
    `${fieldPath} must be a JSON object.`,
  ));
  assertRequiredFields(rawStrategy, DIRECT_STRATEGY_FIELDS, (field) => failConfig(
    processorConfigFilePath,
    `${fieldPath}.${field}`,
    `${fieldPath}.${field} is required.`,
  ));

  if (rawStrategy.strategy === 'request-to-external') {
    return parseRequestStrategy(rawStrategy, fieldPath, processorConfigFilePath);
  }
  if (rawStrategy.strategy === 'response-from-external') {
    return parseResponseStrategy(rawStrategy, fieldPath, processorConfigFilePath);
  }
  failConfig(
    processorConfigFilePath,
    `${fieldPath}.strategy`,
    `${fieldPath}.strategy must be exactly "request-to-external" or "response-from-external".`,
  );
}

function parseRequestStrategy(
  rawStrategy: JsonObject,
  fieldPath: string,
  processorConfigFilePath: string,
): ExternalRequestRoutingStrategy {
  if (rawStrategy.mode === 'direct') {
    assertExactStrategyFields(
      rawStrategy,
      DIRECT_STRATEGY_FIELDS,
      fieldPath,
      processorConfigFilePath,
    );
    return deepFreeze({ strategy: 'request-to-external' as const, mode: 'direct' as const });
  }
  if (rawStrategy.mode === 'canonical-filter') {
    assertExactStrategyFields(
      rawStrategy,
      PROCESSOR_STRATEGY_FIELDS,
      fieldPath,
      processorConfigFilePath,
    );
    return deepFreeze({
      strategy: 'request-to-external' as const,
      mode: 'canonical-filter' as const,
      processor: readProcessorName(
        rawStrategy.processor,
        `${fieldPath}.processor`,
        processorConfigFilePath,
      ),
    });
  }
  if (rawStrategy.mode === 'body-encoder') {
    assertExactStrategyFields(
      rawStrategy,
      BODY_ENCODER_STRATEGY_FIELDS,
      fieldPath,
      processorConfigFilePath,
    );
    return deepFreeze({
      strategy: 'request-to-external' as const,
      mode: 'body-encoder' as const,
      processor: readProcessorName(
        rawStrategy.processor,
        `${fieldPath}.processor`,
        processorConfigFilePath,
      ),
      contentType: readMediaType(
        rawStrategy.contentType,
        `${fieldPath}.contentType`,
        processorConfigFilePath,
      ),
    });
  }
  failConfig(
    processorConfigFilePath,
    `${fieldPath}.mode`,
    `${fieldPath}.mode must be exactly "direct", "canonical-filter", or "body-encoder" for request-to-external.`,
  );
}

function parseResponseStrategy(
  rawStrategy: JsonObject,
  fieldPath: string,
  processorConfigFilePath: string,
): ExternalResponseRoutingStrategy {
  if (rawStrategy.mode === 'direct') {
    assertExactStrategyFields(
      rawStrategy,
      DIRECT_STRATEGY_FIELDS,
      fieldPath,
      processorConfigFilePath,
    );
    return deepFreeze({ strategy: 'response-from-external' as const, mode: 'direct' as const });
  }
  if (rawStrategy.mode === 'canonical-filter' || rawStrategy.mode === 'body-decoder') {
    assertExactStrategyFields(
      rawStrategy,
      PROCESSOR_STRATEGY_FIELDS,
      fieldPath,
      processorConfigFilePath,
    );
    return deepFreeze({
      strategy: 'response-from-external' as const,
      mode: rawStrategy.mode,
      processor: readProcessorName(
        rawStrategy.processor,
        `${fieldPath}.processor`,
        processorConfigFilePath,
      ),
    });
  }
  failConfig(
    processorConfigFilePath,
    `${fieldPath}.mode`,
    `${fieldPath}.mode must be exactly "direct", "canonical-filter", or "body-decoder" for response-from-external.`,
  );
}

function assertExactStrategyFields(
  value: JsonObject,
  fields: ReadonlySet<string>,
  fieldPath: string,
  processorConfigFilePath: string,
): void {
  assertKnownFields(value, fields, (field) => failConfig(
    processorConfigFilePath,
    `${fieldPath}.${field}`,
    `Unknown routing strategy field ${fieldPath}.${field}. Remove it.`,
  ));
  assertRequiredFields(value, fields, (field) => failConfig(
    processorConfigFilePath,
    `${fieldPath}.${field}`,
    `${fieldPath}.${field} is required.`,
  ));
}

function selectRoutingStrategies(
  strategies: readonly ParsedStrategy[],
  processorConfigFilePath: string,
): {
  readonly request: Readonly<{
    readonly index: number;
    readonly value: ExternalRequestRoutingStrategy;
  }>;
  readonly response: Readonly<{
    readonly index: number;
    readonly value: ExternalResponseRoutingStrategy;
  }>;
} {
  let request: { readonly index: number; readonly value: ExternalRequestRoutingStrategy } | undefined;
  let response: { readonly index: number; readonly value: ExternalResponseRoutingStrategy } | undefined;
  for (const strategy of strategies) {
    if (strategy.value.strategy === 'request-to-external') {
      if (request !== undefined) {
        failConfig(
          processorConfigFilePath,
          `routingStrategy[${strategy.index}].strategy`,
          'routingStrategy must contain exactly one request-to-external strategy.',
        );
      }
      request = Object.freeze({ index: strategy.index, value: strategy.value });
      continue;
    }
    if (response !== undefined) {
      failConfig(
        processorConfigFilePath,
        `routingStrategy[${strategy.index}].strategy`,
        'routingStrategy must contain exactly one response-from-external strategy.',
      );
    }
    response = Object.freeze({ index: strategy.index, value: strategy.value });
  }
  if (request === undefined) {
    failConfig(
      processorConfigFilePath,
      'routingStrategy',
      'routingStrategy must contain exactly one request-to-external strategy.',
    );
  }
  if (response === undefined) {
    failConfig(
      processorConfigFilePath,
      'routingStrategy',
      'routingStrategy must contain exactly one response-from-external strategy.',
    );
  }
  return Object.freeze({ request, response });
}

function assertUniqueProcessorNames(
  processors: readonly ExternalProcessorDefinition[],
  processorConfigFilePath: string,
): void {
  const indexByName = new Map<string, number>();
  for (let index = 0; index < processors.length; index++) {
    const processor = processors[index];
    if (processor === undefined) continue;
    const firstIndex = indexByName.get(processor.name);
    if (firstIndex !== undefined) {
      failConfig(
        processorConfigFilePath,
        `processors[${index}].name`,
        `Processor name "${processor.name}" is duplicated by processors[${firstIndex}] and processors[${index}].`,
      );
    }
    indexByName.set(processor.name, index);
  }
}

function assertProcessorReferences(
  processors: readonly ExternalProcessorDefinition[],
  routing: ReturnType<typeof selectRoutingStrategies>,
  processorConfigFilePath: string,
): void {
  const indexByName = new Map(processors.map((processor, index) => [processor.name, index]));
  const referencedNames = new Set<string>();
  for (const strategy of [routing.request, routing.response]) {
    if (!('processor' in strategy.value)) continue;
    if (!indexByName.has(strategy.value.processor)) {
      failConfig(
        processorConfigFilePath,
        `routingStrategy[${strategy.index}].processor`,
        `routingStrategy[${strategy.index}].processor references undefined Processor "${strategy.value.processor}".`,
      );
    }
    referencedNames.add(strategy.value.processor);
  }
  for (let index = 0; index < processors.length; index++) {
    const processor = processors[index];
    if (processor !== undefined && !referencedNames.has(processor.name)) {
      failConfig(
        processorConfigFilePath,
        `processors[${index}].name`,
        `Processor "${processor.name}" is not referenced by routingStrategy.`,
      );
    }
  }
}

function parseEndpointConfig(
  value: JsonValue,
  endpointConfigFilePath: string,
): ExternalHttpEndpointConfig {
  const rawConfig = readObject(value, () => failConfig(
    endpointConfigFilePath,
    undefined,
    'External routing HTTP endpoint config file must contain a JSON object.',
  ));
  assertKnownFields(rawConfig, ENDPOINT_CONFIG_FIELDS, (fieldPath) => failConfig(
    endpointConfigFilePath,
    fieldPath,
    `Unknown HTTP endpoint config field ${fieldPath}. Remove it.`,
  ));
  assertRequiredFields(rawConfig, new Set(['version', 'url', 'timeoutMs']), (fieldPath) =>
    failConfig(endpointConfigFilePath, fieldPath, `${fieldPath} is required.`));
  if (rawConfig.version !== 1) {
    failConfig(
      endpointConfigFilePath,
      'version',
      'version must be the number 1. The current server only supports external HTTP endpoint schema version 1.',
    );
  }
  const url = readEndpointUrl(rawConfig.url, endpointConfigFilePath);
  const timeoutMs = unwrapValuePolicy(
    endpointConfigFilePath,
    readJsonPositiveInteger(rawConfig.timeoutMs, {
      fieldPath: 'timeoutMs',
      max: MAX_TIMEOUT_MS,
      rangeDescription: `in the range 1..${MAX_TIMEOUT_MS}`,
      label: 'timeoutMs',
    }),
  );
  return deepFreeze({
    url,
    timeoutMs,
    headers: parseEndpointHeaders(rawConfig.headers, endpointConfigFilePath),
  });
}

function parseEndpointHeaders(
  value: JsonValue | undefined,
  endpointConfigFilePath: string,
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const rawHeaders = readObject(value, () => failConfig(
    endpointConfigFilePath,
    'headers',
    'headers must be a JSON object when present.',
  ));
  const seenNames = new Set<string>();
  const headers: [string, string][] = [];
  for (const [name, headerValue] of Object.entries(rawHeaders)) {
    const fieldPath = `headers[${JSON.stringify(name)}]`;
    if (typeof headerValue !== 'string') {
      failConfig(endpointConfigFilePath, fieldPath, `${fieldPath} must be a string.`);
    }
    try {
      validateHeaderName(name);
      validateHeaderValue(name, headerValue);
    } catch {
      failConfig(
        endpointConfigFilePath,
        fieldPath,
        `${fieldPath} must use a valid Node.js HTTP header name and value.`,
      );
    }
    const normalizedName = name.toLowerCase();
    if (seenNames.has(normalizedName)) {
      failConfig(
        endpointConfigFilePath,
        fieldPath,
        `headers must not contain duplicate field names ignoring case: "${name}".`,
      );
    }
    if (FORBIDDEN_ENDPOINT_HEADERS.has(normalizedName)) {
      failConfig(
        endpointConfigFilePath,
        fieldPath,
        `headers must not configure transport-owned or hop-by-hop field "${name}".`,
      );
    }
    seenNames.add(normalizedName);
    headers.push([name, headerValue]);
  }
  return Object.freeze(Object.fromEntries(headers));
}

function readEndpointUrl(value: JsonValue | undefined, endpointConfigFilePath: string): string {
  const url = unwrapValuePolicy(
    endpointConfigFilePath,
    readTypedString(value, { fieldPath: 'url' }),
  );
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    failConfig(
      endpointConfigFilePath,
      'url',
      'url must be an absolute http: or https: URL with a hostname.',
    );
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.hostname.length === 0
  ) {
    failConfig(
      endpointConfigFilePath,
      'url',
      'url must be an absolute http: or https: URL with a hostname, no credentials, and no fragment.',
    );
  }
  if (!/^https?:\/\//i.test(url)) {
    failConfig(
      endpointConfigFilePath,
      'url',
      'url must use an absolute http:// or https:// URL form.',
    );
  }
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url)?.[1] ?? '';
  if (
    authority.includes('@') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    url.includes('#')
  ) {
    failConfig(
      endpointConfigFilePath,
      'url',
      'url must be an absolute http: or https: URL with a hostname, no credentials, and no fragment.',
    );
  }
  return url;
}

function readMediaType(
  value: JsonValue | undefined,
  fieldPath: string,
  processorConfigFilePath: string,
): string {
  const contentType = unwrapValuePolicy(
    processorConfigFilePath,
    readTypedString(value, { fieldPath }),
  );
  try {
    validateHeaderValue('Content-Type', contentType);
    new MIMEType(contentType);
  } catch {
    failConfig(
      processorConfigFilePath,
      fieldPath,
      `${fieldPath} must be a syntactically valid media type that is safe to write as an HTTP Content-Type header.`,
    );
  }
  return contentType;
}

function readProcessorName(
  value: JsonValue | undefined,
  fieldPath: string,
  processorConfigFilePath: string,
): string {
  if (typeof value !== 'string' || !PROCESSOR_NAME_RE.test(value)) {
    failConfig(
      processorConfigFilePath,
      fieldPath,
      `${fieldPath} must match ^[A-Za-z0-9._-]{1,128}$.`,
    );
  }
  return value;
}

function readExistingRegularFilePath(
  value: JsonValue | undefined,
  fieldPath: string,
  processorConfigFilePath: string,
): string {
  const executablePath = unwrapValuePolicy(
    processorConfigFilePath,
    readLocalAbsolutePath(value, { fieldPath }),
  );
  const resolvedPath = path.resolve(executablePath);
  try {
    if (!statSync(resolvedPath).isFile()) {
      failConfig(
        processorConfigFilePath,
        fieldPath,
        `${fieldPath} must point to an existing regular file: ${resolvedPath}.`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof ConfigError) throw error;
    failConfig(
      processorConfigFilePath,
      fieldPath,
      `${fieldPath} does not exist or cannot be accessed as a regular file: ${resolvedPath}.`,
    );
  }
  return executablePath;
}

function readObject(value: JsonValue | undefined, fail: () => never): JsonObject {
  return isJsonObject(value) ? value : fail();
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
    if (!knownFields.has(key)) fail(key);
  }
}

function assertRequiredFields(
  value: JsonObject,
  fields: ReadonlySet<string>,
  fail: (fieldPath: string) => never,
): void {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) fail(field);
  }
}

function unwrapValuePolicy<T>(
  configFilePath: string,
  result: ValuePolicyResult<T>,
): T {
  if (!result.ok) {
    failConfig(configFilePath, result.error.fieldPath, result.error.message);
  }
  return result.value;
}

function failConfig(
  configFilePath: string,
  fieldPath: string | undefined,
  message: string,
): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath,
    ...(fieldPath === undefined ? {} : { fieldPath }),
    message,
    suggestion: `Fix ${fieldPath ?? 'the external routing configuration'} in ${configFilePath} and restart the server.`,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const propertyValue of Object.values(value as Record<string, unknown>)) {
    deepFreeze(propertyValue);
  }
  return Object.freeze(value);
}
