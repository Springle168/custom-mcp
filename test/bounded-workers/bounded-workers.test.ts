import { mapWithWorkers } from '../../src/utils/bounded-workers.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function testBoundAndStableResults(): Promise<void> {
  const first = gate();
  const second = gate();
  const bothStarted = gate();
  let active = 0;
  let maxActive = 0;
  const started: number[] = [];
  const resultPromise = mapWithWorkers(
    [10, 20, 30, 40],
    2,
    new AbortController().signal,
    async (item, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(index);
      if (started.length === 2) bothStarted.release();
      try {
        if (index === 0) await first.promise;
        if (index === 1) await second.promise;
        return `${index}:${item}`;
      } finally {
        active -= 1;
      }
    },
  );
  await bothStarted.promise;
  second.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assertEqual(
    started.join(','),
    '0,1,2,3',
    'Available workers continue without waiting for earlier indexes',
  );
  assertEqual(active, 1, 'Only the first task remains blocked');
  first.release();
  assertEqual(
    (await resultPromise).join(','),
    '0:10,1:20,2:30,3:40',
    'Results retain input positions',
  );
  assertEqual(maxActive, 2, 'The configured concurrency bound is respected');
}

async function testFailureStopsAndDrains(): Promise<void> {
  const fail = gate();
  const peer = gate();
  const startedGate = gate();
  const originalError = new Error('unexpected task failure');
  let started = 0;
  let cleaned = 0;
  let settled = false;
  const result = mapWithWorkers([0, 1, 2, 3], 2, new AbortController().signal, async (_, index) => {
    started += 1;
    if (started === 2) startedGate.release();
    try {
      if (index === 0) {
        await fail.promise;
        throw originalError;
      }
      await peer.promise;
      return index;
    } finally {
      cleaned += 1;
    }
  }).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await startedGate.promise;
  fail.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assertEqual(started, 2, 'A failed task stops new work');
  assertEqual(settled, false, 'A failed batch waits for already-started peers');
  peer.release();
  assertEqual(
    await result,
    originalError,
    'The original internal exception is propagated unchanged',
  );
  assertEqual(cleaned, 2, 'All started tasks have cleaned up before rejection');
}

async function testCancellationStopsAndDrains(): Promise<void> {
  const controller = new AbortController();
  const peers = gate();
  let started = 0;
  let cleaned = 0;
  let settled = false;
  const result = mapWithWorkers([0, 1, 2], 2, controller.signal, async (item) => {
    started += 1;
    try {
      await peers.promise;
      return item;
    } finally {
      cleaned += 1;
    }
  }).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  const reason = new Error('cancelled');
  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assertEqual(settled, false, 'Abort cannot bypass resource cleanup');
  peers.release();
  assertEqual(await result, reason, 'The abort reason is propagated');
  assertEqual(started, 2, 'Abort stops further scheduling');
  assertEqual(cleaned, 2, 'Started tasks have completed cleanup');

  let invoked = false;
  const preCancelled = await mapWithWorkers([0], 1, controller.signal, async () => {
    invoked = true;
  }).catch((error: unknown) => error);
  assertEqual(preCancelled, reason, 'Pre-cancelled calls reject immediately');
  assertEqual(invoked, false, 'Pre-cancellation performs no work');
}

async function testEmptyAndConcurrencyValidation(): Promise<void> {
  const signal = new AbortController().signal;
  const empty = await mapWithWorkers([], 8, signal, async () => {
    throw new Error('not called');
  });
  assertEqual(empty.length, 0, 'An empty batch returns an empty result');
  for (const concurrency of [0, -1, 1.5, Infinity, NaN]) {
    let invoked = false;
    const result = await mapWithWorkers([0], concurrency, signal, async () => {
      invoked = true;
    }).catch((error: unknown) => error);
    assert(
      result instanceof RangeError,
      'Invalid concurrency must reject rather than silently lose work',
    );
    assertEqual(invoked, false, 'Invalid concurrency never starts tasks');
  }
}

async function testUndefinedFailureAndControlledResults(): Promise<void> {
  let invoked = 0;
  let rejected = false;
  await mapWithWorkers([0, 1], 1, new AbortController().signal, async () => {
    invoked += 1;
    throw undefined;
  }).catch((error: unknown) => {
    rejected = true;
    assertEqual(error, undefined, 'Even undefined exceptions retain identity');
  });
  assert(rejected, 'An undefined thrown value still rejects');
  assertEqual(invoked, 1, 'An undefined exception also stops scheduling');

  const result = await mapWithWorkers([0, 1], 1, new AbortController().signal, async (index) => ({
    ok: index !== 0,
  }));
  assertEqual(result.length, 2, 'Resolved business failures do not stop the batch');
  assertEqual(result[0]?.ok, false, 'Resolved business failure is preserved untouched');
  assertEqual(result[1]?.ok, true, 'Later work continues after controlled failure');
}

await runTestSuite({
  title: 'Bounded Worker Tests',
  tests: [
    { name: 'Concurrency is bounded and output is stable', run: testBoundAndStableResults },
    { name: 'Internal failure stops scheduling and drains peers', run: testFailureStopsAndDrains },
    { name: 'Cancellation stops scheduling and drains peers', run: testCancellationStopsAndDrains },
    { name: 'Empty batches and concurrency validation', run: testEmptyAndConcurrencyValidation },
    {
      name: 'Thrown values and controlled results retain their contracts',
      run: testUndefinedFailureAndControlledResults,
    },
  ],
});
