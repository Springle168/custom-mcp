import { parseAndroidGradleOutput } from '../../src/engine/android-gradle-output.js';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}\nExpected: ${String(expected)}\nActual: ${String(actual)}`,
    );
  }
}

function assertIncludes(text: string | null, substring: string, message: string): void {
  if (!text || !text.includes(substring)) {
    throw new Error(
      `Assertion failed: ${message}\nExpected to find: "${substring}"\nIn text: ${text ?? 'null'}`,
    );
  }
}

function testSuccessResult() {
  console.log('Test: success result');

  const result = parseAndroidGradleOutput({
    exitCode: 0,
    stdout: 'BUILD SUCCESSFUL',
    stderr: '',
    maxErrorBlockChars: 2500,
    maxLogTailChars: 4000,
  });

  assert(result.success, 'Should mark success');
  assertEqual(result.summary, 'BUILD SUCCESSFUL', 'Should keep success summary');
  assertEqual(result.firstErrorBlock, null, 'Should not return firstErrorBlock');
  assertEqual(result.logTail, null, 'Should not return logTail');

  console.log('  ✓ Passed\n');
}

function testCompilerErrorExtraction() {
  console.log('Test: compiler error extraction');

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
  });

  assert(!result.success, 'Should mark failure');
  assertEqual(result.summary, 'BUILD FAILED', 'Should keep failure summary');
  assertIncludes(
    result.firstErrorBlock,
    'Unresolved reference: missingSymbol',
    'Should capture first compiler error block',
  );
  assertIncludes(result.logTail, 'BUILD FAILED in 4s', 'Should keep log tail');

  console.log('  ✓ Passed\n');
}

function testWhatWentWrongExtraction() {
  console.log('Test: what went wrong extraction');

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

  assertIncludes(
    result.firstErrorBlock,
    "Execution failed for task ':app:compileDebugKotlin'.",
    'Should capture the What went wrong block',
  );

  console.log('  ✓ Passed\n');
}

function testAnsiRemovalAndTailTruncation() {
  console.log('Test: ANSI removal and tail truncation');

  const longTail = `prefix-${'x'.repeat(80)}-suffix`;
  const result = parseAndroidGradleOutput({
    exitCode: 1,
    stdout: '\u001B[31merror: Something failed\u001B[0m',
    stderr: longTail,
    maxErrorBlockChars: 40,
    maxLogTailChars: 30,
  });

  assertIncludes(result.firstErrorBlock, 'error: Something failed', 'Should strip ANSI escape sequences');
  assertIncludes(result.logTail, '...[truncated]', 'Should mark truncated log tail');
  assert(
    !result.logTail?.includes('\u001B[31m'),
    'Should not keep raw ANSI sequences',
  );

  console.log('  ✓ Passed\n');
}

function testCombinedOutputPreservesArrivalOrder() {
  console.log('Test: combined output preserves arrival order');

  const result = parseAndroidGradleOutput({
    exitCode: 1,
    stdout: ['stdout-1', 'stdout-2'].join('\n'),
    stderr: 'stderr-1',
    combinedOutput: ['stdout-1', 'stderr-1', 'stdout-2'].join('\n'),
    maxErrorBlockChars: 2500,
    maxLogTailChars: 4000,
  });

  assertEqual(
    result.logTail,
    ['stdout-1', 'stderr-1', 'stdout-2'].join('\n'),
    'Should prefer the merged arrival-order stream for logTail',
  );

  console.log('  ✓ Passed\n');
}

function main() {
  console.log('='.repeat(24));
  console.log('Testing android gradle output parser');
  console.log('='.repeat(24));

  testSuccessResult();
  testCompilerErrorExtraction();
  testWhatWentWrongExtraction();
  testAnsiRemovalAndTailTruncation();
  testCombinedOutputPreservesArrivalOrder();

  console.log('='.repeat(24));
  console.log('All parser tests passed');
  console.log('='.repeat(24));
}

main();
