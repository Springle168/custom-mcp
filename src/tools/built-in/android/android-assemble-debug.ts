import type { ToolRuntimeContext } from '../../../runtime/invocation/tool-context.js';
import type { ToolInvocationContext } from '../../../runtime/invocation/tool-invocation-context.js';
import type { MCPTool, ToolCallResult } from '../../types.js';
import { executeAndroidGradleTask } from './android-build-shared.js';
import { ANDROID_ASSEMBLE_DEBUG_TOOL_DEFINITION } from './android-build.definition.js';

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
