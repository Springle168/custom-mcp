import { MAX_FILE_SIZE_MB } from '../../../utils/file-read.js';
import type { MCPTool } from '../../types.js';

export const READ_FILE_TOOL_DEFINITION = {
  name: 'read_file',
  description: `Reads and returns the content of a specified text file.

Supports full-file reads and optional continuous ranges positioned by 1-based line numbers or line-by-line JavaScript RegExp patterns.
For context efficiency, always retrieve only the minimum content necessary for your next step.
Successful responses start with two summary lines followed by the requested file content.
Text files only. Binary files (images, archives, compiled output, etc.) are rejected.
Files exceeding ${MAX_FILE_SIZE_MB}MB are rejected. Single-file reads do not apply line-count or line-length truncation.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        minLength: 1,
        description: 'The path to the text file to read.',
      },
      start_line: {
        type: ['integer', 'string'],
        minimum: 1,
        minLength: 1,
        description:
          'Optional: In read_mode="line", the 1-based line number to start reading from. In read_mode="regex", a non-empty JavaScript RegExp pattern whose first matching line becomes the start line.',
      },
      end_line: {
        type: ['integer', 'string'],
        minimum: 1,
        minLength: 1,
        description:
          'Optional: In read_mode="line", the 1-based line number to end reading at (inclusive). In read_mode="regex", a non-empty JavaScript RegExp pattern searched from the resolved start line and included as the end line.',
      },
      read_mode: {
        type: 'string',
        enum: ['line', 'regex'],
        description:
          'How to interpret start_line and end_line. Use "line" for positive integer line numbers, or "regex" for line-by-line JavaScript RegExp pattern positioning. Defaults to "line".',
      },
      show_line_numbers: {
        type: 'boolean',
        description:
          'If true, prefix each returned content line with its original 1-based line number. Use only when line numbers are necessary. Defaults to false.',
      },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
} as const satisfies MCPTool['definition'];
