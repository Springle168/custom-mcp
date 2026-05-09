// test/test-read-file.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
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

function getResultText(result: any): string {
  return result.content[0].text;
}

async function testReadFullFile() {
  console.log('Test: Read full text file');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt' },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'Read 15 of 15 line(s) from src\\Foo.kt.', 'Should report line count');
  assertIncludes(text, 'No truncation: all returned file content is complete.', 'Should report no truncation');
  assertIncludes(text, 'data class Foo', 'Should include file content');

  console.log('  ✓ Passed\n');
}

async function testReadLineRange() {
  console.log('Test: Read targeted line range');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt', start_line: 6, end_line: 8 },
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'Read 3 of 15 line(s) from src\\Foo.kt.', 'Should report selected line count');
  assertIncludes(text, 'IMPORTANT: The file content has been truncated.', 'Should explain partial range');
  assertIncludes(text, 'Showing lines 6-8 of 15 total lines', 'Should report selected range');
  assertIncludes(text, 'data class Foo(', 'Should include start line');
  assertIncludes(text, '    val name: String', 'Should include end line');
  assertNotIncludes(text, 'package com.example.demo', 'Should omit lines before range');

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

async function testInvalidRange() {
  console.log('Test: Reject invalid line range');

  const result = await readFileTool.handler(
    { file_path: 'src/Foo.kt', start_line: 10, end_line: 5 },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  assertIncludes(getResultText(result), 'start_line cannot be greater than end_line', 'Should explain invalid range');

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

async function testLongLineWithLineNumbersStaysWithinLimit() {
  console.log('Test: Long line with line numbers stays within limit');

  const fileName = 'long-line.tmp.txt';
  const filePath = path.join(FIXTURES_DIR, fileName);
  await fs.writeFile(filePath, 'x'.repeat(2010), 'utf-8');

  try {
    const result = await readFileTool.handler(
      { file_path: fileName, show_line_numbers: true },
      testConfig,
    );

    assert(result.isError !== true, 'Should succeed');
    const text = getResultText(result);
    const contentLine = text.split('\n').at(-1) ?? '';

    assertIncludes(text, 'Some returned lines were shortened to 2000 characters', 'Should explain long-line truncation');
    assertNotIncludes(text, 'Use start_line and end_line', 'Should not suggest line ranges for long-line-only truncation');
    assert(contentLine.startsWith('1: '), 'Should include line number prefix');
    assert(contentLine.length <= 2000, 'Returned content line should stay within 2000 characters');
  } finally {
    await fs.rm(filePath, { force: true });
  }

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
  console.log('='.repeat(60));
  console.log('Testing read_file tool');
  console.log('='.repeat(60));
  console.log(`Fixtures directory: ${FIXTURES_DIR}\n`);

  const tests = [
    testReadFullFile,
    testReadLineRange,
    testShowLineNumbers,
    testInvalidRange,
    testStartLineBeyondEof,
    testLongLineWithLineNumbersStaysWithinLimit,
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

  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
