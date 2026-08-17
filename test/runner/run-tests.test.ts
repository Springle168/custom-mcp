import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverAutomatedTests,
  executeTestScript,
  parseTestRunnerArgs,
  runTestScripts,
  selectAutomatedTests,
  summarizeTestTopics,
  type TestExecutionResult,
  type TestScriptResult,
} from '../run-tests.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const SAMPLE_TESTS = [
  'test/config/value-policy.test.ts',
  'test/config/workspace-selection.test.ts',
  'test/read-file/read-file.test.ts',
  'test/runtime/request-context.test.ts',
];

async function testDiscoversOnlyAutomatedScripts(): Promise<void> {
  const tests = await discoverAutomatedTests();

  assert(
    tests.includes('test/config/value-policy.test.ts'),
    'Should discover ordinary *.test.ts scripts',
  );
  assert(
    tests.includes('test/android-build/test-android-gradle-timeout.ts'),
    'Should discover legacy-named Android automated scripts',
  );
  assert(
    tests.includes('test/runner/run-tests.test.ts'),
    'Should discover the runner regression test',
  );
  assert(
    !tests.includes('test/logger/logger.test.ts'),
    'Should exclude the logger demo script',
  );
  assert(
    !tests.includes('test/ask-user/ask-user.manual.ts'),
    'Should exclude manual scripts',
  );
  assert(
    !tests.includes('test/fixtures/read-many-files/setup.ts'),
    'Should exclude fixture setup scripts',
  );
  assert(
    !tests.includes('test/tools/inspect-tools.ts'),
    'Should exclude inspection scripts',
  );
  assert(
    !tests.includes('test/replace-text/helpers.ts'),
    'Should exclude helper modules',
  );
  assert(
    !tests.includes('test/runner/fixtures/failing-script.ts'),
    'Should exclude runner fixture scripts',
  );
}

function testParsesSelectorsAndVerbose(): void {
  const options = parseTestRunnerArgs(['config', '--verbose', 'runtime']);

  assertEqual(options.verbose, true, 'Should enable verbose output');
  assertEqual(
    options.selectors.join(','),
    'config,runtime',
    'Should retain selector order',
  );
}

function testRejectsUnknownOptions(): void {
  assertThrows(
    () => parseTestRunnerArgs(['--parallel']),
    'Unknown option: --parallel',
  );
}

function testSelectsTopic(): void {
  const selected = selectAutomatedTests(SAMPLE_TESTS, ['config']);

  assertEqual(selected.length, 2, 'Should select both config scripts');
  assert(
    selected.every((testPath) => testPath.startsWith('test/config/')),
    'Should only select scripts from the requested topic',
  );
}

function testSelectsRelativePathWithEitherSeparator(): void {
  const posixSelected = selectAutomatedTests(
    SAMPLE_TESTS,
    ['test/config/value-policy.test.ts'],
  );
  const windowsSelected = selectAutomatedTests(
    SAMPLE_TESTS,
    ['test\\config\\value-policy.test.ts'],
  );

  assertEqual(
    posixSelected.join(','),
    'test/config/value-policy.test.ts',
    'Should select an exact repository-relative path',
  );
  assertEqual(
    windowsSelected.join(','),
    'test/config/value-policy.test.ts',
    'Should normalize Windows path separators',
  );
}

function testSelectsFileNameAndMultipleSelectors(): void {
  const byFileName = selectAutomatedTests(SAMPLE_TESTS, ['read-file.test.ts']);
  const combined = selectAutomatedTests(SAMPLE_TESTS, ['config', 'runtime']);

  assertEqual(
    byFileName.join(','),
    'test/read-file/read-file.test.ts',
    'Should select by file name',
  );
  assertEqual(combined.length, 3, 'Should combine multiple selectors with OR semantics');
}

function testRejectsEveryUnmatchedSelector(): void {
  assertThrows(
    () => selectAutomatedTests(SAMPLE_TESTS, ['config', 'missing-topic']),
    'No automated tests matched selector(s): missing-topic',
  );
}

async function testContinuesAfterFailures(): Promise<void> {
  const calls: Array<{ testPath: string; verbose: boolean }> = [];
  const exitCodes = new Map<string, number>([
    ['first.test.ts', 1],
    ['second.test.ts', 0],
    ['third.test.ts', 2],
  ]);

  const summary = await runTestScripts(
    [...exitCodes.keys()],
    true,
    async (testPath, verbose): Promise<TestExecutionResult> => {
      calls.push({ testPath, verbose });
      return {
        exitCode: exitCodes.get(testPath) ?? 1,
        signal: null,
        durationMs: 1,
        output: `output-${testPath}`,
      };
    },
  );

  assertEqual(calls.length, 3, 'Should execute every script after earlier failures');
  assertEqual(
    calls.map((call) => call.testPath).join(','),
    'first.test.ts,second.test.ts,third.test.ts',
    'Should preserve serial script order',
  );
  assert(
    calls.every((call) => call.verbose),
    'Should forward verbose mode to every script execution',
  );
  assertEqual(summary.passed, 1, 'Should count successful scripts');
  assertEqual(summary.failed, 2, 'Should collect all failed scripts');
  assertEqual(
    summary.results[0]?.output,
    'output-first.test.ts',
    'Should retain failed script output',
  );
  assertEqual(
    summary.results[1]?.output,
    undefined,
    'Should discard successful script output after completion',
  );
}

async function testTreatsExecutorErrorsAsFailures(): Promise<void> {
  let secondExecuted = false;
  const summary = await runTestScripts(
    ['throws.test.ts', 'continues.test.ts'],
    false,
    async (testPath): Promise<TestExecutionResult> => {
      if (testPath === 'throws.test.ts') {
        throw new Error('spawn failed');
      }
      secondExecuted = true;
      return { exitCode: 0, signal: null, durationMs: 1 };
    },
  );

  assert(secondExecuted, 'Should continue after an executor error');
  assertEqual(summary.failed, 1, 'Should count executor errors as failures');
  assertEqual(
    summary.results[0]?.error?.message,
    'spawn failed',
    'Should retain the executor error',
  );
}

function testSummarizesResultsByTopic(): void {
  const results: TestScriptResult[] = [
    scriptResult('test/config/first.test.ts', true, 10),
    scriptResult('test/config/second.test.ts', false, 20),
    scriptResult('test/runtime/third.test.ts', true, 30),
  ];

  const summaries = summarizeTestTopics(results);
  const config = summaries[0];
  const runtime = summaries[1];

  assertEqual(summaries.length, 2, 'Should produce one summary per topic');
  assertEqual(config?.topic, 'config', 'Should derive the config topic');
  assertEqual(config?.total, 2, 'Should count all config scripts');
  assertEqual(config?.passed, 1, 'Should count passed config scripts');
  assertEqual(config?.failed, 1, 'Should count failed config scripts');
  assertEqual(config?.durationMs, 30, 'Should add config script durations');
  assertEqual(runtime?.topic, 'runtime', 'Should preserve topic order');
  assertEqual(runtime?.passed, 1, 'Should count passed runtime scripts');
}

async function testCapturesFailedScriptOutput(): Promise<void> {
  const result = await executeTestScript(
    'test/runner/fixtures/failing-script.ts',
    false,
  );

  assertEqual(result.exitCode, 1, 'Fixture script should fail');
  assertIncludes(
    result.output,
    'captured stdout marker',
    'Should capture failed script stdout',
  );
  assertIncludes(
    result.output,
    'captured stderr marker',
    'Should capture failed script stderr',
  );
}

async function testTruncatesExcessiveCapturedOutput(): Promise<void> {
  const result = await executeTestScript(
    'test/runner/fixtures/large-output-script.ts',
    false,
  );

  assertEqual(result.exitCode, 1, 'Large-output fixture script should fail');
  assertIncludes(
    result.output,
    '...[captured output truncated at 256 KB]',
    'Should mark captured output truncation',
  );
  assert(
    (result.output?.length ?? 0) < 263_000,
    'Should keep captured output near the configured byte limit',
  );
}

function testDefaultCliUsesCompactOutput(): void {
  const result = runRunnerCli(['test/runtime/mcp-identifiers.test.ts']);

  assertEqual(result.status, 0, 'Compact runner invocation should pass');
  assertIncludes(
    result.stdout,
    'Test module summary',
    'Should print the module summary',
  );
  assertIncludes(
    result.stdout,
    'PASS runtime',
    'Should summarize the selected topic',
  );
  assertIncludes(
    result.stdout,
    'PASS 1/1 test scripts',
    'Should print the aggregate result',
  );
  assertNotIncludes(
    result.stdout,
    'Testing MCP identifier generation',
    'Should suppress successful child output by default',
  );
}

function testVerboseCliStreamsChildOutput(): void {
  const result = runRunnerCli([
    'test/runtime/mcp-identifiers.test.ts',
    '--verbose',
  ]);

  assertEqual(result.status, 0, 'Verbose runner invocation should pass');
  assertIncludes(
    result.stdout,
    'Testing MCP identifier generation',
    'Should show the child suite title in verbose mode',
  );
  assertIncludes(
    result.stdout,
    'Test: session IDs use session prefix',
    'Should forward verbose mode to the child script',
  );
}

function scriptResult(
  testPath: string,
  passed: boolean,
  durationMs: number,
): TestScriptResult {
  return {
    testPath,
    passed,
    exitCode: passed ? 0 : 1,
    signal: null,
    durationMs,
  };
}

function runRunnerCli(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'test/run-tests.ts', ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
    },
  );

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function assertThrows(run: () => unknown, expectedMessage: string): void {
  try {
    run();
  } catch (error) {
    assert(
      error instanceof Error && error.message === expectedMessage,
      `Should throw "${expectedMessage}"`,
    );
    return;
  }

  throw new Error(`Expected error: ${expectedMessage}`);
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing unified test runner',
    tests: [
      { name: 'discovers only automated scripts', run: testDiscoversOnlyAutomatedScripts },
      { name: 'parses selectors and verbose', run: testParsesSelectorsAndVerbose },
      { name: 'rejects unknown options', run: testRejectsUnknownOptions },
      { name: 'selects a topic', run: testSelectsTopic },
      {
        name: 'selects relative paths with either separator',
        run: testSelectsRelativePathWithEitherSeparator,
      },
      {
        name: 'selects a file name and multiple selectors',
        run: testSelectsFileNameAndMultipleSelectors,
      },
      { name: 'rejects every unmatched selector', run: testRejectsEveryUnmatchedSelector },
      { name: 'continues after failures', run: testContinuesAfterFailures },
      { name: 'treats executor errors as failures', run: testTreatsExecutorErrorsAsFailures },
      { name: 'summarizes results by topic', run: testSummarizesResultsByTopic },
      { name: 'captures failed script output', run: testCapturesFailedScriptOutput },
      {
        name: 'truncates excessive captured output',
        run: testTruncatesExcessiveCapturedOutput,
      },
      { name: 'default CLI uses compact output', run: testDefaultCliUsesCompactOutput },
      { name: 'verbose CLI streams child output', run: testVerboseCliStreamsChildOutput },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
