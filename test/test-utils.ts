export type TestFn = () => void | Promise<void>;

export interface TestCase {
  name: string;
  run: TestFn;
}

export interface RunTestSuiteOptions {
  title: string;
  tests: TestCase[];
  beforeAll?: TestFn;
  afterAll?: TestFn;
  details?: string | string[];
}

export interface TestSuiteResult {
  passed: number;
  failed: number;
}

export interface TextResultLike {
  content?: Array<{ text?: string }>;
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';

const CONSOLE_METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error'];
const VERBOSE_TEST_OUTPUT = process.argv.includes('--verbose');

export function isVerboseTestOutput(): boolean {
  return VERBOSE_TEST_OUTPUT;
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Assertion failed: ${message}\nExpected: ${formatValue(expected)}\nActual: ${formatValue(actual)}`,
    );
  }
}

export function assertIncludes(
  text: string | null | undefined,
  substring: string,
  message: string,
): void {
  if (!text?.includes(substring)) {
    throw new Error(
      `Assertion failed: ${message}\nExpected to find: "${substring}"\nIn text: ${formatText(text)}`,
    );
  }
}

export function assertNotIncludes(
  text: string | null | undefined,
  substring: string,
  message: string,
): void {
  if (text?.includes(substring)) {
    throw new Error(
      `Assertion failed: ${message}\nDid not expect to find: "${substring}"\nIn text: ${formatText(text)}`,
    );
  }
}

export function getResultText(result: TextResultLike): string {
  return result.content?.[0]?.text ?? '';
}

export async function runTest(name: string, test: TestFn): Promise<void> {
  if (VERBOSE_TEST_OUTPUT) {
    console.log(`Test: ${name}`);
  }

  await test();

  if (VERBOSE_TEST_OUTPUT) {
    console.log('  ✓ Passed\n');
  }
}

export async function runTestSuite(
  options: RunTestSuiteOptions,
): Promise<TestSuiteResult> {
  if (VERBOSE_TEST_OUTPUT) {
    printDivider();
    console.log(options.title);
    printDivider();
    printDetails(options.details);
  } else {
    console.log();
    console.log(options.title);
  }

  let passed = 0;
  let failed = 0;

  if (options.beforeAll) {
    await options.beforeAll();
  }

  try {
    for (const testCase of options.tests) {
      try {
        if (VERBOSE_TEST_OUTPUT) {
          await runTest(testCase.name, testCase.run);
        } else {
          await runQuietTest(testCase.run);
        }

        passed++;
      } catch (error) {
        failed++;
        printFailure(testCase.name, error);
      }
    }
  } finally {
    if (options.afterAll) {
      await options.afterAll();
    }
  }

  if (VERBOSE_TEST_OUTPUT) {
    printDivider();
  }

  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (VERBOSE_TEST_OUTPUT) {
    printDivider();
  }

  if (failed > 0) {
    process.exit(1);
  }

  return { passed, failed };
}

async function runQuietTest(test: TestFn): Promise<void> {
  const originalMethods = new Map<ConsoleMethod, (...data: unknown[]) => void>();

  for (const method of CONSOLE_METHODS) {
    originalMethods.set(method, console[method].bind(console));
    console[method] = (): void => {};
  }

  try {
    await test();
  } finally {
    for (const method of CONSOLE_METHODS) {
      const original = originalMethods.get(method);
      if (original) {
        console[method] = original;
      }
    }
  }
}

function printFailure(name: string, error: unknown): void {
  if (VERBOSE_TEST_OUTPUT) {
    console.error(`  ✗ Failed: ${formatError(error)}\n`);
    return;
  }

  console.error(`Test: ${name}`);
  printFailureError(error);
  console.error('');
}

function printFailureError(error: unknown): void {
  const [firstLine = '', ...remainingLines] = formatError(error).split(/\r?\n/);

  console.error(`  ✗ Failed: ${firstLine}`);
  for (const line of remainingLines) {
    console.error(`    ${line}`);
  }
}

function printDivider(): void {
  console.log('='.repeat(24));
}

function printDetails(details: string | string[] | undefined): void {
  if (!details) return;

  const lines = Array.isArray(details) ? details : [details];
  for (const line of lines) {
    console.log(line);
  }
  console.log('');
}

function formatValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function formatText(text: string | null | undefined): string {
  if (text === null) return 'null';
  if (text === undefined) return 'undefined';

  const maxLength = 500;
  if (text.length <= maxLength) return text;
  return `${text.substring(0, maxLength)}...`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
