import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
// Use the unbundled entry so matching code follows the versions in the lockfile.
import { globIterate } from 'glob/raw';
import type { AndroidTestReportFile } from '../engine/android-test-report.js';

const TEST_REPORT_PATTERN = '**/test-results/testDebugUnitTest/TEST-*.xml';
const MAX_REPORT_FILES = 1000;
const MAX_REPORT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_REPORT_BYTES = 10 * 1024 * 1024;

export interface AndroidTestReportFileFingerprint {
  size: number;
  mtimeMs: number;
}

export type AndroidTestReportSnapshot = ReadonlyMap<string, AndroidTestReportFileFingerprint>;

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
      const remainingBytes = Math.min(MAX_REPORT_FILE_BYTES, MAX_TOTAL_REPORT_BYTES - totalBytes);
      const content = await readBoundedReportFile(absolutePath, remainingBytes);
      if (!content) {
        unreadableFileCount += 1;
        continue;
      }

      totalBytes += content.bytes;
      files.push({
        relativePath: toPortableRelativePath(workspaceRoot, absolutePath),
        xml: content.xml,
      });
    } catch {
      unreadableFileCount += 1;
    }
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));

  return {
    files,
    changedFileCount,
    unreadableFileCount,
  };
}

async function discoverReportPaths(workspaceRoot: string): Promise<string[]> {
  const resolvedRoot = path.resolve(workspaceRoot);
  const matches = globIterate(TEST_REPORT_PATTERN, {
    cwd: resolvedRoot,
    absolute: true,
    nodir: true,
    dot: false,
    follow: false,
    ignore: ['**/.git/**', '**/.gradle/**', '**/node_modules/**'],
  });
  const safePaths: string[] = [];

  for await (const match of matches) {
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

    if (safePaths.length > MAX_REPORT_FILES) {
      throw new Error(`Android test report candidate limit exceeded (${MAX_REPORT_FILES}).`);
    }
  }

  return [...new Set(safePaths)].sort((left, right) => left.localeCompare(right, 'en'));
}

async function readBoundedReportFile(
  absolutePath: string,
  maxBytes: number,
): Promise<{ xml: string; bytes: number } | null> {
  if (maxBytes <= 0) {
    return null;
  }

  const file = await open(absolutePath, 'r');
  try {
    const fileStats = await file.stat();
    if (!fileStats.isFile() || fileStats.size > maxBytes) {
      return null;
    }

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;

    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }

    if (bytesRead > maxBytes) {
      return null;
    }

    return {
      xml: buffer.subarray(0, bytesRead).toString('utf8'),
      bytes: bytesRead,
    };
  } finally {
    await file.close();
  }
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
