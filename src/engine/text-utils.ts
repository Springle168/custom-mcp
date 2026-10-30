/** 将 CRLF 和独立 CR 规范化为 LF，不补删尾换行。 */
export function normalizeToLf(content: string): string {
  return content.replace(/\r\n|\r/g, '\n');
}

/** 按写出策略统一行尾符，保留输入的换行数量。 */
export function applyLineEnding(content: string, lineEnding: '\r\n' | '\n'): string {
  if (lineEnding === '\r\n') {
    return content.replace(/\r\n|\r|\n/g, '\r\n');
  }
  return normalizeToLf(content);
}

/** 按 CRLF 与独立 LF 的数量选择主要行尾符；平票或没有换行时使用 LF。 */
export function detectLineEnding(content: string): '\r\n' | '\n' {
  let crlfCount = 0;
  let lfCount = 0;

  for (let index = 0; index < content.length; index++) {
    if (content[index] !== '\n') continue;

    if (index > 0 && content[index - 1] === '\r') {
      crlfCount++;
    } else {
      lfCount++;
    }
  }

  return crlfCount > lfCount ? '\r\n' : '\n';
}

/**
 * 解析配置的行尾符策略。
 * auto 模式会保留已有文件检测到的行尾符；新建文件默认使用 LF。
 */
export function resolveLineEnding(
  configLineEnding: 'auto' | 'lf' | 'crlf',
  detectedLineEnding: '\r\n' | '\n' | null,
): '\r\n' | '\n' {
  if (configLineEnding === 'lf') return '\n';
  if (configLineEnding === 'crlf') return '\r\n';
  if (detectedLineEnding) return detectedLineEnding;
  return '\n';
}
