import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  loadRuntimeConfig,
} from '../../src/config.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'load-runtime-config');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PRIMARY_DIR = path.join(FIXTURES_DIR, 'primary');
const ADDITIONAL_DIR = path.join(FIXTURES_DIR, 'additional');
const SECONDARY_DIR = path.join(FIXTURES_DIR, 'secondary');
const OVERRIDE_DIR = path.join(FIXTURES_DIR, 'override-root');

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(PRIMARY_DIR, { recursive: true });
  await fs.mkdir(ADDITIONAL_DIR, { recursive: true });
  await fs.mkdir(SECONDARY_DIR, { recursive: true });
  await fs.mkdir(OVERRIDE_DIR, { recursive: true });
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
        port: 4321,
        lineEnding: 'lf',
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

  const snapshot = loadRuntimeConfig({ homeDir: HOME_DIR, env: {} });

  assertEqual(snapshot.configFilePath, CONFIG_FILE, 'Snapshot should record the home-level dotdir config path');
  assertEqual(snapshot.workspaceId, 'primary-workspace', 'Phase 3 bridge should use the first validated workspace');
  assertEqual(snapshot.rootDir, PRIMARY_DIR, 'Snapshot should use rootDir from the selected workspace');
  assertEqual(snapshot.otherRootDirs.length, 1, 'Snapshot should keep additional roots from the selected workspace');
  assertEqual(snapshot.otherRootDirs[0], ADDITIONAL_DIR, 'Snapshot should keep the additional root path');
  assertEqual(snapshot.port, 4321, 'Snapshot should use the configured port');
  assertEqual(snapshot.lineEnding, 'lf', 'Snapshot should use the configured line ending');
  assertEqual(
    snapshot.pathSafetyContext.allowedRoots.length,
    2,
    'Snapshot should include a validated path safety context',
  );
}

async function testPhase3BridgeKeepsLegacyEnvOverrides(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(createGlobalConfig());

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    env: {
      MCP_ROOT_DIR: OVERRIDE_DIR,
      MCP_PORT: '5432',
      MCP_LINE_ENDING: 'crlf',
    },
  });

  assertEqual(snapshot.rootDir, OVERRIDE_DIR, 'Phase 3 should still preserve legacy MCP_ROOT_DIR override until phase 5');
  assertEqual(snapshot.port, 5432, 'Phase 3 should still preserve legacy MCP_PORT override until phase 5');
  assertEqual(snapshot.lineEnding, 'crlf', 'Phase 3 should still preserve legacy MCP_LINE_ENDING override until phase 5');
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
    const error = captureConfigError(() => loadRuntimeConfig({ homeDir: HOME_DIR, env: {} }));

    assertEqual(error.code, 'config_file_not_found', 'Missing config should have a precise error code');
    assertEqual(error.configFilePath, CONFIG_FILE, 'Missing config error should point to the expanded absolute path');
    assertIncludes(error.suggestion, CONFIG_FILE, 'Missing config suggestion should include the file to create');
    assertIncludes(error.suggestion, 'Minimum global config', 'Missing config suggestion should include a minimal example');
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
    JSON.stringify({ version: 1, workspaces: [{ id: 'cwd', rootDir: cwdRootDir, port: 9999, lineEnding: 'auto' }] }, null, 2),
    'utf-8',
  );
  await fs.mkdir(HOME_DIR, { recursive: true });

  const previousCwd = process.cwd();
  process.chdir(cwdDir);
  try {
    const error = captureConfigError(() => loadRuntimeConfig({ homeDir: HOME_DIR, env: {} }));

    assertEqual(error.code, 'config_file_not_found', 'Missing home-level config should fail even when cwd has config.json');
    assertEqual(error.configFilePath, CONFIG_FILE, 'Runtime config should only look at the home-level dotdir path');
  } finally {
    process.chdir(previousCwd);
  }
}

async function testInvalidJsonThrowsStructuredError(): Promise<void> {
  await resetFixtures();
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, '{ invalid json', 'utf-8');

  const error = captureConfigError(() => loadRuntimeConfig({ homeDir: HOME_DIR, env: {} }));

  assertEqual(error.code, 'config_json_invalid', 'Invalid JSON should be reported as a JSON config error');
  assertEqual(error.configFilePath, CONFIG_FILE, 'Invalid JSON error should include the config file path');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing runtime config loading',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'loads runtime snapshot from home dotdir config', run: testLoadsRuntimeSnapshotFromHomeDotdirConfig },
      { name: 'phase 3 bridge keeps legacy env overrides', run: testPhase3BridgeKeepsLegacyEnvOverrides },
      { name: 'missing config throws without process.exit', run: testMissingConfigThrowsWithoutProcessExit },
      { name: 'does not read current directory config.json', run: testDoesNotReadCurrentDirectoryConfigJson },
      { name: 'invalid JSON throws structured error', run: testInvalidJsonThrowsStructuredError },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
