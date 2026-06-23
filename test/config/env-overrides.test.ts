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
const WORKSPACE_A_DIR = path.join(FIXTURES_DIR, 'workspace-a');
const WORKSPACE_B_DIR = path.join(FIXTURES_DIR, 'workspace-b');
const OVERRIDE_ROOT_DIR = path.join(FIXTURES_DIR, 'override-root');
const ANDROID_WORKSPACE_ROOT = path.join(FIXTURES_DIR, 'android-project');
const ANDROID_JAVA_HOME = path.join(FIXTURES_DIR, 'jbr');
const ANDROID_OVERRIDE_WORKSPACE_ROOT = path.join(FIXTURES_DIR, 'android-override-project');
const ANDROID_OVERRIDE_JAVA_HOME = path.join(FIXTURES_DIR, 'android-override-jbr');
const LOGS_DIR = path.join(FIXTURES_DIR, 'configured-logs');
const OVERRIDE_LOGS_DIR = path.join(FIXTURES_DIR, 'override-logs');

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
  await fs.mkdir(WORKSPACE_A_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_B_DIR, { recursive: true });
  await fs.mkdir(OVERRIDE_ROOT_DIR, { recursive: true });
  await fs.mkdir(ANDROID_WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(ANDROID_JAVA_HOME, { recursive: true });
  await fs.mkdir(ANDROID_OVERRIDE_WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(ANDROID_OVERRIDE_JAVA_HOME, { recursive: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });
  await fs.mkdir(OVERRIDE_LOGS_DIR, { recursive: true });
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

async function testEnvIgnoredWhenEnvOverridesMissing(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, { android: androidConfig() }),
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-a',
    env: envValues(),
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
    env: envValues(),
  });

  assertEqual(snapshot.lineEnding, 'lf', 'An empty allowedFields array should disable lineEnding overrides');
  assertEqual(snapshot.logsDir, path.join(HOME_DIR, '.custom-mcp', 'logs'), 'An empty allowedFields array should disable logsDir overrides');
  assert(snapshot.android !== undefined, 'Fixture should include Android config');
  assertEqual(snapshot.android.javaHome, path.resolve(ANDROID_JAVA_HOME), 'An empty allowedFields array should disable Android overrides');
  assertEqual(snapshot.android.maxLogTailChars, 4000, 'An empty allowedFields array should disable numeric Android overrides');
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

async function testEmptyEnvValuesFallBackToConfigFile(): Promise<void> {
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
    env: envValues({
      MCP_LINE_ENDING: '',
      MCP_LOGS_DIR: '',
      ANDROID_WORKSPACE_ROOT: '',
      ANDROID_JAVA_HOME: '',
      ANDROID_BUILD_TIMEOUT_MS: '',
      ANDROID_MAX_ERROR_BLOCK_CHARS: '',
      ANDROID_MAX_LOG_TAIL_CHARS: '',
    }),
  });

  assertEqual(snapshot.lineEnding, 'lf', 'Empty MCP_LINE_ENDING should fall back to config file value');
  assertEqual(snapshot.logsDir, path.resolve(LOGS_DIR), 'Empty MCP_LOGS_DIR should fall back to config file value');
  assert(snapshot.android !== undefined, 'Fixture should include Android config');
  assertEqual(snapshot.android.workspaceRoot, path.resolve(ANDROID_WORKSPACE_ROOT), 'Empty ANDROID_WORKSPACE_ROOT should fall back to config file value');
  assertEqual(snapshot.android.javaHome, path.resolve(ANDROID_JAVA_HOME), 'Empty ANDROID_JAVA_HOME should fall back to config file value');
  assertEqual(snapshot.android.buildTimeoutMs, 900000, 'Empty ANDROID_BUILD_TIMEOUT_MS should fall back to config file value');
}

async function testInvalidEnvValuesFailStartup(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      android: androidConfig(),
      envOverrides: { allowedFields: ['lineEnding', 'logsDir', 'android.buildTimeoutMs'] },
    }),
  ]));

  const lineEndingError = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-a',
      env: envValues({ MCP_LINE_ENDING: 'native' }),
    })
  );
  assertIncludes(lineEndingError.message, 'MCP_LINE_ENDING must be one of', 'Invalid lineEnding env should be reported');
  assertEqual(lineEndingError.fieldPath, 'workspaces[0].lineEnding', 'Invalid lineEnding env should identify the target field');

  const integerError = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-a',
      env: envValues({ MCP_LINE_ENDING: '', ANDROID_BUILD_TIMEOUT_MS: '123abc' }),
    })
  );
  assertIncludes(integerError.message, 'ANDROID_BUILD_TIMEOUT_MS must be a positive integer', 'Invalid numeric env should be reported');
  assertEqual(integerError.fieldPath, 'workspaces[0].android.buildTimeoutMs', 'Invalid numeric env should identify the target field');

  const logsDirError = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-a',
      env: envValues({
        MCP_LINE_ENDING: '',
        MCP_LOGS_DIR: 'relative-logs',
        ANDROID_BUILD_TIMEOUT_MS: '',
      }),
    })
  );
  assertIncludes(logsDirError.message, 'MCP_LOGS_DIR must be an absolute local path', 'Invalid logsDir env should be reported');
  assertEqual(logsDirError.fieldPath, 'workspaces[0].logsDir', 'Invalid logsDir env should identify the target field');
}

async function testLogsDirEnvRequiresAllowlistField(): Promise<void> {
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
    env: envValues({ MCP_LOGS_DIR: OVERRIDE_LOGS_DIR }),
  });

  assertEqual(snapshot.lineEnding, 'crlf', 'The allowed lineEnding env should still apply');
  assertEqual(snapshot.logsDir, path.resolve(LOGS_DIR), 'MCP_LOGS_DIR should be ignored when logsDir is not allowlisted');
}

async function testForbiddenAndUnknownAllowlistFieldsFailStartup(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      envOverrides: { allowedFields: ['rootDir'] },
    }),
  ]));

  const rootDirError = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: envValues() })
  );
  assertIncludes(rootDirError.message, 'forbidden field "rootDir"', 'rootDir should be forbidden in allowlist');
  assertEqual(rootDirError.fieldPath, 'workspaces[0].envOverrides.allowedFields[0]', 'Forbidden field should identify the allowlist entry');

  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      envOverrides: { allowedFields: ['MCP_PORT'] },
    }),
  ]));

  const mcpPortError = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: envValues() })
  );
  assertIncludes(mcpPortError.message, 'environment variable name "MCP_PORT"', 'MCP_PORT should not be used as an allowlist selector');

  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      envOverrides: { allowedFields: ['MCP_ROOT_DIR'] },
    }),
  ]));

  const mcpRootDirError = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: envValues() })
  );
  assertIncludes(mcpRootDirError.message, 'environment variable name "MCP_ROOT_DIR"', 'MCP_ROOT_DIR should not be used as an allowlist selector');

  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      envOverrides: { allowedFields: ['android.unknown'] },
    }),
  ]));

  const unknownError = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: envValues() })
  );
  assertIncludes(unknownError.message, 'unknown field "android.unknown"', 'Unknown allowlist fields should fail startup');

  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace('workspace-a', WORKSPACE_A_DIR, 4701, {
      envOverrides: { allowedFields: ['MCP_LOGS_DIR'] },
    }),
  ]));

  const mcpLogsDirError = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: envValues() })
  );
  assertIncludes(mcpLogsDirError.message, 'environment variable name "MCP_LOGS_DIR"', 'MCP_LOGS_DIR should not be used as an allowlist selector');
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
    env: envValues({ MCP_LINE_ENDING: 'crlf' }),
  });
  assertEqual(selectedA.workspaceId, 'workspace-a', 'Fixture should select workspace-a');
  assertEqual(selectedA.lineEnding, 'lf', 'Unselected workspace-b allowlist should not affect workspace-a');

  const selectedB = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-b',
    env: envValues({ MCP_LINE_ENDING: 'crlf' }),
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
      { name: 'allowed fields override snapshot only', run: testAllowedFieldsOverrideSnapshotOnly },
      { name: 'empty env values fall back to config file', run: testEmptyEnvValuesFallBackToConfigFile },
      { name: 'invalid env values fail startup', run: testInvalidEnvValuesFailStartup },
      { name: 'logsDir env requires allowlist field', run: testLogsDirEnvRequiresAllowlistField },
      { name: 'forbidden and unknown allowlist fields fail startup', run: testForbiddenAndUnknownAllowlistFieldsFailStartup },
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
