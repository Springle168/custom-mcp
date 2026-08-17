import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';
import {
  assertSpan,
  assertSuccessResult,
  createReplaceTextFixtureHarness,
} from './helpers.js';

const {
  assertFixtureContent,
  callReplace,
  cleanupFixtures,
  createTestToolContext,
  readFixture,
  resetFixtures,
  writeFixture,
} = createReplaceTextFixtureHarness('line-ending-concurrency');

async function testAutoPreservesExistingLf(): Promise<void> {
  await resetFixtures();
  await writeFixture('auto-lf.txt', 'alpha\nbeta\n');

  const result = await callReplace(
    {
      file_path: 'auto-lf.txt',
      target: 'alpha',
      replacement: 'ALPHA',
    },
    createTestToolContext('auto'),
  );

  const json = assertSuccessResult(result);
  assertEqual(json.file_line_count.previous, 3, 'LF previous line count');
  assertEqual(json.file_line_count.current, 3, 'LF current line count');
  await assertFixtureContent(
    'auto-lf.txt',
    'ALPHA\nbeta\n',
    'lineEnding=auto should preserve LF files as LF',
  );
}

async function testAutoPreservesExistingCrlf(): Promise<void> {
  await resetFixtures();
  await writeFixture('auto-crlf.txt', 'alpha\r\nbeta\r\n');

  const result = await callReplace(
    {
      file_path: 'auto-crlf.txt',
      target: 'alpha',
      replacement: 'ALPHA',
    },
    createTestToolContext('auto'),
  );

  const json = assertSuccessResult(result);
  assertEqual(json.file_line_count.previous, 3, 'CRLF previous line count uses normalized LF');
  assertEqual(json.file_line_count.current, 3, 'CRLF current line count uses normalized LF');
  await assertFixtureContent(
    'auto-crlf.txt',
    'ALPHA\r\nbeta\r\n',
    'lineEnding=auto should preserve CRLF files as CRLF',
  );
}

async function testAutoNewFileUsesLf(): Promise<void> {
  await resetFixtures();

  const result = await callReplace(
    {
      file_path: 'auto-new-file.txt',
      target: '',
      replacement: 'alpha\nbeta\n',
      match_mode: 'default',
    },
    createTestToolContext('auto'),
  );

  const json = assertSuccessResult(result);
  assertEqual(json.file_line_count.previous, 0, 'New file previous line count');
  assertEqual(json.file_line_count.current, 3, 'New file current line count');
  await assertFixtureContent(
    'auto-new-file.txt',
    'alpha\nbeta\n',
    'lineEnding=auto should write new files as LF',
  );
}

async function testLfConfigConvertsExistingCrlfToLf(): Promise<void> {
  await resetFixtures();
  await writeFixture('force-lf.txt', 'alpha\r\nbeta\r\n');

  const result = await callReplace(
    {
      file_path: 'force-lf.txt',
      target: 'alpha',
      replacement: 'ALPHA',
    },
    createTestToolContext('lf'),
  );

  assertSuccessResult(result);
  await assertFixtureContent(
    'force-lf.txt',
    'ALPHA\nbeta\n',
    'lineEnding=lf should convert existing CRLF files to LF',
  );
}

async function testCrlfConfigConvertsExistingLfToCrlf(): Promise<void> {
  await resetFixtures();
  await writeFixture('force-crlf.txt', 'alpha\nbeta\n');

  const result = await callReplace(
    {
      file_path: 'force-crlf.txt',
      target: 'alpha',
      replacement: 'ALPHA',
    },
    createTestToolContext('crlf'),
  );

  assertSuccessResult(result);
  await assertFixtureContent(
    'force-crlf.txt',
    'ALPHA\r\nbeta\r\n',
    'lineEnding=crlf should convert existing LF files to CRLF',
  );
}

async function testRegexCrossLineUsesNormalizedLfForCrlfFile(): Promise<void> {
  await resetFixtures();
  await writeFixture('regex-normalized-crlf.txt', 'before\r\nstart\r\nmiddle\r\nend\r\nafter\r\n');

  const result = await callReplace(
    {
      file_path: 'regex-normalized-crlf.txt',
      target: 'start\nmiddle\nend',
      replacement: 'done',
      match_mode: 'regex',
    },
    createTestToolContext('auto'),
  );

  const json = assertSuccessResult(result);
  assertSpan(json, 2, 4, 'Regex CRLF normalized LF span');
  assertEqual(json.file_line_count.previous, 6, 'Previous count normalizes CRLF');
  assertEqual(json.file_line_count.current, 4, 'Current count normalizes CRLF');
  await assertFixtureContent(
    'regex-normalized-crlf.txt',
    'before\r\ndone\r\nafter\r\n',
    'Regex pattern should use LF while auto writeback preserves CRLF',
  );
}

async function testSpanAndCountsIgnorePhysicalCrlfWidth(): Promise<void> {
  await resetFixtures();
  await writeFixture('crlf-span.txt', 'one\r\ntwo\r\nthree\r\n');

  const result = await callReplace(
    {
      file_path: 'crlf-span.txt',
      target: 'two\nthree',
      replacement: 'TWO\nTHREE',
    },
    createTestToolContext('crlf'),
  );

  const json = assertSuccessResult(result);
  assertSpan(json, 2, 3, 'CRLF span should use normalized LF offsets');
  assertEqual(json.file_line_count.previous, 4, 'Previous line count should normalize CRLF');
  assertEqual(json.file_line_count.current, 4, 'Current line count should normalize CRLF');
  await assertFixtureContent(
    'crlf-span.txt',
    'one\r\nTWO\r\nTHREE\r\n',
    'Configured CRLF writeback should not affect reported span/counts',
  );
}

async function testConcurrentSameFileReplacementsDoNotLoseUpdates(): Promise<void> {
  await resetFixtures();
  await writeFixture('concurrent-same.txt', 'alpha beta gamma\n');

  const [alphaResult, betaResult] = await Promise.all([
    callReplace({
      file_path: 'concurrent-same.txt',
      target: 'alpha',
      replacement: 'ALPHA',
    }),
    callReplace({
      file_path: 'concurrent-same.txt',
      target: 'beta',
      replacement: 'BETA',
    }),
  ]);

  assertSuccessResult(alphaResult);
  assertSuccessResult(betaResult);
  const content = await readFixture('concurrent-same.txt');
  assert(
    content === 'ALPHA BETA gamma\n',
    `Concurrent same-file replacements should not lose updates. Actual: ${content}`,
  );
}

async function testConcurrentDifferentFilesSucceedIndependently(): Promise<void> {
  await resetFixtures();
  await writeFixture('concurrent-a.txt', 'alpha\n');
  await writeFixture('concurrent-b.txt', 'beta\n');

  const [alphaResult, betaResult] = await Promise.all([
    callReplace({
      file_path: 'concurrent-a.txt',
      target: 'alpha',
      replacement: 'ALPHA',
    }),
    callReplace({
      file_path: 'concurrent-b.txt',
      target: 'beta',
      replacement: 'BETA',
    }),
  ]);

  assertSuccessResult(alphaResult);
  assertSuccessResult(betaResult);
  await assertFixtureContent(
    'concurrent-a.txt',
    'ALPHA\n',
    'Concurrent replacement on first file should succeed',
  );
  await assertFixtureContent(
    'concurrent-b.txt',
    'BETA\n',
    'Concurrent replacement on second file should succeed',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text v2 line ending and concurrency tests',
    details: 'Covers lineEnding auto/lf/crlf, normalized LF spans/counts, regex CRLF matching, and file lock regressions.',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'auto preserves existing LF', run: testAutoPreservesExistingLf },
      { name: 'auto preserves existing CRLF', run: testAutoPreservesExistingCrlf },
      { name: 'auto writes new files as LF', run: testAutoNewFileUsesLf },
      { name: 'lf converts existing CRLF to LF', run: testLfConfigConvertsExistingCrlfToLf },
      { name: 'crlf converts existing LF to CRLF', run: testCrlfConfigConvertsExistingLfToCrlf },
      {
        name: 'regex cross-line match uses normalized LF for CRLF files',
        run: testRegexCrossLineUsesNormalizedLfForCrlfFile,
      },
      {
        name: 'span and counts ignore physical CRLF width',
        run: testSpanAndCountsIgnorePhysicalCrlfWidth,
      },
      {
        name: 'concurrent same-file replacements do not lose updates',
        run: testConcurrentSameFileReplacementsDoNotLoseUpdates,
      },
      {
        name: 'concurrent different-file replacements succeed independently',
        run: testConcurrentDifferentFilesSucceedIndependently,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
