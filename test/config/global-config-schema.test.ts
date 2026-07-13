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
const DEFAULT_LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const WORKSPACE_A_DIR = path.join(FIXTURES_DIR, 'workspace-a');
const WORKSPACE_B_DIR = path.join(FIXTURES_DIR, 'workspace-b');
const WORKSPACE_C_DIR = path.join(FIXTURES_DIR, 'workspace-c');
const WORKSPACE_WITH_SPACE_DIR = path.join(FIXTURES_DIR, 'workspace with spaces');
const NESTED_A_DIR = path.join(WORKSPACE_A_DIR, 'nested');
const NOT_DIRECTORY_PATH = path.join(FIXTURES_DIR, 'not-a-directory.txt');
const ANDROID_WORKSPACE_ROOT = path.join(FIXTURES_DIR, 'android-project');
const ANDROID_JAVA_HOME = path.join(FIXTURES_DIR, 'jbr');
const LOGS_DIR = path.join(FIXTURES_DIR, 'service-logs');
const LOGS_WITH_SPACE_DIR = path.join(FIXTURES_DIR, 'service logs with spaces');
const ANDROID_NUMERIC_FIELDS = [
  'buildTimeoutMs',
  'maxErrorBlockChars',
  'maxLogTailChars',
] as const;

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(DEFAULT_LOGS_DIR, { recursive: true });
  await fs.mkdir(NESTED_A_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_B_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_C_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_WITH_SPACE_DIR, { recursive: true });
  await fs.mkdir(ANDROID_WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(ANDROID_JAVA_HOME, { recursive: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });
  await fs.mkdir(LOGS_WITH_SPACE_DIR, { recursive: true });
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
  const rootDirs = [WORKSPACE_A_DIR, WORKSPACE_B_DIR, WORKSPACE_C_DIR, WORKSPACE_WITH_SPACE_DIR];

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
  assertEqual(snapshot.host, '127.0.0.1', 'Snapshot should default host to IPv4 loopback');
  assertEqual(snapshot.logsDir, path.resolve(LOGS_DIR), 'Snapshot should use the selected workspace logsDir');
  assertEqual(snapshot.otherRootDirs.length, 0, 'otherRootDirs should default to an empty array');
  assert(snapshot.android === undefined, 'Android config should be optional');
}

async function testPathLikeFieldsAllowInternalSpaces(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace(3, {
      id: 'space-workspace',
      logsDir: LOGS_WITH_SPACE_DIR,
      otherRootDirs: [WORKSPACE_B_DIR],
    }),
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'space-workspace',
    env: {},
  });

  assertEqual(snapshot.rootDir, path.resolve(WORKSPACE_WITH_SPACE_DIR), 'Path policy should allow internal spaces in rootDir');
  assertEqual(snapshot.logsDir, path.resolve(LOGS_WITH_SPACE_DIR), 'Path policy should allow internal spaces in logsDir');
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
    [],
    'Config file must contain a JSON object',
  );
  await expectValidationError(
    { workspaces: [workspace(0)] },
    'version must be the number 1',
    'version',
  );
  await expectValidationError(
    globalConfig([workspace(0)], { version: '1' }),
    'version must be the number 1',
    'version',
  );
  await expectValidationError(
    globalConfig([workspace(0)], { version: 2 }),
    'version must be the number 1',
    'version',
  );
  await expectValidationError(
    globalConfig([workspace(0)], { version: 1.1 }),
    'version must be the number 1',
    'version',
  );
  await expectValidationError(
    globalConfig([workspace(0)], { version: true }),
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
  await expectValidationError(
    globalConfig([42]),
    'workspaces[0] must be a JSON object',
    'workspaces[0]',
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
    globalConfig([workspace(0, { id: 42 })]),
    'workspaces[0].id must be a string',
    'workspaces[0].id',
  );
  await expectValidationError(
    globalConfig([workspace(0, { id: '' })]),
    'workspaces[0].id must be a non-empty string',
    'workspaces[0].id',
  );
  await expectValidationError(
    globalConfig([workspace(0, { id: '   ' })]),
    'workspaces[0].id must be a non-empty string',
    'workspaces[0].id',
  );
  await expectValidationError(
    globalConfig([workspace(0, { id: ' workspace_0' })]),
    'workspaces[0].id must not contain leading or trailing whitespace',
    'workspaces[0].id',
  );
  await expectValidationError(
    globalConfig([workspace(0, { id: 'workspace_0 ' })]),
    'workspaces[0].id must not contain leading or trailing whitespace',
    'workspaces[0].id',
  );

  await resetFixtures();
  await writeGlobalConfig(globalConfig([workspace(0, { id: 'workspace_0' })]));
  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace_0',
    env: {},
  });
  assertEqual(snapshot.workspaceId, 'workspace_0', 'Workspace id should allow underscores');

  for (const invalidId of [
    'Workspace-0',
    '_workspace',
    '-workspace',
    'team/alpha',
    'team.alpha',
    'team alpha',
    'a'.repeat(65),
  ]) {
    await expectValidationError(
      globalConfig([workspace(0, { id: invalidId })]),
      'workspaces[0].id must be 1-64 characters, start with a lowercase letter or digit',
      'workspaces[0].id',
    );
  }

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
  for (const invalidPort of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 65536]) {
    await expectValidationError(
      globalConfig([workspace(0, { port: invalidPort })]),
      'workspaces[0].port must be a JSON number positive integer between 1 and 65535',
      'workspaces[0].port',
    );
  }

  for (const invalidPort of ['3100', ' 3100', '3100 ', '123abc']) {
    await expectValidationError(
      globalConfig([workspace(0, { port: invalidPort })]),
      'workspaces[0].port must be a JSON number positive integer between 1 and 65535',
      'workspaces[0].port',
    );
  }

  await expectValidationError(
    globalConfig([
      workspace(0, { port: 4100 }),
      workspace(1, { port: 4100 }),
    ]),
    'workspace port 4100 must be unique',
    'workspaces[1].port',
  );
}

async function testWorkspaceHostValidation(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace(0, { host: '::1' }),
    workspace(1, { host: '::1' }),
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-1',
    env: {},
  });
  assertEqual(snapshot.host, '::1', 'IPv6 hosts should load and duplicate hosts should be allowed');

  const invalidHosts = [
    { value: 42, message: 'workspaces[0].host must be a string' },
    { value: '', message: 'workspaces[0].host must be a non-empty string' },
    { value: '   ', message: 'workspaces[0].host must be a non-empty string' },
    {
      value: ' 127.0.0.1',
      message: 'workspaces[0].host must not contain leading or trailing whitespace',
    },
    {
      value: '127.0.0.1 ',
      message: 'workspaces[0].host must not contain leading or trailing whitespace',
    },
    { value: 'localhost', message: 'workspaces[0].host must be an IPv4 or IPv6 address' },
    { value: 'example.com', message: 'workspaces[0].host must be an IPv4 or IPv6 address' },
    { value: '127.0.0.1:3100', message: 'workspaces[0].host must be an IPv4 or IPv6 address' },
    { value: '999.1.1.1', message: 'workspaces[0].host must be an IPv4 or IPv6 address' },
  ] as const;

  for (const invalidHost of invalidHosts) {
    await expectValidationError(
      globalConfig([workspace(0, { host: invalidHost.value })]),
      invalidHost.message,
      'workspaces[0].host',
    );
  }
}

async function testLineEndingValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { lineEnding: undefined })]),
    'workspaces[0].lineEnding is required',
    'workspaces[0].lineEnding',
  );
  await expectValidationError(
    globalConfig([workspace(0, { lineEnding: 42 })]),
    'workspaces[0].lineEnding must be a string',
    'workspaces[0].lineEnding',
  );
  await expectValidationError(
    globalConfig([workspace(0, { lineEnding: '' })]),
    'workspaces[0].lineEnding must be a non-empty string',
    'workspaces[0].lineEnding',
  );
  await expectValidationError(
    globalConfig([workspace(0, { lineEnding: '   ' })]),
    'workspaces[0].lineEnding must be a non-empty string',
    'workspaces[0].lineEnding',
  );
  await expectValidationError(
    globalConfig([workspace(0, { lineEnding: ' lf' })]),
    'workspaces[0].lineEnding must not contain leading or trailing whitespace',
    'workspaces[0].lineEnding',
  );
  await expectValidationError(
    globalConfig([workspace(0, { lineEnding: 'lf ' })]),
    'workspaces[0].lineEnding must not contain leading or trailing whitespace',
    'workspaces[0].lineEnding',
  );
  await expectValidationError(
    globalConfig([workspace(0, { lineEnding: 'LF' })]),
    'workspaces[0].lineEnding must be one of',
    'workspaces[0].lineEnding',
  );
  await expectValidationError(
    globalConfig([workspace(0, { lineEnding: 'native' })]),
    'workspaces[0].lineEnding must be one of',
    'workspaces[0].lineEnding',
  );
}

async function testOtherRootDirsPathValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { otherRootDirs: 'not-array' })]),
    'workspaces[0].otherRootDirs must be an array of non-empty strings',
    'workspaces[0].otherRootDirs',
  );
  await expectValidationError(
    globalConfig([workspace(0, { otherRootDirs: [WORKSPACE_B_DIR, 42] })]),
    'workspaces[0].otherRootDirs[1] must be a string',
    'workspaces[0].otherRootDirs[1]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { otherRootDirs: ['   '] })]),
    'workspaces[0].otherRootDirs[0] must be a non-empty string',
    'workspaces[0].otherRootDirs[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { otherRootDirs: [` ${WORKSPACE_B_DIR}`] })]),
    'workspaces[0].otherRootDirs[0] must not contain leading or trailing whitespace',
    'workspaces[0].otherRootDirs[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { otherRootDirs: [`${WORKSPACE_B_DIR} `] })]),
    'workspaces[0].otherRootDirs[0] must not contain leading or trailing whitespace',
    'workspaces[0].otherRootDirs[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { otherRootDirs: ['relative-other-root'] })]),
    'workspaces[0].otherRootDirs[0] must be an absolute local path',
    'workspaces[0].otherRootDirs[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { otherRootDirs: [path.join(FIXTURES_DIR, 'missing-other-root')] })]),
    'workspaces[0].otherRootDirs[0] does not exist or cannot be accessed',
    'workspaces[0].otherRootDirs[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { otherRootDirs: [NOT_DIRECTORY_PATH] })]),
    'workspaces[0].otherRootDirs[0] must point to an existing directory',
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
    globalConfig([workspace(0, { logsDir: '   ' })]),
    'workspaces[0].logsDir must be a non-empty string',
    'workspaces[0].logsDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { logsDir: 42 })]),
    'workspaces[0].logsDir must be a string',
    'workspaces[0].logsDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { logsDir: ` ${LOGS_DIR}` })]),
    'workspaces[0].logsDir must not contain leading or trailing whitespace',
    'workspaces[0].logsDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { logsDir: `${LOGS_DIR} ` })]),
    'workspaces[0].logsDir must not contain leading or trailing whitespace',
    'workspaces[0].logsDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { logsDir: 'relative/logs' })]),
    'workspaces[0].logsDir must be an absolute local path',
    'workspaces[0].logsDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { logsDir: path.join(FIXTURES_DIR, 'missing-logs') })]),
    'workspaces[0].logsDir does not exist or cannot be accessed',
    'workspaces[0].logsDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { logsDir: NOT_DIRECTORY_PATH })]),
    'workspaces[0].logsDir must point to an existing directory',
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
    { name: 'tilde path', value: '~/logs' },
  ];

  for (const testCase of unsupportedWindowsPaths) {
    await expectValidationError(
      globalConfig([workspace(0, { logsDir: testCase.value })]),
      testCase.name === 'tilde path'
        ? 'workspaces[0].logsDir must be an absolute local path and cannot use ~ expansion'
        : 'workspaces[0].logsDir must be an absolute local path',
      'workspaces[0].logsDir',
    );
  }
}

async function testAndroidCompletenessAndStrictIntegers(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { android: 'enabled' })]),
    'workspaces[0].android must be a JSON object when configured',
    'workspaces[0].android',
  );
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
        workspaceRoot: 'relative-android-project',
        javaHome: ANDROID_JAVA_HOME,
        buildTimeoutMs: 900000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
    })]),
    'workspaces[0].android.workspaceRoot must be an absolute local path',
    'workspaces[0].android.workspaceRoot',
  );
  await expectValidationError(
    globalConfig([workspace(0, {
      android: {
        workspaceRoot: `${ANDROID_WORKSPACE_ROOT} `,
        javaHome: ANDROID_JAVA_HOME,
        buildTimeoutMs: 900000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
    })]),
    'workspaces[0].android.workspaceRoot must not contain leading or trailing whitespace',
    'workspaces[0].android.workspaceRoot',
  );
  await expectValidationError(
    globalConfig([workspace(0, {
      android: {
        workspaceRoot: ANDROID_WORKSPACE_ROOT,
        javaHome: path.join(FIXTURES_DIR, 'missing-jbr'),
        buildTimeoutMs: 900000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
    })]),
    'workspaces[0].android.javaHome does not exist or cannot be accessed',
    'workspaces[0].android.javaHome',
  );
  await expectValidationError(
    globalConfig([workspace(0, {
      android: {
        workspaceRoot: ANDROID_WORKSPACE_ROOT,
        javaHome: NOT_DIRECTORY_PATH,
        buildTimeoutMs: 900000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
    })]),
    'workspaces[0].android.javaHome must point to an existing directory',
    'workspaces[0].android.javaHome',
  );

  const invalidNumericValues: Record<typeof ANDROID_NUMERIC_FIELDS[number], unknown> = {
    buildTimeoutMs: '900000',
    maxErrorBlockChars: 1.5,
    maxLogTailChars: 0,
  };
  for (const field of ANDROID_NUMERIC_FIELDS) {
    await expectValidationError(
      globalConfig([workspace(0, {
        android: {
          workspaceRoot: ANDROID_WORKSPACE_ROOT,
          javaHome: ANDROID_JAVA_HOME,
          buildTimeoutMs: 900000,
          maxErrorBlockChars: 2500,
          maxLogTailChars: 4000,
          [field]: invalidNumericValues[field],
        },
      })]),
      `workspaces[0].android.${field} must be a JSON number positive integer`,
      `workspaces[0].android.${field}`,
    );
  }
}

async function testEnvOverridesSelectorValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: [], legacy: true } })]),
    'Unknown config field workspaces[0].envOverrides.legacy',
    'workspaces[0].envOverrides.legacy',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: 'lineEnding' })]),
    'workspaces[0].envOverrides must be a JSON object when configured',
    'workspaces[0].envOverrides',
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
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: [42] } })]),
    'workspaces[0].envOverrides.allowedFields[0] must be a string',
    'workspaces[0].envOverrides.allowedFields[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: [''] } })]),
    'workspaces[0].envOverrides.allowedFields[0] must be a non-empty string',
    'workspaces[0].envOverrides.allowedFields[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: ['   '] } })]),
    'workspaces[0].envOverrides.allowedFields[0] must be a non-empty string',
    'workspaces[0].envOverrides.allowedFields[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: [' logsDir'] } })]),
    'workspaces[0].envOverrides.allowedFields[0] must not contain leading or trailing whitespace',
    'workspaces[0].envOverrides.allowedFields[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: ['logsDir '] } })]),
    'workspaces[0].envOverrides.allowedFields[0] must not contain leading or trailing whitespace',
    'workspaces[0].envOverrides.allowedFields[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: ['lineEnding', 'lineEnding'] } })]),
    'envOverrides.allowedFields contains duplicate field "lineEnding"',
    'workspaces[0].envOverrides.allowedFields[1]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: ['rootDir'] } })]),
    'envOverrides.allowedFields contains forbidden field "rootDir"',
    'workspaces[0].envOverrides.allowedFields[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: ['host'] } })]),
    'envOverrides.allowedFields contains forbidden field "host"',
    'workspaces[0].envOverrides.allowedFields[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: ['android.unknown'] } })]),
    'envOverrides.allowedFields contains unknown field "android.unknown"',
    'workspaces[0].envOverrides.allowedFields[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: ['MCP_LOGS_DIR'] } })]),
    'envOverrides.allowedFields contains environment variable name "MCP_LOGS_DIR"',
    'workspaces[0].envOverrides.allowedFields[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: ['MCP_HOST'] } })]),
    'envOverrides.allowedFields contains environment variable name "MCP_HOST"',
    'workspaces[0].envOverrides.allowedFields[0]',
  );
  await expectValidationError(
    globalConfig([workspace(0, { envOverrides: { allowedFields: ['android.javaHome'] } })]),
    'android is not configured',
    'workspaces[0].envOverrides.allowedFields[0]',
  );

  await resetFixtures();
  await writeGlobalConfig(globalConfig([workspace(0, { envOverrides: { allowedFields: [] } })]));
  const snapshot = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-0', env: {} });
  assertEqual(snapshot.workspaceId, 'workspace-0', 'Empty allowedFields should be legal and disable env override');
}

async function testUnselectedWorkspaceInvalidAllowlistStillFails(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig([
    workspace(0),
    workspace(1, { envOverrides: { allowedFields: ['android.javaHome'] } }),
  ]));

  const error = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-0',
      env: {},
    })
  );

  assertEqual(error.fieldPath, 'workspaces[1].envOverrides.allowedFields[0]', 'Schema validation should cover unselected workspace allowlists');
  assertIncludes(error.message, 'android is not configured', 'Android allowlist base config should be checked before workspace selection finishes');
}

async function testRootDirPathValidation(): Promise<void> {
  await expectValidationError(
    globalConfig([workspace(0, { rootDir: 42 })]),
    'workspaces[0].rootDir must be a string',
    'workspaces[0].rootDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { rootDir: '' })]),
    'workspaces[0].rootDir must be a non-empty string',
    'workspaces[0].rootDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { rootDir: ` ${WORKSPACE_A_DIR}` })]),
    'workspaces[0].rootDir must not contain leading or trailing whitespace',
    'workspaces[0].rootDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { rootDir: `${WORKSPACE_A_DIR} ` })]),
    'workspaces[0].rootDir must not contain leading or trailing whitespace',
    'workspaces[0].rootDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { rootDir: 'relative/root' })]),
    'workspaces[0].rootDir must be an absolute local path',
    'workspaces[0].rootDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { rootDir: path.join(FIXTURES_DIR, 'missing') })]),
    'workspaces[0].rootDir does not exist or cannot be accessed',
    'workspaces[0].rootDir',
  );
  await expectValidationError(
    globalConfig([workspace(0, { rootDir: NOT_DIRECTORY_PATH })]),
    'workspaces[0].rootDir must point to an existing directory',
    'workspaces[0].rootDir',
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
      { name: 'path-like fields allow internal spaces', run: testPathLikeFieldsAllowInternalSpaces },
      { name: 'complete Android config is accepted', run: testCompleteAndroidConfigIsAccepted },
      { name: 'version and workspaces are required', run: testVersionAndWorkspacesAreRequired },
      { name: 'unknown fields are rejected', run: testUnknownFieldsAreRejected },
      { name: 'workspace id validation', run: testWorkspaceIdValidation },
      { name: 'workspace port validation', run: testWorkspacePortValidation },
      { name: 'workspace host validation', run: testWorkspaceHostValidation },
      { name: 'lineEnding validation', run: testLineEndingValidation },
      { name: 'otherRootDirs path validation', run: testOtherRootDirsPathValidation },
      { name: 'logsDir shape and path validation', run: testLogsDirShapeAndPathValidation },
      { name: 'Android completeness and strict integers', run: testAndroidCompletenessAndStrictIntegers },
      { name: 'envOverrides selector validation', run: testEnvOverridesSelectorValidation },
      { name: 'unselected workspace invalid allowlist still fails', run: testUnselectedWorkspaceInvalidAllowlistStillFails },
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
