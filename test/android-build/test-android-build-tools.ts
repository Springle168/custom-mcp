import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../../src/config.js';
import androidAssembleDebugTool from '../../src/tools/android-assemble-debug.js';
import androidTestDebugUnitTestTool from '../../src/tools/android-test-debug-unit-test.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertIncludes(text: string, substring: string, message: string): void {
  if (!text.includes(substring)) {
    throw new Error(
      `Assertion failed: ${message}\nExpected to find: "${substring}"\nIn text: ${text}`,
    );
  }
}

function getResultText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? '';
}

const baseConfig: Config = {
  rootDir: PROJECT_ROOT,
  lineEnding: 'auto',
  port: 3100,
};

async function testValidationErrorForUnknownField() {
  console.log('Test: unknown field validation');

  const result = await androidAssembleDebugTool.handler(
    { quiet: true, profile: true },
    baseConfig,
  );

  assert(result.isError === true, 'Should fail on unknown field');
  assertIncludes(
    getResultText(result),
    'Unknown parameter: profile',
    'Should explain the unknown field',
  );

  console.log('  ✓ Passed\n');
}

async function testValidationErrorForNonBoolean() {
  console.log('Test: non-boolean validation');

  const result = await androidTestDebugUnitTestTool.handler(
    { stacktrace: 'yes' },
    baseConfig,
  );

  assert(result.isError === true, 'Should fail on non-boolean parameter');
  assertIncludes(
    getResultText(result),
    "The 'stacktrace' parameter must be a boolean.",
    'Should explain the invalid parameter type',
  );

  console.log('  ✓ Passed\n');
}

async function testMissingAndroidConfig() {
  console.log('Test: missing Android config');

  const result = await androidAssembleDebugTool.handler({}, baseConfig);

  assert(result.isError === true, 'Should fail when Android config is missing');
  assertIncludes(
    getResultText(result),
    'android.workspaceRoot and android.javaHome',
    'Should explain required Android config keys',
  );

  console.log('  ✓ Passed\n');
}

async function testMissingGradleWrapper() {
  console.log('Test: missing gradle wrapper');

  const config: Config = {
    ...baseConfig,
    android: {
      workspaceRoot: PROJECT_ROOT,
      javaHome: 'C:/AndroidStudio/jbr',
      buildTimeoutMs: 1000,
      maxErrorBlockChars: 2500,
      maxLogTailChars: 4000,
    },
  };

  const result = await androidTestDebugUnitTestTool.handler({ quiet: true }, config);

  assert(result.isError === true, 'Should fail when gradlew.bat is missing');
  assertIncludes(
    getResultText(result),
    'Gradle wrapper not found',
    'Should surface missing wrapper error',
  );
  assertIncludes(
    getResultText(result),
    'BUILD FAILED',
    'Should keep failure summary in JSON output',
  );

  console.log('  ✓ Passed\n');
}

async function main() {
  console.log('='.repeat(60));
  console.log('Testing Android build tools');
  console.log('='.repeat(60));

  await testValidationErrorForUnknownField();
  await testValidationErrorForNonBoolean();
  await testMissingAndroidConfig();
  await testMissingGradleWrapper();

  console.log('='.repeat(60));
  console.log('All Android tool tests passed');
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
