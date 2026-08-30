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

export interface SkippedFileSelection {
  readonly path: string;
  readonly reason: string;
}

export interface ReadableFileSelection {
  readonly files: readonly SelectedReadableFile[];
  readonly skipped: readonly SkippedFileSelection[];
  readonly blockedByDeny: boolean;
  readonly ignoredByPolicy: boolean;
}

export interface ReadableFileSelectionRequest {
  readonly pathSelectors: readonly string[];
  readonly discoveryExcludePatterns: readonly string[];
  readonly respectIgnoreFiles: boolean;
  readonly fileAccessPolicyContext: FileAccessPolicyContext;
}

export type ReadableFileSelectionResult =
  | { readonly ok: true; readonly selection: ReadableFileSelection }
  | { readonly ok: false; readonly reason: string };

type LiteralDecision = 'added' | 'handled' | 'continue_to_glob';

function fileKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function addFile(
  fileMap: Map<string, SelectedReadableFile>,
  entry: SelectedReadableFile,
): void {
  const key = fileKey(entry.readPath);
  if (!fileMap.has(key)) {
    fileMap.set(key, entry);
  }
}

async function tryAddLiteralFile(
  item: string,
  itemHasGlobMagic: boolean,
  fileAccessPolicyContext: FileAccessPolicyContext,
  fileMap: Map<string, SelectedReadableFile>,
  skipped: SkippedFileSelection[],
): Promise<
  | { readonly ok: true; readonly decision: LiteralDecision }
  | { readonly ok: false; readonly reason: string }
> {
  const safePathResult = resolveFileAccessPath(item, fileAccessPolicyContext);
  if (!safePathResult.ok) {
    if (safePathResult.code === 'deny_policy') {
      return { ok: false, reason: safePathResult.reason };
    }
    skipped.push({ path: item, reason: safePathResult.reason });
    return { ok: true, decision: 'handled' };
  }

  const safePath = safePathResult.path;
  const readTarget = await validateFileAccessReadTarget(
    safePath,
    fileAccessPolicyContext,
  );
  if (!readTarget.ok) {
    if (readTarget.code === 'not_found' && itemHasGlobMagic) {
      return { ok: true, decision: 'continue_to_glob' };
    }
    if (readTarget.code === 'deny_policy') {
      return { ok: false, reason: readTarget.reason };
    }
    skipped.push({ path: item, reason: readTarget.reason });
    return { ok: true, decision: 'handled' };
  }

  if (readTarget.target.kind !== 'file') {
    if (itemHasGlobMagic) {
      return { ok: true, decision: 'continue_to_glob' };
    }
    skipped.push({ path: item, reason: 'not a file' });
    return { ok: true, decision: 'handled' };
  }

  addFile(fileMap, {
    readPath: readTarget.target.realPath,
    displayPath: safePath.displayPath,
  });
  return { ok: true, decision: 'added' };
}

async function addGlobFiles(
  item: string,
  request: ReadableFileSelectionRequest,
  fileMap: Map<string, SelectedReadableFile>,
  skipped: SkippedFileSelection[],
): Promise<
  | {
      readonly ok: true;
      readonly blockedByDeny: boolean;
      readonly ignoredByPolicy: boolean;
    }
  | { readonly ok: false; readonly reason: string }
> {
  const result = await expandFileAccessGlob(
    item,
    request.fileAccessPolicyContext,
  );
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }

  skipped.push(...result.expansion.skipped);
  let ignoredByPolicy = false;
  for (const target of result.expansion.files) {
    if (
      request.respectIgnoreFiles &&
      isIgnoredByFileAccessPolicy(
        target.safePath,
        request.fileAccessPolicyContext,
      )
    ) {
      ignoredByPolicy = true;
      continue;
    }
    if (
      matchesExcludePattern(
        target.safePath,
        request.discoveryExcludePatterns,
      )
    ) {
      continue;
    }

    addFile(fileMap, {
      readPath: target.realPath,
      displayPath: target.safePath.displayPath,
    });
  }

  return {
    ok: true,
    blockedByDeny: result.expansion.blockedByDeny,
    ignoredByPolicy,
  };
}

/**
 * Resolves literal paths and glob expressions into readable files.
 *
 * Literal paths bypass discovery-only exclude and ignore filters. Access deny,
 * root containment, realpath, and controlled traversal remain mandatory.
 */
export async function selectReadableFiles(
  request: ReadableFileSelectionRequest,
): Promise<ReadableFileSelectionResult> {
  const fileMap = new Map<string, SelectedReadableFile>();
  const skipped: SkippedFileSelection[] = [];
  let blockedByDeny = false;
  let ignoredByPolicy = false;

  for (const item of request.pathSelectors) {
    const itemHasGlobMagic = hasGlobMagic(item);
    const slashLeadingGlob =
      itemHasGlobMagic &&
      (item.startsWith('/') || item.startsWith('\\')) &&
      !(item.startsWith('//') || item.startsWith('\\\\'));

    if (!slashLeadingGlob) {
      const literalResult = await tryAddLiteralFile(
        item,
        itemHasGlobMagic,
        request.fileAccessPolicyContext,
        fileMap,
        skipped,
      );
      if (!literalResult.ok) return literalResult;
      if (literalResult.decision !== 'continue_to_glob') continue;
    }

    if (itemHasGlobMagic) {
      const globResult = await addGlobFiles(
        item,
        request,
        fileMap,
        skipped,
      );
      if (!globResult.ok) return globResult;
      blockedByDeny ||= globResult.blockedByDeny;
      ignoredByPolicy ||= globResult.ignoredByPolicy;
    }
  }

  return {
    ok: true,
    selection: {
      files: Array.from(fileMap.values()),
      skipped,
      blockedByDeny,
      ignoredByPolicy,
    },
  };
}
