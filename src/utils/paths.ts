import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type SafePathKind = 'drive_absolute' | 'relative';
export type SafePathDisplayKind = 'absolute' | 'relative_to_root';

export interface SafePath {
  input: string;
  kind: SafePathKind;
  resolvedPath: string;
  rootDir: string;
  displayPath: string;
  displayKind: SafePathDisplayKind;
}

export type PathSafetyErrorCode =
  | 'empty_path'
  | 'drive_relative_path'
  | 'rooted_without_drive'
  | 'repeated_rooted_without_drive'
  | 'unc_path'
  | 'namespace_path'
  | 'outside_root_dir'
  | 'invalid_glob';

export interface PathSafetyError {
  input: string;
  code: PathSafetyErrorCode;
  message: string;
}

export type SafePathResult =
  | { ok: true; path: SafePath }
  | { ok: false; error: PathSafetyError };

export interface SafeGlobPattern {
  input: string;
  kind: SafePathKind;
  pattern: string;
  staticBase: string;
  resolvedStaticBase: string;
  rootDir: string;
  displayKind: SafePathDisplayKind;
}

export type SafeGlobPatternResult =
  | { ok: true; glob: SafeGlobPattern }
  | { ok: false; error: PathSafetyError };

export type SafeReadTargetResult =
  | { ok: true; realPath: string }
  | {
      ok: false;
      code: 'not_found' | 'outside_root_dir' | 'io_error';
      reason: string;
    };

interface PathClassification {
  kind: SafePathKind;
  pathInput: string;
  slashLeadingGlob: boolean;
}

type PathClassificationResult =
  | { ok: true; path: PathClassification }
  | { ok: false; error: PathSafetyError };

interface StaticGlobBase {
  staticBase: string;
  magicRemainder: string;
}

const DRIVE_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;
const DRIVE_RELATIVE_RE = /^[a-zA-Z]:(?![\\/])/;
const GLOB_MAGIC_RE = /[*?\[\]{}]/;

export function hasGlobMagic(input: string): boolean {
  return GLOB_MAGIC_RE.test(input);
}

export function resolvePath(filePath: string, rootDir: string): string {
  const result = resolveSafePath(filePath, rootDir);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.path.resolvedPath;
}

export function validatePathAccess(
  resolvedPath: string,
  rootDir: string,
): string | null {
  if (!isPathInsideRoot(resolvedPath, rootDir)) {
    return `Path ${resolvedPath} is outside the allowed workspace ${rootDir}.`;
  }
  return null;
}

export function resolveSafePath(input: string, rootDir: string): SafePathResult {
  const classification = classifyPathInput(input, { allowSlashLeadingGlob: false });
  if (!classification.ok) return classification;

  const normalizedRoot = path.resolve(rootDir);
  const resolvedPath = classification.path.kind === 'drive_absolute'
    ? path.resolve(classification.path.pathInput)
    : path.resolve(normalizedRoot, classification.path.pathInput);

  if (!isPathInsideRoot(resolvedPath, normalizedRoot)) {
    return pathError(
      input,
      'outside_root_dir',
      `Path ${input} resolves outside the allowed workspace ${normalizedRoot}.`,
    );
  }

  const displayKind: SafePathDisplayKind = classification.path.kind === 'drive_absolute'
    ? 'absolute'
    : 'relative_to_root';

  return {
    ok: true,
    path: {
      input,
      kind: classification.path.kind,
      resolvedPath,
      rootDir: normalizedRoot,
      displayPath: getDisplayPath(resolvedPath, normalizedRoot, displayKind),
      displayKind,
    },
  };
}

export function resolveSafeGlobPattern(
  input: string,
  rootDir: string,
): SafeGlobPatternResult {
  const classification = classifyPathInput(input, { allowSlashLeadingGlob: true });
  if (!classification.ok) return classification;

  const patternInput = normalizeGlobSeparators(classification.path.pathInput);
  if (!hasGlobMagic(patternInput)) {
    return pathError(
      input,
      'invalid_glob',
      `Glob pattern ${input} does not contain glob metacharacters. Provide a file path or a valid glob pattern.`,
    );
  }

  const staticBase = getStaticGlobBase(
    patternInput,
    classification.path.kind,
  );

  if (containsParentTraversal(staticBase.magicRemainder)) {
    return pathError(
      input,
      'invalid_glob',
      `Glob pattern ${input} contains '..' after a glob segment, which could escape the workspace during expansion. Use a pattern whose traversals are resolved before the first glob segment.`,
    );
  }

  const normalizedRoot = path.resolve(rootDir);
  const resolvedStaticBase = classification.path.kind === 'drive_absolute'
    ? path.resolve(staticBase.staticBase)
    : path.resolve(normalizedRoot, staticBase.staticBase);

  if (!isPathInsideRoot(resolvedStaticBase, normalizedRoot)) {
    return pathError(
      input,
      'outside_root_dir',
      `Glob pattern ${input} has a static base outside the allowed workspace ${normalizedRoot}.`,
    );
  }

  const canonicalStaticBase = toGlobPath(
    path.relative(normalizedRoot, resolvedStaticBase),
  );
  const pattern = joinGlobParts(
    canonicalStaticBase,
    staticBase.magicRemainder,
  );
  const displayKind: SafePathDisplayKind = classification.path.kind === 'drive_absolute'
    ? 'absolute'
    : 'relative_to_root';

  return {
    ok: true,
    glob: {
      input,
      kind: classification.path.kind,
      pattern,
      staticBase: staticBase.staticBase,
      resolvedStaticBase,
      rootDir: normalizedRoot,
      displayKind,
    },
  };
}

export function resolveSafeGlobEntry(
  entry: string,
  globPattern: SafeGlobPattern,
): SafePathResult {
  const resolvedPath = path.resolve(entry);

  if (!isPathInsideRoot(resolvedPath, globPattern.rootDir)) {
    return pathError(
      entry,
      'outside_root_dir',
      `Glob result ${entry} resolves outside the allowed workspace ${globPattern.rootDir}.`,
    );
  }

  return {
    ok: true,
    path: {
      input: entry,
      kind: globPattern.kind,
      resolvedPath,
      rootDir: globPattern.rootDir,
      displayPath: getDisplayPath(
        resolvedPath,
        globPattern.rootDir,
        globPattern.displayKind,
      ),
      displayKind: globPattern.displayKind,
    },
  };
}

export async function validateSafeReadTarget(
  safePath: SafePath,
): Promise<SafeReadTargetResult> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(safePath.rootDir);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return {
      ok: false,
      code: 'io_error',
      reason: `Could not resolve workspace root: ${error.message}. Check the server configuration.`,
    };
  }

  let realTarget: string;
  try {
    realTarget = await fs.realpath(safePath.resolvedPath);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return { ok: false, code: 'not_found', reason: 'file not found' };
    }
    return {
      ok: false,
      code: 'io_error',
      reason: `Could not resolve real path for ${safePath.input}: ${error.message}. Check the path and permissions.`,
    };
  }

  if (!isPathInsideRoot(realTarget, realRoot)) {
    return {
      ok: false,
      code: 'outside_root_dir',
      reason: `Path ${safePath.input} resolves outside the allowed workspace. Provide a path inside the configured workspace root.`,
    };
  }

  return { ok: true, realPath: realTarget };
}

export async function validateSafeWriteTarget(
  safePath: SafePath,
): Promise<string | null> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(safePath.rootDir);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return `Could not resolve workspace root: ${error.message}. Check the server configuration.`;
  }

  try {
    const existingAncestor = await findExistingAncestor(
      path.dirname(safePath.resolvedPath),
    );
    const realAncestor = await fs.realpath(existingAncestor);
    if (!isPathInsideRoot(realAncestor, realRoot)) {
      return `Path ${safePath.input} resolves outside the allowed workspace. Provide a file path inside the configured workspace root.`;
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return `Could not validate write path ${safePath.input}: ${error.message}. Check the path and permissions.`;
  }

  try {
    const stat = await fs.lstat(safePath.resolvedPath);
    if (stat.isSymbolicLink()) {
      return `Cannot write file ${safePath.input}: target path is a symbolic link. Provide a regular file path inside the workspace.`;
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      return `Could not validate write target ${safePath.input}: ${error.message}. Check the path and permissions.`;
    }
  }

  return null;
}

export function formatPathSafetyError(error: PathSafetyError): string {
  return error.message;
}

function classifyPathInput(
  input: string,
  options: { allowSlashLeadingGlob: boolean },
): PathClassificationResult {
  if (input.length === 0) {
    return pathError(
      input,
      'empty_path',
      'Path must be a non-empty string.',
    );
  }

  const normalized = normalizeGlobSeparators(input);

  if (normalized.startsWith('//?/') || normalized.startsWith('//./')) {
    return pathError(
      input,
      'namespace_path',
      `Path ${input} uses a Windows namespace prefix, which is not supported. Provide a normal drive-absolute or workspace-relative path.`,
    );
  }

  if (DRIVE_RELATIVE_RE.test(input)) {
    return pathError(
      input,
      'drive_relative_path',
      `Path ${input} uses drive-relative syntax. Use a full drive-absolute path like C:/dir/file.txt or a path relative to the workspace root.`,
    );
  }

  if (DRIVE_ABSOLUTE_RE.test(input)) {
    return {
      ok: true,
      path: { kind: 'drive_absolute', pathInput: input, slashLeadingGlob: false },
    };
  }

  const leadingRootLength = countLeadingRootSeparators(input);
  if (leadingRootLength > 0) {
    if (leadingRootLength >= 3) {
      return pathError(
        input,
        'repeated_rooted_without_drive',
        `Path ${input} starts with repeated root separators and is not supported. Provide a workspace-relative path or a drive-absolute path inside the workspace.`,
      );
    }

    if (leadingRootLength === 2) {
      return pathError(
        input,
        'unc_path',
        `Path ${input} looks like a UNC path, which is not supported. Provide a local drive-absolute or workspace-relative path.`,
      );
    }

    if (options.allowSlashLeadingGlob && hasGlobMagic(input)) {
      return {
        ok: true,
        path: {
          kind: 'relative',
          pathInput: input.slice(1),
          slashLeadingGlob: true,
        },
      };
    }

    return pathError(
      input,
      'rooted_without_drive',
      `Path ${input} is rooted without a drive letter. Use a path relative to the workspace root or a drive-absolute path inside it.`,
    );
  }

  return {
    ok: true,
    path: { kind: 'relative', pathInput: input, slashLeadingGlob: false },
  };
}

function pathError(
  input: string,
  code: PathSafetyErrorCode,
  message: string,
): { ok: false; error: PathSafetyError } {
  return { ok: false, error: { input, code, message } };
}

function isPathInsideRoot(candidatePath: string, rootDir: string): boolean {
  const normalizedRoot = path.resolve(rootDir);
  const normalizedPath = path.resolve(candidatePath);
  const rootPrefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : normalizedRoot + path.sep;

  if (process.platform === 'win32') {
    const lowerRoot = normalizedRoot.toLowerCase();
    const lowerPrefix = rootPrefix.toLowerCase();
    const lowerPath = normalizedPath.toLowerCase();
    return lowerPath === lowerRoot || lowerPath.startsWith(lowerPrefix);
  }

  return normalizedPath === normalizedRoot || normalizedPath.startsWith(rootPrefix);
}

function getDisplayPath(
  resolvedPath: string,
  rootDir: string,
  displayKind: SafePathDisplayKind,
): string {
  if (displayKind === 'absolute') return resolvedPath;
  return path.relative(rootDir, resolvedPath);
}

function normalizeGlobSeparators(input: string): string {
  return input.replace(/\\/g, '/');
}

function toGlobPath(input: string): string {
  return normalizeGlobSeparators(input);
}

function countLeadingRootSeparators(input: string): number {
  let count = 0;
  for (const char of input) {
    if (char !== '/' && char !== '\\') break;
    count++;
  }
  return count;
}

function getStaticGlobBase(
  patternInput: string,
  kind: SafePathKind,
): StaticGlobBase {
  const segments = patternInput.split('/');
  const firstMagicIndex = segments.findIndex((segment) => hasGlobMagic(segment));
  const magicStart = firstMagicIndex === -1 ? segments.length : firstMagicIndex;
  const baseSegments = segments.slice(0, magicStart);
  const magicSegments = segments.slice(magicStart);

  let staticBase: string;
  if (baseSegments.length === 0 || baseSegments.every((segment) => segment === '')) {
    staticBase = '.';
  } else if (
    kind === 'drive_absolute' &&
    baseSegments.length === 1 &&
    /^[a-zA-Z]:$/.test(baseSegments[0])
  ) {
    staticBase = `${baseSegments[0]}/`;
  } else {
    staticBase = baseSegments.join('/') || '.';
  }

  return {
    staticBase,
    magicRemainder: magicSegments.join('/'),
  };
}

function containsParentTraversal(globPart: string): boolean {
  return globPart.split('/').some((segment) => segment === '..');
}

function joinGlobParts(base: string, remainder: string): string {
  const normalizedBase = base === '.' ? '' : base.replace(/^\.\//, '');
  if (normalizedBase.length === 0) return remainder.length > 0 ? remainder : '.';
  if (remainder.length === 0) return normalizedBase;
  return `${normalizedBase}/${remainder}`;
}

async function findExistingAncestor(directoryPath: string): Promise<string> {
  let current = directoryPath;

  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}
