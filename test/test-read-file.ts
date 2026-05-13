// test/test-read-file.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import type { ToolCallResult } from '../src/tools/types.js';
import readFileTool from '../src/tools/read-file.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'read-many-files');

const testConfig: Config = {
  rootDir: FIXTURES_DIR,
  lineEnding: 'auto',
  port: 3100,
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertIncludes(text: string, substring: string, message: string): void {
  if (!text.includes(substring)) {
    throw new Error(`Assertion failed: ${message}\nExpected to find: "${substring}"\nIn text: ${text.substring(0, 200)}...`);
  }
}

function assertNotIncludes(text: string, substring: string, message: string): void {
  if (text.includes(substring)) {
    throw new Error(`Assertion failed: ${message}\nDid not expect to find: "${substring}"`);
  }
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message}\nExpected: ${expected}\nActual: ${actual}`);
  }
}

function getResultText(result: ToolCallResult): string {
  return result.content[0]?.text ?? '';
}

function getReturnedContent(text: string): string {
  const separatorMatch = text.match(/\n\n--- .+ ---\n\n/);
  if (separatorMatch?.index === undefined) {
    throw new Error('Could not find read_file content separator');
  }

  const contentStart = separatorMatch.index + separatorMatch[0].length;
  const contentEnd = text.lastIndexOf('\n\n--- End of content ---');
  if (contentEnd < contentStart) {
    throw new Error('Could not find read_file content terminator');
  }

  return text.slice(contentStart, contentEnd);
}

async function withTempTextFile(
  fileName: string,
  content: string,
  run: (fileName: string, filePath: string) => Promise<void>,
): Promise<void> {
  const filePath = path.join(FIXTURES_DIR, fileName);
  await fs.writeFile(filePath, content, 'utf-8');

  try {
    await run(fileName, filePath);
  } finally {
    await fs.rm(filePath, { force: true });
  }
}

async function testReadFullFile() {
  console.log('Test: line mode reads full text file');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt' },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'Read 15 of 15 line(s) from src\\Foo.kt.', 'Should report line count');
  assertIncludes(text, 'No truncation: all returned file content is complete.', 'Should report no truncation');
  assertIncludes(text, '--- src\\Foo.kt ---', 'Should separate summary from content');
  assertIncludes(text, '--- End of content ---', 'Should terminate content block');
  assertIncludes(text, 'data class Foo', 'Should include file content');
  assertNotIncludes(text, 'IMPORTANT: The file content has been truncated.', 'Should not report truncation');

  console.log('  ✓ Passed\n');
}

async function testReadLineRange() {
  console.log('Test: line mode reads targeted line range');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt', start_line: 6, end_line: 8 },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'Read 3 of 15 line(s) from src\\Foo.kt.', 'Should report selected line count');
  assertIncludes(text, 'Partial read: showing lines 6-8 of 15 total lines.', 'Should report partial range');
  assertNotIncludes(text, 'IMPORTANT: The file content has been truncated.', 'Should not call a range read truncation');
  assertIncludes(text, 'data class Foo(', 'Should include start line');
  assertIncludes(text, '    val name: String', 'Should include end line');
  assertNotIncludes(text, 'package com.example.demo', 'Should omit lines before range');

  console.log('  ✓ Passed\n');
}

async function testEndLineBeyondEofClipsToEof() {
  console.log('Test: line mode clips end_line beyond EOF');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt', start_line: 13, end_line: 999 },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'Read 3 of 15 line(s) from src\\Foo.kt.', 'Should report clipped line count');
  assertIncludes(text, 'Partial read: showing lines 13-15 of 15 total lines.', 'Should report clipped range');
  assertIncludes(text, '}', 'Should include EOF content');
  assertNotIncludes(text, 'truncated', 'Should not call clipped end_line truncation');

  console.log('  ✓ Passed\n');
}

async function testShowLineNumbers() {
  console.log('Test: show_line_numbers prefixes original line numbers');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt', start_line: 6, end_line: 8, show_line_numbers: true },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, '6: data class Foo(', 'Should prefix first selected line');
  assertIncludes(text, '8:     val name: String', 'Should preserve original line numbers');

  console.log('  ✓ Passed\n');
}

async function testLargeFileReadsAllLines() {
  console.log('Test: line mode reads more than 2000 lines');

  const content = Array.from({ length: 2105 }, (_, index) => `line-${index + 1}`).join('\n');

  await withTempTextFile('large-read-file-v2.tmp.txt', content, async (fileName) => {
    const result = await readFileTool.handler(
      { file_path: fileName },
      testConfig,
    );

    assert(result.isError !== true, 'Should succeed');
    const text = getResultText(result);

    assertIncludes(text, `Read 2105 of 2105 line(s) from ${fileName}.`, 'Should report all lines');
    assertIncludes(text, 'No truncation: all returned file content is complete.', 'Should report complete read');
    assertIncludes(text, 'line-2105', 'Should include final line beyond old limit');
    assertNotIncludes(text, 'IMPORTANT: The file content has been truncated.', 'Should not report line truncation');
  });

  console.log('  ✓ Passed\n');
}

async function testLongLineIsNotShortened() {
  console.log('Test: line mode reads more than 2000 characters in one line');

  const longLine = 'x'.repeat(2010);

  await withTempTextFile('long-line-read-file-v2.tmp.txt', longLine, async (fileName) => {
    const result = await readFileTool.handler(
      { file_path: fileName },
      testConfig,
    );

    assert(result.isError !== true, 'Should succeed');
    const text = getResultText(result);
    const contentLine = getReturnedContent(text);

    assertEquals(contentLine.length, 2010, 'Returned content line should not be shortened');
    assertEquals(contentLine, longLine, 'Returned content line should be complete');
    assertNotIncludes(text, '[truncated]', 'Should not add long-line truncation marker');
    assertNotIncludes(text, 'Some returned lines were shortened', 'Should not explain long-line truncation');
  });

  console.log('  ✓ Passed\n');
}

async function testRegexRange() {
  console.log('Test: regex mode locates start and end lines');

  const result = await readFileTool.handler(
    {
      file_path: 'src/Foo.kt',
      read_mode: 'regex',
      start_line: 'data class Foo\\(',
      end_line: '^\\)',
      show_line_numbers: true,
    },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'Read 5 of 15 line(s) from src\\Foo.kt.', 'Should report regex-selected line count');
  assertIncludes(text, 'Partial read: showing lines 6-10 of 15 total lines.', 'Should report resolved line range');
  assertIncludes(text, '6: data class Foo(', 'Should include resolved start line');
  assertIncludes(text, '10: ) {', 'Should include resolved end line');
  assertNotIncludes(text, '11:     fun isValid()', 'Should stop at regex end line');
  assertNotIncludes(text, 'truncated', 'Should not call regex range truncation');

  console.log('  ✓ Passed\n');
}

async function testRegexStartOnlyReadsToEof() {
  console.log('Test: regex mode start_line reads to EOF');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt', read_mode: 'regex', start_line: 'fun isValid' },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'Read 5 of 15 line(s) from src\\Foo.kt.', 'Should read from regex match to EOF');
  assertIncludes(text, 'Partial read: showing lines 11-15 of 15 total lines.', 'Should report start-to-EOF range');
  assertIncludes(text, 'fun isValid(): Boolean', 'Should include matched start line');
  assertNotIncludes(text, 'data class Foo(', 'Should omit lines before regex start');

  console.log('  ✓ Passed\n');
}

async function testRegexInvalidPattern() {
  console.log('Test: regex mode rejects invalid pattern');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt', read_mode: 'regex', start_line: '[' },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  const text = getResultText(result);

  assertIncludes(text, 'Invalid start_line regex pattern:', 'Should explain invalid regex');
  assertIncludes(text, 'Check the pattern syntax', 'Should suggest a corrective action');

  console.log('  ✓ Passed\n');
}

async function testRegexStartNoMatch() {
  console.log('Test: regex mode reports unmatched start pattern');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt', read_mode: 'regex', start_line: 'NoSuchSymbol' },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  const text = getResultText(result);

  assertIncludes(text, 'start_line regex pattern did not match any line', 'Should explain unmatched start pattern');
  assertIncludes(text, 'Check the pattern', 'Should suggest checking the pattern');

  console.log('  ✓ Passed\n');
}

async function testRegexEndNoMatch() {
  console.log('Test: regex mode reports unmatched end pattern');

  const result = await readFileTool.handler(
    {
      file_path: 'src/Foo.kt',
      read_mode: 'regex',
      start_line: 'data class Foo',
      end_line: 'NoSuchSymbol',
    },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  const text = getResultText(result);

  assertIncludes(text, 'end_line regex pattern did not match any line at or after the resolved start line', 'Should explain unmatched end pattern');
  assertIncludes(text, 'Check the pattern', 'Should suggest checking the pattern');

  console.log('  ✓ Passed\n');
}

async function testModeSpecificRangeTypes() {
  console.log('Test: read modes reject wrong range value types');

  const lineModeResult = await readFileTool.handler(
    { file_path: 'src/Foo.kt', read_mode: 'line', start_line: '6' },
    testConfig,
  );

  assert(lineModeResult.isError === true, 'Line mode should reject string start_line');
  assertIncludes(
    getResultText(lineModeResult),
    'In read_mode="line", start_line must be a positive integer (JSON number).',
    'Should explain line mode start_line type requirement',
  );

  const lineModeEndResult = await readFileTool.handler(
    { file_path: 'src/Foo.kt', read_mode: 'line', end_line: '8' },
    testConfig,
  );

  assert(lineModeEndResult.isError === true, 'Line mode should reject string end_line');
  assertIncludes(
    getResultText(lineModeEndResult),
    'In read_mode="line", end_line must be a positive integer (JSON number).',
    'Should explain line mode end_line type requirement',
  );

  const regexModeResult = await readFileTool.handler(
    { file_path: 'src/Foo.kt', read_mode: 'regex', start_line: 6 },
    testConfig,
  );

  assert(regexModeResult.isError === true, 'Regex mode should reject numeric start_line');
  assertIncludes(
    getResultText(regexModeResult),
    'In read_mode="regex", start_line must be a non-empty regex pattern string.',
    'Should explain regex mode type requirement',
  );

  console.log('  ✓ Passed\n');
}

async function testInvalidReadMode() {
  console.log('Test: Reject invalid read_mode');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt', read_mode: 'keyword' },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  assertIncludes(getResultText(result), "The 'read_mode' parameter must be either 'line' or 'regex'.", 'Should explain valid modes');

  console.log('  ✓ Passed\n');
}

async function testInvalidRange() {
  console.log('Test: Reject invalid line range');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt', start_line: 10, end_line: 5 },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  assertIncludes(
    getResultText(result),
    'start_line 10 cannot be greater than end_line 5.',
    'Should explain invalid range with actual values',
  );

  console.log('  ✓ Passed\n');
}

async function testStartLineBeyondEof() {
  console.log('Test: Reject start_line beyond EOF');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt', start_line: 999 },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  assertIncludes(getResultText(result), 'start_line 999 exceeds file line count (15)', 'Should explain EOF range');

  console.log('  ✓ Passed\n');
}

async function testBinaryFileRejected() {
  console.log('Test: Reject binary file');

  const result = await readFileTool.handler(
    { file_path: 'binary/fake.png' },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  assertIncludes(getResultText(result), 'Cannot display content of binary file', 'Should explain binary rejection');

  console.log('  ✓ Passed\n');
}

async function main() {
  console.log('='.repeat(24));
  console.log('Testing read_file tool');
  console.log('='.repeat(24));
  console.log(`Fixtures directory: ${FIXTURES_DIR}\n`);

  const tests = [
    testReadFullFile,
    testReadLineRange,
    testEndLineBeyondEofClipsToEof,
    testShowLineNumbers,
    testLargeFileReadsAllLines,
    testLongLineIsNotShortened,
    testRegexRange,
    testRegexStartOnlyReadsToEof,
    testRegexInvalidPattern,
    testRegexStartNoMatch,
    testRegexEndNoMatch,
    testModeSpecificRangeTypes,
    testInvalidReadMode,
    testInvalidRange,
    testStartLineBeyondEof,
    testBinaryFileRejected,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      failed++;
      console.error(`  ✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  console.log('='.repeat(24));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(24));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
