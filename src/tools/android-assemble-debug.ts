import type { Config } from '../config.js';
import type { MCPTool, ToolCallResult } from './types.js';
import {
  ANDROID_GRADLE_TOOL_INPUT_SCHEMA,
  executeAndroidGradleTask,
} from './android-build-shared.js';

const ANDROID_ASSEMBLE_DEBUG_TOOL_DEFINITION = {
  name: 'android.assembleDebug',
  description:
    'Runs .\\gradlew.bat assembleDebug in the configured android.workspaceRoot. Only supports quiet?: boolean and stacktrace?: boolean. Always uses the configured Android Studio JBR via JAVA_HOME and always appends --no-daemon. Success returns BUILD SUCCESSFUL. Failure returns a compact JSON summary with firstErrorBlock and logTail.',
  inputSchema: ANDROID_GRADLE_TOOL_INPUT_SCHEMA,
};

async function handleAndroidAssembleDebug(
  args: Record<string, unknown>,
  config: Config,
): Promise<ToolCallResult> {
  return executeAndroidGradleTask('assembleDebug', args, config);
}

const androidAssembleDebugTool: MCPTool = {
  definition: ANDROID_ASSEMBLE_DEBUG_TOOL_DEFINITION,
  handler: handleAndroidAssembleDebug,
};

export default androidAssembleDebugTool;
