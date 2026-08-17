import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import androidAssembleDebugTool from '../../src/tools/android-assemble-debug.js';
import androidTestDebugUnitTestTool from '../../src/tools/android-test-debug-unit-test.js';
import { formatAndroidGradleToolResult } from '../../src/tools/android-build-shared.js';
import type { RunAndroidGradleResult } from '../../src/utils/android-gradle.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const baseContext = createTestToolRuntimeContext({ rootDir: PROJECT_ROOT });

function parseCompactJsonText(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;

  assert(
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
    'Failure text should parse as a JSON object',
  );
  assertEqual(text, JSON.stringify(parsed), 'Failure text should be compact JSON');
  return parsed as Record<string, unknown>;
}

async function testValidationErrorForUnknownField() {
  const result = await androidAssembleDebugTool.handler(
    { quiet: true, profile: true },
    baseContext,
  );

  assert(result.isError === true, 'Should fail on unknown field');
  assertIncludes(
    getResultText(result),
    'Unknown parameter: profile',
    'Should explain the unknown field',
  );
}

async function testValidationErrorForNonBoolean() {
  const result = await androidTestDebugUnitTestTool.handler(
    { offline: 'yes' },
    baseContext,
  );

  assert(result.isError === true, 'Should fail on non-boolean parameter');
  assertIncludes(
    getResultText(result),
    "The 'offline' parameter must be a boolean.",
    'Should explain the invalid parameter type',
  );
}

async function testMissingAndroidConfig() {
  const result = await androidAssembleDebugTool.handler({}, baseContext);

  assert(result.isError === true, 'Should fail when Android config is missing');
  assertIncludes(
    getResultText(result),
    'workspaceRoot, javaHome',
    'Should explain required Android config keys',
  );
}

async function testMissingGradleWrapper() {
  const context = createTestToolRuntimeContext({
    rootDir: PROJECT_ROOT,
    android: {
      workspaceRoot: PROJECT_ROOT,
      javaHome: 'C:/AndroidStudio/jbr',
      buildTimeoutMs: 1000,
      maxErrorBlockChars: 2500,
      maxLogTailChars: 4000,
    },
  });

  const result = await androidTestDebugUnitTestTool.handler(
    { quiet: true, offline: true },
    context,
  );
  const failure = parseCompactJsonText(getResultText(result));

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
  assertEqual(
    failure.success,
    false,
    'Failure JSON should keep success=false',
  );
  assertIncludes(
    String(failure.command),
    '--offline',
    'Should pass offline mode to Gradle',
  );
}

function testFailureFormatterUsesCompactJson() {
  const runResult: RunAndroidGradleResult = {
    success: false,
    task: 'assembleDebug',
    command: '.\\gradlew.bat assembleDebug --no-daemon',
    exitCode: 1,
    durationMs: 1234,
    timedOut: false,
    summary: 'BUILD FAILED',
    firstErrorBlock: 'Execution failed for task :app:compileDebugKotlin.',
    logTail: 'BUILD FAILED in 1s',
  };

  const result = formatAndroidGradleToolResult(runResult);
  const failure = parseCompactJsonText(getResultText(result));

  assertEqual(result.isError, true, 'Failure formatter should return isError=true');
  assertEqual(failure.success, false, 'Failure JSON should keep success=false');
  assertEqual(failure.task, 'assembleDebug', 'Failure JSON should keep task');
  assertEqual(
    failure.firstErrorBlock,
    'Execution failed for task :app:compileDebugKotlin.',
    'Failure JSON should keep firstErrorBlock',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing Android build tools',
    tests: [
      { name: 'unknown field validation', run: testValidationErrorForUnknownField },
      { name: 'non-boolean validation', run: testValidationErrorForNonBoolean },
      { name: 'missing Android config', run: testMissingAndroidConfig },
      { name: 'missing gradle wrapper', run: testMissingGradleWrapper },
      { name: 'failure formatter uses compact JSON', run: testFailureFormatterUsesCompactJson },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
