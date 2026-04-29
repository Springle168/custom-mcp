const ANSI_ESCAPE_PATTERN = /\u001B\[[0-9;]*m/g;

export interface ParsedAndroidGradleOutput {
  success: boolean;
  summary: 'BUILD SUCCESSFUL' | 'BUILD FAILED';
  firstErrorBlock: string | null;
  logTail: string | null;
}

export interface ParseAndroidGradleOutputOptions {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  maxErrorBlockChars: number;
  maxLogTailChars: number;
}

export function parseAndroidGradleOutput(
  options: ParseAndroidGradleOutputOptions,
): ParsedAndroidGradleOutput {
  const merged = normalizeOutput([options.stdout, options.stderr].join('\n'));

  if (options.exitCode === 0) {
    return {
      success: true,
      summary: 'BUILD SUCCESSFUL',
      firstErrorBlock: null,
      logTail: null,
    };
  }

  return {
    success: false,
    summary: 'BUILD FAILED',
    firstErrorBlock: extractFirstErrorBlock(
      merged,
      options.maxErrorBlockChars,
    ),
    logTail: merged ? takeTail(merged, options.maxLogTailChars) : null,
  };
}

function normalizeOutput(text: string): string {
  return text
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
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
    return truncate(
      captureWhatWentWrongBlock(lines, whatWentWrongIndex),
      maxChars,
    );
  }

  const taskFailureIndex = lines.findIndex((line) =>
    /Execution failed for task/i.test(line),
  );

  if (taskFailureIndex >= 0) {
    return truncate(captureFromLine(lines, taskFailureIndex, 12), maxChars);
  }

  const causeIndex = lines.findIndex((line) => line.trimStart().startsWith('> '));

  if (causeIndex >= 0) {
    return truncate(captureFromLine(lines, causeIndex, 12), maxChars);
  }

  return null;
}

function captureWhatWentWrongBlock(lines: string[], startIndex: number): string {
  const collected: string[] = [];

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];

    if (line === undefined) {
      break;
    }

    const trimmed = line.trim();

    if (
      i > startIndex &&
      (trimmed === '* Try:' ||
        trimmed === '* Exception is:' ||
        trimmed.startsWith('BUILD FAILED'))
    ) {
      break;
    }

    collected.push(line);
  }

  return collected.join('\n').trim();
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
