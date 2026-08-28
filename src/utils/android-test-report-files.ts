import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import type { AndroidTestReportFile } from '../engine/android-test-report.js';

const TEST_REPORT_PATTERN =
  '**/test-results/testDebugUnitTest/TEST-*.xml';
const MAX_REPORT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_REPORT_BYTES = 10 * 1024 * 1024;

export interface AndroidTestReportFileFingerprint {
  size: number;
  mtimeMs: number;
}

export type AndroidTestReportSnapshot = ReadonlyMap<
  string,
  AndroidTestReportFileFingerprint
>;

export interface ChangedAndroidTestReportFiles {
  files: AndroidTestReportFile[];
  changedFileCount: number;
  unreadableFileCount: number;
}

export async function snapshotAndroidTestReportFiles(
  workspaceRoot: string,
): Promise<AndroidTestReportSnapshot> {
  const snapshot = new Map<string, AndroidTestReportFileFingerprint>();

  for (const absolutePath of await discoverReportPaths(workspaceRoot)) {
    const fingerprint = await readFingerprint(absolutePath);
    if (fingerprint) {
      snapshot.set(absolutePath, fingerprint);
    }
  }

  return snapshot;
}

export async function readChangedAndroidTestReportFiles(
  workspaceRoot: string,
  before: AndroidTestReportSnapshot,
): Promise<ChangedAndroidTestReportFiles> {
  const files: AndroidTestReportFile[] = [];
  let changedFileCount = 0;
  let unreadableFileCount = 0;
  let totalBytes = 0;

  for (const absolutePath of await discoverReportPaths(workspaceRoot)) {
    const fingerprint = await readFingerprint(absolutePath);
    if (!fingerprint || fingerprintsEqual(before.get(absolutePath), fingerprint)) {
      continue;
    }

    changedFileCount += 1;

    if (
      fingerprint.size > MAX_REPORT_FILE_BYTES ||
      totalBytes + fingerprint.size > MAX_TOTAL_REPORT_BYTES
    ) {
      unreadableFileCount += 1;
      continue;
    }

    try {
      const xml = await readFile(absolutePath, 'utf8');
      const actualBytes = Buffer.byteLength(xml, 'utf8');
      if (
        actualBytes > MAX_REPORT_FILE_BYTES ||
        totalBytes + actualBytes > MAX_TOTAL_REPORT_BYTES
      ) {
        unreadableFileCount += 1;
        continue;
      }

      totalBytes += actualBytes;
      files.push({
        relativePath: toPortableRelativePath(workspaceRoot, absolutePath),
        xml,
      });
    } catch {
      unreadableFileCount += 1;
    }
  }

  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, 'en'),
  );

  return {
    files,
    changedFileCount,
    unreadableFileCount,
  };
}

async function discoverReportPaths(workspaceRoot: string): Promise<string[]> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const matches = await glob(TEST_REPORT_PATTERN, {
    cwd: resolvedRoot,
    absolute: true,
    nodir: true,
    dot: false,
    follow: false,
    ignore: ['**/.git/**', '**/.gradle/**', '**/node_modules/**'],
  });
  const safePaths: string[] = [];

  for (const match of matches) {
    const absolutePath = path.resolve(match);
    if (!isWithinRoot(resolvedRoot, absolutePath)) {
      continue;
    }

    try {
      const fileStats = await lstat(absolutePath);
      if (fileStats.isFile() && !fileStats.isSymbolicLink()) {
        safePaths.push(absolutePath);
      }
    } catch {
      // Build outputs may disappear while Gradle replaces a report set.
    }
  }

  return [...new Set(safePaths)].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
}

async function readFingerprint(
  absolutePath: string,
): Promise<AndroidTestReportFileFingerprint | null> {
  try {
    const fileStats = await lstat(absolutePath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
      return null;
    }

    return {
      size: fileStats.size,
      mtimeMs: fileStats.mtimeMs,
    };
  } catch {
    return null;
  }
}

function fingerprintsEqual(
  before: AndroidTestReportFileFingerprint | undefined,
  after: AndroidTestReportFileFingerprint,
): boolean {
  return before?.size === after.size && before.mtimeMs === after.mtimeMs;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}

function toPortableRelativePath(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}
