/** The fixed v1 maximum number of operations that may be locally draining. */
export const EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES = 8;

/** The fixed v1 maximum number of FIFO-waiting operations. */
export const EXTERNAL_ROUTING_MAX_PENDING_EXCHANGES = 64;

/**
 * Input admitted to the external-routing operation callback. The runtime does
 * not interpret the input; canonical protocol, HTTP, and Processor adapters
 * remain outside this concurrency boundary.
 */
export interface ExternalRoutingRuntimeInvocation<TInput> {
  readonly input: TInput;
  /** Caller-owned cancellation, relayed into one runtime-owned controller. */
  readonly signal?: AbortSignal;
}

/**
 * An operation exposes its caller-visible result separately from local drain.
 * `drained` must complete after the operation has released all resources that
 * consume an active runtime slot, even when `settled` completed earlier.
 */
export interface ExternalRoutingOperationExchange<TOutcome> {
  readonly settled: Promise<TOutcome>;
  readonly drained: Promise<void>;
}

/**
 * The injected implementation starts exactly one admitted operation. It must
 * observe `signal` before beginning each later stage; the runtime can abort
 * that signal but cannot prevent implementation-specific work by itself.
 */
export type ExternalRoutingOperation<TInput, TOutcome> = (
  input: TInput,
  signal: AbortSignal,
) => ExternalRoutingOperationExchange<TOutcome>;

/** Runtime-controlled outcomes intentionally contain no implementation error. */
export type ExternalRoutingRuntimeFailureKind = 'capacity' | 'cancelled' | 'internal';

export interface ExternalRoutingRuntimeFailure {
  readonly kind: ExternalRoutingRuntimeFailureKind;
}

/**
 * Wraps a successful operation callback outcome so it cannot collide with the
 * runtime's stable capacity, cancellation, and internal failure outcomes.
 */
export interface ExternalRoutingRuntimeOperationOutcome<TOutcome> {
  readonly kind: 'operation';
  readonly outcome: TOutcome;
}

export type ExternalRoutingRuntimeOutcome<TOutcome> =
  | ExternalRoutingRuntimeFailure
  | ExternalRoutingRuntimeOperationOutcome<TOutcome>;

type InvocationPhase = 'pending' | 'active' | 'drained';

interface InvocationRecord<TInput, TOutcome> {
  readonly input: TInput;
  readonly callerSignal: AbortSignal | undefined;
  readonly completion: Promise<ExternalRoutingRuntimeOutcome<TOutcome>>;
  readonly drainCompletion: Promise<void>;
  readonly resolveCompletion: (outcome: ExternalRoutingRuntimeOutcome<TOutcome>) => void;
  readonly resolveDrain: () => void;
  phase: InvocationPhase;
  settled: boolean;
  drained: boolean;
  operationStarted: boolean;
  controller: AbortController | undefined;
  callerAbortListener: (() => void) | undefined;
}

const CAPACITY_OUTCOME: ExternalRoutingRuntimeFailure = Object.freeze({ kind: 'capacity' });
const CANCELLED_OUTCOME: ExternalRoutingRuntimeFailure = Object.freeze({ kind: 'cancelled' });
const INTERNAL_OUTCOME: ExternalRoutingRuntimeFailure = Object.freeze({ kind: 'internal' });

/**
 * Owner-scoped admission runtime for external routing exchanges.
 *
 * Admission and registry updates are synchronous. An admitted operation keeps
 * its active slot until its own `drained` promise settles, independently of
 * when the caller-visible `settled` result resolves. This prevents a late
 * completion or cancellation from letting replacement work overlap local
 * cleanup that still owns a slot.
 */
export class ExternalRoutingRuntime<TInput, TOutcome> {
  readonly #operation: ExternalRoutingOperation<TInput, TOutcome>;
  readonly #activeInvocations = new Set<InvocationRecord<TInput, TOutcome>>();
  readonly #pendingInvocations: InvocationRecord<TInput, TOutcome>[] = [];
  #accepting = true;
  #closePromise: Promise<void> | undefined;

  constructor(operation: ExternalRoutingOperation<TInput, TOutcome>) {
    this.#operation = operation;
  }

  /** Active operations, including ones that have settled but are still draining. */
  get activeExchangeCount(): number {
    return this.#activeInvocations.size;
  }

  /** FIFO-waiting operations that have not started the injected callback. */
  get pendingExchangeCount(): number {
    return this.#pendingInvocations.length;
  }

  /**
   * Admits and starts one exchange, queues it FIFO, or returns a stable local
   * failure. A queued invocation never calls the injected operation before it
   * owns an active slot.
   */
  exchange(
    invocation: ExternalRoutingRuntimeInvocation<TInput>,
  ): Promise<ExternalRoutingRuntimeOutcome<TOutcome>> {
    return this.#admitAndRegister(invocation);
  }

  /**
   * Idempotently stops admission, cancels queued work, aborts active work, and
   * waits only for active local drain. Callers may already have received a
   * settled result while the close still waits for their resource cleanup.
   */
  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#accepting = false;
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    this.#closePromise = closePromise;

    const pending = this.#pendingInvocations.splice(0);
    for (const invocation of pending) {
      if (invocation.phase !== 'pending') {
        continue;
      }
      this.#settle(invocation, CANCELLED_OUTCOME);
      invocation.phase = 'drained';
      invocation.drained = true;
      invocation.resolveDrain();
    }

    const active = [...this.#activeInvocations];
    for (const invocation of active) {
      this.#cancelActive(invocation);
    }

    void Promise.all(active.map((invocation) => invocation.drainCompletion))
      .then(() => {
        resolveClose();
      });
    return closePromise;
  }

  /**
   * This method deliberately has no await point: capacity checks, queue
   * insertion, active registration, cancellation observation, and operation
   * startup occur in one JavaScript turn.
   */
  #admitAndRegister(
    invocation: ExternalRoutingRuntimeInvocation<TInput>,
  ): Promise<ExternalRoutingRuntimeOutcome<TOutcome>> {
    if (!this.#accepting || invocation.signal?.aborted === true) {
      return Promise.resolve(CANCELLED_OUTCOME);
    }

    if (this.#activeInvocations.size < EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES) {
      const record = this.#createRecord(invocation);
      this.#startActive(record);
      return record.completion;
    }

    if (this.#pendingInvocations.length >= EXTERNAL_ROUTING_MAX_PENDING_EXCHANGES) {
      return Promise.resolve(CAPACITY_OUTCOME);
    }

    const record = this.#createRecord(invocation);
    this.#pendingInvocations.push(record);
    this.#attachCallerCancellation(record);
    return record.completion;
  }

  #createRecord(
    invocation: ExternalRoutingRuntimeInvocation<TInput>,
  ): InvocationRecord<TInput, TOutcome> {
    let resolveCompletion!: (outcome: ExternalRoutingRuntimeOutcome<TOutcome>) => void;
    const completion = new Promise<ExternalRoutingRuntimeOutcome<TOutcome>>((resolve) => {
      resolveCompletion = resolve;
    });

    let resolveDrain!: () => void;
    const drainCompletion = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });

    return {
      input: invocation.input,
      callerSignal: invocation.signal,
      completion,
      drainCompletion,
      resolveCompletion,
      resolveDrain,
      phase: 'pending',
      settled: false,
      drained: false,
      operationStarted: false,
      controller: undefined,
      callerAbortListener: undefined,
    };
  }

  #startActive(invocation: InvocationRecord<TInput, TOutcome>): void {
    invocation.phase = 'active';
    invocation.controller = new AbortController();
    this.#activeInvocations.add(invocation);
    this.#attachCallerCancellation(invocation);

    // A signal can abort between the initial admission check and listener
    // registration. Never invoke a callback after that cancellation won.
    if (invocation.settled || invocation.phase !== 'active') {
      return;
    }

    invocation.operationStarted = true;
    let exchange: ExternalRoutingOperationExchange<TOutcome>;
    try {
      exchange = this.#operation(invocation.input, invocation.controller.signal);
    } catch {
      this.#settle(invocation, INTERNAL_OUTCOME);
      this.#finishDrain(invocation);
      return;
    }

    if (typeof exchange !== 'object' || exchange === null) {
      this.#settle(invocation, INTERNAL_OUTCOME);
      this.#finishDrain(invocation);
      return;
    }

    let settled: Promise<TOutcome>;
    try {
      settled = Promise.resolve(exchange.settled);
    } catch {
      this.#settle(invocation, INTERNAL_OUTCOME);
      this.#finishDrain(invocation);
      return;
    }
    void settled.then(
      (outcome) => {
        this.#settle(invocation, { kind: 'operation', outcome });
      },
      () => {
        this.#settle(invocation, INTERNAL_OUTCOME);
      },
    );

    let drained: Promise<void>;
    try {
      drained = Promise.resolve(exchange.drained);
    } catch {
      this.#settle(invocation, INTERNAL_OUTCOME);
      this.#finishDrain(invocation);
      return;
    }
    void drained.then(
      () => {
        this.#finishDrain(invocation);
      },
      () => {
        this.#settle(invocation, INTERNAL_OUTCOME);
        this.#finishDrain(invocation);
      },
    );
  }

  #attachCallerCancellation(invocation: InvocationRecord<TInput, TOutcome>): void {
    const signal = invocation.callerSignal;
    if (!signal || invocation.callerAbortListener) {
      return;
    }

    const listener = (): void => {
      this.#cancelForCallerAbort(invocation);
    };
    invocation.callerAbortListener = listener;
    signal.addEventListener('abort', listener, { once: true });

    if (signal.aborted) {
      listener();
    }
  }

  #detachCallerCancellation(invocation: InvocationRecord<TInput, TOutcome>): void {
    const listener = invocation.callerAbortListener;
    if (listener && invocation.callerSignal) {
      invocation.callerSignal.removeEventListener('abort', listener);
    }
    invocation.callerAbortListener = undefined;
  }

  #cancelForCallerAbort(invocation: InvocationRecord<TInput, TOutcome>): void {
    if (invocation.phase === 'pending') {
      const index = this.#pendingInvocations.indexOf(invocation);
      if (index !== -1) {
        this.#pendingInvocations.splice(index, 1);
      }
      this.#settle(invocation, CANCELLED_OUTCOME);
      invocation.phase = 'drained';
      invocation.drained = true;
      invocation.resolveDrain();
      return;
    }

    this.#cancelActive(invocation);
  }

  #cancelActive(invocation: InvocationRecord<TInput, TOutcome>): void {
    this.#settle(invocation, CANCELLED_OUTCOME);
    if (!invocation.controller?.signal.aborted) {
      invocation.controller?.abort();
    }

    if (invocation.phase === 'active' && !invocation.operationStarted) {
      this.#finishDrain(invocation);
    }
  }

  /** Compare-and-set terminal outcome; late operation completion is discarded. */
  #settle(
    invocation: InvocationRecord<TInput, TOutcome>,
    outcome: ExternalRoutingRuntimeOutcome<TOutcome>,
  ): boolean {
    if (invocation.settled) {
      return false;
    }

    invocation.settled = true;
    this.#detachCallerCancellation(invocation);
    invocation.resolveCompletion(outcome);
    return true;
  }

  #finishDrain(invocation: InvocationRecord<TInput, TOutcome>): void {
    if (invocation.drained) {
      return;
    }

    invocation.drained = true;
    if (invocation.phase === 'active') {
      this.#activeInvocations.delete(invocation);
    }
    invocation.phase = 'drained';
    invocation.resolveDrain();
    this.#promotePending();
  }

  #promotePending(): void {
    while (
      this.#accepting &&
      this.#activeInvocations.size < EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES
    ) {
      const invocation = this.#pendingInvocations.shift();
      if (!invocation) {
        return;
      }
      if (invocation.phase !== 'pending') {
        continue;
      }
      this.#startActive(invocation);
    }
  }
}
