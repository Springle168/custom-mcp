import levenshtein from 'fast-levenshtein';
import {
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
// Types
// ================

export type MatchStrategy = 'exact' | 'flexible' | 'tokenized' | 'fuzzy';

export interface ReplaceParams {
  file_path: string;
  target: string;
  replacement: string;
  allow_multiple?: boolean;
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
  strategy?: MatchStrategy;
}

export type RegexReplacementResult =
  | ({ ok: true; invalidReplacementSyntax: boolean } & ReplacementResult)
  | { ok: false; reason: 'invalid_regex' | 'zero_length_match'; message: string };

interface LineSegment {
  text: string;
  startOffset: number;
}

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

function splitLineSegments(content: string): LineSegment[] {
  const matches = content.match(/.*(?:\n|$)/g)?.slice(0, -1) ?? [];
  const segments: LineSegment[] = [];
  let startOffset = 0;

  for (const text of matches) {
    segments.push({ text, startOffset });
    startOffset += text.length;
  }

  return segments;
}

function rangeForLineWindow(
  lines: LineSegment[],
  startIndex: number,
  lineCount: number,
): MatchRange {
  const firstLine = lines[startIndex];
  const lastLine = lines[startIndex + lineCount - 1];

  return {
    startOffset: firstLine.startOffset,
    endOffset: lastLine.startOffset + lastLine.text.length,
  };
}

function buildIndentedReplacement(
  replacement: string,
  indentation: string,
  preserveTrailingNewline: boolean,
): string {
  const replacementLines = replacement.split('\n');
  let replacementText = applyIndentation(replacementLines, indentation).join('\n');

  if (preserveTrailingNewline && !replacementText.endsWith('\n')) {
    replacementText += '\n';
  }

  return replacementText;
}

function replaceLineWindows(
  content: string,
  replacements: Array<{ range: MatchRange; text: string }>,
): string {
  const sortedReplacements = [...replacements].sort(
    (a, b) => a.range.startOffset - b.range.startOffset,
  );
  let result = '';
  let cursor = 0;

  for (const replacement of sortedReplacements) {
    result += content.slice(cursor, replacement.range.startOffset);
    result += replacement.text;
    cursor = replacement.range.endOffset;
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
  const firstRange = sortedRanges[0];
  const lastRange = sortedRanges[sortedRanges.length - 1];

  return {
    start_line: lineForOffset(content, firstRange.startOffset),
    end_line: lineForRangeEnd(content, lastRange.endOffset),
  };
}

// ================
// Strategy 1: Exact Match
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
    strategy: 'exact',
  };
}

// ================
// Strategy 2: Flexible Match
// ================

function flexibleMatch(
  currentContent: string,
  params: ReplaceParams,
): ReplacementResult | null {
  const normalizedReplace = normalizeInput(params.replacement);
  const normalizedSearch = normalizeInput(params.target);
  const sourceLines = splitLineSegments(currentContent);
  const searchLinesStripped = normalizedSearch
    .split('\n')
    .map((line: string) => line.trim());

  if (searchLinesStripped.length === 0) return null;

  const matches: Array<{ range: MatchRange; replacementText: string }> = [];
  let index = 0;

  while (index <= sourceLines.length - searchLinesStripped.length) {
    const window = sourceLines.slice(index, index + searchLinesStripped.length);
    const windowStripped = window.map((line: LineSegment) => line.text.trim());
    const isMatch = windowStripped.every(
      (line: string, lineIndex: number) => line === searchLinesStripped[lineIndex],
    );

    if (isMatch) {
      const firstLineInMatch = window[0].text;
      const indentationMatch = firstLineInMatch.match(/^([ \t]*)/);
      const indentation = indentationMatch ? indentationMatch[1] : '';
      const range = rangeForLineWindow(
        sourceLines,
        index,
        searchLinesStripped.length,
      );
      const replacementText = buildIndentedReplacement(
        normalizedReplace,
        indentation,
        window[window.length - 1].text.endsWith('\n'),
      );

      matches.push({ range, replacementText });
      index += searchLinesStripped.length;
    } else {
      index++;
    }
  }

  if (matches.length === 0) return null;

  const matchRanges = matches.map((match) => match.range);
  const matchedTargets = matches.length;
  let newContent = currentContent;
  let replacementCount = 0;

  if (shouldApplyReplacement(matchedTargets, params.allow_multiple)) {
    newContent = replaceLineWindows(
      currentContent,
      matches.map((match) => ({ range: match.range, text: match.replacementText })),
    );
    newContent = restoreTrailingNewline(currentContent, newContent);
    replacementCount = matchedTargets;
  }

  return {
    newContent,
    matchedTargets,
    replacementCount,
    matchRanges,
    strategy: 'flexible',
  };
}

// ================
// Strategy 3: Tokenized Match
// ================

function tokenizedMatch(
  currentContent: string,
  params: ReplaceParams,
): ReplacementResult | null {
  const normalizedReplace = normalizeInput(params.replacement);
  const normalizedSearch = normalizeInput(params.target);
  const delimiters = ['(', ')', ':', '[', ']', '{', '}', '>', '<', '='];

  let processedString = normalizedSearch;
  for (const delimiter of delimiters) {
    processedString = processedString.split(delimiter).join(` ${delimiter} `);
  }

  const tokens = processedString.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const escapedTokens = tokens.map(escapeRegex);
  const pattern = escapedTokens.join('\\s*');
  const finalPattern = `^([ \t]*)${pattern}`;
  const globalRegex = new RegExp(finalPattern, 'gm');
  const matches: Array<{ range: MatchRange; replacementText: string }> = [];

  for (const match of currentContent.matchAll(globalRegex)) {
    if (match.index === undefined) continue;

    const indentation = match[1] ?? '';
    const matchedText = match[0];
    const range = {
      startOffset: match.index,
      endOffset: match.index + matchedText.length,
    };
    const replacementText = buildIndentedReplacement(
      normalizedReplace,
      indentation,
      matchedText.endsWith('\n'),
    );

    matches.push({ range, replacementText });
  }

  if (matches.length === 0) return null;

  const matchRanges = matches.map((match) => match.range);
  const matchedTargets = matches.length;
  let newContent = currentContent;
  let replacementCount = 0;

  if (shouldApplyReplacement(matchedTargets, params.allow_multiple)) {
    newContent = replaceLineWindows(
      currentContent,
      matches.map((match) => ({ range: match.range, text: match.replacementText })),
    );
    newContent = restoreTrailingNewline(currentContent, newContent);
    replacementCount = matchedTargets;
  }

  return {
    newContent,
    matchedTargets,
    replacementCount,
    matchRanges,
    strategy: 'tokenized',
  };
}

// ================
// Strategy 4: Fuzzy Match
// ================

function fuzzyMatch(
  currentContent: string,
  params: ReplaceParams,
): ReplacementResult | null {
  const normalizedReplace = normalizeInput(params.replacement);
  const normalizedSearch = normalizeInput(params.target);

  if (normalizedSearch.length < 10) return null;

  const sourceLines = splitLineSegments(currentContent);
  const searchLines = normalizedSearch
    .match(/.*(?:\n|$)/g)
    ?.slice(0, -1)
    .map((line: string) => line.trimEnd());

  if (!searchLines || searchLines.length === 0) return null;

  if (sourceLines.length * Math.pow(normalizedSearch.length, 2) > 400_000_000) {
    return null;
  }

  const lineCount = searchLines.length;
  const searchBlock = searchLines.join('\n');
  const candidates: Array<{ index: number; score: number }> = [];

  for (let index = 0; index <= sourceLines.length - lineCount; index++) {
    const windowLines = sourceLines.slice(index, index + lineCount);
    const windowText = windowLines
      .map((line: LineSegment) => line.text.trimEnd())
      .join('\n');
    const lengthDiff = Math.abs(windowText.length - searchBlock.length);

    if (
      lengthDiff / searchBlock.length >
      FUZZY_MATCH_THRESHOLD / WHITESPACE_PENALTY_FACTOR
    ) {
      continue;
    }

    const rawDistance = levenshtein.get(windowText, searchBlock);
    const normalizedDistance = levenshtein.get(
      stripWhitespace(windowText),
      stripWhitespace(searchBlock),
    );
    const weightedDistance =
      normalizedDistance +
      (rawDistance - normalizedDistance) * WHITESPACE_PENALTY_FACTOR;
    const score = weightedDistance / searchBlock.length;

    if (score <= FUZZY_MATCH_THRESHOLD) {
      candidates.push({ index, score });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.score - b.score || a.index - b.index);

  const selectedMatches: Array<{ index: number; score: number }> = [];
  for (const candidate of candidates) {
    const overlaps = selectedMatches.some(
      (match) => Math.abs(match.index - candidate.index) < lineCount,
    );
    if (!overlaps) {
      selectedMatches.push(candidate);
    }
  }

  if (selectedMatches.length === 0) return null;

  selectedMatches.sort((a, b) => a.index - b.index);

  const matches = selectedMatches.map((match) => {
    const window = sourceLines.slice(match.index, match.index + lineCount);
    const firstLineMatch = window[0].text;
    const indentationMatch = firstLineMatch.match(/^([ \t]*)/);
    const indentation = indentationMatch ? indentationMatch[1] : '';
    const range = rangeForLineWindow(sourceLines, match.index, lineCount);
    const replacementText = buildIndentedReplacement(
      normalizedReplace,
      indentation,
      window[window.length - 1].text.endsWith('\n'),
    );

    return { range, replacementText };
  });

  const matchRanges = matches.map((match) => match.range);
  const matchedTargets = matches.length;
  let newContent = currentContent;
  let replacementCount = 0;

  if (shouldApplyReplacement(matchedTargets, params.allow_multiple)) {
    newContent = replaceLineWindows(
      currentContent,
      matches.map((match) => ({ range: match.range, text: match.replacementText })),
    );
    newContent = restoreTrailingNewline(currentContent, newContent);
    replacementCount = matchedTargets;
  }

  return {
    newContent,
    matchedTargets,
    replacementCount,
    matchRanges,
    strategy: 'fuzzy',
  };
}

// ================
// Explicit Regex Mode
// ================

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
      while (digitIndex < replacement.length && /\d/.test(replacement[digitIndex])) {
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
    regex = new RegExp(params.target, 'gms');
  } catch (err: unknown) {
    const error = err as Error;
    return {
      ok: false,
      reason: 'invalid_regex',
      message: error.message || String(err),
    };
  }

  const normalizedReplace = normalizeInput(params.replacement);
  const matches: RegExpExecArray[] = [];

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

    matches.push(match);
  }

  const matchRanges = matches.map((match) => ({
    startOffset: match.index,
    endOffset: match.index + match[0].length,
  }));
  const matchedTargets = matches.length;
  let newContent = currentContent;
  let replacementCount = 0;
  let invalidReplacementSyntax = false;

  if (shouldApplyReplacement(matchedTargets, params.allow_multiple)) {
    let cursor = 0;
    let result = '';

    for (const match of matches) {
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
  };
}

// ================
// Main Default Orchestrator
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

  const exactResult = exactMatch(currentContent, normalizedParams);
  if (exactResult) return exactResult;

  const flexibleResult = flexibleMatch(currentContent, normalizedParams);
  if (flexibleResult) return flexibleResult;

  const tokenizedResult = tokenizedMatch(currentContent, normalizedParams);
  if (tokenizedResult) return tokenizedResult;

  const fuzzyResult = fuzzyMatch(currentContent, normalizedParams);
  if (fuzzyResult) return fuzzyResult;

  return {
    newContent: currentContent,
    matchedTargets: 0,
    replacementCount: 0,
    matchRanges: [],
  };
}
