import path from 'node:path';
import {
  AndroidGradleGateRegistry,
  type AndroidGradleGateExecution,
  type AndroidGradleGateResult,
} from '../../src/utils/android-gradle-gate.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

interface FakeExecution<T> {
  readonly execution: AndroidGradleGateExecution<T>;
  readonly settled: Deferred<T>;
  readonly drained: Deferred<void>;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createFakeExecution<T>(): FakeExecution<T> {
  const settled = createDeferred<T>();
  const drained = createDeferred<void>();

  return {
    execution: {
      settled: settled.promise,
      drained: drained.promise,
    },
    settled,
    drained,
  };
}

function complete<T>(execution: FakeExecution<T>, value: T): void {
  execution.settled.resolve(value);
  execution.drained.resolve();
}

function assertCompleted<T>(
  result: AndroidGradleGateResult<T>,
  expected: T,
  message: string,
): void {
  assert(result.status === 'completed', `${message}: expected a completed result`);
  if (result.status === 'completed') {
    assertEqual(result.value, expected, message);
  }
}

function assertCancelled(
  result: AndroidGradleGateResult<unknown>,
  reason: 'caller-aborted' | 'registry-closed',
  message: string,
): void {
  assert(result.status === 'cancelled', `${message}: expected a cancelled result`);
  if (result.status === 'cancelled') {
    assertEqual(result.reason, reason, message);
  }
}

function assertFailed(
  result: AndroidGradleGateResult<unknown>,
  expected: unknown,
  message: string,
): void {
  assert(result.status === 'failed', `${message}: expected a failed result`);
  if (result.status === 'failed') {
    assertEqual(result.error, expected, message);
  }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert(condition(), message);
}

async function testSameWorkspaceUsesFifoAdmission() {
  const registry = new AndroidGradleGateRegistry();
  const workspaceRoot = path.resolve('android-gate-fifo-workspace');
  const firstExecution = createFakeExecution<string>();
  const secondExecution = createFakeExecution<string>();
  const starts: string[] = [];

  const first = registry.run(workspaceRoot, new AbortController().signal, () => {
    starts.push('first');
    return firstExecution.execution;
  });
  const second = registry.run(path.join(workspaceRoot, '.'), new AbortController().signal, () => {
    starts.push('second');
    return secondExecution.execution;
  });

  assertEqual(starts.join(','), 'first', 'Second same-workspace operation should wait');

  complete(firstExecution, 'first result');
  assertCompleted(await first, 'first result', 'First operation should settle normally');
  await waitFor(
    () => starts.join(',') === 'first,second',
    'Second operation should start after the first lease drains',
  );

  complete(secondExecution, 'second result');
  assertCompleted(await second, 'second result', 'Second operation should settle normally');
  await waitFor(() => registry.workspaceCount === 0, 'Idle workspace entry should be removed');
}

async function testDifferentWorkspacesRunInParallel() {
  const registry = new AndroidGradleGateRegistry();
  const firstExecution = createFakeExecution<number>();
  const secondExecution = createFakeExecution<number>();
  const starts: string[] = [];

  const first = registry.run(
    path.resolve('android-gate-parallel-a'),
    new AbortController().signal,
    () => {
      starts.push('first');
      return firstExecution.execution;
    },
  );
  const second = registry.run(
    path.resolve('android-gate-parallel-b'),
    new AbortController().signal,
    () => {
      starts.push('second');
      return secondExecution.execution;
    },
  );

  assertEqual(starts.join(','), 'first,second', 'Different workspaces should both be active');

  complete(firstExecution, 1);
  complete(secondExecution, 2);
  assertCompleted(await first, 1, 'First workspace should complete independently');
  assertCompleted(await second, 2, 'Second workspace should complete independently');
  await waitFor(() => registry.workspaceCount === 0, 'Both idle entries should be removed');
}

async function testQueuedCancellationRemovesWaiterWithoutRunningOperation() {
  const registry = new AndroidGradleGateRegistry();
  const workspaceRoot = path.resolve('android-gate-queued-cancel');
  const firstExecution = createFakeExecution<void>();
  const queuedController = new AbortController();
  let queuedOperationStarted = false;

  const first = registry.run(
    workspaceRoot,
    new AbortController().signal,
    () => firstExecution.execution,
  );
  const queued = registry.run(workspaceRoot, queuedController.signal, () => {
    queuedOperationStarted = true;
    return createFakeExecution<void>().execution;
  });

  queuedController.abort();
  assertCancelled(
    await queued,
    'caller-aborted',
    'Queued caller cancellation should have a stable result',
  );
  assertEqual(queuedOperationStarted, false, 'Cancelled waiter must not execute its callback');

  complete(firstExecution, undefined);
  assertCompleted(await first, undefined, 'Active operation should still complete normally');
  await waitFor(() => registry.workspaceCount === 0, 'Cancelled queue should not retain an entry');
}

async function testSettledResultDoesNotReleaseBeforeDrain() {
  const registry = new AndroidGradleGateRegistry();
  const workspaceRoot = path.resolve('android-gate-settled-before-drained');
  const firstExecution = createFakeExecution<string>();
  const secondExecution = createFakeExecution<string>();
  const starts: string[] = [];

  const first = registry.run(workspaceRoot, new AbortController().signal, () => {
    starts.push('first');
    return firstExecution.execution;
  });
  const second = registry.run(workspaceRoot, new AbortController().signal, () => {
    starts.push('second');
    return secondExecution.execution;
  });

  firstExecution.settled.resolve('first result');
  assertCompleted(
    await first,
    'first result',
    'Caller should receive the settled result before cleanup drains',
  );
  assertEqual(starts.join(','), 'first', 'Second operation must remain queued until drain');

  firstExecution.drained.resolve();
  await waitFor(
    () => starts.join(',') === 'first,second',
    'Drain completion should hand off to the next FIFO waiter',
  );

  complete(secondExecution, 'second result');
  assertCompleted(await second, 'second result', 'Second operation should complete after handoff');
  await waitFor(
    () => registry.workspaceCount === 0,
    'Entry should be cleaned up after the final drain',
  );
}

async function testRejectedSettledDoesNotReleaseBeforeDrain() {
  const registry = new AndroidGradleGateRegistry();
  const workspaceRoot = path.resolve('android-gate-rejected-settled');
  const firstExecution = createFakeExecution<void>();
  const secondExecution = createFakeExecution<void>();
  const failure = new Error('simulated Gradle failure');
  let secondOperationStarted = false;

  const first = registry.run(
    workspaceRoot,
    new AbortController().signal,
    () => firstExecution.execution,
  );
  const second = registry.run(workspaceRoot, new AbortController().signal, () => {
    secondOperationStarted = true;
    return secondExecution.execution;
  });

  firstExecution.settled.reject(failure);
  assertFailed(
    await first,
    failure,
    'Rejected settled promise should be returned as a controlled failure',
  );
  assertEqual(
    secondOperationStarted,
    false,
    'Failed settled result must still retain the gate until drain completes',
  );

  firstExecution.drained.resolve();
  await waitFor(
    () => secondOperationStarted,
    'A failed operation should hand off only after its drain barrier settles',
  );

  complete(secondExecution, undefined);
  assertCompleted(await second, undefined, 'Second operation should complete after failed handoff');
  await waitFor(
    () => registry.workspaceCount === 0,
    'Failed lease should still clean up its entry',
  );
}

async function testAbortDuringHandoffDoesNotStartQueuedOperation() {
  const registry = new AndroidGradleGateRegistry();
  const workspaceRoot = path.resolve('android-gate-handoff-abort-race');
  const firstExecution = createFakeExecution<void>();
  const secondController = new AbortController();
  let secondOperationStarted = false;

  const first = registry.run(
    workspaceRoot,
    new AbortController().signal,
    () => firstExecution.execution,
  );
  const second = registry.run(workspaceRoot, secondController.signal, () => {
    secondOperationStarted = true;
    return createFakeExecution<void>().execution;
  });

  complete(firstExecution, undefined);
  secondController.abort();

  assertCompleted(await first, undefined, 'First operation should complete normally');
  assertCancelled(
    await second,
    'caller-aborted',
    'Abort concurrent with release should cancel the queued waiter',
  );
  assertEqual(secondOperationStarted, false, 'Handoff must re-check the waiter signal');
  await waitFor(
    () => registry.workspaceCount === 0,
    'Race-cancelled waiter should not retain entry state',
  );
}

async function testActiveAbortAndOldLeaseEventsAreIsolated() {
  const registry = new AndroidGradleGateRegistry();
  const workspaceRoot = path.resolve('android-gate-lease-isolation');
  const oldCaller = new AbortController();
  const oldExecution = createFakeExecution<void>();
  let oldLeaseSignal: AbortSignal | undefined;

  const oldRun = registry.run(workspaceRoot, oldCaller.signal, (lease) => {
    oldLeaseSignal = lease.signal;
    return oldExecution.execution;
  });
  complete(oldExecution, undefined);
  assertCompleted(await oldRun, undefined, 'Old lease should complete normally');
  await waitFor(() => registry.workspaceCount === 0, 'Old lease should fully release its entry');

  const newCaller = new AbortController();
  const newExecution = createFakeExecution<void>();
  let newLeaseSignal: AbortSignal | undefined;
  const newRun = registry.run(workspaceRoot, newCaller.signal, (lease) => {
    newLeaseSignal = lease.signal;
    return newExecution.execution;
  });

  assert(oldLeaseSignal !== undefined, 'Old operation should receive a runtime-owned signal');
  assert(newLeaseSignal !== undefined, 'New operation should receive a runtime-owned signal');
  assert(oldLeaseSignal !== newLeaseSignal, 'Each lease must own an independent controller');

  oldCaller.abort();
  assertEqual(
    oldLeaseSignal.aborted,
    false,
    'Late old-caller abort should not affect a released lease or its replacement',
  );
  assertEqual(newLeaseSignal.aborted, false, 'Late old events must not abort the current lease');

  newCaller.abort();
  assertEqual(
    newLeaseSignal.aborted,
    true,
    'Active caller abort must reach the runtime-owned signal',
  );

  complete(newExecution, undefined);
  assertCompleted(await newRun, undefined, 'Active operation should retain its controlled result');
  await waitFor(() => registry.workspaceCount === 0, 'Replacement lease should clean up normally');
}

async function testCloseCancelsQueueAbortsActiveAndWaitsForDrain() {
  const registry = new AndroidGradleGateRegistry();
  const workspaceRoot = path.resolve('android-gate-close');
  const activeExecution = createFakeExecution<string>();
  let activeLeaseSignal: AbortSignal | undefined;
  let queuedOperationStarted = false;

  const active = registry.run(workspaceRoot, new AbortController().signal, (lease) => {
    activeLeaseSignal = lease.signal;
    return activeExecution.execution;
  });
  const queued = registry.run(workspaceRoot, new AbortController().signal, () => {
    queuedOperationStarted = true;
    return createFakeExecution<string>().execution;
  });

  const close = registry.close();
  assertEqual(registry.close(), close, 'Registry close should be idempotent');
  assert(activeLeaseSignal?.aborted === true, 'Close must abort the active runtime-owned signal');
  assertCancelled(await queued, 'registry-closed', 'Close should cancel queued callers');
  assertEqual(queuedOperationStarted, false, 'Close-cancelled queue must not start callbacks');

  const afterClose = await registry.run(workspaceRoot, new AbortController().signal, () => {
    throw new Error('Closed registry must not run new operations');
  });
  assertCancelled(afterClose, 'registry-closed', 'Closed registry should reject future admission');

  activeExecution.settled.resolve('active result');
  assertCompleted(await active, 'active result', 'Active caller should receive its settled result');
  let closeFinished = false;
  void close.then(() => {
    closeFinished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assertEqual(closeFinished, false, 'Close must wait for the active drain barrier');

  activeExecution.drained.resolve();
  await close;
  assertEqual(registry.workspaceCount, 0, 'Close should leave no live workspace entries');
}

async function testIdleEntryCleanup() {
  const registry = new AndroidGradleGateRegistry();
  const execution = createFakeExecution<number>();

  const result = registry.run(
    path.resolve('android-gate-idle-cleanup'),
    new AbortController().signal,
    () => execution.execution,
  );
  assertEqual(registry.workspaceCount, 1, 'Active workspace should have one registry entry');

  complete(execution, 42);
  assertCompleted(await result, 42, 'Operation should complete before idle cleanup');
  await waitFor(() => registry.workspaceCount === 0, 'Fully idle entry should be removed');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing Android Gradle workspace gate',
    tests: [
      { name: 'same workspace FIFO admission', run: testSameWorkspaceUsesFifoAdmission },
      { name: 'different workspace parallelism', run: testDifferentWorkspacesRunInParallel },
      {
        name: 'queued cancellation',
        run: testQueuedCancellationRemovesWaiterWithoutRunningOperation,
      },
      { name: 'settled before drained', run: testSettledResultDoesNotReleaseBeforeDrain },
      { name: 'failed settled before drained', run: testRejectedSettledDoesNotReleaseBeforeDrain },
      { name: 'handoff and abort race', run: testAbortDuringHandoffDoesNotStartQueuedOperation },
      {
        name: 'active abort and old lease isolation',
        run: testActiveAbortAndOldLeaseEventsAreIsolated,
      },
      { name: 'close and active drain', run: testCloseCancelsQueueAbortsActiveAndWaitsForDrain },
      { name: 'idle entry cleanup', run: testIdleEntryCleanup },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
