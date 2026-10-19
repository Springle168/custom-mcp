import { MAX_FILE_SIZE_MB } from '../../../utils/file-read.js';
import type { MCPTool } from '../../types.js';

export const MAX_READ_REQUESTS = 100;
export const MAX_READ_WORKERS = 8;

export const READ_TOOL_DEFINITION = {
  name: 'read',
  description: `Reads text files or selected continuous ranges from literal paths and glob patterns.
For broad file sets, use shallow_read to inspect selected ranges and content sizes before requesting their bodies.
Text only. Binary files and files larger than ${MAX_FILE_SIZE_MB} MiB are rejected.
Processes at most the first 100 final requests after deduplication and object overrides. Excess requests are not processed, and the summary reports the limit.`,
  inputSchema: {
    type: 'object',
    properties: {
      include: {
        type: 'array',
        minItems: 1,
        description: `File paths, glob patterns, or literal-file objects with optional range settings. Relative inputs resolve from the primary workspace root; drive-absolute inputs may target any configured workspace root.
Input order is preserved, with each glob's results sorted by display path. Default whole-file requests are deduplicated by real path, keeping the first occurrence.
Each object keeps its declared position and replaces all default whole-file requests for the same real file. Objects are never merged, even when their paths and ranges are identical. An invalid range does not restore the replaced whole-file request.`,
        items: {
          oneOf: [
            { type: 'string', minLength: 1 },
            {
              type: 'object',
              properties: {
                file_path: {
                  type: 'string',
                  minLength: 1,
                  description: 'Path to one literal text file.',
                },
                start_line: {
                  type: ['integer', 'string'],
                  minimum: 1,
                  minLength: 1,
                  description:
                    'Optional starting position. In read_mode="line", use a positive integer for the first line to include. In read_mode="regex", use a non-empty JavaScript RegExp pattern; the first matching line from the beginning of the file becomes the start. Defaults to the first line.',
                },
                end_line: {
                  type: ['integer', 'string'],
                  minimum: 1,
                  minLength: 1,
                  description:
                    'Optional inclusive ending position. In read_mode="line", use a positive integer. In read_mode="regex", use a non-empty JavaScript RegExp pattern; the first match at or after the resolved start line becomes the end. Defaults to EOF.',
                },
                read_mode: {
                  type: 'string',
                  enum: ['line', 'regex'],
                  description:
                    'How to interpret start_line and end_line. Use "line" for 1-based positive integer line numbers, or "regex" for line-by-line JavaScript RegExp patterns without flags. Defaults to "line". Regex positioning does not match across lines.',
                },
                show_line_numbers: {
                  type: 'boolean',
                  description:
                    'Overrides the top-level show_line_numbers setting. If omitted, inherits the top-level setting.',
                },
              },
              required: ['file_path'],
              additionalProperties: false,
            },
          ],
        },
      },
      exclude: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        description:
          'Additional glob patterns for filtering automatically discovered files after access checks. Does not apply to literal paths. Examples: ["**/*.test.ts", "generated/**"].',
      },
      use_ignore_files: {
        type: 'boolean',
        description:
          'Whether configured ignoreFiles rules filter glob-discovered files. Defaults to true. Literal string paths and literal-file objects bypass ignore rules. Does not disable exclude patterns or the deny policy.',
      },
      shallow_read: {
        oneOf: [
          { type: 'boolean' },
          { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        ],
        description: `Controls whether successful content bodies are included:
- false or omitted: Include all successful bodies.
- true: Omit successful bodies.
- positive integer: Include all successful bodies only when their combined UTF-8 size is at most this many bytes; otherwise omit them all.

Statistics and per-request failures are always returned.
Keep numeric thresholds at or below the recommended 50 KiB batch size unless larger output is intentional.`,
      },
      show_line_numbers: {
        type: 'boolean',
        description:
          'Prefix returned content lines with their original 1-based line numbers. Defaults to false. Each literal-file object can override this setting.',
      },
    },
    required: ['include'],
    additionalProperties: false,
  },
} as const satisfies MCPTool['definition'];
