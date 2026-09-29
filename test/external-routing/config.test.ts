import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../src/config/errors.js';
import {
  loadExternalRoutingConfig,
  type ExternalToolDefinitionBinding,
} from '../../src/tools/external-routing/config.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'external-routing-config');
const EXTERNAL_ROUTING_CONFIG_FILE = path.join(FIXTURES_DIR, 'external-routing-config.json');
const PROCESSOR_CONFIG_FILE = path.join(FIXTURES_DIR, 'processor-config.json');
const FIRST_ENDPOINT_CONFIG_FILE = path.join(FIXTURES_DIR, 'first-endpoint-config.json');
const SECOND_ENDPOINT_CONFIG_FILE = path.join(FIXTURES_DIR, 'second-endpoint-config.json');
const FIRST_SERVER_CONFIG_FILE = path.join(FIXTURES_DIR, 'first-mcp-server.json');
const SECOND_SERVER_CONFIG_FILE = path.join(FIXTURES_DIR, 'second-mcp-server.json');
const EXECUTABLE_FILE = path.join(FIXTURES_DIR, 'processor.exe');

const CUSTOM_DEFINITIONS: readonly ExternalToolDefinitionBinding[] = Object.freeze([
  Object.freeze({ definitionId: 'first-route', toolName: 'first.custom', builtIn: false }),
  Object.freeze({ definitionId: 'second-route', toolName: 'second.custom', builtIn: false }),
]);

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
  await fs.writeFile(EXECUTABLE_FILE, 'placeholder', 'utf-8');
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function endpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    url: 'https://external.example.test/v1/tool-calls?tenant=private',
    timeoutMs: 30_000,
    headers: { Authorization: 'Bearer configured-secret', 'X-API-Key': 'key' },
    ...overrides,
  };
}

function mcpServer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    url: 'http://127.0.0.1:43120/mcp?secret=private',
    timeoutMs: 60_000,
    headers: { Authorization: 'Bearer configured-secret', 'X-API-Key': 'key' },
    ...overrides,
  };
}

function directRequest(): Record<string, unknown> {
  return { mode: 'direct' };
}

function directResponse(): Record<string, unknown> {
  return { mode: 'direct' };
}

function routingStrategy(
  request: Record<string, unknown> = directRequest(),
  response: Record<string, unknown> = directResponse(),
): Record<string, unknown> {
  return {
    'request-to-external': [request],
    'response-from-external': [response],
  };
}

function route(
  definitionId: string,
  httpEndpointConfigFile: string,
  strategy: Record<string, unknown> = routingStrategy(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    definitionId,
    routingMode: 'http',
    httpEndpointConfigFile,
    routingStrategy: strategy,
    ...overrides,
  };
}

function mcpRoute(
  definitionId: string,
  mcpServerConfigFile: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { definitionId, routingMode: 'mcp', mcpServerConfigFile, ...overrides };
}

function processor(
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    executable: { resolution: 'absolute-path', path: EXECUTABLE_FILE },
    arguments: ['--mode', 'codec'],
    workingDirectory: FIXTURES_DIR,
    timeoutMs: 30_000,
    ...overrides,
  };
}

function processorConfig(
  processors: unknown[] = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    processors,
    ...overrides,
  };
}

function externalRoutingConfig(
  routes: unknown[] = [route('first-route', FIRST_ENDPOINT_CONFIG_FILE)],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    routes,
    ...overrides,
  };
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    return error;
  }
  throw new Error('Expected external routing configuration loading to fail.');
}

async function testLoadsFrozenRoutesWithIndependentEndpoints(): Promise<void> {
  await resetFixtures();
  await writeJson(FIRST_ENDPOINT_CONFIG_FILE, endpoint({
    url: 'https://first.example.test/v1/tool-calls?tenant=private',
    timeoutMs: 10_000,
  }));
  await writeJson(SECOND_ENDPOINT_CONFIG_FILE, endpoint({
    url: 'https://second.example.test/v1/tool-calls',
    timeoutMs: 20_000,
    headers: { 'X-Route': 'second' },
  }));
  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig([
    processor('codec'),
    processor('unused-registry-entry'),
  ]));
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('first-route', FIRST_ENDPOINT_CONFIG_FILE, routingStrategy(
      {
        mode: 'body-encoder',
        processor: 'codec',
        contentType: 'application/vnd.external+json; charset=utf-8',
      },
      { mode: 'canonical-filter', processor: 'codec' },
    )),
    route('second-route', SECOND_ENDPOINT_CONFIG_FILE),
  ], {
    processorConfigFile: PROCESSOR_CONFIG_FILE,
  }));

  const loaded = loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS);
  const firstRoute = loaded.routesByDefinitionId.get('first-route');
  const secondRoute = loaded.routesByDefinitionId.get('second-route');
  assert(firstRoute?.routingMode === 'http', 'First route should be HTTP');
  assert(secondRoute?.routingMode === 'http', 'Second route should be HTTP');

  assertEqual(loaded.configFilePath, EXTERNAL_ROUTING_CONFIG_FILE, 'Source path should be retained');
  assertEqual(loaded.processorConfigFilePath, PROCESSOR_CONFIG_FILE, 'Processor registry path should be retained');
  assertEqual(loaded.routesByDefinitionId.size, 2, 'Both configured routes should be compiled');
  assertEqual(loaded.routes[0], firstRoute, 'Ordered routes should retain the first declaration');
  assertEqual(loaded.routes[1], secondRoute, 'Ordered routes should retain the second declaration');
  assertEqual(loaded.processorsByName.size, 2, 'The full Processor registry should be retained');
  assertEqual(firstRoute?.toolName, 'first.custom', 'Route should resolve its definition id to Tool name');
  assertEqual(firstRoute?.endpointConfigFilePath, FIRST_ENDPOINT_CONFIG_FILE, 'First route should retain its endpoint source');
  assertEqual(firstRoute?.endpoint.url, 'https://first.example.test/v1/tool-calls?tenant=private', 'First route should retain its endpoint URL');
  assertEqual(firstRoute?.endpoint.timeoutMs, 10_000, 'First route should retain its own endpoint timeout');
  assertEqual(firstRoute?.requestStage.mode, 'body-encoder', 'First request stage should compile');
  assertEqual(
    firstRoute?.requestStage.mode === 'body-encoder' ? firstRoute.requestStage.contentType : undefined,
    'application/vnd.external+json; charset=utf-8',
    'First request stage should retain its media type',
  );
  assertEqual(secondRoute?.toolName, 'second.custom', 'Second route should resolve independently');
  assertEqual(secondRoute?.endpointConfigFilePath, SECOND_ENDPOINT_CONFIG_FILE, 'Second route should retain its endpoint source');
  assertEqual(secondRoute?.endpoint.url, 'https://second.example.test/v1/tool-calls', 'Routes must not share a single endpoint snapshot');
  assertEqual(secondRoute?.endpoint.timeoutMs, 20_000, 'Second route should retain its own endpoint timeout');
  assertEqual(secondRoute?.endpoint.headers['X-Route'], 'second', 'Second route headers should remain route-specific');
  assertEqual(secondRoute?.requestStage.mode, 'direct', 'Direct request routing should load');
  assertEqual(secondRoute?.responseStage.mode, 'direct', 'Direct response routing should load');
  assertEqual(loaded.processorsByName.get('codec')?.name, 'codec', 'Referenced Processor should load');
  assertEqual(loaded.processorsByName.get('unused-registry-entry')?.name, 'unused-registry-entry', 'Unused Processor registry entries should remain valid');

  assert(Object.isFrozen(loaded), 'Compiled routing config should be frozen');
  assert(Object.isFrozen(loaded.routes), 'Ordered routes should be frozen');
  assert(Object.isFrozen(loaded.routesByDefinitionId), 'Route map should be frozen');
  assertEqual(
    'set' in loaded.routesByDefinitionId,
    false,
    'Route map snapshots must not expose mutable Map operations.',
  );
  assertEqual(
    'clear' in loaded.processorsByName,
    false,
    'Processor registry snapshots must not expose mutable Map operations.',
  );
  assert(Object.isFrozen(firstRoute), 'Compiled route should be frozen');
  assert(Object.isFrozen(firstRoute?.endpoint), 'Route endpoint should be frozen');
  assert(Object.isFrozen(firstRoute?.endpoint.headers), 'Endpoint headers should be frozen');
  assert(Object.isFrozen(firstRoute?.requestStage), 'Request stage should be frozen');
  assert(Object.isFrozen(firstRoute?.responseStage), 'Response stage should be frozen');
  assert(Object.isFrozen(loaded.processorsByName.get('codec')), 'Processor definitions should be frozen');
  assert(Object.isFrozen(loaded.processorsByName.get('codec')?.arguments), 'Processor arguments should be frozen');
}

async function testAcceptsEmptyRoutesAndValidatesRedundantProcessorRegistry(): Promise<void> {
  await resetFixtures();
  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig([processor('unused')]));
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([], {
    processorConfigFile: PROCESSOR_CONFIG_FILE,
  }));

  const loaded = loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS);
  assertEqual(loaded.routesByDefinitionId.size, 0, 'An empty routes array should be valid');
  assertEqual(loaded.processorConfigFilePath, PROCESSOR_CONFIG_FILE, 'Redundant Processor config should be retained');
  assertEqual(loaded.processorsByName.get('unused')?.name, 'unused', 'Redundant Processor registry should still load');

  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig([], { unexpected: true }));
  const error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.configFilePath, PROCESSOR_CONFIG_FILE, 'Redundant Processor registry errors should belong to the Processor file');
  assertEqual(error.fieldPath, 'unexpected', 'Redundant Processor registry should be fully validated');
}

async function testRejectsNewSchemaShellAndRouteShape(): Promise<void> {
  await resetFixtures();

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([], { unexpected: true }));
  let error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.configFilePath, EXTERNAL_ROUTING_CONFIG_FILE, 'External routing shell errors belong to its file');
  assertEqual(error.fieldPath, 'unexpected', 'Unknown external routing fields should be identified');

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([], { version: 1 }));
  error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.fieldPath, 'version', 'External routing config must only accept version 2');

  for (const invalidRoutes of [null, {}, 'routes']) {
    await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([], { routes: invalidRoutes }));
    error = captureConfigError(() => loadExternalRoutingConfig(
      EXTERNAL_ROUTING_CONFIG_FILE,
      CUSTOM_DEFINITIONS,
    ));
    assertEqual(error.fieldPath, 'routes', 'External routing routes must be an array');
  }
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, { version: 2 });
  error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.fieldPath, 'routes', 'External routing routes are required');

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([], {
    processorConfigFile: 'relative-processor-config.json',
  }));
  error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.fieldPath, 'processorConfigFile', 'Processor registry references must use local absolute paths');
  assertIncludes(error.message, 'absolute local path', 'Processor registry path policy should be actionable');

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('first-route', FIRST_ENDPOINT_CONFIG_FILE, routingStrategy(), { unexpected: true }),
  ]));
  error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.fieldPath, 'routes[0].unexpected', 'Unknown route fields should include their route index');

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    {
      definitionId: 'first-route',
      routingMode: 'http',
      httpEndpointConfigFile: FIRST_ENDPOINT_CONFIG_FILE,
      routingStrategy: routingStrategy(),
    },
  ], {
    routes: [{ definitionId: 'first-route', routingMode: 'http' }],
  }));
  error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.fieldPath, 'routes[0].httpEndpointConfigFile', 'Route required fields should identify the missing field');
}

async function testEnforcesSingleStageDirectionAwareStrategies(): Promise<void> {
  await resetFixtures();

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly routingStrategy: Record<string, unknown>;
    readonly fieldPath: string;
    readonly message: string;
  }> = [
    {
      name: 'empty request pipeline',
      routingStrategy: {
        'request-to-external': [],
        'response-from-external': [directResponse()],
      },
      fieldPath: 'routes[0].routingStrategy.request-to-external',
      message: 'exactly one stage',
    },
    {
      name: 'multiple response stages',
      routingStrategy: {
        'request-to-external': [directRequest()],
        'response-from-external': [directResponse(), directResponse()],
      },
      fieldPath: 'routes[0].routingStrategy.response-from-external',
      message: 'exactly one stage',
    },
    {
      name: 'direct stage rejects processor field',
      routingStrategy: routingStrategy(
        { mode: 'direct', processor: 'ignored' },
        directResponse(),
      ),
      fieldPath: 'routes[0].routingStrategy.request-to-external[0].processor',
      message: 'Unknown routing stage field',
    },
    {
      name: 'body encoder requires content type',
      routingStrategy: routingStrategy(
        { mode: 'body-encoder', processor: 'codec' },
        directResponse(),
      ),
      fieldPath: 'routes[0].routingStrategy.request-to-external[0].contentType',
      message: 'is required',
    },
    {
      name: 'response stage rejects request-only body encoder',
      routingStrategy: routingStrategy(
        directRequest(),
        { mode: 'body-encoder', processor: 'codec' },
      ),
      fieldPath: 'routes[0].routingStrategy.response-from-external[0].mode',
      message: 'body-decoder',
    },
  ];

  for (const testCase of cases) {
    await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
      route('first-route', FIRST_ENDPOINT_CONFIG_FILE, testCase.routingStrategy),
    ]));
    const error = captureConfigError(() => loadExternalRoutingConfig(
      EXTERNAL_ROUTING_CONFIG_FILE,
      CUSTOM_DEFINITIONS,
    ));
    assertEqual(error.fieldPath, testCase.fieldPath, `${testCase.name} should identify the invalid field`);
    assertIncludes(error.message, testCase.message, `${testCase.name} should explain the violation`);
  }
}

async function testRejectsInvalidDefinitionBindings(): Promise<void> {
  await resetFixtures();

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('missing-route', FIRST_ENDPOINT_CONFIG_FILE),
  ]));
  let error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.configFilePath, EXTERNAL_ROUTING_CONFIG_FILE, 'Undefined definition binding belongs to external routing config');
  assertEqual(error.fieldPath, 'routes[0].definitionId', 'Undefined definition binding should identify its route');
  assertIncludes(error.message, 'undefined Tool definition id', 'Undefined definition binding should be actionable');

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('first-route', FIRST_ENDPOINT_CONFIG_FILE),
    route('first-route', SECOND_ENDPOINT_CONFIG_FILE),
  ]));
  error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.fieldPath, 'routes[1].definitionId', 'Duplicate bindings should identify the later route');
  assertIncludes(error.message, 'already bound', 'Duplicate bindings should be actionable');

  const builtInDefinition: readonly ExternalToolDefinitionBinding[] = Object.freeze([
    Object.freeze({ definitionId: 'built-in-override', toolName: 'read_file', builtIn: true }),
  ]);
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('built-in-override', FIRST_ENDPOINT_CONFIG_FILE),
  ]));
  error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    builtInDefinition,
  ));
  assertEqual(error.configFilePath, EXTERNAL_ROUTING_CONFIG_FILE, 'Built-in binding rejection belongs to external routing config');
  assertEqual(error.fieldPath, 'routes[0].definitionId', 'Built-in binding rejection should identify definitionId');
  assertIncludes(error.message, 'custom-only', 'Built-in binding rejection should explain executor preservation');
}

async function testValidatesProcessorReferencesAndRegistryErrors(): Promise<void> {
  await resetFixtures();
  const requestFilter = { mode: 'canonical-filter', processor: 'codec' };

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('first-route', FIRST_ENDPOINT_CONFIG_FILE, routingStrategy(requestFilter, directResponse())),
  ]));
  let error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.configFilePath, EXTERNAL_ROUTING_CONFIG_FILE, 'Missing Processor registry belongs to external routing config');
  assertEqual(error.fieldPath, 'routes[0].routingStrategy.request-to-external[0].processor', 'Missing registry should identify the stage Processor reference');
  assertIncludes(error.message, 'processorConfigFile is not configured', 'Missing registry should be actionable');
  assertIncludes(error.suggestion ?? '', 'processorConfigFile', 'Missing registry should suggest the registry field');

  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig([]));
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('first-route', FIRST_ENDPOINT_CONFIG_FILE, routingStrategy(requestFilter, directResponse())),
  ], { processorConfigFile: PROCESSOR_CONFIG_FILE }));
  error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.configFilePath, EXTERNAL_ROUTING_CONFIG_FILE, 'Undefined Processor references belong to external routing config');
  assertEqual(error.fieldPath, 'routes[0].routingStrategy.request-to-external[0].processor', 'Undefined Processor should identify its stage');
  assertIncludes(error.message, 'undefined Processor', 'Undefined Processor reference should be actionable');

  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig([], { version: 1 }));
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([], {
    processorConfigFile: PROCESSOR_CONFIG_FILE,
  }));
  error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.configFilePath, PROCESSOR_CONFIG_FILE, 'Processor schema errors belong to Processor config');
  assertEqual(error.fieldPath, 'version', 'Processor config must only accept version 2');

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly processors: unknown[];
    readonly fieldPath: string;
    readonly message: string;
  }> = [
    {
      name: 'duplicate Processor names',
      processors: [processor('codec'), processor('codec')],
      fieldPath: 'processors[1].name',
      message: 'duplicated',
    },
    {
      name: 'absolute executable must be a file',
      processors: [processor('codec', {
        executable: { resolution: 'absolute-path', path: FIXTURES_DIR },
      })],
      fieldPath: 'processors[0].executable.path',
      message: 'regular file',
    },
    {
      name: 'path-search command must be bare',
      processors: [processor('codec', {
        executable: { resolution: 'path-search', command: 'node/codec' },
      })],
      fieldPath: 'processors[0].executable.command',
      message: 'bare command',
    },
    {
      name: 'working directory must exist',
      processors: [processor('codec', { workingDirectory: path.join(FIXTURES_DIR, 'missing') })],
      fieldPath: 'processors[0].workingDirectory',
      message: 'does not exist',
    },
    {
      name: 'timeout has a bounded positive range',
      processors: [processor('codec', { timeoutMs: 0 })],
      fieldPath: 'processors[0].timeoutMs',
      message: '1..2147483647',
    },
  ];

  for (const testCase of cases) {
    await writeJson(PROCESSOR_CONFIG_FILE, processorConfig(testCase.processors));
    const registryError = captureConfigError(() => loadExternalRoutingConfig(
      EXTERNAL_ROUTING_CONFIG_FILE,
      CUSTOM_DEFINITIONS,
    ));
    assertEqual(registryError.configFilePath, PROCESSOR_CONFIG_FILE, `${testCase.name} should belong to Processor config`);
    assertEqual(registryError.fieldPath, testCase.fieldPath, `${testCase.name} should identify the invalid Processor field`);
    assertIncludes(registryError.message, testCase.message, `${testCase.name} should explain the violation`);
  }
}

async function testValidatesEndpointFilesAtTheirActualPaths(): Promise<void> {
  await resetFixtures();
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('first-route', FIRST_ENDPOINT_CONFIG_FILE),
  ]));

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly endpointValue: Record<string, unknown>;
    readonly fieldPath: string;
    readonly message: string;
  }> = [
    {
      name: 'non HTTP scheme',
      endpointValue: endpoint({ url: 'ftp://external.example.test/route' }),
      fieldPath: 'url',
      message: 'http: or https:',
    },
    {
      name: 'credentials',
      endpointValue: endpoint({ url: 'https://user:password@external.example.test/route' }),
      fieldPath: 'url',
      message: 'no credentials',
    },
    {
      name: 'fragment',
      endpointValue: endpoint({ url: 'https://external.example.test/route#fragment' }),
      fieldPath: 'url',
      message: 'no fragment',
    },
    {
      name: 'forbidden transport-owned header',
      endpointValue: endpoint({ headers: { 'Content-Type': 'application/json' } }),
      fieldPath: 'headers["Content-Type"]',
      message: 'transport-owned',
    },
    {
      name: 'case-insensitive duplicate headers',
      endpointValue: endpoint({ headers: { Accept: 'application/json', accept: 'text/plain' } }),
      fieldPath: 'headers["accept"]',
      message: 'duplicate',
    },
    {
      name: 'invalid Node header value',
      endpointValue: endpoint({ headers: { 'X-Test': 'bad\u0001value' } }),
      fieldPath: 'headers["X-Test"]',
      message: 'valid Node.js HTTP header',
    },
  ];

  for (const testCase of cases) {
    await writeJson(FIRST_ENDPOINT_CONFIG_FILE, testCase.endpointValue);
    const error = captureConfigError(() => loadExternalRoutingConfig(
      EXTERNAL_ROUTING_CONFIG_FILE,
      CUSTOM_DEFINITIONS,
    ));
    assertEqual(error.configFilePath, FIRST_ENDPOINT_CONFIG_FILE, `${testCase.name} should belong to the endpoint file`);
    assertEqual(error.fieldPath, testCase.fieldPath, `${testCase.name} should identify the endpoint field`);
    assertIncludes(error.message, testCase.message, `${testCase.name} should explain the violation`);
  }

  await fs.rm(FIRST_ENDPOINT_CONFIG_FILE, { force: true });
  const missingError = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(missingError.code, 'config_file_not_found', 'Missing endpoint should retain the referenced-file error code');
  assertEqual(missingError.configFilePath, FIRST_ENDPOINT_CONFIG_FILE, 'Missing endpoint should identify its actual path');
}

async function testValidatesBodyEncoderMediaTypeAndEndpointHeaderBoundary(): Promise<void> {
  await resetFixtures();
  const requestEncoder = {
    mode: 'body-encoder',
    processor: 'codec',
    contentType: 'application/vnd.external+json; charset=utf-8',
  };
  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig([
    processor('codec', { executable: { resolution: 'path-search', command: 'node' } }),
  ]));
  await writeJson(FIRST_ENDPOINT_CONFIG_FILE, endpoint({ headers: {} }));
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('first-route', FIRST_ENDPOINT_CONFIG_FILE, routingStrategy(requestEncoder, directResponse())),
  ], { processorConfigFile: PROCESSOR_CONFIG_FILE }));

  const loaded = loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS);
  const loadedRoute = loaded.routesByDefinitionId.get('first-route');
  assert(loadedRoute?.routingMode === 'http', 'Body encoder route should be HTTP');
  assertEqual(loadedRoute?.requestStage.mode, 'body-encoder', 'Body encoder should load with a legal media type');
  assertEqual(
    loadedRoute?.requestStage.mode === 'body-encoder' ? loadedRoute.requestStage.contentType : undefined,
    'application/vnd.external+json; charset=utf-8',
    'Configured body media type should be retained',
  );

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('first-route', FIRST_ENDPOINT_CONFIG_FILE, routingStrategy(
      { ...requestEncoder, contentType: 'not-a-media-type' },
      directResponse(),
    )),
  ], { processorConfigFile: PROCESSOR_CONFIG_FILE }));
  let error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.configFilePath, EXTERNAL_ROUTING_CONFIG_FILE, 'Route media type errors belong to external routing config');
  assertEqual(error.fieldPath, 'routes[0].routingStrategy.request-to-external[0].contentType', 'Invalid media type should identify contentType');
  assertIncludes(error.message, 'syntactically valid media type', 'Invalid media type should be explained');

  await writeJson(FIRST_ENDPOINT_CONFIG_FILE, endpoint({ headers: { 'content-type': 'text/plain' } }));
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('first-route', FIRST_ENDPOINT_CONFIG_FILE, routingStrategy(requestEncoder, directResponse())),
  ], { processorConfigFile: PROCESSOR_CONFIG_FILE }));
  error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.configFilePath, FIRST_ENDPOINT_CONFIG_FILE, 'Endpoint header errors belong to endpoint config');
  assertEqual(error.fieldPath, 'headers["content-type"]', 'Static Content-Type must not compete with request strategy');
}

async function testEnforcesRouteModesAndCrossModeBindings(): Promise<void> {
  await resetFixtures();
  const cases: ReadonlyArray<{ readonly routeValue: unknown; readonly fieldPath: string }> = [
    { routeValue: { definitionId: 'first-route', mcpServerConfigFile: FIRST_SERVER_CONFIG_FILE }, fieldPath: 'routes[0].routingMode' },
    { routeValue: mcpRoute('first-route', FIRST_SERVER_CONFIG_FILE, { routingMode: 'unknown' }), fieldPath: 'routes[0].routingMode' },
    { routeValue: mcpRoute('first-route', FIRST_SERVER_CONFIG_FILE, { routingMode: 42 }), fieldPath: 'routes[0].routingMode' },
    { routeValue: mcpRoute('first-route', FIRST_SERVER_CONFIG_FILE, { routingStrategy: routingStrategy() }), fieldPath: 'routes[0].routingStrategy' },
    { routeValue: mcpRoute('first-route', FIRST_SERVER_CONFIG_FILE, { httpEndpointConfigFile: FIRST_ENDPOINT_CONFIG_FILE }), fieldPath: 'routes[0].httpEndpointConfigFile' },
    { routeValue: route('first-route', FIRST_ENDPOINT_CONFIG_FILE, routingStrategy(), { mcpServerConfigFile: FIRST_SERVER_CONFIG_FILE }), fieldPath: 'routes[0].mcpServerConfigFile' },
    { routeValue: { definitionId: 'first-route', routingMode: 'mcp' }, fieldPath: 'routes[0].mcpServerConfigFile' },
    { routeValue: { definitionId: 'first-route', routingMode: 'http', httpEndpointConfigFile: FIRST_ENDPOINT_CONFIG_FILE }, fieldPath: 'routes[0].routingStrategy' },
  ];
  for (const { routeValue, fieldPath } of cases) {
    await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([routeValue]));
    const error = captureConfigError(() => loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS));
    assertEqual(error.configFilePath, EXTERNAL_ROUTING_CONFIG_FILE, 'Route shape errors belong to the routing config');
    assertEqual(error.fieldPath, fieldPath, 'Strict mode union should identify its invalid field');
  }

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('first-route', FIRST_ENDPOINT_CONFIG_FILE),
    mcpRoute('first-route', FIRST_SERVER_CONFIG_FILE),
  ]));
  let error = captureConfigError(() => loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS));
  assertEqual(error.fieldPath, 'routes[1].definitionId', 'Binding identity must be unique across modes');

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    mcpRoute('missing-route', FIRST_SERVER_CONFIG_FILE),
  ]));
  error = captureConfigError(() => loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS));
  assertEqual(error.fieldPath, 'routes[0].definitionId', 'MCP route must reference a known definition');
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    mcpRoute('built-in-override', FIRST_SERVER_CONFIG_FILE),
  ]));
  error = captureConfigError(() => loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, [
    { definitionId: 'built-in-override', toolName: 'read_file', builtIn: true },
  ]));
  assertEqual(error.fieldPath, 'routes[0].definitionId', 'MCP route cannot bind a built-in override');
}

async function testMcpServerPathPolicyAndSourceErrors(): Promise<void> {
  await resetFixtures();
  for (const invalidPath of [
    'relative.json', '~/server.json', ' server.json', 'server.json ',
    '\\\\server\\share\\config.json', '\\\\?\\C:\\server.json',
    'C:server.json', '\\rooted.json',
  ]) {
    await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
      mcpRoute('first-route', invalidPath),
    ]));
    const error = captureConfigError(() => loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS));
    assertEqual(error.configFilePath, EXTERNAL_ROUTING_CONFIG_FILE, 'Invalid reference belongs to routing config');
    assertEqual(error.fieldPath, 'routes[0].mcpServerConfigFile', 'MCP server path must use the local absolute path policy');
  }
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    mcpRoute('first-route', FIRST_SERVER_CONFIG_FILE),
  ]));
  let error = captureConfigError(() => loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS));
  assertEqual(error.code, 'config_file_not_found', 'Missing MCP server should retain referenced-file error code');
  assertEqual(error.configFilePath, FIRST_SERVER_CONFIG_FILE, 'Missing MCP server should identify its declared path');

  await fs.writeFile(FIRST_SERVER_CONFIG_FILE, '{invalid', 'utf-8');
  error = captureConfigError(() => loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS));
  assertEqual(error.code, 'config_json_invalid', 'MCP server JSON errors should retain referenced-file error code');
  assertEqual(error.configFilePath, FIRST_SERVER_CONFIG_FILE, 'Invalid MCP server JSON should identify its declared path');
}

async function testMcpServerSchemaUrlTimeoutAndHeaders(): Promise<void> {
  await resetFixtures();
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    mcpRoute('first-route', FIRST_SERVER_CONFIG_FILE),
  ]));
  const cases: ReadonlyArray<{
    readonly value: unknown;
    readonly fieldPath?: string;
  }> = [
    { value: [] },
    { value: mcpServer({ extra: true }), fieldPath: 'extra' },
    { value: mcpServer({ version: 2 }), fieldPath: 'version' },
    { value: mcpServer({ url: undefined }), fieldPath: 'url' },
    { value: mcpServer({ url: 'ftp://127.0.0.1/mcp' }), fieldPath: 'url' },
    { value: mcpServer({ url: 'http://user:password@127.0.0.1/mcp' }), fieldPath: 'url' },
    { value: mcpServer({ url: 'https://127.0.0.1/mcp#secret' }), fieldPath: 'url' },
    { value: mcpServer({ url: 'http:///mcp' }), fieldPath: 'url' },
    { value: mcpServer({ timeoutMs: 0 }), fieldPath: 'timeoutMs' },
    { value: mcpServer({ timeoutMs: 2_147_483_648 }), fieldPath: 'timeoutMs' },
    { value: mcpServer({ timeoutMs: 1.5 }), fieldPath: 'timeoutMs' },
    { value: mcpServer({ headers: [] }), fieldPath: 'headers' },
    { value: mcpServer({ headers: { 'X-Test': 42 } }), fieldPath: 'headers["X-Test"]' },
    { value: mcpServer({ headers: { 'X-Test': 'bad\u0001value' } }), fieldPath: 'headers["X-Test"]' },
    { value: mcpServer({ headers: { 'bad name': 'value' } }), fieldPath: 'headers["bad name"]' },
    { value: mcpServer({ headers: { Authorization: 'first', authorization: 'second' } }), fieldPath: 'headers["authorization"]' },
  ];
  for (const { value, fieldPath } of cases) {
    await writeJson(FIRST_SERVER_CONFIG_FILE, value);
    const error = captureConfigError(() => loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS));
    assertEqual(error.configFilePath, FIRST_SERVER_CONFIG_FILE, 'MCP server validation belongs to server config');
    assertEqual(error.fieldPath, fieldPath, 'MCP server validation should identify the rejected field');
  }
  for (const forbidden of [
    'Host', 'Content-Length', 'Content-Type', 'Accept', 'Accept-Encoding', 'Transfer-Encoding',
    'Connection', 'Keep-Alive', 'TE', 'Trailer', 'Upgrade', 'Proxy-Authenticate',
    'Proxy-Authorization', 'Proxy-Connection', 'mCp-SeSsIoN-Id', 'mcp-protocol-version',
    'Last-Event-ID',
  ]) {
    await writeJson(FIRST_SERVER_CONFIG_FILE, mcpServer({ headers: { [forbidden]: 'configured' } }));
    const error = captureConfigError(() => loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS));
    assertEqual(error.configFilePath, FIRST_SERVER_CONFIG_FILE, 'Reserved MCP header belongs to server config');
    assertEqual(error.fieldPath, `headers[${JSON.stringify(forbidden)}]`, 'Reserved headers must be rejected case-insensitively');
  }
  await writeJson(FIRST_SERVER_CONFIG_FILE, mcpServer({ timeoutMs: 2_147_483_647 }));
  const routeValue = loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS).routes[0];
  assert(routeValue?.routingMode === 'mcp', 'A valid MCP server config should compile');
  assertEqual(routeValue.server.timeoutMs, 2_147_483_647, 'Maximum timeout should be accepted');
  assertEqual(routeValue.server.url, 'http://127.0.0.1:43120/mcp?secret=private', 'Query should remain in endpoint snapshot');
  assertEqual(routeValue.server.headers.Authorization, 'Bearer configured-secret', 'Authorization is an allowed static header');
  assert(Object.isFrozen(routeValue.server.headers), 'MCP headers must be frozen');
  assert(Object.isFrozen(routeValue.server), 'MCP server snapshot must be frozen');
}

async function testMcpServerRealPathIdentityAndDeclarationOrder(): Promise<void> {
  await resetFixtures();
  await fs.mkdir(path.join(FIXTURES_DIR, 'nested'));
  await writeJson(FIRST_SERVER_CONFIG_FILE, mcpServer());
  await writeJson(SECOND_SERVER_CONFIG_FILE, mcpServer());
  const aliasPath = path.join(FIXTURES_DIR, 'nested', '..', 'first-mcp-server.json');
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    mcpRoute('second-route', FIRST_SERVER_CONFIG_FILE),
    mcpRoute('first-route', aliasPath),
  ]));
  const shared = loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS);
  const first = shared.routes[0];
  const alias = shared.routes[1];
  assert(first?.routingMode === 'mcp' && alias?.routingMode === 'mcp', 'Both routes should be MCP');
  assertEqual(first.definitionId, 'second-route', 'Routes should preserve declaration order');
  assertEqual(alias.definitionId, 'first-route', 'Routes should preserve declaration order, not definition order');
  assertEqual(shared.routesByDefinitionId.get('first-route'), alias, 'Lookup and ordered view share route objects');
  assertEqual(first.server, alias.server, 'Realpath alias should share a server snapshot');
  assertEqual(alias.serverConfigFilePath, aliasPath, 'Alias must retain its declared source path');
  assertEqual(first.server.identity, await fs.realpath(FIRST_SERVER_CONFIG_FILE), 'Server identity must use native realpath');
  assert(Object.isFrozen(shared.routes), 'Declaration-order view must be immutable');

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    mcpRoute('first-route', FIRST_SERVER_CONFIG_FILE),
    mcpRoute('second-route', SECOND_SERVER_CONFIG_FILE),
  ]));
  const separate = loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS);
  const firstSeparate = separate.routes[0];
  const secondSeparate = separate.routes[1];
  assert(firstSeparate?.routingMode === 'mcp' && secondSeparate?.routingMode === 'mcp', 'Both routes should be MCP');
  assert(firstSeparate.server !== secondSeparate.server, 'Separate real paths with equal content must not merge');
  assert(firstSeparate.server.identity !== secondSeparate.server.identity, 'Separate server identities must stay distinct');

  const symlinkPath = path.join(FIXTURES_DIR, 'server-link.json');
  try {
    await fs.symlink(FIRST_SERVER_CONFIG_FILE, symlinkPath, 'file');
  } catch (error: unknown) {
    // Some Windows hosts disallow symlink creation without Developer Mode or privilege.
    if (process.platform === 'win32' && typeof error === 'object' && error !== null &&
        'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')) return;
    throw error;
  }
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    mcpRoute('first-route', FIRST_SERVER_CONFIG_FILE),
    mcpRoute('second-route', symlinkPath),
  ]));
  const linked = loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS);
  const original = linked.routes[0];
  const symlink = linked.routes[1];
  assert(original?.routingMode === 'mcp' && symlink?.routingMode === 'mcp', 'Both linked routes should be MCP');
  assertEqual(original.server, symlink.server, 'Symlink alias should share the realpath identity');
  assertEqual(symlink.serverConfigFilePath, symlinkPath, 'Symlink declaration should retain its source path');
}

async function testHiddenMcpRouteStillLoadsAndValidates(): Promise<void> {
  await resetFixtures();
  // The config loader receives all definitions before catalog exposure filters the visible tools.
  await writeJson(FIRST_ENDPOINT_CONFIG_FILE, endpoint());
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([
    route('first-route', FIRST_ENDPOINT_CONFIG_FILE),
    mcpRoute('second-route', FIRST_SERVER_CONFIG_FILE),
  ]));
  await writeJson(FIRST_SERVER_CONFIG_FILE, mcpServer({ headers: { 'MCP-Session-ID': 'forbidden' } }));
  const error = captureConfigError(() => loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS));
  assertEqual(error.configFilePath, FIRST_SERVER_CONFIG_FILE, 'A later-hidden route must still validate its server config');
  assertEqual(error.fieldPath, 'headers["MCP-Session-ID"]', 'Hidden route still rejects invalid server headers');

  await writeJson(FIRST_SERVER_CONFIG_FILE, mcpServer());
  const loaded = loadExternalRoutingConfig(EXTERNAL_ROUTING_CONFIG_FILE, CUSTOM_DEFINITIONS);
  assertEqual(loaded.routes[0]?.routingMode, 'http', 'Mixed config should preserve HTTP route first');
  assertEqual(loaded.routes[1]?.routingMode, 'mcp', 'Mixed config should preserve MCP route second');
  assertEqual(loaded.routesByDefinitionId.size, 2, 'Both mode routes should be compiled before exposure');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external routing configuration loading',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'loads frozen routes with independent endpoints', run: testLoadsFrozenRoutesWithIndependentEndpoints },
      { name: 'accepts empty routes and validates redundant Processor registry', run: testAcceptsEmptyRoutesAndValidatesRedundantProcessorRegistry },
      { name: 'rejects strict external routing schema shells and route shape', run: testRejectsNewSchemaShellAndRouteShape },
      { name: 'enforces single-stage direction-aware strategies', run: testEnforcesSingleStageDirectionAwareStrategies },
      { name: 'rejects invalid definition bindings', run: testRejectsInvalidDefinitionBindings },
      { name: 'validates Processor references and registry errors', run: testValidatesProcessorReferencesAndRegistryErrors },
      { name: 'validates endpoint files at their actual paths', run: testValidatesEndpointFilesAtTheirActualPaths },
      { name: 'validates body media type and endpoint header boundary', run: testValidatesBodyEncoderMediaTypeAndEndpointHeaderBoundary },
      { name: 'enforces route modes and cross-mode bindings', run: testEnforcesRouteModesAndCrossModeBindings },
      { name: 'validates MCP server path policy and source errors', run: testMcpServerPathPolicyAndSourceErrors },
      { name: 'validates MCP server schema, URL, timeout, and headers', run: testMcpServerSchemaUrlTimeoutAndHeaders },
      { name: 'preserves MCP realpath identities and route declaration order', run: testMcpServerRealPathIdentityAndDeclarationOrder },
      { name: 'validates MCP routes even when later hidden by exposure', run: testHiddenMcpRouteStillLoadsAndValidates },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
