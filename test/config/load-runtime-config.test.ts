import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadRuntimeConfig, loadRuntimeConfigWithIdentity } from '../../src/config.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
  writeSplitConfigFixture,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'load-runtime-config');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const WORKSPACE_CONFIG_FILE = path.join(CONFIG_DIR, 'workspace-0.json');
const DEFAULT_LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const PRIMARY_DIR = path.join(FIXTURES_DIR, 'primary');
const ADDITIONAL_DIR = path.join(FIXTURES_DIR, 'additional');
const SECONDARY_DIR = path.join(FIXTURES_DIR, 'secondary');
const OVERRIDE_DIR = path.join(FIXTURES_DIR, 'override-root');
const OVERRIDE_LOGS_DIR = path.join(FIXTURES_DIR, 'override-logs');
const ANDROID_WORKSPACE_ROOT = path.join(FIXTURES_DIR, 'android-project');
const ANDROID_JAVA_HOME = path.join(FIXTURES_DIR, 'jbr');
const ANDROID_OVERRIDE_ROOT = path.join(FIXTURES_DIR, 'android-override-project');
const ANDROID_OVERRIDE_JAVA_HOME = path.join(FIXTURES_DIR, 'android-override-jbr');

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(DEFAULT_LOGS_DIR, { recursive: true });
  await fs.mkdir(PRIMARY_DIR, { recursive: true });
  await fs.mkdir(ADDITIONAL_DIR, { recursive: true });
  await fs.mkdir(SECONDARY_DIR, { recursive: true });
  await fs.mkdir(OVERRIDE_DIR, { recursive: true });
  await fs.mkdir(OVERRIDE_LOGS_DIR, { recursive: true });
  await fs.mkdir(ANDROID_WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(ANDROID_JAVA_HOME, { recursive: true });
  await fs.mkdir(ANDROID_OVERRIDE_ROOT, { recursive: true });
  await fs.mkdir(ANDROID_OVERRIDE_JAVA_HOME, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function writeGlobalConfig(config: unknown): Promise<void> {
  await writeSplitConfigFixture(CONFIG_FILE, config);
}

async function prependBom(filePath: string): Promise<void> {
  const contents = await fs.readFile(filePath);
  await fs.writeFile(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), contents]));
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    return error;
  }

  throw new Error('Expected loadRuntimeConfig() to throw.');
}

function createGlobalConfig(): unknown {
  return {
    version: 1,
    workspaces: [
      {
        id: 'primary-workspace',
        rootDir: PRIMARY_DIR,
        otherRootDirs: [ADDITIONAL_DIR],
        host: '127.0.0.2',
        port: 4321,
        lineEnding: 'lf',
        android: {
          workspaceRoot: ANDROID_WORKSPACE_ROOT,
          javaHome: ANDROID_JAVA_HOME,
          buildTimeoutMs: 900000,
          maxErrorBlockChars: 2500,
          maxLogTailChars: 4000,
        },
      },
      {
        id: 'secondary-workspace',
        rootDir: SECONDARY_DIR,
        port: 4322,
        lineEnding: 'auto',
      },
    ],
  };
}

async function testLoadsRuntimeSnapshotFromHomeDotdirConfig(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(createGlobalConfig());

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'primary-workspace',
    env: {},
  });

  assertEqual(
    snapshot.globalConfigFilePath,
    CONFIG_FILE,
    'Snapshot should record the home-level global config path',
  );
  assertEqual(
    snapshot.workspaceConfigFilePath,
    WORKSPACE_CONFIG_FILE,
    'Snapshot should record the selected workspace config path',
  );
  assertEqual(
    snapshot.workspaceId,
    'primary-workspace',
    'Snapshot should use the explicitly selected workspace',
  );
  assertEqual(
    snapshot.rootDir,
    PRIMARY_DIR,
    'Snapshot should use rootDir from the selected workspace',
  );
  assertEqual(
    snapshot.otherRootDirs.length,
    1,
    'Snapshot should keep additional roots from the selected workspace',
  );
  assertEqual(
    snapshot.otherRootDirs[0],
    ADDITIONAL_DIR,
    'Snapshot should keep the additional root path',
  );
  assertEqual(snapshot.host, '127.0.0.2', 'Snapshot should use the configured host');
  assertEqual(snapshot.port, 4321, 'Snapshot should use the configured port');
  assertEqual(snapshot.lineEnding, 'lf', 'Snapshot should use the configured line ending');
  assertEqual(
    snapshot.pathSafetyContext.allowedRoots.length,
    2,
    'Snapshot should include a validated path safety context',
  );
}

async function testEnvOverridesAreIgnoredWithoutAllowlist(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(createGlobalConfig());

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'primary-workspace',
    env: {
      MCP_ROOT_DIR: OVERRIDE_DIR,
      MCP_PORT: '5432',
      MCP_LINE_ENDING: 'crlf',
      ANDROID_WORKSPACE_ROOT: ANDROID_OVERRIDE_ROOT,
      ANDROID_JAVA_HOME: ANDROID_OVERRIDE_JAVA_HOME,
      ANDROID_BUILD_TIMEOUT_MS: '1234',
      ANDROID_MAX_ERROR_BLOCK_CHARS: '1235',
      ANDROID_MAX_LOG_TAIL_CHARS: '1236',
    },
  });

  assertEqual(
    snapshot.rootDir,
    PRIMARY_DIR,
    'MCP_ROOT_DIR should not affect the selected workspace rootDir',
  );
  assertEqual(snapshot.port, 4321, 'MCP_PORT should not affect the selected workspace port');
  assertEqual(
    snapshot.lineEnding,
    'lf',
    'MCP_LINE_ENDING should not affect lineEnding without a selected workspace allowlist',
  );
  assert(snapshot.android !== undefined, 'Fixture should include Android config');
  assertEqual(
    snapshot.android.workspaceRoot,
    path.resolve(ANDROID_WORKSPACE_ROOT),
    'ANDROID_WORKSPACE_ROOT should not override Android config',
  );
  assertEqual(
    snapshot.android.javaHome,
    path.resolve(ANDROID_JAVA_HOME),
    'ANDROID_JAVA_HOME should not override Android config',
  );
  assertEqual(
    snapshot.android.buildTimeoutMs,
    900000,
    'ANDROID_BUILD_TIMEOUT_MS should not override Android config',
  );
}

async function testEnvOverridesApplyAfterWorkspaceSelectionBeforeSnapshot(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig({
    version: 1,
    workspaces: [
      {
        id: 'primary-workspace',
        rootDir: PRIMARY_DIR,
        otherRootDirs: [ADDITIONAL_DIR],
        port: 4321,
        lineEnding: 'lf',
        android: {
          workspaceRoot: ANDROID_WORKSPACE_ROOT,
          javaHome: ANDROID_JAVA_HOME,
          buildTimeoutMs: 900000,
          maxErrorBlockChars: 2500,
          maxLogTailChars: 4000,
        },
        envOverrides: {
          allowedFields: ['lineEnding', 'logsDir', 'android.buildTimeoutMs'],
        },
      },
      {
        id: 'secondary-workspace',
        rootDir: SECONDARY_DIR,
        port: 4322,
        lineEnding: 'auto',
      },
    ],
  });

  const loaded = loadRuntimeConfigWithIdentity({
    homeDir: HOME_DIR,
    workspaceId: 'primary-workspace',
    env: {
      MCP_ROOT_DIR: SECONDARY_DIR,
      MCP_PORT: '4322',
      MCP_LINE_ENDING: 'crlf',
      MCP_LOGS_DIR: OVERRIDE_LOGS_DIR,
      ANDROID_BUILD_TIMEOUT_MS: '1234',
    },
  });

  assertEqual(
    loaded.identity.workspaceId,
    'primary-workspace',
    'Selection should run before env overrides are applied',
  );
  assertEqual(
    loaded.identity.rootDir,
    PRIMARY_DIR,
    'Runtime identity should keep the selected config rootDir',
  );
  assertEqual(
    loaded.identity.host,
    '127.0.0.1',
    'Runtime identity should use the default IPv4 loopback host',
  );
  assertEqual(loaded.identity.port, 4321, 'Runtime identity should keep the selected config port');
  assertEqual(
    loaded.snapshot.rootDir,
    PRIMARY_DIR,
    'Boundary rootDir should not be overridden by env',
  );
  assertEqual(loaded.snapshot.host, '127.0.0.1', 'Boundary host should not be overridden by env');
  assertEqual(loaded.snapshot.port, 4321, 'Boundary port should not be overridden by env');
  assertEqual(
    loaded.snapshot.lineEnding,
    'crlf',
    'Snapshot should include the allowlisted lineEnding env override',
  );
  assertEqual(
    loaded.snapshot.logsDir,
    path.resolve(OVERRIDE_LOGS_DIR),
    'Snapshot should include the allowlisted logsDir env override',
  );
  assert(loaded.snapshot.android !== undefined, 'Fixture should include Android config');
  assertEqual(
    loaded.snapshot.android.buildTimeoutMs,
    1234,
    'Snapshot should include the allowlisted Android numeric env override',
  );
}

async function testAndroidConfigRelativePathsFailStartup(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig({
    version: 1,
    workspaces: [
      {
        id: 'primary-workspace',
        rootDir: PRIMARY_DIR,
        port: 4321,
        lineEnding: 'auto',
        android: {
          workspaceRoot: 'relative-android-project',
          javaHome: ANDROID_JAVA_HOME,
          buildTimeoutMs: 900000,
          maxErrorBlockChars: 2500,
          maxLogTailChars: 4000,
        },
      },
    ],
  });

  const error = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'primary-workspace',
      env: {},
    }),
  );

  assertEqual(
    error.fieldPath,
    'android.workspaceRoot',
    'Relative Android path should identify the invalid field',
  );
  assertIncludes(
    error.message,
    'must be an absolute local path',
    'Android paths should use typed path policy',
  );
}

async function testMissingConfigThrowsWithoutProcessExit(): Promise<void> {
  await resetFixtures();
  await fs.mkdir(HOME_DIR, { recursive: true });

  const originalExit = process.exit;
  let exitCalled = false;
  process.exit = ((code?: string | number | null | undefined): never => {
    exitCalled = true;
    throw new Error(`process.exit(${String(code)}) was called`);
  }) as typeof process.exit;

  try {
    const error = captureConfigError(() =>
      loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary-workspace', env: {} }),
    );

    assertEqual(
      error.code,
      'config_file_not_found',
      'Missing config should have a precise error code',
    );
    assertEqual(
      error.configFilePath,
      CONFIG_FILE,
      'Missing config error should point to the expanded absolute path',
    );
    assertIncludes(
      error.suggestion,
      CONFIG_FILE,
      'Missing config suggestion should include the file to create',
    );
    assertIncludes(
      error.suggestion,
      'Minimum global config',
      'Missing config suggestion should include a minimal example',
    );
  } finally {
    process.exit = originalExit;
  }

  assert(!exitCalled, 'loadRuntimeConfig should not call process.exit()');
}

async function testDoesNotReadCurrentDirectoryConfigJson(): Promise<void> {
  await resetFixtures();

  const cwdDir = path.join(FIXTURES_DIR, 'cwd-with-config');
  const cwdRootDir = path.join(cwdDir, 'workspace');
  await fs.mkdir(cwdRootDir, { recursive: true });
  await fs.writeFile(
    path.join(cwdDir, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        workspaces: [{ id: 'cwd', rootDir: cwdRootDir, port: 9999, lineEnding: 'auto' }],
      },
      null,
      2,
    ),
    'utf-8',
  );
  await fs.mkdir(HOME_DIR, { recursive: true });

  const previousCwd = process.cwd();
  process.chdir(cwdDir);
  try {
    const error = captureConfigError(() =>
      loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary-workspace', env: {} }),
    );

    assertEqual(
      error.code,
      'config_file_not_found',
      'Missing home-level config should fail even when cwd has config.json',
    );
    assertEqual(
      error.configFilePath,
      CONFIG_FILE,
      'Runtime config should only look at the home-level dotdir path',
    );
  } finally {
    process.chdir(previousCwd);
  }
}

async function testInvalidJsonThrowsStructuredError(): Promise<void> {
  await resetFixtures();
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, '{ invalid json', 'utf-8');

  const error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary-workspace', env: {} }),
  );

  assertEqual(
    error.code,
    'config_json_invalid',
    'Invalid JSON should be reported as a JSON config error',
  );
  assertEqual(
    error.configFilePath,
    CONFIG_FILE,
    'Invalid JSON error should include the config file path',
  );
}

async function testAcceptsOneBomAndRejectsTwo(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(createGlobalConfig());
  await prependBom(CONFIG_FILE);
  await prependBom(WORKSPACE_CONFIG_FILE);

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'primary-workspace',
    env: {},
  });
  assertEqual(
    snapshot.workspaceId,
    'primary-workspace',
    'One BOM should be accepted in both configuration layers',
  );

  await prependBom(WORKSPACE_CONFIG_FILE);
  let error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary-workspace', env: {} }),
  );
  assertEqual(
    error.code,
    'config_json_invalid',
    'A second workspace BOM should be treated as JSON content',
  );
  assertEqual(
    error.configFilePath,
    WORKSPACE_CONFIG_FILE,
    'Double-BOM workspace failure should identify its file',
  );

  await resetFixtures();
  await writeGlobalConfig(createGlobalConfig());
  await prependBom(CONFIG_FILE);
  await prependBom(CONFIG_FILE);
  error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary-workspace', env: {} }),
  );
  assertEqual(
    error.code,
    'config_json_invalid',
    'A second global BOM should be treated as JSON content',
  );
  assertEqual(
    error.configFilePath,
    CONFIG_FILE,
    'Double-BOM global failure should identify its file',
  );
}

async function testRejectsNonRegularGlobalConfig(): Promise<void> {
  await resetFixtures();
  await fs.mkdir(CONFIG_FILE);

  const error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary-workspace', env: {} }),
  );
  assertEqual(
    error.code,
    'config_file_read_failed',
    'A directory should fail at the file-reading boundary',
  );
  assertIncludes(
    error.message,
    'regular file',
    'A directory should produce a regular-file diagnostic',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing runtime config loading',
    afterAll: cleanupFixtures,
    tests: [
      {
        name: 'loads runtime snapshot from home dotdir config',
        run: testLoadsRuntimeSnapshotFromHomeDotdirConfig,
      },
      {
        name: 'env overrides are ignored without allowlist',
        run: testEnvOverridesAreIgnoredWithoutAllowlist,
      },
      {
        name: 'env overrides apply after workspace selection before snapshot',
        run: testEnvOverridesApplyAfterWorkspaceSelectionBeforeSnapshot,
      },
      {
        name: 'Android config relative paths fail startup',
        run: testAndroidConfigRelativePathsFailStartup,
      },
      {
        name: 'missing config throws without process.exit',
        run: testMissingConfigThrowsWithoutProcessExit,
      },
      {
        name: 'does not read current directory config.json',
        run: testDoesNotReadCurrentDirectoryConfigJson,
      },
      { name: 'invalid JSON throws structured error', run: testInvalidJsonThrowsStructuredError },
      { name: 'accepts one BOM and rejects two', run: testAcceptsOneBomAndRejectsTwo },
      { name: 'rejects a non-regular global config', run: testRejectsNonRegularGlobalConfig },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
