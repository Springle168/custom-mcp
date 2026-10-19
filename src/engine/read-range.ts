/** Range semantics are request-local and independent of file I/O. */
export interface ReadRangeOptions {
  readonly start_line?: number | string;
  readonly end_line?: number | string;
  readonly read_mode?: 'line' | 'regex';
}

export type CompiledReadRange =
  | { readonly mode: 'line'; readonly start?: number; readonly end?: number }
  | { readonly mode: 'regex'; readonly start?: RegExp; readonly end?: RegExp };

export interface SelectedTextRange {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly lineCount: number;
  readonly bytes: number;
}

type RangeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** Structural validation belongs to the schema; mode-dependent semantics stay local. */
export function compileReadRange(options: ReadRangeOptions): RangeResult<CompiledReadRange> {
  const mode = options.read_mode ?? 'line';
  for (const name of ['start_line', 'end_line'] as const) {
    const value = options[name];
    if (value === undefined) continue;
    if (mode === 'line' && typeof value !== 'number') {
      return {
        ok: false,
        reason: `In read_mode="line", ${name} must be a positive integer (JSON number).`,
      };
    }
    if (mode === 'regex' && typeof value !== 'string') {
      return {
        ok: false,
        reason: `In read_mode="regex", ${name} must be a non-empty regex pattern string.`,
      };
    }
  }

  if (mode === 'line') {
    const start = options.start_line as number | undefined;
    const end = options.end_line as number | undefined;
    if (start !== undefined && end !== undefined && start > end) {
      return { ok: false, reason: `start_line ${start} cannot be greater than end_line ${end}.` };
    }
    return { ok: true, value: { mode, start, end } };
  }

  const patterns: { start?: RegExp; end?: RegExp } = {};
  for (const [name, key] of [
    ['start_line', 'start'],
    ['end_line', 'end'],
  ] as const) {
    const pattern = options[name] as string | undefined;
    if (pattern === undefined) continue;
    try {
      patterns[key] = new RegExp(pattern);
    } catch {
      return {
        ok: false,
        reason: `Invalid ${name} regex pattern. Check the pattern syntax and escaping.`,
      };
    }
  }
  return { ok: true, value: { mode, ...patterns } };
}

/** Selects complete lines, retaining original numbering and actual UTF-8 body size. */
export function selectTextRange(
  lines: readonly string[],
  range: CompiledReadRange,
  showLineNumbers: boolean,
): RangeResult<SelectedTextRange> {
  let startIndex = 0;
  let endIndex = lines.length;

  if (range.mode === 'line') {
    startIndex = (range.start ?? 1) - 1;
    if (startIndex >= lines.length) {
      return {
        ok: false,
        reason: `start_line ${startIndex + 1} exceeds file line count (${lines.length}).`,
      };
    }
    endIndex = Math.min(range.end ?? lines.length, lines.length);
  } else {
    if (range.start) {
      const pattern = range.start;
      startIndex = lines.findIndex((line) => pattern.test(line));
      if (startIndex === -1) {
        return { ok: false, reason: 'start_line regex pattern did not match any line.' };
      }
    }
    if (range.end) {
      const pattern = range.end;
      let matchIndex = startIndex;
      while (matchIndex < lines.length && !pattern.test(lines[matchIndex]!)) {
        matchIndex += 1;
      }
      if (matchIndex === lines.length) {
        return {
          ok: false,
          reason:
            'end_line regex pattern did not match any line at or after the resolved start line.',
        };
      }
      endIndex = matchIndex + 1;
    }
  }

  const content = lines
    .slice(startIndex, endIndex)
    .map((line, index) => (showLineNumbers ? `${startIndex + index + 1}: ${line}` : line))
    .join('\n');
  return {
    ok: true,
    value: {
      content,
      startLine: startIndex + 1,
      endLine: endIndex,
      totalLines: lines.length,
      lineCount: endIndex - startIndex,
      bytes: Buffer.byteLength(content, 'utf8'),
    },
  };
}
