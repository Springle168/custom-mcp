import * as fs from 'node:fs/promises';
import { getPathSafetyContext, type Config } from '../config.js';
import type { MCPTool, ToolCallResult } from './types.js';
import {
  formatPathSafetyError,
  resolveSafePathInContext,
  validateSafeReadTarget,
} from '../utils/paths.js';
import {
  isBinaryFile,
  MAX_FILE_SIZE_MB,
  readTextFile,
} from '../utils/file-read.js';

type ReadMode = 'line' | 'regex';

interface LineRange {
  startLine?: number;
  endLine?: number;
}

const OUTPUT_SEPARATOR_FORMAT = '--- {filePath} ---';
const OUTPUT_TERMINATOR = '--- End of content ---';

// ================
// Tool Schema
// ================

const READ_FILE_TOOL_DEFINITION = {
  name: 'read_file',
  description: `Reads and returns the content of a specified text file.

Use read_mode="line" to interpret start_line and end_line as 1-based line numbers; end_line is inclusive.
Use read_mode="regex" to interpret start_line and end_line as JavaScript RegExp patterns matched line-by-line; returned content is still one continuous line range.
For context efficiency, always retrieve only the minimum content necessary for your next step.
Successful responses always start with two summary lines, then a blank line, then a '${OUTPUT_SEPARATOR_FORMAT}' separator before the file content, and end with '${OUTPUT_TERMINATOR}'.
Text files only. Binary files (images, archives, compiled output, etc.) are rejected.
Files exceeding ${MAX_FILE_SIZE_MB}MB are rejected. Single-file reads do not apply line-count or line-length truncation.
Set show_line_numbers to true only when line numbers are necessary; it prefixes each returned content line like "12: print(\"xxx\")".`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the text file to read.',
      },
      start_line: {
        type: ['integer', 'string'],
        description:
          'Optional: In read_mode="line", the 1-based line number to start reading from. In read_mode="regex", a non-empty JavaScript RegExp pattern whose first matching line becomes the start line.',
      },
      end_line: {
        type: ['integer', 'string'],
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

function getReadMode(args: Record<string, unknown>): ReadMode | null {
  if (args.read_mode === undefined) return 'line';
  if (args.read_mode === 'line' || args.read_mode === 'regex') {
    return args.read_mode;
  }
  return null;
}

function validateParams(args: Record<string, unknown>): string | null {
  if (typeof args.file_path !== 'string' || args.file_path.length === 0) {
    return "The 'file_path' parameter must be a non-empty string.";
  }

  const readMode = getReadMode(args);
  if (readMode === null) {
    return "The 'read_mode' parameter must be either 'line' or 'regex'.";
  }

  if (args.start_line !== undefined) {
    const startLine = args.start_line;
    if (readMode === 'line') {
      if (!Number.isInteger(startLine) || (startLine as number) < 1) {
        return 'In read_mode="line", start_line must be a positive integer (JSON number).';
      }
    } else if (typeof startLine !== 'string' || startLine.length === 0) {
      return 'In read_mode="regex", start_line must be a non-empty regex pattern string.';
    }
  }

  if (args.end_line !== undefined) {
    const endLine = args.end_line;
    if (readMode === 'line') {
      if (!Number.isInteger(endLine) || (endLine as number) < 1) {
        return 'In read_mode="line", end_line must be a positive integer (JSON number).';
      }
    } else if (typeof endLine !== 'string' || endLine.length === 0) {
      return 'In read_mode="regex", end_line must be a non-empty regex pattern string.';
    }
  }

  if (
    readMode === 'line' &&
    args.start_line !== undefined &&
    args.end_line !== undefined &&
    (args.start_line as number) > (args.end_line as number)
  ) {
    return `start_line ${args.start_line as number} cannot be greater than end_line ${args.end_line as number}.`;
  }

  if (readMode === 'regex') {
    for (const paramName of ['start_line', 'end_line'] as const) {
      const pattern = args[paramName];
      if (pattern === undefined) continue;
      try {
        new RegExp(pattern as string);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Invalid ${paramName} regex pattern: ${message}. Check the pattern syntax and escape special characters when needed.`;
      }
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

async function resolveRegexRange(
  filePath: string,
  args: Record<string, unknown>,
): Promise<LineRange | string> {
  const fullFile = await readTextFile(filePath, {
    maxLines: null,
    maxLineLength: null,
  });

  if (!fullFile.ok) {
    return fullFile.reason;
  }

  const lines = fullFile.content.split('\n');
  let startIndex = 0;

  if (args.start_line !== undefined) {
    const startPattern = new RegExp(args.start_line as string);
    startIndex = lines.findIndex((line) => startPattern.test(line));
    if (startIndex === -1) {
      return 'start_line regex pattern did not match any line. Check the pattern and choose text that appears on the intended start line.';
    }
  }

  let endLine: number | undefined;
  if (args.end_line !== undefined) {
    const endPattern = new RegExp(args.end_line as string);
    const relativeEndIndex = lines
      .slice(startIndex)
      .findIndex((line) => endPattern.test(line));
    if (relativeEndIndex === -1) {
      return 'end_line regex pattern did not match any line at or after the resolved start line. Check the pattern and choose text that appears on the intended end line.';
    }
    endLine = startIndex + relativeEndIndex + 1;
  }

  return {
    startLine: args.start_line !== undefined ? startIndex + 1 : undefined,
    endLine,
  };
}

async function resolveLineRange(
  readMode: ReadMode,
  resolvedPath: string,
  args: Record<string, unknown>,
): Promise<LineRange | string> {
  if (readMode === 'line') {
    return {
      startLine: args.start_line as number | undefined,
      endLine: args.end_line as number | undefined,
    };
  }

  return resolveRegexRange(resolvedPath, args);
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
  const readMode = getReadMode(args) ?? 'line';

  const filePath = args.file_path as string;
  const pathSafetyContext = getPathSafetyContext(config);
  const safePathResult = resolveSafePathInContext(filePath, pathSafetyContext);
  if (!safePathResult.ok) {
    return errorResult(formatPathSafetyError(safePathResult.error));
  }
  const safePath = safePathResult.path;

  const readTarget = await validateSafeReadTarget(safePath);
  if (!readTarget.ok) {
    return errorResult(
      `Could not read file ${filePath}: ${readTarget.reason}. Check the path and ensure it is a readable text file.`,
    );
  }

  try {
    const stat = await fs.stat(readTarget.realPath);
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

  if (await isBinaryFile(readTarget.realPath)) {
    return errorResult(
      `Cannot display content of binary file: ${filePath}. Provide a text file path instead.`,
    );
  }

  const lineRange = await resolveLineRange(readMode, readTarget.realPath, args);
  if (typeof lineRange === 'string') {
    return errorResult(
      `Could not read file ${filePath}: ${lineRange}`,
    );
  }

  const result = await readTextFile(readTarget.realPath, {
    startLine: lineRange.startLine,
    endLine: lineRange.endLine,
    showLineNumbers: (args.show_line_numbers as boolean | undefined) ?? false,
    maxLines: null,
    maxLineLength: null,
  });

  if (!result.ok) {
    return errorResult(
      `Could not read file ${filePath}: ${result.reason}. Check the path and ensure it is a readable text file.`,
    );
  }

  const displayPath = safePath.displayPath;
  const separator = OUTPUT_SEPARATOR_FORMAT.replace('{filePath}', displayPath);
  const summaryParts = [
    `Read ${result.linesRead} of ${result.originalLineCount} line(s) from ${displayPath}.`,
  ];

  if (result.isPartialRead) {
    summaryParts.push(
      `Partial read: showing lines ${result.startLine}-${result.endLine} of ${result.originalLineCount} total lines.`,
    );
  } else {
    summaryParts.push('No truncation: all returned file content is complete.');
  }

  return successResult(
    `${summaryParts.join('\n')}\n\n${separator}\n\n${result.content}\n\n${OUTPUT_TERMINATOR}`,
  );
}

// ================
// Export
// ================

const readFileTool: MCPTool = {
  definition: READ_FILE_TOOL_DEFINITION,
  handler: handleReadFile,
};

export default readFileTool;
