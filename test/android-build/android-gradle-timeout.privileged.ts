import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { runAndroidGradle } from '../../src/utils/android-gradle.js';
import { assert, runTestSuite } from '../test-utils.js';
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTempDirWithRetry(tempDir: string): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (attempt === 10 || (error.code !== 'EBUSY' && error.code !== 'ENOTEMPTY')) {
        throw error;
      }
      await sleep(500 * attempt);
    }
  }
}

async function testTimeoutKillsProcessTree() {
  if (process.platform !== 'win32') {
    console.log('  - Skipped on non-Windows platform\n');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'custom-mcp-timeout-'));
  const gradlewPath = path.join(tempDir, 'gradlew.bat');
  const markerPath = path.join(tempDir, 'child-survived.txt');
  const escapedMarkerPath = markerPath.replace(/'/g, "''");

  const gradlewScript = [
    '@echo off',
    `start "" /b powershell.exe -NoProfile -Command "Start-Sleep -Seconds 2; Set-Content -Path '${escapedMarkerPath}' -Value 'child survived'"`,
    'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30"',
  ].join('\r\n');

  await writeFile(gradlewPath, gradlewScript, 'utf8');

  try {
    const result = await runAndroidGradle(
      'assembleDebug',
      {
        workspaceRoot: tempDir,
        javaHome: process.env.JAVA_HOME || 'C:/AndroidStudio/jbr',
        buildTimeoutMs: 500,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
      {},
    );

    assert(result.timedOut === true, 'Should mark the build as timed out');
    assert(result.success === false, 'Timed-out build should be treated as failure');

    await sleep(3000);

    const markerExists = await fileExists(markerPath);
    assert(
      markerExists === false,
      'Timed-out child process should not survive long enough to create the marker file',
    );
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
}

async function testCancellationKillsProcessTree() {
  if (process.platform !== 'win32') {
    console.log('  - Skipped on non-Windows platform\n');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'custom-mcp-cancel-'));
  const gradlewPath = path.join(tempDir, 'gradlew.bat');
  const markerPath = path.join(tempDir, 'child-survived.txt');
  const escapedMarkerPath = markerPath.replace(/'/g, "''");
  await writeFile(
    gradlewPath,
    [
      '@echo off',
      `start "" /b powershell.exe -NoProfile -Command "Start-Sleep -Seconds 2; Set-Content -Path '${escapedMarkerPath}' -Value 'child survived'"`,
      'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30"',
    ].join('\r\n'),
    'utf8',
  );

  try {
    const controller = new AbortController();
    const resultPromise = runAndroidGradle(
      'assembleDebug',
      {
        workspaceRoot: tempDir,
        javaHome: process.env.JAVA_HOME || 'C:/AndroidStudio/jbr',
        buildTimeoutMs: 10_000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
      {},
      controller.signal,
    );
    setTimeout(() => controller.abort(), 500);
    const result = await resultPromise;

    assert(result.cancelled === true, 'Should mark the build as cancelled');
    assert(result.timedOut === false, 'Cancellation should not be classified as timeout');
    assert(result.summary === 'BUILD CANCELLED', 'Cancellation should use its stable summary');

    await sleep(3000);
    assert(
      (await fileExists(markerPath)) === false,
      'Cancelled child process should not survive long enough to create the marker file',
    );
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing Android Gradle timeout handling',
    tests: [
      { name: 'timeout kills the full Gradle process tree', run: testTimeoutKillsProcessTree },
      {
        name: 'cancellation kills the full Gradle process tree',
        run: testCancellationKillsProcessTree,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
