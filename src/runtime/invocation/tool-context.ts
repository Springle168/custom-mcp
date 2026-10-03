import type { LineEnding, RuntimeAndroidConfig, RuntimeConfigSnapshot } from '../../config.js';
import type { PathSafetyContext } from '../../utils/paths.js';
import type { FileAccessPolicyContext } from '../../utils/file-access-policy.js';

export interface ToolRuntimeContext {
  readonly pathSafetyContext: PathSafetyContext;
  readonly fileAccessPolicyContext: FileAccessPolicyContext;
  readonly lineEnding: LineEnding;
  readonly android?: RuntimeAndroidConfig;
  readonly missingAndroidConfigMessage: string;
}

export function createToolRuntimeContext(snapshot: RuntimeConfigSnapshot): ToolRuntimeContext {
  return {
    pathSafetyContext: snapshot.pathSafetyContext,
    fileAccessPolicyContext: snapshot.fileAccessPolicyContext,
    lineEnding: snapshot.lineEnding,
    ...(snapshot.android ? { android: snapshot.android } : {}),
    missingAndroidConfigMessage:
      `Android build config is not configured for selected workspace "${snapshot.workspaceId}". ` +
      `Add an android section to that workspace in ${snapshot.workspaceConfigFilePath} ` +
      'with workspaceRoot, javaHome, buildTimeoutMs, maxErrorBlockChars, and maxLogTailChars.',
  };
}
