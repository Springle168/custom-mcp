import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import {
  detectLineEnding,
  resolveLineEnding,
  detectOmissionPlaceholders,
} from '../engine/text-utils.js';
import { isBinaryFile } from '../utils/file-read.js';
import { withFileLock } from '../utils/file-lock.js';
import {
  resolveFileAccessPath,
  validateFileAccessWriteTarget,
} from '../utils/file-access-policy.js';
import { WRITE_FILE_TOOL_DEFINITION } from './definitions/write-file.definition.js';
import type { MCPTool, ToolCallResult } from './types.js';
import { textErrorResult } from './results.js';

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

function appendWarning(message: string, warning: string | null): string {
  return warning ? `${message}\n${warning}` : message;
}

async function handleWriteFile(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
): Promise<ToolCallResult> {
  const filePath = args.file_path as string;
  const content = args.content as string;
  const placeholderWarning = getOmissionPlaceholderWarning(content);
  const fileAccessPolicyContext = context.fileAccessPolicyContext;
  const safePathResult = resolveFileAccessPath(
    filePath,
    fileAccessPolicyContext,
  );
  if (!safePathResult.ok) {
    return textErrorResult(safePathResult.reason);
  }
  const safePath = safePathResult.path;

  return withFileLock(safePath.resolvedPath, async () => {
    const safetyResult = await validateFileAccessWriteTarget(
      safePath,
      fileAccessPolicyContext,
    );
    if (!safetyResult.ok) return textErrorResult(safetyResult.reason);

    let detectedLineEnding: '\r\n' | '\n' | null = null;

    try {
      const stat = await fs.stat(safePath.resolvedPath);
      if (stat.isDirectory()) {
        return textErrorResult(
          `Could not write file ${filePath}: target path is a directory. Provide a file path instead.`,
        );
      }

      if (await isBinaryFile(safePath.resolvedPath)) {
        return textErrorResult(
          `Cannot write text content to binary file: ${filePath}. Provide a text file path instead.`,
        );
      }

      const raw = await fs.readFile(safePath.resolvedPath, 'utf-8');
      detectedLineEnding = detectLineEnding(raw);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        if (await isBinaryFile(safePath.resolvedPath)) {
          return textErrorResult(
            `Cannot write text content to binary file: ${filePath}. Provide a text file path instead.`,
          );
        }
      } else if (error.code !== 'ENOENT') {
        return textErrorResult(
          `Could not prepare file ${filePath}: ${error.message}. Check the path and permissions.`,
        );
      }
    }

    const lineEnding = resolveLineEnding(context.lineEnding, detectedLineEnding);
    const finalContent = normalizeLineEndings(content, lineEnding);

    try {
      await fs.mkdir(path.dirname(safePath.resolvedPath), { recursive: true });
      const postMkdirSafetyResult = await validateFileAccessWriteTarget(
        safePath,
        fileAccessPolicyContext,
      );
      if (!postMkdirSafetyResult.ok) {
        return textErrorResult(postMkdirSafetyResult.reason);
      }

      await fs.writeFile(safePath.resolvedPath, finalContent, 'utf-8');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      return textErrorResult(
        `Could not write file ${filePath}: ${error.message}. Check the path and permissions.`,
      );
    }

    const message = `Success: wrote ${safePath.displayPath}. Total lines: ${countLines(finalContent)}.`;
    return {
      content: [{ type: 'text', text: appendWarning(message, placeholderWarning) }],
      isError: false,
    };
  });
}

const writeFileTool: MCPTool = {
  definition: WRITE_FILE_TOOL_DEFINITION,
  handler: handleWriteFile,
};

export default writeFileTool;
