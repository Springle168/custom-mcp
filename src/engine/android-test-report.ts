import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';

const DEFAULT_FAILED_TEST_DETAILS_LIMIT = 10;
const DEFAULT_MAX_FIRST_ERROR_BLOCK_CHARS = 2500;
const MAX_CLASS_NAME_CHARS = 500;
const MAX_TEST_NAME_CHARS = 500;
const MAX_FAILURE_TYPE_CHARS = 500;
const MAX_FAILURE_MESSAGE_CHARS = 1000;
const MAX_SOURCE_LOCATION_CHARS = 500;
const SOURCE_LOCATION_PATTERN = /\(([^()\r\n]+\.(?:kt|java):\d+)\)/g;

export type TestReportStatus =
  | 'generated'
  | 'not_generated'
  | 'parse_failed';

export interface FailedTestDetail {
  className: string | null;
  name: string;
  type: string | null;
  message: string | null;
  location: string | null;
}

export interface TestReportSummary {
  status: TestReportStatus;
  reportFiles?: number;
  tests?: number;
  failures?: number;
  errors?: number;
  skipped?: number;
  failedTests?: FailedTestDetail[];
  omittedFailedTests?: number;
}

export interface AndroidTestReportFile {
  relativePath: string;
  xml: string;
}

export interface ParsedAndroidTestReports {
  summary: TestReportSummary;
  firstErrorBlock: string | null;
}

type XmlRecord = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: {
    enabled: true,
    maxEntitySize: 1000,
    maxExpansionDepth: 4,
    maxTotalExpansions: 1000,
    maxExpandedLength: 100_000,
    maxEntityCount: 50,
  },
  isArray: (tagName) =>
    tagName === 'testsuite' ||
    tagName === 'testcase' ||
    tagName === 'failure' ||
    tagName === 'error',
});

export function parseAndroidTestReports(
  files: readonly AndroidTestReportFile[],
  failedTestDetailsLimit = DEFAULT_FAILED_TEST_DETAILS_LIMIT,
  maxFirstErrorBlockChars = DEFAULT_MAX_FIRST_ERROR_BLOCK_CHARS,
): ParsedAndroidTestReports {
  const orderedFiles = [...files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, 'en'),
  );
  const parsedSuites: XmlRecord[] = [];
  let parsedFileCount = 0;

  for (const file of orderedFiles) {
    try {
      SyntaxValidator.validate(file.xml, {
        multipleRoots: false,
        docType: {
          maxEntityCount: 50,
          maxEntitySize: 1000,
        },
      });
      const parsed = parser.parse(file.xml) as unknown;
      const suites = extractSuites(parsed);
      if (suites.length === 0) {
        continue;
      }

      parsedFileCount += 1;
      parsedSuites.push(...suites);
    } catch {
      // A malformed report must not replace the authoritative Gradle failure.
    }
  }

  if (parsedFileCount === 0) {
    return {
      summary: { status: 'parse_failed' },
      firstErrorBlock: null,
    };
  }

  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  const allFailedTests: FailedTestDetail[] = [];

  for (const suite of parsedSuites) {
    const testCases = asRecordArray(suite.testcase);
    const suiteFailures = collectFailedTests(testCases);

    tests += readCount(suite.tests, testCases.length);
    failures += readCount(
      suite.failures,
      suiteFailures.filter((failure) => failure.nodeName === 'failure').length,
    );
    errors += readCount(
      suite.errors,
      suiteFailures.filter((failure) => failure.nodeName === 'error').length,
    );
    skipped += readCount(
      suite.skipped,
      testCases.filter((testCase) => testCase.skipped !== undefined).length,
    );

    allFailedTests.push(
      ...suiteFailures.map(({ detail }) => detail),
    );
  }

  const detailLimit = Math.max(0, Math.floor(failedTestDetailsLimit));
  const failedTests = allFailedTests.slice(0, detailLimit);
  const totalFailedCount = Math.max(failures + errors, allFailedTests.length);
  const omittedFailedTests = Math.max(0, totalFailedCount - failedTests.length);

  const summary: TestReportSummary = {
    status: 'generated',
    reportFiles: parsedFileCount,
    tests,
    failures,
    errors,
    skipped,
    failedTests,
    omittedFailedTests,
  };

  return {
    summary,
    firstErrorBlock: formatFirstTestErrorBlock(
      summary,
      maxFirstErrorBlockChars,
    ),
  };
}

export function formatFirstTestErrorBlock(
  summary: TestReportSummary,
  maxChars = DEFAULT_MAX_FIRST_ERROR_BLOCK_CHARS,
): string | null {
  const firstFailure = summary.failedTests?.[0];
  if (!firstFailure) {
    return null;
  }

  const failedCount = Math.max(
    (summary.failures ?? 0) + (summary.errors ?? 0),
    (summary.failedTests?.length ?? 0) + (summary.omittedFailedTests ?? 0),
  );
  const lines = [
    `${failedCount} ${failedCount === 1 ? 'test' : 'tests'} failed. First failure:`,
    [firstFailure.className, firstFailure.name].filter(Boolean).join(' > '),
  ];

  const diagnostic = [firstFailure.type, firstFailure.message]
    .filter(Boolean)
    .join(': ');
  if (diagnostic) {
    lines.push(diagnostic);
  }
  if (firstFailure.location) {
    lines.push(firstFailure.location);
  }

  return truncateText(lines.join('\n'), maxChars);
}

function extractSuites(parsed: unknown): XmlRecord[] {
  if (!isRecord(parsed)) {
    return [];
  }

  const directSuites = asRecordArray(parsed.testsuite);
  const containers = asRecordArray(parsed.testsuites);
  const nestedSuites = containers.flatMap((container) =>
    asRecordArray(container.testsuite),
  );

  return [...directSuites, ...nestedSuites];
}

function collectFailedTests(testCases: readonly XmlRecord[]): Array<{
  nodeName: 'failure' | 'error';
  detail: FailedTestDetail;
}> {
  const failures: Array<{
    nodeName: 'failure' | 'error';
    detail: FailedTestDetail;
  }> = [];

  for (const testCase of testCases) {
    for (const nodeName of ['failure', 'error'] as const) {
      for (const failureNode of asUnknownArray(testCase[nodeName])) {
        failures.push({
          nodeName,
          detail: toFailedTestDetail(testCase, failureNode),
        });
      }
    }
  }

  return failures;
}

function toFailedTestDetail(
  testCase: XmlRecord,
  failureNode: unknown,
): FailedTestDetail {
  const failureRecord = isRecord(failureNode) ? failureNode : null;
  const failureText = readNodeText(failureNode);
  const className = truncateNullableText(
    readOptionalString(testCase.classname),
    MAX_CLASS_NAME_CHARS,
  );
  const name = truncateText(
    readOptionalString(testCase.name) ?? 'Unknown test',
    MAX_TEST_NAME_CHARS,
  );
  const type = truncateNullableText(
    readOptionalString(failureRecord?.type),
    MAX_FAILURE_TYPE_CHARS,
  );
  const rawMessage =
    compactMessage(readOptionalString(failureRecord?.message)) ??
    compactMessage(firstNonBlankLine(failureText));
  const normalizedMessage =
    type && rawMessage?.startsWith(`${type}:`)
      ? rawMessage.slice(type.length + 1).trim() || null
      : rawMessage;
  const message = truncateNullableText(
    normalizedMessage,
    MAX_FAILURE_MESSAGE_CHARS,
  );

  return {
    className,
    name,
    type,
    message,
    location: truncateNullableText(
      extractSourceLocation(failureText, className),
      MAX_SOURCE_LOCATION_CHARS,
    ),
  };
}

function extractSourceLocation(
  failureText: string | null,
  className: string | null,
): string | null {
  if (!failureText) {
    return null;
  }

  const matches = [...failureText.matchAll(SOURCE_LOCATION_PATTERN)].map(
    (match) => match[1],
  );
  if (matches.length === 0) {
    return null;
  }

  const simpleClassName = className?.split('.').at(-1)?.split('$')[0];
  if (simpleClassName) {
    const classLocation = matches.find((location) =>
      location?.startsWith(`${simpleClassName}.`),
    );
    if (classLocation) {
      return classLocation;
    }
  }

  return matches[0] ?? null;
}

function readNodeText(node: unknown): string | null {
  if (typeof node === 'string') {
    return node.trim() || null;
  }
  if (!isRecord(node)) {
    return null;
  }

  return readOptionalString(node['#text']);
}

function compactMessage(message: string | null): string | null {
  if (!message) {
    return null;
  }

  const compact = message.replace(/\s+/g, ' ').trim();
  return compact || null;
}

function firstNonBlankLine(text: string | null): string | null {
  if (!text) {
    return null;
  }

  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function readCount(value: unknown, fallback: number): number {
  const text = readOptionalString(value);
  if (text === null || !/^\d+$/u.test(text)) {
    return fallback;
  }

  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function truncateNullableText(
  value: string | null,
  maxChars: number,
): string | null {
  return value === null ? null : truncateText(value, maxChars);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}...[truncated]`;
}

function asRecordArray(value: unknown): XmlRecord[] {
  return asUnknownArray(value).filter(isRecord);
}

function asUnknownArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
