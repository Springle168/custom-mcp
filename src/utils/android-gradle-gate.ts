import path from 'node:path';

/**
 * A controlled execution result. Cancellation is represented as data so callers
 * can distinguish an admission outcome from an unexpected operation failure.
 */
export type AndroidGradleGateResult<T> =
  | {
    status: 'completed';
    value: T;
  }
  | {
    status: 'cancelled';
    reason: AndroidGradleGateCancellationReason;
  }
  | {
    status: 'failed';
    error: unknown;
  };

export type AndroidGradleGateCancellationReason =
  | 'caller-aborted'
  | 'registry-closed';

/**
 * The two execution milestones the gate needs to coordinate.
 *
 * `settled` returns the controlled operation result to its caller. `drained`
 * marks the point at which another Gradle invocation may safely take the same
 * workspace gate. They intentionally remain separate because process cleanup
 * can outlive a user-visible execution result.
 */
export interface AndroidGradleGateExecution<T> {
  readonly settled: Promise<T>;
  readonly drained: Promise<void>;
  requestShutdownDetach?(): void;
}

/**
 * Runtime-owned ownership for one admitted workspace operation.
 *
 * The signal is never the caller signal directly. It is owned by the active
 * lease so either caller cancellation or registry shutdown can cancel the same
 * Gradle execution without coupling shutdown to request/session propagation.
 */
export interface AndroidGradleGateLease {
  readonly id: number;
  readonly signal: AbortSignal;
}

export type AndroidGradleGateOperation<T> = (
  lease: AndroidGradleGateLease,
) => AndroidGradleGateExecution<T>;

interface GateWaiter {
  readonly id: number;
  readonly callerSignal: AbortSignal;
  readonly start: (lease: ActiveLease) => void;
  readonly cancel: (reason: AndroidGradleGateCancellationReason) => void;
  abortListener: (() => void) | undefined;
  state: 'queued' | 'admitted' | 'cancelled';
}

interface ActiveLease extends AndroidGradleGateLease {
  readonly callerSignal: AbortSignal;
  readonly controller: AbortController;
  readonly callerAbortListener: () => void;
  shutdownDetach: (() => void) | undefined;
}

/**
 * Process-wide Android/Gradle workspace admission registry.
 *
 * A registry is intentionally Android-specific rather than a reusable task
 * scheduler. One workspace entry serializes only Gradle work for that configured
 * workspace; entries for distinct workspace keys remain independent.
 */
export class AndroidGradleGateRegistry {
  private readonly entries = new Map<string, WorkspaceGate>();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private nextWaiterId = 1;
  private nextLeaseId = 1;

  /** Number of live workspace entries, exposed for focused lifecycle tests. */
  public get workspaceCount(): number {
    return this.entries.size;
  }

  /**
   * Admits an Android operation for `workspaceRoot` in FIFO order.
   *
   * The returned promise resolves as soon as the operation's `settled` promise
   * becomes terminal. The associated workspace remains owned until `drained`
   * is also terminal, including when either operation promise rejects.
   */
  public run<T>(
    workspaceRoot: string,
    callerSignal: AbortSignal,
    operation: AndroidGradleGateOperation<T>,
  ): Promise<AndroidGradleGateResult<T>> {
    if (this.closed) {
      return Promise.resolve({
        status: 'cancelled',
        reason: 'registry-closed',
      });
    }

    const key = path.resolve(workspaceRoot).toLowerCase();
    let gate = this.entries.get(key);
    if (!gate) {
      gate = new WorkspaceGate(
        key,
        () => this.nextWaiterId++,
        () => this.nextLeaseId++,
        (idleGate) => this.cleanupIdleEntry(idleGate),
      );
      this.entries.set(key, gate);
    }

    return gate.enqueue(callerSignal, operation);
  }

  /**
   * Stops all future admission, cancels queued calls, and aborts every active
   * lease. The promise resolves only after all active release barriers finish.
   * Repeated calls return the same promise and never restart shutdown work.
   */
  public close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closed = true;
    const gates = [...this.entries.values()];
    let resolveClose: () => void;
    this.closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    for (const gate of gates) {
      gate.close();
    }

    void Promise.all(gates.map((gate) => gate.waitForIdle())).then(
      () => resolveClose(),
      () => resolveClose(),
    );

    return this.closePromise;
  }

  private cleanupIdleEntry(gate: WorkspaceGate): void {
    if (!gate.isIdle || this.entries.get(gate.key) !== gate) {
      return;
    }

    this.entries.delete(gate.key);
  }
}

class WorkspaceGate {
  private readonly queue: GateWaiter[] = [];
  private readonly idleResolvers: Array<() => void> = [];
  private active: ActiveLease | undefined;
  private closing = false;

  public constructor(
    public readonly key: string,
    private readonly createWaiterId: () => number,
    private readonly createLeaseId: () => number,
    private readonly onIdle: (gate: WorkspaceGate) => void,
  ) {}

  public get isIdle(): boolean {
    return this.active === undefined && this.queue.length === 0;
  }

  public enqueue<T>(
    callerSignal: AbortSignal,
    operation: AndroidGradleGateOperation<T>,
  ): Promise<AndroidGradleGateResult<T>> {
    return new Promise((resolve) => {
      const waiter: GateWaiter = {
        id: this.createWaiterId(),
        callerSignal,
        start: (lease) => this.startOperation(lease, operation, resolve),
        cancel: (reason) => resolve({ status: 'cancelled', reason }),
        abortListener: undefined,
        state: 'queued',
      };

      if (callerSignal.aborted) {
        this.cancelWaiter(waiter, 'caller-aborted');
        this.notifyIfIdle();
        return;
      }

      waiter.abortListener = () => {
        this.cancelQueuedWaiter(waiter, 'caller-aborted');
      };
      callerSignal.addEventListener('abort', waiter.abortListener, { once: true });
      this.queue.push(waiter);
      this.admitNext();
    });
  }

  public close(): void {
    this.closing = true;
    for (const waiter of [...this.queue]) {
      this.cancelQueuedWaiter(waiter, 'registry-closed');
    }

    this.active?.controller.abort();
    this.active?.shutdownDetach?.();
    this.notifyIfIdle();
  }

  public waitForIdle(): Promise<void> {
    if (this.isIdle) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private admitNext(): void {
    if (this.active) {
      return;
    }

    if (this.closing) {
      this.notifyIfIdle();
      return;
    }

    while (this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (!waiter || waiter.state !== 'queued') {
        continue;
      }

      if (waiter.callerSignal.aborted) {
        this.cancelWaiter(waiter, 'caller-aborted');
        continue;
      }

      waiter.state = 'admitted';
      this.removeWaiterAbortListener(waiter);
      const lease = this.createLease(waiter.callerSignal);
      this.active = lease;
      waiter.start(lease);
      return;
    }

    this.notifyIfIdle();
  }

  private createLease(callerSignal: AbortSignal): ActiveLease {
    const controller = new AbortController();
    const callerAbortListener = () => controller.abort();
    callerSignal.addEventListener('abort', callerAbortListener, { once: true });

    // AbortSignal does not replay a prior abort to listeners added afterwards.
    // This closes the handoff race between the final queued check and listener
    // registration before the operation can start Gradle work.
    if (callerSignal.aborted) {
      controller.abort();
    }

    return {
      id: this.createLeaseId(),
      signal: controller.signal,
      callerSignal,
      controller,
      callerAbortListener,
      shutdownDetach: undefined,
    };
  }

  private startOperation<T>(
    lease: ActiveLease,
    operation: AndroidGradleGateOperation<T>,
    resolveResult: (result: AndroidGradleGateResult<T>) => void,
  ): void {
    let execution: AndroidGradleGateExecution<T>;
    try {
      execution = operation(lease);
      lease.shutdownDetach = execution.requestShutdownDetach?.bind(execution);
    } catch (error) {
      resolveResult({ status: 'failed', error });
      this.releaseLease(lease);
      return;
    }

    let settled: Promise<void>;
    let drained: Promise<void>;
    try {
      settled = Promise.resolve(execution.settled).then(
        (value) => {
          resolveResult({ status: 'completed', value });
        },
        (error: unknown) => {
          resolveResult({ status: 'failed', error });
        },
      );
      drained = Promise.resolve(execution.drained).then(
        () => undefined,
        () => undefined,
      );
    } catch (error) {
      resolveResult({ status: 'failed', error });
      this.releaseLease(lease);
      return;
    }

    // Both branches above convert rejection to fulfillment. This observes all
    // operation promises even when the caller has already received `settled`.
    void Promise.all([settled, drained]).then(() => {
      this.releaseLease(lease);
    });
  }

  private releaseLease(lease: ActiveLease): void {
    // A late lifecycle event belongs only to the lease that created it. It must
    // never release a newer owner for the same workspace key.
    if (this.active !== lease) {
      return;
    }

    lease.callerSignal.removeEventListener('abort', lease.callerAbortListener);
    this.active = undefined;
    this.admitNext();
    this.notifyIfIdle();
  }

  private cancelQueuedWaiter(
    waiter: GateWaiter,
    reason: AndroidGradleGateCancellationReason,
  ): void {
    if (waiter.state !== 'queued') {
      return;
    }

    const index = this.queue.indexOf(waiter);
    if (index === -1) {
      return;
    }

    this.queue.splice(index, 1);
    this.cancelWaiter(waiter, reason);
    this.admitNext();
    this.notifyIfIdle();
  }

  private cancelWaiter(
    waiter: GateWaiter,
    reason: AndroidGradleGateCancellationReason,
  ): void {
    if (waiter.state !== 'queued') {
      return;
    }

    waiter.state = 'cancelled';
    this.removeWaiterAbortListener(waiter);
    waiter.cancel(reason);
  }

  private removeWaiterAbortListener(waiter: GateWaiter): void {
    if (!waiter.abortListener) {
      return;
    }

    waiter.callerSignal.removeEventListener('abort', waiter.abortListener);
    waiter.abortListener = undefined;
  }

  private notifyIfIdle(): void {
    if (!this.isIdle) {
      return;
    }

    for (const resolve of this.idleResolvers.splice(0)) {
      resolve();
    }
    this.onIdle(this);
  }
}

/** Shared Android gate registry for the current custom-mcp process. */
export const androidGradleGateRegistry = new AndroidGradleGateRegistry();
