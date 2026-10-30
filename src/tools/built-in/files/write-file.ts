import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolRuntimeContext } from '../../../runtime/invocation/tool-context.js';
import {
  applyLineEnding,
  detectLineEnding,
  resolveLineEnding,
} from '../../../engine/text-utils.js';
import { classifyFileContent } from '../../../engine/file-content.js';
import { withFileLock } from '../../../utils/file-lock.js';
import {
  fileSystemErrorReason,
  getFileSystemErrorCode,
} from '../../../utils/file-system-errors.js';
import {
  resolveFileAccessPath,
  validateFileAccessWriteTarget,
} from '../../../utils/file-access-policy.js';
import { WRITE_FILE_TOOL_DEFINITION } from './write-file.definition.js';
import type { MCPTool, ToolCallResult } from '../../types.js';
import { textErrorResult } from '../../results.js';

function countLines(content: string): number {
  return content.split(/\r?\n/).length;
}

async function handleWriteFile(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
  classify: typeof classifyFileContent,
): Promise<ToolCallResult> {
  const filePath = args.file_path as string;
  const content = args.content as string;
  const fileAccessPolicyContext = context.fileAccessPolicyContext;
  const safePathResult = resolveFileAccessPath(filePath, fileAccessPolicyContext);
  if (!safePathResult.ok) {
    return textErrorResult(safePathResult.reason);
  }
  const safePath = safePathResult.path;

  return withFileLock(safePath.resolvedPath, async () => {
    const safetyResult = await validateFileAccessWriteTarget(safePath, fileAccessPolicyContext);
    if (!safetyResult.ok) return textErrorResult(safetyResult.reason);

    let detectedLineEnding: '\r\n' | '\n' | null = null;
    let existingBytes: Buffer | undefined;

    try {
      const stat = await fs.stat(safePath.resolvedPath);
      if (stat.isDirectory()) {
        return textErrorResult(
          `Could not write file ${filePath}: target path is a directory. Provide a file path instead.`,
        );
      }

      if (!stat.isFile()) {
        return textErrorResult(`Could not write file ${filePath}: target is not a regular file.`);
      }

      existingBytes = await fs.readFile(safePath.resolvedPath);
    } catch (err: unknown) {
      if (getFileSystemErrorCode(err) !== 'ENOENT') {
        return textErrorResult(
          `Could not prepare file ${filePath}: ${fileSystemErrorReason(err)}. Check the path and permissions.`,
        );
      }
    }

    // Only filesystem failures above may confirm absence. Detector errors, even
    // those carrying ENOENT, must never authorize creating or overwriting a file.
    if (existingBytes !== undefined) {
      try {
        const classification = await classify(existingBytes);
        if (classification.kind !== 'text') {
          return textErrorResult(
            `Cannot write text content to non-text file: ${filePath} (${classification.kind}).`,
          );
        }
        detectedLineEnding = detectLineEnding(existingBytes.toString('utf8'));
      } catch {
        return textErrorResult(`Could not classify file content: ${filePath}.`);
      }
    }

    const lineEnding = resolveLineEnding(context.lineEnding, detectedLineEnding);
    const finalContent = applyLineEnding(content, lineEnding);

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
      return textErrorResult(
        `Could not write file ${filePath}: ${fileSystemErrorReason(err)}. Check the path and permissions.`,
      );
    }

    const message = `Success: wrote ${safePath.displayPath}. Total lines: ${countLines(finalContent)}.`;
    return {
      content: [{ type: 'text', text: message }],
      isError: false,
    };
  });
}

export function createWriteFileHandler(
  classify: typeof classifyFileContent = classifyFileContent,
): MCPTool['handler'] {
  return (args, context) => handleWriteFile(args, context, classify);
}

const writeFileTool: MCPTool = {
  definition: WRITE_FILE_TOOL_DEFINITION,
  handler: createWriteFileHandler(),
};

export default writeFileTool;
