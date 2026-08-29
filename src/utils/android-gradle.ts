import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import {
  parseAndroidGradleOutput,
  type ParsedAndroidGradleOutput,
} from '../engine/android-gradle-output.js';

export type AndroidGradleTask = 'assembleDebug' | 'testDebugUnitTest';

export interface AndroidGradleRuntimeConfig {
  workspaceRoot: string;
  javaHome: string;
  buildTimeoutMs: number;
  maxErrorBlockChars: number;
  maxLogTailChars: number;
}

export interface RunAndroidGradleOptions {
  quiet?: boolean;
  stacktrace?: boolean;
  offline?: boolean;
  includeLogTail?: boolean;
}

export interface RunAndroidGradleResult extends ParsedAndroidGradleOutput {
  task: AndroidGradleTask;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface AndroidGradleExecution {
  readonly settled: Promise<RunAndroidGradleResult>;
  readonly drained: Promise<void>;
  requestShutdownDetach(): void;
}

type TerminationReason = 'timeout' | 'cancelled' | 'failure';
type TerminationHelperSpawner = (
  command: string,
  args: readonly string[],
  options: {
    readonly windowsHide: boolean;
    readonly stdio: 'ignore';
  },
) => ChildProcess;

interface TerminationAttemptOptions {
  readonly spawnHelper?: TerminationHelperSpawner;
  readonly attemptTimeoutMs?: number;
  readonly reapGraceMs?: number;
}

const TERMINATION_GRACE_PERIOD_MS = 5_000;
export const ANDROID_GRADLE_RECOVERY_GRACE_PERIOD_MS = 30_000;
const TERMINATION_RETRY_INTERVAL_MS = 2_000;
const TERMINATION_ATTEMPT_TIMEOUT_MS = 3_000;
const TERMINATION_HELPER_REAP_GRACE_MS = 1_000;
const GRADLE_WRAPPER_COMMAND = '.\\gradlew.bat';
const lingeringShutdownDetachers = new Set<() => void>();

export function startAndroidGradleExecution(
  task: AndroidGradleTask,
  runtimeConfig: AndroidGradleRuntimeConfig,
  options: RunAndroidGradleOptions = {},
  signal: AbortSignal = new AbortController().signal,
  startedAt = Date.now(),
): AndroidGradleExecution {
  const args = buildGradleArgs(task, options);
  const command = formatDisplayCommand(args);
  const commandLine = buildWindowsCommandLine(args);
  let settleExecution!: (result: RunAndroidGradleResult) => void;
  let drainExecution!: () => void;
  let settledDone = false;
  let drainedDone = false;
  let child: ChildProcessWithoutNullStreams | undefined;
  let childClosed = false;
  let terminationReason: TerminationReason | undefined;
  let stdout = '';
  let stderr = '';
  let combinedOutput = '';
  let retainOutput = true;
  let shutdownDetachRequested = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let terminationGraceHandle: NodeJS.Timeout | undefined;
  let recoveryDeadlineHandle: NodeJS.Timeout | undefined;
  let recoveryRetryHandle: NodeJS.Timeout | undefined;
  const cleanupController = new AbortController();

  const settled = new Promise<RunAndroidGradleResult>((resolve) => {
    settleExecution = resolve;
  });
  const drained = new Promise<void>((resolve) => {
    drainExecution = resolve;
  });

  const appendStdout = (chunk: string): void => {
    if (!retainOutput) return;
    stdout += chunk;
    combinedOutput += chunk;
  };
  const appendStderr = (chunk: string): void => {
    if (!retainOutput) return;
    stderr += chunk;
    combinedOutput += chunk;
  };
  const appendSyntheticError = (message: string): void => {
    if (!retainOutput) return;
    stderr = appendLine(stderr, message);
    combinedOutput = appendLine(combinedOutput, message);
  };

  const settle = (exitCode: number | null): void => {
    if (settledDone) return;
    settledDone = true;
    retainOutput = false;
    clearTimeout(timeoutHandle);
    clearTimeout(terminationGraceHandle);
    settleExecution(buildResult({
      task,
      command,
      exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: terminationReason === 'timeout',
      cancelled: terminationReason === 'cancelled',
      stdout,
      stderr,
      combinedOutput,
    }, runtimeConfig, options.includeLogTail === true));
  };

  const finalDetach = (): void => {
    lingeringShutdownDetachers.delete(finalDetach);
    const activeChild = child;
    if (activeChild === undefined || childClosed) return;
    activeChild.unref();
    activeChild.stdin.destroy();
    activeChild.stdout.destroy();
    activeChild.stderr.destroy();
  };

  const drain = (optimistic: boolean): void => {
    if (drainedDone) return;
    drainedDone = true;
    clearTimeout(recoveryDeadlineHandle);
    clearInterval(recoveryRetryHandle);
    clearTimeout(timeoutHandle);
    clearTimeout(terminationGraceHandle);
    cleanupController.abort();
    if (optimistic && shutdownDetachRequested) finalDetach();
    if (optimistic && !childClosed && !shutdownDetachRequested) {
      lingeringShutdownDetachers.add(finalDetach);
    }
    drainExecution();
  };

  const startRecovery = (): void => {
    if (drainedDone || childClosed || recoveryDeadlineHandle !== undefined) return;
    recoveryRetryHandle = setInterval(() => {
      if (child !== undefined && !childClosed) {
        void terminateProcessTreeAttempt(child, cleanupController.signal);
      }
    }, TERMINATION_RETRY_INTERVAL_MS);
    recoveryDeadlineHandle = setTimeout(() => {
      // The process may survive this deadline. Stop retaining output and release
      // the workspace without allowing the old lease to affect a future owner.
      retainOutput = false;
      stdout = '';
      stderr = '';
      combinedOutput = '';
      drain(true);
    }, ANDROID_GRADLE_RECOVERY_GRACE_PERIOD_MS);
  };

  const beginTermination = (reason: TerminationReason): void => {
    if (terminationReason !== undefined || settledDone) return;
    terminationReason = reason;
    clearTimeout(timeoutHandle);
    if (reason === 'timeout') {
      appendSyntheticError(
        `error: Gradle process timed out after ${runtimeConfig.buildTimeoutMs}ms.`,
      );
    } else if (reason === 'cancelled') {
      appendSyntheticError('error: Gradle process was cancelled.');
    }

    if (child === undefined) {
      settle(null);
      drain(false);
      return;
    }

    void terminateProcessTreeAttempt(child, cleanupController.signal);
    terminationGraceHandle = setTimeout(() => {
      if (childClosed) return;
      appendSyntheticError(
        'error: Gradle process did not exit after the termination request.',
      );
      settle(null);
      startRecovery();
    }, TERMINATION_GRACE_PERIOD_MS);
  };

  const onAbort = (): void => beginTermination('cancelled');
  signal.addEventListener('abort', onAbort, { once: true });
  void settled.finally(() => {
    signal.removeEventListener('abort', onAbort);
  }).catch(() => {});

  const finishWithoutChild = (
    message: string,
    cancelled = false,
  ): void => {
    if (cancelled) terminationReason = 'cancelled';
    appendSyntheticError(message);
    settle(null);
    drain(false);
  };

  void (async () => {
    if (signal.aborted) {
      finishWithoutChild('error: Gradle process was cancelled.', true);
      return;
    }

    if (process.platform !== 'win32') {
      finishWithoutChild(
        'error: This MCP server supports Windows only because it runs gradlew.bat.',
      );
      return;
    }

    const gradlewPath = join(runtimeConfig.workspaceRoot, 'gradlew.bat');
    try {
      await access(gradlewPath);
    } catch {
      finishWithoutChild(`error: Gradle wrapper not found: ${gradlewPath}`);
      return;
    }

    if (signal.aborted) {
      finishWithoutChild('error: Gradle process was cancelled.', true);
      return;
    }

    try {
      child = spawn('cmd.exe', ['/d', '/s', '/c', commandLine], {
        cwd: runtimeConfig.workspaceRoot,
        env: createChildEnv(runtimeConfig.javaHome),
        windowsHide: true,
        stdio: 'pipe',
      });
    } catch (error: unknown) {
      finishWithoutChild(`error: Failed to start Gradle: ${errorMessage(error)}`);
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', appendStdout);
    child.stderr.on('data', appendStderr);
    child.on('error', (error: Error) => {
      appendSyntheticError(`error: Failed to start Gradle: ${error.message}`);
      if (child?.pid === undefined) {
        settle(null);
        drain(false);
      } else if (terminationReason === undefined) {
        beginTermination('failure');
      }
    });
    child.on('close', (exitCode: number | null) => {
      childClosed = true;
      lingeringShutdownDetachers.delete(finalDetach);
      clearTimeout(terminationGraceHandle);
      if (!settledDone) settle(exitCode);
      drain(false);
    });

    if (signal.aborted) {
      beginTermination('cancelled');
      return;
    }

    timeoutHandle = setTimeout(
      () => beginTermination('timeout'),
      runtimeConfig.buildTimeoutMs,
    );
    timeoutHandle.unref?.();
  })().catch((error: unknown) => {
    finishWithoutChild(`error: Failed to start Gradle: ${errorMessage(error)}`);
  });

  return {
    settled,
    drained,
    requestShutdownDetach() {
      shutdownDetachRequested = true;
      if (drainedDone && !childClosed) finalDetach();
    },
  };
}

export function getAndroidGradleDisplayCommand(
  task: AndroidGradleTask,
  options: RunAndroidGradleOptions = {},
): string {
  return formatDisplayCommand(buildGradleArgs(task, options));
}

export function detachLingeringAndroidGradleExecutionsForShutdown(): void {
  for (const detach of [...lingeringShutdownDetachers]) {
    detach();
  }
}

export async function runAndroidGradle(
  task: AndroidGradleTask,
  runtimeConfig: AndroidGradleRuntimeConfig,
  options: RunAndroidGradleOptions = {},
  signal?: AbortSignal,
): Promise<RunAndroidGradleResult> {
  return startAndroidGradleExecution(task, runtimeConfig, options, signal).settled;
}

function buildGradleArgs(
  task: AndroidGradleTask,
  options: RunAndroidGradleOptions,
): string[] {
  const args: string[] = [task];
  if (options.quiet !== false) args.push('-q');
  if (options.stacktrace === true) args.push('--stacktrace');
  if (options.offline === true) args.push('--offline');
  args.push('--no-daemon', '--console=plain');
  return args;
}

function formatDisplayCommand(args: string[]): string {
  return [GRADLE_WRAPPER_COMMAND, ...args].join(' ');
}

function buildWindowsCommandLine(args: string[]): string {
  return [quoteWindowsArgument(GRADLE_WRAPPER_COMMAND), ...args.map(quoteWindowsArgument)].join(' ');
}

function quoteWindowsArgument(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function createChildEnv(javaHome: string): NodeJS.ProcessEnv {
  const javaBinPath = join(javaHome, 'bin');
  const currentPath = process.env.Path ?? process.env.PATH ?? '';
  const nextPath = currentPath ? `${javaBinPath}${delimiter}${currentPath}` : javaBinPath;
  return {
    ...process.env,
    ANDROID_JAVA_HOME: javaHome,
    JAVA_HOME: javaHome,
    Path: nextPath,
    PATH: nextPath,
  };
}

async function terminateProcessTreeAttempt(
  child: ChildProcess,
  cleanupSignal: AbortSignal,
  options: TerminationAttemptOptions = {},
): Promise<void> {
  if (cleanupSignal.aborted) return;
  if (child.pid === undefined) {
    tryKillChild(child);
    return;
  }
  if (process.platform !== 'win32') {
    tryKillChild(child, 'SIGKILL');
    return;
  }

  await new Promise<void>((resolve) => {
    const spawnHelper: TerminationHelperSpawner = options.spawnHelper
      ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    const attemptTimeoutMs =
      options.attemptTimeoutMs ?? TERMINATION_ATTEMPT_TIMEOUT_MS;
    const reapGraceMs =
      options.reapGraceMs ?? TERMINATION_HELPER_REAP_GRACE_MS;
    let completed = false;
    let stopRequested = false;
    let helper: ChildProcess;
    let reapHandle: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timeoutHandle);
      clearTimeout(reapHandle);
      cleanupSignal.removeEventListener('abort', onCleanupAbort);
      resolve();
    };
    const requestHelperStop = (): void => {
      if (stopRequested) return;
      stopRequested = true;
      const terminationRequested = tryKillChild(helper);
      if (!terminationRequested) {
        helper.unref();
        finish();
        return;
      }
      reapHandle = setTimeout(() => {
        // A failed TerminateProcess request must not let the helper keep Node
        // alive beyond this attempt's own bounded cleanup window.
        helper.unref();
        finish();
      }, reapGraceMs);
    };
    const onCleanupAbort = (): void => {
      if (completed) return;
      stopRequested = true;
      tryKillChild(helper);
      helper.unref();
      finish();
    };

    try {
      helper = spawnHelper('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      tryKillChild(child);
      resolve();
      return;
    }

    helper.once('error', () => {
      tryKillChild(child);
      finish();
    });
    helper.once('close', (exitCode) => {
      if (exitCode !== 0) tryKillChild(child);
      finish();
    });
    const timeoutHandle = setTimeout(() => {
      requestHelperStop();
      tryKillChild(child);
    }, attemptTimeoutMs);
    cleanupSignal.addEventListener('abort', onCleanupAbort, { once: true });
    if (cleanupSignal.aborted) onCleanupAbort();
  });
}

export const androidGradleInternalForTests = Object.freeze({
  terminateProcessTreeAttempt(
    child: ChildProcess,
    cleanupSignal: AbortSignal,
    options: TerminationAttemptOptions,
  ): Promise<void> {
    return terminateProcessTreeAttempt(child, cleanupSignal, options);
  },
});

function tryKillChild(child: ChildProcess, signal?: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    // Termination is best effort; child close or the recovery deadline owns drain.
    return false;
  }
}

function buildResult(
  input: {
    task: AndroidGradleTask;
    command: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    cancelled: boolean;
    stdout: string;
    stderr: string;
    combinedOutput: string;
  },
  runtimeConfig: AndroidGradleRuntimeConfig,
  includeLogTail: boolean,
): RunAndroidGradleResult {
  const parsed = parseAndroidGradleOutput({
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    combinedOutput: input.combinedOutput,
    maxErrorBlockChars: runtimeConfig.maxErrorBlockChars,
    maxLogTailChars: runtimeConfig.maxLogTailChars,
    includeLogTail,
    cancelled: input.cancelled,
    timedOut: input.timedOut,
  });
  return {
    task: input.task,
    command: input.command,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    timedOut: input.timedOut,
    ...parsed,
  };
}

function appendLine(current: string, next: string): string {
  return current ? `${current}\n${next}` : next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
