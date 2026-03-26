import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '../config.js';
import {
  calculateReplacement,
  getErrorReplaceResult,
  type ReplaceParams,
} from '../engine/replacement.js';
import {
  detectLineEnding,
  resolveLineEnding,
  detectOmissionPlaceholders,
} from '../engine/text-utils.js';
import { resolvePath, validatePathAccess } from '../utils/paths.js';
import { withFileLock } from '../utils/file-lock.js';
import type { MCPTool } from './types.js';

// ================
// Tool Schema（MCP tools/list 返回给宿主的）
// ================

export const REPLACE_TOOL_DEFINITION = {
  name: 'replace_text',
  description: `Replaces text within a file. By default expects exactly ONE occurrence of \`old_string\`. Set \`allow_multiple\` to true to replace all occurrences.

Use a non-existent path and an empty \`old_string\` for new file creation. But it is recommended to use \`write_file\` as much as possible to create new files.

Rules for \`new_string\`:
- Must be EXACT literal replacement text.
- Ensure the resulting code is correct and idiomatic.
- Do NOT use omission placeholders like '(rest of methods ...)', '...', or 'unchanged code'.
- Must be different from \`old_string\`.

Rules for \`old_string\`:
- Must be EXACT literal text including all whitespace, indentation, and newlines.
- Include at least 3 lines of context BEFORE and AFTER the target text for unique matching.
- NEVER escape the string content.
- If multiple locations match and \`allow_multiple\` is not true, the tool will fail.

Best practices:
- Always use read_file to examine file content before making replacements.
- Prefer multiple small, atomic replacements over one large replacement.
- If the target file requires extensive refactoring, it is recommended to first perform a full overwrite of the file using \`write_file\`, and then perform partial replacements based on needs and subsequent plan adjustments.
- Verify file content after changes.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file to modify.',
      },
      new_string: {
        type: 'string',
        description:
          'The exact literal replacement text. Must be complete code, no placeholders.',
      },
      old_string: {
        type: 'string',
        description:
          'The exact literal text to find. Include surrounding context lines for precise matching.',
      },
      allow_multiple: {
        type: 'boolean',
        description:
          'If true, replace ALL occurrences. If false (default), succeeds only if exactly one occurrence is found.',
      },
    },
    required: ['file_path', 'new_string', 'old_string'],
  },
};

// ================
// Response Helpers
// ================

function successResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

// ================
// Parameter Validation
// ================

function validateParams(args: Record<string, unknown>): string | null {
  if (typeof args.file_path !== 'string' || !args.file_path) {
    return "The 'file_path' parameter must be a non-empty string.";
  }
  if (typeof args.new_string !== 'string') {
    return "The 'new_string' parameter must be a string.";
  }
  if (typeof args.old_string !== 'string') {
    return "The 'old_string' parameter must be a string.";
  }

  // 省略占位符检测
  const newPlaceholders = detectOmissionPlaceholders(args.new_string);
  if (newPlaceholders.length > 0) {
    const oldPlaceholders = new Set(
      detectOmissionPlaceholders(args.old_string),
    );
    for (const placeholder of newPlaceholders) {
      if (!oldPlaceholders.has(placeholder)) {
        return "`new_string` contains an omission placeholder (e.g. 'rest of methods ...'). Provide exact literal replacement text.";
      }
    }
  }

  return null;
}

// ================
// Tool Handler
// ================

export async function handleReplace(
  args: Record<string, unknown>,
  config: Config,
) {
  // 1. 参数校验
  const validationError = validateParams(args);
  if (validationError) return errorResult(validationError);

  const filePath = String(args.file_path);
  const newString = String(args.new_string);
  const oldString = String(args.old_string);
  const allowMultiple = Boolean(args.allow_multiple ?? false);

  // 2. 路径解析 + 安全校验
  const resolved = resolvePath(filePath, config.rootDir);
  const pathError = validatePathAccess(resolved, config.rootDir);
  if (pathError) return errorResult(pathError);

  // 3. 文件锁内执行
  return withFileLock(resolved, async () => {
    // 4. 读取文件
    let currentContent: string | null = null;
    let fileExists = false;
    let detectedLineEnding: '\r\n' | '\n' | null = null;

    try {
      const raw = await fs.readFile(resolved, 'utf-8');
      detectedLineEnding = detectLineEnding(raw);
      currentContent = raw.replace(/\r\n/g, '\n');
      fileExists = true;
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        return errorResult(`Failed to read file: ${error.message}`);
      }
    }

    const isNewFile = oldString === '' && !fileExists;

    // 5. 新建文件
    if (isNewFile) {
      const lineEnding = resolveLineEnding(config.lineEnding, null);
      let content = newString;
      if (lineEnding === '\r\n') {
        content = content.replace(/\r?\n/g, '\r\n');
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');
      return successResult(`Created new file: ${filePath}`);
    }

    // 6. 错误分支
    if (!fileExists) {
      return errorResult(
        `File not found: ${filePath}. Use empty old_string to create a new file.`,
      );
    }

    if (oldString === '' && fileExists) {
      return errorResult(
        `File already exists: ${filePath}. Cannot create. Provide old_string to modify existing file.`,
      );
    }

    // 7. 计算替换
    const params: ReplaceParams = {
      file_path: filePath,
      new_string: newString,
      old_string: oldString,
      allow_multiple: allowMultiple,
    };

    const result = calculateReplacement(currentContent!, params);

    // 8. 检查替换结果
    const replaceError = getErrorReplaceResult(
      params,
      result.occurrences,
      result.finalOldString,
      result.finalNewString,
    );
    if (replaceError) return errorResult(replaceError.raw);

    // 9. 写入文件（恢复行尾符）
    const lineEnding = resolveLineEnding(config.lineEnding, detectedLineEnding);
    let finalContent = result.newContent;
    if (lineEnding === '\r\n') {
      finalContent = finalContent.replace(/\r?\n/g, '\r\n');
    }
    await fs.writeFile(resolved, finalContent, 'utf-8');

    // 10. 构造成功消息
    const parts = [
      `Modified ${filePath}: ${result.occurrences} replacement(s) via ${result.strategy} match.`,
    ];

    if (
      result.strategy === 'fuzzy' &&
      result.matchRanges &&
      result.matchRanges.length > 0
    ) {
      const ranges = result.matchRanges
        .map((r) =>
          r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`,
        )
        .join(', ');
      parts.push(
        `Applied fuzzy match at line${result.matchRanges.length > 1 ? 's' : ''} ${ranges}.`,
      );
    }

    return successResult(parts.join(' '));
  });
}

const replaceTool: MCPTool = {
  definition: REPLACE_TOOL_DEFINITION,
  handler: handleReplace,
};

export default replaceTool;