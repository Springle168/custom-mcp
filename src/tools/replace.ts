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
  formatPathSafetyError,
  resolveSafePathInContext,
  validateSafeWriteTarget,
} from '../utils/paths.js';
import { withFileLock } from '../utils/file-lock.js';
import type { MCPTool, ToolCallResult } from './types.js';
import { textErrorResult, textResult } from './results.js';

// ================
// Types
// ================

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

// ================
// Tool Schema（MCP tools/list 返回给宿主的）
// ================

export const REPLACE_TOOL_DEFINITION = {
  name: 'replace_text' as const,
  description: `Replaces text within a file and returns a JSON payload.

- When writing code, do NOT use omission placeholders to represent existing code, such as '(rest of methods ...)', '...', or 'unchanged code'. Write the complete replacement content explicitly. Possible placeholders are written but reported as warnings in note.

Mode boundaries:
- In default mode, target MUST be EXACT literal source text, including all whitespace, indentation, and newlines. Never escape or approximate it. replacement must be complete literal text; no replacement syntax is interpreted.
- In regex mode, target is a bare JavaScript RegExp pattern. Matching is global and defaults to regex_flags='ms'; with dotAll enabled, '.' matches newlines, so prefer '[^\\n]+' for line-local captures.
- Regex replacement interprets only $!n capture references and $$ dollar escaping. JavaScript native replacement tokens like $1, $&, $\`, and $' remain literal.
- Empty target is allowed only in default mode when the file does not exist, to create a new file. Prefer write_file for new file creation.

Parallel calls:
- Parallel replace_text calls may target the same file.
- Same-file calls in a single parallel call batch are applied in listed order; each call matches against the file content produced by previous same-file calls in that batch.

Best practices:
- Always use read_file to examine file content before making replacements.
- Prefer multiple small, atomic replacements over one large replacement.
- For multiple same-file edits in one change set, put the replace_text calls in a single parallel call batch ordered by application sequence; place prerequisite replacements before dependent replacements, and write each target against the content at that step.
- If the target file requires extensive refactoring, it is recommended to first perform a full overwrite of the file using \`write_file\` or a similar file-writing tool, and then perform partial replacements based on needs and subsequent plan adjustments.
- Verify file content after changes.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      file_path: {
        type: 'string',
        description:
          'Path of the file to modify.',
      },
      target: {
        type: 'string',
        description:
          "Content to locate. In default mode this is EXACT literal text; in regex mode this is a bare JavaScript RegExp pattern. Empty target is allowed only in default mode for creating a missing file.",
      },
      replacement: {
        type: 'string',
        description:
          "The exact literal replacement text. Must be complete content with no placeholders. In regex mode only $!n capture references and $$ dollar escaping are interpreted.",
      },
      allow_multiple: {
        type: 'boolean',
        description:
          "Defaults to 'false'. If 'true', replace all matches. If false or omitted, exactly one match is required for replacement.",
      },
      match_mode: {
        type: 'string',
        enum: ['default', 'regex'],
        description:
          "Matching mode. Defaults to 'default'. 'regex' compiles target as a bare JavaScript RegExp with global matching plus regex_flags.",
      },
      regex_flags: {
        type: 'string',
        description:
          "Optional only when match_mode='regex'. Defaults to 'ms'. May contain each of g, m, and s at most once; g is always enabled internally and does not need to be specified. Use 'm' to keep multiline anchors and omit 's' when '.' must not match newlines.",
      },
    },
    required: ['file_path', 'target', 'replacement'],
    additionalProperties: false,
  },
};

// ================
// Response Helpers
// ================

function successResult(payload: ReplaceTextPayload): ToolCallResult {
  return textResult(JSON.stringify(payload));
}

function errorResult(payload: ReplaceTextPayload): ToolCallResult {
  return textErrorResult(JSON.stringify(payload));
}

function normalizeMatchMode(value: unknown): MatchMode {
  return value === 'default' || value === 'regex' ? value : 'default';
}

function normalizeAllowMultiple(value: unknown): boolean {
  return value === true;
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
    file_path: typeof args.file_path === 'string' ? args.file_path : '',
    match_mode: normalizeMatchMode(args.match_mode),
    allow_multiple: normalizeAllowMultiple(args.allow_multiple),
    matched_targets: 0,
    replacement_count: 0,
    matched_span: null,
    replacement_line_count:
      typeof args.replacement === 'string' ? countLines(args.replacement) : 0,
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

// ================
// Parameter Validation
// ================

const ALLOWED_KEYS = new Set([
  'file_path',
  'target',
  'replacement',
  'allow_multiple',
  'match_mode',
  'regex_flags',
]);

function hasOwn(args: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function validateRegexFlags(value: string): ValidationResult {
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

function validateParams(args: Record<string, unknown>): ValidationResult {
  const unknownKeys = Object.keys(args).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      note:
        `Unknown parameter(s): ${unknownKeys.join(', ')}. ` +
        'Use target/replacement for replace_text; accepted parameters are file_path, target, replacement, allow_multiple, match_mode, and regex_flags.',
    };
  }

  if (!hasOwn(args, 'file_path')) {
    return { ok: false, note: "Missing required parameter 'file_path'." };
  }
  if (typeof args.file_path !== 'string' || args.file_path.length === 0) {
    return {
      ok: false,
      note: "The 'file_path' parameter must be a non-empty string.",
    };
  }

  if (!hasOwn(args, 'target')) {
    return { ok: false, note: "Missing required parameter 'target'." };
  }
  if (typeof args.target !== 'string') {
    return { ok: false, note: "The 'target' parameter must be a string." };
  }

  if (!hasOwn(args, 'replacement')) {
    return { ok: false, note: "Missing required parameter 'replacement'." };
  }
  if (typeof args.replacement !== 'string') {
    return {
      ok: false,
      note: "The 'replacement' parameter must be a string.",
    };
  }

  if (
    hasOwn(args, 'allow_multiple') &&
    typeof args.allow_multiple !== 'boolean'
  ) {
    return {
      ok: false,
      note: "The 'allow_multiple' parameter must be a boolean when provided.",
    };
  }

  if (
    hasOwn(args, 'match_mode') &&
    args.match_mode !== 'default' &&
    args.match_mode !== 'regex'
  ) {
    return {
      ok: false,
      note: "The 'match_mode' parameter must be either 'default' or 'regex'.",
    };
  }

  if (hasOwn(args, 'regex_flags')) {
    if (typeof args.regex_flags !== 'string') {
      return {
        ok: false,
        note: "The 'regex_flags' parameter must be a string when provided.",
      };
    }

    if (args.match_mode !== 'regex') {
      return {
        ok: false,
        note: "The 'regex_flags' parameter can be used only when match_mode is 'regex'.",
      };
    }

    const regexFlagsValidation = validateRegexFlags(args.regex_flags);
    if (!regexFlagsValidation.ok) {
      return regexFlagsValidation;
    }
  }

  if (args.match_mode === 'regex' && args.target === '') {
    return {
      ok: false,
      note:
        "The 'target' parameter must be non-empty when match_mode is 'regex'. Provide a regex pattern that consumes text.",
    };
  }

  return { ok: true };
}

// ================
// Omission Placeholder Warning
// ================

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

// ================
// File Preparation
// ================

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

// ================
// Replacement Results
// ================

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

// ================
// Tool Handler
// ================

export async function handleReplace(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
): Promise<ToolCallResult> {
  const validation = validateParams(args);
  if (!validation.ok) {
    return errorResult(payloadFromArgs(args, false, validation.note));
  }

  const filePath = args.file_path as string;
  const target = args.target as string;
  const replacement = args.replacement as string;
  const matchMode = normalizeMatchMode(args.match_mode);
  const allowMultiple = normalizeAllowMultiple(args.allow_multiple);
  const regexFlags = typeof args.regex_flags === 'string' ? args.regex_flags : undefined;
  const placeholderWarning = getOmissionPlaceholderWarning(target, replacement);

  const pathSafetyContext = context.pathSafetyContext;
  const safePathResult = resolveSafePathInContext(filePath, pathSafetyContext);
  if (!safePathResult.ok) {
    return errorResult(
      payloadFromArgs(
        args,
        false,
        formatPathSafetyError(safePathResult.error),
      ),
    );
  }
  const safePath = safePathResult.path;

  return withFileLock(safePath.resolvedPath, async () => {
    const safetyError = await validateSafeWriteTarget(safePath);
    if (safetyError) {
      return errorResult(payloadFromArgs(args, false, safetyError));
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
        const postMkdirSafetyError = await validateSafeWriteTarget(safePath);
        if (postMkdirSafetyError) {
          return errorResult(payloadFromArgs(args, false, postMkdirSafetyError));
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
    const preWriteSafetyError = await validateSafeWriteTarget(safePath);
    if (preWriteSafetyError) {
      return errorResult(
        payloadFromArgs(args, false, preWriteSafetyError, {
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
