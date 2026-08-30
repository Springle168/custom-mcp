import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import {
  calculateMatchedSpan,
  calculateRegexReplacement,
  calculateReplacement,
  type MatchedSpan,
  type ReplaceParams,
  type ReplacementResult,
} from '../engine/replacement.js';
import {
  detectLineEnding,
  resolveLineEnding,
  detectOmissionPlaceholders,
} from '../engine/text-utils.js';
import { MAX_FILE_SIZE_MB, isBinaryFile } from '../utils/file-read.js';
import {
  resolveFileAccessPath,
  validateFileAccessWriteTarget,
} from '../utils/file-access-policy.js';
import { withFileLock } from '../utils/file-lock.js';
import { REPLACE_TOOL_DEFINITION } from './definitions/replace-text.definition.js';
import type { MCPTool, ToolCallResult } from './types.js';
import { textErrorResult, textResult } from './results.js';

type MatchMode = 'default' | 'regex';

interface ReplaceTextPayload {
  success: boolean;
  file_path: string;
  match_mode: MatchMode;
  allow_multiple: boolean;
  matched_targets: number;
  replacement_count: number;
  matched_span: MatchedSpan | null;
  replacement_line_count: number;
  file_line_count: {
    previous: number;
    current: number;
  };
  note?: string;
}

interface ValidationResult {
  ok: boolean;
  note?: string;
}

function successResult(payload: ReplaceTextPayload): ToolCallResult {
  return textResult(JSON.stringify(payload));
}

function errorResult(payload: ReplaceTextPayload): ToolCallResult {
  return textErrorResult(JSON.stringify(payload));
}

function getMatchMode(args: Record<string, unknown>): MatchMode {
  return (args.match_mode as MatchMode | undefined) ?? 'default';
}

function getAllowMultiple(args: Record<string, unknown>): boolean {
  return (args.allow_multiple as boolean | undefined) ?? false;
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

function payloadFromArgs(
  args: Record<string, unknown>,
  success: boolean,
  note: string | undefined,
  overrides: Partial<ReplaceTextPayload> = {},
): ReplaceTextPayload {
  const previousLineCount = overrides.file_line_count?.previous ?? 0;
  const payload: ReplaceTextPayload = {
    success,
    file_path: args.file_path as string,
    match_mode: getMatchMode(args),
    allow_multiple: getAllowMultiple(args),
    matched_targets: 0,
    replacement_count: 0,
    matched_span: null,
    replacement_line_count: countLines(args.replacement as string),
    file_line_count: {
      previous: previousLineCount,
      current: previousLineCount,
    },
    ...overrides,
  };

  if (note !== undefined && note.length > 0) {
    payload.note = note;
  }

  return payload;
}

function joinNotes(...notes: Array<string | null | undefined>): string | undefined {
  const filteredNotes = notes.filter(
    (note): note is string => typeof note === 'string' && note.length > 0,
  );
  return filteredNotes.length > 0 ? filteredNotes.join(' ') : undefined;
}

function formatFileReadinessError(
  filePath: string,
  reason: string,
): string {
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

function validateRegexFlagsForMode(
  matchMode: MatchMode,
  regexFlags: string | undefined,
): ValidationResult {
  if (regexFlags === undefined) {
    return { ok: true };
  }
  if (matchMode !== 'regex') {
    return {
      ok: false,
      note:
        "The 'regex_flags' parameter can be used only when match_mode is 'regex'.",
    };
  }

  return validateRegexFlagCharactersAndRepetition(regexFlags);
}

function validateRegexTargetIsNonEmpty(
  matchMode: MatchMode,
  target: string,
): ValidationResult {
  if (matchMode === 'regex' && target === '') {
    return {
      ok: false,
      note:
        "The 'target' parameter must be non-empty when match_mode is 'regex'. Provide a regex pattern that consumes text.",
    };
  }

  return { ok: true };
}

function validateReplaceSemantics(
  args: Record<string, unknown>,
): ValidationResult {
  const matchMode = getMatchMode(args);
  const regexFlags = args.regex_flags as string | undefined;
  const flagsValidation = validateRegexFlagsForMode(matchMode, regexFlags);
  if (!flagsValidation.ok) {
    return flagsValidation;
  }

  const target = args.target as string;
  const targetValidation = validateRegexTargetIsNonEmpty(matchMode, target);
  if (!targetValidation.ok) {
    return targetValidation;
  }

  return { ok: true };
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
  args: Record<string, unknown>,
  note: string,
  previousLineCount: number,
  calculation: ReplacementResult,
  currentContent: string,
): ToolCallResult {
  return errorResult(
    payloadFromArgs(args, false, note, {
      matched_targets: calculation.matchedTargets,
      replacement_count: 0,
      matched_span: calculateMatchedSpan(currentContent, calculation.matchRanges),
      file_line_count: {
        previous: previousLineCount,
        current: previousLineCount,
      },
    }),
  );
}

export async function handleReplace(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
): Promise<ToolCallResult> {
  const validation = validateReplaceSemantics(args);
  if (!validation.ok) {
    return errorResult(payloadFromArgs(args, false, validation.note));
  }

  const filePath = args.file_path as string;
  const target = args.target as string;
  const replacement = args.replacement as string;
  const matchMode = getMatchMode(args);
  const allowMultiple = getAllowMultiple(args);
  const regexFlags = args.regex_flags as string | undefined;
  const placeholderWarning = getOmissionPlaceholderWarning(target, replacement);

  const fileAccessPolicyContext = context.fileAccessPolicyContext;
  const safePathResult = resolveFileAccessPath(
    filePath,
    fileAccessPolicyContext,
  );
  if (!safePathResult.ok) {
    return errorResult(
      payloadFromArgs(
        args,
        false,
        safePathResult.reason,
      ),
    );
  }
  const safePath = safePathResult.path;

  return withFileLock(safePath.resolvedPath, async () => {
    const safetyResult = await validateFileAccessWriteTarget(
      safePath,
      fileAccessPolicyContext,
    );
    if (!safetyResult.ok) {
      return errorResult(payloadFromArgs(args, false, safetyResult.reason));
    }

    const existingFile = await readExistingTextFile(safePath.resolvedPath, filePath);
    if (existingFile.exists === null) {
      return errorResult(payloadFromArgs(args, false, existingFile.error));
    }

    if (!existingFile.exists) {
      if (matchMode === 'default' && target === '') {
        if (await isBinaryFile(safePath.resolvedPath)) {
          return errorResult(
            payloadFromArgs(
              args,
              false,
              `Cannot create text content at binary-looking path: ${filePath}. Provide a text file path instead.`,
            ),
          );
        }

        const normalizedReplacement = normalizeTextLineEndings(replacement);
        const lineEnding = resolveLineEnding(context.lineEnding, null);
        try {
          await fs.mkdir(path.dirname(safePath.resolvedPath), { recursive: true });
        } catch (err: unknown) {
          const error = err as NodeJS.ErrnoException;
          return errorResult(
            payloadFromArgs(
              args,
              false,
              `Could not create parent directory for ${filePath}: ${error.message}. Check the path and permissions before retrying.`,
            ),
          );
        }
        const postMkdirSafetyResult = await validateFileAccessWriteTarget(
          safePath,
          fileAccessPolicyContext,
        );
        if (!postMkdirSafetyResult.ok) {
          return errorResult(
            payloadFromArgs(args, false, postMkdirSafetyResult.reason),
          );
        }

        const writeError = await writeTextContent(
          safePath.resolvedPath,
          normalizedReplacement,
          lineEnding,
        );
        if (writeError) {
          return errorResult(payloadFromArgs(args, false, writeError));
        }

        return successResult(
          payloadFromArgs(
            args,
            true,
            joinNotes(`File created at ${filePath}.`, placeholderWarning),
            {
              matched_targets: 0,
              replacement_count: 0,
              matched_span: null,
              file_line_count: {
                previous: 0,
                current: countLines(normalizedReplacement),
              },
            },
          ),
        );
      }

      return errorResult(
        payloadFromArgs(
          args,
          false,
          `File not found: ${filePath}. Verify the path with read_file, or in default mode use an empty target only when you intend to create a missing file.`,
        ),
      );
    }

    const currentContent = existingFile.content;
    const previousLineCount = existingFile.lineCount;

    if (matchMode === 'default' && target === '') {
      return errorResult(
        payloadFromArgs(
          args,
          false,
          `File already exists: ${filePath}. Empty target is only allowed for creating a missing file; provide a non-empty target to modify an existing file.`,
          {
            file_line_count: {
              previous: previousLineCount,
              current: previousLineCount,
            },
          },
        ),
      );
    }

    const params: ReplaceParams = {
      file_path: filePath,
      target,
      replacement,
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
        return errorResult(
          payloadFromArgs(args, false, note, {
            matched_targets: 0,
            replacement_count: 0,
            matched_span: null,
            file_line_count: {
              previous: previousLineCount,
              current: previousLineCount,
            },
          }),
        );
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
        args,
        note,
        previousLineCount,
        calculation,
        currentContent,
      );
    }

    if (!allowMultiple && calculation.matchedTargets !== 1) {
      return buildMatchedFailure(
        args,
        `Expected exactly 1 match but found ${calculation.matchedTargets} in ${filePath}. If you intended to replace multiple matches, set allow_multiple=true.`,
        previousLineCount,
        calculation,
        currentContent,
      );
    }

    if (calculation.newContent === currentContent) {
      return buildMatchedFailure(
        args,
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
      fileAccessPolicyContext,
    );
    if (!preWriteSafetyResult.ok) {
      return errorResult(
        payloadFromArgs(args, false, preWriteSafetyResult.reason, {
          file_line_count: {
            previous: previousLineCount,
            current: previousLineCount,
          },
        }),
      );
    }

    const writeError = await writeTextContent(
      safePath.resolvedPath,
      calculation.newContent,
      lineEnding,
    );
    if (writeError) {
      return errorResult(
        payloadFromArgs(args, false, writeError, {
          file_line_count: {
            previous: previousLineCount,
            current: previousLineCount,
          },
        }),
      );
    }

    return successResult(
      payloadFromArgs(
        args,
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
      ),
    );
  });
}

const replaceTool: MCPTool = {
  definition: REPLACE_TOOL_DEFINITION,
  handler: handleReplace,
};

export default replaceTool;
