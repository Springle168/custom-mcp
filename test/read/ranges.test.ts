import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assert, assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';
import { block, body, cleanupFixtures, FIXTURES_DIR, prepareFixtures, read } from './fixtures.js';

async function testLineRanges(): Promise<void> {
  const result = await read({
    include: [
      { file_path: 'a.txt', start_line: 2, end_line: 3 },
      { file_path: 'a.txt', start_line: 3, end_line: 99 },
      { file_path: 'a.txt', end_line: 1 },
      { file_path: 'a.txt', start_line: 4 },
    ],
    show_line_numbers: true,
  });
  assert(result.isError === false, 'Selected line ranges should succeed');
  assertEqual(body(result, 1), '2: beta\n3: gamma', 'Ranges retain original line numbers');
  assertEqual(
    body(result, 2),
    '3: gamma\n4: ',
    'End beyond EOF clips and retains trailing empty line',
  );
  assertEqual(body(result, 3), '1: alpha', 'Missing start defaults to the first line');
  assertEqual(body(result, 4), '4: ', 'The trailing empty line is readable');
  assertIncludes(block(result, 2), 'lines 3-4 of 4', 'Headers report the resolved range');
}

async function testRegexRanges(): Promise<void> {
  const result = await read({
    include: [
      { file_path: 'markers.txt', read_mode: 'regex', start_line: '^start$', end_line: '^end$' },
      { file_path: 'markers.txt', read_mode: 'regex', start_line: '^start$' },
      { file_path: 'markers.txt', read_mode: 'regex', end_line: '^end$' },
      { file_path: 'markers.txt', read_mode: 'regex', start_line: '^start$', end_line: '^start$' },
    ],
  });
  assert(result.isError === false, 'Regex ranges should succeed');
  assertEqual(
    body(result, 1),
    'start\nmiddle\nend',
    'End search begins at the resolved start, not the beginning of the file',
  );
  assertEqual(
    body(result, 2),
    'start\nmiddle\nend\nstart\nend',
    'Start-only regex reads through EOF',
  );
  assertEqual(body(result, 3), 'end', 'End-only regex searches from the first line');
  assertEqual(body(result, 4), 'start', 'End matching includes the starting line');
}

async function testIndependentSemanticFailures(): Promise<void> {
  const failures = [
    { start_line: '2' },
    { end_line: '3' },
    { read_mode: 'regex', start_line: 2 },
    { read_mode: 'regex', end_line: 3 },
    { start_line: 3, end_line: 2 },
    { start_line: 99 },
    { read_mode: 'regex', start_line: '[' },
    { read_mode: 'regex', end_line: '[' },
    { read_mode: 'regex', start_line: '^absent$' },
    { read_mode: 'regex', start_line: '^beta$', end_line: '^alpha$' },
    { read_mode: 'regex', start_line: 'alpha\\nbeta' },
  ];
  const result = await read({
    include: [
      'a.txt',
      ...failures.map((options) => ({ file_path: 'a.txt', ...options })),
      { file_path: 'a.txt', start_line: 2, end_line: 2 },
    ],
  });
  assert(result.isError === false, 'One valid fragment makes a mixed call successful');
  assertEqual(
    result.content.length,
    failures.length + 2,
    'Invalid fragments stay independent and suppress the default whole-file request',
  );
  for (let index = 0; index < failures.length; index++) {
    assertIncludes(
      block(result, index + 1),
      `include[${index + 1}]`,
      'Failure keeps the originating input index',
    );
    assertIncludes(block(result, index + 1), 'failed', 'Each semantic failure has a failure block');
  }
  assertEqual(
    body(result, failures.length + 1),
    'beta',
    'Failure does not damage a sibling fragment',
  );
  assertIncludes(
    block(result, 0),
    'Selected content: 1 lines, 4 bytes.',
    'Only successful fragments count',
  );

  const allFailed = await read({ include: [{ file_path: 'a.txt', start_line: 99 }] });
  assert(allFailed.isError === true, 'All local failures make the call an error');
  assertEqual(
    allFailed.content.length,
    2,
    'A normal all-failed read still has summary and request failure',
  );
}

async function testEmptyAndCrlf(): Promise<void> {
  const result = await read({ include: ['empty.txt', 'crlf.txt'] });
  assert(result.isError === false, 'Empty files are successful text');
  assertEqual(body(result, 1), '', 'Empty files return an empty body');
  assertIncludes(block(result, 1), 'lines 1-1 of 1', 'An empty file has one logical line');
  assertEqual(
    body(result, 2),
    '中文\n😀\n',
    'CRLF normalizes to LF and retains the final empty line',
  );
  assertIncludes(
    block(result, 0),
    'Selected content: 4 lines, 12 bytes.',
    'Statistics use normalized UTF-8 content',
  );
}

async function testCompleteLargeText(): Promise<void> {
  const text = Array.from({ length: 2105 }, (_, index) => `${index + 1}-${'界'.repeat(2100)}`).join(
    '\n',
  );
  await fs.writeFile(path.join(FIXTURES_DIR, 'large.txt'), text);
  const result = await read({ include: ['large.txt'] });
  assert(result.isError === false, 'Text below the size bound should succeed');
  assertEqual(body(result), text, 'Long lines and large line counts remain complete');
  assertIncludes(
    block(result, 0),
    `Selected content: 2105 lines, ${Buffer.byteLength(text)} bytes.`,
    'Statistics describe all returned text',
  );
}

async function testFileFailures(): Promise<void> {
  const largeFile = path.join(FIXTURES_DIR, 'oversized.txt');
  await fs.writeFile(largeFile, '');
  await fs.truncate(largeFile, 20 * 1024 * 1024 + 1);
  const result = await read({
    include: [
      'b.txt',
      'missing.txt',
      'nested',
      'fake.png',
      'binary.unknown',
      { file_path: 'oversized.txt', start_line: 1, end_line: 1 },
    ],
  });
  assert(
    result.isError === false,
    'Local filesystem/content failures preserve successful siblings',
  );
  assertEqual(result.content.length, 7, 'Every selected request has its own result');
  for (let index = 2; index <= 6; index++) {
    assertIncludes(
      block(result, index),
      'failed',
      'Missing files, directories, binaries, and oversize sources fail independently',
    );
  }
  assertIncludes(block(result, 4), 'binary', 'Non-text bytes are rejected regardless of suffix');
  assertIncludes(block(result, 5), 'binary', 'Unknown extensions use the same content rules');
  assertIncludes(block(result, 6), '20', 'A tiny range cannot bypass the source size bound');
}

await runTestSuite({
  title: 'Testing read ranges and text boundaries',
  beforeAll: prepareFixtures,
  afterAll: cleanupFixtures,
  tests: [
    { name: 'line ranges, clipping, and original line numbers', run: testLineRanges },
    { name: 'regex ranges select inclusive per-line matches', run: testRegexRanges },
    {
      name: 'semantic failures isolate fragments without restoring defaults',
      run: testIndependentSemanticFailures,
    },
    { name: 'empty files, CRLF, and trailing empty lines', run: testEmptyAndCrlf },
    { name: 'large text returns every line and character', run: testCompleteLargeText },
    { name: 'filesystem and content failures are per request', run: testFileFailures },
  ],
});
