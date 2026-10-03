import { realpathSync, statSync } from 'node:fs';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import * as path from 'node:path';
import { MIMEType } from 'node:util';
import { ConfigError } from '../../config/errors.js';
import { readJsonFile, type JsonObject, type JsonValue } from '../../config/json-file.js';
import { readExistingDirectoryPath, readLocalAbsolutePath } from '../../config/path-policy.js';
import {
  readJsonPositiveInteger,
  readTypedString,
  type ValuePolicyResult,
} from '../../config/value-policy.js';
import { immutableMap } from '../../utils/immutable-map.js';

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

export type ExternalRequestRoutingStage =
  | { readonly mode: 'direct' }
  | { readonly mode: 'canonical-filter'; readonly processor: string }
  | {
      readonly mode: 'body-encoder';
      readonly processor: string;
      readonly contentType: string;
    };

export type ExternalResponseRoutingStage =
  | { readonly mode: 'direct' }
  | { readonly mode: 'canonical-filter'; readonly processor: string }
  | { readonly mode: 'body-decoder'; readonly processor: string };

export interface ExternalHttpEndpointConfig {
  readonly url: string;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ExternalMcpServerConfig {
  /** Native real path; the workspace-owned downstream connection identity. */
  readonly identity: string;
  readonly url: string;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ExternalToolDefinitionBinding {
  readonly definitionId: string;
  readonly toolName: string;
  readonly builtIn: boolean;
}

export interface CompiledHttpRoute {
  readonly routingMode: 'http';
  readonly definitionId: string;
  readonly toolName: string;
  readonly endpointConfigFilePath: string;
  readonly endpoint: ExternalHttpEndpointConfig;
  readonly requestStage: ExternalRequestRoutingStage;
  readonly responseStage: ExternalResponseRoutingStage;
}

export interface CompiledMcpRoute {
  readonly routingMode: 'mcp';
  readonly definitionId: string;
  readonly toolName: string;
  readonly serverConfigFilePath: string;
  readonly server: ExternalMcpServerConfig;
}

export type CompiledExternalRoute = CompiledHttpRoute | CompiledMcpRoute;

/** Fully validated, startup-stable routing configuration for one workspace. */
export interface CompiledExternalRoutingConfig {
  readonly configFilePath: string;
  readonly processorConfigFilePath?: string;
  readonly processorsByName: ReadonlyMap<string, ExternalProcessorDefinition>;
  /** Declaration order, including routes hidden by workspace exposure. */
  readonly routes: readonly CompiledExternalRoute[];
  readonly routesByDefinitionId: ReadonlyMap<string, CompiledExternalRoute>;
}

interface ParsedHttpRoute {
  readonly index: number;
  readonly routingMode: 'http';
  readonly definitionId: string;
  readonly endpointConfigFilePath: string;
  readonly requestStage: ExternalRequestRoutingStage;
  readonly responseStage: ExternalResponseRoutingStage;
}

interface ParsedMcpRoute {
  readonly index: number;
  readonly routingMode: 'mcp';
  readonly definitionId: string;
  readonly serverConfigFilePath: string;
}

type ParsedExternalRoute = ParsedHttpRoute | ParsedMcpRoute;

interface ParsedExternalRoutingConfig {
  readonly processorConfigFilePath?: string;
  readonly routes: readonly ParsedExternalRoute[];
}

const EXTERNAL_ROUTING_CONFIG_FIELDS = new Set(['version', 'processorConfigFile', 'routes']);
const HTTP_ROUTE_FIELDS = new Set([
  'definitionId',
  'routingMode',
  'httpEndpointConfigFile',
  'routingStrategy',
]);
const MCP_ROUTE_FIELDS = new Set(['definitionId', 'routingMode', 'mcpServerConfigFile']);
const ROUTING_STRATEGY_FIELDS = new Set(['request-to-external', 'response-from-external']);
const PROCESSOR_CONFIG_FIELDS = new Set(['version', 'processors']);
const ENDPOINT_CONFIG_FIELDS = new Set(['version', 'url', 'timeoutMs', 'headers']);
const MCP_SERVER_CONFIG_FIELDS = new Set(['version', 'url', 'timeoutMs', 'headers']);
const PROCESSOR_FIELDS = new Set([
  'name',
  'executable',
  'arguments',
  'workingDirectory',
  'timeoutMs',
]);
const ABSOLUTE_EXECUTABLE_FIELDS = new Set(['resolution', 'path']);
const PATH_SEARCH_EXECUTABLE_FIELDS = new Set(['resolution', 'command']);
const DIRECT_STAGE_FIELDS = new Set(['mode']);
const PROCESSOR_STAGE_FIELDS = new Set(['mode', 'processor']);
const BODY_ENCODER_STAGE_FIELDS = new Set(['mode', 'processor', 'contentType']);
const CONFIG_IDENTITY_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PATH_SEARCH_COMMAND_RE = /^[^/\\]+$/;
const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:/;
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
const FORBIDDEN_MCP_HEADERS = new Set([
  ...FORBIDDEN_ENDPOINT_HEADERS,
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

/**
 * Loads every referenced routing artifact and validates cross-file bindings.
 * No application-owned runner or HTTP resource is created by this function.
 */
export function loadExternalRoutingConfig(
  externalRoutingConfigFilePath: string,
  definitions: readonly ExternalToolDefinitionBinding[],
): CompiledExternalRoutingConfig {
  const validatedConfigFilePath = unwrapValuePolicy(
    externalRoutingConfigFilePath,
    readLocalAbsolutePath(externalRoutingConfigFilePath, {
      fieldPath: 'externalRoutingConfigFile',
    }),
  );
  const rawConfig = readJsonFile(validatedConfigFilePath, {
    label: 'External routing config file',
  });
  const parsedConfig = parseExternalRoutingConfig(rawConfig, validatedConfigFilePath);
  const processors =
    parsedConfig.processorConfigFilePath === undefined
      ? []
      : loadProcessorConfig(parsedConfig.processorConfigFilePath);
  const processorsByName = new Map(processors.map((processor) => [processor.name, processor]));
  const definitionsById = new Map(
    definitions.map((definition) => [definition.definitionId, definition]),
  );
  const endpointsByPath = new Map<string, ExternalHttpEndpointConfig>();
  const serversByRealPath = new Map<string, ExternalMcpServerConfig>();
  const serversByDeclaredPath = new Map<string, ExternalMcpServerConfig>();
  const routesByDefinitionId = new Map<string, CompiledExternalRoute>();
  const routes: CompiledExternalRoute[] = [];

  for (const route of parsedConfig.routes) {
    const definitionPath = `routes[${route.index}].definitionId`;
    const definition = definitionsById.get(route.definitionId);
    if (definition === undefined) {
      failConfig(
        validatedConfigFilePath,
        definitionPath,
        `${definitionPath} references undefined Tool definition id "${route.definitionId}".`,
      );
    }
    if (definition.builtIn) {
      failConfig(
        validatedConfigFilePath,
        definitionPath,
        `${definitionPath} must reference a custom-only Tool definition; built-in overrides retain their built-in executor.`,
      );
    }

    let compiledRoute: CompiledExternalRoute;
    if (route.routingMode === 'http') {
      assertStageProcessorReference(
        route.requestStage,
        `routes[${route.index}].routingStrategy.request-to-external[0]`,
        parsedConfig.processorConfigFilePath,
        processorsByName,
        validatedConfigFilePath,
      );
      assertStageProcessorReference(
        route.responseStage,
        `routes[${route.index}].routingStrategy.response-from-external[0]`,
        parsedConfig.processorConfigFilePath,
        processorsByName,
        validatedConfigFilePath,
      );

      let endpoint = endpointsByPath.get(route.endpointConfigFilePath);
      if (endpoint === undefined) {
        const rawEndpoint = readJsonFile(route.endpointConfigFilePath, {
          label: 'External routing HTTP endpoint config file',
        });
        endpoint = parseEndpointConfig(rawEndpoint, route.endpointConfigFilePath);
        endpointsByPath.set(route.endpointConfigFilePath, endpoint);
      }
      compiledRoute = deepFreeze({
        routingMode: 'http',
        definitionId: route.definitionId,
        toolName: definition.toolName,
        endpointConfigFilePath: route.endpointConfigFilePath,
        endpoint,
        requestStage: route.requestStage,
        responseStage: route.responseStage,
      });
    } else {
      let server = serversByDeclaredPath.get(route.serverConfigFilePath);
      if (server === undefined) {
        // Read at the declared path first so file/JSON failures retain their source identity.
        const rawServer = readJsonFile(route.serverConfigFilePath, {
          label: 'External routing MCP server config file',
        });
        let identity: string;
        try {
          identity = realpathSync.native(route.serverConfigFilePath);
        } catch (cause: unknown) {
          throw new ConfigError({
            code: 'config_file_read_failed',
            configFilePath: route.serverConfigFilePath,
            message: `Failed to resolve MCP server config file at ${route.serverConfigFilePath}.`,
            suggestion:
              'Check the referenced file and its symlink target, then restart the server.',
            cause,
          });
        }
        server = serversByRealPath.get(identity);
        if (server === undefined) {
          server = parseMcpServerConfig(rawServer, route.serverConfigFilePath, identity);
          serversByRealPath.set(identity, server);
        }
        serversByDeclaredPath.set(route.serverConfigFilePath, server);
      }
      compiledRoute = deepFreeze({
        routingMode: 'mcp',
        definitionId: route.definitionId,
        toolName: definition.toolName,
        serverConfigFilePath: route.serverConfigFilePath,
        server,
      });
    }
    routes.push(compiledRoute);
    routesByDefinitionId.set(route.definitionId, compiledRoute);
  }

  return Object.freeze({
    configFilePath: validatedConfigFilePath,
    ...(parsedConfig.processorConfigFilePath === undefined
      ? {}
      : { processorConfigFilePath: parsedConfig.processorConfigFilePath }),
    processorsByName: immutableMap(processorsByName),
    routes: Object.freeze(routes),
    routesByDefinitionId: immutableMap(routesByDefinitionId),
  });
}

function parseExternalRoutingConfig(
  value: JsonValue,
  configFilePath: string,
): ParsedExternalRoutingConfig {
  const rawConfig = readObject(value, () =>
    failConfig(
      configFilePath,
      undefined,
      'External routing config file must contain a JSON object.',
    ),
  );
  assertKnownFields(rawConfig, EXTERNAL_ROUTING_CONFIG_FIELDS, (fieldPath) =>
    failConfig(
      configFilePath,
      fieldPath,
      `Unknown external routing config field ${fieldPath}. Remove it.`,
    ),
  );
  assertRequiredFields(rawConfig, new Set(['version', 'routes']), (fieldPath) =>
    failConfig(configFilePath, fieldPath, `${fieldPath} is required.`),
  );
  if (rawConfig.version !== 2) {
    failConfig(
      configFilePath,
      'version',
      'version must be the number 2. The server only supports external routing config schema version 2.',
    );
  }
  if (!Array.isArray(rawConfig.routes)) {
    failConfig(configFilePath, 'routes', 'routes must be an array.');
  }

  const processorConfigFilePath = Object.prototype.hasOwnProperty.call(
    rawConfig,
    'processorConfigFile',
  )
    ? unwrapValuePolicy(
        configFilePath,
        readLocalAbsolutePath(rawConfig.processorConfigFile, {
          fieldPath: 'processorConfigFile',
        }),
      )
    : undefined;
  const seenDefinitionIds = new Set<string>();
  const routes = rawConfig.routes.map((route, index) => {
    const parsedRoute = parseExternalRoute(route, index, configFilePath);
    if (seenDefinitionIds.has(parsedRoute.definitionId)) {
      failConfig(
        configFilePath,
        `routes[${index}].definitionId`,
        `Tool definition id "${parsedRoute.definitionId}" is already bound by an earlier route.`,
      );
    }
    seenDefinitionIds.add(parsedRoute.definitionId);
    return parsedRoute;
  });

  return deepFreeze({
    ...(processorConfigFilePath === undefined ? {} : { processorConfigFilePath }),
    routes,
  });
}

function parseExternalRoute(
  value: JsonValue,
  index: number,
  configFilePath: string,
): ParsedExternalRoute {
  const fieldPath = `routes[${index}]`;
  const rawRoute = readObject(value, () =>
    failConfig(configFilePath, fieldPath, `${fieldPath} must be a JSON object.`),
  );
  if (rawRoute.routingMode !== 'http' && rawRoute.routingMode !== 'mcp') {
    failConfig(
      configFilePath,
      `${fieldPath}.routingMode`,
      `${fieldPath}.routingMode must be exactly "http" or "mcp".`,
    );
  }
  const fields = rawRoute.routingMode === 'http' ? HTTP_ROUTE_FIELDS : MCP_ROUTE_FIELDS;
  assertKnownFields(rawRoute, fields, (field) =>
    failConfig(
      configFilePath,
      `${fieldPath}.${field}`,
      `Unknown route field ${fieldPath}.${field}. Remove it.`,
    ),
  );
  assertRequiredFields(rawRoute, fields, (field) =>
    failConfig(configFilePath, `${fieldPath}.${field}`, `${fieldPath}.${field} is required.`),
  );
  const definitionId = readConfigIdentity(
    rawRoute.definitionId,
    `${fieldPath}.definitionId`,
    configFilePath,
  );
  if (rawRoute.routingMode === 'mcp') {
    const serverConfigFilePath = unwrapValuePolicy(
      configFilePath,
      readLocalAbsolutePath(rawRoute.mcpServerConfigFile, {
        fieldPath: `${fieldPath}.mcpServerConfigFile`,
      }),
    );
    return Object.freeze({ index, routingMode: 'mcp', definitionId, serverConfigFilePath });
  }
  const endpointConfigFilePath = unwrapValuePolicy(
    configFilePath,
    readLocalAbsolutePath(rawRoute.httpEndpointConfigFile, {
      fieldPath: `${fieldPath}.httpEndpointConfigFile`,
    }),
  );
  const routing = parseRouteRoutingStrategy(
    rawRoute.routingStrategy,
    `${fieldPath}.routingStrategy`,
    configFilePath,
  );
  return deepFreeze({
    index,
    routingMode: 'http' as const,
    definitionId,
    endpointConfigFilePath,
    requestStage: routing.request,
    responseStage: routing.response,
  });
}

function parseRouteRoutingStrategy(
  value: JsonValue | undefined,
  fieldPath: string,
  configFilePath: string,
): {
  readonly request: ExternalRequestRoutingStage;
  readonly response: ExternalResponseRoutingStage;
} {
  const rawRouting = readObject(value, () =>
    failConfig(configFilePath, fieldPath, `${fieldPath} must be a JSON object.`),
  );
  assertKnownFields(rawRouting, ROUTING_STRATEGY_FIELDS, (field) =>
    failConfig(
      configFilePath,
      `${fieldPath}.${field}`,
      `Unknown routing strategy field ${fieldPath}.${field}. Remove it.`,
    ),
  );
  assertRequiredFields(rawRouting, ROUTING_STRATEGY_FIELDS, (field) =>
    failConfig(configFilePath, `${fieldPath}.${field}`, `${fieldPath}.${field} is required.`),
  );

  const requestPath = `${fieldPath}.request-to-external`;
  const responsePath = `${fieldPath}.response-from-external`;
  const requestStages = readSingleStageArray(
    rawRouting['request-to-external'],
    requestPath,
    configFilePath,
  );
  const responseStages = readSingleStageArray(
    rawRouting['response-from-external'],
    responsePath,
    configFilePath,
  );
  return deepFreeze({
    request: parseRequestStage(requestStages[0], `${requestPath}[0]`, configFilePath),
    response: parseResponseStage(responseStages[0], `${responsePath}[0]`, configFilePath),
  });
}

function readSingleStageArray(
  value: JsonValue | undefined,
  fieldPath: string,
  configFilePath: string,
): readonly [JsonValue] {
  if (!Array.isArray(value)) {
    failConfig(configFilePath, fieldPath, `${fieldPath} must be an array.`);
  }
  if (value.length !== 1) {
    failConfig(
      configFilePath,
      fieldPath,
      `${fieldPath} must contain exactly one stage in external routing config schema version 2.`,
    );
  }
  return value as unknown as readonly [JsonValue];
}

function parseRequestStage(
  value: JsonValue,
  fieldPath: string,
  configFilePath: string,
): ExternalRequestRoutingStage {
  const rawStage = readObject(value, () =>
    failConfig(configFilePath, fieldPath, `${fieldPath} must be a JSON object.`),
  );
  if (rawStage.mode === 'direct') {
    assertExactStageFields(rawStage, DIRECT_STAGE_FIELDS, fieldPath, configFilePath);
    return Object.freeze({ mode: 'direct' as const });
  }
  if (rawStage.mode === 'canonical-filter') {
    assertExactStageFields(rawStage, PROCESSOR_STAGE_FIELDS, fieldPath, configFilePath);
    return Object.freeze({
      mode: 'canonical-filter' as const,
      processor: readConfigIdentity(rawStage.processor, `${fieldPath}.processor`, configFilePath),
    });
  }
  if (rawStage.mode === 'body-encoder') {
    assertExactStageFields(rawStage, BODY_ENCODER_STAGE_FIELDS, fieldPath, configFilePath);
    return Object.freeze({
      mode: 'body-encoder' as const,
      processor: readConfigIdentity(rawStage.processor, `${fieldPath}.processor`, configFilePath),
      contentType: readMediaType(rawStage.contentType, `${fieldPath}.contentType`, configFilePath),
    });
  }
  failConfig(
    configFilePath,
    `${fieldPath}.mode`,
    `${fieldPath}.mode must be exactly "direct", "canonical-filter", or "body-encoder".`,
  );
}

function parseResponseStage(
  value: JsonValue,
  fieldPath: string,
  configFilePath: string,
): ExternalResponseRoutingStage {
  const rawStage = readObject(value, () =>
    failConfig(configFilePath, fieldPath, `${fieldPath} must be a JSON object.`),
  );
  if (rawStage.mode === 'direct') {
    assertExactStageFields(rawStage, DIRECT_STAGE_FIELDS, fieldPath, configFilePath);
    return Object.freeze({ mode: 'direct' as const });
  }
  if (rawStage.mode === 'canonical-filter' || rawStage.mode === 'body-decoder') {
    assertExactStageFields(rawStage, PROCESSOR_STAGE_FIELDS, fieldPath, configFilePath);
    return Object.freeze({
      mode: rawStage.mode,
      processor: readConfigIdentity(rawStage.processor, `${fieldPath}.processor`, configFilePath),
    });
  }
  failConfig(
    configFilePath,
    `${fieldPath}.mode`,
    `${fieldPath}.mode must be exactly "direct", "canonical-filter", or "body-decoder".`,
  );
}

function assertExactStageFields(
  value: JsonObject,
  fields: ReadonlySet<string>,
  fieldPath: string,
  configFilePath: string,
): void {
  assertKnownFields(value, fields, (field) =>
    failConfig(
      configFilePath,
      `${fieldPath}.${field}`,
      `Unknown routing stage field ${fieldPath}.${field}. Remove it.`,
    ),
  );
  assertRequiredFields(value, fields, (field) =>
    failConfig(configFilePath, `${fieldPath}.${field}`, `${fieldPath}.${field} is required.`),
  );
}

function loadProcessorConfig(
  processorConfigFilePath: string,
): readonly ExternalProcessorDefinition[] {
  const rawConfig = readJsonFile(processorConfigFilePath, {
    label: 'External routing Processor config file',
  });
  const rawObject = readObject(rawConfig, () =>
    failConfig(
      processorConfigFilePath,
      undefined,
      'External routing Processor config file must contain a JSON object.',
    ),
  );
  assertKnownFields(rawObject, PROCESSOR_CONFIG_FIELDS, (fieldPath) =>
    failConfig(
      processorConfigFilePath,
      fieldPath,
      `Unknown Processor config field ${fieldPath}. Remove it.`,
    ),
  );
  assertRequiredFields(rawObject, PROCESSOR_CONFIG_FIELDS, (fieldPath) =>
    failConfig(processorConfigFilePath, fieldPath, `${fieldPath} is required.`),
  );
  if (rawObject.version !== 2) {
    failConfig(
      processorConfigFilePath,
      'version',
      'version must be the number 2. The server only supports Processor config schema version 2.',
    );
  }
  if (!Array.isArray(rawObject.processors)) {
    failConfig(processorConfigFilePath, 'processors', 'processors must be an array.');
  }
  const processors = rawObject.processors.map((processor, index) =>
    parseProcessorDefinition(processor, index, processorConfigFilePath),
  );
  assertUniqueProcessorNames(processors, processorConfigFilePath);
  return Object.freeze(processors);
}

function parseProcessorDefinition(
  value: JsonValue,
  index: number,
  processorConfigFilePath: string,
): ExternalProcessorDefinition {
  const fieldPath = `processors[${index}]`;
  const rawProcessor = readObject(value, () =>
    failConfig(processorConfigFilePath, fieldPath, `${fieldPath} must be a JSON object.`),
  );
  assertKnownFields(rawProcessor, PROCESSOR_FIELDS, (field) =>
    failConfig(
      processorConfigFilePath,
      `${fieldPath}.${field}`,
      `Unknown Processor definition field ${fieldPath}.${field}. Remove it.`,
    ),
  );
  assertRequiredFields(rawProcessor, PROCESSOR_FIELDS, (field) =>
    failConfig(
      processorConfigFilePath,
      `${fieldPath}.${field}`,
      `${fieldPath}.${field} is required.`,
    ),
  );

  const name = readConfigIdentity(rawProcessor.name, `${fieldPath}.name`, processorConfigFilePath);
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
  const rawExecutable = readObject(value, () =>
    failConfig(processorConfigFilePath, fieldPath, `${fieldPath} must be a JSON object.`),
  );
  if (!Object.prototype.hasOwnProperty.call(rawExecutable, 'resolution')) {
    failConfig(
      processorConfigFilePath,
      `${fieldPath}.resolution`,
      `${fieldPath}.resolution is required.`,
    );
  }

  if (rawExecutable.resolution === 'absolute-path') {
    assertKnownFields(rawExecutable, ABSOLUTE_EXECUTABLE_FIELDS, (field) =>
      failConfig(
        processorConfigFilePath,
        `${fieldPath}.${field}`,
        `Unknown absolute-path executable field ${fieldPath}.${field}. Remove it.`,
      ),
    );
    assertRequiredFields(rawExecutable, ABSOLUTE_EXECUTABLE_FIELDS, (field) =>
      failConfig(
        processorConfigFilePath,
        `${fieldPath}.${field}`,
        `${fieldPath}.${field} is required.`,
      ),
    );
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
    assertKnownFields(rawExecutable, PATH_SEARCH_EXECUTABLE_FIELDS, (field) =>
      failConfig(
        processorConfigFilePath,
        `${fieldPath}.${field}`,
        `Unknown path-search executable field ${fieldPath}.${field}. Remove it.`,
      ),
    );
    assertRequiredFields(rawExecutable, PATH_SEARCH_EXECUTABLE_FIELDS, (field) =>
      failConfig(
        processorConfigFilePath,
        `${fieldPath}.${field}`,
        `${fieldPath}.${field} is required.`,
      ),
    );
    const command = unwrapValuePolicy(
      processorConfigFilePath,
      readTypedString(rawExecutable.command, { fieldPath: `${fieldPath}.command` }),
    );
    if (!PATH_SEARCH_COMMAND_RE.test(command) || WINDOWS_DRIVE_PREFIX_RE.test(command)) {
      failConfig(
        processorConfigFilePath,
        `${fieldPath}.command`,
        `${fieldPath}.command must be a bare command name without path separators or a drive prefix.`,
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

function assertStageProcessorReference(
  stage: ExternalRequestRoutingStage | ExternalResponseRoutingStage,
  fieldPath: string,
  processorConfigFilePath: string | undefined,
  processorsByName: ReadonlyMap<string, ExternalProcessorDefinition>,
  externalRoutingConfigFilePath: string,
): void {
  if (!('processor' in stage)) return;
  const processorPath = `${fieldPath}.processor`;
  if (processorConfigFilePath === undefined) {
    failConfig(
      externalRoutingConfigFilePath,
      processorPath,
      `${processorPath} references Processor "${stage.processor}", but processorConfigFile is not configured.`,
      `Add processorConfigFile to ${externalRoutingConfigFilePath}, or use a direct stage, then restart the server.`,
    );
  }
  if (!processorsByName.has(stage.processor)) {
    failConfig(
      externalRoutingConfigFilePath,
      processorPath,
      `${processorPath} references undefined Processor "${stage.processor}".`,
    );
  }
}

function parseEndpointConfig(
  value: JsonValue,
  endpointConfigFilePath: string,
): ExternalHttpEndpointConfig {
  const rawConfig = readObject(value, () =>
    failConfig(
      endpointConfigFilePath,
      undefined,
      'External routing HTTP endpoint config file must contain a JSON object.',
    ),
  );
  assertKnownFields(rawConfig, ENDPOINT_CONFIG_FIELDS, (fieldPath) =>
    failConfig(
      endpointConfigFilePath,
      fieldPath,
      `Unknown HTTP endpoint config field ${fieldPath}. Remove it.`,
    ),
  );
  assertRequiredFields(rawConfig, new Set(['version', 'url', 'timeoutMs']), (fieldPath) =>
    failConfig(endpointConfigFilePath, fieldPath, `${fieldPath} is required.`),
  );
  if (rawConfig.version !== 1) {
    failConfig(
      endpointConfigFilePath,
      'version',
      'version must be the number 1. The server only supports external HTTP endpoint schema version 1.',
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

function parseMcpServerConfig(
  value: JsonValue,
  serverConfigFilePath: string,
  identity: string,
): ExternalMcpServerConfig {
  const rawConfig = readObject(value, () =>
    failConfig(
      serverConfigFilePath,
      undefined,
      'External routing MCP server config file must contain a JSON object.',
    ),
  );
  assertKnownFields(rawConfig, MCP_SERVER_CONFIG_FIELDS, (fieldPath) =>
    failConfig(
      serverConfigFilePath,
      fieldPath,
      `Unknown MCP server config field ${fieldPath}. Remove it.`,
    ),
  );
  assertRequiredFields(rawConfig, new Set(['version', 'url', 'timeoutMs']), (fieldPath) =>
    failConfig(serverConfigFilePath, fieldPath, `${fieldPath} is required.`),
  );
  if (rawConfig.version !== 1) {
    failConfig(
      serverConfigFilePath,
      'version',
      'version must be the number 1. The server only supports MCP server config schema version 1.',
    );
  }
  const url = readEndpointUrl(rawConfig.url, serverConfigFilePath);
  if (!/^https?:\/\/[^/?#]+/i.test(url)) {
    failConfig(
      serverConfigFilePath,
      'url',
      'url must be an absolute http: or https: URL with a hostname.',
    );
  }
  const timeoutMs = unwrapValuePolicy(
    serverConfigFilePath,
    readJsonPositiveInteger(rawConfig.timeoutMs, {
      fieldPath: 'timeoutMs',
      max: MAX_TIMEOUT_MS,
      rangeDescription: `in the range 1..${MAX_TIMEOUT_MS}`,
      label: 'timeoutMs',
    }),
  );
  return deepFreeze({
    identity,
    url,
    timeoutMs,
    headers: parseEndpointHeaders(rawConfig.headers, serverConfigFilePath, FORBIDDEN_MCP_HEADERS),
  });
}

function parseEndpointHeaders(
  value: JsonValue | undefined,
  endpointConfigFilePath: string,
  forbiddenHeaders: ReadonlySet<string> = FORBIDDEN_ENDPOINT_HEADERS,
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const rawHeaders = readObject(value, () =>
    failConfig(endpointConfigFilePath, 'headers', 'headers must be a JSON object when present.'),
  );
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
    if (forbiddenHeaders.has(normalizedName)) {
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
  configFilePath: string,
): string {
  const contentType = unwrapValuePolicy(configFilePath, readTypedString(value, { fieldPath }));
  try {
    validateHeaderValue('Content-Type', contentType);
    new MIMEType(contentType);
  } catch {
    failConfig(
      configFilePath,
      fieldPath,
      `${fieldPath} must be a syntactically valid media type that is safe to write as an HTTP Content-Type header.`,
    );
  }
  return contentType;
}

function readConfigIdentity(
  value: JsonValue | undefined,
  fieldPath: string,
  configFilePath: string,
): string {
  if (typeof value !== 'string' || !CONFIG_IDENTITY_RE.test(value)) {
    failConfig(configFilePath, fieldPath, `${fieldPath} must match ^[A-Za-z0-9._-]{1,128}$.`);
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

function unwrapValuePolicy<T>(configFilePath: string, result: ValuePolicyResult<T>): T {
  if (!result.ok) {
    failConfig(configFilePath, result.error.fieldPath, result.error.message);
  }
  return result.value;
}

function failConfig(
  configFilePath: string,
  fieldPath: string | undefined,
  message: string,
  suggestion?: string,
): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath,
    ...(fieldPath === undefined ? {} : { fieldPath }),
    message,
    suggestion:
      suggestion ??
      `Fix ${fieldPath ?? 'the external routing configuration'} in ${configFilePath} and restart the server.`,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const propertyValue of Object.values(value as Record<string, unknown>)) {
    deepFreeze(propertyValue);
  }
  return Object.freeze(value);
}
