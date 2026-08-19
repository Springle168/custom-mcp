import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  loadRuntimeConfig,
  type RuntimeToolExposure,
} from '../../src/config.js';
import { TOOL_NAMES } from '../../src/tools/names.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
  writeSplitConfigFixture,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'tool-exposure-config');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const WORKSPACE_A_DIR = path.join(FIXTURES_DIR, 'workspace-a');
const WORKSPACE_B_DIR = path.join(FIXTURES_DIR, 'workspace-b');
const OVERRIDE_LOGS_DIR = path.join(FIXTURES_DIR, 'override-logs');

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(DEFAULT_LOGS_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_A_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_B_DIR, { recursive: true });
  await fs.mkdir(OVERRIDE_LOGS_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function writeGlobalConfig(config: unknown): Promise<void> {
  await writeSplitConfigFixture(CONFIG_FILE, config);
}

function workspace(
  id: string,
  rootDir: string,
  port: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    rootDir,
    port,
    lineEnding: 'auto',
    ...overrides,
  };
}

function globalConfig(workspaces: unknown[]): Record<string, unknown> {
  return { version: 1, workspaces };
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    assertEqual(error.code, 'config_validation_failed', 'Tool exposure failures should use config_validation_failed');
    return error;
  }

  throw new Error('Expected loadRuntimeConfig() to throw.');
}

async function expectToolExposureError(options: {
  readonly tools: unknown;
  readonly expectedFieldPath: string;
  readonly expectedMessage: string;
}): Promise<ConfigError> {
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4901, { tools: options.tools }),
  ]));
  const error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: {} })
  );

  assertEqual(error.fieldPath, options.expectedFieldPath, 'Error should identify the exact tools field');
  assertIncludes(error.message, options.expectedMessage, 'Error should explain the tools schema failure');
  return error;
}

function assertExposure(
  actual: RuntimeToolExposure,
  expectedMode: RuntimeToolExposure['mode'],
  expectedNames: readonly string[] = [],
): void {
  assertEqual(actual.mode, expectedMode, 'Snapshot should contain the expected exposure mode');
  const actualNames = actual.mode === 'all' ? [] : actual.names;
  assertEqual(actualNames.join(','), expectedNames.join(','), 'Snapshot should preserve configured tool names');
}

async function testMissingToolsDefaultsToAll(): Promise<void> {
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4901),
  ]));

  const snapshot = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: {} });
  assertExposure(snapshot.toolExposure, 'all');
}

async function testEnabledAndDisabledParseIntoSnapshot(): Promise<void> {
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4901, {
      tools: { enabled: ['read_file', 'ask_user'] },
    }),
    workspace('workspace-b', WORKSPACE_B_DIR, 4902, {
      tools: { disabled: ['write_file', 'replace_text'] },
    }),
  ]));

  const enabled = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: {} });
  const disabled = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-b', env: {} });
  assertExposure(enabled.toolExposure, 'enable', ['read_file', 'ask_user']);
  assertExposure(disabled.toolExposure, 'disable', ['write_file', 'replace_text']);
}

async function testEmptyArraysAreValid(): Promise<void> {
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4901, { tools: { enabled: [] } }),
    workspace('workspace-b', WORKSPACE_B_DIR, 4902, { tools: { disabled: [] } }),
  ]));

  const enabled = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: {} });
  const disabled = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-b', env: {} });
  assertExposure(enabled.toolExposure, 'enable');
  assertExposure(disabled.toolExposure, 'disable');
}

async function testToolsMustBeObject(): Promise<void> {
  for (const value of [null, [], 'read_file', 42, true]) {
    await expectToolExposureError({
      tools: value,
      expectedFieldPath: 'tools',
      expectedMessage: 'must be a JSON object',
    });
  }
}

async function testExactlyOneConstraint(): Promise<void> {
  for (const tools of [{}, { enabled: ['read_file'], disabled: ['write_file'] }]) {
    const error = await expectToolExposureError({
      tools,
      expectedFieldPath: 'tools',
      expectedMessage: 'exactly one of enabled or disabled',
    });
    assertIncludes(error.message, 'only enabled or only disabled', 'Exactly-one error should state the valid alternatives');
  }
}

async function testUnknownToolObjectFieldFailsFirst(): Promise<void> {
  await expectToolExposureError({
    tools: { foo: [], enabled: ['read_file'] },
    expectedFieldPath: 'tools.foo',
    expectedMessage: 'Unknown config field',
  });
}

async function testLegacyAllowedFieldIsRejected(): Promise<void> {
  const error = await expectToolExposureError({
    tools: { allowed: ['read_file'] },
    expectedFieldPath: 'tools.allowed',
    expectedMessage: 'Unknown config field',
  });
  assertIncludes(error.message, 'Only enabled and disabled are supported', 'Legacy allowed field should name the supported fields');
}

async function testSelectedListMustBeArray(): Promise<void> {
  await expectToolExposureError({
    tools: { enabled: 'read_file' },
    expectedFieldPath: 'tools.enabled',
    expectedMessage: 'must be an array',
  });
  await expectToolExposureError({
    tools: { disabled: {} },
    expectedFieldPath: 'tools.disabled',
    expectedMessage: 'must be an array',
  });
}

async function testEntryTypedStringValidation(): Promise<void> {
  const cases = [
    { value: 42, message: 'must be a string' },
    { value: '', message: 'must be a non-empty string' },
    { value: '   ', message: 'must be a non-empty string' },
    { value: ' read_file', message: 'must not contain leading or trailing whitespace' },
    { value: 'read_file ', message: 'must not contain leading or trailing whitespace' },
  ];

  for (const testCase of cases) {
    await expectToolExposureError({
      tools: { enabled: [testCase.value] },
      expectedFieldPath: 'tools.enabled[0]',
      expectedMessage: testCase.message,
    });
  }
}

async function testUnknownToolNamesReportCanonicalDirectory(): Promise<void> {
  for (const name of ['READ_FILE', 'android_assembleDebug', 'mcp__custom_mcp__android.assembleDebug']) {
    const error = await expectToolExposureError({
      tools: { enabled: [name] },
      expectedFieldPath: 'tools.enabled[0]',
      expectedMessage: `Unknown tool name "${name}"`,
    });
    assertIncludes(
      error.message,
      TOOL_NAMES.join(', '),
      'Unknown tool error should list every valid name in canonical order',
    );
  }
}

async function testDuplicateUsesSecondEntryPath(): Promise<void> {
  const error = await expectToolExposureError({
    tools: { disabled: ['read_file', 'read_file'] },
    expectedFieldPath: 'tools.disabled[1]',
    expectedMessage: 'Duplicate tool name "read_file"',
  });
  assertIncludes(error.message, 'read_file', 'Duplicate error should include the repeated name');
}

async function testEntryValidationIsFailFastInArrayOrder(): Promise<void> {
  await expectToolExposureError({
    tools: { enabled: ['read_file', 'read_file', 42] },
    expectedFieldPath: 'tools.enabled[1]',
    expectedMessage: 'Duplicate tool name "read_file"',
  });
  await expectToolExposureError({
    tools: { enabled: ['read_file', 'unknown_tool', 'read_file'] },
    expectedFieldPath: 'tools.enabled[1]',
    expectedMessage: 'Unknown tool name "unknown_tool"',
  });
}

async function testUnselectedWorkspaceToolsAreNotValidated(): Promise<void> {
  const cases = [
    { tools: {}, path: 'workspaces[1].tools', message: 'exactly one of enabled or disabled' },
    { tools: { enabled: ['unknown_tool'] }, path: 'workspaces[1].tools.enabled[0]', message: 'Unknown tool name' },
    { tools: { disabled: ['read_file', 'read_file'] }, path: 'workspaces[1].tools.disabled[1]', message: 'Duplicate tool name' },
  ];

  for (const testCase of cases) {
    await writeGlobalConfig(globalConfig([
      workspace('workspace-a', WORKSPACE_A_DIR, 4901),
      workspace('workspace-b', WORKSPACE_B_DIR, 4902, { tools: testCase.tools }),
    ]));
    const snapshot = loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-a',
      env: {},
    });
    assertExposure(snapshot.toolExposure, 'all');
  }
}

async function testOnlySelectedWorkspaceExposureEntersSnapshot(): Promise<void> {
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4901, { tools: { enabled: ['read_file'] } }),
    workspace('workspace-b', WORKSPACE_B_DIR, 4902, { tools: { disabled: ['ask_user'] } }),
  ]));

  const snapshot = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-b', env: {} });
  assertExposure(snapshot.toolExposure, 'disable', ['ask_user']);
}

async function testLegalEnvOverridesPreserveExposure(): Promise<void> {
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4901, {
      lineEnding: 'lf',
      tools: { enabled: ['read_file', 'ask_user'] },
      envOverrides: { allowedFields: ['lineEnding', 'logsDir'] },
    }),
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-a',
    env: {
      MCP_LINE_ENDING: 'crlf',
      MCP_LOGS_DIR: OVERRIDE_LOGS_DIR,
    },
  });
  assertEqual(snapshot.lineEnding, 'crlf', 'Legal lineEnding override should still apply');
  assertEqual(snapshot.logsDir, path.resolve(OVERRIDE_LOGS_DIR), 'Legal logsDir override should still apply');
  assertExposure(snapshot.toolExposure, 'enable', ['read_file', 'ask_user']);
}

async function testToolSelectorsAreForbiddenBeforeEnvRead(): Promise<void> {
  const selectors = ['tools', 'tools.enabled', 'tools.disabled', 'tools.foo', 'tools.enabled.foo'];

  for (const selector of selectors) {
    await writeGlobalConfig(globalConfig([
      workspace('workspace-a', WORKSPACE_A_DIR, 4901, {
        envOverrides: { allowedFields: [selector, 'logsDir'] },
      }),
    ]));
    const error = captureConfigError(() =>
      loadRuntimeConfig({
        homeDir: HOME_DIR,
        workspaceId: 'workspace-a',
        env: { MCP_LOGS_DIR: 'relative-invalid-logs-dir' },
      })
    );
    assertEqual(
      error.fieldPath,
      'envOverrides.allowedFields[0]',
      'Forbidden tool selector should fail at its allowlist entry before env values are read',
    );
    assertIncludes(error.message, `forbidden field "${selector}"`, 'Forbidden selector error should include the selector');
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing workspace tool exposure configuration',
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'missing tools defaults to all', run: testMissingToolsDefaultsToAll },
      { name: 'enabled and disabled parse into snapshots', run: testEnabledAndDisabledParseIntoSnapshot },
      { name: 'empty arrays are valid', run: testEmptyArraysAreValid },
      { name: 'tools must be an object', run: testToolsMustBeObject },
      { name: 'tools enforces exactly one list', run: testExactlyOneConstraint },
      { name: 'unknown tools object field fails first', run: testUnknownToolObjectFieldFailsFirst },
      { name: 'legacy allowed field is rejected', run: testLegacyAllowedFieldIsRejected },
      { name: 'selected list must be an array', run: testSelectedListMustBeArray },
      { name: 'entries use typed string validation', run: testEntryTypedStringValidation },
      { name: 'unknown names report canonical directory', run: testUnknownToolNamesReportCanonicalDirectory },
      { name: 'duplicate uses second entry path', run: testDuplicateUsesSecondEntryPath },
      { name: 'entry validation is fail-fast', run: testEntryValidationIsFailFastInArrayOrder },
      { name: 'unselected workspace tools are not validated', run: testUnselectedWorkspaceToolsAreNotValidated },
      { name: 'only selected workspace exposure enters snapshot', run: testOnlySelectedWorkspaceExposureEntersSnapshot },
      { name: 'legal env overrides preserve exposure', run: testLegalEnvOverridesPreserveExposure },
      { name: 'tool selectors are forbidden before env read', run: testToolSelectorsAreForbiddenBeforeEnvRead },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
