import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../src/config/errors.js';
import { loadCustomToolConfig } from '../../src/tools/custom-tool-config.js';
import { assert, assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'custom-tool-config');
const TOOL_CONFIG_FILE = path.join(FIXTURES_DIR, 'tool-config.json');
const FIRST_DEFINITION_FILE = path.join(FIXTURES_DIR, 'first-definition.json');
const SECOND_DEFINITION_FILE = path.join(FIXTURES_DIR, 'second-definition.json');
const EXTERNAL_ROUTING_CONFIG_FILE = path.join(FIXTURES_DIR, 'external-routing-config.json');
const ENDPOINT_CONFIG_FILE = path.join(FIXTURES_DIR, 'endpoint-config.json');
const NO_BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set();

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function writeBomJson(filePath: string, value: unknown): Promise<void> {
  const json = Buffer.from(JSON.stringify(value, null, 2), 'utf-8');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json]));
}

async function writeDoubleBomJson(filePath: string, value: unknown): Promise<void> {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const json = Buffer.from(JSON.stringify(value, null, 2), 'utf-8');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.concat([bom, bom, json]));
}

function reference(id: string, toolDefinitionFile: string): Record<string, unknown> {
  return { id, toolDefinitionFile };
}

function toolConfig(
  definitions: unknown[] = [reference('first', FIRST_DEFINITION_FILE)],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { version: 2, definitions, ...overrides };
}

function definition(
  name = 'custom.tool',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    description: 'A custom tool.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    ...overrides,
  };
}

function directRoutingStrategy(): Record<string, unknown> {
  return {
    'request-to-external': [{ mode: 'direct' }],
    'response-from-external': [{ mode: 'direct' }],
  };
}

function externalRoutingConfig(
  routes: unknown[] = [
    {
      definitionId: 'external-reference',
      routingMode: 'http',
      httpEndpointConfigFile: ENDPOINT_CONFIG_FILE,
      routingStrategy: directRoutingStrategy(),
    },
  ],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { version: 2, routes, ...overrides };
}

function externalEndpointConfig(): Record<string, unknown> {
  return {
    version: 1,
    url: 'https://external.example.test/tool-calls',
    timeoutMs: 30_000,
    headers: {},
  };
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    return error;
  }
  throw new Error('Expected custom tool config loading to fail.');
}

async function testLoadsOrderedFrozenDefinitionsAndStableValidators(): Promise<void> {
  await resetFixtures();
  const firstSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    $defs: {
      nonEmpty: { type: 'string', minLength: 1 },
    },
    properties: {
      value: { $ref: '#/$defs/nonEmpty' },
      optional: { type: 'string', default: 'not-injected' },
      emptyList: { type: 'array', items: false, maxItems: 0 },
      formatted: { type: 'string', format: 'workspace-private-format' },
    },
    required: ['value'],
    additionalProperties: false,
    'x-workspace-annotation': true,
  };
  await writeBomJson(
    FIRST_DEFINITION_FILE,
    definition('first.tool', {
      description: '  Description whitespace is preserved.  ',
      inputSchema: firstSchema,
    }),
  );
  await writeJson(SECOND_DEFINITION_FILE, definition('second-tool'));
  await writeBomJson(
    TOOL_CONFIG_FILE,
    toolConfig([
      reference('first-ref', FIRST_DEFINITION_FILE),
      reference('second-ref', SECOND_DEFINITION_FILE),
    ]),
  );

  const loaded = loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES);
  assertEqual(loaded.definitions.length, 2, 'All references should load');
  assertEqual(
    loaded.definitions[0]?.definition.name,
    'first.tool',
    'Reference order should be retained',
  );
  assertEqual(
    loaded.definitions[1]?.definition.name,
    'second-tool',
    'Second definition should retain its order',
  );
  assertEqual(
    loaded.definitions[0]?.definition.description,
    '  Description whitespace is preserved.  ',
    'Description content should be preserved exactly',
  );
  assertEqual(
    loaded.definitions[0]?.source.referenceId,
    'first-ref',
    'Source should retain reference id',
  );
  assertEqual(
    loaded.definitions[0]?.source.toolDefinitionFilePath,
    FIRST_DEFINITION_FILE,
    'Source should retain the actual definition file',
  );
  assertEqual(
    loaded.definitions[1]?.source.definitionIndex,
    1,
    'Source should retain config order index',
  );
  assertEqual(
    loaded.externalRouting,
    undefined,
    'External routing should remain disabled when its v2 field is absent',
  );

  assert(Object.isFrozen(loaded), 'Loaded config should be frozen');
  assert(Object.isFrozen(loaded.definitions), 'Definition collection should be frozen');
  const first = loaded.definitions[0];
  assert(first !== undefined, 'First compiled definition should exist');
  assert(Object.isFrozen(first), 'Compiled definition entry should be frozen');
  assert(Object.isFrozen(first.definition), 'Definition should be frozen');
  assert(Object.isFrozen(first.definition.inputSchema), 'Input schema root should be frozen');
  assert(
    Object.isFrozen(first.definition.inputSchema.properties),
    'Nested schema values should be frozen',
  );
  assert(Object.isFrozen(first.source), 'Source metadata should be frozen');
  assert(Object.isFrozen(first.validator), 'Validator facade should be frozen');

  const validPayload: Record<string, unknown> = {
    value: 'ok',
    emptyList: [],
    formatted: 'format-is-not-enforced',
  };
  const validResult = first.validator.validate(validPayload);
  assert(validResult.valid, 'Document-local refs and ignored formats should validate');
  assert(!('optional' in validPayload), 'Schema defaults must not be injected');

  const invalidPayload: Record<string, unknown> = { value: 7, unknown: 'retained' };
  const beforeValidation = JSON.stringify(invalidPayload);
  const invalidResult = first.validator.validate(invalidPayload);
  assert(!invalidResult.valid, 'Type coercion and additional properties should not be accepted');
  assertEqual(
    JSON.stringify(invalidPayload),
    beforeValidation,
    'Validation must not coerce values or remove additional properties',
  );
  assert(
    invalidResult.errors.length >= 2,
    'allErrors should return actionable type and property issues',
  );
  const copiedErrors = JSON.stringify(invalidResult.errors);
  first.validator.validate({ value: 'later-call' });
  assertEqual(
    JSON.stringify(invalidResult.errors),
    copiedErrors,
    'A later validation must not mutate an earlier error result',
  );
  assert(Object.isFrozen(invalidResult), 'Invalid result should be frozen');
  assert(Object.isFrozen(invalidResult.errors), 'Copied error array should be frozen');
  assert(Object.isFrozen(invalidResult.errors[0]), 'Copied issues should be frozen');
  assert(Object.isFrozen(invalidResult.errors[0]?.params), 'Copied issue params should be frozen');
}

async function testAcceptsEmptyDefinitionsAndRejectsV2ConfigShell(): Promise<void> {
  await resetFixtures();
  await writeJson(TOOL_CONFIG_FILE, toolConfig([]));
  const empty = loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES);
  assertEqual(empty.definitions.length, 0, 'Version 2 should allow an empty definitions array');
  assertEqual(
    empty.externalRouting,
    undefined,
    'Empty Tool config should not create external routing',
  );

  await writeJson(TOOL_CONFIG_FILE, toolConfig([], { unknown: true }));
  let error = captureConfigError(() =>
    loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES),
  );
  assertEqual(
    error.configFilePath,
    TOOL_CONFIG_FILE,
    'Tool config shell errors should belong to Tool config',
  );
  assertEqual(error.fieldPath, 'unknown', 'Unknown top-level fields should identify the field');

  await writeJson(TOOL_CONFIG_FILE, toolConfig([], { version: 1 }));
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertEqual(error.fieldPath, 'version', 'Tool config must only accept version 2');

  await writeJson(
    TOOL_CONFIG_FILE,
    toolConfig([], {
      processorConfigFile: path.join(FIXTURES_DIR, 'legacy-processor-config.json'),
    }),
  );
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertEqual(
    error.fieldPath,
    'processorConfigFile',
    'The legacy processorConfigFile entry must be rejected as unknown',
  );
  assertIncludes(
    error.message,
    'Unknown tool config field',
    'Legacy entry rejection should explain the v2 shell boundary',
  );

  await writeJson(
    TOOL_CONFIG_FILE,
    toolConfig([], {
      externalRoutingConfigFile: 'relative-external-routing-config.json',
    }),
  );
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertEqual(
    error.configFilePath,
    TOOL_CONFIG_FILE,
    'External routing path lexical errors belong to Tool config',
  );
  assertEqual(
    error.fieldPath,
    'externalRoutingConfigFile',
    'External routing path errors identify the v2 field',
  );
  assertIncludes(
    error.message,
    'absolute local path',
    'External routing config path should reuse local absolute path policy',
  );

  await writeJson(
    TOOL_CONFIG_FILE,
    toolConfig([
      reference('duplicate', FIRST_DEFINITION_FILE),
      reference('duplicate', SECOND_DEFINITION_FILE),
    ]),
  );
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertEqual(error.fieldPath, 'definitions[1].id', 'Duplicate ids should identify the later id');
  assertIncludes(error.message, 'must be unique', 'Duplicate id should be actionable');

  await writeJson(TOOL_CONFIG_FILE, toolConfig([reference('bad path', FIRST_DEFINITION_FILE)]));
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertEqual(error.fieldPath, 'definitions[0].id', 'Reference id grammar should be strict');

  await writeJson(
    TOOL_CONFIG_FILE,
    toolConfig([reference('relative', 'relative-definition.json')]),
  );
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertEqual(
    error.configFilePath,
    TOOL_CONFIG_FILE,
    'Lexical definition path errors belong to Tool config',
  );
  assertEqual(
    error.fieldPath,
    'definitions[0].toolDefinitionFile',
    'Lexical path errors identify the reference field',
  );
  assertIncludes(
    error.message,
    'absolute local path',
    'Definition paths should reuse local absolute path policy',
  );
}

async function testRejectsStrictDefinitionShellAndProtocolShape(): Promise<void> {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly value: Record<string, unknown>;
    readonly fieldPath: string;
    readonly message: string;
  }> = [
    {
      name: 'unknown outer field',
      value: definition('strict.tool', { title: 'Not accepted' }),
      fieldPath: 'title',
      message: 'Unknown Tool definition field',
    },
    {
      name: 'invalid Tool name',
      value: definition('contains spaces'),
      fieldPath: 'name',
      message: 'must match',
    },
    {
      name: 'blank description',
      value: definition('blank-description', { description: ' \t\n ' }),
      fieldPath: 'description',
      message: 'non-whitespace',
    },
    {
      name: 'boolean root schema',
      value: definition('boolean-root', { inputSchema: true }),
      fieldPath: 'inputSchema',
      message: 'JSON object',
    },
    {
      name: 'missing object root type',
      value: definition('missing-root-type', { inputSchema: { properties: {} } }),
      fieldPath: 'inputSchema.type',
      message: 'exactly the string "object"',
    },
    {
      name: 'wrong explicit dialect',
      value: definition('wrong-dialect', {
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
        },
      }),
      fieldPath: 'inputSchema.$schema',
      message: 'draft/2020-12',
    },
    {
      name: 'boolean direct property schema',
      value: definition('boolean-property', {
        inputSchema: { type: 'object', properties: { rejected: false } },
      }),
      fieldPath: 'inputSchema.properties["rejected"]',
      message: 'JSON object form',
    },
  ];

  for (const testCase of cases) {
    await resetFixtures();
    await writeJson(
      TOOL_CONFIG_FILE,
      toolConfig([reference('diagnostic-ref', FIRST_DEFINITION_FILE)]),
    );
    await writeJson(FIRST_DEFINITION_FILE, testCase.value);

    const error = captureConfigError(() =>
      loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES),
    );
    assertEqual(
      error.configFilePath,
      FIRST_DEFINITION_FILE,
      `${testCase.name} should belong to definition file`,
    );
    assertEqual(
      error.fieldPath,
      testCase.fieldPath,
      `${testCase.name} should identify its definition field`,
    );
    assertIncludes(error.message, testCase.message, `${testCase.name} should explain the failure`);
    assertIncludes(
      error.message,
      'diagnostic-ref',
      `${testCase.name} should identify its reference id`,
    );
  }
}

async function testCompilesSchemasInIsolatedResolverContexts(): Promise<void> {
  await resetFixtures();
  const sharedId = 'https://schemas.example.test/shared';
  await writeJson(
    FIRST_DEFINITION_FILE,
    definition('publisher', {
      inputSchema: {
        $id: sharedId,
        type: 'object',
        properties: { value: { type: 'string' } },
      },
    }),
  );
  await writeJson(
    SECOND_DEFINITION_FILE,
    definition('consumer', {
      inputSchema: {
        type: 'object',
        properties: { value: { $ref: sharedId } },
      },
    }),
  );
  await writeJson(
    TOOL_CONFIG_FILE,
    toolConfig([
      reference('publisher-ref', FIRST_DEFINITION_FILE),
      reference('consumer-ref', SECOND_DEFINITION_FILE),
    ]),
  );

  let error = captureConfigError(() =>
    loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES),
  );
  assertEqual(
    error.configFilePath,
    SECOND_DEFINITION_FILE,
    'Cross-document ref should fail on consumer file',
  );
  assertEqual(error.fieldPath, 'inputSchema', 'Compilation errors should identify inputSchema');
  assertIncludes(
    error.message,
    'consumer-ref',
    'Compilation errors should retain reference identity',
  );
  assertIncludes(
    error.message,
    'compile',
    'External dependency failure should be described as compilation failure',
  );

  await writeJson(
    TOOL_CONFIG_FILE,
    toolConfig([reference('invalid-schema-ref', FIRST_DEFINITION_FILE)]),
  );
  await writeJson(
    FIRST_DEFINITION_FILE,
    definition('invalid-schema', {
      inputSchema: { type: 'object', required: 'value' },
    }),
  );
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertEqual(
    error.configFilePath,
    FIRST_DEFINITION_FILE,
    'Invalid JSON Schema should belong to definition file',
  );
  assertEqual(error.fieldPath, 'inputSchema', 'Invalid JSON Schema should identify inputSchema');
  assertIncludes(
    error.message,
    'invalid-schema-ref',
    'Invalid schema should identify reference id',
  );

  await writeJson(
    FIRST_DEFINITION_FILE,
    definition('async-schema', {
      inputSchema: { type: 'object', $async: true },
    }),
  );
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertIncludes(error.message, 'Asynchronous', 'Async validators should be rejected at startup');
}

async function testReferencedDefinitionFailuresUseActualFileAndReferenceId(): Promise<void> {
  await resetFixtures();
  await writeJson(TOOL_CONFIG_FILE, toolConfig([reference('missing-ref', FIRST_DEFINITION_FILE)]));

  let error = captureConfigError(() =>
    loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES),
  );
  assertEqual(
    error.code,
    'config_file_not_found',
    'Missing definition should use file-not-found code',
  );
  assertEqual(
    error.configFilePath,
    FIRST_DEFINITION_FILE,
    'Missing definition should point to actual target',
  );
  assertIncludes(error.message, 'missing-ref', 'Missing definition should retain reference id');

  await fs.writeFile(FIRST_DEFINITION_FILE, Buffer.from([0xc3, 0x28]));
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertEqual(error.code, 'config_file_read_failed', 'Invalid UTF-8 should fail during reading');
  assertEqual(
    error.configFilePath,
    FIRST_DEFINITION_FILE,
    'UTF-8 failure should point to definition file',
  );
  assertIncludes(error.message, 'valid UTF-8', 'UTF-8 decoding should fail closed');
  assertIncludes(error.message, 'missing-ref', 'UTF-8 failure should retain reference id');

  await fs.writeFile(FIRST_DEFINITION_FILE, '{ invalid json', 'utf-8');
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertEqual(error.code, 'config_json_invalid', 'Malformed definition JSON should use JSON code');
  assertEqual(
    error.configFilePath,
    FIRST_DEFINITION_FILE,
    'JSON failure should point to definition file',
  );
  assertIncludes(error.message, 'missing-ref', 'JSON failure should retain reference id');

  await fs.rm(FIRST_DEFINITION_FILE, { force: true });
  await fs.mkdir(FIRST_DEFINITION_FILE);
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertEqual(
    error.configFilePath,
    FIRST_DEFINITION_FILE,
    'Non-file target should point to actual path',
  );
  assertIncludes(
    error.message,
    'regular file',
    'Directories should not satisfy referenced file policy',
  );
  assertIncludes(error.message, 'missing-ref', 'Regular-file failure should retain reference id');
}

async function testRejectsDoubleBomJson(): Promise<void> {
  await resetFixtures();
  await writeJson(FIRST_DEFINITION_FILE, definition());
  await writeDoubleBomJson(TOOL_CONFIG_FILE, toolConfig());

  let error = captureConfigError(() =>
    loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES),
  );
  assertEqual(error.code, 'config_json_invalid', 'A second Tool config BOM should be JSON content');
  assertEqual(
    error.configFilePath,
    TOOL_CONFIG_FILE,
    'Double-BOM Tool config failure should identify its file',
  );

  await writeJson(TOOL_CONFIG_FILE, toolConfig());
  await writeDoubleBomJson(FIRST_DEFINITION_FILE, definition());
  error = captureConfigError(() => loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES));
  assertEqual(error.code, 'config_json_invalid', 'A second definition BOM should be JSON content');
  assertEqual(
    error.configFilePath,
    FIRST_DEFINITION_FILE,
    'Double-BOM definition failure should identify its file',
  );
}

async function testRejectsDuplicateCustomNamesAtToolConfigBoundary(): Promise<void> {
  await resetFixtures();
  await writeJson(FIRST_DEFINITION_FILE, definition('same-name'));
  await writeJson(SECOND_DEFINITION_FILE, definition('same-name'));
  await writeJson(
    TOOL_CONFIG_FILE,
    toolConfig([
      reference('first-identity', FIRST_DEFINITION_FILE),
      reference('second-identity', SECOND_DEFINITION_FILE),
    ]),
  );

  const error = captureConfigError(() =>
    loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES),
  );
  assertEqual(
    error.configFilePath,
    TOOL_CONFIG_FILE,
    'Duplicate names are a Tool config relationship error',
  );
  assertEqual(
    error.fieldPath,
    'definitions[1].toolDefinitionFile',
    'Duplicate name should identify the later conflicting reference',
  );
  assertIncludes(error.message, 'same-name', 'Duplicate error should identify Tool name');
  assertIncludes(
    error.message,
    'first-identity',
    'Duplicate error should identify first reference',
  );
  assertIncludes(
    error.message,
    'second-identity',
    'Duplicate error should identify second reference',
  );
}

async function testLoadsExternalRoutingConfigFromV2ToolConfig(): Promise<void> {
  await resetFixtures();
  await writeJson(FIRST_DEFINITION_FILE, definition('external.custom'));
  await writeJson(ENDPOINT_CONFIG_FILE, externalEndpointConfig());
  await writeJson(EXTERNAL_ROUTING_CONFIG_FILE, externalRoutingConfig());
  await writeJson(
    TOOL_CONFIG_FILE,
    toolConfig([reference('external-reference', FIRST_DEFINITION_FILE)], {
      externalRoutingConfigFile: EXTERNAL_ROUTING_CONFIG_FILE,
    }),
  );

  const loaded = loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES);
  const externalRouting = loaded.externalRouting;
  const compiledRoute = externalRouting?.routesByDefinitionId.get('external-reference');
  assert(externalRouting !== undefined, 'externalRoutingConfigFile should load external routing');
  assertEqual(
    externalRouting.configFilePath,
    EXTERNAL_ROUTING_CONFIG_FILE,
    'External routing config source should be retained',
  );
  assertEqual(
    externalRouting.routes[0],
    compiledRoute,
    'Ordered routes and binding lookup should share the compiled route',
  );
  assertEqual(
    compiledRoute?.toolName,
    'external.custom',
    'Route should bind by definition reference id',
  );
  assertEqual(compiledRoute?.routingMode, 'http', 'Route should retain its HTTP mode');
  assert(compiledRoute?.routingMode === 'http', 'Expected a compiled HTTP route');
  assertEqual(
    compiledRoute.endpointConfigFilePath,
    ENDPOINT_CONFIG_FILE,
    'Route should retain its endpoint source',
  );
  assertEqual(
    compiledRoute.endpoint.url,
    'https://external.example.test/tool-calls',
    'Route endpoint should be compiled',
  );
  assert(Object.isFrozen(externalRouting), 'Compiled external routing should be immutable');
  assert(Object.isFrozen(compiledRoute), 'Compiled route should be immutable');

  await fs.rm(EXTERNAL_ROUTING_CONFIG_FILE, { force: true });
  const error = captureConfigError(() =>
    loadCustomToolConfig(TOOL_CONFIG_FILE, NO_BUILT_IN_TOOL_NAMES),
  );
  assertEqual(
    error.code,
    'config_file_not_found',
    'Missing external routing config should retain referenced-file error code',
  );
  assertEqual(
    error.configFilePath,
    EXTERNAL_ROUTING_CONFIG_FILE,
    'Missing external routing config should identify its actual file',
  );
}

async function testRejectsExternalRouteForBuiltInOverride(): Promise<void> {
  await resetFixtures();
  await writeJson(FIRST_DEFINITION_FILE, definition('read_file'));
  await writeJson(ENDPOINT_CONFIG_FILE, externalEndpointConfig());
  await writeJson(
    EXTERNAL_ROUTING_CONFIG_FILE,
    externalRoutingConfig([
      {
        definitionId: 'read-file-override',
        routingMode: 'http',
        httpEndpointConfigFile: ENDPOINT_CONFIG_FILE,
        routingStrategy: directRoutingStrategy(),
      },
    ]),
  );
  await writeJson(
    TOOL_CONFIG_FILE,
    toolConfig([reference('read-file-override', FIRST_DEFINITION_FILE)], {
      externalRoutingConfigFile: EXTERNAL_ROUTING_CONFIG_FILE,
    }),
  );

  const error = captureConfigError(() =>
    loadCustomToolConfig(TOOL_CONFIG_FILE, new Set(['read_file'])),
  );
  assertEqual(
    error.configFilePath,
    EXTERNAL_ROUTING_CONFIG_FILE,
    'Built-in binding rejection belongs to external routing config',
  );
  assertEqual(
    error.fieldPath,
    'routes[0].definitionId',
    'Built-in binding rejection should identify definitionId',
  );
  assertIncludes(
    error.message,
    'custom-only',
    'Built-in binding rejection should preserve the built-in executor boundary',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing custom Tool config loading and input schema validators',
    afterAll: cleanupFixtures,
    tests: [
      {
        name: 'loads ordered frozen definitions and stable validators',
        run: testLoadsOrderedFrozenDefinitionsAndStableValidators,
      },
      {
        name: 'accepts empty definitions and rejects strict v2 config shell',
        run: testAcceptsEmptyDefinitionsAndRejectsV2ConfigShell,
      },
      {
        name: 'rejects strict definition shell and protocol shape',
        run: testRejectsStrictDefinitionShellAndProtocolShape,
      },
      {
        name: 'compiles schemas in isolated resolver contexts',
        run: testCompilesSchemasInIsolatedResolverContexts,
      },
      {
        name: 'referenced definition failures use actual file and reference id',
        run: testReferencedDefinitionFailuresUseActualFileAndReferenceId,
      },
      { name: 'rejects double-BOM JSON documents', run: testRejectsDoubleBomJson },
      {
        name: 'rejects duplicate custom names at Tool config boundary',
        run: testRejectsDuplicateCustomNamesAtToolConfigBoundary,
      },
      {
        name: 'loads external routing config from v2 Tool config',
        run: testLoadsExternalRoutingConfigFromV2ToolConfig,
      },
      {
        name: 'rejects external route for built-in override',
        run: testRejectsExternalRouteForBuiltInOverride,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
