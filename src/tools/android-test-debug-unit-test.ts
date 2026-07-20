import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { MCPTool, ToolCallResult } from './types.js';
import {
  ANDROID_GRADLE_TOOL_INPUT_SCHEMA,
  executeAndroidGradleTask,
} from './android-build-shared.js';

const ANDROID_TEST_DEBUG_UNIT_TEST_TOOL_DEFINITION = {
  name: 'android.testDebugUnitTest',
  description:
    'Runs the Android project debug unit tests. All optional parameters default to false. Success returns BUILD SUCCESSFUL. Failure returns a compact JSON summary with firstErrorBlock and logTail, which may be truncated. If these details are insufficient to diagnose the failure, explain that limitation to the user instead of guessing.',
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
