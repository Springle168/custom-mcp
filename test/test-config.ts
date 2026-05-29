import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachValidatedPathSafetyContext,
  buildConfig,
  type Config,
  type ConfigSource,
} from '../src/config.js';
import { assert, assertEqual, runTestSuite } from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FIXTURES_DIR = path.join(__dirname, 'fixtures', 'config-roots');
const PRIMARY_DIR = path.join(CONFIG_FIXTURES_DIR, 'primary');
const ADDITIONAL_DIR = path.join(CONFIG_FIXTURES_DIR, 'additional');
const NESTED_DIR = path.join(PRIMARY_DIR, 'nested');
const ROOT_FILE = path.join(CONFIG_FIXTURES_DIR, 'not-a-directory.txt');

function createConfig(rootDir: string, otherRootDirs?: string[]): Config {
  return {
    rootDir,
    ...(otherRootDirs ? { otherRootDirs } : {}),
    lineEnding: 'auto',
    port: 3100,
  };
}

function assertThrowsIncludes(
  run: () => unknown,
  expectedMessage: string,
  message: string,
): void {
  try {
    run();
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    assert(
      text.includes(expectedMessage),
      `${message}. Expected message to include "${expectedMessage}", got "${text}"`,
    );
    return;
  }

  throw new Error(`Assertion failed: ${message}. Expected function to throw.`);
}

async function prepareFixtures(): Promise<void> {
  await fs.rm(CONFIG_FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(NESTED_DIR, { recursive: true });
  await fs.mkdir(ADDITIONAL_DIR, { recursive: true });
  await fs.writeFile(ROOT_FILE, 'not a directory\n', 'utf-8');
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(CONFIG_FIXTURES_DIR, { recursive: true, force: true });
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
    console.log(`  - Skipped symlink config assertion: ${error.message}`);
    return false;
  }
}

function testBlankMcpEnvFallsBackToFileConfig() {
  const fileConfig: ConfigSource = {
    rootDir: 'E:/Workspace/Project',
    lineEnding: 'crlf',
    port: 3200,
  };

  const config = buildConfig(fileConfig, {
    MCP_ROOT_DIR: '   ',
    MCP_LINE_ENDING: '   ',
    MCP_PORT: '   ',
  });

  assertEqual(config.rootDir, 'E:/Workspace/Project', 'Should keep file rootDir');
  assertEqual(config.lineEnding, 'crlf', 'Should keep file lineEnding');
  assertEqual(config.port, 3200, 'Should keep file port');
}

function testOtherRootDirsParsingDoesNotUseEnvOverride() {
  const fileConfig: ConfigSource = {
    rootDir: 'E:/Workspace/Project',
    otherRootDirs: [' E:/Workspace/Other ', 'D:/SharedWorkspace'],
    lineEnding: 'auto',
    port: 3100,
  };

  const config = buildConfig(fileConfig, {
    MCP_ROOT_DIR: 'E:/Workspace/Override',
    MCP_OTHER_ROOT_DIRS: 'E:/Ignored',
  });

  assertEqual(config.rootDir, 'E:/Workspace/Override', 'MCP_ROOT_DIR should override only rootDir');
  assertEqual(
    JSON.stringify(config.otherRootDirs),
    JSON.stringify(['E:/Workspace/Other', 'D:/SharedWorkspace']),
    'otherRootDirs should come from config file and trim entries',
  );
}

function testInvalidOtherRootDirsShapeFailsParsing() {
  assertThrowsIncludes(
    () => buildConfig({ rootDir: 'E:/Workspace/Project', otherRootDirs: 'E:/Other' }),
    'otherRootDirs must be an array',
    'otherRootDirs must be an array when provided',
  );

  assertThrowsIncludes(
    () => buildConfig({ rootDir: 'E:/Workspace/Project', otherRootDirs: ['E:/Other', '   '] }),
    'otherRootDirs[1] must be a non-empty string',
    'otherRootDirs entries must be non-empty strings',
  );
}

function testBlankAndroidEnvFallsBackToFileConfig() {
  const fileConfig: ConfigSource = {
    rootDir: 'E:/Workspace/Project',
    lineEnding: 'auto',
    port: 3100,
    android: {
      workspaceRoot: 'E:/Android/Project',
      javaHome: 'E:/AndroidStudio/jbr',
      buildTimeoutMs: 120000,
      maxErrorBlockChars: 3333,
      maxLogTailChars: 4444,
    },
  };

  const config = buildConfig(fileConfig, {
    ANDROID_WORKSPACE_ROOT: '   ',
    ANDROID_JAVA_HOME: '   ',
    ANDROID_BUILD_TIMEOUT_MS: '   ',
    ANDROID_MAX_ERROR_BLOCK_CHARS: '   ',
    ANDROID_MAX_LOG_TAIL_CHARS: '   ',
  });

  assert(config.android !== undefined, 'Should keep Android config');
  assertEqual(
    config.android?.workspaceRoot,
    path.resolve('E:/Android/Project'),
    'Should keep file Android workspaceRoot',
  );
  assertEqual(
    config.android?.javaHome,
    path.resolve('E:/AndroidStudio/jbr'),
    'Should keep file Android javaHome',
  );
  assertEqual(
    config.android?.buildTimeoutMs,
    120000,
    'Should keep file Android timeout',
  );
  assertEqual(
    config.android?.maxErrorBlockChars,
    3333,
    'Should keep file Android maxErrorBlockChars',
  );
  assertEqual(
    config.android?.maxLogTailChars,
    4444,
    'Should keep file Android maxLogTailChars',
  );
}

function testNonBlankEnvStillOverridesFileConfig() {
  const fileConfig: ConfigSource = {
    rootDir: 'E:/Workspace/Project',
    lineEnding: 'lf',
    port: 3100,
    android: {
      workspaceRoot: 'E:/Android/Project',
      javaHome: 'E:/AndroidStudio/jbr',
      buildTimeoutMs: 120000,
      maxErrorBlockChars: 2500,
      maxLogTailChars: 4000,
    },
  };

  const config = buildConfig(fileConfig, {
    MCP_ROOT_DIR: 'E:/Workspace/Override',
    MCP_LINE_ENDING: 'crlf',
    MCP_PORT: '3300',
    ANDROID_WORKSPACE_ROOT: 'E:/Android/Override',
    ANDROID_BUILD_TIMEOUT_MS: '180000',
  });

  assertEqual(config.rootDir, 'E:/Workspace/Override', 'Should override rootDir');
  assertEqual(config.lineEnding, 'crlf', 'Should override lineEnding');
  assertEqual(config.port, 3300, 'Should override port');
  assertEqual(
    config.android?.workspaceRoot,
    path.resolve('E:/Android/Override'),
    'Should override Android workspaceRoot',
  );
  assertEqual(
    config.android?.buildTimeoutMs,
    180000,
    'Should override Android timeout',
  );
}

function testValidatedPathSafetyContextAcceptsIndependentRoots() {
  const config = attachValidatedPathSafetyContext(
    createConfig(PRIMARY_DIR, [ADDITIONAL_DIR]),
  );

  assert(config.pathSafetyContext !== undefined, 'Validated config should carry a path safety context');
  assertEqual(
    config.pathSafetyContext.allowedRoots.length,
    2,
    'Validated context should include primary plus additional roots',
  );
  assertEqual(
    config.pathSafetyContext.allowedRoots[0].kind,
    'primary',
    'First allowed root should be primary',
  );
  assertEqual(
    config.pathSafetyContext.allowedRoots[1].kind,
    'additional',
    'Second allowed root should be additional',
  );
  assert(
    typeof config.pathSafetyContext.allowedRoots[1].realRootDir === 'string',
    'Validated roots should carry realRootDir eagerly',
  );
}

function testValidatedPathSafetyContextRejectsInvalidRoots() {
  assertThrowsIncludes(
    () => attachValidatedPathSafetyContext(createConfig('relative/root')),
    'absolute local path',
    'rootDir must be absolute',
  );

  assertThrowsIncludes(
    () => attachValidatedPathSafetyContext(createConfig(PRIMARY_DIR, ['relative/other'])),
    'absolute local path',
    'otherRootDirs entries must be absolute',
  );

  assertThrowsIncludes(
    () => attachValidatedPathSafetyContext(createConfig(path.join(CONFIG_FIXTURES_DIR, 'missing'))),
    'does not exist',
    'Configured root must exist',
  );

  assertThrowsIncludes(
    () => attachValidatedPathSafetyContext(createConfig(ROOT_FILE)),
    'existing directory',
    'Configured root must be a directory',
  );
}

function testValidatedPathSafetyContextRejectsLexicalDuplicateAndNestedRoots() {
  assertThrowsIncludes(
    () => attachValidatedPathSafetyContext(createConfig(PRIMARY_DIR, [`${PRIMARY_DIR}${path.sep}`])),
    'unique at the lexical path layer',
    'Trailing separators should not bypass lexical duplicate detection',
  );

  assertThrowsIncludes(
    () => attachValidatedPathSafetyContext(createConfig(PRIMARY_DIR, [NESTED_DIR])),
    'must not be nested at the lexical path layer',
    'Nested roots should be rejected lexically',
  );

  if (process.platform === 'win32') {
    assertThrowsIncludes(
      () => attachValidatedPathSafetyContext(createConfig(PRIMARY_DIR.toUpperCase(), [PRIMARY_DIR.toLowerCase()])),
      'unique at the lexical path layer',
      'Windows root comparison should be case-insensitive',
    );
  }
}

async function testValidatedPathSafetyContextRejectsRealpathDuplicateRoots() {
  const linkPath = path.join(CONFIG_FIXTURES_DIR, 'link-to-primary');
  const linkCreated = await createDirectoryLink(linkPath, PRIMARY_DIR);
  if (!linkCreated) return;

  try {
    assertThrowsIncludes(
      () => attachValidatedPathSafetyContext(createConfig(PRIMARY_DIR, [linkPath])),
      'unique at the real path layer',
      'Symlink roots that resolve to the same directory should be rejected',
    );
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function testValidatedPathSafetyContextRejectsRealpathNestedRoots() {
  const linkPath = path.join(CONFIG_FIXTURES_DIR, 'link-to-nested');
  const linkCreated = await createDirectoryLink(linkPath, NESTED_DIR);
  if (!linkCreated) return;

  try {
    assertThrowsIncludes(
      () => attachValidatedPathSafetyContext(createConfig(PRIMARY_DIR, [linkPath])),
      'must not be nested at the real path layer',
      'Symlink roots that resolve inside another root should be rejected',
    );
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing config loading',
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'blank MCP env falls back to file config', run: testBlankMcpEnvFallsBackToFileConfig },
      { name: 'otherRootDirs parses from file config only', run: testOtherRootDirsParsingDoesNotUseEnvOverride },
      { name: 'invalid otherRootDirs shape fails parsing', run: testInvalidOtherRootDirsShapeFailsParsing },
      { name: 'blank Android env falls back to file config', run: testBlankAndroidEnvFallsBackToFileConfig },
      { name: 'non-blank env still overrides file config', run: testNonBlankEnvStillOverridesFileConfig },
      { name: 'validated path safety context accepts independent roots', run: testValidatedPathSafetyContextAcceptsIndependentRoots },
      { name: 'validated path safety context rejects invalid roots', run: testValidatedPathSafetyContextRejectsInvalidRoots },
      { name: 'validated path safety context rejects lexical duplicate and nested roots', run: testValidatedPathSafetyContextRejectsLexicalDuplicateAndNestedRoots },
      { name: 'validated path safety context rejects realpath duplicate roots', run: testValidatedPathSafetyContextRejectsRealpathDuplicateRoots },
      { name: 'validated path safety context rejects realpath nested roots', run: testValidatedPathSafetyContextRejectsRealpathNestedRoots },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
