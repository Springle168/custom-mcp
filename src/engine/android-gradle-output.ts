const ANSI_ESCAPE_PATTERN = /\u001B\[[0-9;]*m/g;
const FAILED_TASK_PATTERN = /Execution failed for task ['"]([^'"]+)['"]\.?/i;

export interface ParsedAndroidGradleOutput {
  success: boolean;
  summary: 'BUILD SUCCESSFUL' | 'BUILD FAILED' | 'BUILD CANCELLED';
  cancelled: boolean;
  failedTask: string | null;
  firstErrorBlock: string | null;
  logTail?: string;
}

export interface ParseAndroidGradleOutputOptions {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  combinedOutput?: string;
  maxErrorBlockChars: number;
  maxLogTailChars: number;
  includeLogTail?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
}

export function parseAndroidGradleOutput(
  options: ParseAndroidGradleOutputOptions,
): ParsedAndroidGradleOutput {
  const merged = normalizeOutput(
    options.combinedOutput ?? [options.stdout, options.stderr].join('\n'),
  );

  if (options.cancelled === true) {
    return {
      success: false,
      summary: 'BUILD CANCELLED',
      cancelled: true,
      failedTask: extractFailedTask(merged),
      firstErrorBlock: extractFirstErrorBlock(merged, options.maxErrorBlockChars),
      ...(options.includeLogTail === true && merged
        ? { logTail: takeTail(merged, options.maxLogTailChars) }
        : {}),
    };
  }

  if (options.timedOut === true) {
    return {
      success: false,
      summary: 'BUILD FAILED',
      cancelled: false,
      failedTask: extractFailedTask(merged),
      firstErrorBlock: extractFirstErrorBlock(merged, options.maxErrorBlockChars),
      ...(options.includeLogTail === true && merged
        ? { logTail: takeTail(merged, options.maxLogTailChars) }
        : {}),
    };
  }

  if (options.exitCode === 0) {
    return {
      success: true,
      summary: 'BUILD SUCCESSFUL',
      cancelled: false,
      failedTask: null,
      firstErrorBlock: null,
    };
  }

  return {
    success: false,
    summary: 'BUILD FAILED',
    cancelled: false,
    failedTask: extractFailedTask(merged),
    firstErrorBlock: extractFirstErrorBlock(
      merged,
      options.maxErrorBlockChars,
    ),
    ...(options.includeLogTail === true && merged
      ? { logTail: takeTail(merged, options.maxLogTailChars) }
      : {}),
  };
}

function normalizeOutput(text: string): string {
  return text
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function extractFailedTask(text: string): string | null {
  return FAILED_TASK_PATTERN.exec(text)?.[1] ?? null;
}

function extractFirstErrorBlock(
  text: string,
  maxChars: number,
): string | null {
  if (!text) {
    return null;
  }

  const lines = text.split('\n');

  const compilerErrorIndex = lines.findIndex(
    (line) =>
      /^e:\s/i.test(line) ||
      /^error:\s/i.test(line) ||
      /:\d+:\s(error|warning):/i.test(line),
  );

  if (compilerErrorIndex >= 0) {
    return truncate(
      captureFromLine(lines, compilerErrorIndex, 12),
      maxChars,
    );
  }

  const whatWentWrongIndex = lines.findIndex(
    (line) => line.trim() === '* What went wrong:',
  );

  if (whatWentWrongIndex >= 0) {
    const rootCause = captureWhatWentWrongRootCause(lines, whatWentWrongIndex);
    if (rootCause) {
      return truncate(rootCause, maxChars);
    }
  }

  const causeIndex = lines.findIndex((line) => line.trimStart().startsWith('> '));

  if (causeIndex >= 0) {
    return truncate(captureFromLine(lines, causeIndex, 12), maxChars);
  }

  const fallback = cleanFailureTemplate(lines);
  return fallback ? truncate(fallback, maxChars) : null;
}

function captureWhatWentWrongRootCause(
  lines: string[],
  startIndex: number,
): string {
  const collected: string[] = [];

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];

    if (line === undefined) {
      break;
    }

    const trimmed = line.trim();

    if (
      trimmed === '* Try:' ||
      trimmed === '* Exception is:' ||
      trimmed.startsWith('BUILD FAILED')
    ) {
      break;
    }

    if (FAILED_TASK_PATTERN.test(trimmed)) {
      continue;
    }

    collected.push(line);
  }

  return trimBlankLines(collected).join('\n');
}

function cleanFailureTemplate(lines: string[]): string {
  const collected: string[] = [];
  let skippingSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '* Try:' || trimmed === '* Exception is:') {
      skippingSection = true;
      continue;
    }

    if (skippingSection) {
      if (trimmed.startsWith('* ') && trimmed.endsWith(':')) {
        skippingSection = false;
      } else if (trimmed.startsWith('BUILD FAILED')) {
        skippingSection = false;
      } else {
        continue;
      }
    }

    if (
      trimmed === 'FAILURE: Build failed with an exception.' ||
      trimmed === '* What went wrong:' ||
      FAILED_TASK_PATTERN.test(trimmed) ||
      trimmed.startsWith('BUILD FAILED') ||
      /^\d+ actionable tasks?:/i.test(trimmed)
    ) {
      continue;
    }

    collected.push(line);
  }

  return trimBlankLines(collected).join('\n');
}

function captureFromLine(
  lines: string[],
  startIndex: number,
  maxLines: number,
): string {
  const collected: string[] = [];

  for (
    let i = startIndex;
    i < lines.length && collected.length < maxLines;
    i += 1
  ) {
    const line = lines[i];

    if (line === undefined) {
      break;
    }

    const trimmed = line.trim();

    if (
      i > startIndex &&
      (trimmed === '' ||
        trimmed === 'FAILURE: Build failed with an exception.' ||
        trimmed === '* What went wrong:' ||
        trimmed === '* Try:' ||
        trimmed === '* Exception is:' ||
        trimmed.startsWith('BUILD FAILED'))
    ) {
      break;
    }

    collected.push(line);
  }

  return collected.join('\n').trim();
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]?.trim() === '') {
    start += 1;
  }

  while (end > start && lines[end - 1]?.trim() === '') {
    end -= 1;
  }

  return lines.slice(start, end);
}

function takeTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `...[truncated]\n${text.slice(-maxChars)}`;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}...[truncated]`;
}
