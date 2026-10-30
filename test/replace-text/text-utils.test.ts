import {
  applyLineEnding,
  detectLineEnding,
  normalizeToLf,
  resolveLineEnding,
} from '../../src/engine/text-utils.js';
import { assertEqual, runTestSuite } from '../test-utils.js';

async function main(): Promise<void> {
  const conversionCases = [
    { name: 'empty text', content: '', expectedLf: '', expectedCrlf: '' },
    {
      name: 'text without newlines',
      content: '\uFEFFalpha 中文😀',
      expectedLf: '\uFEFFalpha 中文😀',
      expectedCrlf: '\uFEFFalpha 中文😀',
    },
    {
      name: 'LF only',
      content: 'alpha\nbeta',
      expectedLf: 'alpha\nbeta',
      expectedCrlf: 'alpha\r\nbeta',
    },
    {
      name: 'CRLF only',
      content: 'alpha\r\nbeta',
      expectedLf: 'alpha\nbeta',
      expectedCrlf: 'alpha\r\nbeta',
    },
    {
      name: 'standalone CR',
      content: 'alpha\rbeta',
      expectedLf: 'alpha\nbeta',
      expectedCrlf: 'alpha\r\nbeta',
    },
    {
      name: 'mixed line endings',
      content: 'alpha\r\nbeta\ngamma\rdelta',
      expectedLf: 'alpha\nbeta\ngamma\ndelta',
      expectedCrlf: 'alpha\r\nbeta\r\ngamma\r\ndelta',
    },
    {
      name: 'one trailing newline',
      content: 'alpha\r\n',
      expectedLf: 'alpha\n',
      expectedCrlf: 'alpha\r\n',
    },
    {
      name: 'multiple trailing newlines',
      content: 'alpha\r\n\n\r',
      expectedLf: 'alpha\n\n\n',
      expectedCrlf: 'alpha\r\n\r\n\r\n',
    },
    {
      name: 'newline-only text',
      content: '\r\n',
      expectedLf: '\n',
      expectedCrlf: '\r\n',
    },
    {
      name: 'consecutive CRs before LF',
      content: '\r\r\n',
      expectedLf: '\n\n',
      expectedCrlf: '\r\n\r\n',
    },
  ];

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

  const policyCases = [
    { config: 'auto', detected: null, expected: '\n' },
    { config: 'auto', detected: '\n', expected: '\n' },
    { config: 'auto', detected: '\r\n', expected: '\r\n' },
    { config: 'lf', detected: null, expected: '\n' },
    { config: 'lf', detected: '\n', expected: '\n' },
    { config: 'lf', detected: '\r\n', expected: '\n' },
    { config: 'crlf', detected: null, expected: '\r\n' },
    { config: 'crlf', detected: '\n', expected: '\r\n' },
    { config: 'crlf', detected: '\r\n', expected: '\r\n' },
  ] as const;

  await runTestSuite({
    title: 'Text line ending conversion, detection, and policy',
    tests: [
      ...conversionCases.flatMap((testCase) => [
        {
          name: `normalize to LF: ${testCase.name}`,
          run: () => {
            assertEqual(normalizeToLf(testCase.content), testCase.expectedLf, testCase.name);
          },
        },
        {
          name: `write as LF: ${testCase.name}`,
          run: () => {
            assertEqual(
              applyLineEnding(testCase.content, '\n'),
              testCase.expectedLf,
              testCase.name,
            );
          },
        },
        {
          name: `write as CRLF: ${testCase.name}`,
          run: () => {
            assertEqual(
              applyLineEnding(testCase.content, '\r\n'),
              testCase.expectedCrlf,
              testCase.name,
            );
          },
        },
      ]),
      ...detectionCases.map((testCase) => ({
        name: testCase.name,
        run: () => {
          assertEqual(detectLineEnding(testCase.content), testCase.expected, testCase.name);
        },
      })),
      ...policyCases.map((testCase) => ({
        name: `resolve ${testCase.config} with ${JSON.stringify(testCase.detected)}`,
        run: () => {
          assertEqual(
            resolveLineEnding(testCase.config, testCase.detected),
            testCase.expected,
            'Configured line ending policy',
          );
        },
      })),
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
