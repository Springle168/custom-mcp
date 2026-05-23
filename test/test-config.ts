import path from 'node:path';
import {
  buildConfig,
  type ConfigSource,
} from '../src/config.js';
import { assert, assertEqual, runTestSuite } from './test-utils.js';

function testBlankMcpEnvFallsBackToFileConfig() {
  const fileConfig: ConfigSource = {
    rootDir: 'E:/Workspace/Project',
    otherRootDirs: ['E:/Workspace/Shared'],
    lineEnding: 'crlf',
    port: 3200,
  };

  const config = buildConfig(fileConfig, {
    MCP_ROOT_DIR: '   ',
    MCP_OTHER_ROOT_DIRS: '   ',
    MCP_LINE_ENDING: '   ',
    MCP_PORT: '   ',
  });

  assertEqual(config.rootDir, 'E:/Workspace/Project', 'Should keep file rootDir');
  assertEqual(config.otherRootDirs.length, 1, 'Should keep file otherRootDirs');
  assertEqual(
    config.otherRootDirs[0],
    'E:/Workspace/Shared',
    'Should keep file otherRootDirs entry',
  );
  assertEqual(config.lineEnding, 'crlf', 'Should keep file lineEnding');
  assertEqual(config.port, 3200, 'Should keep file port');
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
    otherRootDirs: ['E:/Workspace/FileOther'],
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
    MCP_OTHER_ROOT_DIRS: [
      'E:/Workspace/EnvOtherA',
      'E:/Workspace/EnvOtherB',
    ].join(path.delimiter),
    MCP_LINE_ENDING: 'crlf',
    MCP_PORT: '3300',
    ANDROID_WORKSPACE_ROOT: 'E:/Android/Override',
    ANDROID_BUILD_TIMEOUT_MS: '180000',
  });

  assertEqual(config.rootDir, 'E:/Workspace/Override', 'Should override rootDir');
  assertEqual(
    config.otherRootDirs.join('|'),
    'E:/Workspace/EnvOtherA|E:/Workspace/EnvOtherB',
    'Should override otherRootDirs',
  );
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

function testOtherRootDirsAreOptionalAndDeduped() {
  const defaultConfig = buildConfig({
    rootDir: 'E:/Workspace/Main',
  }, {});

  assertEqual(
    defaultConfig.otherRootDirs.length,
    0,
    'Should default otherRootDirs to an empty array',
  );

  const config = buildConfig({
    rootDir: 'E:/Workspace/Main',
    otherRootDirs: [
      'E:/Workspace/OtherA',
      ' E:/Workspace/OtherB ',
      'E:/Workspace/Main',
      'E:/Workspace/OtherA',
    ],
  }, {});

  assertEqual(
    config.otherRootDirs.join('|'),
    'E:/Workspace/OtherA|E:/Workspace/OtherB',
    'Should trim and dedupe otherRootDirs while excluding rootDir',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing config loading',
    tests: [
      { name: 'blank MCP env falls back to file config', run: testBlankMcpEnvFallsBackToFileConfig },
      { name: 'blank Android env falls back to file config', run: testBlankAndroidEnvFallsBackToFileConfig },
      { name: 'non-blank env still overrides file config', run: testNonBlankEnvStillOverridesFileConfig },
      { name: 'otherRootDirs are optional and deduped', run: testOtherRootDirsAreOptionalAndDeduped },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
