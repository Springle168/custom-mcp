import { statSync, type Stats } from 'node:fs';
import * as path from 'node:path';
import { readTypedString, type ValuePolicyResult } from './value-policy.js';

type PathApi = typeof path.win32 | typeof path.posix;

type DirectoryStat = Pick<Stats, 'isDirectory'>;

export interface ExistingDirectoryPathOptions {
  readonly fieldPath: string;
  readonly platform?: NodeJS.Platform;
  readonly stat?: (targetPath: string) => DirectoryStat;
  readonly allowPosixAbsolute?: boolean;
}

export interface LocalAbsolutePathOptions {
  readonly fieldPath: string;
  readonly platform?: NodeJS.Platform;
  readonly allowPosixAbsolute?: boolean;
}

interface PathShapeOptions {
  readonly fieldPath: string;
  readonly platform: NodeJS.Platform;
  readonly allowPosixAbsolute: boolean;
}

const DRIVE_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;
const DRIVE_RELATIVE_RE = /^[a-zA-Z]:(?![\\/])/;

export function readExistingDirectoryPath(
  value: unknown,
  options: ExistingDirectoryPathOptions,
): ValuePolicyResult<string> {
  const shapeResult = readLocalAbsolutePath(value, options);
  if (!shapeResult.ok) return shapeResult;

  const platform = options.platform ?? process.platform;
  const pathApi = getPathApi(platform);
  const resolvedPath = pathApi.resolve(shapeResult.value);
  const stat = options.stat ?? defaultStat;

  try {
    const stats = stat(resolvedPath);
    if (!stats.isDirectory()) {
      return fail(
        options.fieldPath,
        `${options.fieldPath} must point to an existing directory: ${resolvedPath}.`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      options.fieldPath,
      `${options.fieldPath} does not exist or cannot be accessed: ${resolvedPath}. ${message}`,
    );
  }

  return ok(shapeResult.value);
}

export function readLocalAbsolutePath(
  value: unknown,
  options: LocalAbsolutePathOptions,
): ValuePolicyResult<string> {
  const stringResult = readTypedString(value, options);
  if (!stringResult.ok) return stringResult;

  const platform = options.platform ?? process.platform;
  const allowPosixAbsolute = options.allowPosixAbsolute ?? true;
  const shapeResult = validateLocalAbsolutePathShape(stringResult.value, {
    fieldPath: options.fieldPath,
    platform,
    allowPosixAbsolute,
  });
  if (!shapeResult.ok) return shapeResult;

  return ok(stringResult.value);
}

function validateLocalAbsolutePathShape(
  value: string,
  options: PathShapeOptions,
): ValuePolicyResult<string> {
  const normalized = value.replace(/\\/g, '/');

  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    return fail(
      options.fieldPath,
      `${options.fieldPath} must be an absolute local path and cannot use ~ expansion.`,
    );
  }

  if (normalized.startsWith('//?/') || normalized.startsWith('//./')) {
    return failAbsoluteLocalPath(options.fieldPath);
  }

  if (DRIVE_RELATIVE_RE.test(value)) {
    return failAbsoluteLocalPath(options.fieldPath);
  }

  if (options.platform === 'win32') {
    if (DRIVE_ABSOLUTE_RE.test(value)) {
      return ok(value);
    }

    return failAbsoluteLocalPath(options.fieldPath);
  }

  if (countLeadingRootSeparators(value) >= 2) {
    return failAbsoluteLocalPath(options.fieldPath);
  }

  if (DRIVE_ABSOLUTE_RE.test(value)) {
    return failAbsoluteLocalPath(options.fieldPath);
  }

  if (options.allowPosixAbsolute && path.posix.isAbsolute(value)) {
    return ok(value);
  }

  return failAbsoluteLocalPath(options.fieldPath);
}

function failAbsoluteLocalPath(fieldPath: string): ValuePolicyResult<never> {
  return fail(
    fieldPath,
    `${fieldPath} must be an absolute local path. ` +
      'Use a drive-absolute path on Windows, for example E:/Workspace.',
  );
}

function getPathApi(platform: NodeJS.Platform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

function countLeadingRootSeparators(input: string): number {
  let count = 0;
  for (const char of input) {
    if (char !== '/' && char !== '\\') break;
    count++;
  }
  return count;
}

function defaultStat(targetPath: string): DirectoryStat {
  return statSync(targetPath);
}

function ok<T>(value: T): ValuePolicyResult<T> {
  return { ok: true, value };
}

function fail(fieldPath: string, message: string): ValuePolicyResult<never> {
  return { ok: false, error: { fieldPath, message } };
}
