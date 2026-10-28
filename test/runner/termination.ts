import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface TerminationResult {
  confirmed: boolean;
  detail?: string;
}

export interface TerminationOptions {
  platform?: NodeJS.Platform;
  spawnHelper?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  attemptTimeoutMs?: number;
  reapGraceMs?: number;
}

export function tryKill(child: ChildProcess): boolean {
  try {
    return child.kill('SIGKILL');
  } catch {
    return false;
  }
}

/**
 * Only the PID owned by this execution is targeted. A successful taskkill is
 * required on Windows: closing local pipes or killing only the root cannot
 * confirm that its process tree stopped.
 */
export async function terminateTestProcess(
  child: ChildProcess,
  signal: AbortSignal,
  options: TerminationOptions = {},
): Promise<TerminationResult> {
  if (signal.aborted) return { confirmed: false, detail: 'Cleanup deadline expired.' };
  if ((options.platform ?? process.platform) !== 'win32') {
    tryKill(child);
    // The executor additionally requires child close; Unix descendants are not owned.
    return { confirmed: true };
  }
  if (child.pid === undefined) {
    return { confirmed: false, detail: 'No spawned PID was available for taskkill.' };
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      confirmed: false,
      detail: 'Root process already exited; refusing taskkill against a potentially reused PID.',
    };
  }

  return new Promise((resolve) => {
    let helper: ChildProcess;
    let finished = false;
    let stopRequested = false;
    const timers: { attempt?: NodeJS.Timeout; reap?: NodeJS.Timeout } = {};

    const finish = (result: TerminationResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timers.attempt);
      clearTimeout(timers.reap);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const detachHelper = (): void => {
      helper.stdout?.destroy();
      helper.stderr?.destroy();
      helper.stdin?.destroy();
      helper.unref();
    };
    const onAbort = (): void => {
      if (finished) return;
      stopRequested = true;
      tryKill(helper);
      tryKill(child);
      detachHelper();
      finish({ confirmed: false, detail: 'Cleanup deadline expired during taskkill.' });
    };

    try {
      helper = (options.spawnHelper ?? spawn)('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (error) {
      tryKill(child);
      finish({ confirmed: false, detail: `Could not spawn taskkill: ${String(error)}` });
      return;
    }

    helper.on('error', (error) => {
      if (finished) return;
      // Settle first: a failed kill request may itself emit another error.
      finish({ confirmed: false, detail: `taskkill error: ${error.message}` });
      tryKill(child);
      tryKill(helper);
      detachHelper();
    });
    helper.once('close', (code) => {
      if (finished) return;
      if (code === 0 && !stopRequested) {
        finish({ confirmed: true });
      } else {
        tryKill(child);
        finish({
          confirmed: false,
          detail: stopRequested
            ? 'taskkill exceeded its attempt deadline.'
            : `taskkill exited ${code}.`,
        });
      }
    });
    timers.attempt = setTimeout(() => {
      stopRequested = true;
      // Reaping is bounded inside the executor's single overall cleanup budget.
      timers.reap = setTimeout(() => {
        detachHelper();
        finish({ confirmed: false, detail: 'taskkill did not close after termination.' });
      }, options.reapGraceMs ?? 1_000);
      tryKill(child);
      tryKill(helper);
    }, options.attemptTimeoutMs ?? 3_000);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
