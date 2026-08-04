import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob, Ignore } from 'glob';
import {
  formatPathSafetyError,
  resolveSafeGlobEntry,
  resolveSafeGlobPatternInContext,
  resolveSafePathInContext,
  type PathSafetyContext,
  type SafeGlobPattern,
  type SafePath,
  type WorkspaceRoot,
} from './paths.js';

export interface FileAccessPolicyQuery {
  readonly isIgnored: (candidate: string) => boolean;
}

export interface RootFileAccessPolicy {
  readonly rootDir: string;
  readonly realRootDir: string;
  readonly ignore: FileAccessPolicyQuery;
  readonly deny: FileAccessPolicyQuery;
}

export interface FileAccessPolicyContext {
  readonly pathSafetyContext: PathSafetyContext;
  readonly roots: readonly RootFileAccessPolicy[];
}

export type FileAccessTargetKind = 'file' | 'directory';

export interface FileAccessReadTarget {
  readonly safePath: SafePath;
  readonly realPath: string;
  readonly kind: FileAccessTargetKind;
}

export type FileAccessPathResult =
  | { readonly ok: true; readonly path: SafePath }
  | {
      readonly ok: false;
      readonly code: 'path_safety' | 'deny_policy';
      readonly reason: string;
    };

export type FileAccessReadTargetResult =
  | { readonly ok: true; readonly target: FileAccessReadTarget }
  | {
      readonly ok: false;
      readonly code:
        | 'not_found'
        | 'outside_root_dir'
        | 'io_error'
        | 'deny_policy';
      readonly reason: string;
    };

export type FileAccessWriteTargetResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'outside_root_dir' | 'io_error' | 'deny_policy';
      readonly reason: string;
    };

export interface FileAccessGlobExpansion {
  readonly files: readonly FileAccessReadTarget[];
  readonly skipped: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
  readonly blockedByDeny: boolean;
}

export type FileAccessGlobExpansionResult =
  | { readonly ok: true; readonly expansion: FileAccessGlobExpansion }
  | {
      readonly ok: false;
      readonly code: 'path_safety' | 'deny_policy' | 'io_error';
      readonly reason: string;
    };

const EMPTY_QUERY: FileAccessPolicyQuery = Object.freeze({
  isIgnored: () => false,
});

export function createFileAccessPolicyContext(
  pathSafetyContext: PathSafetyContext,
  policies: readonly RootFileAccessPolicy[] = [],
): FileAccessPolicyContext {
  if (policies.length > 0) {
    for (const root of pathSafetyContext.allowedRoots) {
      const matches = policies.filter((policy) =>
        areSamePath(policy.rootDir, root.rootDir)
      );
      if (matches.length !== 1) {
        throw new Error(
          `File access policy must contain exactly one entry for workspace root ${root.rootDir}.`,
        );
      }
      const realRootDir = root.realRootDir ?? matches[0]?.realRootDir;
      if (
        realRootDir === undefined ||
        !areSamePath(matches[0]?.realRootDir ?? '', realRootDir)
      ) {
        throw new Error(
          `File access policy real root does not match workspace root ${root.rootDir}.`,
        );
      }
    }
    if (policies.length !== pathSafetyContext.allowedRoots.length) {
      throw new Error(
        'File access policy contains roots that are not configured workspace roots.',
      );
    }
  }

  const roots = pathSafetyContext.allowedRoots.map((root) => {
    const configured = policies.find((policy) =>
      areSamePath(policy.rootDir, root.rootDir)
    );
    return Object.freeze({
      rootDir: root.rootDir,
      realRootDir: root.realRootDir ?? configured?.realRootDir ?? root.rootDir,
      ignore: configured?.ignore ?? EMPTY_QUERY,
      deny: configured?.deny ?? EMPTY_QUERY,
    });
  });

  return Object.freeze({
    pathSafetyContext,
    roots: Object.freeze(roots),
  });
}

export function createPolicyCandidate(
  targetPath: string,
  rootDir: string,
  kind: FileAccessTargetKind,
): string | null {
  const relative = path.relative(path.resolve(rootDir), path.resolve(targetPath));
  if (relative === '') return null;
  if (path.isAbsolute(relative)) {
    throw new Error('Policy candidate is outside its associated root.');
  }

  const normalized = relative.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    segments.some((segment) =>
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\\')
    )
  ) {
    throw new Error('Policy candidate contains an invalid path segment.');
  }

  return kind === 'directory' ? `${normalized}/` : normalized;
}

export function resolveFileAccessPath(
  input: string,
  context: FileAccessPolicyContext,
): FileAccessPathResult {
  const result = resolveSafePathInContext(input, context.pathSafetyContext);
  if (!result.ok) {
    return {
      ok: false,
      code: 'path_safety',
      reason: formatPathSafetyError(result.error),
    };
  }

  if (isDenied(result.path.resolvedPath, result.path.matchedRoot, 'file', context, false)) {
    return denyResult(input);
  }

  return { ok: true, path: result.path };
}

export async function validateFileAccessReadTarget(
  safePath: SafePath,
  context: FileAccessPolicyContext,
): Promise<FileAccessReadTargetResult> {
  let realPath: string;
  try {
    realPath = await fs.realpath(safePath.resolvedPath);
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

  const rootPolicy = policyForRoot(context, safePath.matchedRoot);
  if (!isInsideRoot(realPath, rootPolicy.realRootDir)) {
    return {
      ok: false,
      code: 'outside_root_dir',
      reason:
        `Path ${safePath.input} resolves outside its matched workspace root. ` +
        'Symlinks and real paths must stay within the same matched workspace root.',
    };
  }

  let stats;
  try {
    stats = await fs.stat(realPath);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return {
      ok: false,
      code: error.code === 'ENOENT' ? 'not_found' : 'io_error',
      reason: error.code === 'ENOENT' ? 'file not found' : error.message,
    };
  }

  const kind: FileAccessTargetKind = stats.isDirectory() ? 'directory' : 'file';
  if (
    isDenied(safePath.resolvedPath, safePath.matchedRoot, kind, context, false) ||
    isDenied(realPath, safePath.matchedRoot, kind, context, true)
  ) {
    return denyReadResult(safePath.input);
  }

  return {
    ok: true,
    target: {
      safePath,
      realPath,
      kind,
    },
  };
}

export async function validateFileAccessWriteTarget(
  safePath: SafePath,
  context: FileAccessPolicyContext,
): Promise<FileAccessWriteTargetResult> {
  const rootPolicy = policyForRoot(context, safePath.matchedRoot);
  let existingAncestor: string;
  try {
    existingAncestor = await findExistingAncestor(path.dirname(safePath.resolvedPath));
    const realAncestor = await fs.realpath(existingAncestor);
    if (!isInsideRoot(realAncestor, rootPolicy.realRootDir)) {
      return {
        ok: false,
        code: 'outside_root_dir',
        reason:
          `Path ${safePath.input} resolves outside its matched workspace root. ` +
          'Symlinks and real paths must stay within the same matched workspace root.',
      };
    }

    const remainder = path.relative(existingAncestor, safePath.resolvedPath);
    const predictedRealTarget = path.resolve(realAncestor, remainder);
    if (
      !isInsideRoot(predictedRealTarget, rootPolicy.realRootDir) ||
      isDenied(predictedRealTarget, safePath.matchedRoot, 'file', context, true)
    ) {
      return isInsideRoot(predictedRealTarget, rootPolicy.realRootDir)
        ? denyWriteResult(safePath.input)
        : {
            ok: false,
            code: 'outside_root_dir',
            reason:
              `Path ${safePath.input} resolves outside its matched workspace root. ` +
              'Symlinks and real paths must stay within the same matched workspace root.',
          };
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return {
      ok: false,
      code: 'io_error',
      reason: `Could not validate write path ${safePath.input}: ${error.message}. Check the path and permissions.`,
    };
  }

  try {
    const stats = await fs.lstat(safePath.resolvedPath);
    const realPath = await fs.realpath(safePath.resolvedPath);
    const actualStats = await fs.stat(realPath);
    const kind: FileAccessTargetKind = actualStats.isDirectory() ? 'directory' : 'file';

    if (
      isDenied(safePath.resolvedPath, safePath.matchedRoot, kind, context, false) ||
      isDenied(realPath, safePath.matchedRoot, kind, context, true)
    ) {
      return denyWriteResult(safePath.input);
    }

    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        code: 'io_error',
        reason:
          `Cannot write file ${safePath.input}: target path is a symbolic link. ` +
          'Provide a regular file path inside the matched workspace root.',
      };
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      return {
        ok: false,
        code: 'io_error',
        reason: `Could not validate write target ${safePath.input}: ${error.message}. Check the path and permissions.`,
      };
    }
  }

  return { ok: true };
}

export async function expandFileAccessGlob(
  input: string,
  context: FileAccessPolicyContext,
): Promise<FileAccessGlobExpansionResult> {
  const globResult = resolveSafeGlobPatternInContext(
    input,
    context.pathSafetyContext,
  );
  if (!globResult.ok) {
    return {
      ok: false,
      code: 'path_safety',
      reason: formatPathSafetyError(globResult.error),
    };
  }

  const staticBaseResult = await validateGlobStaticBase(globResult.glob, context);
  if (!staticBaseResult.ok) return staticBaseResult;
  if (!staticBaseResult.existsAsDirectory) {
    return {
      ok: true,
      expansion: { files: [], skipped: [], blockedByDeny: false },
    };
  }

  let blockedByDeny = false;
  const controlledFs = {
    readdir: (
      directory: nodeFs.PathLike,
      options: nodeFs.ObjectEncodingOptions & { withFileTypes: true },
      callback: (error: NodeJS.ErrnoException | null, entries?: nodeFs.Dirent[]) => void,
    ): void => {
      const directoryPath = path.resolve(directory.toString());
      void validateTraversalDirectory(
        directoryPath,
        globResult.glob.matchedRoot,
        context,
      ).then((validation) => {
        if (!validation.ok) {
          if (validation.code === 'deny_policy') blockedByDeny = true;
          const error = Object.assign(new Error(validation.reason), {
            code: 'EACCES',
          }) as NodeJS.ErrnoException;
          callback(error);
          return;
        }
        nodeFs.readdir(directory, options, callback);
      }).catch((err: unknown) => {
        callback(err as NodeJS.ErrnoException);
      });
    },
  };

  let entries: string[];
  try {
    entries = await glob(globResult.glob.pattern, {
      cwd: globResult.glob.rootDir,
      nodir: true,
      dot: true,
      absolute: true,
      follow: false,
      fs: controlledFs,
    });
  } catch (err: unknown) {
    return {
      ok: false,
      code: 'io_error',
      reason:
        `Glob pattern error: ${err instanceof Error ? err.message : String(err)}. ` +
        'Check that the include pattern is valid.',
    };
  }

  const files: FileAccessReadTarget[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const entry of entries) {
    const safeEntry = resolveSafeGlobEntry(entry, globResult.glob);
    if (!safeEntry.ok) {
      skipped.push({ path: entry, reason: formatPathSafetyError(safeEntry.error) });
      continue;
    }

    const target = await validateFileAccessReadTarget(safeEntry.path, context);
    if (!target.ok) {
      if (target.code === 'deny_policy') {
        blockedByDeny = true;
      } else {
        skipped.push({
          path: safeEntry.path.displayPath,
          reason: target.reason,
        });
      }
      continue;
    }
    if (target.target.kind === 'file') files.push(target.target);
  }

  return {
    ok: true,
    expansion: { files, skipped, blockedByDeny },
  };
}

export function isIgnoredByFileAccessPolicy(
  safePath: SafePath,
  context: FileAccessPolicyContext,
): boolean {
  const candidate = createPolicyCandidate(
    safePath.resolvedPath,
    safePath.matchedRoot.rootDir,
    'file',
  );
  return candidate !== null &&
    policyForRoot(context, safePath.matchedRoot).ignore.isIgnored(candidate);
}

export function matchesExcludePattern(
  safePath: SafePath,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) return false;
  const matcher = new Ignore([...patterns], {
    dot: true,
    nocase: process.platform === 'win32',
  });
  const candidate = createPolicyCandidate(
    safePath.resolvedPath,
    safePath.matchedRoot.rootDir,
    'file',
  );
  if (candidate === null) return false;
  return matcher.ignored({
    fullpath: () => safePath.resolvedPath,
    relative: () => candidate,
  } as Parameters<Ignore['ignored']>[0]);
}

async function validateGlobStaticBase(
  globPattern: SafeGlobPattern,
  context: FileAccessPolicyContext,
): Promise<
  | { readonly ok: true; readonly existsAsDirectory: boolean }
  | {
      readonly ok: false;
      readonly code: 'deny_policy' | 'io_error';
      readonly reason: string;
    }
> {
  const root = globPattern.matchedRoot;
  if (
    !areSamePath(globPattern.resolvedStaticBase, root.rootDir) &&
    isDenied(globPattern.resolvedStaticBase, root, 'directory', context, false)
  ) {
    return denyGlobResult(globPattern.input);
  }

  let existingAncestor: string;
  try {
    existingAncestor = await findExistingAncestor(globPattern.resolvedStaticBase);
    const realAncestor = await fs.realpath(existingAncestor);
    const rootPolicy = policyForRoot(context, root);
    if (!isInsideRoot(realAncestor, rootPolicy.realRootDir)) {
      return {
        ok: false,
        code: 'io_error',
        reason:
          `Glob static base ${globPattern.input} resolves outside its matched workspace root.`,
      };
    }
    const remainder = path.relative(existingAncestor, globPattern.resolvedStaticBase);
    const predictedRealBase = path.resolve(realAncestor, remainder);
    if (
      !areSamePath(predictedRealBase, rootPolicy.realRootDir) &&
      isDenied(predictedRealBase, root, 'directory', context, true)
    ) {
      return denyGlobResult(globPattern.input);
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return {
      ok: false,
      code: 'io_error',
      reason: `Could not validate glob static base ${globPattern.input}: ${error.message}.`,
    };
  }

  try {
    const stats = await fs.stat(globPattern.resolvedStaticBase);
    return { ok: true, existsAsDirectory: stats.isDirectory() };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return { ok: true, existsAsDirectory: true };
    }
    return {
      ok: false,
      code: 'io_error',
      reason: `Could not inspect glob static base ${globPattern.input}: ${error.message}.`,
    };
  }
}

async function validateTraversalDirectory(
  directoryPath: string,
  root: WorkspaceRoot,
  context: FileAccessPolicyContext,
): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'deny_policy' | 'io_error';
      readonly reason: string;
    }
> {
  if (
    !isInsideRoot(directoryPath, root.rootDir) ||
    (
      !areSamePath(directoryPath, root.rootDir) &&
      isDenied(directoryPath, root, 'directory', context, false)
    )
  ) {
    return isInsideRoot(directoryPath, root.rootDir)
      ? { ...denyGlobResult('glob traversal'), reason: 'Directory was blocked by the file access deny policy.' }
      : { ok: false, code: 'io_error', reason: 'Glob traversal left its matched workspace root.' };
  }

  try {
    const realPath = await fs.realpath(directoryPath);
    const rootPolicy = policyForRoot(context, root);
    if (!isInsideRoot(realPath, rootPolicy.realRootDir)) {
      return {
        ok: false,
        code: 'io_error',
        reason: 'Glob traversal resolved outside its matched workspace root.',
      };
    }
    if (
      !areSamePath(realPath, rootPolicy.realRootDir) &&
      isDenied(realPath, root, 'directory', context, true)
    ) {
      return {
        ok: false,
        code: 'deny_policy',
        reason: 'Directory was blocked by the file access deny policy.',
      };
    }
    return { ok: true };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return { ok: false, code: 'io_error', reason: error.message };
  }
}

function isDenied(
  targetPath: string,
  root: WorkspaceRoot,
  kind: FileAccessTargetKind,
  context: FileAccessPolicyContext,
  realPath: boolean,
): boolean {
  const policy = policyForRoot(context, root);
  const rootDir = realPath ? policy.realRootDir : policy.rootDir;
  const candidate = createPolicyCandidate(targetPath, rootDir, kind);
  return candidate !== null && policy.deny.isIgnored(candidate);
}

function policyForRoot(
  context: FileAccessPolicyContext,
  root: WorkspaceRoot,
): RootFileAccessPolicy {
  const policy = context.roots.find((candidate) =>
    areSamePath(candidate.rootDir, root.rootDir)
  );
  if (policy === undefined) {
    throw new Error(`Missing file access policy for workspace root ${root.rootDir}.`);
  }
  return policy;
}

function denyMessage(input: string): string {
  return `Access to ${input} was blocked by the file access deny policy.`;
}

function denyResult(input: string): FileAccessPathResult {
  return { ok: false, code: 'deny_policy', reason: denyMessage(input) };
}

function denyReadResult(input: string): FileAccessReadTargetResult {
  return { ok: false, code: 'deny_policy', reason: denyMessage(input) };
}

function denyWriteResult(input: string): FileAccessWriteTargetResult {
  return { ok: false, code: 'deny_policy', reason: denyMessage(input) };
}

function denyGlobResult(
  input: string,
): {
  readonly ok: false;
  readonly code: 'deny_policy';
  readonly reason: string;
} {
  return { ok: false, code: 'deny_policy', reason: denyMessage(input) };
}

function areSamePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isInsideRoot(candidatePath: string, rootDir: string): boolean {
  const normalizedRoot = path.resolve(rootDir);
  const normalizedCandidate = path.resolve(candidatePath);
  if (areSamePath(normalizedCandidate, normalizedRoot)) return true;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function findExistingAncestor(targetPath: string): Promise<string> {
  let current = targetPath;
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
