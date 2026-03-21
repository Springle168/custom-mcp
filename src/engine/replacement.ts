import levenshtein from 'fast-levenshtein';
import {
  safeLiteralReplace,
  restoreTrailingNewline,
  escapeRegex,
  stripWhitespace,
  applyIndentation,
} from './text-utils.js';

// ================
// Constants
// ================

const FUZZY_MATCH_THRESHOLD = 0.1;
const WHITESPACE_PENALTY_FACTOR = 0.1;

// ================
// Interfaces
// ================

export interface ReplaceParams {
  file_path: string;
  old_string: string;
  new_string: string;
  allow_multiple?: boolean;
}

export interface ReplacementResult {
  newContent: string;
  occurrences: number;
  finalOldString: string;
  finalNewString: string;
  strategy?: 'exact' | 'flexible' | 'regex' | 'fuzzy';
  matchRanges?: Array<{ start: number; end: number }>;
}

// ================
// Strategy 1: Exact Match
// 直接字面匹配，最快最精确
// ================

function exactMatch(
  currentContent: string,
  params: ReplaceParams,
): ReplacementResult | null {
  const normalizedCode = currentContent;
  const normalizedSearch = params.old_string.replace(/\r\n/g, '\n');
  const normalizedReplace = params.new_string.replace(/\r\n/g, '\n');

  const exactOccurrences = normalizedCode.split(normalizedSearch).length - 1;

  // 多匹配但未允许 → 返回结果（occurrences > 1 会被上层判定为错误）
  if (!params.allow_multiple && exactOccurrences > 1) {
    return {
      newContent: currentContent,
      occurrences: exactOccurrences,
      finalOldString: normalizedSearch,
      finalNewString: normalizedReplace,
    };
  }

  if (exactOccurrences > 0) {
    let modifiedCode = safeLiteralReplace(
      normalizedCode,
      normalizedSearch,
      normalizedReplace,
    );
    modifiedCode = restoreTrailingNewline(currentContent, modifiedCode);
    return {
      newContent: modifiedCode,
      occurrences: exactOccurrences,
      finalOldString: normalizedSearch,
      finalNewString: normalizedReplace,
    };
  }

  return null;
}

// ================
// Strategy 2: Flexible Match
// 逐行 trim 后比较，忽略缩进差异，替换时自动对齐缩进
// ================

function flexibleMatch(
  currentContent: string,
  params: ReplaceParams,
): ReplacementResult | null {
  const normalizedCode = currentContent;
  const normalizedSearch = params.old_string.replace(/\r\n/g, '\n');
  const normalizedReplace = params.new_string.replace(/\r\n/g, '\n');

  // 按行分割，保留每行的尾部换行符
  const sourceLines = normalizedCode.match(/.*(?:\n|$)/g)?.slice(0, -1) ?? [];
  const searchLinesStripped = normalizedSearch
    .split('\n')
    .map((line: string) => line.trim());
  const replaceLines = normalizedReplace.split('\n');

  let flexibleOccurrences = 0;
  let i = 0;
  while (i <= sourceLines.length - searchLinesStripped.length) {
    const window = sourceLines.slice(i, i + searchLinesStripped.length);
    const windowStripped = window.map((line: string) => line.trim());
    const isMatch = windowStripped.every(
      (line: string, index: number) => line === searchLinesStripped[index],
    );

    if (isMatch) {
      flexibleOccurrences++;
      const firstLineInMatch = window[0];
      const indentationMatch = firstLineInMatch.match(/^([ \t]*)/);
      const indentation = indentationMatch ? indentationMatch[1] : '';
      const newBlockWithIndent = applyIndentation(replaceLines, indentation);
      sourceLines.splice(
        i,
        searchLinesStripped.length,
        newBlockWithIndent.join('\n'),
      );
      i += replaceLines.length;
    } else {
      i++;
    }
  }

  if (flexibleOccurrences > 0) {
    let modifiedCode = sourceLines.join('');
    modifiedCode = restoreTrailingNewline(currentContent, modifiedCode);
    return {
      newContent: modifiedCode,
      occurrences: flexibleOccurrences,
      finalOldString: normalizedSearch,
      finalNewString: normalizedReplace,
    };
  }

  return null;
}

// ================
// Strategy 3: Regex Match
// 将 old_string 拆分为 token，用 \s* 连接，容忍任意空白变化
// ================

function regexMatch(
  currentContent: string,
  params: ReplaceParams,
): ReplacementResult | null {
  const normalizedSearch = params.old_string.replace(/\r\n/g, '\n');
  const normalizedReplace = params.new_string.replace(/\r\n/g, '\n');

  const delimiters = ['(', ')', ':', '[', ']', '{', '}', '>', '<', '='];

  let processedString = normalizedSearch;
  for (const delim of delimiters) {
    processedString = processedString.split(delim).join(` ${delim} `);
  }

  const tokens = processedString.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const escapedTokens = tokens.map(escapeRegex);
  const pattern = escapedTokens.join('\\s*');
  const finalPattern = `^([ \t]*)${pattern}`;

  const globalRegex = new RegExp(finalPattern, 'gm');
  const matches = currentContent.match(globalRegex);
  if (!matches) return null;

  const occurrences = matches.length;
  const newLines = normalizedReplace.split('\n');

  const replaceRegex = new RegExp(
    finalPattern,
    params.allow_multiple ? 'gm' : 'm',
  );

  const modifiedCode = currentContent.replace(
    replaceRegex,
    (_match: string, indentation: string) =>
      applyIndentation(newLines, indentation || '').join('\n'),
  );

  return {
    newContent: restoreTrailingNewline(currentContent, modifiedCode),
    occurrences,
    finalOldString: normalizedSearch,
    finalNewString: normalizedReplace,
  };
}

// ================
// Strategy 4: Fuzzy Match
// 滑动窗口 + Levenshtein 距离，容忍小幅文本差异
// ================

function fuzzyMatch(
  currentContent: string,
  params: ReplaceParams,
): ReplacementResult | null {
  const { old_string, new_string } = params;

  // 太短的搜索串容易误匹配
  if (old_string.length < 10) return null;

  const normalizedCode = currentContent.replace(/\r\n/g, '\n');
  const normalizedSearch = old_string.replace(/\r\n/g, '\n');
  const normalizedReplace = new_string.replace(/\r\n/g, '\n');

  const sourceLines = normalizedCode.match(/.*(?:\n|$)/g)?.slice(0, -1) ?? [];
  const searchLines = normalizedSearch
    .match(/.*(?:\n|$)/g)
    ?.slice(0, -1)
    .map((l: string) => l.trimEnd());

  // 复杂度保护：O(sourceLines * old_string²) < 4e8
  if (sourceLines.length * Math.pow(old_string.length, 2) > 400_000_000) {
    return null;
  }

  if (!searchLines || searchLines.length === 0) return null;

  const N = searchLines.length;
  const candidates: Array<{ index: number; score: number }> = [];
  const searchBlock = searchLines.join('\n');

  // 滑动窗口扫描
  for (let i = 0; i <= sourceLines.length - N; i++) {
    const windowLines = sourceLines.slice(i, i + N);
    const windowText = windowLines.map((l: string) => l.trimEnd()).join('\n');

    // 长度启发式剪枝
    const lengthDiff = Math.abs(windowText.length - searchBlock.length);
    if (
      lengthDiff / searchBlock.length >
      FUZZY_MATCH_THRESHOLD / WHITESPACE_PENALTY_FACTOR
    ) {
      continue;
    }

    // 双重评分：空白差异只算 10% 权重
    const d_raw = levenshtein.get(windowText, searchBlock);
    const d_norm = levenshtein.get(
      stripWhitespace(windowText),
      stripWhitespace(searchBlock),
    );

    const weightedDist = d_norm + (d_raw - d_norm) * WHITESPACE_PENALTY_FACTOR;
    const score = weightedDist / searchBlock.length;

    if (score <= FUZZY_MATCH_THRESHOLD) {
      candidates.push({ index: i, score });
    }
  }

  if (candidates.length === 0) return null;

  // 按分数升序，选择最佳非重叠匹配
  candidates.sort((a, b) => a.score - b.score || a.index - b.index);

  const selectedMatches: Array<{ index: number; score: number }> = [];
  for (const candidate of candidates) {
    const overlaps = selectedMatches.some(
      (m) => Math.abs(m.index - candidate.index) < N,
    );
    if (!overlaps) {
      selectedMatches.push(candidate);
    }
  }

  if (selectedMatches.length === 0) return null;

  // 记录匹配行号范围（1-based）
  const matchRanges = selectedMatches
    .map((m) => ({ start: m.index + 1, end: m.index + N }))
    .sort((a, b) => a.start - b.start);

  // 从下往上替换，避免索引偏移
  selectedMatches.sort((a, b) => b.index - a.index);

  const newLines = normalizedReplace.split('\n');

  for (const match of selectedMatches) {
    const firstLineMatch = sourceLines[match.index];
    const indentationMatch = firstLineMatch.match(/^([ \t]*)/);
    const indentation = indentationMatch ? indentationMatch[1] : '';

    const indentedReplaceLines = applyIndentation(newLines, indentation);

    let replacementText = indentedReplaceLines.join('\n');
    if (sourceLines[match.index + N - 1].endsWith('\n')) {
      replacementText += '\n';
    }

    sourceLines.splice(match.index, N, replacementText);
  }

  let modifiedCode = sourceLines.join('');
  modifiedCode = restoreTrailingNewline(currentContent, modifiedCode);

  return {
    newContent: modifiedCode,
    occurrences: selectedMatches.length,
    finalOldString: normalizedSearch,
    finalNewString: normalizedReplace,
    strategy: 'fuzzy',
    matchRanges,
  };
}

// ================
// Main Orchestrator
// 按优先级依次尝试：exact → flexible → regex → fuzzy
// ================

export function calculateReplacement(
  currentContent: string,
  params: ReplaceParams,
): ReplacementResult {
  const normalizedSearch = params.old_string.replace(/\r\n/g, '\n');
  const normalizedReplace = params.new_string.replace(/\r\n/g, '\n');

  if (normalizedSearch === '') {
    return {
      newContent: currentContent,
      occurrences: 0,
      finalOldString: normalizedSearch,
      finalNewString: normalizedReplace,
    };
  }

  const exactResult = exactMatch(currentContent, params);
  if (exactResult) return { ...exactResult, strategy: 'exact' };

  const flexibleResult = flexibleMatch(currentContent, params);
  if (flexibleResult) return { ...flexibleResult, strategy: 'flexible' };

  const regexResult = regexMatch(currentContent, params);
  if (regexResult) return { ...regexResult, strategy: 'regex' };

  const fuzzyResult = fuzzyMatch(currentContent, params);
  if (fuzzyResult) return fuzzyResult; // strategy 已在内部设置为 'fuzzy'

  return {
    newContent: currentContent,
    occurrences: 0,
    finalOldString: normalizedSearch,
    finalNewString: normalizedReplace,
  };
}

// ================
// Error Checking
// ================

export function getErrorReplaceResult(
  params: ReplaceParams,
  occurrences: number,
  finalOldString: string,
  finalNewString: string,
): { display: string; raw: string } | null {
  if (occurrences === 0) {
    return {
      display: 'Failed to edit, could not find the string to replace.',
      raw:
        `Failed to edit, 0 occurrences found for old_string in ${params.file_path}. ` +
        `Ensure you're not escaping content incorrectly and check whitespace, ` +
        `indentation, and context. Use read_file tool to verify.`,
    };
  }

  if (!params.allow_multiple && occurrences !== 1) {
    return {
      display: `Failed to edit, expected 1 occurrence but found ${occurrences}.`,
      raw:
        `Failed to edit, expected 1 occurrence but found ${occurrences} for ` +
        `old_string in file: ${params.file_path}. If you intended to replace ` +
        `multiple occurrences, set 'allow_multiple' to true.`,
    };
  }

  if (finalOldString === finalNewString) {
    return {
      display: 'No changes to apply. The old_string and new_string are identical.',
      raw: `No changes to apply. The old_string and new_string are identical in file: ${params.file_path}`,
    };
  }

  return null;
}
