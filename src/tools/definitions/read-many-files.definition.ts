import { MAX_LINES_PER_FILE } from '../../utils/file-read.js';
import type { MCPTool } from '../types.js';

/** Recommended maximum original file size for a content-returning shallow read. */
export const SHALLOW_READ_BATCH_SIZE_BYTES = 50 * 1024;
export const SHALLOW_READ_BATCH_SIZE_LABEL =
  `${(SHALLOW_READ_BATCH_SIZE_BYTES / 1024).toFixed(1)} KB`;

export const READ_MANY_FILES_TOOL_DEFINITION = {
  name: 'read_many_files',
  description: `Reads and returns the content of multiple text files in one call.

Use this tool when reading several related files or expanding glob patterns. Text files only; binary files are skipped.
Files exceeding ${MAX_LINES_PER_FILE} lines are truncated—use read_file for a complete or targeted single-file read.

For broad file sets, use shallow_read first to inspect their size and truncation risk before requesting contents. Prefer read_file when reading only one file.`,
  inputSchema: {
    type: 'object',
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
      use_ignore_files: {
        type: 'boolean',
        description:
          'Whether configured ignoreFiles rules filter automatically discovered glob results. Defaults to true. Literal include paths bypass ignore rules. The file access deny policy always applies. Keep enabled for broad discovery. If inspection of ignored matches is needed, use the recommended workflow: first use a narrow include pattern with use_ignore_files=false and shallow_read=true, then read selected files by literal path.',
      },
      shallow_read: {
        type: 'boolean',
        description:
          `If true, return the matched file list with per-file line counts and sizes, total line count and size, and whether content would be truncated. Use shallow_read_content_limit_bytes to also return contents for small selections. Keep content-return thresholds at or below the recommended ${SHALLOW_READ_BATCH_SIZE_LABEL} batch size unless larger output is intentional. Defaults to false.`,
      },
      shallow_read_content_limit_bytes: {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
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
} as const satisfies MCPTool['definition'];
