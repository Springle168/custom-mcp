import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../src/config/errors.js';
import { loadExternalRoutingSpec } from '../../src/tools/external-routing/config.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'external-routing-config');
const PROCESSOR_CONFIG_FILE = path.join(FIXTURES_DIR, 'processor-config.json');
const ENDPOINT_CONFIG_FILE = path.join(FIXTURES_DIR, 'endpoint-config.json');
const EXECUTABLE_FILE = path.join(FIXTURES_DIR, 'processor.exe');

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
  return { strategy: 'request-to-external', mode: 'direct' };
}

function directResponse(): Record<string, unknown> {
  return { strategy: 'response-from-external', mode: 'direct' };
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
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    httpEndpointConfigFile: ENDPOINT_CONFIG_FILE,
    processors: [],
    routingStrategy: [directRequest(), directResponse()],
    ...overrides,
  };
}

async function writeValidDirectConfig(): Promise<void> {
  await writeJson(ENDPOINT_CONFIG_FILE, endpoint());
  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig());
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

async function testLoadsFrozenDirectDirectSpec(): Promise<void> {
  await resetFixtures();
  await writeValidDirectConfig();

  const spec = loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE);
  assertEqual(spec.processorConfigFilePath, PROCESSOR_CONFIG_FILE, 'Processor source path should be retained');
  assertEqual(spec.httpEndpointConfigFilePath, ENDPOINT_CONFIG_FILE, 'Endpoint source path should be retained');
  assertEqual(spec.endpoint.url, 'https://external.example.test/v1/tool-calls?tenant=private', 'Endpoint URL should be preserved');
  assertEqual(spec.endpoint.timeoutMs, 30_000, 'Endpoint timeout should be retained');
  assertEqual(spec.endpoint.headers.Authorization, 'Bearer configured-secret', 'Allowed static headers should be retained');
  assertEqual(spec.requestStrategy.mode, 'direct', 'Direct request routing should load');
  assertEqual(spec.responseStrategy.mode, 'direct', 'Direct response routing should load');
  assertEqual(spec.processors.length, 0, 'direct/direct must allow no processors');
  assert(Object.isFrozen(spec), 'External route spec should be frozen');
  assert(Object.isFrozen(spec.endpoint), 'Endpoint config should be frozen');
  assert(Object.isFrozen(spec.endpoint.headers), 'Endpoint headers should be frozen');
  assert(Object.isFrozen(spec.processors), 'Processor list should be frozen');
  assert(Object.isFrozen(spec.requestStrategy), 'Request strategy should be frozen');
  assert(Object.isFrozen(spec.responseStrategy), 'Response strategy should be frozen');
}

async function testStrictShellsAndReferencedFiles(): Promise<void> {
  await resetFixtures();
  await writeValidDirectConfig();

  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig({ unknown: true }));
  let error = captureConfigError(() => loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE));
  assertEqual(error.configFilePath, PROCESSOR_CONFIG_FILE, 'Processor shell errors belong to the Processor config');
  assertEqual(error.fieldPath, 'unknown', 'Unknown Processor field should be identified');

  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig({ version: 2 }));
  error = captureConfigError(() => loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE));
  assertEqual(error.fieldPath, 'version', 'Unsupported Processor version should be identified');

  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig({ httpEndpointConfigFile: 'relative.json' }));
  error = captureConfigError(() => loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE));
  assertEqual(error.fieldPath, 'httpEndpointConfigFile', 'Endpoint references must use local absolute paths');
  assertIncludes(error.message, 'absolute local path', 'Endpoint reference policy should be actionable');

  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig({ httpEndpointConfigFile: ENDPOINT_CONFIG_FILE }));
  await fs.rm(ENDPOINT_CONFIG_FILE, { force: true });
  error = captureConfigError(() => loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE));
  assertEqual(error.code, 'config_file_not_found', 'Missing endpoint config should retain the file-not-found code');
  assertEqual(error.configFilePath, ENDPOINT_CONFIG_FILE, 'Missing endpoint config should identify the referenced file');

  await writeJson(ENDPOINT_CONFIG_FILE, endpoint({ unexpected: true }));
  error = captureConfigError(() => loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE));
  assertEqual(error.configFilePath, ENDPOINT_CONFIG_FILE, 'Endpoint shell errors belong to the endpoint config');
  assertEqual(error.fieldPath, 'unexpected', 'Unknown endpoint field should be identified');
}

async function testStrictStrategyUnionAndCardinality(): Promise<void> {
  await resetFixtures();
  await writeJson(ENDPOINT_CONFIG_FILE, endpoint());

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly routingStrategy: unknown[];
    readonly fieldPath: string;
    readonly message: string;
  }> = [
    {
      name: 'duplicate request direction',
      routingStrategy: [directRequest(), directRequest(), directResponse()],
      fieldPath: 'routingStrategy[1].strategy',
      message: 'exactly one request-to-external',
    },
    {
      name: 'missing response direction',
      routingStrategy: [directRequest()],
      fieldPath: 'routingStrategy',
      message: 'exactly one response-from-external',
    },
    {
      name: 'request mode is exact',
      routingStrategy: [
        { strategy: 'request-to-external', mode: 'DIRECT' },
        directResponse(),
      ],
      fieldPath: 'routingStrategy[0].mode',
      message: 'must be exactly',
    },
    {
      name: 'direct branch rejects processor field',
      routingStrategy: [
        { strategy: 'request-to-external', mode: 'direct', processor: 'ignored' },
        directResponse(),
      ],
      fieldPath: 'routingStrategy[0].processor',
      message: 'Unknown routing strategy field',
    },
    {
      name: 'body encoder requires content type',
      routingStrategy: [
        { strategy: 'request-to-external', mode: 'body-encoder', processor: 'codec' },
        directResponse(),
      ],
      fieldPath: 'routingStrategy[0].contentType',
      message: 'is required',
    },
  ];

  for (const testCase of cases) {
    await writeJson(PROCESSOR_CONFIG_FILE, processorConfig({ routingStrategy: testCase.routingStrategy }));
    const error = captureConfigError(() => loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE));
    assertEqual(error.fieldPath, testCase.fieldPath, `${testCase.name} should identify the invalid field`);
    assertIncludes(error.message, testCase.message, `${testCase.name} should explain the violation`);
  }
}

async function testProcessorDefinitionsAndReferences(): Promise<void> {
  await resetFixtures();
  await writeJson(ENDPOINT_CONFIG_FILE, endpoint());

  const requestFilter = {
    strategy: 'request-to-external',
    mode: 'canonical-filter',
    processor: 'codec',
  };
  const responseDecoder = {
    strategy: 'response-from-external',
    mode: 'body-decoder',
    processor: 'codec',
  };
  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig({
    processors: [processor('codec')],
    routingStrategy: [responseDecoder, requestFilter],
  }));
  const loaded = loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE);
  assertEqual(loaded.processors[0]?.name, 'codec', 'A Processor may serve both strategies');
  assertEqual(loaded.responseStrategy.mode, 'body-decoder', 'Strategy order must not change response selection');
  assert(Object.isFrozen(loaded.processors[0]), 'Processor entries should be frozen');
  assert(Object.isFrozen(loaded.processors[0]?.arguments), 'Processor argument arrays should be frozen');

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly config: Record<string, unknown>;
    readonly fieldPath: string;
    readonly message: string;
  }> = [
    {
      name: 'duplicate names',
      config: {
        processors: [processor('codec'), processor('codec')],
        routingStrategy: [requestFilter, responseDecoder],
      },
      fieldPath: 'processors[1].name',
      message: 'duplicated',
    },
    {
      name: 'undefined reference',
      config: {
        processors: [],
        routingStrategy: [requestFilter, directResponse()],
      },
      fieldPath: 'routingStrategy[0].processor',
      message: 'undefined Processor',
    },
    {
      name: 'unused processor',
      config: { processors: [processor('unused')] },
      fieldPath: 'processors[0].name',
      message: 'not referenced',
    },
    {
      name: 'absolute executable must be a file',
      config: {
        processors: [processor('codec', { executable: { resolution: 'absolute-path', path: FIXTURES_DIR } })],
        routingStrategy: [requestFilter, responseDecoder],
      },
      fieldPath: 'processors[0].executable.path',
      message: 'regular file',
    },
    {
      name: 'path search command must be bare',
      config: {
        processors: [processor('codec', { executable: { resolution: 'path-search', command: 'node/codec' } })],
        routingStrategy: [requestFilter, responseDecoder],
      },
      fieldPath: 'processors[0].executable.command',
      message: 'bare command',
    },
    {
      name: 'path search command rejects Windows drive-relative form',
      config: {
        processors: [processor('codec', { executable: { resolution: 'path-search', command: 'C:codec.exe' } })],
        routingStrategy: [requestFilter, responseDecoder],
      },
      fieldPath: 'processors[0].executable.command',
      message: 'drive prefix',
    },
    {
      name: 'working directory must exist',
      config: {
        processors: [processor('codec', { workingDirectory: path.join(FIXTURES_DIR, 'missing') })],
        routingStrategy: [requestFilter, responseDecoder],
      },
      fieldPath: 'processors[0].workingDirectory',
      message: 'does not exist',
    },
    {
      name: 'timeout has a bounded positive range',
      config: {
        processors: [processor('codec', { timeoutMs: 0 })],
        routingStrategy: [requestFilter, responseDecoder],
      },
      fieldPath: 'processors[0].timeoutMs',
      message: '1..2147483647',
    },
  ];

  for (const testCase of cases) {
    await writeJson(PROCESSOR_CONFIG_FILE, processorConfig(testCase.config));
    const error = captureConfigError(() => loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE));
    assertEqual(error.fieldPath, testCase.fieldPath, `${testCase.name} should identify the invalid field`);
    assertIncludes(error.message, testCase.message, `${testCase.name} should explain the violation`);
  }
}

async function testEndpointUrlAndHeaderValidation(): Promise<void> {
  await resetFixtures();
  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig());

  const cases: ReadonlyArray<{
    readonly name: string;
    readonly endpoint: Record<string, unknown>;
    readonly fieldPath: string;
    readonly message: string;
  }> = [
    {
      name: 'non HTTP scheme',
      endpoint: endpoint({ url: 'ftp://external.example.test/route' }),
      fieldPath: 'url',
      message: 'http: or https:',
    },
    {
      name: 'non authority HTTP form',
      endpoint: endpoint({ url: 'https:external.example.test/route' }),
      fieldPath: 'url',
      message: 'http:// or https://',
    },
    {
      name: 'credentials',
      endpoint: endpoint({ url: 'https://user:password@external.example.test/route' }),
      fieldPath: 'url',
      message: 'no credentials',
    },
    {
      name: 'empty userinfo',
      endpoint: endpoint({ url: 'https://@external.example.test/route' }),
      fieldPath: 'url',
      message: 'no credentials',
    },
    {
      name: 'fragment',
      endpoint: endpoint({ url: 'https://external.example.test/route#fragment' }),
      fieldPath: 'url',
      message: 'no fragment',
    },
    {
      name: 'empty fragment',
      endpoint: endpoint({ url: 'https://external.example.test/route#' }),
      fieldPath: 'url',
      message: 'no fragment',
    },
    {
      name: 'forbidden transport owned header',
      endpoint: endpoint({ headers: { 'Content-Type': 'application/json' } }),
      fieldPath: 'headers["Content-Type"]',
      message: 'transport-owned',
    },
    {
      name: 'forbidden hop by hop header',
      endpoint: endpoint({ headers: { Connection: 'close' } }),
      fieldPath: 'headers["Connection"]',
      message: 'hop-by-hop',
    },
    {
      name: 'case insensitive duplicate headers',
      endpoint: endpoint({ headers: { Accept: 'application/json', accept: 'text/plain' } }),
      fieldPath: 'headers["accept"]',
      message: 'duplicate',
    },
    {
      name: 'invalid Node header value',
      endpoint: endpoint({ headers: { 'X-Test': 'bad\u0001value' } }),
      fieldPath: 'headers["X-Test"]',
      message: 'valid Node.js HTTP header',
    },
  ];

  for (const testCase of cases) {
    await writeJson(ENDPOINT_CONFIG_FILE, testCase.endpoint);
    const error = captureConfigError(() => loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE));
    assertEqual(error.fieldPath, testCase.fieldPath, `${testCase.name} should identify the invalid field`);
    assertIncludes(error.message, testCase.message, `${testCase.name} should explain the violation`);
  }
}

async function testBodyEncoderMediaTypeAndHeaderCrossValidation(): Promise<void> {
  await resetFixtures();
  await writeJson(ENDPOINT_CONFIG_FILE, endpoint({ headers: {} }));

  const requestEncoder = {
    strategy: 'request-to-external',
    mode: 'body-encoder',
    processor: 'codec',
    contentType: 'application/vnd.external+json; charset=utf-8',
  };
  const response = directResponse();
  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig({
    processors: [processor('codec', { executable: { resolution: 'path-search', command: 'node' } })],
    routingStrategy: [requestEncoder, response],
  }));
  const loaded = loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE);
  assertEqual(loaded.requestStrategy.mode, 'body-encoder', 'body-encoder should load with a legal media type');
  assertEqual(
    loaded.requestStrategy.mode === 'body-encoder' ? loaded.requestStrategy.contentType : undefined,
    'application/vnd.external+json; charset=utf-8',
    'The configured body media type should be retained',
  );

  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig({
    processors: [processor('codec', { executable: { resolution: 'path-search', command: 'node' } })],
    routingStrategy: [{ ...requestEncoder, contentType: 'not-a-media-type' }, response],
  }));
  let error = captureConfigError(() => loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE));
  assertEqual(error.fieldPath, 'routingStrategy[0].contentType', 'Invalid media type should identify contentType');
  assertIncludes(error.message, 'syntactically valid media type', 'Invalid media type should be explained');

  await writeJson(ENDPOINT_CONFIG_FILE, endpoint({ headers: { 'content-type': 'text/plain' } }));
  await writeJson(PROCESSOR_CONFIG_FILE, processorConfig({
    processors: [processor('codec', { executable: { resolution: 'path-search', command: 'node' } })],
    routingStrategy: [requestEncoder, response],
  }));
  error = captureConfigError(() => loadExternalRoutingSpec(PROCESSOR_CONFIG_FILE));
  assertEqual(error.fieldPath, 'headers["content-type"]', 'Static Content-Type must not compete with the request strategy');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external routing configuration loading',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'loads frozen direct/direct spec', run: testLoadsFrozenDirectDirectSpec },
      { name: 'rejects strict shells and referenced file failures', run: testStrictShellsAndReferencedFiles },
      { name: 'enforces strict strategy union and cardinality', run: testStrictStrategyUnionAndCardinality },
      { name: 'validates Processor definitions and references', run: testProcessorDefinitionsAndReferences },
      { name: 'validates endpoint URLs and headers', run: testEndpointUrlAndHeaderValidation },
      { name: 'validates body media type and header cross validation', run: testBodyEncoderMediaTypeAndHeaderCrossValidation },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
