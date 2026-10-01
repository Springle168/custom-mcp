import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolRuntimeContext } from '../../../runtime/invocation/tool-context.js';
import {
  calculateMatchedSpan,
  calculateRegexReplacement,
  calculateReplacement,
  type MatchedSpan,
  type ReplaceParams,
  type ReplacementResult,
} from '../../../engine/replacement.js';
import {
  detectLineEnding,
  resolveLineEnding,
  detectOmissionPlaceholders,
} from '../../../engine/text-utils.js';
import { MAX_FILE_SIZE_MB, isBinaryFile } from '../../../utils/file-read.js';
import {
  resolveFileAccessPath,
  validateFileAccessWriteTarget,
} from '../../../utils/file-access-policy.js';
import { withFileLock } from '../../../utils/file-lock.js';
import type { SafePath } from '../../../utils/paths.js';
import { REPLACE_TOOL_DEFINITION } from './replace-text.definition.js';
import type { MCPTool, ToolCallResult } from '../../types.js';
import { textErrorResult } from '../../results.js';

type MatchMode = 'default' | 'regex';

interface ReplacementInput {
  target: string;
  replacement: string;
}

interface FileInput {
  file_path: string;
  allow_multiple?: boolean;
  match_mode?: MatchMode;
  regex_flags?: string;
  replacements: ReplacementInput[];
}

interface ReplaceTextReplacementResult {
  success: boolean;
  matched_targets: number;
  replacement_count: number;
  matched_span: MatchedSpan | null;
  replacement_line_count: number;
  file_line_count: {
    previous: number | null;
    current: number | null;
  };
  note?: string;
}

interface ReplaceTextFileResult {
  success: boolean;
  file_path: string;
  match_mode: MatchMode;
  allow_multiple: boolean;
  replacements: ReplaceTextReplacementResult[];
}

interface ReplaceTextBatchPayload {
  success: boolean;
  files: ReplaceTextFileResult[];
}

interface ValidationResult {
  ok: boolean;
  note?: string;
}

interface ReplaceDependencies {
  writeTextContent: (
    resolved: string,
    content: string,
    lineEnding: '\r\n' | '\n',
  ) => Promise<string | null>;
}

function getMatchMode(file: FileInput): MatchMode {
  return file.match_mode ?? 'default';
}

function getAllowMultiple(file: FileInput): boolean {
  return file.allow_multiple ?? false;
}

function normalizeTextLineEndings(text: string): string {
  return text.replace(/\r\n|\r/g, '\n');
}

function applyLineEnding(
  content: string,
  lineEnding: '\r\n' | '\n',
): string {
  if (lineEnding === '\r\n') {
    return content.replace(/\r\n|\r|\n/g, '\r\n');
  }
  return content.replace(/\r\n|\r/g, '\n');
}

function countLines(text: string): number {
  return text === '' ? 0 : normalizeTextLineEndings(text).split('\n').length;
}

function replacementResult(
  replacement: ReplacementInput,
  success: boolean,
  note: string | undefined,
  overrides: Partial<ReplaceTextReplacementResult> = {},
): ReplaceTextReplacementResult {
  const previousLineCount = overrides.file_line_count?.previous ?? null;
  const result: ReplaceTextReplacementResult = {
    success,
    matched_targets: 0,
    replacement_count: 0,
    matched_span: null,
    replacement_line_count: countLines(replacement.replacement),
    file_line_count: {
      previous: previousLineCount,
      current: previousLineCount,
    },
    ...overrides,
  };

  if (note !== undefined && note.length > 0) {
    result.note = note;
  }

  return result;
}

function fileResult(
  file: FileInput,
  replacements: ReplaceTextReplacementResult[],
): ReplaceTextFileResult {
  return {
    success: replacements.every((result) => result.success),
    file_path: file.file_path,
    match_mode: getMatchMode(file),
    allow_multiple: getAllowMultiple(file),
    replacements,
  };
}

function joinNotes(...notes: Array<string | null | undefined>): string | undefined {
  const filteredNotes = notes.filter(
    (note): note is string => typeof note === 'string' && note.length > 0,
  );
  return filteredNotes.length > 0 ? filteredNotes.join(' ') : undefined;
}

function formatFileReadinessError(filePath: string, reason: string): string {
  return `Could not prepare ${filePath}: ${reason}. Check the path, permissions, and file type before retrying.`;
}

function validateRegexFlagCharactersAndRepetition(
  value: string,
): ValidationResult {
  const seenFlags = new Set<string>();

  for (const flag of value) {
    if (flag !== 'g' && flag !== 'm' && flag !== 's') {
      return {
        ok: false,
        note: "The 'regex_flags' parameter may contain only 'g', 'm', and 's'.",
      };
    }

    if (seenFlags.has(flag)) {
      return {
        ok: false,
        note: "The 'regex_flags' parameter must not repeat flags; each of 'g', 'm', and 's' can appear at most once.",
      };
    }

    seenFlags.add(flag);
  }

  return { ok: true };
}

function validateFileSemantics(file: FileInput): ValidationResult {
  if (file.regex_flags === undefined) {
    return { ok: true };
  }
  if (getMatchMode(file) !== 'regex') {
    return {
      ok: false,
      note:
        "The 'regex_flags' parameter can be used only when match_mode is 'regex'.",
    };
  }

  return validateRegexFlagCharactersAndRepetition(file.regex_flags);
}

function isDotsOnly(text: string): boolean {
  if (text.length < 3) return false;
  return [...text].every((char) => char === '.');
}

function stripPlaceholderLineDecorators(line: string): string {
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

  if (text.startsWith('(') && text.endsWith(')')) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

function normalizeStandaloneOmissionPhrase(text: string): string | null {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const phrase = normalized.replace(/\s*\.{3,}\s*$/, '').trim();

  const patterns = [
    /^rest of(?: the)?(?: code| file| method| methods| implementation)?$/,
    /^unchanged(?: code| file| method| methods| implementation)?$/,
    /^existing(?: code| implementation)?$/,
    /^same as (?:above|before)$/,
  ];

  if (patterns.some((pattern) => pattern.test(phrase))) {
    return `${phrase} ...`;
  }
  return null;
}

function detectPotentialOmissionPlaceholders(text: string): string[] {
  const placeholders = new Set(detectOmissionPlaceholders(text));

  for (const line of text.split(/\r\n|\r|\n/)) {
    const stripped = stripPlaceholderLineDecorators(line);
    if (isDotsOnly(stripped)) {
      placeholders.add('...');
      continue;
    }

    const standalonePhrase = normalizeStandaloneOmissionPhrase(stripped);
    if (standalonePhrase) {
      placeholders.add(standalonePhrase);
    }
  }

  return [...placeholders];
}

function getOmissionPlaceholderWarning(
  target: string,
  replacement: string,
): string | null {
  const targetPlaceholders = new Set(detectPotentialOmissionPlaceholders(target));
  const replacementPlaceholders = detectPotentialOmissionPlaceholders(
    replacement,
  ).filter((placeholder) => !targetPlaceholders.has(placeholder));

  if (replacementPlaceholders.length === 0) return null;

  const shownPlaceholders = [...new Set(replacementPlaceholders)]
    .slice(0, 3)
    .map((placeholder) => `'${placeholder}'`)
    .join(', ');
  const more = replacementPlaceholders.length > 3 ? ' and more' : '';

  return `Warning: replacement contains possible omission placeholder(s) ${shownPlaceholders}${more}. If this is intentional literal text, for example documentation, you can ignore this warning; otherwise use read_file to verify and provide complete replacement text.`;
}

function getInvalidRegexReplacementWarning(
  matchMode: MatchMode,
  invalidReplacementSyntax: boolean,
): string | null {
  if (matchMode !== 'regex' || !invalidReplacementSyntax) return null;
  return "Warning: replacement contains '$!' not followed by digits. In regex mode only $!n capture references are expanded; the suspicious syntax was written literally. Verify the result with read_file.";
}

function getRegexFlagsWarning(
  matchMode: MatchMode,
  regexFlags: string | undefined,
): string | null {
  if (
    matchMode !== 'regex' ||
    regexFlags === undefined ||
    !regexFlags.includes('g')
  ) {
    return null;
  }
  return "Warning: regex_flags includes 'g', but replace_text always enables global matching internally; you do not need to specify it.";
}

function getRegexMultilineMatchWarning(
  matchMode: MatchMode,
  hasMultilineMatch: boolean,
): string | null {
  if (matchMode !== 'regex' || !hasMultilineMatch) return null;
  return "Warning: regex target matched across multiple lines. If this was not intended, check dotAll ('s') usage; for line-local captures prefer '[^\\n]+' over '.+'.";
}

async function readExistingTextFile(
  resolved: string,
  filePath: string,
): Promise<
  | {
      exists: true;
      content: string;
      detectedLineEnding: '\r\n' | '\n';
      lineCount: number;
    }
  | { exists: false }
  | { exists: null; error: string }
> {
  try {
    const stats = await fs.stat(resolved);

    if (stats.isDirectory()) {
      return {
        exists: null,
        error: `Path ${filePath} is a directory. Provide a text file path instead.`,
      };
    }

    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > MAX_FILE_SIZE_MB) {
      return {
        exists: null,
        error: `File ${filePath} exceeds ${MAX_FILE_SIZE_MB}MB size limit (${sizeMB.toFixed(1)}MB). Use a smaller text file.`,
      };
    }

    if (await isBinaryFile(resolved)) {
      return {
        exists: null,
        error: `Cannot modify binary file: ${filePath}. Provide a text file path instead.`,
      };
    }

    const raw = await fs.readFile(resolved, 'utf-8');
    const content = normalizeTextLineEndings(raw);
    return {
      exists: true,
      content,
      detectedLineEnding: detectLineEnding(raw),
      lineCount: countLines(content),
    };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return { exists: false };
    }
    return {
      exists: null,
      error: formatFileReadinessError(filePath, error.message),
    };
  }
}

async function writeTextContent(
  resolved: string,
  content: string,
  lineEnding: '\r\n' | '\n',
): Promise<string | null> {
  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, applyLineEnding(content, lineEnding), 'utf-8');
    return null;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return `Could not write file: ${error.message}. Check the path and permissions before retrying.`;
  }
}

function buildMatchedFailure(
  replacement: ReplacementInput,
  note: string,
  previousLineCount: number,
  calculation: ReplacementResult,
  currentContent: string,
): ReplaceTextReplacementResult {
  return replacementResult(replacement, false, note, {
    matched_targets: calculation.matchedTargets,
    replacement_count: 0,
    matched_span: calculateMatchedSpan(currentContent, calculation.matchRanges),
    file_line_count: {
      previous: previousLineCount,
      current: previousLineCount,
    },
  });
}

async function recoverCurrentLineCount(
  safePath: SafePath,
  filePath: string,
  context: ToolRuntimeContext,
): Promise<number | null> {
  const safetyResult = await validateFileAccessWriteTarget(
    safePath,
    context.fileAccessPolicyContext,
  );
  if (!safetyResult.ok) return null;

  const recovered = await readExistingTextFile(safePath.resolvedPath, filePath);
  if (recovered.exists === true) return recovered.lineCount;
  if (recovered.exists === false) return 0;
  return null;
}

async function executeReplacement(
  file: FileInput,
  replacement: ReplacementInput,
  safePath: SafePath,
  context: ToolRuntimeContext,
  dependencies: ReplaceDependencies,
): Promise<ReplaceTextReplacementResult> {
  const filePath = file.file_path;
  const matchMode = getMatchMode(file);
  const allowMultiple = getAllowMultiple(file);
  const regexFlags = file.regex_flags;
  const target = replacement.target;
  const replacementText = replacement.replacement;

  if (matchMode === 'regex' && target === '') {
    return replacementResult(
      replacement,
      false,
      "The 'target' parameter must be non-empty when match_mode is 'regex'. Provide a regex pattern that consumes text.",
    );
  }

  const safetyResult = await validateFileAccessWriteTarget(
    safePath,
    context.fileAccessPolicyContext,
  );
  if (!safetyResult.ok) {
    return replacementResult(replacement, false, safetyResult.reason);
  }

  const existingFile = await readExistingTextFile(safePath.resolvedPath, filePath);
  if (existingFile.exists === null) {
    return replacementResult(replacement, false, existingFile.error);
  }

  const placeholderWarning = getOmissionPlaceholderWarning(
    target,
    replacementText,
  );

  if (!existingFile.exists) {
    if (matchMode === 'default' && target === '') {
      if (await isBinaryFile(safePath.resolvedPath)) {
        return replacementResult(
          replacement,
          false,
          `Cannot create text content at binary-looking path: ${filePath}. Provide a text file path instead.`,
          { file_line_count: { previous: 0, current: 0 } },
        );
      }

      const normalizedReplacement = normalizeTextLineEndings(replacementText);
      const lineEnding = resolveLineEnding(context.lineEnding, null);
      try {
        await fs.mkdir(path.dirname(safePath.resolvedPath), { recursive: true });
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        return replacementResult(
          replacement,
          false,
          `Could not create parent directory for ${filePath}: ${error.message}. Check the path and permissions before retrying.`,
          { file_line_count: { previous: 0, current: 0 } },
        );
      }

      const postMkdirSafetyResult = await validateFileAccessWriteTarget(
        safePath,
        context.fileAccessPolicyContext,
      );
      if (!postMkdirSafetyResult.ok) {
        return replacementResult(
          replacement,
          false,
          postMkdirSafetyResult.reason,
          { file_line_count: { previous: 0, current: 0 } },
        );
      }

      const writeError = await dependencies.writeTextContent(
        safePath.resolvedPath,
        normalizedReplacement,
        lineEnding,
      );
      if (writeError) {
        const currentLineCount = await recoverCurrentLineCount(
          safePath,
          filePath,
          context,
        );
        return replacementResult(
          replacement,
          false,
          `${writeError} The file may have been truncated, partially written, or fully written; use read_file to verify its actual content.`,
          { file_line_count: { previous: 0, current: currentLineCount } },
        );
      }

      return replacementResult(
        replacement,
        true,
        joinNotes(`File created at ${filePath}.`, placeholderWarning),
        {
          file_line_count: {
            previous: 0,
            current: countLines(normalizedReplacement),
          },
        },
      );
    }

    return replacementResult(
      replacement,
      false,
      `File not found: ${filePath}. Verify the path with read_file, or in default mode use an empty target only when you intend to create a missing file.`,
      { file_line_count: { previous: 0, current: 0 } },
    );
  }

  const currentContent = existingFile.content;
  const previousLineCount = existingFile.lineCount;

  if (matchMode === 'default' && target === '') {
    return replacementResult(
      replacement,
      false,
      `File already exists: ${filePath}. Empty target is only allowed for creating a missing file; provide a non-empty target to modify an existing file.`,
      {
        file_line_count: {
          previous: previousLineCount,
          current: previousLineCount,
        },
      },
    );
  }

  const params: ReplaceParams = {
    file_path: filePath,
    target,
    replacement: replacementText,
    allow_multiple: allowMultiple,
    regex_flags: regexFlags,
  };

  let calculation: ReplacementResult;
  let invalidReplacementSyntax = false;
  let hasMultilineRegexMatch = false;

  if (matchMode === 'regex') {
    const regexResult = calculateRegexReplacement(currentContent, params);
    if (!regexResult.ok) {
      const note = regexResult.reason === 'invalid_regex'
        ? `Invalid regex target: ${regexResult.message}. Provide a bare JavaScript RegExp pattern without slash delimiters or flags.`
        : regexResult.message;
      return replacementResult(replacement, false, note, {
        file_line_count: {
          previous: previousLineCount,
          current: previousLineCount,
        },
      });
    }
    calculation = regexResult;
    invalidReplacementSyntax = regexResult.invalidReplacementSyntax;
    hasMultilineRegexMatch = regexResult.hasMultilineMatch;
  } else {
    calculation = calculateReplacement(currentContent, params);
  }

  if (calculation.matchedTargets === 0) {
    const note = matchMode === 'regex'
      ? `No regex matches found for target in ${filePath}. Verify the JavaScript RegExp pattern against the file content.`
      : `No matches found for target in ${filePath}. Use read_file to verify exact content, whitespace, indentation, and context.`;
    return buildMatchedFailure(
      replacement,
      note,
      previousLineCount,
      calculation,
      currentContent,
    );
  }

  if (!allowMultiple && calculation.matchedTargets !== 1) {
    return buildMatchedFailure(
      replacement,
      `Expected exactly 1 match but found ${calculation.matchedTargets} in ${filePath}. If you intended to replace multiple matches, set allow_multiple=true.`,
      previousLineCount,
      calculation,
      currentContent,
    );
  }

  if (calculation.newContent === currentContent) {
    return buildMatchedFailure(
      replacement,
      'No changes to apply. The computed replacement is identical to the current file content; check whether target and replacement are the same.',
      previousLineCount,
      calculation,
      currentContent,
    );
  }

  const currentLineCount = countLines(calculation.newContent);
  const lineEnding = resolveLineEnding(
    context.lineEnding,
    existingFile.detectedLineEnding,
  );
  const preWriteSafetyResult = await validateFileAccessWriteTarget(
    safePath,
    context.fileAccessPolicyContext,
  );
  if (!preWriteSafetyResult.ok) {
    return replacementResult(replacement, false, preWriteSafetyResult.reason, {
      matched_targets: calculation.matchedTargets,
      matched_span: calculateMatchedSpan(
        currentContent,
        calculation.matchRanges,
      ),
      file_line_count: {
        previous: previousLineCount,
        current: null,
      },
    });
  }

  const writeError = await dependencies.writeTextContent(
    safePath.resolvedPath,
    calculation.newContent,
    lineEnding,
  );
  if (writeError) {
    const recoveredLineCount = await recoverCurrentLineCount(
      safePath,
      filePath,
      context,
    );
    return replacementResult(
      replacement,
      false,
      `${writeError} The file may have been truncated, partially written, or fully written; use read_file to verify its actual content.`,
      {
        matched_targets: calculation.matchedTargets,
        replacement_count: 0,
        matched_span: calculateMatchedSpan(
          currentContent,
          calculation.matchRanges,
        ),
        file_line_count: {
          previous: previousLineCount,
          current: recoveredLineCount,
        },
      },
    );
  }

  return replacementResult(
    replacement,
    true,
    joinNotes(
      placeholderWarning,
      getRegexFlagsWarning(matchMode, regexFlags),
      getInvalidRegexReplacementWarning(matchMode, invalidReplacementSyntax),
      getRegexMultilineMatchWarning(matchMode, hasMultilineRegexMatch),
    ),
    {
      matched_targets: calculation.matchedTargets,
      replacement_count: calculation.replacementCount,
      matched_span: calculateMatchedSpan(
        currentContent,
        calculation.matchRanges,
      ),
      file_line_count: {
        previous: previousLineCount,
        current: currentLineCount,
      },
    },
  );
}

async function executeFile(
  file: FileInput,
  context: ToolRuntimeContext,
  dependencies: ReplaceDependencies,
): Promise<ReplaceTextFileResult> {
  const validation = validateFileSemantics(file);
  if (!validation.ok) {
    return fileResult(
      file,
      file.replacements.map((replacement) =>
        replacementResult(replacement, false, validation.note),
      ),
    );
  }

  const safePathResult = resolveFileAccessPath(
    file.file_path,
    context.fileAccessPolicyContext,
  );
  if (!safePathResult.ok) {
    return fileResult(
      file,
      file.replacements.map((replacement) =>
        replacementResult(replacement, false, safePathResult.reason),
      ),
    );
  }

  return withFileLock(safePathResult.path.resolvedPath, async () => {
    const results: ReplaceTextReplacementResult[] = [];
    for (const replacement of file.replacements) {
      results.push(
        await executeReplacement(
          file,
          replacement,
          safePathResult.path,
          context,
          dependencies,
        ),
      );
    }
    return fileResult(file, results);
  });
}

export function createReplaceTextHandler(
  dependencies: Partial<ReplaceDependencies> = {},
): MCPTool['handler'] {
  const resolvedDependencies: ReplaceDependencies = {
    writeTextContent,
    ...dependencies,
  };

  return async (
    args: Record<string, unknown>,
    context: ToolRuntimeContext,
  ): Promise<ToolCallResult> => {
    const files = args.files as FileInput[];
    const fileResults: ReplaceTextFileResult[] = [];

    for (const file of files) {
      fileResults.push(await executeFile(file, context, resolvedDependencies));
    }

    const payload: ReplaceTextBatchPayload = {
      success: fileResults.every((result) => result.success),
      files: fileResults,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: !payload.success,
    };
  };
}

export const handleReplace = createReplaceTextHandler();

const replaceTool: MCPTool = {
  definition: REPLACE_TOOL_DEFINITION,
  handler: handleReplace,
};

export default replaceTool;
