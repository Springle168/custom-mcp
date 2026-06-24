import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  loadRuntimeConfig,
  loadRuntimeConfigWithIdentity,
} from '../../src/config.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'env-overrides');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const WORKSPACE_A_DIR = path.join(FIXTURES_DIR, 'workspace-a');
const WORKSPACE_B_DIR = path.join(FIXTURES_DIR, 'workspace-b');
const OVERRIDE_ROOT_DIR = path.join(FIXTURES_DIR, 'override-root');
const ANDROID_WORKSPACE_ROOT = path.join(FIXTURES_DIR, 'android-project');
const ANDROID_JAVA_HOME = path.join(FIXTURES_DIR, 'jbr');
const ANDROID_OVERRIDE_WORKSPACE_ROOT = path.join(FIXTURES_DIR, 'android-override-project');
const ANDROID_OVERRIDE_JAVA_HOME = path.join(FIXTURES_DIR, 'android-override-jbr');
const LOGS_DIR = path.join(FIXTURES_DIR, 'configured-logs');
const OVERRIDE_LOGS_DIR = path.join(FIXTURES_DIR, 'override-logs');
const NOT_DIRECTORY_FILE = path.join(FIXTURES_DIR, 'not-a-directory.txt');
const MISSING_DIR = path.join(FIXTURES_DIR, 'missing');

const ALL_ALLOWED_FIELDS = [
  'lineEnding',
  'logsDir',
  'android.workspaceRoot',
  'android.javaHome',
  'android.buildTimeoutMs',
  'android.maxErrorBlockChars',
  'android.maxLogTailChars',
];

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(DEFAULT_LOGS_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_A_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_B_DIR, { recursive: true });
  await fs.mkdir(OVERRIDE_ROOT_DIR, { recursive: true });
  await fs.mkdir(ANDROID_WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(ANDROID_JAVA_HOME, { recursive: true });
  await fs.mkdir(ANDROID_OVERRIDE_WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(ANDROID_OVERRIDE_JAVA_HOME, { recursive: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });
  await fs.mkdir(OVERRIDE_LOGS_DIR, { recursive: true });
  await fs.writeFile(NOT_DIRECTORY_FILE, 'not a directory', 'utf-8');
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function writeGlobalConfig(config: unknown): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    assertEqual(error.code, 'config_validation_failed', 'Env override failures should use config_validation_failed');
    return error;
  }

  throw new Error('Expected loadRuntimeConfig() to throw.');
}

function androidConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceRoot: ANDROID_WORKSPACE_ROOT,
    javaHome: ANDROID_JAVA_HOME,
    buildTimeoutMs: 900000,
    maxErrorBlockChars: 2500,
    maxLogTailChars: 4000,
    ...overrides,
  };
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
    lineEnding: 'lf',
    ...overrides,
  };
}

function globalConfig(workspaces: unknown[] = [workspace('workspace-a', WORKSPACE_A_DIR, 4701)]): Record<string, unknown> {
  return {
    version: 1,
    workspaces,
  };
}

function envValues(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MCP_ROOT_DIR: OVERRIDE_ROOT_DIR,
    MCP_PORT: '5701',
    MCP_LINE_ENDING: 'crlf',
    MCP_LOGS_DIR: OVERRIDE_LOGS_DIR,
    ANDROID_WORKSPACE_ROOT: ANDROID_OVERRIDE_WORKSPACE_ROOT,
    ANDROID_JAVA_HOME: ANDROID_OVERRIDE_JAVA_HOME,
    ANDROID_BUILD_TIMEOUT_MS: '1234',
    ANDROID_MAX_ERROR_BLOCK_CHARS: '1235',
    ANDROID_MAX_LOG_TAIL_CHARS: '1236',
    ...overrides,
  };
}

function invalidEnvValues(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MCP_ROOT_DIR: `${OVERRIDE_ROOT_DIR} `,
    MCP_PORT: '5701 ',
    MCP_LINE_ENDING: ' native ',
    MCP_LOGS_DIR: 'relative-logs',
    ANDROID_WORKSPACE_ROOT: 'relative-android-project',
    ANDROID_JAVA_HOME: '',
    ANDROID_BUILD_TIMEOUT_MS: '001',
    ANDROID_MAX_ERROR_BLOCK_CHARS: '1.5',
    ANDROID_MAX_LOG_TAIL_CHARS: `${Number.MAX_SAFE_INTEGER + 1}`,
    ...overrides,
  };
}

function assertEnvValueError(
  error: ConfigError,
  expectedFieldPath: string,
  envVar: string,
  expectedMessage: string,
  selector: string,
): void {
  assertEqual(error.fieldPath, expectedFieldPath, `${envVar} error should identify the target config field`);
  assertIncludes(error.message, envVar, `${envVar} error message should include the env var name`);
  assertIncludes(error.message, expectedMessage, `${envVar} error should explain the invalid value`);
  assertIncludes(error.suggestion, `Fix ${envVar}`, `${envVar} suggestion should point at the environment`);
  assertIncludes(error.suggestion, `remove ${selector}`, `${envVar} suggestion should mention removing the allowlist entry`);
}

async function testEnvIgnoredWhenEnvOverridesMissing(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, { android: androidConfig() }),
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-a',
    env: invalidEnvValues(),
  });

  assertEqual(snapshot.rootDir, WORKSPACE_A_DIR, 'MCP_ROOT_DIR should not affect rootDir without an allowlist');
  assertEqual(snapshot.port, 4701, 'MCP_PORT should not affect port without an allowlist');
  assertEqual(snapshot.lineEnding, 'lf', 'MCP_LINE_ENDING should not apply without envOverrides');
  assertEqual(snapshot.logsDir, path.join(HOME_DIR, '.custom-mcp', 'logs'), 'MCP_LOGS_DIR should not apply without envOverrides');
  assert(snapshot.android !== undefined, 'Fixture should include Android config');
  assertEqual(snapshot.android.workspaceRoot, path.resolve(ANDROID_WORKSPACE_ROOT), 'ANDROID_WORKSPACE_ROOT should not apply without envOverrides');
  assertEqual(snapshot.android.javaHome, path.resolve(ANDROID_JAVA_HOME), 'ANDROID_JAVA_HOME should not apply without envOverrides');
  assertEqual(snapshot.android.buildTimeoutMs, 900000, 'ANDROID_BUILD_TIMEOUT_MS should not apply without envOverrides');
}

async function testEnvIgnoredWhenAllowlistIsEmpty(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      android: androidConfig(),
      envOverrides: { allowedFields: [] },
    }),
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-a',
    env: invalidEnvValues(),
  });

  assertEqual(snapshot.lineEnding, 'lf', 'An empty allowedFields array should disable lineEnding overrides');
  assertEqual(snapshot.logsDir, path.join(HOME_DIR, '.custom-mcp', 'logs'), 'An empty allowedFields array should disable logsDir overrides');
  assert(snapshot.android !== undefined, 'Fixture should include Android config');
  assertEqual(snapshot.android.javaHome, path.resolve(ANDROID_JAVA_HOME), 'An empty allowedFields array should disable Android overrides');
  assertEqual(snapshot.android.maxLogTailChars, 4000, 'An empty allowedFields array should disable numeric Android overrides');
}

async function testUnallowlistedEnvValuesAreNotRead(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      logsDir: LOGS_DIR,
      envOverrides: { allowedFields: ['lineEnding'] },
    }),
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-a',
    env: envValues({
      MCP_LOGS_DIR: 'relative-logs',
      ANDROID_BUILD_TIMEOUT_MS: '123abc',
    }),
  });

  assertEqual(snapshot.lineEnding, 'crlf', 'The allowlisted lineEnding env should apply');
  assertEqual(snapshot.logsDir, path.resolve(LOGS_DIR), 'Unallowlisted MCP_LOGS_DIR should not be read');
}

async function testAllowlistedEnvAbsenceDoesNotOverrideConfig(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      android: androidConfig(),
      logsDir: LOGS_DIR,
      envOverrides: { allowedFields: ALL_ALLOWED_FIELDS },
    }),
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-a',
    env: {},
  });

  assertEqual(snapshot.lineEnding, 'lf', 'Missing MCP_LINE_ENDING should keep the config file value');
  assertEqual(snapshot.logsDir, path.resolve(LOGS_DIR), 'Missing MCP_LOGS_DIR should keep configured logsDir');
  assert(snapshot.android !== undefined, 'Fixture should include Android config');
  assertEqual(snapshot.android.workspaceRoot, path.resolve(ANDROID_WORKSPACE_ROOT), 'Missing ANDROID_WORKSPACE_ROOT should keep config value');
  assertEqual(snapshot.android.javaHome, path.resolve(ANDROID_JAVA_HOME), 'Missing ANDROID_JAVA_HOME should keep config value');
  assertEqual(snapshot.android.buildTimeoutMs, 900000, 'Missing numeric Android env should keep config value');
}

async function testAllowedFieldsOverrideSnapshotOnly(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      android: androidConfig(),
      logsDir: LOGS_DIR,
      envOverrides: { allowedFields: ALL_ALLOWED_FIELDS },
    }),
  ]));

  const loaded = loadRuntimeConfigWithIdentity({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-a',
    env: envValues(),
  });

  assertEqual(loaded.snapshot.rootDir, WORKSPACE_A_DIR, 'Boundary rootDir should not be overridden');
  assertEqual(loaded.snapshot.port, 4701, 'Boundary port should not be overridden');
  assertEqual(loaded.identity.rootDir, WORKSPACE_A_DIR, 'Runtime identity rootDir should stay based on config file selection');
  assertEqual(loaded.identity.port, 4701, 'Runtime identity port should stay based on config file selection');
  assertEqual(loaded.snapshot.lineEnding, 'crlf', 'Allowed MCP_LINE_ENDING should override snapshot lineEnding');
  assertEqual(loaded.snapshot.logsDir, path.resolve(OVERRIDE_LOGS_DIR), 'Allowed MCP_LOGS_DIR should override snapshot logsDir');
  assert(loaded.snapshot.android !== undefined, 'Fixture should include Android config');
  assertEqual(loaded.snapshot.android.workspaceRoot, path.resolve(ANDROID_OVERRIDE_WORKSPACE_ROOT), 'Allowed ANDROID_WORKSPACE_ROOT should override Android workspaceRoot');
  assertEqual(loaded.snapshot.android.javaHome, path.resolve(ANDROID_OVERRIDE_JAVA_HOME), 'Allowed ANDROID_JAVA_HOME should override Android javaHome');
  assertEqual(loaded.snapshot.android.buildTimeoutMs, 1234, 'Allowed ANDROID_BUILD_TIMEOUT_MS should override buildTimeoutMs');
  assertEqual(loaded.snapshot.android.maxErrorBlockChars, 1235, 'Allowed ANDROID_MAX_ERROR_BLOCK_CHARS should override maxErrorBlockChars');
  assertEqual(loaded.snapshot.android.maxLogTailChars, 1236, 'Allowed ANDROID_MAX_LOG_TAIL_CHARS should override maxLogTailChars');
}

async function testAuthorizedEnvEmptyAndWhitespaceValuesFailStartup(): Promise<void> {
  const cases = [
    {
      name: 'empty lineEnding',
      env: { MCP_LINE_ENDING: '' },
      fieldPath: 'workspaces[0].lineEnding',
      envVar: 'MCP_LINE_ENDING',
      message: 'must be a non-empty string',
      selector: 'lineEnding',
    },
    {
      name: 'whitespace-only lineEnding',
      env: { MCP_LINE_ENDING: '   ' },
      fieldPath: 'workspaces[0].lineEnding',
      envVar: 'MCP_LINE_ENDING',
      message: 'must be a non-empty string',
      selector: 'lineEnding',
    },
    {
      name: 'leading whitespace logsDir',
      env: { MCP_LOGS_DIR: ` ${OVERRIDE_LOGS_DIR}` },
      fieldPath: 'workspaces[0].logsDir',
      envVar: 'MCP_LOGS_DIR',
      message: 'must not contain leading or trailing whitespace',
      selector: 'logsDir',
    },
    {
      name: 'trailing whitespace Android path',
      env: { ANDROID_JAVA_HOME: `${ANDROID_OVERRIDE_JAVA_HOME} ` },
      fieldPath: 'workspaces[0].android.javaHome',
      envVar: 'ANDROID_JAVA_HOME',
      message: 'must not contain leading or trailing whitespace',
      selector: 'android.javaHome',
    },
    {
      name: 'empty numeric Android value',
      env: { ANDROID_BUILD_TIMEOUT_MS: '' },
      fieldPath: 'workspaces[0].android.buildTimeoutMs',
      envVar: 'ANDROID_BUILD_TIMEOUT_MS',
      message: 'must be a non-empty string',
      selector: 'android.buildTimeoutMs',
    },
  ];

  for (const testCase of cases) {
    await resetFixtures();
    await writeGlobalConfig(globalConfig([
      workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
        android: androidConfig(),
        logsDir: LOGS_DIR,
        envOverrides: { allowedFields: ALL_ALLOWED_FIELDS },
      }),
    ]));

    const error = captureConfigError(() =>
      loadRuntimeConfig({
        homeDir: HOME_DIR,
        workspaceId: 'workspace-a',
        env: envValues(testCase.env),
      })
    );

    assertEnvValueError(
      error,
      testCase.fieldPath,
      testCase.envVar,
      testCase.message,
      testCase.selector,
    );
  }
}

async function testInvalidTokenEnvValuesFailStartup(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      envOverrides: { allowedFields: ['lineEnding'] },
    }),
  ]));

  const error = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-a',
      env: envValues({ MCP_LINE_ENDING: 'native' }),
    })
  );

  assertEnvValueError(
    error,
    'workspaces[0].lineEnding',
    'MCP_LINE_ENDING',
    'must be one of: auto, lf, crlf',
    'lineEnding',
  );
}

async function testPathEnvOverridesRequireExistingDirectories(): Promise<void> {
  const cases = [
    { name: 'relative path', value: 'relative-logs', message: 'must be an absolute local path' },
    { name: 'UNC slash path', value: '//server/share/project', message: 'must be an absolute local path' },
    { name: 'namespace path', value: '\\\\?\\C:\\project', message: 'must be an absolute local path' },
    { name: 'drive-relative path', value: 'C:project', message: 'must be an absolute local path' },
    { name: 'rooted without drive path', value: '\\project', message: 'must be an absolute local path' },
    { name: 'tilde path', value: '~/project', message: 'cannot use ~ expansion' },
    { name: 'missing path', value: MISSING_DIR, message: 'does not exist or cannot be accessed' },
    { name: 'file path', value: NOT_DIRECTORY_FILE, message: 'must point to an existing directory' },
  ];

  for (const testCase of cases) {
    await resetFixtures();
    await writeGlobalConfig(globalConfig([
      workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
        logsDir: LOGS_DIR,
        envOverrides: { allowedFields: ['logsDir'] },
      }),
    ]));

    const error = captureConfigError(() =>
      loadRuntimeConfig({
        homeDir: HOME_DIR,
        workspaceId: 'workspace-a',
        env: { MCP_LOGS_DIR: testCase.value },
      })
    );

    assertEnvValueError(
      error,
      'workspaces[0].logsDir',
      'MCP_LOGS_DIR',
      testCase.message,
      'logsDir',
    );
  }
}

async function testAndroidPathEnvOverridesRequireExistingDirectories(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      android: androidConfig(),
      envOverrides: { allowedFields: ['android.workspaceRoot'] },
    }),
  ]));

  const error = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-a',
      env: { ANDROID_WORKSPACE_ROOT: NOT_DIRECTORY_FILE },
    })
  );

  assertEnvValueError(
    error,
    'workspaces[0].android.workspaceRoot',
    'ANDROID_WORKSPACE_ROOT',
    'must point to an existing directory',
    'android.workspaceRoot',
  );
}

async function testNumericEnvOverridesUseRawPositiveIntegerGrammar(): Promise<void> {
  const invalidValues = ['', '   ', ' 1234', '1234 ', '+123', '001', '1.5', '123abc', `${Number.MAX_SAFE_INTEGER + 1}`];

  for (const value of invalidValues) {
    await resetFixtures();
    await writeGlobalConfig(globalConfig([
      workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
        android: androidConfig(),
        envOverrides: { allowedFields: ['android.buildTimeoutMs'] },
      }),
    ]));

    const error = captureConfigError(() =>
      loadRuntimeConfig({
        homeDir: HOME_DIR,
        workspaceId: 'workspace-a',
        env: { ANDROID_BUILD_TIMEOUT_MS: value },
      })
    );

    assertEnvValueError(
      error,
      'workspaces[0].android.buildTimeoutMs',
      'ANDROID_BUILD_TIMEOUT_MS',
      value.trim().length === 0 ? 'must be a non-empty string' : 'must',
      'android.buildTimeoutMs',
    );
  }
}

async function testAndroidAllowlistCannotCreateMissingAndroidConfig(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      envOverrides: { allowedFields: ['android.javaHome'] },
    }),
  ]));

  const error = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-a',
      env: envValues({ ANDROID_JAVA_HOME: ANDROID_OVERRIDE_JAVA_HOME }),
    })
  );

  assertIncludes(error.message, 'android is not configured', 'Android allowlist fields should require an existing android config block');
  assertEqual(error.fieldPath, 'workspaces[0].envOverrides.allowedFields[0]', 'Missing Android config should identify the allowlist entry');
}

async function testEnvOverridesOnlySelectedWorkspace(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, { lineEnding: 'lf' }),
    workspace('workspace-b', WORKSPACE_B_DIR, 4702, {
      lineEnding: 'auto',
      envOverrides: { allowedFields: ['lineEnding'] },
    }),
  ]));

  const selectedA = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-a',
    env: { MCP_LINE_ENDING: ' native ' },
  });
  assertEqual(selectedA.workspaceId, 'workspace-a', 'Fixture should select workspace-a');
  assertEqual(selectedA.lineEnding, 'lf', 'Unselected workspace-b allowlist should not read env for workspace-a');

  const selectedB = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-b',
    env: { MCP_LINE_ENDING: 'crlf' },
  });
  assertEqual(selectedB.workspaceId, 'workspace-b', 'Fixture should select workspace-b');
  assertEqual(selectedB.lineEnding, 'crlf', 'Selected workspace-b allowlist should apply to workspace-b');
}

async function testEnvOverridesDoNotParticipateInCwdSelection(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      envOverrides: { allowedFields: ['lineEnding'] },
    }),
    workspace('workspace-b', WORKSPACE_B_DIR, 4702),
  ]));

  const loaded = loadRuntimeConfigWithIdentity({
    homeDir: HOME_DIR,
    cwd: WORKSPACE_A_DIR,
    env: envValues({
      MCP_ROOT_DIR: WORKSPACE_B_DIR,
      MCP_PORT: '4702',
      MCP_LINE_ENDING: 'crlf',
    }),
  });

  assertEqual(loaded.snapshot.workspaceId, 'workspace-a', 'Default cwd selection should use cwd/rootDir identity, not env');
  assertEqual(loaded.snapshot.rootDir, WORKSPACE_A_DIR, 'MCP_ROOT_DIR should not change selected rootDir');
  assertEqual(loaded.snapshot.port, 4701, 'MCP_PORT should not change selected port');
  assertEqual(loaded.snapshot.lineEnding, 'crlf', 'Allowed non-boundary env should still apply after selection');
  assertEqual(loaded.identity.workspaceId, 'workspace-a', 'Runtime identity should record the selected workspace');
  assertEqual(loaded.identity.rootDir, WORKSPACE_A_DIR, 'Runtime identity should not include env overrides');
  assertEqual(loaded.identity.port, 4701, 'Runtime identity port should not include env overrides');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing env override allowlist',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'env ignored when envOverrides is missing', run: testEnvIgnoredWhenEnvOverridesMissing },
      { name: 'env ignored when allowlist is empty', run: testEnvIgnoredWhenAllowlistIsEmpty },
      { name: 'unallowlisted env values are not read', run: testUnallowlistedEnvValuesAreNotRead },
      { name: 'allowlisted env absence does not override config', run: testAllowlistedEnvAbsenceDoesNotOverrideConfig },
      { name: 'allowed fields override snapshot only', run: testAllowedFieldsOverrideSnapshotOnly },
      { name: 'authorized env empty and whitespace values fail startup', run: testAuthorizedEnvEmptyAndWhitespaceValuesFailStartup },
      { name: 'invalid token env values fail startup', run: testInvalidTokenEnvValuesFailStartup },
      { name: 'path env overrides require existing directories', run: testPathEnvOverridesRequireExistingDirectories },
      { name: 'Android path env overrides require existing directories', run: testAndroidPathEnvOverridesRequireExistingDirectories },
      { name: 'numeric env overrides use raw positive integer grammar', run: testNumericEnvOverridesUseRawPositiveIntegerGrammar },
      { name: 'Android allowlist cannot create missing Android config', run: testAndroidAllowlistCannotCreateMissingAndroidConfig },
      { name: 'env overrides only selected workspace', run: testEnvOverridesOnlySelectedWorkspace },
      { name: 'env overrides do not participate in cwd selection', run: testEnvOverridesDoNotParticipateInCwdSelection },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
