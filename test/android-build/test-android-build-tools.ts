import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import androidAssembleDebugTool from '../../src/tools/android-assemble-debug.js';
import androidTestDebugUnitTestTool from '../../src/tools/android-test-debug-unit-test.js';
import {
  assert,
  assertIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

const baseContext = createTestToolRuntimeContext({ rootDir: PROJECT_ROOT });

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
    { stacktrace: 'yes' },
    baseContext,
  );

  assert(result.isError === true, 'Should fail on non-boolean parameter');
  assertIncludes(
    getResultText(result),
    "The 'stacktrace' parameter must be a boolean.",
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
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing Android build tools',
    tests: [
      { name: 'unknown field validation', run: testValidationErrorForUnknownField },
      { name: 'non-boolean validation', run: testValidationErrorForNonBoolean },
      { name: 'missing Android config', run: testMissingAndroidConfig },
      { name: 'missing gradle wrapper', run: testMissingGradleWrapper },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
