import path from 'node:path';
import {
  buildConfig,
  type ConfigSource,
} from '../src/config.js';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}\nExpected: ${String(expected)}\nActual: ${String(actual)}`,
    );
  }
}

function testBlankMcpEnvFallsBackToFileConfig() {
  console.log('Test: blank MCP env falls back to file config');

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

  console.log('  ✓ Passed\n');
}

function testBlankAndroidEnvFallsBackToFileConfig() {
  console.log('Test: blank Android env falls back to file config');

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

  console.log('  ✓ Passed\n');
}

function testNonBlankEnvStillOverridesFileConfig() {
  console.log('Test: non-blank env still overrides file config');

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

  console.log('  ✓ Passed\n');
}

function main() {
  console.log('='.repeat(60));
  console.log('Testing config loading');
  console.log('='.repeat(60));

  testBlankMcpEnvFallsBackToFileConfig();
  testBlankAndroidEnvFallsBackToFileConfig();
  testNonBlankEnvStillOverridesFileConfig();

  console.log('='.repeat(60));
  console.log('All config tests passed');
  console.log('='.repeat(60));
}

main();
