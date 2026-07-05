import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  loadRuntimeConfig,
} from '../../src/config.js';
import { parseGlobalConfig } from '../../src/config/schema.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'request-header-rules');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const WORKSPACE_A_DIR = path.join(FIXTURES_DIR, 'workspace-a');
const WORKSPACE_B_DIR = path.join(FIXTURES_DIR, 'workspace-b');
const LOGS_DIR = path.join(FIXTURES_DIR, 'logs-dir');

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(DEFAULT_LOGS_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_A_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_B_DIR, { recursive: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function writeGlobalConfig(config: unknown): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function workspace(
  index: 0 | 1,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const roots = [WORKSPACE_A_DIR, WORKSPACE_B_DIR];
  return {
    id: `workspace-${index}`,
    rootDir: roots[index],
    port: 4901 + index,
    lineEnding: 'auto',
    ...overrides,
  };
}

function globalConfig(workspaces: unknown[] = [workspace(0)]): Record<string, unknown> {
  return {
    version: 1,
    workspaces,
  };
}

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    match: { 'x-client': 'android-studio' },
    enable: ['structuredContent'],
    ...overrides,
  };
}

function parseConfig(config: unknown) {
  return parseGlobalConfig(config, { configFilePath: CONFIG_FILE });
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    assertEqual(error.code, 'config_validation_failed', 'Request header rule failures should be config validation errors');
    return error;
  }

  throw new Error('Expected config parsing to throw.');
}

async function expectParseError(
  workspaceOverrides: Record<string, unknown>,
  expectedMessage: string,
  expectedFieldPath?: string,
): Promise<ConfigError> {
  await resetFixtures();
  const error = captureConfigError(() => parseConfig(globalConfig([workspace(0, workspaceOverrides)])));

  assertIncludes(error.message, expectedMessage, 'Error message should identify the rules schema failure');
  if (expectedFieldPath !== undefined) {
    assertEqual(error.fieldPath, expectedFieldPath, 'Error fieldPath should identify the invalid rules field');
  }

  return error;
}

async function testRulesDefaultsNormalizeToEmpty(): Promise<void> {
  await resetFixtures();
  const cases = [
    {},
    { rules: {} },
    { rules: { requestHeaders: undefined } },
    { rules: { requestHeaders: [] } },
  ];

  for (const overrides of cases) {
    const parsed = parseConfig(globalConfig([workspace(0, overrides)]));
    assertEqual(parsed.workspaces[0]?.rules.requestHeaders.length, 0, 'Missing or empty rules should normalize to an empty requestHeaders array');
  }
}

async function testRulesShapeFailures(): Promise<void> {
  const cases: Array<{
    readonly overrides: Record<string, unknown>;
    readonly message: string;
    readonly fieldPath: string;
  }> = [
    { overrides: { rules: null }, message: 'must be a JSON object', fieldPath: 'workspaces[0].rules' },
    { overrides: { rules: [] }, message: 'must be a JSON object', fieldPath: 'workspaces[0].rules' },
    { overrides: { rules: { requestHeaders: {} } }, message: 'must be an array', fieldPath: 'workspaces[0].rules.requestHeaders' },
    { overrides: { rules: { requestHeaders: [null] } }, message: 'must be a JSON object', fieldPath: 'workspaces[0].rules.requestHeaders[0]' },
    { overrides: { rules: { requestHeaders: [rule({ match: null })] } }, message: 'must be a non-empty JSON object', fieldPath: 'workspaces[0].rules.requestHeaders[0].match' },
    { overrides: { rules: { requestHeaders: [rule({ enable: 'structuredContent' })] } }, message: 'must be a non-empty array', fieldPath: 'workspaces[0].rules.requestHeaders[0].enable' },
  ];

  for (const testCase of cases) {
    await expectParseError(testCase.overrides, testCase.message, testCase.fieldPath);
  }
}

async function testUnknownAndRequiredFields(): Promise<void> {
  await expectParseError(
    { rules: { unexpected: true } },
    'Unknown config field workspaces[0].rules.unexpected',
    'workspaces[0].rules.unexpected',
  );
  await expectParseError(
    { rules: { requestHeaders: [rule({ unexpected: true })] } },
    'Unknown config field workspaces[0].rules.requestHeaders[0].unexpected',
    'workspaces[0].rules.requestHeaders[0].unexpected',
  );
  await expectParseError(
    { rules: { requestHeaders: [{ enable: ['structuredContent'] }] } },
    'workspaces[0].rules.requestHeaders[0].match is required',
    'workspaces[0].rules.requestHeaders[0].match',
  );
  await expectParseError(
    { rules: { requestHeaders: [{ match: { 'x-client': 'android-studio' } }] } },
    'workspaces[0].rules.requestHeaders[0].enable is required',
    'workspaces[0].rules.requestHeaders[0].enable',
  );
  await expectParseError(
    { rules: { requestHeaders: [rule({ match: {} })] } },
    'must be a non-empty JSON object',
    'workspaces[0].rules.requestHeaders[0].match',
  );
}

async function testHeaderNamesNormalizeAndValidate(): Promise<void> {
  await resetFixtures();
  const parsed = parseConfig(globalConfig([
    workspace(0, {
      rules: {
        requestHeaders: [rule({
          match: {
            'X-Client': 'android studio',
            'mcp-session-id': 'session-1',
            'X-Internal-Space': 'left middle',
            'X-Internal-Tab': 'left\tmiddle',
          },
        })],
      },
    }),
  ]));
  const match = parsed.workspaces[0]?.rules.requestHeaders[0]?.match ?? [];

  assertEqual(match.map((condition) => condition.name).join(','), 'x-client,mcp-session-id,x-internal-space,x-internal-tab', 'Header names should be lowercased and mcp-session-id accepted normally');
  assertEqual(match[0]?.value, 'android studio', 'Internal spaces should be preserved');
  assertEqual(match[3]?.value, 'left\tmiddle', 'Internal HTAB should be preserved');

  await expectParseError(
    { rules: { requestHeaders: [rule({ match: { 'Bad Header': 'value' } })] } },
    'contains invalid HTTP header name "Bad Header"',
    'workspaces[0].rules.requestHeaders[0].match.Bad Header',
  );
  await expectParseError(
    { rules: { requestHeaders: [rule({ match: { 'X-Client': 'one', 'x-client': 'two' } })] } },
    'duplicates header name "x-client"',
    'workspaces[0].rules.requestHeaders[0].match.x-client',
  );
}

async function testHeaderValueValidationAndRedaction(): Promise<void> {
  const invalidValueCases: Array<{
    readonly value: unknown;
    readonly message: string;
  }> = [
    { value: 42, message: 'must be a string' },
    { value: '', message: 'must be a non-empty string' },
    { value: '   ', message: 'must be a non-empty string' },
    { value: ' secret-value', message: 'must not contain leading or trailing whitespace' },
    { value: 'secret-value ', message: 'must not contain leading or trailing whitespace' },
    { value: 'secret\rvalue', message: 'Invalid character: U+000D' },
    { value: 'secret\nvalue', message: 'Invalid character: U+000A' },
    { value: 'secret\u0000value', message: 'Invalid character: U+0000' },
    { value: 'secret\u0001value', message: 'Invalid character: U+0001' },
    { value: 'secret\u007fvalue', message: 'Invalid character: U+007F' },
  ];

  for (const testCase of invalidValueCases) {
    const error = await expectParseError(
      { rules: { requestHeaders: [rule({ match: { 'x-client': testCase.value } })] } },
      testCase.message,
      'workspaces[0].rules.requestHeaders[0].match.x-client',
    );

    assertNotIncludes(error.message, 'secret-value', 'Typed-string errors should not include rejected header values');
    assertNotIncludes(error.message, 'secret', 'HTTP field-value errors should not include rejected header values');
  }
}

async function testEnableValidation(): Promise<void> {
  const cases: Array<{
    readonly enable: unknown;
    readonly message: string;
    readonly fieldPath: string;
  }> = [
    { enable: [], message: 'must be a non-empty array', fieldPath: 'workspaces[0].rules.requestHeaders[0].enable' },
    { enable: [42], message: 'must be a string', fieldPath: 'workspaces[0].rules.requestHeaders[0].enable[0]' },
    { enable: [''], message: 'must be a non-empty string', fieldPath: 'workspaces[0].rules.requestHeaders[0].enable[0]' },
    { enable: ['   '], message: 'must be a non-empty string', fieldPath: 'workspaces[0].rules.requestHeaders[0].enable[0]' },
    { enable: [' structuredContent'], message: 'must not contain leading or trailing whitespace', fieldPath: 'workspaces[0].rules.requestHeaders[0].enable[0]' },
    { enable: ['structuredContent '], message: 'must not contain leading or trailing whitespace', fieldPath: 'workspaces[0].rules.requestHeaders[0].enable[0]' },
    { enable: ['unknownFeature'], message: 'must be one of: structuredContent', fieldPath: 'workspaces[0].rules.requestHeaders[0].enable[0]' },
    { enable: ['StructuredContent'], message: 'must be one of: structuredContent', fieldPath: 'workspaces[0].rules.requestHeaders[0].enable[0]' },
    { enable: ['structuredContent', 'structuredContent'], message: 'contains duplicate feature "structuredContent"', fieldPath: 'workspaces[0].rules.requestHeaders[0].enable[1]' },
  ];

  for (const testCase of cases) {
    await expectParseError(
      { rules: { requestHeaders: [rule({ enable: testCase.enable })] } },
      testCase.message,
      testCase.fieldPath,
    );
  }
}

async function testUnselectedWorkspaceInvalidRulesStillFail(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace(0),
    workspace(1, { rules: { requestHeaders: [rule({ enable: ['unknownFeature'] })] } }),
  ]));

  const error = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-0',
      env: {},
    })
  );

  assertEqual(error.fieldPath, 'workspaces[1].rules.requestHeaders[0].enable[0]', 'Unselected workspace rules should still be schema-validated');
  assertIncludes(error.message, 'must be one of: structuredContent', 'Unselected invalid feature should fail startup');
}

async function testOnlySelectedWorkspaceRulesEnterSnapshot(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace(0, {
      rules: { requestHeaders: [rule({ match: { 'x-client': 'workspace-a' } })] },
    }),
    workspace(1, {
      rules: { requestHeaders: [rule({ match: { 'X-Client': 'workspace-b' } })] },
    }),
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-1',
    env: {},
  });
  const selectedRule = snapshot.rules.requestHeaders[0];

  assertEqual(snapshot.rules.requestHeaders.length, 1, 'Snapshot should include selected workspace rules only');
  assertEqual(selectedRule?.match[0]?.name, 'x-client', 'Snapshot rule match should use lowercase header name');
  assertEqual(selectedRule?.match[0]?.value, 'workspace-b', 'Snapshot rule should come from selected workspace');
}

async function testRulesEnvOverridesAreForbiddenBeforeEnvRead(): Promise<void> {
  const selectors = ['rules', 'rules.requestHeaders', 'rules.foo', 'rules.requestHeaders.match'];

  for (const selector of selectors) {
    await resetFixtures();
    await writeGlobalConfig(globalConfig([
      workspace(0, {
        logsDir: LOGS_DIR,
        envOverrides: { allowedFields: [selector, 'logsDir'] },
      }),
    ]));

    const error = captureConfigError(() =>
      loadRuntimeConfig({
        homeDir: HOME_DIR,
        workspaceId: 'workspace-0',
        env: { MCP_LOGS_DIR: '' },
      })
    );

    assertEqual(error.fieldPath, 'workspaces[0].envOverrides.allowedFields[0]', `${selector} should fail in schema allowlist validation`);
    assertIncludes(error.message, `forbidden field "${selector}"`, `${selector} should be treated as a forbidden field`);
    assertNotIncludes(error.message, 'MCP_LOGS_DIR', 'Forbidden rules selectors should fail before reading env values');
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing request header rules config parsing',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'rules defaults normalize to empty requestHeaders', run: testRulesDefaultsNormalizeToEmpty },
      { name: 'rules shape failures', run: testRulesShapeFailures },
      { name: 'unknown and required fields', run: testUnknownAndRequiredFields },
      { name: 'header names normalize and validate', run: testHeaderNamesNormalizeAndValidate },
      { name: 'header value validation redacts values', run: testHeaderValueValidationAndRedaction },
      { name: 'enable validation', run: testEnableValidation },
      { name: 'unselected workspace invalid rules still fail', run: testUnselectedWorkspaceInvalidRulesStillFail },
      { name: 'only selected workspace rules enter snapshot', run: testOnlySelectedWorkspaceRulesEnterSnapshot },
      { name: 'rules env overrides are forbidden before env read', run: testRulesEnvOverridesAreForbiddenBeforeEnvRead },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
