import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTOMATED_TEST_PATTERNS = [
  'test/**/*.test.ts',
  'test/android-build/test-*.ts',
];
const EXCLUDED_AUTOMATED_TESTS = new Set([
  'test/logger/logger.test.ts',
]);

export interface TestRunnerCliOptions {
  selectors: string[];
  verbose: boolean;
}

export interface TestExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  error?: Error;
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
  const matches = await glob(AUTOMATED_TEST_PATTERNS, {
    cwd: projectRoot,
    nodir: true,
  });

  return [...new Set(matches.map(normalizeTestPath))]
    .filter((testPath) => !EXCLUDED_AUTOMATED_TESTS.has(testPath))
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

    const result: TestScriptResult = {
      ...execution,
      testPath,
      passed: execution.exitCode === 0 && !execution.error,
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

async function executeTestScript(
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
      stdio: 'inherit',
    });
    let spawnError: Error | undefined;

    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        durationMs: performance.now() - startedAt,
        error: spawnError,
      });
    });
  });
}

async function main(): Promise<void> {
  const options = parseTestRunnerArgs(process.argv.slice(2));
  const discoveredTests = await discoverAutomatedTests();
  const selectedTests = selectAutomatedTests(discoveredTests, options.selectors);

  console.log(`Running ${selectedTests.length} test script(s) serially...`);

  const summary = await runTestScripts(
    selectedTests,
    options.verbose,
    executeTestScript,
    {
      onStart(testPath) {
        console.log(`\n▶ ${testPath}`);
      },
      onComplete(result) {
        const status = result.passed ? 'PASS' : 'FAIL';
        console.log(
          `${status} ${result.testPath} (${formatDuration(result.durationMs)})`,
        );
        if (result.error) {
          console.error(`  ${result.error.message}`);
        } else if (result.signal) {
          console.error(`  Terminated by signal: ${result.signal}`);
        }
      },
    },
  );

  console.log('\nTest script summary');
  console.log(`  Selected: ${summary.results.length}`);
  console.log(`  Passed: ${summary.passed}`);
  console.log(`  Failed: ${summary.failed}`);
  console.log(`  Duration: ${formatDuration(summary.durationMs)}`);

  if (summary.failed > 0) {
    console.error('\nFailed test scripts:');
    for (const result of summary.results.filter((item) => !item.passed)) {
      console.error(`  - ${result.testPath}`);
    }
    process.exitCode = 1;
  }
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
