import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import {
  parseAndroidTestReports,
  type TestReportSummary,
} from '../engine/android-test-report.js';
import type { ToolCallResult } from './types.js';
import { textErrorResult } from './results.js';
import {
  readChangedAndroidTestReportFiles,
  snapshotAndroidTestReportFiles,
  type AndroidTestReportSnapshot,
} from '../utils/android-test-report-files.js';
import {
  getAndroidGradleDisplayCommand,
  startAndroidGradleExecution,
  type AndroidGradleRuntimeConfig,
  type AndroidGradleTask,
  type RunAndroidGradleOptions,
  type RunAndroidGradleResult,
} from '../utils/android-gradle.js';
import {
  androidGradleGateRegistry,
  type AndroidGradleGateExecution,
} from '../utils/android-gradle-gate.js';

export interface AndroidGradleToolArgs {
  quiet?: boolean;
  stacktrace?: boolean;
  offline?: boolean;
  includeLogTail?: boolean;
}

type ToolAndroidConfig = NonNullable<ToolRuntimeContext['android']>;

interface AndroidGradleFailureEnhancement {
  firstErrorBlock?: string;
  testReport?: TestReportSummary;
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

  if (typeof args.include_log_tail === 'boolean') {
    options.includeLogTail = args.include_log_tail;
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
  callerSignal: AbortSignal,
): Promise<ToolCallResult> {
  const runtimeConfig = resolveAndroidGradleRuntimeConfig(context);
  if (!runtimeConfig.ok) {
    return textErrorResult(runtimeConfig.error);
  }

  const options = toRunAndroidGradleOptions(args);
  const gated = await androidGradleGateRegistry.run(
    runtimeConfig.value.workspaceRoot,
    callerSignal,
    (lease) => createAndroidGradleGateExecution(
      task,
      runtimeConfig.value,
      options,
      lease.signal,
    ),
  );

  if (gated.status === 'completed') {
    return gated.value;
  }
  if (gated.status === 'cancelled') {
    return formatAndroidGradleToolResult(createQueuedCancellationResult(
      task,
      options,
    ));
  }
  return textErrorResult('The Android Gradle operation failed unexpectedly.');
}

function createAndroidGradleGateExecution(
  task: AndroidGradleTask,
  runtimeConfig: AndroidGradleRuntimeConfig,
  options: RunAndroidGradleOptions,
  operationSignal: AbortSignal,
): AndroidGradleGateExecution<ToolCallResult> {
  const activeStartedAt = Date.now();
  let execution:
    | ReturnType<typeof startAndroidGradleExecution>
    | undefined;
  let shutdownDetachRequested = false;
  const started = (async () => {
    const reportSnapshot = task === 'testDebugUnitTest'
      ? await trySnapshotAndroidTestReports(runtimeConfig.workspaceRoot)
      : null;
    execution = startAndroidGradleExecution(
      task,
      runtimeConfig,
      options,
      operationSignal,
      activeStartedAt,
    );
    if (shutdownDetachRequested) {
      execution.requestShutdownDetach();
    }
    return { execution, reportSnapshot };
  })();

  const settled = started.then(async ({ execution: activeExecution, reportSnapshot }) => {
    const result = await activeExecution.settled;
    const enhancement =
      task === 'testDebugUnitTest' && !result.success && !result.cancelled
        ? await buildTestFailureEnhancement(
            runtimeConfig.workspaceRoot,
            reportSnapshot,
            result.failedTask,
            runtimeConfig.maxErrorBlockChars,
          )
        : undefined;
    return formatAndroidGradleToolResult(result, enhancement);
  });
  const drained = started.then(
    ({ execution: activeExecution }) => activeExecution.drained,
  );

  return {
    settled,
    drained,
    requestShutdownDetach() {
      shutdownDetachRequested = true;
      execution?.requestShutdownDetach();
    },
  };
}

export function formatAndroidGradleToolResult(
  result: RunAndroidGradleResult,
  enhancement?: AndroidGradleFailureEnhancement,
): ToolCallResult {
  if (result.success) {
    return {
      content: [{ type: 'text', text: result.summary }],
      isError: false,
    };
  }

  const failure = {
    success: false,
    task: result.task,
    command: result.command,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    timed_out: result.timedOut,
    cancelled: result.cancelled,
    summary: result.cancelled ? 'BUILD CANCELLED' : 'BUILD FAILED',
    failed_task: result.failedTask,
    first_error_block: enhancement?.firstErrorBlock ?? result.firstErrorBlock,
    log_tail: result.logTail,
    test_report: enhancement?.testReport
      ? toAndroidTestReportPayload(enhancement.testReport)
      : undefined,
  };

  return textErrorResult(JSON.stringify(failure));
}

function toAndroidTestReportPayload(
  report: TestReportSummary,
) {
  return {
    status: report.status,
    report_files: report.reportFiles,
    tests: report.tests,
    failures: report.failures,
    errors: report.errors,
    skipped: report.skipped,
    failed_tests: report.failedTests?.map((failedTest) => ({
      class_name: failedTest.className,
      name: failedTest.name,
      type: failedTest.type,
      message: failedTest.message,
      location: failedTest.location,
    })),
    omitted_failed_tests: report.omittedFailedTests,
  };
}

function createQueuedCancellationResult(
  task: AndroidGradleTask,
  options: RunAndroidGradleOptions,
): RunAndroidGradleResult {
  return {
    success: false,
    task,
    command: getAndroidGradleDisplayCommand(task, options),
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    cancelled: true,
    summary: 'BUILD CANCELLED',
    failedTask: null,
    firstErrorBlock: null,
  };
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
