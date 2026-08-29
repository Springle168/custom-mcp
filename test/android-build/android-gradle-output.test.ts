import { parseAndroidGradleOutput } from '../../src/engine/android-gradle-output.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

function testSuccessResult() {
  const result = parseAndroidGradleOutput({
    exitCode: 0,
    stdout: 'BUILD SUCCESSFUL',
    stderr: '',
    maxErrorBlockChars: 2500,
    maxLogTailChars: 4000,
  });

  assert(result.success, 'Should mark success');
  assertEqual(result.summary, 'BUILD SUCCESSFUL', 'Should keep success summary');
  assertEqual(result.cancelled, false, 'Successful output should not be cancelled');
  assertEqual(result.failedTask, null, 'Should not return failedTask');
  assertEqual(result.firstErrorBlock, null, 'Should not return firstErrorBlock');
  assertEqual(result.logTail, undefined, 'Should omit logTail');
}

function testCancelledResult() {
  const result = parseAndroidGradleOutput({
    exitCode: 0,
    stdout: 'BUILD SUCCESSFUL',
    stderr: '',
    maxErrorBlockChars: 2500,
    maxLogTailChars: 4000,
    cancelled: true,
  });

  assert(!result.success, 'Cancellation should override a late zero exit code');
  assertEqual(result.summary, 'BUILD CANCELLED', 'Cancellation should use its stable summary');
  assertEqual(result.cancelled, true, 'Cancellation should set the cancelled flag');
}

function testTimedOutResultIgnoresLateZeroExitCode() {
  const result = parseAndroidGradleOutput({
    exitCode: 0,
    stdout: 'BUILD SUCCESSFUL',
    stderr: 'error: Gradle process timed out after 500ms.',
    maxErrorBlockChars: 2500,
    maxLogTailChars: 4000,
    timedOut: true,
  });

  assert(!result.success, 'Timeout should override a late zero exit code');
  assertEqual(result.summary, 'BUILD FAILED', 'Timeout should retain the failure summary');
  assertEqual(result.cancelled, false, 'Timeout should remain distinct from cancellation');
}

function testCompilerErrorExtraction() {
  const result = parseAndroidGradleOutput({
    exitCode: 1,
    stdout: '',
    stderr: [
      '> Task :app:compileDebugKotlin FAILED',
      'e: file:///E:/Demo/app/src/main/java/com/example/MainActivity.kt:12:5 Unresolved reference: missingSymbol',
      'e: file:///E:/Demo/app/src/main/java/com/example/MainActivity.kt:13:5 Type mismatch: inferred type is String but Int was expected',
      '',
      'BUILD FAILED in 4s',
    ].join('\n'),
    maxErrorBlockChars: 2500,
    maxLogTailChars: 4000,
    includeLogTail: true,
  });

  assert(!result.success, 'Should mark failure');
  assertEqual(result.summary, 'BUILD FAILED', 'Should keep failure summary');
  assertEqual(result.failedTask, null, 'Compiler-only sample has no Gradle failed task');
  assertIncludes(
    result.firstErrorBlock,
    'Unresolved reference: missingSymbol',
    'Should capture first compiler error block',
  );
  assertIncludes(result.logTail, 'BUILD FAILED in 4s', 'Should keep log tail');
}

function testWhatWentWrongExtraction() {
  const result = parseAndroidGradleOutput({
    exitCode: 1,
    stdout: '',
    stderr: [
      '* What went wrong:',
      "Execution failed for task ':app:compileDebugKotlin'.",
      '> Compilation error. See log for more details',
      '* Try:',
      'Run with --stacktrace option to get the stack trace.',
    ].join('\n'),
    maxErrorBlockChars: 2500,
    maxLogTailChars: 4000,
  });

  assertEqual(
    result.failedTask,
    ':app:compileDebugKotlin',
    'Should extract the failed Gradle task',
  );
  assert(
    !result.firstErrorBlock?.includes('* What went wrong:'),
    'Should remove the What went wrong heading',
  );
  assertIncludes(
    result.firstErrorBlock,
    'Compilation error. See log for more details',
    'Should keep the root cause from What went wrong',
  );
  assert(
    !result.firstErrorBlock?.includes('Execution failed for task'),
    'Should not repeat the structured failed task',
  );
}

function testAnsiRemovalAndTailTruncation() {
  const longTail = `prefix-${'x'.repeat(80)}-suffix`;
  const result = parseAndroidGradleOutput({
    exitCode: 1,
    stdout: '\u001B[31merror: Something failed\u001B[0m',
    stderr: longTail,
    maxErrorBlockChars: 40,
    maxLogTailChars: 30,
    includeLogTail: true,
  });

  assertIncludes(result.firstErrorBlock, 'error: Something failed', 'Should strip ANSI escape sequences');
  assertIncludes(result.logTail, '...[truncated]', 'Should mark truncated log tail');
  assert(
    !result.logTail?.includes('\u001B[31m'),
    'Should not keep raw ANSI sequences',
  );
}

function testCombinedOutputPreservesArrivalOrder() {
  const result = parseAndroidGradleOutput({
    exitCode: 1,
    stdout: ['stdout-1', 'stdout-2'].join('\n'),
    stderr: 'stderr-1',
    combinedOutput: ['stdout-1', 'stderr-1', 'stdout-2'].join('\n'),
    maxErrorBlockChars: 2500,
    maxLogTailChars: 4000,
    includeLogTail: true,
  });

  assertEqual(
    result.logTail,
    ['stdout-1', 'stderr-1', 'stdout-2'].join('\n'),
    'Should prefer the merged arrival-order stream for logTail',
  );
}

function testLogTailIsOptIn() {
  const result = parseAndroidGradleOutput({
    exitCode: 1,
    stdout: '',
    stderr: 'error: Something failed\nBUILD FAILED in 1s',
    maxErrorBlockChars: 2500,
    maxLogTailChars: 4000,
  });

  assertEqual(result.logTail, undefined, 'Should omit logTail by default');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing android gradle output parser',
    tests: [
      { name: 'success result', run: testSuccessResult },
      { name: 'cancelled result', run: testCancelledResult },
      { name: 'timeout ignores late zero exit code', run: testTimedOutResultIgnoresLateZeroExitCode },
      { name: 'compiler error extraction', run: testCompilerErrorExtraction },
      { name: 'what went wrong extraction', run: testWhatWentWrongExtraction },
      { name: 'ANSI removal and tail truncation', run: testAnsiRemovalAndTailTruncation },
      { name: 'combined output preserves arrival order', run: testCombinedOutputPreservesArrivalOrder },
      { name: 'log tail is opt-in', run: testLogTailIsOptIn },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
