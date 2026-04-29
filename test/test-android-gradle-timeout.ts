import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { runAndroidGradle } from '../src/utils/android-gradle.js';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

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

async function testTimeoutKillsProcessTree() {
  console.log('Test: timeout kills the full Gradle process tree');

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

    console.log('  ✓ Passed\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Testing Android Gradle timeout handling');
  console.log('='.repeat(60));

  await testTimeoutKillsProcessTree();

  console.log('='.repeat(60));
  console.log('All timeout tests passed');
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
