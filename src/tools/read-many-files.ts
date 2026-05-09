// src/tools/read-many-files.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { glob, escape } from 'glob';
import type { Config } from '../config.js';
import type { MCPTool } from './types.js';
import { validatePathAccess } from '../utils/paths.js';
import {
  BINARY_EXTENSIONS,
  isBinaryFile,
  readTextFile,
  MAX_LINE_LENGTH,
  MAX_LINES_PER_FILE,
} from '../utils/file-read.js';

// ================
// Constants
// ================

/** Maximum number of files to process in a single call. */
const MAX_FILES = 100;

const OUTPUT_SEPARATOR_FORMAT = '--- {filePath} ---';
const OUTPUT_TERMINATOR = '--- End of content ---';

/**
 * Default exclusion patterns applied when useDefaultExcludes is true.
 * Binary/media glob patterns are generated from the shared BINARY_EXTENSIONS set
 * so the two layers stay in sync automatically.
 */
const DEFAULT_EXCLUDES: string[] = [
  // Version control & dependencies
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/bower_components/**',
  // IDE & editor
  '**/.vscode/**',
  '**/.idea/**',
  // Build output
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/.gradle/**',
  // System files
  '**/.DS_Store',
  '**/.env',
  // Binary & media files
  ...[...BINARY_EXTENSIONS].map((ext) => `**/*${ext}`),
];

// ================
// Tool Schema
// ================

const READ_MANY_FILES_TOOL_DEFINITION = {
  name: 'read_many_files',
  description: `Reads and returns the content of multiple text files in one call. Supports absolute file paths and glob patterns.

Use this tool when you need content from several files at once, such as:
- Reading all Kotlin files in a package: include ["src/main/kotlin/com/example/**/*.kt"]
- Reading specific files by absolute path: include ["/absolute/path/Foo.kt", "/absolute/path/Bar.kt"]
- Mixing paths and patterns: include ["/absolute/path/Config.kt", "src/**/*.kt"]

Text files only. Binary files (images, archives, compiled output, etc.) are automatically skipped.
Files exceeding ${MAX_LINES_PER_FILE} lines are truncated — use read_file or a similar file-reading tool on that specific file for full content.
Set shallow_read to true to list matched files with per-file line counts, total line count, and truncation status without returning file contents.
Set show_line_numbers to true only when line numbers are necessary; it prefixes each returned content line like "12: print(\"xxx\")".
Default excludes filter out node_modules, .git, build directories, and binary files. Set useDefaultExcludes to false to disable.
Prefer read_file for a single file. Use this tool when reading 2 or more files.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      include: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description:
          'File paths or glob patterns to read. Absolute paths and relative globs (resolved from workspace root) can be mixed. Examples: ["src/**/*.kt"], ["/abs/path/Foo.kt", "docs/*.md"]',
      },
      exclude: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        description:
          'Optional glob patterns for files to exclude, added to default excludes. Examples: ["**/*.test.kt", "generated/**"]',
      },
      useDefaultExcludes: {
        type: 'boolean',
        description:
          'Whether to apply default exclusion patterns (node_modules, .git, build, binary files, etc.). Defaults to true.',
      },
      shallow_read: {
        type: 'boolean',
        description:
          'If true, return only the matched file list with each file line count, total line count, and whether content would be truncated. Defaults to false.',
      },
      show_line_numbers: {
        type: 'boolean',
        description:
          'If true, prefix each returned content line with its original 1-based line number. Use only when line numbers are necessary. Defaults to false.',
      },
    },
    required: ['include'],
  },
};

// ================
// Response Helpers
// ================

function successResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

// ================
// Path Helpers
// ================

function isAbsolutePath(p: string): boolean {
  // Glob patterns should not be treated as absolute paths
  const hasGlobChars = /[*?[\]{}]/.test(p);
  if (hasGlobChars) return false;
  
  return p.startsWith('/') || /^[a-zA-Z]:/.test(p);
}

// ================
// Parameter Validation
// ================

function validateParams(args: Record<string, unknown>): string | null {
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
    args.useDefaultExcludes !== undefined &&
    typeof args.useDefaultExcludes !== 'boolean'
  ) {
    return "The 'useDefaultExcludes' parameter must be a boolean.";
  }
  if (args.shallow_read !== undefined && typeof args.shallow_read !== 'boolean') {
    return "The 'shallow_read' parameter must be a boolean.";
  }
  if (
    args.show_line_numbers !== undefined &&
    typeof args.show_line_numbers !== 'boolean'
  ) {
    return "The 'show_line_numbers' parameter must be a boolean.";
  }
  return null;
}

// ================
// Tool Handler
// ================

async function handleReadManyFiles(
  args: Record<string, unknown>,
  config: Config,
) {
  // 1. Parameter validation
  const validationError = validateParams(args);
  if (validationError) return errorResult(validationError);

  const include = args.include as string[];
  const exclude = (args.exclude as string[] | undefined) ?? [];
  const useDefaultExcludes =
    (args.useDefaultExcludes as boolean | undefined) ?? true;
  const shallowRead = (args.shallow_read as boolean | undefined) ?? false;
  const showLineNumbers =
    (args.show_line_numbers as boolean | undefined) ?? false;

  // 2. Build effective exclude patterns
  const effectiveExcludes = useDefaultExcludes
    ? [...DEFAULT_EXCLUDES, ...exclude]
    : [...exclude];

  // 3. Classify include items into absolute paths and glob patterns.
  //    For relative items that resolve to an existing file, escape glob
  //    metacharacters so filenames containing [ ] { } etc. are matched literally.
  const absolutePaths: string[] = [];
  const globPatterns: string[] = [];

  for (const item of include) {
    if (isAbsolutePath(item)) {
      absolutePaths.push(item);
    } else {
      const normalized = item.replace(/\\/g, '/');
      const fullPath = path.resolve(config.rootDir, normalized);
      let isLiteralFile = false;
      try {
        const stat = await fs.stat(fullPath);
        isLiteralFile = stat.isFile();
      } catch {
        isLiteralFile = false;
      }
      globPatterns.push(isLiteralFile ? escape(normalized) : normalized);
    }
  }

  // 4. Resolve absolute paths directly (bypass glob, no exclude filtering)
  const fileSet = new Set<string>();
  const absolutePathSet = new Set<string>();
  const skipped: Array<{ path: string; reason: string }> = [];

  for (const absPath of absolutePaths) {
    const resolved = path.resolve(absPath);
    const pathError = validatePathAccess(resolved, config.rootDir);
    if (pathError) {
      skipped.push({ path: absPath, reason: 'outside workspace' });
      continue;
    }
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        skipped.push({ path: absPath, reason: 'not a file' });
        continue;
      }
      fileSet.add(resolved);
      absolutePathSet.add(resolved);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      skipped.push({
        path: absPath,
        reason: error.code === 'ENOENT' ? 'file not found' : error.message,
      });
    }
  }

  // 5. Expand glob patterns relative to rootDir
  if (globPatterns.length > 0) {
    try {
      const entries = await glob(globPatterns, {
        cwd: config.rootDir,
        ignore: effectiveExcludes,
        nodir: true,
        dot: true,
        absolute: true,
      });
      for (const entry of entries) {
        const resolved = path.resolve(entry);
        if (!validatePathAccess(resolved, config.rootDir)) {
          fileSet.add(resolved);
        }
      }
    } catch (err: unknown) {
      return errorResult(
        `Glob pattern error: ${err instanceof Error ? err.message : String(err)}. ` +
          'Check that your include patterns are valid.',
      );
    }
  }

  // 6. Early exit when nothing was found at all
  if (fileSet.size === 0 && skipped.length === 0) {
    return errorResult(
      'No files matched the given include patterns. ' +
        'Verify the paths/patterns and ensure files exist in the workspace.',
    );
  }

  // 7. Sort and enforce file count limit
  const sortedFiles = Array.from(fileSet).sort();
  let filesLimited = false;
  if (sortedFiles.length > MAX_FILES) {
    filesLimited = true;
    sortedFiles.length = MAX_FILES;
  }

  // 8. Read files in parallel (binary check → text read)
  const readResults = await Promise.allSettled(
    sortedFiles.map(async (filePath) => {
      if (await isBinaryFile(filePath)) {
        return { filePath, ok: false as const, reason: 'binary file' };
      }
      const result = await readTextFile(filePath, {
        showLineNumbers: !shallowRead && showLineNumbers,
      });
      if (!result.ok) {
        return { filePath, ok: false as const, reason: result.reason };
      }
      return {
        filePath,
        ok: true as const,
        content: result.content,
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

  // 9. Assemble file content blocks
  const contentParts: string[] = [];
  const processedFiles: Array<{
    filePath: string;
    displayPath: string;
    content: string;
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
      skipped.push({ path: r.filePath, reason: r.reason });
      continue;
    }

    const displayPath = absolutePathSet.has(r.filePath)
      ? r.filePath
      : path.relative(config.rootDir, r.filePath);

    processedFiles.push({
      filePath: r.filePath,
      displayPath,
      content: r.content,
      isTruncated: r.isTruncated,
      lineCountTruncated: r.lineCountTruncated,
      lineLengthTruncated: r.lineLengthTruncated,
      originalLineCount: r.originalLineCount,
      linesRead: r.linesRead,
      startLine: r.startLine,
      endLine: r.endLine,
    });
  }

  // 10. Build summary header
  const summaryParts: string[] = [];

  summaryParts.push(
    `Read ${processedFiles.length} file(s)` +
      (skipped.length > 0 ? `, skipped ${skipped.length}` : '') +
      '.',
  );

  if (shallowRead && processedFiles.length > 0) {
    const totalLineCount = processedFiles.reduce(
      (sum, file) => sum + file.originalLineCount,
      0,
    );
    summaryParts.push('Shallow read: file contents omitted.');
    summaryParts.push(`Total lines: ${totalLineCount}.`);
    summaryParts.push('Files:');
    for (const file of processedFiles) {
      const truncationStatus = file.isTruncated
        ? `yes (${[
            file.lineCountTruncated ? 'line count' : null,
            file.lineLengthTruncated ? 'long lines' : null,
          ].filter(Boolean).join(', ')})`
        : 'no';
      summaryParts.push(
        `- ${file.displayPath}: ${file.originalLineCount} line(s), would be truncated: ${truncationStatus}.`,
      );
    }
  } else if (processedFiles.length > 0) {
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
    ? successResult(output)
    : errorResult(output);
}

// ================
// Export
// ================

const readManyFilesTool: MCPTool = {
  definition: READ_MANY_FILES_TOOL_DEFINITION,
  handler: handleReadManyFiles,
};

export default readManyFilesTool;
