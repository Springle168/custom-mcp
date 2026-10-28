import { main, parseTestRunnerArgs } from '../../run-tests.js';

// Exercise the real CLI reporting without running taskkill in an ordinary test.
const unconfirmed = process.argv.includes('--unconfirmed-cleanup');
const args = process.argv.slice(2).filter((arg) => arg !== '--unconfirmed-cleanup');
const options = parseTestRunnerArgs(args);
await main(args, {
  discover: async () => ['test/sample/timeout.test.ts', 'test/sample/next.test.ts'],
  execute: async (testPath) =>
    testPath.includes('timeout')
      ? {
          exitCode: 0,
          signal: null,
          timedOut: true,
          timeoutMs: options.timeoutMs,
          durationMs: options.timeoutMs + 10,
          cleanupConfirmed: !unconfirmed,
          cleanupError: unconfirmed ? 'injected taskkill failure' : undefined,
          output: 'timeout output marker',
        }
      : { exitCode: 0, signal: null, durationMs: 1 },
});
