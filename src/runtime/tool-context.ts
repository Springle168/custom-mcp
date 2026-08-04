import type {
  LineEnding,
  RuntimeAndroidConfig,
  RuntimeConfigSnapshot,
} from '../config.js';
import { buildHttpUrl } from '../utils/http-url.js';
import type { PathSafetyContext } from '../utils/paths.js';
import type { FileAccessPolicyContext } from '../utils/file-access-policy.js';

export interface ToolRuntimeContext {
  readonly pathSafetyContext: PathSafetyContext;
  readonly fileAccessPolicyContext: FileAccessPolicyContext;
  readonly lineEnding: LineEnding;
  readonly askUser: {
    readonly makeUrl: (sessionId: string) => string;
  };
  readonly android?: RuntimeAndroidConfig;
  readonly missingAndroidConfigMessage: string;
}

export function createToolRuntimeContext(
  snapshot: RuntimeConfigSnapshot,
): ToolRuntimeContext {
  return {
    pathSafetyContext: snapshot.pathSafetyContext,
    fileAccessPolicyContext: snapshot.fileAccessPolicyContext,
    lineEnding: snapshot.lineEnding,
    askUser: {
      makeUrl: (sessionId: string) =>
        buildHttpUrl(snapshot.host, snapshot.port, `/ask/${sessionId}`),
    },
    ...(snapshot.android ? { android: snapshot.android } : {}),
    missingAndroidConfigMessage:
      `Android build config is not configured for selected workspace "${snapshot.workspaceId}". ` +
      `Add an android section to that workspace in ${snapshot.configFilePath} ` +
      'with workspaceRoot, javaHome, buildTimeoutMs, maxErrorBlockChars, and maxLogTailChars.',
  };
}
