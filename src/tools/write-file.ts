import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '../config.js';
import {
  detectLineEnding,
  resolveLineEnding,
  detectOmissionPlaceholders,
} from '../engine/text-utils.js';
import { isBinaryFile } from '../utils/file-read.js';
import { withFileLock } from '../utils/file-lock.js';
import { resolvePath, validatePathAccess } from '../utils/paths.js';
import type { MCPTool, ToolCallResult } from './types.js';

// ================
// Tool Schema
// ================

const WRITE_FILE_TOOL_DEFINITION = {
  name: 'write_file',
  description: `Writes complete text content to a file, creating missing parent directories and overwriting existing files.

Use this tool for new files or full-file rewrites. Use replace_text or similar tools for targeted edits to existing files.
The file path must stay inside the configured workspace root.
The content parameter must contain the full file contents; possible omission placeholders like "..." or "rest of code" are written but reported as warnings.
On success, returns a message with the written path and the file's total line count.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      file_path: {
        type: 'string',
        description:
          'Path to the file to write. Relative paths resolve from the configured workspace root.',
      },
      content: {
        type: 'string',
        description:
          'Complete text content to write. Provide the full file; possible omission placeholders are written but reported as warnings.',
      },
    },
    required: ['file_path', 'content'],
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

function isDotsOnly(text: string): boolean {
  if (text.length < 3) return false;
  return [...text].every((char) => char === '.');
}

function stripCommentMarkers(line: string): string {
  let text = line.trim();
  const prefixes = ['//', '#', '--', '*', '/*', '<!--'];
  const suffixes = ['*/', '-->'];

  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length).trim();
      break;
    }
  }

  for (const suffix of suffixes) {
    if (text.endsWith(suffix)) {
      text = text.slice(0, -suffix.length).trim();
      break;
    }
  }

  return text;
}

function detectContentOmissionPlaceholders(content: string): string[] {
  const placeholders = new Set(detectOmissionPlaceholders(content));

  for (const line of content.split(/\r\n|\r|\n/)) {
    if (isDotsOnly(stripCommentMarkers(line))) {
      placeholders.add('...');
    }
  }

  return [...placeholders];
}

function getOmissionPlaceholderWarning(content: string): string | null {
  const placeholders = detectContentOmissionPlaceholders(content);
  if (placeholders.length === 0) return null;

  const shownPlaceholders = placeholders
    .slice(0, 3)
    .map((placeholder) => `'${placeholder}'`)
    .join(', ');
  const more = placeholders.length > 3 ? ' and more' : '';

  return `Warning: content contains possible omission placeholder(s) ${shownPlaceholders}${more}. If this is intentional literal text, for example documentation, you can ignore this warning; otherwise use read_file to verify and provide complete file content.`;
}

function validateParams(args: Record<string, unknown>): string | null {
  if (typeof args.file_path !== 'string' || args.file_path.length === 0) {
    return "The 'file_path' parameter must be a non-empty string.";
  }

  if (typeof args.content !== 'string') {
    return "The 'content' parameter must be a string.";
  }

  return null;
}

// ================
// Content Helpers
// ================

function normalizeLineEndings(
  content: string,
  lineEnding: '\r\n' | '\n',
): string {
  if (lineEnding === '\r\n') {
    return content.replace(/\r\n|\r|\n/g, '\r\n');
  }
  return content.replace(/\r\n|\r/g, '\n');
}

function countLines(content: string): number {
  return content.split(/\r?\n/).length;
}

function successPath(filePath: string, resolved: string, rootDir: string): string {
  return path.isAbsolute(filePath)
    ? resolved
    : path.relative(rootDir, resolved);
}

function appendWarning(message: string, warning: string | null): string {
  return warning ? `${message}\n${warning}` : message;
}

async function findExistingAncestor(directoryPath: string): Promise<string> {
  let current = directoryPath;

  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        throw error;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

async function validateSafeWriteTarget(
  resolved: string,
  rootDir: string,
  filePath: string,
): Promise<string | null> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(rootDir);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return `Could not resolve workspace root: ${error.message}. Check the server configuration.`;
  }

  try {
    const existingAncestor = await findExistingAncestor(path.dirname(resolved));
    const realAncestor = await fs.realpath(existingAncestor);
    if (validatePathAccess(realAncestor, realRoot)) {
      return `Path ${filePath} resolves outside the allowed workspace. Provide a file path inside the configured workspace root.`;
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return `Could not validate write path ${filePath}: ${error.message}. Check the path and permissions.`;
  }

  try {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) {
      return `Cannot write file ${filePath}: target path is a symbolic link. Provide a regular file path inside the workspace.`;
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      return `Could not validate write target ${filePath}: ${error.message}. Check the path and permissions.`;
    }
  }

  return null;
}

// ================
// Tool Handler
// ================

async function handleWriteFile(
  args: Record<string, unknown>,
  config: Config,
): Promise<ToolCallResult> {
  const validationError = validateParams(args);
  if (validationError) return errorResult(validationError);

  const filePath = args.file_path as string;
  const content = args.content as string;
  const placeholderWarning = getOmissionPlaceholderWarning(content);
  const resolved = resolvePath(filePath, config.rootDir);
  const pathError = validatePathAccess(resolved, config.rootDir);
  if (pathError) {
    return errorResult(
      `${pathError} Provide a file path inside the configured workspace root.`,
    );
  }

  return withFileLock(resolved, async () => {
    const safetyError = await validateSafeWriteTarget(
      resolved,
      config.rootDir,
      filePath,
    );
    if (safetyError) return errorResult(safetyError);

    let detectedLineEnding: '\r\n' | '\n' | null = null;

    try {
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        return errorResult(
          `Could not write file ${filePath}: target path is a directory. Provide a file path instead.`,
        );
      }

      if (await isBinaryFile(resolved)) {
        return errorResult(
          `Cannot write text content to binary file: ${filePath}. Provide a text file path instead.`,
        );
      }

      const raw = await fs.readFile(resolved, 'utf-8');
      detectedLineEnding = detectLineEnding(raw);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        if (await isBinaryFile(resolved)) {
          return errorResult(
            `Cannot write text content to binary file: ${filePath}. Provide a text file path instead.`,
          );
        }
      } else if (error.code !== 'ENOENT') {
        return errorResult(
          `Could not prepare file ${filePath}: ${error.message}. Check the path and permissions.`,
        );
      }
    }

    const lineEnding = resolveLineEnding(config.lineEnding, detectedLineEnding);
    const finalContent = normalizeLineEndings(content, lineEnding);

    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      const postMkdirSafetyError = await validateSafeWriteTarget(
        resolved,
        config.rootDir,
        filePath,
      );
      if (postMkdirSafetyError) return errorResult(postMkdirSafetyError);

      await fs.writeFile(resolved, finalContent, 'utf-8');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      return errorResult(
        `Could not write file ${filePath}: ${error.message}. Check the path and permissions.`,
      );
    }

    const displayPath = successPath(filePath, resolved, config.rootDir);
    const message = `Success: wrote ${displayPath}. Total lines: ${countLines(finalContent)}.`;
    return successResult(appendWarning(message, placeholderWarning));
  });
}

const writeFileTool: MCPTool = {
  definition: WRITE_FILE_TOOL_DEFINITION,
  handler: handleWriteFile,
};

export default writeFileTool;
