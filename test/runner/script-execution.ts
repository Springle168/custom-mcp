import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as path from 'node:path';
import { terminateTestProcess, tryKill, type TerminationResult } from './termination.js';

export const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000;
export const MAX_TIMER_MS = 2_147_483_647;
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;
const CLEANUP_TIMEOUT_MS = 5_000;

export interface TestExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  error?: Error;
  output?: string;
  timedOut?: boolean;
  timeoutMs?: number;
  cleanupConfirmed?: boolean;
  cleanupError?: string;
}

export interface ScriptExecutionOptions {
  projectRoot: string;
  spawnChild?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  terminate?: (child: ChildProcess, signal: AbortSignal) => Promise<TerminationResult>;
  cleanupTimeoutMs?: number;
}

export function validateTimeoutMs(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new Error(`--timeout-ms must be a positive integer between 1 and ${MAX_TIMER_MS}.`);
  }
}

/**
 * The deadline covers spawn through close, including inherited pipe holders.
 * Cleanup has one separate bounded budget; detaching local handles never counts
 * as confirmation that an OS process stopped.
 */
export async function executeTestScriptProcess(
  testPath: string,
  verbose: boolean,
  timeoutMs: number,
  options: ScriptExecutionOptions,
): Promise<TestExecutionResult> {
  validateTimeoutMs(timeoutMs);
  const startedAt = performance.now();
  const args = ['--import', 'tsx', path.join(options.projectRoot, testPath)];
  if (verbose) args.push('--verbose');

  return new Promise((resolve) => {
    const output = new BoundedOutputBuffer();
    let child: ChildProcess;
    let finished = false;
    let closed = false;
    let rootExited = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: Error | undefined;
    let termination: TerminationResult | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const cleanupController = new AbortController();

    const onStdout = (chunk: Buffer): void => {
      output.append(chunk);
      if (verbose) process.stdout.write(chunk);
    };
    const onStderr = (chunk: Buffer): void => {
      output.append(chunk);
      if (verbose) process.stderr.write(chunk);
    };
    const finish = (cleanupConfirmed?: boolean, cleanupError?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      clearTimeout(cleanupTimer);
      child?.stdout?.off('data', onStdout);
      child?.stderr?.off('data', onStderr);
      if (cleanupConfirmed === false) {
        // Local release bounds runner liveness, not the lifetime of escaped children.
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.stdin?.destroy();
        child?.unref();
      }
      resolve({
        exitCode,
        signal: exitSignal,
        durationMs: performance.now() - startedAt,
        error: spawnError,
        output: output.toString(),
        timedOut,
        timeoutMs,
        cleanupConfirmed,
        cleanupError,
      });
    };
    const maybeFinishCleanup = (): void => {
      if (!termination || finished) return;
      if (!termination.confirmed) {
        finish(false, termination.detail ?? 'Process termination was not confirmed.');
      } else if (closed) {
        finish(true);
      }
    };
    const deadlineTimer = setTimeout(() => {
      if (finished) return;
      timedOut = true;
      cleanupTimer = setTimeout(() => {
        if (finished) return;
        cleanupController.abort();
        if (!rootExited) tryKill(child);
        finish(
          false,
          'Overall cleanup deadline expired before termination and close were confirmed.',
        );
      }, options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS);

      // A dependency may throw, reject, or never settle; the overall timer owns liveness.
      void Promise.resolve()
        .then(() =>
          rootExited
            ? {
                confirmed: false,
                detail:
                  'Root process exited before close; its former PID cannot safely identify remaining descendants.',
              }
            : (options.terminate ?? terminateTestProcess)(child, cleanupController.signal),
        )
        .then(
          (result) => {
            termination = result;
            maybeFinishCleanup();
          },
          (error: unknown) => {
            termination = { confirmed: false, detail: `Termination failed: ${String(error)}` };
            maybeFinishCleanup();
          },
        );
    }, timeoutMs);

    try {
      child = (options.spawnChild ?? spawn)(process.execPath, args, {
        cwd: options.projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      spawnError = error instanceof Error ? error : new Error(String(error));
      finish();
      return;
    }

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', (error) => {
      if (!finished) spawnError = error;
    });
    child.once('exit', () => {
      rootExited = true;
    });
    child.once('close', (code, signal) => {
      if (finished) return;
      closed = true;
      exitCode = code;
      exitSignal = signal;
      if (timedOut) {
        maybeFinishCleanup();
      } else {
        finish();
      }
    });
  });
}

class BoundedOutputBuffer {
  readonly #chunks: Buffer[] = [];
  #size = 0;
  #truncated = false;

  append(chunk: Buffer): void {
    const remaining = MAX_CAPTURED_OUTPUT_BYTES - this.#size;
    if (chunk.length > remaining) this.#truncated = true;
    if (remaining <= 0) return;
    const captured = chunk.subarray(0, remaining);
    this.#chunks.push(captured);
    this.#size += captured.length;
  }

  toString(): string | undefined {
    if (this.#size === 0 && !this.#truncated) return undefined;
    const output = Buffer.concat(this.#chunks, this.#size).toString('utf-8');
    return this.#truncated ? `${output}\n...[captured output truncated at 256 KB]\n` : output;
  }
}
