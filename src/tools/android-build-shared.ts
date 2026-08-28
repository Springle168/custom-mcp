import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import {
  parseAndroidTestReports,
  type TestReportSummary,
} from '../engine/android-test-report.js';
import type { ToolCallResult } from './types.js';
import { textErrorResult, textResult } from './results.js';
import {
  readChangedAndroidTestReportFiles,
  snapshotAndroidTestReportFiles,
  type AndroidTestReportSnapshot,
} from '../utils/android-test-report-files.js';
import {
  runAndroidGradle,
  type AndroidGradleRuntimeConfig,
  type AndroidGradleTask,
  type RunAndroidGradleOptions,
  type RunAndroidGradleResult,
} from '../utils/android-gradle.js';

const ALLOWED_KEYS = new Set([
  'quiet',
  'stacktrace',
  'offline',
  'includeLogTail',
]);

export const ANDROID_GRADLE_TOOL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    quiet: {
      type: 'boolean',
      description: 'Reduces Gradle output when true. Defaults to true.',
    },
    stacktrace: {
      type: 'boolean',
      description: 'Includes a Gradle stack trace on failure when true. Defaults to false.',
    },
    offline: {
      type: 'boolean',
      description:
        "Uses Gradle's offline dependency resolution when true; required dependencies must already be cached. Defaults to false.",
    },
    includeLogTail: {
      type: 'boolean',
      description:
        'Includes a bounded tail of the normalized raw Gradle output on failure. Defaults to false.',
    },
  },
  additionalProperties: false,
};

export interface AndroidGradleToolArgs {
  quiet?: boolean;
  stacktrace?: boolean;
  offline?: boolean;
  includeLogTail?: boolean;
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
  failedTask: string | null;
  firstErrorBlock: string | null;
  logTail?: string;
  testReport?: TestReportSummary;
};

interface AndroidGradleFailureEnhancement {
  firstErrorBlock?: string;
  testReport?: TestReportSummary;
}

export function validateAndroidGradleToolArgs(
  args: Record<string, unknown>,
): string | null {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_KEYS.has(key)) {
      return `Unknown parameter: ${key}. Allowed parameters are: quiet, stacktrace, offline, includeLogTail.`;
    }
  }

  if (args.quiet !== undefined && typeof args.quiet !== 'boolean') {
    return "The 'quiet' parameter must be a boolean.";
  }

  if (args.stacktrace !== undefined && typeof args.stacktrace !== 'boolean') {
    return "The 'stacktrace' parameter must be a boolean.";
  }

  if (args.offline !== undefined && typeof args.offline !== 'boolean') {
    return "The 'offline' parameter must be a boolean.";
  }

  if (
    args.includeLogTail !== undefined &&
    typeof args.includeLogTail !== 'boolean'
  ) {
    return "The 'includeLogTail' parameter must be a boolean.";
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

  if (typeof args.offline === 'boolean') {
    options.offline = args.offline;
  }

  if (typeof args.includeLogTail === 'boolean') {
    options.includeLogTail = args.includeLogTail;
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

  const reportSnapshot =
    task === 'testDebugUnitTest'
      ? await trySnapshotAndroidTestReports(runtimeConfig.value.workspaceRoot)
      : null;
  const result = await runAndroidGradle(
    task,
    runtimeConfig.value,
    toRunAndroidGradleOptions(args),
  );
  const enhancement =
    task === 'testDebugUnitTest' && !result.success
      ? await buildTestFailureEnhancement(
          runtimeConfig.value.workspaceRoot,
          reportSnapshot,
          result.failedTask,
          runtimeConfig.value.maxErrorBlockChars,
        )
      : undefined;

  return formatAndroidGradleToolResult(result, enhancement);
}

export function formatAndroidGradleToolResult(
  result: RunAndroidGradleResult,
  enhancement?: AndroidGradleFailureEnhancement,
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
    failedTask: result.failedTask,
    firstErrorBlock: enhancement?.firstErrorBlock ?? result.firstErrorBlock,
    ...(result.logTail === undefined ? {} : { logTail: result.logTail }),
    ...(enhancement?.testReport === undefined
      ? {}
      : { testReport: enhancement.testReport }),
  };

  return textErrorResult(JSON.stringify(failure));
}

async function trySnapshotAndroidTestReports(
  workspaceRoot: string,
): Promise<AndroidTestReportSnapshot | null> {
  try {
    return await snapshotAndroidTestReportFiles(workspaceRoot);
  } catch {
    return null;
  }
}

async function buildTestFailureEnhancement(
  workspaceRoot: string,
  before: AndroidTestReportSnapshot | null,
  failedTask: string | null,
  maxErrorBlockChars: number,
): Promise<AndroidGradleFailureEnhancement | undefined> {
  if (!before) {
    return undefined;
  }

  try {
    const changed = await readChangedAndroidTestReportFiles(
      workspaceRoot,
      before,
    );

    if (changed.changedFileCount > 0) {
      if (changed.files.length === 0) {
        return {
          testReport: { status: 'parse_failed' },
        };
      }

      const parsed = parseAndroidTestReports(
        changed.files,
        undefined,
        maxErrorBlockChars,
      );
      return {
        ...(parsed.firstErrorBlock
          ? { firstErrorBlock: parsed.firstErrorBlock }
          : {}),
        testReport: parsed.summary,
      };
    }

    if (isRequestedTestTask(failedTask)) {
      return {
        testReport: { status: 'not_generated' },
      };
    }
  } catch {
    if (isRequestedTestTask(failedTask)) {
      return {
        testReport: { status: 'parse_failed' },
      };
    }
  }

  return undefined;
}

function isRequestedTestTask(failedTask: string | null): boolean {
  return (
    failedTask === 'testDebugUnitTest' ||
    failedTask?.endsWith(':testDebugUnitTest') === true
  );
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
