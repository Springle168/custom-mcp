import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTOMATED_TEST_PATTERN = 'test/**/*.test.ts';
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;

export interface TestRunnerCliOptions {
  selectors: string[];
  verbose: boolean;
}

export interface TestExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  error?: Error;
  output?: string;
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

  for (const arg of args) {
    if (arg === '--verbose') {
      verbose = true;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    }

    selectors.push(arg);
  }

  return { selectors, verbose };
}

export async function discoverAutomatedTests(
  projectRoot = PROJECT_ROOT,
): Promise<string[]> {
  const matches = await glob(AUTOMATED_TEST_PATTERN, {
    cwd: projectRoot,
    nodir: true,
  });

  return [...new Set(matches.map(normalizeTestPath))]
    .sort((left, right) => left.localeCompare(right, 'en'));
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
    throw new Error(
      `No automated tests matched selector(s): ${unmatchedSelectors.join(', ')}`,
    );
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

    const passed = execution.exitCode === 0 && !execution.error;
    const result: TestScriptResult = {
      ...execution,
      output: passed ? undefined : execution.output,
      testPath,
      passed,
    };
    results.push(result);
    callbacks.onComplete?.(result);
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    results,
    passed,
    failed: results.length - passed,
    durationMs: performance.now() - startedAt,
  };
}

export function summarizeTestTopics(
  results: readonly TestScriptResult[],
): TestTopicSummary[] {
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
): Promise<TestExecutionResult> {
  const args = ['--import', 'tsx', path.join(PROJECT_ROOT, testPath)];
  if (verbose) {
    args.push('--verbose');
  }

  const startedAt = performance.now();

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    const capturedOutput = verbose ? undefined : new BoundedOutputBuffer();
    let spawnError: Error | undefined;

    child.stdout?.on('data', (chunk: Buffer) => {
      capturedOutput?.append(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      capturedOutput?.append(chunk);
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        durationMs: performance.now() - startedAt,
        error: spawnError,
        output: capturedOutput?.toString(),
      });
    });
  });
}

async function main(): Promise<void> {
  const options = parseTestRunnerArgs(process.argv.slice(2));
  const discoveredTests = await discoverAutomatedTests();
  const selectedTests = selectAutomatedTests(discoveredTests, options.selectors);
  if (selectedTests.length === 0) {
    throw new Error('No automated test scripts were discovered.');
  }

  console.log(`Running ${selectedTests.length} test script(s) serially...`);

  const summary = await runTestScripts(
    selectedTests,
    options.verbose,
    executeTestScript,
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

class BoundedOutputBuffer {
  readonly #chunks: Buffer[] = [];
  #size = 0;
  #truncated = false;

  append(chunk: Buffer): void {
    const remaining = MAX_CAPTURED_OUTPUT_BYTES - this.#size;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }

    if (chunk.length > remaining) {
      this.#chunks.push(chunk.subarray(0, remaining));
      this.#size += remaining;
      this.#truncated = true;
      return;
    }

    this.#chunks.push(chunk);
    this.#size += chunk.length;
  }

  toString(): string | undefined {
    if (this.#size === 0 && !this.#truncated) {
      return undefined;
    }

    const output = Buffer.concat(this.#chunks, this.#size).toString('utf-8');
    if (!this.#truncated) {
      return output;
    }

    return `${output}\n...[captured output truncated at 256 KB]\n`;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(toError(error).message);
    process.exitCode = 1;
  });
}
