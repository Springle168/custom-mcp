import type {
  LineEnding,
  RuntimeAndroidConfig,
  RuntimeConfigSnapshot,
} from '../config.js';
import type { PathSafetyContext } from '../utils/paths.js';

export interface ToolRuntimeContext {
  readonly pathSafetyContext: PathSafetyContext;
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
    lineEnding: snapshot.lineEnding,
    askUser: {
      makeUrl: (sessionId: string) => `http://localhost:${snapshot.port}/ask/${sessionId}`,
    },
    ...(snapshot.android ? { android: snapshot.android } : {}),
    missingAndroidConfigMessage:
      `Android build config is not configured for workspace "${snapshot.workspaceId}". ` +
      `Add an android section with workspaceRoot, javaHome, buildTimeoutMs, maxErrorBlockChars, and maxLogTailChars to ${snapshot.configFilePath}.`,
  };
}
