import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function testValidationErrorForNonBooleanLogTail() {
  const result = await androidTestDebugUnitTestTool.handler(
    { includeLogTail: 'yes' },
    baseContext,
  );

  assert(result.isError === true, 'Should fail on non-boolean includeLogTail');
  assertIncludes(
    getResultText(result),
    "The 'includeLogTail' parameter must be a boolean.",
    'Should explain the invalid includeLogTail type',
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
  assertIncludes(
    String(failure.command),
    '-q',
    'Should use quiet mode by default',
  );
  assertIncludes(
    String(failure.command),
    '--console=plain',
    'Should force plain console output',
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
    failedTask: ':app:compileDebugKotlin',
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
  assertEqual(
    failure.failedTask,
    ':app:compileDebugKotlin',
    'Failure JSON should keep failedTask',
  );
}

async function testUnitTestFailureUsesGeneratedXmlReport() {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'custom-mcp-android-tool-'),
  );
  const gradlewPath = path.join(workspaceRoot, 'gradlew.bat');

  await writeFile(
    gradlewPath,
    [
      '@echo off',
      'set "REPORT_DIR=app\\build\\test-results\\testDebugUnitTest"',
      'if not exist "%REPORT_DIR%" mkdir "%REPORT_DIR%"',
      '> "%REPORT_DIR%\\TEST-DemoTest.xml" echo ^<testsuite tests="1" failures="1" errors="0" skipped="0"^>',
      '>> "%REPORT_DIR%\\TEST-DemoTest.xml" echo ^<testcase name="fails" classname="demo.DemoTest"^>^<failure message="Expected true but was false" type="java.lang.AssertionError"^>at demo.DemoTest.fails(DemoTest.kt:12)^</failure^>^</testcase^>',
      '>> "%REPORT_DIR%\\TEST-DemoTest.xml" echo ^</testsuite^>',
      '1>&2 echo FAILURE: Build failed with an exception.',
      '1>&2 echo * What went wrong:',
      "1>&2 echo Execution failed for task ':app:testDebugUnitTest'.",
      'exit /b 1',
    ].join('\r\n'),
    'utf8',
  );

  try {
    const context = createTestToolRuntimeContext({
      rootDir: PROJECT_ROOT,
      android: {
        workspaceRoot,
        javaHome: process.env.JAVA_HOME || 'C:/AndroidStudio/jbr',
        buildTimeoutMs: 5000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
    });
    const result = await androidTestDebugUnitTestTool.handler({}, context);
    const failure = parseCompactJsonText(getResultText(result));
    const testReport = failure.testReport as Record<string, unknown>;

    assertEqual(result.isError, true, 'Should return the Gradle failure');
    assertEqual(
      failure.failedTask,
      ':app:testDebugUnitTest',
      'Should extract the failed test task',
    );
    assertEqual(
      testReport.status,
      'generated',
      'Should attach the report generated by this invocation',
    );
    assertEqual(testReport.tests, 1, 'Should aggregate test count');
    assertIncludes(
      String(failure.firstErrorBlock),
      'DemoTest.kt:12',
      'Should prefer the XML test diagnosis',
    );
    assertEqual(
      Object.hasOwn(failure, 'logTail'),
      false,
      'Should omit logTail by default',
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testFailedTestTaskWithoutReportIsExplicit() {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'custom-mcp-android-tool-'),
  );
  await writeFile(
    path.join(workspaceRoot, 'gradlew.bat'),
    [
      '@echo off',
      '1>&2 echo FAILURE: Build failed with an exception.',
      '1>&2 echo * What went wrong:',
      "1>&2 echo Execution failed for task ':app:testDebugUnitTest'.",
      '1>&2 echo ^> There were failing tests.',
      'exit /b 1',
    ].join('\r\n'),
    'utf8',
  );

  try {
    const context = createTestToolRuntimeContext({
      rootDir: PROJECT_ROOT,
      android: {
        workspaceRoot,
        javaHome: process.env.JAVA_HOME || 'C:/AndroidStudio/jbr',
        buildTimeoutMs: 5000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
    });
    const result = await androidTestDebugUnitTestTool.handler({}, context);
    const failure = parseCompactJsonText(getResultText(result));
    const testReport = failure.testReport as Record<string, unknown>;

    assertEqual(
      testReport.status,
      'not_generated',
      'Should distinguish a failed test task without a new XML report',
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testCompileFailureDoesNotUseOldTestReport() {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'custom-mcp-android-tool-'),
  );
  const reportDir = path.join(
    workspaceRoot,
    'app',
    'build',
    'test-results',
    'testDebugUnitTest',
  );
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, 'TEST-OldFailure.xml'),
    '<testsuite tests="1" failures="1" errors="0" skipped="0"/>',
    'utf8',
  );
  await writeFile(
    path.join(workspaceRoot, 'gradlew.bat'),
    [
      '@echo off',
      '1>&2 echo e: file:///Demo.kt:1:1 Unresolved reference oldFailure',
      '1>&2 echo FAILURE: Build failed with an exception.',
      '1>&2 echo * What went wrong:',
      "1>&2 echo Execution failed for task ':app:compileDebugKotlin'.",
      'exit /b 1',
    ].join('\r\n'),
    'utf8',
  );

  try {
    const context = createTestToolRuntimeContext({
      rootDir: PROJECT_ROOT,
      android: {
        workspaceRoot,
        javaHome: process.env.JAVA_HOME || 'C:/AndroidStudio/jbr',
        buildTimeoutMs: 5000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
    });
    const result = await androidTestDebugUnitTestTool.handler({}, context);
    const failure = parseCompactJsonText(getResultText(result));

    assertEqual(
      Object.hasOwn(failure, 'testReport'),
      false,
      'Should not attribute an unchanged old report to a compile failure',
    );
    assertIncludes(
      String(failure.firstErrorBlock),
      'Unresolved reference oldFailure',
      'Should keep the current compile diagnosis',
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function testConcurrentUnitTestCallsAreSerializedPerWorkspace() {
  const workspaceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'custom-mcp-android-tool-'),
  );
  await writeFile(
    path.join(workspaceRoot, 'gradlew.bat'),
    [
      '@echo off',
      'if exist active-build.txt (',
      '  1>&2 echo error: overlapping test build',
      '  exit /b 1',
      ')',
      '> active-build.txt echo active',
      'powershell.exe -NoProfile -Command "Start-Sleep -Milliseconds 250"',
      'del active-build.txt',
      '1>&2 echo FAILURE: Build failed with an exception.',
      '1>&2 echo * What went wrong:',
      "1>&2 echo Execution failed for task ':app:testDebugUnitTest'.",
      'exit /b 1',
    ].join('\r\n'),
    'utf8',
  );

  try {
    const context = createTestToolRuntimeContext({
      rootDir: PROJECT_ROOT,
      android: {
        workspaceRoot,
        javaHome: process.env.JAVA_HOME || 'C:/AndroidStudio/jbr',
        buildTimeoutMs: 5000,
        maxErrorBlockChars: 2500,
        maxLogTailChars: 4000,
      },
    });
    const [first, second] = await Promise.all([
      androidTestDebugUnitTestTool.handler({}, context),
      androidTestDebugUnitTestTool.handler({}, context),
    ]);

    assertEqual(first.isError, true, 'First simulated build should fail');
    assertEqual(second.isError, true, 'Second simulated build should fail');
    assertEqual(
      getResultText(first).includes('overlapping test build'),
      false,
      'First build should not observe another report-attribution window',
    );
    assertEqual(
      getResultText(second).includes('overlapping test build'),
      false,
      'Second build should start only after the first attribution window closes',
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing Android build tools',
    tests: [
      { name: 'unknown field validation', run: testValidationErrorForUnknownField },
      { name: 'non-boolean validation', run: testValidationErrorForNonBoolean },
      { name: 'non-boolean log tail validation', run: testValidationErrorForNonBooleanLogTail },
      { name: 'missing Android config', run: testMissingAndroidConfig },
      { name: 'missing gradle wrapper', run: testMissingGradleWrapper },
      { name: 'failure formatter uses compact JSON', run: testFailureFormatterUsesCompactJson },
      { name: 'unit test failure uses generated XML report', run: testUnitTestFailureUsesGeneratedXmlReport },
      { name: 'failed test task without report', run: testFailedTestTaskWithoutReportIsExplicit },
      { name: 'compile failure ignores old test report', run: testCompileFailureDoesNotUseOldTestReport },
      { name: 'concurrent test calls are serialized', run: testConcurrentUnitTestCallsAreSerializedPerWorkspace },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
