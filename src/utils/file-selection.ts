import {
  expandFileAccessGlob,
  isIgnoredByFileAccessPolicy,
  matchesExcludePattern,
  resolveFileAccessPath,
  validateFileAccessReadTarget,
  type FileAccessPolicyContext,
} from './file-access-policy.js';
import { hasGlobMagic } from './paths.js';

export interface SelectedReadableFile {
  readonly readPath: string;
  readonly displayPath: string;
}

export type ReadableFileSelectionEntry =
  | {
      readonly ok: true;
      readonly includeIndex: number;
      readonly file: SelectedReadableFile;
    }
  | {
      readonly ok: false;
      readonly includeIndex: number;
      readonly path: string;
      readonly reason: string;
      readonly denied: boolean;
    };

export interface ReadableFileSelection {
  readonly entries: readonly ReadableFileSelectionEntry[];
  readonly blockedByDeny: boolean;
  readonly ignoredByPolicy: boolean;
}

export interface ReadableFileSelectionRequest {
  readonly pathSelectors: readonly (string | { readonly file_path: string })[];
  readonly discoveryExcludePatterns: readonly string[];
  readonly respectIgnoreFiles: boolean;
  readonly fileAccessPolicyContext: FileAccessPolicyContext;
  readonly signal?: AbortSignal;
}

/** Compares validated real paths using the host filesystem's path casing convention. */
export function fileIdentityKey(realPath: string): string {
  return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
}

/**
 * Preserves selector provenance and duplicates for the caller's own request semantics.
 * Only glob discoveries receive ignore/exclude filtering; every path still passes
 * through deny, root containment, realpath, and controlled traversal checks.
 */
export async function selectReadableFiles(
  request: ReadableFileSelectionRequest,
  expandGlob: typeof expandFileAccessGlob = expandFileAccessGlob,
): Promise<ReadableFileSelection> {
  const entries: ReadableFileSelectionEntry[] = [];
  let blockedByDeny = false;
  let ignoredByPolicy = false;

  for (const [includeIndex, selector] of request.pathSelectors.entries()) {
    request.signal?.throwIfAborted();
    const item = typeof selector === 'string' ? selector : selector.file_path;
    const itemHasGlobMagic = typeof selector === 'string' && hasGlobMagic(item);
    const slashLeadingGlob =
      itemHasGlobMagic &&
      (item.startsWith('/') || item.startsWith('\\')) &&
      !(item.startsWith('//') || item.startsWith('\\\\'));

    if (!slashLeadingGlob) {
      const safePathResult = resolveFileAccessPath(item, request.fileAccessPolicyContext);
      if (!safePathResult.ok) {
        const denied = safePathResult.code === 'deny_policy';
        entries.push({
          ok: false,
          includeIndex,
          path: item,
          reason: safePathResult.reason,
          denied,
        });
        continue;
      }

      const readTarget = await validateFileAccessReadTarget(
        safePathResult.path,
        request.fileAccessPolicyContext,
      );
      request.signal?.throwIfAborted();
      if (readTarget.ok && readTarget.target.kind === 'file') {
        entries.push({
          ok: true,
          includeIndex,
          file: {
            readPath: readTarget.target.realPath,
            displayPath: safePathResult.path.displayPath,
          },
        });
        continue;
      }
      if (!itemHasGlobMagic || (!readTarget.ok && readTarget.code !== 'not_found')) {
        const denied = !readTarget.ok && readTarget.code === 'deny_policy';
        entries.push({
          ok: false,
          includeIndex,
          path: item,
          reason: readTarget.ok ? 'not a file' : readTarget.reason,
          denied,
        });
        continue;
      }
    }

    const result = await expandGlob(item, request.fileAccessPolicyContext);
    request.signal?.throwIfAborted();
    if (!result.ok) {
      const denied = result.code === 'deny_policy';
      entries.push({ ok: false, includeIndex, path: item, reason: result.reason, denied });
      continue;
    }

    blockedByDeny ||= result.expansion.blockedByDeny;
    const globEntries: ReadableFileSelectionEntry[] = result.expansion.skipped.map((skipped) => ({
      ok: false,
      includeIndex,
      path: skipped.path,
      reason: skipped.reason,
      denied: false,
    }));
    for (const target of result.expansion.files) {
      request.signal?.throwIfAborted();
      if (
        request.respectIgnoreFiles &&
        isIgnoredByFileAccessPolicy(target.safePath, request.fileAccessPolicyContext)
      ) {
        ignoredByPolicy = true;
        continue;
      }
      if (matchesExcludePattern(target.safePath, request.discoveryExcludePatterns)) continue;

      globEntries.push({
        ok: true,
        includeIndex,
        file: { readPath: target.realPath, displayPath: target.safePath.displayPath },
      });
    }
    globEntries.sort((left, right) =>
      (left.ok ? left.file.displayPath : left.path).localeCompare(
        right.ok ? right.file.displayPath : right.path,
      ),
    );
    // Broad globs can exceed V8's function argument limit when spread into push.
    for (const entry of globEntries) entries.push(entry);
  }

  request.signal?.throwIfAborted();
  return { entries, blockedByDeny, ignoredByPolicy };
}
