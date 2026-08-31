import { extname } from 'node:path';
import {
  constants as fsConstants,
  type BigIntStats,
} from 'node:fs';
import {
  lstat,
  open,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { ToolInvocationContext } from '../runtime/tool-invocation-context.js';
import {
  extractGuidelineFrontMatterSource,
  parseGuidelineFrontMatter,
  type GuidelineMetadata,
} from '../engine/guideline-front-matter.js';
import {
  selectReadableFiles,
  type SelectedReadableFile,
} from '../utils/file-selection.js';
import {
  DISCOVER_GUIDELINES_TOOL_DEFINITION,
  MAX_GUIDELINE_FILES,
  MAX_GUIDELINE_PREFIX_BYTES,
  MAX_GUIDELINE_READ_WORKERS,
} from './definitions/discover-guidelines.definition.js';
import { textErrorResult, textResult } from './results.js';
import type { MCPTool, ToolCallResult } from './types.js';

const CANCELLED_MESSAGE = 'The discover_guidelines tool call was cancelled.';
const INTERNAL_ERROR_MESSAGE =
  'Guideline discovery failed because of an unexpected internal error. Retry with narrower selectors.';
const PREFIX_READ_CHUNK_BYTES = 4 * 1024;
const SAFE_READ_OPEN_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0);

interface DiscoveredGuideline extends GuidelineMetadata {
  readonly file_path: string;
}

interface DiscoveryPayload {
  readonly guidelines: readonly DiscoveredGuideline[];
  readonly note?: string;
}

interface PrefixReadResult {
  readonly text: string;
  readonly containsWholeFile: boolean;
}

interface OpenedSelectedFile {
  readonly handle: FileHandle;
  readonly stats: BigIntStats;
}

type FileInspectionResult =
  | { readonly ok: true; readonly metadata: GuidelineMetadata | null }
  | { readonly ok: false };

type GuidelineFileInspector = (
  file: SelectedReadableFile,
  signal: AbortSignal,
) => Promise<FileInspectionResult>;

async function readBoundedPrefix(
  fileHandle: FileHandle,
  sizeAtOpen: number,
  signal: AbortSignal,
): Promise<PrefixReadResult> {
  const buffer = Buffer.allocUnsafe(MAX_GUIDELINE_PREFIX_BYTES);
  let bytesRead = 0;

  while (bytesRead < buffer.length) {
    if (signal.aborted) {
      break;
    }
    const result = await fileHandle.read(
      buffer,
      bytesRead,
      Math.min(PREFIX_READ_CHUNK_BYTES, buffer.length - bytesRead),
      bytesRead,
    );
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;

    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const containsWholeFile = sizeAtOpen <= bytesRead;
    const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text;
    if (
      ((containsWholeFile || bytesRead >= 8) &&
        !withoutBom.startsWith('---\n') &&
        !withoutBom.startsWith('---\r\n')) ||
      extractGuidelineFrontMatterSource(text, containsWholeFile) !== null
    ) {
      return { text, containsWholeFile };
    }
  }

  return {
    text: buffer.subarray(0, bytesRead).toString('utf8'),
    containsWholeFile: sizeAtOpen <= bytesRead,
  };
}

function sameFileIdentity(
  openedStats: BigIntStats,
  pathStats: BigIntStats,
): boolean {
  return (
    openedStats.dev === pathStats.dev &&
    openedStats.ino === pathStats.ino
  );
}

async function openSelectedRegularFile(
  filePath: string,
): Promise<OpenedSelectedFile | null> {
  let fileHandle: FileHandle | undefined;
  try {
    const beforeOpenStats = await lstat(filePath, { bigint: true });
    if (!beforeOpenStats.isFile()) {
      return null;
    }

    fileHandle = await open(filePath, SAFE_READ_OPEN_FLAGS);
    const openedStats = await fileHandle.stat({ bigint: true });
    if (!openedStats.isFile()) {
      await fileHandle.close();
      return null;
    }

    const [revalidatedPath, pathStats] = await Promise.all([
      realpath(filePath),
      lstat(filePath, { bigint: true }),
    ]);
    if (
      revalidatedPath !== filePath ||
      !pathStats.isFile() ||
      !sameFileIdentity(openedStats, pathStats)
    ) {
      await fileHandle.close();
      return null;
    }

    return { handle: fileHandle, stats: openedStats };
  } catch {
    await fileHandle?.close().catch(() => undefined);
    return null;
  }
}

async function inspectGuidelineFile(
  file: SelectedReadableFile,
  signal: AbortSignal,
): Promise<FileInspectionResult> {
  let fileHandle: FileHandle | undefined;
  let result: FileInspectionResult = { ok: false };
  try {
    const openedFile = await openSelectedRegularFile(file.readPath);
    if (!openedFile) {
      return result;
    }
    fileHandle = openedFile.handle;
    const prefix = await readBoundedPrefix(
      fileHandle,
      Number(openedFile.stats.size),
      signal,
    );
    if (!signal.aborted) {
      result = {
        ok: true,
        metadata: parseGuidelineFrontMatter(
          prefix.text,
          prefix.containsWholeFile,
        ),
      };
    }
  } catch {
    result = { ok: false };
  } finally {
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch {
        result = { ok: false };
      }
    }
  }
  return result;
}

async function inspectFilesWithWorkerLimit(
  files: readonly SelectedReadableFile[],
  signal: AbortSignal,
  inspector: GuidelineFileInspector,
): Promise<readonly (FileInspectionResult | undefined)[]> {
  const results: Array<FileInspectionResult | undefined> = new Array(
    files.length,
  );
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (!signal.aborted) {
      const index = nextIndex;
      if (index >= files.length) {
        return;
      }
      nextIndex += 1;
      const file = files[index];
      if (!file) {
        return;
      }
      results[index] = await inspector(file, signal);
    }
  }

  const workerCount = Math.min(MAX_GUIDELINE_READ_WORKERS, files.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => worker()),
  );
  return results;
}

function successPayload(
  guidelines: readonly DiscoveredGuideline[],
  notes: readonly string[],
): ToolCallResult {
  const payload: DiscoveryPayload =
    notes.length === 0
      ? { guidelines }
      : { guidelines, note: notes.join(' ') };
  return textResult(JSON.stringify(payload));
}

async function discoverGuidelines(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
  invocation: ToolInvocationContext,
  inspector: GuidelineFileInspector,
): Promise<ToolCallResult> {
  if (invocation.signal.aborted) {
    return textErrorResult(CANCELLED_MESSAGE);
  }

  try {
    const selectionResult = await selectReadableFiles({
      pathSelectors: args.include as string[],
      discoveryExcludePatterns:
        (args.exclude as string[] | undefined) ?? [],
      respectIgnoreFiles:
        (args.use_ignore_files as boolean | undefined) ?? false,
      fileAccessPolicyContext: context.fileAccessPolicyContext,
    });
    if (!selectionResult.ok) {
      return textErrorResult(selectionResult.reason);
    }
    if (invocation.signal.aborted) {
      return textErrorResult(CANCELLED_MESSAGE);
    }

    const {
      files,
      skipped,
      blockedByDeny,
      ignoredByPolicy,
    } = selectionResult.selection;
    const sortedFiles = [...files].sort((left, right) =>
      left.readPath.localeCompare(right.readPath),
    );
    const markdownFiles = sortedFiles.filter(
      (file) => extname(file.readPath).toLowerCase() === '.md',
    );
    const filesLimited = markdownFiles.length > MAX_GUIDELINE_FILES;
    const inspectedFiles = markdownFiles.slice(0, MAX_GUIDELINE_FILES);
    const inspectionResults = await inspectFilesWithWorkerLimit(
      inspectedFiles,
      invocation.signal,
      inspector,
    );
    if (invocation.signal.aborted) {
      return textErrorResult(CANCELLED_MESSAGE);
    }

    const guidelines: DiscoveredGuideline[] = [];
    let inspectionFailed = false;
    for (let index = 0; index < inspectedFiles.length; index += 1) {
      const result = inspectionResults[index];
      if (!result?.ok) {
        inspectionFailed = true;
        continue;
      }
      if (result.metadata) {
        const file = inspectedFiles[index];
        if (file) {
          guidelines.push({
            ...result.metadata,
            file_path: file.displayPath,
          });
        }
      }
    }

    const notes: string[] = [];
    if (files.length === 0) {
      notes.push(
        skipped.length > 0
          ? 'No readable files were selected from the given include selectors.'
          : 'No files matched the given include selectors.',
      );
    } else if (markdownFiles.length === 0) {
      notes.push('Matched files were found, but none were Markdown files.');
    } else if (guidelines.length === 0) {
      notes.push(
        'Markdown files were found, but none contained valid guideline Front Matter.',
      );
    }
    if (filesLimited) {
      notes.push(
        `Only the first ${MAX_GUIDELINE_FILES} matched Markdown files were inspected. Use more specific selectors for a complete result.`,
      );
    }
    if (files.length > 0 && blockedByDeny) {
      notes.push('Some paths were blocked by the file access deny policy.');
    }
    if (files.length > 0 && ignoredByPolicy) {
      notes.push(
        'Some glob-discovered paths were filtered by configured ignoreFiles rules.',
      );
    }
    if (skipped.length > 0 || inspectionFailed) {
      notes.push(
        'Some include selectors or selected files could not be inspected.',
      );
    }

    if (invocation.signal.aborted) {
      return textErrorResult(CANCELLED_MESSAGE);
    }
    return successPayload(guidelines, notes);
  } catch {
    return invocation.signal.aborted
      ? textErrorResult(CANCELLED_MESSAGE)
      : textErrorResult(INTERNAL_ERROR_MESSAGE);
  }
}

async function handleDiscoverGuidelines(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
  invocation: ToolInvocationContext,
): Promise<ToolCallResult> {
  return discoverGuidelines(args, context, invocation, inspectGuidelineFile);
}

export const discoverGuidelinesInternalForTests = Object.freeze({
  discoverGuidelines,
  inspectGuidelineFile,
  inspectFilesWithWorkerLimit,
  readBoundedPrefix,
});

const discoverGuidelinesTool: MCPTool = {
  definition: DISCOVER_GUIDELINES_TOOL_DEFINITION,
  handler: handleDiscoverGuidelines,
};

export default discoverGuidelinesTool;
