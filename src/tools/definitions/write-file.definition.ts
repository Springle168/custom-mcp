import type { MCPTool } from '../types.js';

export const WRITE_FILE_TOOL_DEFINITION = {
  name: 'write_file',
  description: `Writes complete text content to a file, creating missing parent directories and overwriting existing files.

Use this tool for new files or full-file rewrites. Use replace_text or similar tools for targeted edits to existing files.

Parallel batching best practice: When creating or overwriting multiple files with substantial content, prefer one file at a time or at most two independent files per parallel batch. Small independent file writes may be parallelized normally.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        minLength: 1,
        description:
          'Path to the file to write. Relative paths resolve from the primary workspace root; drive-absolute paths may target any configured workspace root.',
      },
      content: {
        type: 'string',
        description:
          'Complete text content to write. Provide the full file; possible omission placeholders are written but reported as warnings.',
      },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
} as const satisfies MCPTool['definition'];
