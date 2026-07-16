// ============
// 安全字面替换
// ============

/**
 * 安全的字面文本替换，避免 String.replace() 中 $ 符号被当作替换模式。
 * 替换所有出现的 search。
 */
export function safeLiteralReplace(
  content: string,
  search: string,
  replace: string,
): string {
  // split/join 是最安全的字面替换方式，完全不解释特殊字符
  return content.split(search).join(replace);
}

// ============
// 行尾符相关
// ============

export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/(?<!\r)\n/g) || []).length;
  return crlfCount > lfCount ? '\r\n' : '\n';
}

export function resolveLineEnding(
  configLineEnding: 'auto' | 'lf' | 'crlf',
  detectedLineEnding: '\r\n' | '\n' | null, // null = 新建文件
): '\r\n' | '\n' {
  if (configLineEnding === 'lf') return '\n';
  if (configLineEnding === 'crlf') return '\r\n';
  // auto 模式
  if (detectedLineEnding) return detectedLineEnding; // 已有文件，保留原始
  return '\n'; // 新建文件，默认 LF
}

/**
 * 保持修改后的内容与原始内容在尾部换行符上一致。
 * 平移自 edit.ts restoreTrailingNewline
 */
export function restoreTrailingNewline(
  originalContent: string,
  modifiedContent: string,
): string {
  const hadTrailingNewline = originalContent.endsWith('\n');
  if (hadTrailingNewline && !modifiedContent.endsWith('\n')) {
    return modifiedContent + '\n';
  } else if (!hadTrailingNewline && modifiedContent.endsWith('\n')) {
    return modifiedContent.replace(/\n$/, '');
  }
  return modifiedContent;
}

// ============
// 省略占位符检测
// ============

const OMITTED_PREFIXES = new Set([
  'rest of',
  'rest of method',
  'rest of methods',
  'rest of code',
  'unchanged code',
  'unchanged method',
  'unchanged methods',
]);

function isAllDots(str: string): boolean {
  if (str.length === 0) return false;
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== '.') return false;
  }
  return true;
}

function normalizeWhitespace(input: string): string {
  const segments: string[] = [];
  let current = '';

  for (const char of input) {
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (current.length > 0) {
        segments.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    segments.push(current);
  }

  return segments.join(' ');
}

function normalizePlaceholder(line: string): string | null {
  let text = line.trim();
  if (!text) return null;

  if (text.startsWith('//')) {
    text = text.slice(2).trim();
  }

  if (text.startsWith('(') && text.endsWith(')')) {
    text = text.slice(1, -1).trim();
  }

  const ellipsisStart = text.indexOf('...');
  if (ellipsisStart < 0) return null;

  const prefixRaw = text.slice(0, ellipsisStart).trim().toLowerCase();
  const suffixRaw = text.slice(ellipsisStart + 3).trim();
  const prefix = normalizeWhitespace(prefixRaw);

  if (!OMITTED_PREFIXES.has(prefix)) return null;
  if (suffixRaw.length > 0 && !isAllDots(suffixRaw)) return null;

  return `${prefix} ...`;
}

export function detectOmissionPlaceholders(text: string): string[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const matches: string[] = [];

  for (const rawLine of lines) {
    const normalized = normalizePlaceholder(rawLine);
    if (normalized) {
      matches.push(normalized);
    }
  }

  return matches;
}
