import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import {
  DEFAULT_SCRIPT_TIMEOUT_MS,
  executeTestScriptProcess,
  validateTimeoutMs,
  type ScriptExecutionOptions,
  type TestExecutionResult,
} from './runner/script-execution.js';

export type { TestExecutionResult } from './runner/script-execution.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTOMATED_TEST_PATTERN = 'test/**/*.test.ts';

export interface TestRunnerCliOptions {
  selectors: string[];
  verbose: boolean;
  timeoutMs: number;
}

export interface TestScriptResult extends TestExecutionResult {
  testPath: string;
  passed: boolean;
}

export interface TestRunSummary {
  results: TestScriptResult[];
  passed: number;
  failed: number;
  durationMs: number;
  notRun: string[];
  stopReason?: string;
}

export interface TestTopicSummary {
  topic: string;
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
}

export type TestScriptExecutor = (
  testPath: string,
  verbose: boolean,
) => Promise<TestExecutionResult>;

export interface TestRunCallbacks {
  onStart?: (testPath: string) => void;
  onComplete?: (result: TestScriptResult) => void;
}

export function parseTestRunnerArgs(args: readonly string[]): TestRunnerCliOptions {
  const selectors: string[] = [];
  let verbose = false;
  let timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS;
  let timeoutSpecified = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--verbose') {
      verbose = true;
      continue;
    }

    if (arg === '--timeout-ms') {
      if (timeoutSpecified) throw new Error('--timeout-ms may only be specified once.');
      timeoutSpecified = true;
      const value = args[++index];
      if (!value || !/^[0-9]+$/u.test(value)) {
        validateTimeoutMs(Number.NaN);
      }
      timeoutMs = Number(value);
      validateTimeoutMs(timeoutMs);
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    selectors.push(arg);
  }

  return { selectors, verbose, timeoutMs };
}

export async function discoverAutomatedTests(projectRoot = PROJECT_ROOT): Promise<string[]> {
  const matches = await glob(AUTOMATED_TEST_PATTERN, {
    cwd: projectRoot,
    nodir: true,
  });

  return [...new Set(matches.map(normalizeTestPath))].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
}

export function selectAutomatedTests(
  tests: readonly string[],
  selectors: readonly string[],
): string[] {
  if (selectors.length === 0) {
    return [...tests];
  }

  const normalizedSelectors = selectors.map(normalizeSelector);
  const unmatchedSelectors = normalizedSelectors.filter(
    (selector) => !tests.some((testPath) => matchesSelector(testPath, selector)),
  );

  if (unmatchedSelectors.length > 0) {
    throw new Error(`No automated tests matched selector(s): ${unmatchedSelectors.join(', ')}`);
  }

  return tests.filter((testPath) =>
    normalizedSelectors.some((selector) => matchesSelector(testPath, selector)),
  );
}

export async function runTestScripts(
  tests: readonly string[],
  verbose: boolean,
  execute: TestScriptExecutor,
  callbacks: TestRunCallbacks = {},
): Promise<TestRunSummary> {
  const startedAt = performance.now();
  const results: TestScriptResult[] = [];
  let stopReason: string | undefined;

  for (const testPath of tests) {
    callbacks.onStart?.(testPath);

    let execution: TestExecutionResult;
    try {
      execution = await execute(testPath, verbose);
    } catch (error) {
      execution = {
        exitCode: null,
        signal: null,
        durationMs: 0,
        error: toError(error),
      };
    }

    const passed =
      execution.exitCode === 0 &&
      !execution.error &&
      !execution.timedOut &&
      execution.cleanupConfirmed !== false;
    const result: TestScriptResult = {
      ...execution,
      output: passed ? undefined : execution.output,
      testPath,
      passed,
    };
    results.push(result);
    callbacks.onComplete?.(result);
    if (execution.cleanupConfirmed === false) {
      stopReason = `Cleanup was not confirmed for ${testPath}: ${execution.cleanupError ?? 'unknown cleanup failure'}`;
      break;
    }
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    results,
    passed,
    failed: results.length - passed,
    durationMs: performance.now() - startedAt,
    notRun: tests.slice(results.length),
    stopReason,
  };
}

export function summarizeTestTopics(results: readonly TestScriptResult[]): TestTopicSummary[] {
  const summaries = new Map<string, TestTopicSummary>();

  for (const result of results) {
    const topic = getTestTopic(result.testPath);
    const summary = summaries.get(topic) ?? {
      topic,
      total: 0,
      passed: 0,
      failed: 0,
      durationMs: 0,
    };

    summary.total++;
    summary.durationMs += result.durationMs;
    if (result.passed) {
      summary.passed++;
    } else {
      summary.failed++;
    }
    summaries.set(topic, summary);
  }

  return [...summaries.values()];
}

export async function executeTestScript(
  testPath: string,
  verbose: boolean,
  timeoutMs = DEFAULT_SCRIPT_TIMEOUT_MS,
  options: Omit<ScriptExecutionOptions, 'projectRoot'> = {},
): Promise<TestExecutionResult> {
  return executeTestScriptProcess(testPath, verbose, timeoutMs, {
    ...options,
    projectRoot: PROJECT_ROOT,
  });
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  dependencies: {
    discover?: () => Promise<string[]>;
    execute?: TestScriptExecutor;
  } = {},
): Promise<void> {
  const options = parseTestRunnerArgs(args);
  const discoveredTests = await (dependencies.discover ?? discoverAutomatedTests)();
  const selectedTests = selectAutomatedTests(discoveredTests, options.selectors);
  if (selectedTests.length === 0) {
    throw new Error('No automated test scripts were discovered.');
  }

  console.log(`Running ${selectedTests.length} test script(s) serially...`);

  const summary = await runTestScripts(
    selectedTests,
    options.verbose,
    dependencies.execute ??
      ((testPath, verbose) => executeTestScript(testPath, verbose, options.timeoutMs)),
    options.verbose
      ? {
          onStart(testPath) {
            console.log(`\n▶ ${testPath}`);
          },
          onComplete(result) {
            printVerboseResult(result);
          },
        }
      : {
          onComplete(result) {
            if (!result.passed) {
              printFailure(result);
            }
          },
        },
  );

  printTopicSummary(summary);

  if (summary.stopReason) {
    console.error(`\nStopped: ${summary.stopReason}`);
    console.log(`Not run: ${summary.notRun.length} test script(s)`);
    for (const testPath of summary.notRun) {
      console.log(`  - ${testPath}`);
    }
  }

  if (summary.failed > 0) {
    console.log('\nFailed test scripts:');
    for (const result of summary.results.filter((item) => !item.passed)) {
      console.log(`  - ${result.testPath}`);
    }
    process.exitCode = 1;
  }
}

function printVerboseResult(result: TestScriptResult): void {
  const status = result.passed ? 'PASS' : 'FAIL';
  console.log(`${status} ${result.testPath} (${formatDuration(result.durationMs)})`);
  if (result.timedOut) {
    console.error(`  ${describeFailure(result)}; elapsed ${formatDuration(result.durationMs)}`);
  }
  if (result.cleanupConfirmed === false) {
    console.error(`  Cleanup not confirmed: ${result.cleanupError}`);
  }
  if (result.error) {
    console.error(`  ${result.error.message}`);
  } else if (result.signal) {
    console.error(`  Terminated by signal: ${result.signal}`);
  }
}

function printFailure(result: TestScriptResult): void {
  console.log(
    `\nFAIL ${result.testPath} (${describeFailure(result)}, ${formatDuration(result.durationMs)})`,
  );

  if (result.error) {
    console.log(result.error.message);
  }
  if (result.cleanupConfirmed === false) {
    console.log(`Cleanup not confirmed: ${result.cleanupError}`);
  }

  if (result.output) {
    console.log('\n--- Captured output ---');
    process.stdout.write(result.output);
    if (!result.output.endsWith('\n')) {
      process.stdout.write('\n');
    }
    console.log('--- End of captured output ---');
  }
}

function printTopicSummary(summary: TestRunSummary): void {
  const topicSummaries = summarizeTestTopics(summary.results);
  const topicWidth = Math.max(...topicSummaries.map((item) => item.topic.length));
  const countWidth = Math.max(
    ...topicSummaries.map((item) => `${item.passed}/${item.total}`.length),
  );

  console.log('\nTest module summary');
  for (const topic of topicSummaries) {
    const status = topic.failed === 0 ? 'PASS' : 'FAIL';
    const count = `${topic.passed}/${topic.total}`;
    console.log(
      `${status} ${topic.topic.padEnd(topicWidth)}  ${count.padStart(countWidth)}  ${formatDuration(topic.durationMs)}`,
    );
  }

  const status = summary.failed === 0 ? 'PASS' : 'FAIL';
  console.log(
    `\n${status} ${summary.passed}/${summary.results.length} test scripts in ${formatDuration(summary.durationMs)}`,
  );
}

function describeFailure(result: TestScriptResult): string {
  if (result.timedOut) return `timeout after ${result.timeoutMs} ms`;
  if (result.error) return 'runner error';
  if (result.signal) return `signal ${result.signal}`;
  return `exit code ${result.exitCode ?? 'unknown'}`;
}

function getTestTopic(testPath: string): string {
  const [root, topic] = normalizeTestPath(testPath).split('/');
  return root === 'test' && topic ? topic : '(root)';
}

function matchesSelector(testPath: string, selector: string): boolean {
  if (testPath === selector || path.posix.basename(testPath) === selector) {
    return true;
  }

  return !selector.includes('/') && testPath.startsWith(`test/${selector}/`);
}

function normalizeSelector(selector: string): string {
  return normalizeTestPath(selector).replace(/^\.\//u, '').replace(/\/$/u, '');
}

function normalizeTestPath(testPath: string): string {
  return testPath.replaceAll('\\', '/');
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }

  return `${(durationMs / 1000).toFixed(2)} s`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(toError(error).message);
    process.exitCode = 1;
  });
}
