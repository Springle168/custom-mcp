import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadRuntimeConfig } from '../../src/config.js';
import {
  createEmptyRuntimeRulesConfig,
  type RuntimeRulesConfig,
} from '../../src/config/request-header-rules.js';
import { createRuntimeConfigSnapshot } from '../../src/config/runtime-snapshot.js';
import { parseWorkspaceConfig } from '../../src/config/schema.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
  writeSplitConfigFixture,
} from '../test-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'request-header-rules');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const ROOTS = [path.join(FIXTURES_DIR, 'workspace-a'), path.join(FIXTURES_DIR, 'workspace-b')];
const RESULT_PATH = 'rules.requestHeaders.onCallToolResult';
const INITIALIZE_PATH = 'rules.requestHeaders.onInitialize';

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await Promise.all([LOGS_DIR, ...ROOTS].map((directory) => fs.mkdir(directory, { recursive: true })));
}

function workspace(index = 0, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 2, rootDir: ROOTS[index], port: 4901 + index, lineEnding: 'auto', ...overrides };
}

function parseConfig(overrides: Record<string, unknown> = {}) {
  return parseWorkspaceConfig(workspace(0, overrides), { configFilePath: CONFIG_FILE });
}

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { match: { 'x-client': 'android-studio' }, enable: ['structuredContentDup'], ...overrides };
}

function resultRules(rules: unknown[]): Record<string, unknown> {
  return { rules: { requestHeaders: { onCallToolResult: rules } } };
}

function initializeRules(rules: unknown[]): Record<string, unknown> {
  return { rules: { requestHeaders: { onInitialize: rules } } };
}

function expectParseError(
  overrides: Record<string, unknown>,
  fieldPath: string,
  message: string,
): ConfigError {
  try {
    parseConfig(overrides);
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    assertEqual(error.code, 'config_validation_failed', 'Rule failures should be validation errors');
    assertEqual(error.configFilePath, CONFIG_FILE, 'Errors should belong to the workspace file');
    assertEqual(error.fieldPath, fieldPath, 'Error fieldPath should identify the invalid field');
    assertIncludes(error.message, message, 'Error message should identify the schema failure');
    return error;
  }
  throw new Error('Expected config parsing to throw.');
}

async function testWorkspaceVersion(): Promise<void> {
  assertEqual(parseConfig().version, 2, 'Workspace v2 should parse');
  for (const version of [1, 0, 3, '2', null, undefined]) {
    expectParseError({ version }, 'version', 'version must be the number 2');
  }
}

async function testDefaults(): Promise<void> {
  const cases = [
    {},
    { rules: {} },
    { rules: { requestHeaders: undefined } },
    { rules: { requestHeaders: {} } },
    { rules: { requestHeaders: { onInitialize: [] } } },
    { rules: { requestHeaders: { onCallToolResult: [] } } },
    { rules: { requestHeaders: { onInitialize: [], onCallToolResult: [] } } },
  ];
  for (const overrides of cases) {
    const headers = parseConfig(overrides).rules.requestHeaders;
    assertEqual(headers.onInitialize.length, 0, 'Missing initialization stage should normalize to []');
    assertEqual(headers.onCallToolResult.length, 0, 'Missing result stage should normalize to []');
  }
  const first = createEmptyRuntimeRulesConfig();
  const second = createEmptyRuntimeRulesConfig();
  assert(first.requestHeaders !== second.requestHeaders, 'Empty rules should not share containers');
  assert(first.requestHeaders.onInitialize !== second.requestHeaders.onInitialize, 'Empty stages should not share arrays');
}

async function testShapeFailures(): Promise<void> {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ rules: null }, 'rules', 'must be a JSON object'],
    [{ rules: [] }, 'rules', 'must be a JSON object'],
    [{ rules: { unexpected: true } }, 'rules.unexpected', 'Unknown config field'],
    [{ rules: { requestHeaders: [] } }, 'rules.requestHeaders', 'must be a JSON object'],
    [{ rules: { requestHeaders: [rule()] } }, 'rules.requestHeaders', 'must be a JSON object'],
    [{ rules: { requestHeaders: null } }, 'rules.requestHeaders', 'must be a JSON object'],
    [{ rules: { requestHeaders: { unexpected: true } } }, 'rules.requestHeaders.unexpected', 'Unknown config field'],
  ];
  for (const stage of ['onInitialize', 'onCallToolResult']) {
    for (const value of [null, {}, 'rule', 42]) {
      cases.push([{ rules: { requestHeaders: { [stage]: value } } }, `rules.requestHeaders.${stage}`, 'must be an array']);
    }
    for (const value of [null, [], 'rule']) {
      cases.push([{ rules: { requestHeaders: { [stage]: [value] } } }, `rules.requestHeaders.${stage}[0]`, 'must be a JSON object']);
    }
  }
  for (const [overrides, fieldPath, message] of cases) {
    expectParseError(overrides, fieldPath, message);
  }
}

async function testInitializeRules(): Promise<void> {
  const headers = parseConfig({ rules: { requestHeaders: {
    onInitialize: [
      { readHeader: 'X-Tool-List', apply: 'setToolList' },
      { readHeader: 'X-Instructions', apply: 'setInstructions' },
    ],
    onCallToolResult: [rule({ match: { 'X-Tool-List': 'a fixed value' } })],
  } } }).rules.requestHeaders;
  assertEqual(headers.onInitialize[0]?.readHeader, 'x-tool-list', 'Initialization names should normalize');
  assertEqual(headers.onInitialize[1]?.apply, 'setInstructions', 'Both features should preserve config order');
  assertEqual(headers.onCallToolResult[0]?.match[0]?.name, 'x-tool-list', 'Stages may use the same header independently');

  const cases: Array<[unknown[], string, string]> = [
    [[{ apply: 'setToolList' }], 'readHeader', 'is required'],
    [[{ readHeader: 'x-tools' }], 'apply', 'is required'],
    [[{ readHeader: 42, apply: 'setToolList' }], 'readHeader', 'must be a string'],
    [[{ readHeader: ' x-tools', apply: 'setToolList' }], 'readHeader', 'invalid HTTP header name'],
    [[{ readHeader: '', apply: 'setToolList' }], 'readHeader', 'invalid HTTP header name'],
    [[{ readHeader: 'x-tools', apply: ['setToolList'] }], 'apply', 'must be a string'],
    [[{ readHeader: 'x-tools', apply: 'structuredContentDup' }], 'apply', 'must be one of: setToolList, setInstructions'],
    [[{ readHeader: 'x-tools', apply: 'SetToolList' }], 'apply', 'must be one of'],
    [[{ readHeader: 'x-tools', apply: ' setToolList' }], 'apply', 'must not contain leading or trailing whitespace'],
  ];
  for (const extra of ['match', 'enable', 'schema', 'default', 'example', 'unexpected']) {
    cases.push([[{ readHeader: 'x-tools', apply: 'setToolList', [extra]: {} }], extra, 'Unknown config field']);
  }
  for (const [rules, field, message] of cases) {
    expectParseError(initializeRules(rules), `${INITIALIZE_PATH}[0].${field}`, message);
  }
  expectParseError(initializeRules([
    { readHeader: 'X-Tools', apply: 'setToolList' },
    { readHeader: 'x-tools', apply: 'setInstructions' },
  ]), `${INITIALIZE_PATH}[1].readHeader`, 'duplicates header name');
  expectParseError(initializeRules([
    { readHeader: 'x-tools', apply: 'setToolList' },
    { readHeader: 'x-other-tools', apply: 'setToolList' },
  ]), `${INITIALIZE_PATH}[1].apply`, 'duplicate feature');
}

async function testResultFields(): Promise<void> {
  const cases: Array<[unknown, string, string]> = [
    [rule({ unexpected: true }), 'unexpected', 'Unknown config field'],
    [{ enable: ['structuredContentDup'] }, 'match', 'is required'],
    [{ match: { 'x-client': 'android-studio' } }, 'enable', 'is required'],
    [rule({ match: {} }), 'match', 'must be a non-empty JSON object'],
    [rule({ match: null }), 'match', 'must be a non-empty JSON object'],
    [rule({ apply: 'setToolList' }), 'apply', 'Unknown config field'],
    [rule({ enable: 'structuredContentDup' }), 'enable', 'must be a non-empty array'],
    [rule({ enable: [] }), 'enable', 'must be a non-empty array'],
    [rule({ enable: [42] }), 'enable[0]', 'must be a string'],
    [rule({ enable: [''] }), 'enable[0]', 'must be a non-empty string'],
    [rule({ enable: ['structuredContentDup '] }), 'enable[0]', 'must not contain leading or trailing whitespace'],
    [rule({ enable: ['setToolList'] }), 'enable[0]', 'must be one of: structuredContentDup'],
    [rule({ enable: ['setInstructions'] }), 'enable[0]', 'must be one of: structuredContentDup'],
    [rule({ enable: ['unknownFeature'] }), 'enable[0]', 'must be one of: structuredContentDup'],
    [rule({ enable: ['StructuredContentDup'] }), 'enable[0]', 'must be one of: structuredContentDup'],
    [rule({ enable: ['structuredContentDup', 'structuredContentDup'] }), 'enable[1]', 'duplicate feature'],
  ];
  for (const [item, field, message] of cases) {
    expectParseError(resultRules([item]), `${RESULT_PATH}[0].${field}`, message);
  }
}

async function testHeaderMatch(): Promise<void> {
  const match = parseConfig(resultRules([rule({ match: {
    'X-Client': 'android studio', 'mcp-session-id': 'session-1', 'X-Tab': 'left\tmiddle',
  } })])).rules.requestHeaders.onCallToolResult[0]?.match ?? [];
  assertEqual(match.map((condition) => condition.name).join(','), 'x-client,mcp-session-id,x-tab', 'Match names should normalize and preserve order');
  assertEqual(match[0]?.value, 'android studio', 'Internal spaces should be preserved');
  assertEqual(match[2]?.value, 'left\tmiddle', 'Internal HTAB should be preserved');
  expectParseError(resultRules([rule({ match: { 'Bad Header': 'value' } })]), `${RESULT_PATH}[0].match.Bad Header`, 'invalid HTTP header name');
  expectParseError(resultRules([rule({ match: { 'X-Client': 'one', 'x-client': 'two' } })]), `${RESULT_PATH}[0].match.x-client`, 'duplicates header name');

  const values: Array<[unknown, string]> = [
    [42, 'must be a string'], ['', 'must be a non-empty string'], ['   ', 'must be a non-empty string'],
    [' secret-value', 'must not contain leading or trailing whitespace'],
    ['secret-value ', 'must not contain leading or trailing whitespace'],
    ['secret\rvalue', 'Invalid character: U+000D'], ['secret\nvalue', 'Invalid character: U+000A'],
    ['secret\u0000value', 'Invalid character: U+0000'], ['secret\u0001value', 'Invalid character: U+0001'],
    ['secret\u007fvalue', 'Invalid character: U+007F'],
  ];
  for (const [value, message] of values) {
    const error = expectParseError(resultRules([rule({ match: { 'x-client': value } })]), `${RESULT_PATH}[0].match.x-client`, message);
    assertNotIncludes(error.message, 'secret', 'Invalid match values must not appear in diagnostics');
  }
}

async function testSelectedWorkspace(): Promise<void> {
  await writeSplitConfigFixture(CONFIG_FILE, { workspaces: [
    { id: 'workspace-0', ...workspace(0, { rules: { requestHeaders: {
      onInitialize: [{ readHeader: 'X-Instructions', apply: 'setInstructions' }],
      onCallToolResult: [rule({ match: { 'X-Client': 'workspace-a' } })],
    } } }) },
    { id: 'workspace-1', ...workspace(1, { rules: { requestHeaders: [] } }) },
  ] });
  const snapshot = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-0', env: {} });
  assertEqual(snapshot.rules.requestHeaders.onInitialize[0]?.readHeader, 'x-instructions', 'Only selected initialization rules should enter snapshot');
  assertEqual(snapshot.rules.requestHeaders.onCallToolResult[0]?.match[0]?.value, 'workspace-a', 'Only selected result rules should enter snapshot');
  try {
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-1', env: {} });
    throw new Error('Selected legacy rule array should fail.');
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Selected invalid rules should produce ConfigError');
    assertEqual(error.configFilePath, path.join(CONFIG_DIR, 'workspace-1.json'), 'Load errors should belong to the actual selected workspace file');
    assertEqual(error.fieldPath, 'rules.requestHeaders', 'Legacy array load errors should identify the rules field');
  }
}

async function testImmutableSnapshot(): Promise<void> {
  const rules = {
    requestHeaders: {
      onInitialize: [{ readHeader: 'x-tools', apply: 'setToolList' as const }],
      onCallToolResult: [{ match: [{ name: 'x-client', value: 'original' }], enable: ['structuredContentDup' as const] }],
    },
  } satisfies RuntimeRulesConfig;
  const snapshot = createRuntimeConfigSnapshot({
    globalConfigFilePath: CONFIG_FILE,
    workspaceConfigFilePath: path.join(CONFIG_DIR, 'workspace.json'),
    workspaceId: 'workspace-0', rootDir: ROOTS[0]!, otherRootDirs: [], host: '127.0.0.1', port: 4901,
    lineEnding: 'auto', logsDir: LOGS_DIR, snapshotVersion: 1, rules,
  });
  const headers = snapshot.rules.requestHeaders;
  for (const value of [snapshot.rules, headers, headers.onInitialize, headers.onInitialize[0],
    headers.onCallToolResult, headers.onCallToolResult[0], headers.onCallToolResult[0]?.match,
    headers.onCallToolResult[0]?.match[0], headers.onCallToolResult[0]?.enable]) {
    assert(Object.isFrozen(value), 'All rule objects and arrays must be frozen');
  }
  rules.requestHeaders.onInitialize[0]!.readHeader = 'x-mutated';
  rules.requestHeaders.onCallToolResult[0]!.match[0]!.value = 'mutated';
  rules.requestHeaders.onInitialize.length = 0;
  assertEqual(headers.onInitialize[0]?.readHeader, 'x-tools', 'Snapshot must not share initialization input objects');
  assertEqual(headers.onCallToolResult[0]?.match[0]?.value, 'original', 'Snapshot must not share result input conditions');
  const parsedHeaders = parseConfig(initializeRules([{ readHeader: 'x-tools', apply: 'setToolList' }])).rules.requestHeaders;
  assert(Object.isFrozen(parsedHeaders.onInitialize[0]), 'Parsed config should also freeze initialization bindings');
}

async function testForbiddenEnvOverrides(): Promise<void> {
  for (const selector of ['version', 'rules', 'rules.requestHeaders', 'rules.foo',
    'rules.requestHeaders.onInitialize', 'rules.requestHeaders.onCallToolResult']) {
    const error = expectParseError({ envOverrides: { allowedFields: [selector, 'logsDir'] } },
      'envOverrides.allowedFields[0]', `forbidden field "${selector}"`);
    assertNotIncludes(error.message, 'MCP_LOGS_DIR', 'Forbidden selectors should fail before env reading');
    await writeSplitConfigFixture(CONFIG_FILE, { workspaces: [{
      id: 'workspace-0', ...workspace(0, { envOverrides: { allowedFields: [selector, 'logsDir'] } }),
    }] });
    try {
      loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-0', env: { MCP_LOGS_DIR: '' } });
      throw new Error('Forbidden selector should fail before reading empty env value.');
    } catch (loadError: unknown) {
      assert(loadError instanceof ConfigError, 'Forbidden selector should produce ConfigError');
      assertEqual(loadError.fieldPath, 'envOverrides.allowedFields[0]', 'Schema should reject selector before env override application');
      assertNotIncludes(loadError.message, 'MCP_LOGS_DIR', 'Rejected allowlist should not inspect env values');
    }
  }
}

await runTestSuite({
  title: 'Testing two-stage request header rules config parsing',
  beforeAll: resetFixtures,
  afterAll: () => fs.rm(FIXTURES_DIR, { recursive: true, force: true }),
  tests: [
    { name: 'workspace v2 only', run: testWorkspaceVersion },
    { name: 'missing stages normalize to empty arrays', run: testDefaults },
    { name: 'strict rules and stage shapes', run: testShapeFailures },
    { name: 'initialization features and unique normalized bindings', run: testInitializeRules },
    { name: 'strict result fields and stage-specific features', run: testResultFields },
    { name: 'match header names, values and diagnostic redaction', run: testHeaderMatch },
    { name: 'only selected workspace rules are loaded', run: testSelectedWorkspace },
    { name: 'both stages are immutable and cloned in snapshots', run: testImmutableSnapshot },
    { name: 'rules and version env overrides remain forbidden', run: testForbiddenEnvOverrides },
  ],
});
