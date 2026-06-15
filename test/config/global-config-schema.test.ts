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
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'global-config-schema');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const WORKSPACE_A_DIR = path.join(FIXTURES_DIR, 'workspace-a');
const WORKSPACE_B_DIR = path.join(FIXTURES_DIR, 'workspace-b');
const WORKSPACE_C_DIR = path.join(FIXTURES_DIR, 'workspace-c');
const NESTED_A_DIR = path.join(WORKSPACE_A_DIR, 'nested');
const NOT_DIRECTORY_PATH = path.join(FIXTURES_DIR, 'not-a-directory.txt');
const ANDROID_WORKSPACE_ROOT = path.join(FIXTURES_DIR, 'android-project');
const ANDROID_JAVA_HOME = path.join(FIXTURES_DIR, 'jbr');
const LOGS_DIR = path.join(FIXTURES_DIR, 'service-logs');

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(NESTED_A_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_B_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_C_DIR, { recursive: true });
  await fs.mkdir(ANDROID_WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(ANDROID_JAVA_HOME, { recursive: true });
  await fs.writeFile(NOT_DIRECTORY_PATH, 'not a directory\n', 'utf-8');
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
    assertEqual(error.code, 'config_validation_failed', 'Schema failures should use config_validation_failed');
    return error;
  }

  throw new Error('Expected loadRuntimeConfig() to throw.');
}

async function expectValidationError(
  config: unknown,
  expectedMessage: string,
  expectedFieldPath?: string,
): Promise<ConfigError> {
  await resetFixtures();
  await writeGlobalConfig(config);

  const error = captureConfigError(() => loadRuntimeConfig({ homeDir: HOME_DIR, env: {} }));

  assertIncludes(error.message, expectedMessage, 'Error message should identify the schema failure');
  if (expectedFieldPath !== undefined) {
    assertEqual(error.fieldPath, expectedFieldPath, 'Error should identify the invalid field');
  }

  return error;
}

function workspace(
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const rootDirs = [WORKSPACE_A_DIR, WORKSPACE_B_DIR, WORKSPACE_C_DIR];

  return {
    id: `workspace-${index}`,
    rootDir: rootDirs[index] ?? path.join(FIXTURES_DIR, `workspace-${index}`),
    port: 4100 + index,
    lineEnding: 'auto',
    ...overrides,
  };
}

function globalConfig(
  workspaces: unknown[] = [workspace(0)],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    workspaces,
    ...overrides,
  };
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
    console.log(`  - Skipped symlink schema assertion: ${error.message}`);
    return false;
  }
}

async function testValidGlobalConfigLoadsExplicitWorkspace(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace(0, { logsDir: LOGS_DIR }),
    workspace(1, { lineEnding: 'crlf' }),
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-0',
    env: {},
  });

  assertEqual(snapshot.workspaceId, 'workspace-0', 'Snapshot should use the explicitly selected workspace');
  assertEqual(snapshot.rootDir, WORKSPACE_A_DIR, 'Snapshot should use the selected workspace rootDir');
  assertEqual(snapshot.logsDir, path.resolve(LOGS_DIR), 'Snapshot should use the selected workspace logsDir');
  assertEqual(snapshot.otherRootDirs.length, 0, 'otherRootDirs should default to an empty array');
  assert(snapshot.android === undefined, 'Android config should be optional');
}

async function testCompleteAndroidConfigIsAccepted(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace(0, {
      android: {
        workspaceRoot: ANDROID_WORKSPACE_ROOT,
        javaHome: ANDROID_JAVA_HOME,
        buildTimeoutMs: 900000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
    }),
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-0',
    env: {},
  });

  assert(snapshot.android !== undefined, 'Complete Android config should be present in the snapshot');
  assertEqual(snapshot.android.workspaceRoot, path.resolve(ANDROID_WORKSPACE_ROOT), 'Android workspaceRoot should be normalized');
  assertEqual(snapshot.android.javaHome, path.resolve(ANDROID_JAVA_HOME), 'Android javaHome should be normalized');
  assertEqual(snapshot.android.buildTimeoutMs, 900000, 'Android positive integer fields should be preserved');
}

async function testVersionAndWorkspacesAreRequired(): Promise<void> {
  await expectValidationError(
    { workspaces: [workspace(0)] },
    'version must be the number 1',
    'version',
  );
  await expectValidationError(
    globalConfig([workspace(0)], { version: 2 }),
    'version must be the number 1',
    'version',
  );
  await expectValidationError(
    { version: 1 },
    'workspaces must be a non-empty array',
    'workspaces',
  );
  await expectValidationError(
    { version: 1, workspaces: 'not-array' },
    'workspaces must be a non-empty array',
    'workspaces',
  );
  await expectValidationError(
    { version: 1, workspaces: [] },
    'workspaces must contain at least one workspace',
    'workspaces',
  );
}

async function testUnknownFieldsAreRejected(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0)], { legacy: true }),
    'Unknown config field legacy',
    'legacy',
  );
  await expectValidationError(
    globalConfig([workspace(0, { legacy: true })]),
    'Unknown config field workspaces[0].legacy',
    'workspaces[0].legacy',
  );
  await expectValidationError(
    globalConfig([workspace(0, {
      android: {
        workspaceRoot: ANDROID_WORKSPACE_ROOT,
        javaHome: ANDROID_JAVA_HOME,
        buildTimeoutMs: 900000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
        legacy: true,
      },
    })]),
    'Unknown config field workspaces[0].android.legacy',
    'workspaces[0].android.legacy',
  );
}

async function testWorkspaceIdValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { id: undefined })]),
    'workspaces[0].id is required',
    'workspaces[0].id',
  );
  await expectValidationError(
    globalConfig([workspace(0, { id: '   ' })]),
    'workspaces[0].id must be a non-empty string',
    'workspaces[0].id',
  );
  await expectValidationError(
    globalConfig([
      workspace(0, { id: 'duplicate' }),
      workspace(1, { id: 'duplicate' }),
    ]),
    'workspace id "duplicate" must be unique',
    'workspaces[1].id',
  );
}

async function testWorkspacePortValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { port: 0 })]),
    'workspaces[0].port must be a positive integer between 1 and 65535',
    'workspaces[0].port',
  );
  await expectValidationError(
    globalConfig([workspace(0, { port: 65536 })]),
    'workspaces[0].port must be a positive integer between 1 and 65535',
    'workspaces[0].port',
  );
  await expectValidationError(
    globalConfig([workspace(0, { port: '123abc' })]),
    'workspaces[0].port must be a positive integer between 1 and 65535',
    'workspaces[0].port',
  );
  await expectValidationError(
    globalConfig([workspace(0, { port: 1.5 })]),
    'workspaces[0].port must be a positive integer between 1 and 65535',
    'workspaces[0].port',
  );
  await expectValidationError(
    globalConfig([
      workspace(0, { port: 4100 }),
      workspace(1, { port: 4100 }),
    ]),
    'workspace port 4100 must be unique',
    'workspaces[1].port',
  );
}

async function testLineEndingValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { lineEnding: undefined })]),
    'workspaces[0].lineEnding is required',
    'workspaces[0].lineEnding',
  );
  await expectValidationError(
    globalConfig([workspace(0, { lineEnding: 'native' })]),
    'workspaces[0].lineEnding must be one of',
    'workspaces[0].lineEnding',
  );
}

async function testOtherRootDirsShapeValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { otherRootDirs: 'not-array' })]),
    'workspaces[0].otherRootDirs must be an array of non-empty strings',
    'workspaces[0].otherRootDirs',
  );
  await expectValidationError(
    globalConfig([workspace(0, { otherRootDirs: [WORKSPACE_B_DIR, 42] })]),
    'workspaces[0].otherRootDirs[1] must be a non-empty string',
    'workspaces[0].otherRootDirs[1]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { otherRootDirs: ['   '] })]),
    'workspaces[0].otherRootDirs[0] must be a non-empty string',
    'workspaces[0].otherRootDirs[0]',
  );
}

async function testLogsDirShapeAndPathValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { logsDir: '' })]),
    'workspaces[0].logsDir must be a non-empty string',
    'workspaces[0].logsDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { logsDir: 42 })]),
    'workspaces[0].logsDir must be a non-empty string',
    'workspaces[0].logsDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { logsDir: 'relative/logs' })]),
    'workspaces[0].logsDir must be an absolute local path',
    'workspaces[0].logsDir',
  );

  if (process.platform !== 'win32') {
    return;
  }

  const unsupportedWindowsPaths = [
    { name: 'UNC slash path', value: '//server/share/logs' },
    { name: 'UNC backslash path', value: '\\\\server\\share\\logs' },
    { name: 'namespace path', value: '\\\\?\\E:\\Logs' },
    { name: 'device namespace path', value: '\\\\.\\C:\\Logs' },
    { name: 'drive-relative path', value: 'C:logs' },
    { name: 'rooted without drive slash path', value: '/logs' },
    { name: 'rooted without drive backslash path', value: '\\logs' },
  ];

  for (const testCase of unsupportedWindowsPaths) {
    await expectValidationError(
      globalConfig([workspace(0, { logsDir: testCase.value })]),
      'workspaces[0].logsDir must be an absolute local path',
      'workspaces[0].logsDir',
    );
  }
}

async function testAndroidCompletenessAndStrictIntegers(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, {
      android: {
        workspaceRoot: ANDROID_WORKSPACE_ROOT,
        buildTimeoutMs: 900000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
    })]),
    'workspaces[0].android.javaHome is required',
    'workspaces[0].android.javaHome',
  );
  await expectValidationError(
    globalConfig([workspace(0, {
      android: {
        workspaceRoot: ANDROID_WORKSPACE_ROOT,
        javaHome: ANDROID_JAVA_HOME,
        buildTimeoutMs: '123abc',
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
    })]),
    'workspaces[0].android.buildTimeoutMs must be a positive integer',
    'workspaces[0].android.buildTimeoutMs',
  );
  await expectValidationError(
    globalConfig([workspace(0, {
      android: {
        workspaceRoot: ANDROID_WORKSPACE_ROOT,
        javaHome: ANDROID_JAVA_HOME,
        buildTimeoutMs: 900000,
        maxErrorBlockChars: 1.5,
        maxLogTailChars: 4000,
      },
    })]),
    'workspaces[0].android.maxErrorBlockChars must be a positive integer',
    'workspaces[0].android.maxErrorBlockChars',
  );
}

async function testEnvOverridesShapeValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: [], legacy: true } })]),
    'Unknown config field workspaces[0].envOverrides.legacy',
    'workspaces[0].envOverrides.legacy',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: {} })]),
    'workspaces[0].envOverrides.allowedFields is required',
    'workspaces[0].envOverrides.allowedFields',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: 'lineEnding' } })]),
    'workspaces[0].envOverrides.allowedFields must be an array of non-empty strings',
    'workspaces[0].envOverrides.allowedFields',
  );
}

async function testRootDirPathValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { rootDir: 'relative/root' })]),
    'workspaces[0].rootDir must be an absolute local path',
  );
  await expectValidationError(
    globalConfig([workspace(0, { rootDir: path.join(FIXTURES_DIR, 'missing') })]),
    'workspaces[0].rootDir does not exist',
  );
  await expectValidationError(
    globalConfig([workspace(0, { rootDir: NOT_DIRECTORY_PATH })]),
    'workspaces[0].rootDir must point to an existing directory',
  );
}

async function testUnselectedWorkspaceInvalidRootDirStillFails(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace(0),
    workspace(1, { rootDir: path.join(FIXTURES_DIR, 'missing-unselected') }),
  ]));

  const error = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-0',
      env: {},
    })
  );

  assertEqual(error.fieldPath, 'workspaces[1].rootDir', 'Global root validation should identify the invalid unselected workspace root');
  assertIncludes(error.message, 'workspaces[1].rootDir does not exist', 'Global validation should run before explicit workspace selection completes');
}

async function testUnselectedWorkspaceInvalidLogsDirStillFails(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace(0),
    workspace(1, { logsDir: 'relative-unselected-logs' }),
  ]));

  const error = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-0',
      env: {},
    })
  );

  assertEqual(error.fieldPath, 'workspaces[1].logsDir', 'Global schema validation should identify the invalid unselected workspace logsDir');
  assertIncludes(error.message, 'workspaces[1].logsDir must be an absolute local path', 'Global schema validation should run before explicit workspace selection completes');
}

async function testRootDirLexicalDuplicateAndNestedValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([
      workspace(0),
      workspace(1, { rootDir: `${WORKSPACE_A_DIR}${path.sep}` }),
    ]),
    'unique at the lexical path layer',
  );
  await expectValidationError(
    globalConfig([
      workspace(0),
      workspace(1, { rootDir: NESTED_A_DIR }),
    ]),
    'must not be nested at the lexical path layer',
  );

  if (process.platform === 'win32') {
    await expectValidationError(
      globalConfig([
        workspace(0, { rootDir: WORKSPACE_A_DIR.toUpperCase() }),
        workspace(1, { rootDir: WORKSPACE_A_DIR.toLowerCase() }),
      ]),
      'unique at the lexical path layer',
    );
  }
}

async function testRootDirRealpathDuplicateValidation(): Promise<void> {
  await resetFixtures();
  const linkPath = path.join(FIXTURES_DIR, 'link-to-workspace-a');
  const linkCreated = await createDirectoryLink(linkPath, WORKSPACE_A_DIR);
  if (!linkCreated) return;

  try {
    await writeGlobalConfig(globalConfig([
      workspace(0),
      workspace(1, { rootDir: linkPath }),
    ]));

    const error = captureConfigError(() => loadRuntimeConfig({ homeDir: HOME_DIR, env: {} }));
    assertIncludes(error.message, 'unique at the real path layer', 'Realpath duplicate roots should be rejected');
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function testRootDirRealpathNestedValidation(): Promise<void> {
  await resetFixtures();
  const linkPath = path.join(FIXTURES_DIR, 'link-to-nested-a');
  const linkCreated = await createDirectoryLink(linkPath, NESTED_A_DIR);
  if (!linkCreated) return;

  try {
    await writeGlobalConfig(globalConfig([
      workspace(0),
      workspace(1, { rootDir: linkPath }),
    ]));

    const error = captureConfigError(() => loadRuntimeConfig({ homeDir: HOME_DIR, env: {} }));
    assertIncludes(error.message, 'must not be nested at the real path layer', 'Realpath nested roots should be rejected');
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing global config schema validation',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'valid global config loads explicit workspace', run: testValidGlobalConfigLoadsExplicitWorkspace },
      { name: 'complete Android config is accepted', run: testCompleteAndroidConfigIsAccepted },
      { name: 'version and workspaces are required', run: testVersionAndWorkspacesAreRequired },
      { name: 'unknown fields are rejected', run: testUnknownFieldsAreRejected },
      { name: 'workspace id validation', run: testWorkspaceIdValidation },
      { name: 'workspace port validation', run: testWorkspacePortValidation },
      { name: 'lineEnding validation', run: testLineEndingValidation },
      { name: 'otherRootDirs shape validation', run: testOtherRootDirsShapeValidation },
      { name: 'logsDir shape and path validation', run: testLogsDirShapeAndPathValidation },
      { name: 'Android completeness and strict integers', run: testAndroidCompletenessAndStrictIntegers },
      { name: 'envOverrides shape validation', run: testEnvOverridesShapeValidation },
      { name: 'rootDir path validation', run: testRootDirPathValidation },
      { name: 'unselected workspace invalid rootDir still fails', run: testUnselectedWorkspaceInvalidRootDirStillFails },
      { name: 'unselected workspace invalid logsDir still fails', run: testUnselectedWorkspaceInvalidLogsDirStillFails },
      { name: 'rootDir lexical duplicate and nested validation', run: testRootDirLexicalDuplicateAndNestedValidation },
      { name: 'rootDir realpath duplicate validation', run: testRootDirRealpathDuplicateValidation },
      { name: 'rootDir realpath nested validation', run: testRootDirRealpathNestedValidation },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
