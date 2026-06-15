import * as path from 'node:path';

const DRIVE_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;
const DRIVE_RELATIVE_RE = /^[a-zA-Z]:(?![\\/])/;

export function normalizeLogsDirPath(value: string, label: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  if (isUnsupportedLocalAbsolutePath(trimmed) || !path.isAbsolute(trimmed)) {
    throw new Error(
      `${label} must be an absolute local path. ` +
        'Use a drive-absolute path on Windows, for example E:/Logs/custom-mcp.',
    );
  }

  return path.resolve(trimmed);
}

function isUnsupportedLocalAbsolutePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');

  if (normalized.startsWith('//')) {
    return true;
  }

  if (process.platform !== 'win32') {
    return false;
  }

  return DRIVE_RELATIVE_RE.test(value) || !DRIVE_ABSOLUTE_RE.test(value);
}
