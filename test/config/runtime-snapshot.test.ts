import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  createEmptyRuntimeRulesConfig,
  loadRuntimeConfig,
  loadRuntimeConfigWithIdentity,
  type RuntimeToolExposure,
} from '../../src/config.js';
import { createRuntimeConfigSnapshot } from '../../src/config/runtime-snapshot.js';
import { createToolRuntimeContext } from '../../src/runtime/tool-context.js';
import type { ToolName } from '../../src/tools/names.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
  writeSplitConfigFixture,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'runtime-snapshot');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const WORKSPACE_CONFIG_FILE = path.join(CONFIG_DIR, 'workspace-0.json');
const DEFAULT_LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const PRIMARY_DIR = path.join(FIXTURES_DIR, 'primary');
const PRIMARY_CHILD_DIR = path.join(PRIMARY_DIR, 'child');
const ADDITIONAL_A_DIR = path.join(FIXTURES_DIR, 'additional-a');
const ADDITIONAL_A_CHILD_DIR = path.join(ADDITIONAL_A_DIR, 'child');
const ADDITIONAL_B_DIR = path.join(FIXTURES_DIR, 'additional-b');
const NOT_DIRECTORY_FILE = path.join(FIXTURES_DIR, 'not-a-directory.txt');
const MISSING_DIR = path.join(FIXTURES_DIR, 'missing');
const CONFIGURED_LOGS_DIR = path.join(FIXTURES_DIR, 'configured-logs');
const OVERRIDE_LOGS_DIR = path.join(FIXTURES_DIR, 'override-logs');
const ANDROID_WORKSPACE_DIR = path.join(FIXTURES_DIR, 'android-project');
const ANDROID_JAVA_HOME_DIR = path.join(FIXTURES_DIR, 'jbr');

interface InvalidOtherRootCase {
  readonly name: string;
  readonly otherRootDirs: readonly string[];
  readonly expectedFieldPath: string;
  readonly expectedMessage: string;
}

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(DEFAULT_LOGS_DIR, { recursive: true });
  await fs.mkdir(PRIMARY_CHILD_DIR, { recursive: true });
  await fs.mkdir(ADDITIONAL_A_CHILD_DIR, { recursive: true });
  await fs.mkdir(ADDITIONAL_B_DIR, { recursive: true });
  await fs.mkdir(CONFIGURED_LOGS_DIR, { recursive: true });
  await fs.mkdir(OVERRIDE_LOGS_DIR, { recursive: true });
  await fs.mkdir(ANDROID_WORKSPACE_DIR, { recursive: true });
  await fs.mkdir(ANDROID_JAVA_HOME_DIR, { recursive: true });
  await fs.writeFile(NOT_DIRECTORY_FILE, 'not a directory', 'utf-8');
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function writeGlobalConfig(config: unknown): Promise<void> {
  await writeSplitConfigFixture(CONFIG_FILE, config);
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
  assertEqual(snapshot.globalConfigFilePath, CONFIG_FILE, 'Snapshot should record the global config file path');
  assertEqual(snapshot.workspaceConfigFilePath, WORKSPACE_CONFIG_FILE, 'Snapshot should record the workspace config file path');
  assertEqual(snapshot.workspaceId, 'runtime-workspace', 'Snapshot should record selected workspace id');
  assertEqual(snapshot.host, '127.0.0.1', 'Snapshot should use the default IPv4 loopback host');
  assertEqual(snapshot.logsDir, DEFAULT_LOGS_DIR, 'Snapshot should use the default home dotdir logs dir');
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

  assertEqual(error.fieldPath, 'logsDir', 'Empty MCP_LOGS_DIR should identify the target config field');
  assertIncludes(error.message, 'MCP_LOGS_DIR must be a non-empty string', 'Empty MCP_LOGS_DIR should fail as an env value');
  assertIncludes(error.suggestion, 'Fix MCP_LOGS_DIR', 'Empty MCP_LOGS_DIR suggestion should point at the environment');
}

async function testMissingDefaultLogsDirFailsStartup(): Promise<void> {
  await resetFixtures();
  await fs.rm(DEFAULT_LOGS_DIR, { recursive: true, force: true });
  await writeGlobalConfig(globalConfig());

  const error = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'runtime-workspace',
      env: {},
    })
  );

  assertEqual(error.fieldPath, 'logsDir', 'Missing default logs root should identify the effective logsDir field');
  assertIncludes(error.message, 'does not exist or cannot be accessed', 'Missing default logs root should fail existing-directory policy');
  assertIncludes(error.suggestion, 'Create the default logs root', 'Missing default logs root suggestion should ask for directory creation');
}

async function testDefaultLogsDirMustBeDirectory(): Promise<void> {
  await resetFixtures();
  await fs.rm(DEFAULT_LOGS_DIR, { recursive: true, force: true });
  await fs.writeFile(DEFAULT_LOGS_DIR, 'not a directory', 'utf-8');
  await writeGlobalConfig(globalConfig());

  const error = captureConfigError(() =>
    loadRuntimeConfig({
      homeDir: HOME_DIR,
      workspaceId: 'runtime-workspace',
      env: {},
    })
  );

  assertEqual(error.fieldPath, 'logsDir', 'File default logs root should identify the effective logsDir field');
  assertIncludes(error.message, 'must point to an existing directory', 'File default logs root should fail directory policy');
  assertIncludes(error.suggestion, 'Create the default logs root', 'File default logs root suggestion should ask for a directory');
}

async function testSnapshotRejectsWhitespacePathPreconditions(): Promise<void> {
  await resetFixtures();
  const baseInput = {
    globalConfigFilePath: CONFIG_FILE,
    workspaceConfigFilePath: WORKSPACE_CONFIG_FILE,
    workspaceId: 'runtime-workspace',
    rootDir: PRIMARY_DIR,
    otherRootDirs: [ADDITIONAL_A_DIR],
    host: '127.0.0.1',
    port: 4801,
    lineEnding: 'lf' as const,
    logsDir: DEFAULT_LOGS_DIR,
    toolExposure: { mode: 'all' as const },
    rules: createEmptyRuntimeRulesConfig(),
    android: {
      workspaceRoot: ANDROID_WORKSPACE_DIR,
      javaHome: ANDROID_JAVA_HOME_DIR,
      buildTimeoutMs: 900000,
      maxErrorBlockChars: 2500,
      maxLogTailChars: 4000,
    },
  };
  const cases = [
    {
      name: 'rootDir',
      run: () =>
        createRuntimeConfigSnapshot({ ...baseInput, rootDir: `${PRIMARY_DIR} ` }),
      expectedFieldPath: 'rootDir',
    },
    {
      name: 'otherRootDirs',
      run: () =>
        createRuntimeConfigSnapshot({ ...baseInput, otherRootDirs: [`${ADDITIONAL_A_DIR} `] }),
      expectedFieldPath: 'otherRootDirs[0]',
    },
    {
      name: 'logsDir',
      run: () =>
        createRuntimeConfigSnapshot({ ...baseInput, logsDir: `${DEFAULT_LOGS_DIR} ` }),
      expectedFieldPath: 'logsDir',
    },
    {
      name: 'android.workspaceRoot',
      run: () =>
        createRuntimeConfigSnapshot({
          ...baseInput,
          android: { ...baseInput.android, workspaceRoot: `${ANDROID_WORKSPACE_DIR} ` },
        }),
      expectedFieldPath: 'android.workspaceRoot',
    },
    {
      name: 'android.javaHome',
      run: () =>
        createRuntimeConfigSnapshot({
          ...baseInput,
          android: { ...baseInput.android, javaHome: `${ANDROID_JAVA_HOME_DIR} ` },
        }),
      expectedFieldPath: 'android.javaHome',
    },
  ];

  for (const testCase of cases) {
    const error = captureConfigError(testCase.run);

    assertEqual(error.fieldPath, testCase.expectedFieldPath, `${testCase.name} precondition should identify the offending field`);
    assertIncludes(error.message, 'must not contain leading or trailing whitespace', `${testCase.name} precondition should reject whitespace instead of trimming`);
    assertIncludes(error.suggestion, 'Snapshot path-like inputs', `${testCase.name} precondition should explain the snapshot seam contract`);
  }
}

async function testLogsAndAndroidPathsStayOutsideAllowedRoots(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig({
    logsDir: CONFIGURED_LOGS_DIR,
    otherRootDirs: [ADDITIONAL_A_DIR],
    android: {
      workspaceRoot: ANDROID_WORKSPACE_DIR,
      javaHome: ANDROID_JAVA_HOME_DIR,
      buildTimeoutMs: 900000,
      maxErrorBlockChars: 2500,
      maxLogTailChars: 4000,
    },
  }));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'runtime-workspace',
    env: {},
  });
  const allowedRootPaths = snapshot.pathSafetyContext.allowedRoots.map((root) => root.rootDir);

  assertEqual(snapshot.logsDir, path.resolve(CONFIGURED_LOGS_DIR), 'Snapshot should resolve configured logsDir for runtime use');
  assert(snapshot.android !== undefined, 'Fixture should include Android config');
  assertEqual(snapshot.android.workspaceRoot, path.resolve(ANDROID_WORKSPACE_DIR), 'Snapshot should resolve Android workspaceRoot');
  assertEqual(snapshot.android.javaHome, path.resolve(ANDROID_JAVA_HOME_DIR), 'Snapshot should resolve Android javaHome');
  assert(!allowedRootPaths.includes(path.resolve(CONFIGURED_LOGS_DIR)), 'logsDir should not become an allowed root');
  assert(!allowedRootPaths.includes(path.resolve(ANDROID_WORKSPACE_DIR)), 'android.workspaceRoot should not become an allowed root');
  assert(!allowedRootPaths.includes(path.resolve(ANDROID_JAVA_HOME_DIR)), 'android.javaHome should not become an allowed root');
}

async function testInvalidOtherRootDirsReturnStructuredErrors(): Promise<void> {
  const cases: InvalidOtherRootCase[] = [
    {
      name: 'duplicates primary root',
      otherRootDirs: [`${PRIMARY_DIR}${path.sep}`],
      expectedFieldPath: 'otherRootDirs[0]',
      expectedMessage: 'rootDir and otherRootDirs[0]',
    },
    {
      name: 'is nested under primary root',
      otherRootDirs: [PRIMARY_CHILD_DIR],
      expectedFieldPath: 'otherRootDirs[0]',
      expectedMessage: 'otherRootDirs[0]',
    },
    {
      name: 'duplicates another additional root',
      otherRootDirs: [ADDITIONAL_A_DIR, `${ADDITIONAL_A_DIR}${path.sep}`],
      expectedFieldPath: 'otherRootDirs[1]',
      expectedMessage: 'otherRootDirs[0] and otherRootDirs[1]',
    },
    {
      name: 'is nested under another additional root',
      otherRootDirs: [ADDITIONAL_A_DIR, ADDITIONAL_A_CHILD_DIR],
      expectedFieldPath: 'otherRootDirs[1]',
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

    assertEqual(error.fieldPath, 'otherRootDirs[1]', 'Realpath duplicate should identify the symlinked additional root');
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

    assertEqual(error.fieldPath, 'otherRootDirs[1]', 'Realpath nested root should identify the symlinked nested additional root');
    assertIncludes(error.message, 'must not be nested at the real path layer', 'Realpath nested additional roots should be rejected');
    assertIncludes(error.message, 'otherRootDirs[1]', 'Realpath nested error should mention the nested additional root');
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function testSnapshotHoldsRequestHeaderRules(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig({
    rules: {
      requestHeaders: [
        {
          match: { 'X-Client': 'android-studio' },
          enable: ['structuredContentDup'],
        },
      ],
    },
  }));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'runtime-workspace',
    env: {},
  });

  assertEqual(snapshot.rules.requestHeaders.length, 1, 'Snapshot should hold selected workspace request header rules');
  assertEqual(snapshot.rules.requestHeaders[0]?.match[0]?.name, 'x-client', 'Snapshot rules should contain normalized header names');
  assertEqual(snapshot.rules.requestHeaders[0]?.enable[0], 'structuredContentDup', 'Snapshot rules should preserve enabled features');
}

async function testSnapshotGraphIsDeepFrozen(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig({
    otherRootDirs: [ADDITIONAL_A_DIR],
    rules: {
      requestHeaders: [
        {
          match: { 'X-Client': 'android-studio' },
          enable: ['structuredContentDup'],
        },
      ],
    },
  }));

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
  assertEqual(snapshot.logsDir, DEFAULT_LOGS_DIR, 'Frozen snapshot should keep logsDir immutable');
  assert(Object.isFrozen(snapshot.otherRootDirs), 'Snapshot otherRootDirs should be frozen');
  assert(Object.isFrozen(snapshot.fileAccessPolicyFiles), 'Snapshot policy file metadata should be frozen');
  for (const root of snapshot.fileAccessPolicyFiles) {
    assert(Object.isFrozen(root), 'Each policy file metadata entry should be frozen');
    assert(Object.isFrozen(root.ignoreFiles), 'Each ignore file metadata array should be frozen');
    assert(Object.isFrozen(root.denyFiles), 'Each deny file metadata array should be frozen');
  }
  assert(Object.isFrozen(snapshot.rules), 'Snapshot rules object should be frozen');
  assert(Object.isFrozen(snapshot.rules.requestHeaders), 'Snapshot requestHeaders array should be frozen');
  const firstRule = snapshot.rules.requestHeaders[0];
  assert(firstRule !== undefined, 'Fixture should include a request header rule');
  assert(Object.isFrozen(firstRule), 'Each request header rule should be frozen');
  assert(Object.isFrozen(firstRule.match), 'Rule match array should be frozen');
  assert(Object.isFrozen(firstRule.match[0]), 'Each rule match condition should be frozen');
  assert(Object.isFrozen(firstRule.enable), 'Rule enable array should be frozen');
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
    WORKSPACE_CONFIG_FILE,
    'Android missing message should point to the selected workspace config file',
  );
  assertIncludes(
    context.missingAndroidConfigMessage,
    'Add an android section to that workspace',
    'Android missing message should point at the selected workspace android section',
  );
}

async function testToolExposureSnapshotCloneAndOwnership(): Promise<void> {
  await resetFixtures();

  const createSnapshot = (toolExposure: RuntimeToolExposure) =>
    createRuntimeConfigSnapshot({
      globalConfigFilePath: CONFIG_FILE,
      workspaceConfigFilePath: WORKSPACE_CONFIG_FILE,
      workspaceId: 'runtime-workspace',
      rootDir: PRIMARY_DIR,
      otherRootDirs: [],
      host: '127.0.0.1',
      port: 4801,
      lineEnding: 'lf',
      logsDir: DEFAULT_LOGS_DIR,
      toolExposure,
      rules: createEmptyRuntimeRulesConfig(),
    });

  const allInput: RuntimeToolExposure = { mode: 'all' };
  const allSnapshot = createSnapshot(allInput);
  assert(allSnapshot.toolExposure !== allInput, 'All exposure should be cloned into a new object');
  assert(Object.isFrozen(allSnapshot.toolExposure), 'All exposure clone should be frozen');
  assert(!Object.isFrozen(allInput), 'Snapshot construction should not freeze the caller all exposure object');

  for (const mode of ['allow', 'disable'] as const) {
    const sourceNames: ToolName[] = ['read_file'];
    const sourceExposure: RuntimeToolExposure = { mode, names: sourceNames };
    const snapshot = createSnapshot(sourceExposure);

    assert(snapshot.toolExposure !== sourceExposure, `${mode} exposure should be cloned into a new object`);
    assert(snapshot.toolExposure.mode !== 'all', `${mode} snapshot should keep its names`);
    assert(snapshot.toolExposure.names !== sourceNames, `${mode} names should be cloned into a new array`);
    assert(Object.isFrozen(snapshot.toolExposure), `${mode} exposure clone should be frozen`);
    assert(Object.isFrozen(snapshot.toolExposure.names), `${mode} names clone should be frozen`);
    assert(!Object.isFrozen(sourceExposure), `Snapshot construction should not freeze caller ${mode} exposure`);
    assert(!Object.isFrozen(sourceNames), `Snapshot construction should not freeze caller ${mode} names`);

    sourceNames.push('ask_user');
    assertEqual(
      snapshot.toolExposure.names.join(','),
      'read_file',
      `${mode} snapshot should not retain the caller names array`,
    );
  }
}

async function testRuntimeOnlyMetadataStaysOutOfIdentityAndToolContext(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig({
    tools: { allowed: ['read_file'] },
  }));

  const loaded = loadRuntimeConfigWithIdentity({
    homeDir: HOME_DIR,
    workspaceId: 'runtime-workspace',
    env: {},
  });
  const identity = loaded.identity as unknown as Record<string, unknown>;
  const context = createToolRuntimeContext(loaded.snapshot) as unknown as Record<string, unknown>;

  assert(!('toolExposure' in identity), 'RuntimeConfigIdentity should not contain toolExposure');
  assert(!('toolExposure' in context), 'ToolRuntimeContext should not contain toolExposure');
  assert(
    !('fileAccessPolicyFiles' in context),
    'ToolRuntimeContext should not expose file access policy file paths',
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
      { name: 'missing default logsDir fails startup', run: testMissingDefaultLogsDirFailsStartup },
      { name: 'default logsDir must be a directory', run: testDefaultLogsDirMustBeDirectory },
      { name: 'snapshot rejects whitespace path preconditions', run: testSnapshotRejectsWhitespacePathPreconditions },
      { name: 'logsDir and Android paths stay outside allowed roots', run: testLogsAndAndroidPathsStayOutsideAllowedRoots },
      { name: 'invalid selected otherRootDirs return structured errors', run: testInvalidOtherRootDirsReturnStructuredErrors },
      { name: 'selected otherRootDirs reject realpath duplicates', run: testOtherRootDirsRealpathDuplicateValidation },
      { name: 'selected otherRootDirs reject realpath nesting', run: testOtherRootDirsRealpathNestedValidation },
      { name: 'snapshot holds request header rules', run: testSnapshotHoldsRequestHeaderRules },
      { name: 'deep-freezes snapshot graph', run: testSnapshotGraphIsDeepFrozen },
      { name: 'tool runtime context uses snapshot Android message', run: testToolRuntimeContextUsesSnapshotAndroidMessage },
      { name: 'tool exposure snapshot clone owns frozen data', run: testToolExposureSnapshotCloneAndOwnership },
      { name: 'runtime-only metadata stays out of identity and tool context', run: testRuntimeOnlyMetadataStaysOutOfIdentityAndToolContext },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
