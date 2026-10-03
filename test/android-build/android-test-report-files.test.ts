import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  readChangedAndroidTestReportFiles,
  snapshotAndroidTestReportFiles,
} from '../../src/utils/android-test-report-files.js';
import { assertEqual, runTestSuite } from '../test-utils.js';

async function writeReport(
  workspaceRoot: string,
  moduleName: string,
  fileName: string,
  content: string,
): Promise<void> {
  const reportDir = path.join(
    workspaceRoot,
    moduleName,
    'custom-build',
    'test-results',
    'testDebugUnitTest',
  );
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, fileName), content, 'utf8');
}

async function testDetectsNewAndChangedReports() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'custom-mcp-test-reports-'));

  try {
    await writeReport(workspaceRoot, 'app', 'TEST-existing.xml', '<testsuite/>');
    await writeReport(workspaceRoot, 'feature', 'TEST-unchanged.xml', '<testsuite/>');
    const before = await snapshotAndroidTestReportFiles(workspaceRoot);

    await writeReport(workspaceRoot, 'app', 'TEST-existing.xml', '<testsuite tests="1"/>');
    await writeReport(workspaceRoot, 'library', 'TEST-new.xml', '<testsuite tests="2"/>');

    const changed = await readChangedAndroidTestReportFiles(workspaceRoot, before);

    assertEqual(changed.changedFileCount, 2, 'Should detect new and updated reports');
    assertEqual(changed.unreadableFileCount, 0, 'Should read changed reports');
    assertEqual(changed.files.length, 2, 'Should return changed report contents');
    assertEqual(
      changed.files[0]?.relativePath,
      'app/custom-build/test-results/testDebugUnitTest/TEST-existing.xml',
      'Should return deterministic workspace-relative paths',
    );
    assertEqual(
      changed.files[1]?.relativePath,
      'library/custom-build/test-results/testDebugUnitTest/TEST-new.xml',
      'Should discover reports without assuming the app/build prefix',
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testIgnoresUnchangedAndExcludedReports() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'custom-mcp-test-reports-'));

  try {
    await writeReport(workspaceRoot, 'app', 'TEST-existing.xml', '<testsuite/>');
    const excludedDir = path.join(
      workspaceRoot,
      'node_modules',
      'package',
      'test-results',
      'testDebugUnitTest',
    );
    await mkdir(excludedDir, { recursive: true });
    await writeFile(path.join(excludedDir, 'TEST-excluded.xml'), '<testsuite/>');

    const before = await snapshotAndroidTestReportFiles(workspaceRoot);
    const changed = await readChangedAndroidTestReportFiles(workspaceRoot, before);

    assertEqual(changed.changedFileCount, 0, 'Should ignore unchanged reports');
    assertEqual(changed.files.length, 0, 'Should not return old report contents');
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testRejectsExcessiveReportCandidates() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'custom-mcp-test-reports-'));
  const reportDir = path.join(workspaceRoot, 'app', 'build', 'test-results', 'testDebugUnitTest');

  try {
    await mkdir(reportDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 1001 }, (_, index) =>
        writeFile(
          path.join(reportDir, `TEST-${String(index).padStart(4, '0')}.xml`),
          '<testsuite/>',
          'utf8',
        ),
      ),
    );

    let rejected = false;
    try {
      await snapshotAndroidTestReportFiles(workspaceRoot);
    } catch {
      rejected = true;
    }

    assertEqual(
      rejected,
      true,
      'Should stop report attribution when the candidate budget is exceeded',
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing Android test report file discovery',
    tests: [
      { name: 'new and changed reports', run: testDetectsNewAndChangedReports },
      { name: 'unchanged and excluded reports', run: testIgnoresUnchangedAndExcludedReports },
      { name: 'report candidate budget', run: testRejectsExcessiveReportCandidates },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
