import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { ToolInvocationContext } from '../runtime/tool-invocation-context.js';
import type { MCPTool, ToolCallResult } from './types.js';
import {
  ANDROID_GRADLE_TOOL_INPUT_SCHEMA,
  executeAndroidGradleTask,
} from './android-build-shared.js';

const ANDROID_ASSEMBLE_DEBUG_TOOL_DEFINITION = {
  name: 'android_assembleDebug' as const,
  description:
    'Builds the Android project debug variant with quiet Gradle output by default. Success returns BUILD SUCCESSFUL. Failure returns compact JSON with the failed task and a cleaned first error block. Set includeLogTail=true only when the default diagnosis is insufficient.',
  inputSchema: ANDROID_GRADLE_TOOL_INPUT_SCHEMA,
};

async function handleAndroidAssembleDebug(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
  invocation: ToolInvocationContext,
): Promise<ToolCallResult> {
  return executeAndroidGradleTask('assembleDebug', args, context, invocation.signal);
}

const androidAssembleDebugTool: MCPTool = {
  definition: ANDROID_ASSEMBLE_DEBUG_TOOL_DEFINITION,
  handler: handleAndroidAssembleDebug,
};

export default androidAssembleDebugTool;
