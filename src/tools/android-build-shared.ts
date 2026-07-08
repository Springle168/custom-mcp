import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { ToolCallResult } from './types.js';
import { textErrorResult, textResult } from './results.js';
import {
  runAndroidGradle,
  type AndroidGradleRuntimeConfig,
  type AndroidGradleTask,
  type RunAndroidGradleOptions,
  type RunAndroidGradleResult,
} from '../utils/android-gradle.js';

const ALLOWED_KEYS = new Set(['quiet', 'stacktrace']);

export const ANDROID_GRADLE_TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    quiet: {
      type: 'boolean',
      description: 'Optional. If true, adds -q to reduce Gradle output.',
    },
    stacktrace: {
      type: 'boolean',
      description: 'Optional. If true, adds --stacktrace for more failure detail.',
    },
  },
  additionalProperties: false,
};

export interface AndroidGradleToolArgs {
  quiet?: boolean;
  stacktrace?: boolean;
}

type ToolAndroidConfig = NonNullable<ToolRuntimeContext['android']>;

export type AndroidGradleToolFailure = {
  success: false;
  task: RunAndroidGradleResult['task'];
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  summary: 'BUILD FAILED';
  firstErrorBlock: string | null;
  logTail: string | null;
};

export function validateAndroidGradleToolArgs(
  args: Record<string, unknown>,
): string | null {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_KEYS.has(key)) {
      return `Unknown parameter: ${key}. Allowed parameters are: quiet, stacktrace.`;
    }
  }

  if (args.quiet !== undefined && typeof args.quiet !== 'boolean') {
    return "The 'quiet' parameter must be a boolean.";
  }

  if (args.stacktrace !== undefined && typeof args.stacktrace !== 'boolean') {
    return "The 'stacktrace' parameter must be a boolean.";
  }

  return null;
}

export function toRunAndroidGradleOptions(
  args: Record<string, unknown>,
): RunAndroidGradleOptions {
  const options: RunAndroidGradleOptions = {};

  if (typeof args.quiet === 'boolean') {
    options.quiet = args.quiet;
  }

  if (typeof args.stacktrace === 'boolean') {
    options.stacktrace = args.stacktrace;
  }

  return options;
}

export function resolveAndroidGradleRuntimeConfig(
  context: ToolRuntimeContext,
): { ok: true; value: AndroidGradleRuntimeConfig } | { ok: false; error: string } {
  if (!context.android) {
    return {
      ok: false,
      error: context.missingAndroidConfigMessage,
    };
  }

  return {
    ok: true,
    value: toRuntimeConfig(context.android),
  };
}

export async function executeAndroidGradleTask(
  task: AndroidGradleTask,
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
): Promise<ToolCallResult> {
  const validationError = validateAndroidGradleToolArgs(args);
  if (validationError) {
    return textErrorResult(validationError);
  }

  const runtimeConfig = resolveAndroidGradleRuntimeConfig(context);
  if (!runtimeConfig.ok) {
    return textErrorResult(runtimeConfig.error);
  }

  const result = await runAndroidGradle(
    task,
    runtimeConfig.value,
    toRunAndroidGradleOptions(args),
  );

  return formatAndroidGradleToolResult(result);
}

export function formatAndroidGradleToolResult(
  result: RunAndroidGradleResult,
): ToolCallResult {
  if (result.success) {
    return textResult(result.summary);
  }

  const failure: AndroidGradleToolFailure = {
    success: false,
    task: result.task,
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    summary: 'BUILD FAILED',
    firstErrorBlock: result.firstErrorBlock,
    logTail: result.logTail,
  };

  return textErrorResult(JSON.stringify(failure));
}

function toRuntimeConfig(androidConfig: ToolAndroidConfig): AndroidGradleRuntimeConfig {
  if (!androidConfig.workspaceRoot || !androidConfig.javaHome) {
    throw new Error('Android build config is incomplete.');
  }

  return {
    workspaceRoot: androidConfig.workspaceRoot,
    javaHome: androidConfig.javaHome,
    buildTimeoutMs: androidConfig.buildTimeoutMs,
    maxErrorBlockChars: androidConfig.maxErrorBlockChars,
    maxLogTailChars: androidConfig.maxLogTailChars,
  };
}
