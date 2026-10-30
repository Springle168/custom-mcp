import { assertEqual, runTestSuite } from '../test-utils.js';
import { assertSuccessResult, countSpecLines, createReplaceTextFixtureHarness } from './helpers.js';

const {
  assertFixtureContent,
  callReplace,
  cleanupFixtures,
  createTestToolContext,
  resetFixtures,
  writeFixture,
} = createReplaceTextFixtureHarness('trailing-newline');

const cases = [
  {
    name: 'preserve-unmatched-newline',
    original: 'hello\n',
    target: 'hello',
    replacement: 'world',
    expected: 'world\n',
  },
  {
    name: 'remove-only-trailing-newline',
    original: 'hello\n',
    target: 'hello\n',
    replacement: 'hello',
    expected: 'hello',
  },
  {
    name: 'add-only-trailing-newline',
    original: 'hello',
    target: 'hello',
    replacement: 'hello\n',
    expected: 'hello\n',
  },
  {
    name: 'add-multiple-trailing-newlines',
    original: 'hello',
    target: 'hello',
    replacement: 'hello\n\n',
    expected: 'hello\n\n',
  },
  {
    name: 'keep-replacement-and-unmatched-newlines',
    original: 'hello\n',
    target: 'hello',
    replacement: 'world\n',
    expected: 'world\n\n',
  },
  {
    name: 'remove-multiple-trailing-newlines',
    original: 'hello\n\n',
    target: 'hello\n\n',
    replacement: 'hello',
    expected: 'hello',
  },
  {
    name: 'empty-newline-only-file',
    original: '\n',
    target: '\n',
    replacement: '',
    expected: '',
  },
  {
    name: 'delete-all-content',
    original: 'hello\n',
    target: 'hello\n',
    replacement: '',
    expected: '',
  },
  {
    name: 'keep-unmatched-suffix-without-trailing-newline',
    original: 'before\nafter',
    target: 'before',
    replacement: 'BEFORE\n',
    expected: 'BEFORE\n\nafter',
  },
  {
    name: 'keep-absent-trailing-newline',
    original: 'hello',
    target: 'hello',
    replacement: 'world',
    expected: 'world',
  },
];

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text trailing newline semantics',
    beforeAll: resetFixtures,
    afterAll: cleanupFixtures,
    tests: (['default', 'regex'] as const).flatMap((matchMode) =>
      (['auto', 'lf', 'crlf'] as const).flatMap((lineEnding) =>
        cases.map((testCase) => ({
          name: `${matchMode}/${lineEnding}: ${testCase.name}`,
          run: async () => {
            const filePath = `${matchMode}-${lineEnding}-${testCase.name}.txt`;
            await writeFixture(filePath, testCase.original);

            const result = await callReplace(
              {
                file_path: filePath,
                target: testCase.target,
                replacement: testCase.replacement,
                match_mode: matchMode,
              },
              createTestToolContext(lineEnding),
            );

            const json = assertSuccessResult(result);
            assertEqual(json.matched_targets, 1, 'Should match the requested range once');
            assertEqual(json.replacement_count, 1, 'Should apply the requested change');
            assertEqual(
              json.file_line_count.previous,
              countSpecLines(testCase.original),
              'Previous line count',
            );
            assertEqual(
              json.file_line_count.current,
              countSpecLines(testCase.expected),
              'Current line count',
            );

            const expected =
              lineEnding === 'crlf' ? testCase.expected.replace(/\n/g, '\r\n') : testCase.expected;
            await assertFixtureContent(
              filePath,
              expected,
              'Only the matched range and configured line ending should change',
            );
          },
        })),
      ),
    ),
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
