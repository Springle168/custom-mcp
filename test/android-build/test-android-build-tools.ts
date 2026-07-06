import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import androidAssembleDebugTool from '../../src/tools/android-assemble-debug.js';
import androidTestDebugUnitTestTool from '../../src/tools/android-test-debug-unit-test.js';
import { adaptToolCallResultForRequestPolicy } from '../../src/runtime/tool-result-adapter.js';
import type { RequestHeaderPolicy } from '../../src/runtime/request-header-policy.js';
import type { ToolCallResult } from '../../src/tools/types.js';
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

function policy(enabled: boolean): RequestHeaderPolicy {
  return {
    rulesConfigured: true,
    matchedRuleIndexes: enabled ? [0] : [],
    enabledFeatures: enabled ? ['structuredContent'] : [],
  };
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function assertNoStructuredPayload(result: ToolCallResult, label: string): void {
  assert(
    !('structuredPayload' in result),
    `${label}: should not include internal structuredPayload`,
  );
}

function assertNoStructuredContent(result: ToolCallResult, label: string): void {
  assert(
    !('structuredContent' in result),
    `${label}: should not include protocol structuredContent`,
  );
}

function parseCompactJsonText(result: ToolCallResult): unknown {
  const text = getResultText(result);
  const parsed = JSON.parse(text) as unknown;

  assertEqual(text, JSON.stringify(parsed), 'Failure content text should be compact JSON');
  return parsed;
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
  assertNoStructuredPayload(result, 'Unknown field validation error');
}

async function testValidationErrorForNonBoolean() {
  const result = await androidTestDebugUnitTestTool.handler(
    { stacktrace: 'yes' },
    baseContext,
  );

  assert(result.isError === true, 'Should fail on non-boolean parameter');
  assertIncludes(
    getResultText(result),
    "The 'stacktrace' parameter must be a boolean.",
    'Should explain the invalid parameter type',
  );
  assertNoStructuredPayload(result, 'Non-boolean validation error');
}

async function testMissingAndroidConfig() {
  const result = await androidAssembleDebugTool.handler({}, baseContext);

  assert(result.isError === true, 'Should fail when Android config is missing');
  assertIncludes(
    getResultText(result),
    'workspaceRoot, javaHome',
    'Should explain required Android config keys',
  );
  assertNoStructuredPayload(result, 'Missing Android config error');
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

  const result = await androidTestDebugUnitTestTool.handler({ quiet: true }, context);

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

  const payload = parseCompactJsonText(result);
  assert(
    'structuredPayload' in result,
    'Missing wrapper failure should include internal structuredPayload',
  );
  assertDeepEqual(
    result.structuredPayload,
    payload,
    'Missing wrapper structuredPayload should match compact JSON text',
  );
  assertNoStructuredContent(result, 'Missing wrapper handler result');
}

function testFailureFormatterPayload() {
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
  const payload = parseCompactJsonText(result);

  assertEqual(
    result.isError,
    true,
    'Android failure formatter should mark tool result as error',
  );
  assert(
    typeof payload === 'object' && payload !== null && !Array.isArray(payload),
    'Android failure formatter should return an object payload',
  );
  assertEqual(
    (payload as { success?: unknown }).success,
    false,
    'Android failure payload should set success: false',
  );
  assert(
    'structuredPayload' in result,
    'Android failure formatter should include internal structuredPayload',
  );
  assertDeepEqual(
    result.structuredPayload,
    payload,
    'Android failure structuredPayload should match compact JSON text',
  );
  assertNoStructuredContent(result, 'Android failure formatter result');
}

function testSuccessFormatterUsesTextFallbackShape() {
  const runResult: RunAndroidGradleResult = {
    success: true,
    task: 'testDebugUnitTest',
    command: '.\\gradlew.bat testDebugUnitTest --no-daemon',
    exitCode: 0,
    durationMs: 345,
    timedOut: false,
    summary: 'BUILD SUCCESSFUL',
    firstErrorBlock: null,
    logTail: null,
  };

  const result = formatAndroidGradleToolResult(runResult);

  assertEqual(
    result.isError,
    false,
    'Android success formatter should not mark tool result as error',
  );
  assertEqual(
    getResultText(result),
    'BUILD SUCCESSFUL',
    'Android success should keep natural text summary',
  );
  assertNoStructuredPayload(result, 'Android success formatter result');
  assertNoStructuredContent(result, 'Android success formatter result');
}

async function testAdapterPayloadAndFallbackShapes() {
  const failureResult = formatAndroidGradleToolResult({
    success: false,
    task: 'assembleDebug',
    command: '.\\gradlew.bat assembleDebug --no-daemon',
    exitCode: 1,
    durationMs: 1234,
    timedOut: false,
    summary: 'BUILD FAILED',
    firstErrorBlock: 'Compilation failed.',
    logTail: 'BUILD FAILED in 1s',
  });
  const failurePayload = parseCompactJsonText(failureResult);
  const adaptedFailure = adaptToolCallResultForRequestPolicy(failureResult, policy(true));

  assertDeepEqual(
    adaptedFailure.structuredContent,
    failurePayload,
    'Feature-on adapter should expose Android failure payload object',
  );
  assert(
    !('structuredPayload' in adaptedFailure),
    'Adapted Android failure should not expose internal structuredPayload',
  );

  const successResult = formatAndroidGradleToolResult({
    success: true,
    task: 'testDebugUnitTest',
    command: '.\\gradlew.bat testDebugUnitTest --no-daemon',
    exitCode: 0,
    durationMs: 345,
    timedOut: false,
    summary: 'BUILD SUCCESSFUL',
    firstErrorBlock: null,
    logTail: null,
  });
  const adaptedSuccess = adaptToolCallResultForRequestPolicy(successResult, policy(true));
  assertEqual(
    adaptedSuccess.structuredContent,
    '\nBUILD SUCCESSFUL\n',
    'Feature-on adapter should use text fallback for Android success summary',
  );

  const validationResult = await androidAssembleDebugTool.handler(
    { quiet: 'yes' },
    baseContext,
  );
  const adaptedValidation = adaptToolCallResultForRequestPolicy(validationResult, policy(true));
  assertNoStructuredPayload(validationResult, 'Android validation error');
  assertEqual(
    adaptedValidation.structuredContent,
    "\nThe 'quiet' parameter must be a boolean.\n",
    'Feature-on adapter should use text fallback for Android validation errors',
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
      { name: 'failure formatter provides payload', run: testFailureFormatterPayload },
      {
        name: 'success formatter uses text fallback shape',
        run: testSuccessFormatterUsesTextFallbackShape,
      },
      {
        name: 'adapter maps Android payload and fallback paths',
        run: testAdapterPayloadAndFallbackShapes,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
