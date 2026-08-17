import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LineEnding } from '../../src/config.js';
import type { ToolRuntimeContext } from '../../src/runtime/tool-context.js';
import replaceTool from '../../src/tools/replace.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  getResultText,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_ROOT = path.join(__dirname, '..', 'fixtures', 'replace-text');

async function removeFixturesRootIfEmpty(): Promise<void> {
  try {
    await fs.rmdir(FIXTURES_ROOT);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // Another concurrently running suite may still own a child directory.
    if (code === 'ENOENT' || code === 'ENOTEMPTY') return;
    throw error;
  }
}

export interface MatchedSpan {
  start_line: number;
  end_line: number;
}

export interface ReplaceTextV2Json {
  success: boolean;
  file_path: string;
  match_mode: 'default' | 'regex';
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

export function createReplaceTextFixtureHarness(suiteName: string) {
  assert(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suiteName),
    'Fixture suite name should use kebab-case',
  );

  const fixturesDir = path.join(FIXTURES_ROOT, suiteName);

  function createTestToolContext(
    lineEnding: LineEnding = 'auto',
  ): ToolRuntimeContext {
    return createTestToolRuntimeContext({ rootDir: fixturesDir, lineEnding });
  }

  async function resetFixtures(): Promise<void> {
    await fs.rm(fixturesDir, { recursive: true, force: true });
    await fs.mkdir(fixturesDir, { recursive: true });
  }

  async function cleanupFixtures(): Promise<void> {
    await fs.rm(fixturesDir, { recursive: true, force: true });
    await removeFixturesRootIfEmpty();
  }

  function fixturePath(...segments: string[]): string {
    return path.join(fixturesDir, ...segments);
  }

  async function writeFixture(
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<string> {
    const absolutePath = fixturePath(relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content);
    return absolutePath;
  }

  async function readFixture(relativePath: string): Promise<string> {
    return fs.readFile(fixturePath(relativePath), 'utf-8');
  }

  async function makeFixtureDir(relativePath: string): Promise<string> {
    const absolutePath = fixturePath(relativePath);
    await fs.mkdir(absolutePath, { recursive: true });
    return absolutePath;
  }

  async function fixtureExists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(fixturePath(relativePath));
      return true;
    } catch {
      return false;
    }
  }

  async function callReplace(
    args: Record<string, unknown>,
    context: ToolRuntimeContext = createTestToolContext(),
  ): Promise<ToolCallResult> {
    return replaceTool.handler(args, context);
  }

  async function assertFixtureContent(
    relativePath: string,
    expected: string,
    message: string,
  ): Promise<void> {
    const actual = await readFixture(relativePath);
    assertEqual(actual, expected, message);
  }

  async function assertFixtureMissing(
    relativePath: string,
    message: string,
  ): Promise<void> {
    assertEqual(await fixtureExists(relativePath), false, message);
  }

  return {
    fixturesDir,
    createTestToolContext,
    resetFixtures,
    cleanupFixtures,
    fixturePath,
    writeFixture,
    readFixture,
    makeFixtureDir,
    fixtureExists,
    callReplace,
    assertFixtureContent,
    assertFixtureMissing,
  };
}

export function parseResultJson(result: ToolCallResult): ReplaceTextV2Json {
  assertEnvelope(result);

  const text = getResultText(result);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Expected content[0].text to be v2 JSON, but parsing failed: ${String(error)}\nText: ${text}`,
    );
  }

  assertResultShape(parsed);
  return parsed;
}

export function assertSuccessResult(result: ToolCallResult): ReplaceTextV2Json {
  assertEqual(result.isError, false, 'Success result should set isError: false');
  const json = parseResultJson(result);
  assertEqual(json.success, true, 'JSON success should be true');
  return json;
}

export function assertErrorResult(result: ToolCallResult): ReplaceTextV2Json {
  assertEqual(result.isError, true, 'Failure result should set isError: true');
  const json = parseResultJson(result);
  assertEqual(json.success, false, 'JSON success should be false');
  assert(typeof json.note === 'string', 'Failure JSON should include note');
  return json;
}

export function assertSpan(
  json: ReplaceTextV2Json,
  startLine: number,
  endLine: number,
  message: string,
): void {
  assert(json.matched_span !== null, `${message}: expected matched_span`);
  assertEqual(
    json.matched_span.start_line,
    startLine,
    `${message}: start_line`,
  );
  assertEqual(json.matched_span.end_line, endLine, `${message}: end_line`);
}

export function assertNoSpan(
  json: ReplaceTextV2Json,
  message: string,
): void {
  assertEqual(json.matched_span, null, message);
}

export function assertJsonNoteIncludes(
  json: ReplaceTextV2Json,
  substring: string,
  message: string,
): void {
  assertIncludes(json.note, substring, message);
}

export function assertJsonDefaults(json: ReplaceTextV2Json): void {
  assertEqual(json.matched_targets, 0, 'Default matched_targets');
  assertEqual(json.replacement_count, 0, 'Default replacement_count');
  assertNoSpan(json, 'Default matched_span');
  assertEqual(json.file_line_count.previous, 0, 'Default previous line count');
  assertEqual(json.file_line_count.current, 0, 'Default current line count');
}

export function assertDeepEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  assertEqual(actualText, expectedText, message);
}

export function countSpecLines(text: string): number {
  const normalized = text.replace(/\r\n/g, '\n');
  return normalized === '' ? 0 : normalized.split('\n').length;
}

function assertEnvelope(result: ToolCallResult): void {
  assert(
    Array.isArray(result.content),
    'Result should contain MCP content array',
  );
  assertEqual(result.content.length, 1, 'Result should have one content item');
  assertEqual(result.content[0]?.type, 'text', 'Result content type');
  assert(
    typeof result.content[0]?.text === 'string',
    'Result content text should be a string',
  );
  assert(
    typeof result.isError === 'boolean',
    'Result should include explicit isError boolean',
  );
  assert(
    !('structuredContent' in result),
    'replace_text v2 should not return structuredContent',
  );
}

function assertResultShape(value: unknown): asserts value is ReplaceTextV2Json {
  assert(isRecord(value), 'Parsed JSON should be an object');

  const requiredKeys = [
    'success',
    'file_path',
    'match_mode',
    'allow_multiple',
    'matched_targets',
    'replacement_count',
    'matched_span',
    'replacement_line_count',
    'file_line_count',
  ];
  const allowedKeys = [...requiredKeys, 'note'];

  assertDeepEqual(
    Object.keys(value).sort(),
    Object.keys(value)
      .filter((key) => allowedKeys.includes(key))
      .sort(),
    'JSON result should not contain undeclared fields',
  );

  for (const key of requiredKeys) {
    assert(key in value, `JSON result should include ${key}`);
  }

  assert(typeof value.success === 'boolean', 'success should be boolean');
  assert(typeof value.file_path === 'string', 'file_path should be string');
  assert(
    value.match_mode === 'default' || value.match_mode === 'regex',
    'match_mode should be default or regex',
  );
  assert(
    typeof value.allow_multiple === 'boolean',
    'allow_multiple should be boolean',
  );
  assertNonNegativeInteger(value.matched_targets, 'matched_targets');
  assertNonNegativeInteger(value.replacement_count, 'replacement_count');
  assertNonNegativeInteger(
    value.replacement_line_count,
    'replacement_line_count',
  );

  if (value.matched_span !== null) {
    assert(isRecord(value.matched_span), 'matched_span should be object or null');
    assertDeepEqual(
      Object.keys(value.matched_span).sort(),
      ['end_line', 'start_line'],
      'matched_span should contain only start_line and end_line',
    );
    assertPositiveInteger(value.matched_span.start_line, 'matched_span.start_line');
    assertPositiveInteger(value.matched_span.end_line, 'matched_span.end_line');
  }

  assert(isRecord(value.file_line_count), 'file_line_count should be object');
  assertDeepEqual(
    Object.keys(value.file_line_count).sort(),
    ['current', 'previous'],
    'file_line_count should contain only previous and current',
  );
  assertNonNegativeInteger(
    value.file_line_count.previous,
    'file_line_count.previous',
  );
  assertNonNegativeInteger(
    value.file_line_count.current,
    'file_line_count.current',
  );

  if ('note' in value) {
    assert(typeof value.note === 'string', 'note should be string when present');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonNegativeInteger(value: unknown, fieldName: string): void {
  assert(
    Number.isInteger(value) && typeof value === 'number' && value >= 0,
    `${fieldName} should be a non-negative integer`,
  );
}

function assertPositiveInteger(value: unknown, fieldName: string): void {
  assert(
    Number.isInteger(value) && typeof value === 'number' && value >= 1,
    `${fieldName} should be a positive integer`,
  );
}
