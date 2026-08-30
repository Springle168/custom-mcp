import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { MCPTool, ToolCallResult } from './types.js';
import { textErrorResult, textResult } from './results.js';
import {
  resolveFileAccessPath,
  validateFileAccessReadTarget,
} from '../utils/file-access-policy.js';
import {
  isBinaryFile,
  readTextFile,
} from '../utils/file-read.js';
import {
  READ_FILE_OUTPUT_SEPARATOR_FORMAT,
  READ_FILE_OUTPUT_TERMINATOR,
  READ_FILE_TOOL_DEFINITION,
} from './definitions/read-file.definition.js';

type ReadMode = 'line' | 'regex';

interface LineRange {
  startLine?: number;
  endLine?: number;
}

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

async function handleReadFile(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
): Promise<ToolCallResult> {
  const validationError = validateParams(args);
  if (validationError) return textErrorResult(validationError);
  const readMode = getReadMode(args) ?? 'line';

  const filePath = args.file_path as string;
  const fileAccessPolicyContext = context.fileAccessPolicyContext;
  const safePathResult = resolveFileAccessPath(
    filePath,
    fileAccessPolicyContext,
  );
  if (!safePathResult.ok) {
    return textErrorResult(safePathResult.reason);
  }
  const safePath = safePathResult.path;

  const readTarget = await validateFileAccessReadTarget(
    safePath,
    fileAccessPolicyContext,
  );
  if (!readTarget.ok) {
    return textErrorResult(
      `Could not read file ${filePath}: ${readTarget.reason}. Check the path and ensure it is a readable text file.`,
    );
  }

  if (readTarget.target.kind === 'directory') {
    return textErrorResult(
      `Could not read file ${filePath}: path is a directory. Provide a text file path instead.`,
    );
  }
  const realPath = readTarget.target.realPath;

  if (await isBinaryFile(realPath)) {
    return textErrorResult(
      `Cannot display content of binary file: ${filePath}. Provide a text file path instead.`,
    );
  }

  const lineRange = await resolveLineRange(readMode, realPath, args);
  if (typeof lineRange === 'string') {
    return textErrorResult(
      `Could not read file ${filePath}: ${lineRange}`,
    );
  }

  const result = await readTextFile(realPath, {
    startLine: lineRange.startLine,
    endLine: lineRange.endLine,
    showLineNumbers: (args.show_line_numbers as boolean | undefined) ?? false,
    maxLines: null,
    maxLineLength: null,
  });

  if (!result.ok) {
    return textErrorResult(
      `Could not read file ${filePath}: ${result.reason}. Check the path and ensure it is a readable text file.`,
    );
  }

  const displayPath = safePath.displayPath;
  const separator = READ_FILE_OUTPUT_SEPARATOR_FORMAT.replace('{filePath}', displayPath);
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

  return textResult(
    `${summaryParts.join('\n')}\n\n${separator}\n\n${result.content}\n\n${READ_FILE_OUTPUT_TERMINATOR}`,
  );
}

const readFileTool: MCPTool = {
  definition: READ_FILE_TOOL_DEFINITION,
  handler: handleReadFile,
};

export default readFileTool;
