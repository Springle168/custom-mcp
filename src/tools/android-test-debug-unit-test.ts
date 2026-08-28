import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { MCPTool, ToolCallResult } from './types.js';
import {
  ANDROID_GRADLE_TOOL_INPUT_SCHEMA,
  executeAndroidGradleTask,
} from './android-build-shared.js';

const ANDROID_TEST_DEBUG_UNIT_TEST_TOOL_DEFINITION = {
  name: 'android_testDebugUnitTest' as const,
  description:
    'Runs the Android project debug unit tests with quiet Gradle output by default. Success returns BUILD SUCCESSFUL. Failure returns compact JSON with the failed task and a cleaned first error block. Set includeLogTail=true only when the default diagnosis is insufficient.',
  inputSchema: ANDROID_GRADLE_TOOL_INPUT_SCHEMA,
};

async function handleAndroidTestDebugUnitTest(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
): Promise<ToolCallResult> {
  return executeAndroidGradleTask('testDebugUnitTest', args, context);
}

const androidTestDebugUnitTestTool: MCPTool = {
  definition: ANDROID_TEST_DEBUG_UNIT_TEST_TOOL_DEFINITION,
  handler: handleAndroidTestDebugUnitTest,
};

export default androidTestDebugUnitTestTool;
