import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  loadRuntimeConfig,
} from '../../src/config.js';
import { createToolRuntimeContext } from '../../src/runtime/tool-context.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'runtime-snapshot');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PRIMARY_DIR = path.join(FIXTURES_DIR, 'primary');
const PRIMARY_CHILD_DIR = path.join(PRIMARY_DIR, 'child');
const ADDITIONAL_A_DIR = path.join(FIXTURES_DIR, 'additional-a');
const ADDITIONAL_A_CHILD_DIR = path.join(ADDITIONAL_A_DIR, 'child');
const ADDITIONAL_B_DIR = path.join(FIXTURES_DIR, 'additional-b');
const NOT_DIRECTORY_FILE = path.join(FIXTURES_DIR, 'not-a-directory.txt');
const MISSING_DIR = path.join(FIXTURES_DIR, 'missing');
const CONFIGURED_LOGS_DIR = path.join(FIXTURES_DIR, 'configured-logs');
const OVERRIDE_LOGS_DIR = path.join(FIXTURES_DIR, 'override-logs');

interface InvalidOtherRootCase {
  readonly name: string;
  readonly otherRootDirs: readonly string[];
  readonly expectedFieldPath: string;
  readonly expectedMessage: string;
}

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(PRIMARY_CHILD_DIR, { recursive: true });
  await fs.mkdir(ADDITIONAL_A_CHILD_DIR, { recursive: true });
  await fs.mkdir(ADDITIONAL_B_DIR, { recursive: true });
  await fs.mkdir(CONFIGURED_LOGS_DIR, { recursive: true });
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

async function removeLinkIfExists(linkPath: string): Promise<void> {
  try {
    await fs.unlink(linkPath);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return;
    await fs.rm(linkPath, { recursive: true, force: true });
  }
}

async function createDirectoryLink(
  linkPath: string,
  targetPath: string,
): Promise<boolean> {
  await removeLinkIfExists(linkPath);
  try {
    await fs.symlink(
      targetPath,
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return true;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    console.log(`  - Skipped symlink runtime snapshot assertion: ${error.message}`);
    return false;
  }
}

function workspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'runtime-workspace',
    rootDir: PRIMARY_DIR,
    port: 4801,
    lineEnding: 'lf',
    ...overrides,
  };
}

function globalConfig(workspaceOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    workspaces: [workspace(workspaceOverrides)],
  };
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    assertEqual(error.code, 'config_validation_failed', 'Runtime snapshot failures should use config_validation_failed');
    return error;
  }

  throw new Error('Expected loadRuntimeConfig() to throw.');
}

async function testSnapshotUsesCanonicalPathSafetyRoots(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig({
    rootDir: `${PRIMARY_DIR}${path.sep}`,
    otherRootDirs: [`${ADDITIONAL_A_DIR}${path.sep}`],
  }));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'runtime-workspace',
    env: {},
  });

  assertEqual(snapshot.snapshotVersion, 1, 'Initial runtime snapshot version should be 1');
  assertEqual(snapshot.configFilePath, CONFIG_FILE, 'Snapshot should record the config file path');
  assertEqual(snapshot.workspaceId, 'runtime-workspace', 'Snapshot should record selected workspace id');
  assertEqual(snapshot.logsDir, path.join(HOME_DIR, '.custom-mcp', 'logs'), 'Snapshot should use the default home dotdir logs dir');
  assertEqual(snapshot.rootDir, path.resolve(PRIMARY_DIR), 'Snapshot rootDir should use canonical path safety primary root');
  assertEqual(snapshot.otherRootDirs.length, 1, 'Snapshot should include canonical additional roots');
  assertEqual(snapshot.otherRootDirs[0], path.resolve(ADDITIONAL_A_DIR), 'Snapshot otherRootDirs should come from path safety roots');
  assertEqual(snapshot.pathSafetyContext.primaryRoot.rootDir, snapshot.rootDir, 'Snapshot rootDir should match pathSafetyContext primary root');
  assertEqual(
    snapshot.pathSafetyContext.allowedRoots[1]?.rootDir,
    snapshot.otherRootDirs[0],
    'Snapshot otherRootDirs should match pathSafetyContext additional roots',
  );
}

async function testSnapshotUsesConfiguredLogsDir(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig({ logsDir: CONFIGURED_LOGS_DIR }));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'runtime-workspace',
    env: {},
  });

  assertEqual(snapshot.logsDir, path.resolve(CONFIGURED_LOGS_DIR), 'Configured logsDir should override the default logs dir');
}

async function testSnapshotUsesAllowedLogsDirEnvOverride(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig({
    logsDir: CONFIGURED_LOGS_DIR,
    envOverrides: { allowedFields: ['logsDir'] },
  }));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'runtime-workspace',
    env: { MCP_LOGS_DIR: OVERRIDE_LOGS_DIR },
  });

  assertEqual(snapshot.logsDir, path.resolve(OVERRIDE_LOGS_DIR), 'Allowed MCP_LOGS_DIR should override configured logsDir');
}

async function testEmptyLogsDirEnvFailsBeforeSnapshot(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig({
    logsDir: CONFIGURED_LOGS_DIR,
    envOverrides: { allowedFields: ['logsDir'] },
  }));

  const error = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'runtime-workspace',
      env: { MCP_LOGS_DIR: '' },
    })
  );

  assertEqual(error.fieldPath, 'workspaces[0].logsDir', 'Empty MCP_LOGS_DIR should identify the target config field');
  assertIncludes(error.message, 'MCP_LOGS_DIR must be a non-empty string', 'Empty MCP_LOGS_DIR should fail as an env value');
  assertIncludes(error.suggestion, 'Fix MCP_LOGS_DIR', 'Empty MCP_LOGS_DIR suggestion should point at the environment');
}

async function testInvalidOtherRootDirsReturnStructuredErrors(): Promise<void> {
  const cases: InvalidOtherRootCase[] = [
    {
      name: 'duplicates primary root',
      otherRootDirs: [`${PRIMARY_DIR}${path.sep}`],
      expectedFieldPath: 'workspaces[0].otherRootDirs[0]',
      expectedMessage: 'rootDir and otherRootDirs[0]',
    },
    {
      name: 'is nested under primary root',
      otherRootDirs: [PRIMARY_CHILD_DIR],
      expectedFieldPath: 'workspaces[0].otherRootDirs[0]',
      expectedMessage: 'otherRootDirs[0]',
    },
    {
      name: 'duplicates another additional root',
      otherRootDirs: [ADDITIONAL_A_DIR, `${ADDITIONAL_A_DIR}${path.sep}`],
      expectedFieldPath: 'workspaces[0].otherRootDirs[1]',
      expectedMessage: 'otherRootDirs[0] and otherRootDirs[1]',
    },
    {
      name: 'is nested under another additional root',
      otherRootDirs: [ADDITIONAL_A_DIR, ADDITIONAL_A_CHILD_DIR],
      expectedFieldPath: 'workspaces[0].otherRootDirs[1]',
      expectedMessage: 'otherRootDirs[1]',
    },
  ];

  for (const testCase of cases) {
    await resetFixtures();
    await writeGlobalConfig(globalConfig({ otherRootDirs: testCase.otherRootDirs }));

    const error = captureConfigError(() =>
      loadRuntimeConfig({
        homeDir: HOME_DIR,
        workspaceId: 'runtime-workspace',
        env: {},
      })
    );

    assertEqual(error.fieldPath, testCase.expectedFieldPath, `${testCase.name} should identify the offending otherRootDirs entry`);
    assertIncludes(error.message, testCase.expectedMessage, `${testCase.name} should include the path safety error`);
    assertIncludes(error.message, 'Selected workspace allowed roots are invalid', `${testCase.name} should identify snapshot root validation`);
    assertIncludes(error.suggestion, 'rootDir/otherRootDirs', `${testCase.name} should include a useful suggestion`);
  }
}

async function testOtherRootDirsRealpathDuplicateValidation(): Promise<void> {
  await resetFixtures();
  const linkPath = path.join(FIXTURES_DIR, 'link-to-additional-a');
  const linkCreated = await createDirectoryLink(linkPath, ADDITIONAL_A_DIR);
  if (!linkCreated) return;

  try {
    await writeGlobalConfig(globalConfig({ otherRootDirs: [ADDITIONAL_A_DIR, linkPath] }));

    const error = captureConfigError(() =>
      loadRuntimeConfig({
        homeDir: HOME_DIR,
        workspaceId: 'runtime-workspace',
        env: {},
      })
    );

    assertEqual(error.fieldPath, 'workspaces[0].otherRootDirs[1]', 'Realpath duplicate should identify the symlinked additional root');
    assertIncludes(error.message, 'unique at the real path layer', 'Realpath duplicate additional roots should be rejected');
    assertIncludes(error.message, 'otherRootDirs[0] and otherRootDirs[1]', 'Realpath duplicate error should mention both additional roots');
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function testOtherRootDirsRealpathNestedValidation(): Promise<void> {
  await resetFixtures();
  const linkPath = path.join(FIXTURES_DIR, 'link-to-additional-a-child');
  const linkCreated = await createDirectoryLink(linkPath, ADDITIONAL_A_CHILD_DIR);
  if (!linkCreated) return;

  try {
    await writeGlobalConfig(globalConfig({ otherRootDirs: [ADDITIONAL_A_DIR, linkPath] }));

    const error = captureConfigError(() =>
      loadRuntimeConfig({
        homeDir: HOME_DIR,
        workspaceId: 'runtime-workspace',
        env: {},
      })
    );

    assertEqual(error.fieldPath, 'workspaces[0].otherRootDirs[1]', 'Realpath nested root should identify the symlinked nested additional root');
    assertIncludes(error.message, 'must not be nested at the real path layer', 'Realpath nested additional roots should be rejected');
    assertIncludes(error.message, 'otherRootDirs[1]', 'Realpath nested error should mention the nested additional root');
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function testSnapshotGraphIsDeepFrozen(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig({ otherRootDirs: [ADDITIONAL_A_DIR] }));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'runtime-workspace',
    env: {},
  });

  assert(Object.isFrozen(snapshot), 'Snapshot should be frozen');
  const unsafeSnapshot = snapshot as unknown as { logsDir: string };
  try {
    unsafeSnapshot.logsDir = path.join(FIXTURES_DIR, 'mutated-logs');
  } catch {
    // Frozen objects throw in strict mode; either way the assertion below checks the observable value.
  }
  assertEqual(snapshot.logsDir, path.join(HOME_DIR, '.custom-mcp', 'logs'), 'Frozen snapshot should keep logsDir immutable');
  assert(Object.isFrozen(snapshot.otherRootDirs), 'Snapshot otherRootDirs should be frozen');
  assert(Object.isFrozen(snapshot.pathSafetyContext), 'PathSafetyContext should be frozen');
  assert(Object.isFrozen(snapshot.pathSafetyContext.primaryRoot), 'Primary root should be frozen');
  assert(Object.isFrozen(snapshot.pathSafetyContext.primaryRoot.permissions), 'Primary root permissions should be frozen');
  assert(Object.isFrozen(snapshot.pathSafetyContext.allowedRoots), 'Allowed roots array should be frozen');
  for (const root of snapshot.pathSafetyContext.allowedRoots) {
    assert(Object.isFrozen(root), 'Each allowed root should be frozen');
    assert(Object.isFrozen(root.permissions), 'Each allowed root permissions object should be frozen');
  }
}

async function testToolRuntimeContextUsesSnapshotAndroidMessage(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig());

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'runtime-workspace',
    env: {},
  });
  const context = createToolRuntimeContext(snapshot);
  const contextRecord = context as unknown as Record<string, unknown>;

  assert(!('logsDir' in contextRecord), 'ToolRuntimeContext should not expose logsDir');
  assertEqual(context.android, undefined, 'Fixture should not configure Android');
  assertIncludes(
    context.missingAndroidConfigMessage,
    'selected workspace "runtime-workspace"',
    'Android missing message should identify the selected workspace',
  );
  assertIncludes(
    context.missingAndroidConfigMessage,
    CONFIG_FILE,
    'Android missing message should point to the global config file',
  );
  assertIncludes(
    context.missingAndroidConfigMessage,
    'Add an android section to that workspace',
    'Android missing message should point at the selected workspace android section',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing runtime snapshot construction',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'uses canonical path safety roots', run: testSnapshotUsesCanonicalPathSafetyRoots },
      { name: 'uses configured logsDir', run: testSnapshotUsesConfiguredLogsDir },
      { name: 'uses allowed logsDir env override', run: testSnapshotUsesAllowedLogsDirEnvOverride },
      { name: 'empty logsDir env fails before snapshot', run: testEmptyLogsDirEnvFailsBeforeSnapshot },
      { name: 'invalid selected otherRootDirs return structured errors', run: testInvalidOtherRootDirsReturnStructuredErrors },
      { name: 'selected otherRootDirs reject realpath duplicates', run: testOtherRootDirsRealpathDuplicateValidation },
      { name: 'selected otherRootDirs reject realpath nesting', run: testOtherRootDirsRealpathNestedValidation },
      { name: 'deep-freezes snapshot graph', run: testSnapshotGraphIsDeepFrozen },
      { name: 'tool runtime context uses snapshot Android message', run: testToolRuntimeContextUsesSnapshotAndroidMessage },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
