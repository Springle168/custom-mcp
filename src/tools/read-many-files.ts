import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { MCPTool, ToolCallResult } from './types.js';
import { textErrorResult, textResult } from './results.js';
import {
  selectReadableFiles,
  type SelectedReadableFile,
  type SkippedFileSelection,
} from '../utils/file-selection.js';
import {
  isBinaryFile,
  readTextFile,
  MAX_LINE_LENGTH,
  MAX_LINES_PER_FILE,
} from '../utils/file-read.js';
import {
  READ_MANY_FILES_TOOL_DEFINITION,
  SHALLOW_READ_BATCH_SIZE_BYTES,
  SHALLOW_READ_BATCH_SIZE_LABEL,
} from './definitions/read-many-files.definition.js';

/** Maximum number of files to process in a single call. */
const MAX_FILES = 100;

const OUTPUT_SEPARATOR_FORMAT = '--- {filePath} ---';
const OUTPUT_TERMINATOR = '--- End of content ---';

function validateParams(args: Record<string, unknown>): string | null {
  const allowedKeys = new Set([
    'include',
    'exclude',
    'use_ignore_files',
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
    args.use_ignore_files !== undefined &&
    typeof args.use_ignore_files !== 'boolean'
  ) {
    return "The 'use_ignore_files' parameter must be a boolean.";
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

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} bytes`;
  }
  return `${(sizeBytes / 1024).toFixed(1)} KB (${sizeBytes} bytes)`;
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
    (args.use_ignore_files as boolean | undefined) ?? true;
  const shallowRead = (args.shallow_read as boolean | undefined) ?? false;
  const shallowReadContentLimitBytes =
    args.shallow_read_content_limit_bytes as number | undefined;
  const showLineNumbers =
    (args.show_line_numbers as boolean | undefined) ?? false;

  const fileAccessPolicyContext = context.fileAccessPolicyContext;
  const selectionResult = await selectReadableFiles({
    pathSelectors: include,
    discoveryExcludePatterns: exclude,
    respectIgnoreFiles: useIgnoreFiles,
    fileAccessPolicyContext,
  });
  if (!selectionResult.ok) {
    return textErrorResult(selectionResult.reason);
  }
  const {
    files,
    skipped: selectionSkipped,
    blockedByDeny,
    ignoredByPolicy,
  } = selectionResult.selection;
  const skipped: SkippedFileSelection[] = [...selectionSkipped];

  if (files.length === 0 && skipped.length === 0) {
    return textErrorResult(
      'No files matched the given include patterns. ' +
        'Verify the paths/patterns and ensure files exist in the workspace.',
    );
  }

  const sortedFiles: SelectedReadableFile[] = [...files].sort((a, b) =>
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
