import { restoreTrailingNewline } from './text-utils.js';

// ================
// Types
// ================

export interface ReplaceParams {
  file_path: string;
  target: string;
  replacement: string;
  allow_multiple?: boolean;
  regex_flags?: string;
}

export interface MatchRange {
  startOffset: number;
  endOffset: number;
}

export interface MatchedSpan {
  start_line: number;
  end_line: number;
}

export interface ReplacementResult {
  newContent: string;
  matchedTargets: number;
  replacementCount: number;
  matchRanges: MatchRange[];
}

export type RegexReplacementResult =
  | ({
      ok: true;
      invalidReplacementSyntax: boolean;
      hasMultilineMatch: boolean;
    } & ReplacementResult)
  | { ok: false; reason: 'invalid_regex' | 'zero_length_match'; message: string };

// ================
// Shared helpers
// ================

function normalizeInput(text: string): string {
  return text.replace(/\r\n|\r/g, '\n');
}

function findLiteralRanges(content: string, target: string): MatchRange[] {
  if (target === '') return [];

  const ranges: MatchRange[] = [];
  let index = 0;

  while (index <= content.length) {
    const startOffset = content.indexOf(target, index);
    if (startOffset < 0) break;

    const endOffset = startOffset + target.length;
    ranges.push({ startOffset, endOffset });
    index = endOffset;
  }

  return ranges;
}

function replaceLiteralRanges(
  content: string,
  ranges: MatchRange[],
  replacement: string,
): string {
  let result = '';
  let cursor = 0;

  for (const range of ranges) {
    result += content.slice(cursor, range.startOffset);
    result += replacement;
    cursor = range.endOffset;
  }

  return result + content.slice(cursor);
}

function shouldApplyReplacement(
  matchedTargets: number,
  allowMultiple: boolean | undefined,
): boolean {
  if (matchedTargets === 0) return false;
  return allowMultiple === true || matchedTargets === 1;
}

function countNewlinesBefore(content: string, offset: number): number {
  let count = 0;
  for (let index = 0; index < offset; index++) {
    if (content[index] === '\n') count++;
  }
  return count;
}

function lineForOffset(content: string, offset: number): number {
  return countNewlinesBefore(content, offset) + 1;
}

function lineForRangeEnd(content: string, endOffset: number): number {
  if (endOffset <= 0) return 1;
  return lineForOffset(content, endOffset - 1);
}

export function calculateMatchedSpan(
  content: string,
  ranges: MatchRange[],
): MatchedSpan | null {
  if (ranges.length === 0) return null;

  const sortedRanges = [...ranges].sort(
    (a, b) => a.startOffset - b.startOffset,
  );
  const firstRange = sortedRanges.at(0);
  const lastRange = sortedRanges.at(-1);
  if (firstRange === undefined || lastRange === undefined) return null;

  return {
    start_line: lineForOffset(content, firstRange.startOffset),
    end_line: lineForRangeEnd(content, lastRange.endOffset),
  };
}

// ================
// Default Literal Matching
// ================

function exactMatch(
  currentContent: string,
  params: ReplaceParams,
): ReplacementResult | null {
  const normalizedReplace = normalizeInput(params.replacement);
  const normalizedSearch = normalizeInput(params.target);
  const matchRanges = findLiteralRanges(currentContent, normalizedSearch);
  const matchedTargets = matchRanges.length;

  if (matchedTargets === 0) return null;

  let newContent = currentContent;
  let replacementCount = 0;

  if (shouldApplyReplacement(matchedTargets, params.allow_multiple)) {
    newContent = replaceLiteralRanges(
      currentContent,
      matchRanges,
      normalizedReplace,
    );
    newContent = restoreTrailingNewline(currentContent, newContent);
    replacementCount = matchedTargets;
  }

  return {
    newContent,
    matchedTargets,
    replacementCount,
    matchRanges,
  };
}

// ================
// Explicit Regex Mode
// ================

function buildRegexFlags(regexFlags: string | undefined): string {
  const requestedFlags = regexFlags ?? 'ms';
  let flags = 'g';

  if (requestedFlags.includes('m')) flags += 'm';
  if (requestedFlags.includes('s')) flags += 's';

  return flags;
}

function expandRegexReplacement(
  replacement: string,
  match: RegExpExecArray,
): { text: string; invalidReplacementSyntax: boolean } {
  let text = '';
  let invalidReplacementSyntax = false;
  let index = 0;

  while (index < replacement.length) {
    const char = replacement[index];
    const nextChar = replacement[index + 1];

    if (char === '$' && nextChar === '$') {
      text += '$';
      index += 2;
      continue;
    }

    if (char === '$' && nextChar === '!') {
      let digitIndex = index + 2;
      while (digitIndex < replacement.length && /\d/.test(replacement.charAt(digitIndex))) {
        digitIndex++;
      }

      if (digitIndex === index + 2) {
        invalidReplacementSyntax = true;
        text += '$!';
        index += 2;
        continue;
      }

      const groupNumber = Number.parseInt(
        replacement.slice(index + 2, digitIndex),
        10,
      );
      text += match[groupNumber] ?? '';
      index = digitIndex;
      continue;
    }

    text += char;
    index++;
  }

  return { text, invalidReplacementSyntax };
}

export function calculateRegexReplacement(
  currentContent: string,
  params: ReplaceParams,
): RegexReplacementResult {
  let regex: RegExp;

  try {
    regex = new RegExp(params.target, buildRegexFlags(params.regex_flags));
  } catch (err: unknown) {
    const error = err as Error;
    return {
      ok: false,
      reason: 'invalid_regex',
      message: error.message || String(err),
    };
  }

  const normalizedReplace = normalizeInput(params.replacement);
  let matchedTargets = 0;
  let firstRange: MatchRange | null = null;
  let lastRange: MatchRange | null = null;
  let hasMultilineMatch = false;

  while (true) {
    const match = regex.exec(currentContent);
    if (!match) break;

    if (match[0].length === 0) {
      return {
        ok: false,
        reason: 'zero_length_match',
        message:
          'Regex target produced a zero-length match. Refine the pattern so every match consumes at least one character.',
      };
    }

    const range = {
      startOffset: match.index,
      endOffset: match.index + match[0].length,
    };
    hasMultilineMatch ||= match[0].includes('\n');
    firstRange ??= range;
    lastRange = range;
    matchedTargets++;
  }

  const matchRanges: MatchRange[] = [];
  if (firstRange !== null) {
    matchRanges.push(firstRange);
    if (lastRange !== null && lastRange !== firstRange) {
      matchRanges.push(lastRange);
    }
  }
  let newContent = currentContent;
  let replacementCount = 0;
  let invalidReplacementSyntax = false;

  if (shouldApplyReplacement(matchedTargets, params.allow_multiple)) {
    regex.lastIndex = 0;
    let cursor = 0;
    let result = '';

    while (true) {
      const match = regex.exec(currentContent);
      if (!match) break;

      const expandedReplacement = expandRegexReplacement(
        normalizedReplace,
        match,
      );
      invalidReplacementSyntax ||= expandedReplacement.invalidReplacementSyntax;
      result += currentContent.slice(cursor, match.index);
      result += expandedReplacement.text;
      cursor = match.index + match[0].length;
    }

    newContent = result + currentContent.slice(cursor);
    replacementCount = matchedTargets;
  }

  return {
    ok: true,
    newContent,
    matchedTargets,
    replacementCount,
    matchRanges,
    invalidReplacementSyntax,
    hasMultilineMatch,
  };
}

// ================
// Default Replacement
// ================

export function calculateReplacement(
  currentContent: string,
  params: ReplaceParams,
): ReplacementResult {
  const normalizedReplace = normalizeInput(params.replacement);
  const normalizedSearch = normalizeInput(params.target);

  if (normalizedSearch === '') {
    return {
      newContent: currentContent,
      matchedTargets: 0,
      replacementCount: 0,
      matchRanges: [],
    };
  }

  const normalizedParams: ReplaceParams = {
    ...params,
    target: normalizedSearch,
    replacement: normalizedReplace,
  };

  return exactMatch(currentContent, normalizedParams) ?? {
    newContent: currentContent,
    matchedTargets: 0,
    replacementCount: 0,
    matchRanges: [],
  };
}
