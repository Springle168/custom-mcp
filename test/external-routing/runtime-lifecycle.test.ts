import {
  EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES,
  EXTERNAL_ROUTING_MAX_PENDING_EXCHANGES,
  ExternalRoutingRuntime,
  type ExternalRoutingOperationExchange,
  type ExternalRoutingRuntimeFailureKind,
  type ExternalRoutingRuntimeOutcome,
} from '../../src/tools/external-routing/runtime.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

interface StartedExchange {
  readonly input: number;
  readonly signal: AbortSignal;
  readonly settled: Deferred<string>;
  readonly drained: Deferred<void>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** A fake that exposes precisely when an admitted operation was started. */
class ControllableOperation {
  readonly started: StartedExchange[] = [];

  readonly operation = (
    input: number,
    signal: AbortSignal,
  ): ExternalRoutingOperationExchange<string> => {
    const exchange: StartedExchange = {
      input,
      signal,
      settled: deferred<string>(),
      drained: deferred<void>(),
    };
    this.started.push(exchange);
    return {
      settled: exchange.settled.promise,
      drained: exchange.drained.promise,
    };
  };

  exchangeFor(input: number): StartedExchange {
    const exchange = this.started.find((candidate) => candidate.input === input);
    if (!exchange) {
      throw new Error(`Expected operation ${input} to have started.`);
    }
    return exchange;
  }
}

function startedInputs(operation: ControllableOperation): readonly number[] {
  return operation.started.map((exchange) => exchange.input);
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function requireFailure<T>(
  result: Promise<ExternalRoutingRuntimeOutcome<T>>,
  expected: ExternalRoutingRuntimeFailureKind,
): Promise<void> {
  const outcome = await result;
  assertEqual(outcome.kind, expected, 'Runtime failure kind should be stable.');
}

async function requireOperation(
  result: Promise<ExternalRoutingRuntimeOutcome<string>>,
  expected: string,
): Promise<void> {
  const outcome = await result;
  assertEqual(outcome.kind, 'operation', 'Operation completion should retain its outcome.');
  if (outcome.kind !== 'operation') {
    throw new Error('Expected an operation outcome.');
  }
  assertEqual(outcome.outcome, expected, 'Operation outcome should not be rewritten by runtime admission.');
}

async function closeAndDrain(
  runtime: ExternalRoutingRuntime<number, string>,
  operation: ControllableOperation,
): Promise<void> {
  const close = runtime.close();
  for (const exchange of operation.started) {
    exchange.drained.resolve();
  }
  await close;
}

async function testKeepsSlotsUntilDrainAndDoesNotPreExecuteQueuedWork(): Promise<void> {
  const operation = new ControllableOperation();
  const runtime = new ExternalRoutingRuntime(operation.operation);
  const active = Array.from({ length: EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES }, (_, input) =>
    runtime.exchange({ input }),
  );
  const queued = runtime.exchange({ input: EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES });

  assertEqual(operation.started.length, EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES,
    'Only active slots may invoke the operation callback.');
  assertEqual(runtime.activeExchangeCount, EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES,
    'All initial admissions should be registered as active.');
  assertEqual(runtime.pendingExchangeCount, 1,
    'The overflow after active capacity should remain queued.');

  const first = operation.exchangeFor(0);
  first.settled.resolve('first result');
  await requireOperation(active[0]!, 'first result');
  assertEqual(runtime.activeExchangeCount, EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES,
    'A settled operation must retain its slot until drain completes.');
  assertEqual(operation.started.length, EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES,
    'Settling alone must not start queued work.');

  first.drained.resolve();
  await flushPromises();
  assertEqual(operation.started.length, EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES + 1,
    'Draining one operation should admit exactly one queued operation.');
  assertEqual(operation.exchangeFor(EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES).input,
    EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES,
    'The queued operation should receive its original input only after admission.');
  assertEqual(runtime.pendingExchangeCount, 0, 'The newly admitted item should leave pending tracking.');

  await closeAndDrain(runtime, operation);
  await requireFailure(queued, 'cancelled');
}

async function testPromotesQueuedWorkInFifoOrder(): Promise<void> {
  const operation = new ControllableOperation();
  const runtime = new ExternalRoutingRuntime(operation.operation);
  for (let input = 0; input < EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES; input++) {
    void runtime.exchange({ input });
  }
  void runtime.exchange({ input: 8 });
  void runtime.exchange({ input: 9 });
  void runtime.exchange({ input: 10 });

  operation.exchangeFor(5).drained.resolve();
  await flushPromises();
  operation.exchangeFor(2).drained.resolve();
  await flushPromises();

  assertEqual(startedInputs(operation).join(','), '0,1,2,3,4,5,6,7,8,9',
    'Freed slots must promote pending operations in FIFO order, not by active completion order.');
  assertEqual(runtime.pendingExchangeCount, 1,
    'Only two of the three pending operations should have received freed slots.');

  await closeAndDrain(runtime, operation);
}

async function testEnforcesEightActiveAndSixtyFourPendingSlots(): Promise<void> {
  const operation = new ControllableOperation();
  const runtime = new ExternalRoutingRuntime(operation.operation);

  for (let input = 0; input < EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES; input++) {
    void runtime.exchange({ input });
  }
  for (
    let input = EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES;
    input < EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES + EXTERNAL_ROUTING_MAX_PENDING_EXCHANGES;
    input++
  ) {
    void runtime.exchange({ input });
  }
  const overflow = runtime.exchange({
    input: EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES + EXTERNAL_ROUTING_MAX_PENDING_EXCHANGES,
  });

  await requireFailure(overflow, 'capacity');
  assertEqual(operation.started.length, EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES,
    'Capacity overflow must not execute an operation callback.');
  assertEqual(runtime.activeExchangeCount, EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES,
    'The active registry must remain at its fixed maximum.');
  assertEqual(runtime.pendingExchangeCount, EXTERNAL_ROUTING_MAX_PENDING_EXCHANGES,
    'The pending registry must remain at its fixed maximum.');

  await closeAndDrain(runtime, operation);
}

async function testCancelsQueuedWorkBeforeItCanStart(): Promise<void> {
  const operation = new ControllableOperation();
  const runtime = new ExternalRoutingRuntime(operation.operation);
  for (let input = 0; input < EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES; input++) {
    void runtime.exchange({ input });
  }

  const cancelledController = new AbortController();
  const cancelled = runtime.exchange({
    input: 8,
    signal: cancelledController.signal,
  });
  const retained = runtime.exchange({ input: 9 });
  cancelledController.abort();
  await requireFailure(cancelled, 'cancelled');

  assertEqual(runtime.pendingExchangeCount, 1,
    'Aborting a queued invocation must remove it from the pending registry.');
  operation.exchangeFor(0).drained.resolve();
  await flushPromises();
  assertEqual(startedInputs(operation).join(','), '0,1,2,3,4,5,6,7,9',
    'A cancelled queued entry must never run and must not block following FIFO work.');

  await closeAndDrain(runtime, operation);
  await requireFailure(retained, 'cancelled');
}

async function testCallerAbortWinsAgainstLateOperationCompletion(): Promise<void> {
  const callerController = new AbortController();
  const settled = deferred<string>();
  const drained = deferred<void>();
  let operationSignal: AbortSignal | undefined;
  let starts = 0;

  const runtime = new ExternalRoutingRuntime<number, string>((_input, signal) => {
    starts++;
    operationSignal = signal;
    // This is an adversarial re-entrant abort: it occurs after active
    // registration but before the callback returns its exchange descriptor.
    callerController.abort();
    return { settled: settled.promise, drained: drained.promise };
  });

  const result = runtime.exchange({ input: 1, signal: callerController.signal });
  await requireFailure(result, 'cancelled');
  assertEqual(starts, 1, 'An invocation already admitted may start exactly once.');
  assert(operationSignal !== undefined, 'The operation should receive a runtime-owned signal.');
  assert(operationSignal !== callerController.signal,
    'The runtime must not pass the caller-owned signal directly to the operation.');
  assert(operationSignal.aborted,
    'Caller cancellation must abort the independent operation controller.');

  settled.resolve('late success');
  await flushPromises();
  await requireFailure(result, 'cancelled');
  assertEqual(runtime.activeExchangeCount, 1,
    'Late completion must not release a slot before the operation drain completes.');

  drained.resolve();
  await flushPromises();
  assertEqual(runtime.activeExchangeCount, 0, 'The active registry should release only after drain.');
  await runtime.close();
}

async function testCloseCancelsAllWorkWaitsForDrainAndIsIdempotent(): Promise<void> {
  const operation = new ControllableOperation();
  const runtime = new ExternalRoutingRuntime(operation.operation);
  const active = Array.from({ length: EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES }, (_, input) =>
    runtime.exchange({ input }),
  );
  const queued = runtime.exchange({ input: 8 });

  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert(Object.is(firstClose, secondClose), 'close() must return the same in-flight promise.');
  await requireFailure(queued, 'cancelled');
  await Promise.all(active.map((result) => requireFailure(result, 'cancelled')));
  assertEqual(operation.started.length, EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES,
    'close() must never promote pending work.');
  assert(operation.started.every((exchange) => exchange.signal.aborted),
    'close() must abort every active operation-owned signal.');
  assertEqual(runtime.activeExchangeCount, EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES,
    'close() must retain active registry entries until their drains complete.');

  let closeCompleted = false;
  void firstClose.then(() => {
    closeCompleted = true;
  });
  operation.exchangeFor(0).drained.resolve();
  await flushPromises();
  assert(!closeCompleted, 'close() must wait for every active drain, not the first one.');

  for (const exchange of operation.started.slice(1)) {
    exchange.drained.resolve();
  }
  await firstClose;
  assert(closeCompleted, 'close() should resolve after every active drain completes.');
  assertEqual(runtime.activeExchangeCount, 0, 'All drained entries should leave active tracking.');

  const afterClose = runtime.exchange({ input: 99 });
  await requireFailure(afterClose, 'cancelled');
  assertEqual(operation.started.length, EXTERNAL_ROUTING_MAX_ACTIVE_EXCHANGES,
    'Closed runtime must reject future admission without executing the operation.');
}

async function testConvertsOperationExceptionsToInternalFailure(): Promise<void> {
  const runtime = new ExternalRoutingRuntime<number, string>(() => {
    throw new Error('operation failure must not escape the runtime boundary');
  });

  await requireFailure(runtime.exchange({ input: 1 }), 'internal');
  assertEqual(runtime.activeExchangeCount, 0,
    'A synchronous operation exception must not leak an active registry entry.');
  await runtime.close();
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external routing admission runtime lifecycle',
    tests: [
      { name: 'keeps active slots until drain without pre-executing queued work', run: testKeepsSlotsUntilDrainAndDoesNotPreExecuteQueuedWork },
      { name: 'promotes queued work in FIFO order', run: testPromotesQueuedWorkInFifoOrder },
      { name: 'enforces eight active and sixty-four pending slots', run: testEnforcesEightActiveAndSixtyFourPendingSlots },
      { name: 'cancels queued work before it can start', run: testCancelsQueuedWorkBeforeItCanStart },
      { name: 'lets caller abort win over late operation completion', run: testCallerAbortWinsAgainstLateOperationCompletion },
      { name: 'closes idempotently after cancelling work and draining active operations', run: testCloseCancelsAllWorkWaitsForDrainAndIsIdempotent },
      { name: 'converts operation exceptions to internal failure', run: testConvertsOperationExceptionsToInternalFailure },
    ],
  });
}

void main();
