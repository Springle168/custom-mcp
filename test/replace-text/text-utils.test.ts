import { detectLineEnding, resolveLineEnding } from '../../src/engine/text-utils.js';
import { assertEqual, runTestSuite } from '../test-utils.js';

async function main(): Promise<void> {
  const detectionCases = [
    { name: 'empty text defaults to LF', content: '', expected: '\n' },
    { name: 'no newline defaults to LF', content: 'alpha', expected: '\n' },
    { name: 'standalone CR is not a candidate', content: 'alpha\rbeta\r', expected: '\n' },
    { name: 'LF only', content: 'alpha\nbeta\n', expected: '\n' },
    { name: 'CRLF only', content: 'alpha\r\nbeta\r\n', expected: '\r\n' },
    { name: 'CRLF majority', content: 'a\r\nb\nc\r\n', expected: '\r\n' },
    { name: 'LF majority', content: 'a\nb\r\nc\n', expected: '\n' },
    { name: 'tie defaults to LF', content: 'a\r\nb\n', expected: '\n' },
    { name: 'leading CRLF', content: '\r\nalpha', expected: '\r\n' },
    { name: 'consecutive CRs do not hide CRLF', content: '\r\r\n', expected: '\r\n' },
  ];

  await runTestSuite({
    title: 'Text line ending detection and policy',
    tests: [
      ...detectionCases.map((testCase) => ({
        name: testCase.name,
        run: () => {
          assertEqual(detectLineEnding(testCase.content), testCase.expected, testCase.name);
        },
      })),
      ...(['auto', 'lf', 'crlf'] as const).flatMap((config) =>
        ([null, '\n', '\r\n'] as const).map((detected) => ({
          name: `resolve ${config} with ${JSON.stringify(detected)}`,
          run: () => {
            const expected =
              config === 'crlf' ? '\r\n' : config === 'lf' ? '\n' : (detected ?? '\n');
            assertEqual(
              resolveLineEnding(config, detected),
              expected,
              'Configured line ending policy',
            );
          },
        })),
      ),
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
