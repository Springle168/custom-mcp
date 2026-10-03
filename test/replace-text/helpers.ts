import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LineEnding } from '../../src/config.js';
import type { ToolRuntimeContext } from '../../src/runtime/invocation/tool-context.js';
import replaceTool from '../../src/tools/built-in/files/replace.js';
import type { MCPTool, ToolCallResult } from '../../src/tools/types.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import { assert, assertEqual, assertIncludes, getResultText } from '../test-utils.js';

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

export interface ReplaceTextReplacementJson {
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

export interface ReplaceTextFileJson {
  success: boolean;
  file_path: string;
  match_mode: 'default' | 'regex';
  allow_multiple: boolean;
  replacements: ReplaceTextReplacementJson[];
}

export interface ReplaceTextBatchJson {
  success: boolean;
  files: ReplaceTextFileJson[];
}

export type ReplaceTextV2Json = ReplaceTextReplacementJson & {
  file_path: string;
  match_mode: 'default' | 'regex';
  allow_multiple: boolean;
};

export interface SingleReplaceArgs {
  file_path: string;
  target: string;
  replacement: string;
  allow_multiple?: boolean;
  match_mode?: 'default' | 'regex';
  regex_flags?: string;
}

export function singleReplaceBatch(args: SingleReplaceArgs): Record<string, unknown> {
  const { file_path, target, replacement, allow_multiple, match_mode, regex_flags } = args;
  return {
    files: [
      {
        file_path,
        ...(allow_multiple === undefined ? {} : { allow_multiple }),
        ...(match_mode === undefined ? {} : { match_mode }),
        ...(regex_flags === undefined ? {} : { regex_flags }),
        replacements: [{ target, replacement }],
      },
    ],
  };
}

export function createReplaceTextFixtureHarness(suiteName: string) {
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suiteName), 'Fixture suite name should use kebab-case');

  const fixturesDir = path.join(FIXTURES_ROOT, suiteName);

  function createTestToolContext(lineEnding: LineEnding = 'auto'): ToolRuntimeContext {
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

  async function writeFixture(relativePath: string, content: string | Uint8Array): Promise<string> {
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

  async function callWithHandler(
    handler: MCPTool['handler'],
    args: Record<string, unknown>,
    context: ToolRuntimeContext = createTestToolContext(),
  ): Promise<ToolCallResult> {
    return handler(args, context, createTestToolInvocationContext());
  }

  async function callReplace(
    args: SingleReplaceArgs,
    context: ToolRuntimeContext = createTestToolContext(),
  ): Promise<ToolCallResult> {
    return callWithHandler(replaceTool.handler, singleReplaceBatch(args), context);
  }

  async function callReplaceBatch(
    args: Record<string, unknown>,
    context: ToolRuntimeContext = createTestToolContext(),
  ): Promise<ToolCallResult> {
    return callWithHandler(replaceTool.handler, args, context);
  }

  async function assertFixtureContent(
    relativePath: string,
    expected: string,
    message: string,
  ): Promise<void> {
    const actual = await readFixture(relativePath);
    assertEqual(actual, expected, message);
  }

  async function assertFixtureMissing(relativePath: string, message: string): Promise<void> {
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
    callWithHandler,
    callReplace,
    callReplaceBatch,
    assertFixtureContent,
    assertFixtureMissing,
  };
}

export function parseResultJson(result: ToolCallResult): ReplaceTextBatchJson {
  assertEnvelope(result);

  const text = getResultText(result);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Expected content[0].text to be batch JSON, but parsing failed: ${String(error)}\nText: ${text}`,
    );
  }

  assertBatchResultShape(parsed);
  return parsed;
}

function onlyResult(batch: ReplaceTextBatchJson): ReplaceTextV2Json {
  assertEqual(batch.files.length, 1, 'Expected exactly one file result');
  const file = batch.files[0];
  assert(file !== undefined, 'Expected one file result');
  assertEqual(file.replacements.length, 1, 'Expected exactly one replacement result');
  const replacement = file.replacements[0];
  assert(replacement !== undefined, 'Expected one replacement result');
  return {
    ...replacement,
    file_path: file.file_path,
    match_mode: file.match_mode,
    allow_multiple: file.allow_multiple,
  };
}

export function assertSuccessResult(result: ToolCallResult): ReplaceTextV2Json {
  assertEqual(result.isError, false, 'Success result should set isError: false');
  const batch = parseResultJson(result);
  assertEqual(batch.success, true, 'Batch JSON success should be true');
  const json = onlyResult(batch);
  assertEqual(json.success, true, 'Replacement JSON success should be true');
  return json;
}

export function assertErrorResult(result: ToolCallResult): ReplaceTextV2Json {
  assertEqual(result.isError, true, 'Failure result should set isError: true');
  const batch = parseResultJson(result);
  assertEqual(batch.success, false, 'Batch JSON success should be false');
  const json = onlyResult(batch);
  assertEqual(json.success, false, 'Replacement JSON success should be false');
  assert(typeof json.note === 'string', 'Failure JSON should include note');
  return json;
}

export function assertSpan(
  json: ReplaceTextReplacementJson,
  startLine: number,
  endLine: number,
  message: string,
): void {
  assert(json.matched_span !== null, `${message}: expected matched_span`);
  assertEqual(json.matched_span.start_line, startLine, `${message}: start_line`);
  assertEqual(json.matched_span.end_line, endLine, `${message}: end_line`);
}

export function assertNoSpan(json: ReplaceTextReplacementJson, message: string): void {
  assertEqual(json.matched_span, null, message);
}

export function assertJsonNoteIncludes(
  json: ReplaceTextReplacementJson,
  substring: string,
  message: string,
): void {
  assertIncludes(json.note, substring, message);
}

export function assertJsonDefaults(json: ReplaceTextReplacementJson): void {
  assertEqual(json.matched_targets, 0, 'Default matched_targets');
  assertEqual(json.replacement_count, 0, 'Default replacement_count');
  assertNoSpan(json, 'Default matched_span');
  assertEqual(json.file_line_count.previous, null, 'Unknown previous line count');
  assertEqual(json.file_line_count.current, null, 'Unknown current line count');
}

export function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  assertEqual(actualText, expectedText, message);
}

export function countSpecLines(text: string): number {
  const normalized = text.replace(/\r\n/g, '\n');
  return normalized === '' ? 0 : normalized.split('\n').length;
}

function assertEnvelope(result: ToolCallResult): void {
  assert(Array.isArray(result.content), 'Result should contain MCP content array');
  assertEqual(result.content.length, 1, 'Result should have one content item');
  const firstContent = result.content[0];
  assert(firstContent?.type === 'text', 'Result content type should be text');
  assert(typeof firstContent.text === 'string', 'Result content text should be a string');
  assert(typeof result.isError === 'boolean', 'Result should include explicit isError boolean');
  assert(!('structuredContent' in result), 'replace_text should not return structuredContent');
}

function assertBatchResultShape(value: unknown): asserts value is ReplaceTextBatchJson {
  assert(isRecord(value), 'Parsed JSON should be an object');
  assertDeepEqual(
    Object.keys(value).sort(),
    ['files', 'success'],
    'Batch result should contain only success and files',
  );
  assert(typeof value.success === 'boolean', 'Batch success should be boolean');
  assert(Array.isArray(value.files), 'Batch files should be an array');
  for (const file of value.files) assertFileResultShape(file);
}

function assertFileResultShape(value: unknown): asserts value is ReplaceTextFileJson {
  assert(isRecord(value), 'File result should be an object');
  assertDeepEqual(
    Object.keys(value).sort(),
    ['allow_multiple', 'file_path', 'match_mode', 'replacements', 'success'],
    'File result should contain only declared fields',
  );
  assert(typeof value.success === 'boolean', 'File success should be boolean');
  assert(typeof value.file_path === 'string', 'file_path should be string');
  assert(
    value.match_mode === 'default' || value.match_mode === 'regex',
    'match_mode should be default or regex',
  );
  assert(typeof value.allow_multiple === 'boolean', 'allow_multiple should be boolean');
  assert(Array.isArray(value.replacements), 'replacements should be an array');
  for (const replacement of value.replacements) {
    assertReplacementResultShape(replacement);
  }
}

function assertReplacementResultShape(value: unknown): asserts value is ReplaceTextReplacementJson {
  assert(isRecord(value), 'Replacement result should be an object');

  const requiredKeys = [
    'success',
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
    'Replacement result should not contain undeclared fields',
  );

  for (const key of requiredKeys) {
    assert(key in value, `Replacement result should include ${key}`);
  }

  assert(typeof value.success === 'boolean', 'success should be boolean');
  assertNonNegativeInteger(value.matched_targets, 'matched_targets');
  assertNonNegativeInteger(value.replacement_count, 'replacement_count');
  assertNonNegativeInteger(value.replacement_line_count, 'replacement_line_count');

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
  assertNullableNonNegativeInteger(value.file_line_count.previous, 'file_line_count.previous');
  assertNullableNonNegativeInteger(value.file_line_count.current, 'file_line_count.current');

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

function assertNullableNonNegativeInteger(value: unknown, fieldName: string): void {
  if (value === null) return;
  assertNonNegativeInteger(value, fieldName);
}

function assertPositiveInteger(value: unknown, fieldName: string): void {
  assert(
    Number.isInteger(value) && typeof value === 'number' && value >= 1,
    `${fieldName} should be a positive integer`,
  );
}
