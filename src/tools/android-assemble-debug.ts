import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { MCPTool, ToolCallResult } from './types.js';
import {
  ANDROID_GRADLE_TOOL_INPUT_SCHEMA,
  executeAndroidGradleTask,
} from './android-build-shared.js';

const ANDROID_ASSEMBLE_DEBUG_TOOL_DEFINITION = {
  name: 'android.assembleDebug',
  description:
    'Builds the Android project debug variant. All optional parameters default to false. Success returns BUILD SUCCESSFUL. Failure returns a compact JSON summary with firstErrorBlock and logTail, which may be truncated. If these details are insufficient to diagnose the failure, explain that limitation to the user instead of guessing.',
  inputSchema: ANDROID_GRADLE_TOOL_INPUT_SCHEMA,
};

async function handleAndroidAssembleDebug(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
): Promise<ToolCallResult> {
  return executeAndroidGradleTask('assembleDebug', args, context);
}

const androidAssembleDebugTool: MCPTool = {
  definition: ANDROID_ASSEMBLE_DEBUG_TOOL_DEFINITION,
  handler: handleAndroidAssembleDebug,
};

export default androidAssembleDebugTool;
