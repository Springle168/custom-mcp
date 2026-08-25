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
    httpEndpointConfigFile,
    routingStrategy: strategy,
    ...overrides,
  };
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
    version: 1,
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

  assertEqual(loaded.configFilePath, EXTERNAL_ROUTING_CONFIG_FILE, 'Source path should be retained');
  assertEqual(loaded.processorConfigFilePath, PROCESSOR_CONFIG_FILE, 'Processor registry path should be retained');
  assertEqual(loaded.routesByDefinitionId.size, 2, 'Both configured routes should be compiled');
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

  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig([], { version: 2 }));
  error = captureConfigError(() => loadExternalRoutingConfig(
    EXTERNAL_ROUTING_CONFIG_FILE,
    CUSTOM_DEFINITIONS,
  ));
  assertEqual(error.fieldPath, 'version', 'External routing config must only accept version 1');

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
      httpEndpointConfigFile: FIRST_ENDPOINT_CONFIG_FILE,
      routingStrategy: routingStrategy(),
    },
  ], {
    routes: [{ definitionId: 'first-route' }],
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
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
