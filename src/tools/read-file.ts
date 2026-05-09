import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '../config.js';
import type { MCPTool, ToolCallResult } from './types.js';
import { resolvePath, validatePathAccess } from '../utils/paths.js';
import {
  isBinaryFile,
  MAX_FILE_SIZE_MB,
  MAX_LINE_LENGTH,
  MAX_LINES_PER_FILE,
  readTextFile,
} from '../utils/file-read.js';

// ================
// Tool Schema
// ================

const READ_FILE_TOOL_DEFINITION = {
  name: 'read_file',
  description: `Reads and returns the content of a specified text file.

Use start_line and end_line for targeted, surgical reads of specific sections. Both are 1-based and end_line is inclusive.
For context efficiency, always retrieve only the minimum content necessary for your next step.
Text files only. Binary files (images, archives, compiled output, etc.) are rejected.
Files exceeding ${MAX_FILE_SIZE_MB}MB are skipped. Output is automatically limited to ${MAX_LINES_PER_FILE} lines and ${MAX_LINE_LENGTH} characters per line.
Set show_line_numbers to true only when line numbers are necessary; it prefixes each returned content line like "12: print(\"xxx\")".`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the text file to read.',
      },
      start_line: {
        type: 'number',
        description: 'Optional: The 1-based line number to start reading from.',
      },
      end_line: {
        type: 'number',
        description:
          'Optional: The 1-based line number to end reading at (inclusive).',
      },
      show_line_numbers: {
        type: 'boolean',
        description:
          'If true, prefix each returned content line with its original 1-based line number. Use only when line numbers are necessary. Defaults to false.',
      },
    },
    required: ['file_path'],
  },
};

// ================
// Response Helpers
// ================

function successResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): ToolCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}

// ================
// Parameter Validation
// ================

function validateParams(args: Record<string, unknown>): string | null {
  if (typeof args.file_path !== 'string' || args.file_path.length === 0) {
    return "The 'file_path' parameter must be a non-empty string.";
  }
  if (args.start_line !== undefined) {
    const startLine = args.start_line;
    if (!Number.isInteger(startLine)) {
      return "The 'start_line' parameter must be an integer.";
    }
    if ((startLine as number) < 1) {
      return 'start_line must be at least 1';
    }
  }
  if (args.end_line !== undefined) {
    const endLine = args.end_line;
    if (!Number.isInteger(endLine)) {
      return "The 'end_line' parameter must be an integer.";
    }
    if ((endLine as number) < 1) {
      return 'end_line must be at least 1';
    }
  }
  if (
    args.start_line !== undefined &&
    args.end_line !== undefined &&
    (args.start_line as number) > (args.end_line as number)
  ) {
    return 'start_line cannot be greater than end_line';
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

async function handleReadFile(
  args: Record<string, unknown>,
  config: Config,
): Promise<ToolCallResult> {
  const validationError = validateParams(args);
  if (validationError) return errorResult(validationError);

  const filePath = args.file_path as string;
  const resolvedPath = resolvePath(filePath, config.rootDir);
  const pathError = validatePathAccess(resolvedPath, config.rootDir);
  if (pathError) {
    return errorResult(
      `${pathError} Provide a file path inside the configured workspace root.`,
    );
  }

  try {
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      return errorResult(
        `Could not read file ${filePath}: path is a directory. Provide a text file path instead.`,
      );
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return errorResult(
      `Could not read file ${filePath}: ${error.code === 'ENOENT' ? 'file not found' : error.message}. Check the path and ensure it is a readable text file.`,
    );
  }

  if (await isBinaryFile(resolvedPath)) {
    return errorResult(
      `Cannot display content of binary file: ${filePath}. Provide a text file path instead.`,
    );
  }

  const result = await readTextFile(resolvedPath, {
    startLine: args.start_line as number | undefined,
    endLine: args.end_line as number | undefined,
    showLineNumbers: (args.show_line_numbers as boolean | undefined) ?? false,
  });

  if (!result.ok) {
    return errorResult(
      `Could not read file ${filePath}: ${result.reason}. Check the path and ensure it is a readable text file.`,
    );
  }

  const displayPath = path.isAbsolute(filePath)
    ? resolvedPath
    : path.relative(config.rootDir, resolvedPath);
  const summaryParts = [
    `Read ${result.linesRead} of ${result.originalLineCount} line(s) from ${displayPath}.`,
  ];

  if (result.isTruncated) {
    summaryParts.push(
      `IMPORTANT: The file content has been truncated. Showing lines ${result.startLine}-${result.endLine} of ${result.originalLineCount} total lines. Use start_line and end_line in a subsequent read_file call to read more.`,
    );
  } else {
    summaryParts.push('No truncation: all returned file content is complete.');
  }

  return successResult(`${summaryParts.join('\n')}\n\n${result.content}`);
}

// ================
// Export
// ================

const readFileTool: MCPTool = {
  definition: READ_FILE_TOOL_DEFINITION,
  handler: handleReadFile,
};

export default readFileTool;
