import { calculateRegexReplacement, calculateReplacement } from '../../src/engine/replacement.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Replacement engine input normalization',
    tests: [
      {
        name: 'Literal entry normalizes target and replacement',
        run: () => {
          const result = calculateReplacement('before\nalpha\nbeta\ngamma\nafter', {
            file_path: 'unused.txt',
            target: 'alpha\r\nbeta\rgamma',
            replacement: 'one\rtwo\r\nthree\r\n\r',
          });

          assertEqual(result.matchedTargets, 1, 'Normalized target should match LF content');
          assertEqual(result.replacementCount, 1, 'Should replace the single match');
          assertEqual(
            result.newContent,
            'before\none\ntwo\nthree\n\n\nafter',
            'Replacement should use LF and retain all trailing newlines',
          );
        },
      },
      {
        name: 'Regex entry normalizes replacement before capture expansion',
        run: () => {
          const result = calculateRegexReplacement('before\nalpha\nbeta\nafter', {
            file_path: 'unused.txt',
            target: '(alpha)\\nbeta',
            replacement: '$!1\r\none\rtwo\r\n',
          });

          assert(result.ok, 'Regex should compile and consume a match');
          assertEqual(result.matchedTargets, 1, 'Should match against LF content');
          assertEqual(result.replacementCount, 1, 'Should replace the single match');
          assertEqual(
            result.newContent,
            'before\nalpha\none\ntwo\n\nafter',
            'Replacement should use LF and still expand captures',
          );
        },
      },
      ...[
        { name: 'literal CRLF in pattern', target: 'alpha\r\nbeta' },
        { name: 'literal CR in pattern', target: 'alpha\rbeta' },
        { name: 'escaped CRLF in pattern', target: 'alpha\\r\\nbeta' },
      ].map((testCase) => ({
        name: `Regex entry preserves ${testCase.name}`,
        run: () => {
          const content = 'alpha\nbeta';
          const result = calculateRegexReplacement(content, {
            file_path: 'unused.txt',
            target: testCase.target,
            replacement: 'changed',
          });

          assert(result.ok, 'Pattern should remain valid');
          assertEqual(result.matchedTargets, 0, 'CR pattern must not become an LF match');
          assertEqual(result.replacementCount, 0, 'Should not replace unmatched text');
          assertEqual(result.newContent, content, 'Unmatched content should remain unchanged');
        },
      })),
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
