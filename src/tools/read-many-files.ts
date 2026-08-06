import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { MCPTool, ToolCallResult } from './types.js';
import { textErrorResult, textResult } from './results.js';
import {
  expandFileAccessGlob,
  isIgnoredByFileAccessPolicy,
  matchesExcludePattern,
  resolveFileAccessPath,
  validateFileAccessReadTarget,
  type FileAccessPolicyContext,
} from '../utils/file-access-policy.js';
import { hasGlobMagic } from '../utils/paths.js';
import {
  isBinaryFile,
  readTextFile,
  MAX_LINE_LENGTH,
  MAX_LINES_PER_FILE,
} from '../utils/file-read.js';

/** Maximum number of files to process in a single call. */
const MAX_FILES = 100;

/** Recommended maximum original file size for a content-returning shallow read. */
const SHALLOW_READ_BATCH_SIZE_BYTES = 50 * 1024;
const SHALLOW_READ_BATCH_SIZE_LABEL =
  `${(SHALLOW_READ_BATCH_SIZE_BYTES / 1024).toFixed(1)} KB`;

const OUTPUT_SEPARATOR_FORMAT = '--- {filePath} ---';
const OUTPUT_TERMINATOR = '--- End of content ---';

const READ_MANY_FILES_TOOL_DEFINITION = {
  name: 'read_many_files' as const,
  description: `Reads and returns the content of multiple text files in one call.

Use this tool when reading several related files or expanding glob patterns. Text files only; binary files are skipped.
Files exceeding ${MAX_LINES_PER_FILE} lines are truncated—use read_file for a complete or targeted single-file read.

For broad file sets, use shallow_read first to inspect their size and truncation risk before requesting contents. Prefer read_file when reading only one file.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      include: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description:
          'File paths or glob patterns to read. Relative paths/globs resolve from the primary workspace root; drive-absolute paths/globs may target any configured workspace root. Examples: ["src/**/*.kt"], ["E:/workspace/project/Foo.kt", "docs/*.md"]',
      },
      exclude: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        description:
          'Optional glob patterns applied to automatically discovered glob results. Literal include paths bypass excludes. Examples: ["**/*.test.kt", "generated/**"]',
      },
      useIgnoreFiles: {
        type: 'boolean',
        description:
          'Whether configured ignoreFiles rules filter automatically discovered glob results. Defaults to true. Literal include paths bypass ignore rules. The file access deny policy always applies. Keep enabled for broad discovery. If inspection of ignored matches is needed, use the recommended workflow: first use a narrow include pattern with useIgnoreFiles=false and shallow_read=true, then read selected files by literal path.',
      },
      shallow_read: {
        type: 'boolean',
        description:
          `If true, return the matched file list with per-file line counts and sizes, total line count and size, and whether content would be truncated. Use shallow_read_content_limit_bytes to also return contents for small selections. Keep content-return thresholds at or below the recommended ${SHALLOW_READ_BATCH_SIZE_LABEL} batch size unless larger output is intentional. Defaults to false.`,
      },
      shallow_read_content_limit_bytes: {
        type: 'integer',
        minimum: 1,
        description:
          'Optional positive integer used only with shallow_read=true. If the total size of successfully processed files is less than or equal to this byte limit, return both shallow-read statistics and file contents.',
      },
      show_line_numbers: {
        type: 'boolean',
        description:
          'If true, prefix each returned content line with its original 1-based line number. This increases output size, so use it only when precise line references are needed. Defaults to false.',
      },
    },
    required: ['include'],
    additionalProperties: false,
  },
};

function validateParams(args: Record<string, unknown>): string | null {
  const allowedKeys = new Set([
    'include',
    'exclude',
    'useIgnoreFiles',
    'shallow_read',
    'shallow_read_content_limit_bytes',
    'show_line_numbers',
  ]);
  const unknownKeys = Object.keys(args).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    return `Unknown parameter(s): ${unknownKeys.join(', ')}.`;
  }
  if (!Array.isArray(args.include) || args.include.length === 0) {
    return "The 'include' parameter must be a non-empty array of strings.";
  }
  for (const item of args.include) {
    if (typeof item !== 'string' || item.length === 0) {
      return "Each item in 'include' must be a non-empty string.";
    }
  }
  if (args.exclude !== undefined) {
    if (!Array.isArray(args.exclude)) {
      return "The 'exclude' parameter must be an array of strings.";
    }
    for (const item of args.exclude) {
      if (typeof item !== 'string' || item.length === 0) {
        return "Each item in 'exclude' must be a non-empty string.";
      }
    }
  }
  if (
    args.useIgnoreFiles !== undefined &&
    typeof args.useIgnoreFiles !== 'boolean'
  ) {
    return "The 'useIgnoreFiles' parameter must be a boolean.";
  }
  if (args.shallow_read !== undefined && typeof args.shallow_read !== 'boolean') {
    return "The 'shallow_read' parameter must be a boolean.";
  }
  if (args.shallow_read_content_limit_bytes !== undefined) {
    if (
      !Number.isSafeInteger(args.shallow_read_content_limit_bytes) ||
      (args.shallow_read_content_limit_bytes as number) < 1
    ) {
      return "The 'shallow_read_content_limit_bytes' parameter must be a positive integer (JSON number).";
    }
    if (args.shallow_read !== true) {
      return "The 'shallow_read_content_limit_bytes' parameter requires 'shallow_read' to be true.";
    }
  }
  if (
    args.show_line_numbers !== undefined &&
    typeof args.show_line_numbers !== 'boolean'
  ) {
    return "The 'show_line_numbers' parameter must be a boolean.";
  }
  return null;
}

interface FileEntry {
  readPath: string;
  displayPath: string;
}

interface SkippedEntry {
  path: string;
  reason: string;
}

type LiteralDecision = 'added' | 'handled' | 'continue_to_glob';

function fileKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

function addFile(fileMap: Map<string, FileEntry>, entry: FileEntry): void {
  const key = fileKey(entry.readPath);
  if (!fileMap.has(key)) {
    fileMap.set(key, entry);
  }
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} bytes`;
  }
  return `${(sizeBytes / 1024).toFixed(1)} KB (${sizeBytes} bytes)`;
}

async function tryAddLiteralFile(
  item: string,
  itemHasGlobMagic: boolean,
  fileAccessPolicyContext: FileAccessPolicyContext,
  fileMap: Map<string, FileEntry>,
  skipped: SkippedEntry[],
): Promise<LiteralDecision | ToolCallResult> {
  const safePathResult = resolveFileAccessPath(item, fileAccessPolicyContext);
  if (!safePathResult.ok) {
    if (safePathResult.code === 'deny_policy') {
      return textErrorResult(safePathResult.reason);
    }
    skipped.push({ path: item, reason: safePathResult.reason });
    return 'handled';
  }

  const safePath = safePathResult.path;
  const readTarget = await validateFileAccessReadTarget(
    safePath,
    fileAccessPolicyContext,
  );
  if (!readTarget.ok) {
    if (readTarget.code === 'not_found' && itemHasGlobMagic) {
      return 'continue_to_glob';
    }
    if (readTarget.code === 'deny_policy') {
      return textErrorResult(readTarget.reason);
    }
    skipped.push({ path: item, reason: readTarget.reason });
    return 'handled';
  }

  if (readTarget.target.kind !== 'file') {
    if (itemHasGlobMagic) return 'continue_to_glob';
    skipped.push({ path: item, reason: 'not a file' });
    return 'handled';
  }

  addFile(fileMap, {
    readPath: readTarget.target.realPath,
    displayPath: safePath.displayPath,
  });
  return 'added';
}

async function expandGlobPattern(
  item: string,
  exclude: string[],
  useIgnoreFiles: boolean,
  fileAccessPolicyContext: FileAccessPolicyContext,
  fileMap: Map<string, FileEntry>,
  skipped: SkippedEntry[],
): Promise<{
  readonly error: string | null;
  readonly blockedByDeny: boolean;
  readonly ignoredByPolicy: boolean;
}> {
  const result = await expandFileAccessGlob(item, fileAccessPolicyContext);
  if (!result.ok) {
    return {
      error: result.reason,
      blockedByDeny: false,
      ignoredByPolicy: false,
    };
  }

  skipped.push(...result.expansion.skipped);
  let ignoredByPolicy = false;
  for (const target of result.expansion.files) {
    if (
      useIgnoreFiles &&
      isIgnoredByFileAccessPolicy(target.safePath, fileAccessPolicyContext)
    ) {
      ignoredByPolicy = true;
      continue;
    }
    if (matchesExcludePattern(target.safePath, exclude)) {
      continue;
    }

    addFile(fileMap, {
      readPath: target.realPath,
      displayPath: target.safePath.displayPath,
    });
  }

  return {
    error: null,
    blockedByDeny: result.expansion.blockedByDeny,
    ignoredByPolicy,
  };
}

async function handleReadManyFiles(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
): Promise<ToolCallResult> {
  const validationError = validateParams(args);
  if (validationError) return textErrorResult(validationError);

  const include = args.include as string[];
  const exclude = (args.exclude as string[] | undefined) ?? [];
  const useIgnoreFiles =
    (args.useIgnoreFiles as boolean | undefined) ?? true;
  const shallowRead = (args.shallow_read as boolean | undefined) ?? false;
  const shallowReadContentLimitBytes =
    args.shallow_read_content_limit_bytes as number | undefined;
  const showLineNumbers =
    (args.show_line_numbers as boolean | undefined) ?? false;

  // Prefer an existing literal file, even when its name contains glob metacharacters.
  const fileMap = new Map<string, FileEntry>();
  const skipped: SkippedEntry[] = [];
  const fileAccessPolicyContext = context.fileAccessPolicyContext;
  let blockedByDeny = false;
  let ignoredByPolicy = false;

  for (const item of include) {
    const itemHasGlobMagic = hasGlobMagic(item);
    const slashLeadingGlob =
      itemHasGlobMagic &&
      (item.startsWith('/') || item.startsWith('\\')) &&
      !(item.startsWith('//') || item.startsWith('\\\\'));

    if (!slashLeadingGlob) {
      const literalDecision = await tryAddLiteralFile(
        item,
        itemHasGlobMagic,
        fileAccessPolicyContext,
        fileMap,
        skipped,
      );

      if (typeof literalDecision !== 'string') {
        return literalDecision;
      }
      if (literalDecision !== 'continue_to_glob') {
        continue;
      }
    }

    if (itemHasGlobMagic) {
      const globExpansion = await expandGlobPattern(
        item,
        exclude,
        useIgnoreFiles,
        fileAccessPolicyContext,
        fileMap,
        skipped,
      );
      if (globExpansion.error) {
        return textErrorResult(globExpansion.error);
      }
      blockedByDeny ||= globExpansion.blockedByDeny;
      ignoredByPolicy ||= globExpansion.ignoredByPolicy;
    }
  }

  if (fileMap.size === 0 && skipped.length === 0) {
    return textErrorResult(
      'No files matched the given include patterns. ' +
        'Verify the paths/patterns and ensure files exist in the workspace.',
    );
  }

  const sortedFiles = Array.from(fileMap.values()).sort((a, b) =>
    a.readPath.localeCompare(b.readPath),
  );
  let filesLimited = false;
  if (sortedFiles.length > MAX_FILES) {
    filesLimited = true;
    sortedFiles.length = MAX_FILES;
  }

  const readResults = await Promise.allSettled(
    sortedFiles.map(async (file) => {
      if (await isBinaryFile(file.readPath)) {
        return {
          filePath: file.readPath,
          displayPath: file.displayPath,
          ok: false as const,
          reason: 'binary file',
        };
      }
      const result = await readTextFile(file.readPath, {
        showLineNumbers:
          (!shallowRead || shallowReadContentLimitBytes !== undefined) &&
          showLineNumbers,
      });
      if (!result.ok) {
        return {
          filePath: file.readPath,
          displayPath: file.displayPath,
          ok: false as const,
          reason: result.reason,
        };
      }
      return {
        filePath: file.readPath,
        displayPath: file.displayPath,
        ok: true as const,
        content: result.content,
        sizeBytes: result.sizeBytes,
        isTruncated: result.isTruncated,
        lineCountTruncated: result.lineCountTruncated,
        lineLengthTruncated: result.lineLengthTruncated,
        originalLineCount: result.originalLineCount,
        linesRead: result.linesRead,
        startLine: result.startLine,
        endLine: result.endLine,
      };
    }),
  );

  const contentParts: string[] = [];
  const processedFiles: Array<{
    filePath: string;
    displayPath: string;
    content: string;
    sizeBytes: number;
    isTruncated: boolean;
    lineCountTruncated: boolean;
    lineLengthTruncated: boolean;
    originalLineCount: number;
    linesRead: number;
    startLine: number;
    endLine: number;
  }> = [];

  for (const settled of readResults) {
    if (settled.status === 'rejected') {
      skipped.push({
        path: 'unknown',
        reason: `unexpected error: ${settled.reason}`,
      });
      continue;
    }

    const r = settled.value;
    if (!r.ok) {
      skipped.push({ path: r.displayPath, reason: r.reason });
      continue;
    }

    processedFiles.push({
      filePath: r.filePath,
      displayPath: r.displayPath,
      content: r.content,
      sizeBytes: r.sizeBytes,
      isTruncated: r.isTruncated,
      lineCountTruncated: r.lineCountTruncated,
      lineLengthTruncated: r.lineLengthTruncated,
      originalLineCount: r.originalLineCount,
      linesRead: r.linesRead,
      startLine: r.startLine,
      endLine: r.endLine,
    });
  }

  const summaryParts: string[] = [];

  summaryParts.push(
    `Read ${processedFiles.length} file(s)` +
      (skipped.length > 0 ? `, skipped ${skipped.length}` : '') +
      '.',
  );

  const totalLineCount = processedFiles.reduce(
    (sum, file) => sum + file.originalLineCount,
    0,
  );
  const totalSizeBytes = processedFiles.reduce(
    (sum, file) => sum + file.sizeBytes,
    0,
  );
  const includeShallowContent =
    shallowRead &&
    shallowReadContentLimitBytes !== undefined &&
    totalSizeBytes <= shallowReadContentLimitBytes;
  const includeContent = !shallowRead || includeShallowContent;

  if (shallowRead && processedFiles.length > 0) {
    if (shallowReadContentLimitBytes === undefined) {
      summaryParts.push('Shallow read: file contents omitted.');
    } else if (includeShallowContent) {
      summaryParts.push(
        `Shallow read: file contents included because total size is within the configured ${formatFileSize(shallowReadContentLimitBytes)} limit.`,
      );
    } else {
      summaryParts.push(
        `Shallow read: file contents omitted because total size exceeds the configured ${formatFileSize(shallowReadContentLimitBytes)} limit.`,
      );
    }
    summaryParts.push(`Total lines: ${totalLineCount}.`);
    summaryParts.push(`Total size: ${formatFileSize(totalSizeBytes)}.`);
    if (
      includeShallowContent &&
      totalSizeBytes > SHALLOW_READ_BATCH_SIZE_BYTES
    ) {
      summaryParts.push(
        `WARNING: Included file contents exceed the recommended ${SHALLOW_READ_BATCH_SIZE_LABEL} batch size. The response may be truncated or otherwise limited by the receiving client or host.`,
      );
    }
    summaryParts.push('Files:');
    for (const file of processedFiles) {
      const truncationStatus = file.isTruncated
        ? `yes (${[
            file.lineCountTruncated ? 'line count' : null,
            file.lineLengthTruncated ? 'long lines' : null,
          ].filter(Boolean).join(', ')})`
        : 'no';
      summaryParts.push(
        `- ${file.displayPath}: ${file.originalLineCount} line(s), ${formatFileSize(file.sizeBytes)}, would be truncated: ${truncationStatus}.`,
      );
    }
  }

  if (includeContent && processedFiles.length > 0) {
    const hasTruncatedContent = processedFiles.some((file) => file.isTruncated);
    if (!hasTruncatedContent) {
      summaryParts.push('No truncation: all returned file contents are complete.');
    } else {
      summaryParts.push(
        'Files without a truncation warning are returned completely.',
      );
    }

    for (const file of processedFiles) {
      const separator = OUTPUT_SEPARATOR_FORMAT.replace(
        '{filePath}',
        file.displayPath,
      );
      let block = '';
      if (file.isTruncated) {
        const truncationReasons = [
          file.lineCountTruncated
            ? `showing lines ${file.startLine}-${file.endLine} of ${file.originalLineCount}`
            : null,
          file.lineLengthTruncated
            ? `some lines shortened to ${MAX_LINE_LENGTH} characters`
            : null,
        ].filter(Boolean);
        block += `[WARNING: Truncated. ${truncationReasons.join('; ')}. Use read_file or a similar file-reading tool for full content.]\n\n`;
      }
      block += file.content;

      contentParts.push(`${separator}\n\n${block}\n`);
    }
  }

  if (filesLimited) {
    summaryParts.push(
      `File limit reached (${MAX_FILES}). ` +
        'Not all matching files were read. Use more specific patterns to narrow results.',
    );
  }

  if (processedFiles.length > 0 && blockedByDeny) {
    summaryParts.push(
      'NOTE: Some paths were blocked by the file access deny policy.',
    );
  }

  if (processedFiles.length > 0 && ignoredByPolicy) {
    summaryParts.push(
      'NOTE: Some glob-discovered paths were filtered by configured ignoreFiles rules.',
    );
  }

  if (skipped.length > 0) {
    const MAX_SHOWN = 10;
    summaryParts.push('Skipped:');
    for (const s of skipped.slice(0, MAX_SHOWN)) {
      summaryParts.push(`- ${s.path} (${s.reason})`);
    }
    if (skipped.length > MAX_SHOWN) {
      summaryParts.push(`- ...and ${skipped.length - MAX_SHOWN} more.`);
    }
  }

  if (contentParts.length > 0) {
    contentParts.push(OUTPUT_TERMINATOR);
  }

  const output = [...summaryParts, '', ...contentParts].join('\n');

  return processedFiles.length > 0
    ? textResult(output)
    : textErrorResult(output);
}

const readManyFilesTool: MCPTool = {
  definition: READ_MANY_FILES_TOOL_DEFINITION,
  handler: handleReadManyFiles,
};

export default readManyFilesTool;
