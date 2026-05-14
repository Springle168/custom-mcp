import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { runAndroidGradle } from '../../src/utils/android-gradle.js';
import { assert, runTestSuite } from '../test-utils.js';

async function createFakeWorkspace(dirName: string): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'custom-mcp-launcher-'));
  const workspaceRoot = path.join(base, dirName);
  const gradlewPath = path.join(workspaceRoot, 'gradlew.bat');

  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(
    gradlewPath,
    ['@echo off', 'echo BUILD SUCCESSFUL'].join('\r\n'),
    'utf8',
  );

  return workspaceRoot;
}

async function testWorkspacePathWithAmpersand() {
  const workspaceRoot = await createFakeWorkspace('R&D Project');

  try {
    const result = await runAndroidGradle(
      'assembleDebug',
      {
        workspaceRoot,
        javaHome: process.env.JAVA_HOME || 'C:/AndroidStudio/jbr',
        buildTimeoutMs: 5000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
      {},
    );

    assert(result.success === true, 'Should successfully start gradlew.bat');
    assert(result.summary === 'BUILD SUCCESSFUL', 'Should report build success');
  } finally {
    await rm(path.dirname(workspaceRoot), { recursive: true, force: true });
  }
}

async function testWorkspacePathWithPercentExpansionSyntax() {
  const workspaceRoot = await createFakeWorkspace('x%TEMP%y');

  try {
    const result = await runAndroidGradle(
      'testDebugUnitTest',
      {
        workspaceRoot,
        javaHome: process.env.JAVA_HOME || 'C:/AndroidStudio/jbr',
        buildTimeoutMs: 5000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
      {},
    );

    assert(result.success === true, 'Should successfully start gradlew.bat');
    assert(result.summary === 'BUILD SUCCESSFUL', 'Should report build success');
  } finally {
    await rm(path.dirname(workspaceRoot), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log('Skipped on non-Windows platform');
    return;
  }

  await runTestSuite({
    title: 'Testing Android Gradle launcher',
    tests: [
      { name: 'workspace path with ampersand', run: testWorkspacePathWithAmpersand },
      { name: 'workspace path with percent expansion syntax', run: testWorkspacePathWithPercentExpansionSyntax },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
