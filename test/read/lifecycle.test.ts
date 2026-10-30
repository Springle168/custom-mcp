import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { readInternalForTests } from '../../src/tools/built-in/files/read.js';
import { MAX_READ_REQUESTS } from '../../src/tools/built-in/files/read.limits.js';
import { FILE_READ_CONCURRENCY } from '../../src/utils/file-read-policy.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';
import {
  block,
  body,
  cleanupFixtures,
  context,
  FIXTURES_DIR,
  prepareFixtures,
} from './fixtures.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function deadline(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for the controlled worker boundary')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const files = Array.from(
  { length: FILE_READ_CONCURRENCY + 1 },
  (_, index) => `worker-${index}.txt`,
);

async function setup(): Promise<void> {
  assert(
    files.length <= MAX_READ_REQUESTS,
    'Worker lifecycle tests require within-limit sources beyond the first worker wave',
  );
  await prepareFixtures();
  await Promise.all(files.map((name) => fs.writeFile(path.join(FIXTURES_DIR, name), name)));
}

async function testOncePerSourceAndNoCrossCallCache(): Promise<void> {
  let calls = 0;
  const args = {
    include: [
      'a.txt',
      { file_path: 'a.txt', read_mode: 'regex', start_line: '^beta$', end_line: '^beta$' },
      { file_path: 'a.txt', start_line: 2, end_line: 3 },
    ],
  };
  const invocation = createTestToolInvocationContext();
  const reader: Parameters<typeof readInternalForTests.read>[3] = async (_file, signal) => {
    assertEqual(signal, invocation.signal, 'Source reads receive the invocation signal');
    calls++;
    return { ok: true, kind: 'text', lines: ['alpha', 'beta', `generation-${calls}`] };
  };
  const first = await readInternalForTests.read(args, context(), invocation, reader);
  assertEqual(calls, 1, 'All ranges, including regex positioning, share one source read');
  assertEqual(body(first, 1), 'beta', 'Regex location is computed from the supplied source lines');
  assertEqual(
    body(first, 2),
    'beta\ngeneration-1',
    'Sibling ranges use the same source generation',
  );

  const second = await readInternalForTests.read(args, context(), invocation, reader);
  assertEqual(calls, 2, 'Source text is not cached across calls');
  assertEqual(body(second, 2), 'beta\ngeneration-2', 'Later calls obtain fresh text');
}

async function testIdentityAndSourceFailures(): Promise<void> {
  const alias = path.join(FIXTURES_DIR, 'alias');
  await fs.symlink(FIXTURES_DIR, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    let calls = 0;
    const result = await readInternalForTests.read(
      {
        include: [
          'a.txt',
          { file_path: 'alias/a.txt', start_line: 1 },
          { file_path: 'a.txt', start_line: 2 },
          'b.txt',
        ],
      },
      context(),
      createTestToolInvocationContext(),
      async (file) => {
        calls++;
        return path.basename(file.readPath) === 'a.txt'
          ? { ok: false, reason: 'controlled source failure' }
          : { ok: true, kind: 'text', lines: ['surviving-body'] };
      },
    );
    assertEqual(calls, 2, 'Different lexical aliases share the same actual source identity');
    assertEqual(
      result.content.length,
      4,
      'The alias object overrides the whole-file default by actual identity',
    );
    assertIncludes(
      block(result, 1),
      'controlled source failure',
      'Source failure reaches every selected fragment',
    );
    assertIncludes(
      block(result, 2),
      'controlled source failure',
      'A second fragment receives the same source failure',
    );
    assertEqual(body(result, 3), 'surviving-body', 'Other sources are not affected');
    assert(result.isError === false, 'An unrelated success keeps the result successful');
  } finally {
    await fs.unlink(alias);
  }
}

async function testBoundedWorkersAndStableOrder(): Promise<void> {
  const firstWave = deferred();
  const release = deferred();
  let started = 0;
  let active = 0;
  let peak = 0;
  const pending = readInternalForTests.read(
    { include: files },
    context(),
    createTestToolInvocationContext(),
    async (file) => {
      started++;
      active++;
      peak = Math.max(peak, active);
      if (started === FILE_READ_CONCURRENCY) firstWave.resolve();
      try {
        await release.promise;
        return { ok: true, kind: 'text', lines: [path.basename(file.readPath)] };
      } finally {
        active--;
      }
    },
  );
  try {
    await deadline(firstWave.promise);
    assertEqual(
      started,
      FILE_READ_CONCURRENCY,
      'Only the configured number of reads may start before any source settles',
    );
    assertEqual(
      active,
      FILE_READ_CONCURRENCY,
      'The first worker wave is held at the read boundary',
    );
  } finally {
    release.resolve();
  }
  const result = await pending;
  assertEqual(
    peak,
    FILE_READ_CONCURRENCY,
    'Concurrent source reads stay within the configured limit',
  );
  assertEqual(started, files.length, 'A completed call eventually processes all selected sources');
  files.forEach((name, index) =>
    assertEqual(
      body(result, index + 1),
      name,
      'Worker completion does not reorder request results',
    ),
  );
}

async function testCancellationDrainsAndStopsScheduling(): Promise<void> {
  const firstWave = deferred();
  const release = deferred();
  const controller = new AbortController();
  let started = 0;
  let active = 0;
  let settled = false;
  const pending = readInternalForTests
    .read(
      { include: files },
      context(),
      createTestToolInvocationContext({ signal: controller.signal }),
      async (_file, signal) => {
        assertEqual(signal, controller.signal, 'Readers share the cancellation signal');
        active++;
        if (++started === FILE_READ_CONCURRENCY) firstWave.resolve();
        try {
          await release.promise;
          return { ok: true, kind: 'text', lines: ['partial-business-result'] };
        } finally {
          active--;
        }
      },
    )
    .then((result) => {
      settled = true;
      return result;
    });
  try {
    await deadline(firstWave.promise);
    controller.abort();
    await nextTurn();
    assert(!settled, 'Cancellation waits for already-started source cleanup');
    assertEqual(started, FILE_READ_CONCURRENCY, 'Cancellation does not start queued source reads');
  } finally {
    release.resolve();
  }
  const result = await pending;
  assertEqual(active, 0, 'All active readers have finished before returning');
  assertEqual(started, FILE_READ_CONCURRENCY, 'Queued files remain unscheduled after drain');
  assert(result.isError === true, 'Cancelled calls are whole-call errors');
  assertEqual(result.content.length, 1, 'Cancellation never returns partial business blocks');
  assertIncludes(getResultText(result), 'cancel', 'The whole-call error explains cancellation');
  assertNotIncludes(
    getResultText(result),
    'partial-business-result',
    'Completed source bodies are not leaked as partial results',
  );
}

async function testInternalExceptionDrainsAndStopsScheduling(): Promise<void> {
  const firstWave = deferred();
  const fail = deferred();
  const release = deferred();
  let started = 0;
  let active = 0;
  let settled = false;
  const pending = readInternalForTests
    .read({ include: files }, context(), createTestToolInvocationContext(), async () => {
      const index = started++;
      active++;
      if (started === FILE_READ_CONCURRENCY) firstWave.resolve();
      try {
        if (index === 0) {
          await fail.promise;
          throw new Error('private-internal-detail');
        }
        await release.promise;
        return { ok: true, kind: 'text', lines: ['partial-business-result'] };
      } finally {
        active--;
      }
    })
    .then((result) => {
      settled = true;
      return result;
    });
  try {
    await deadline(firstWave.promise);
    fail.resolve();
    await nextTurn();
    assertEqual(
      started,
      FILE_READ_CONCURRENCY,
      'An uncontinuable exception stops new source scheduling',
    );
    assert(!settled, 'Internal failure waits for the other started readers to clean up');
  } finally {
    fail.resolve();
    release.resolve();
  }
  const result = await pending;
  assertEqual(active, 0, 'All workers are drained before returning an internal failure');
  assertEqual(started, FILE_READ_CONCURRENCY, 'No queued source starts after the internal failure');
  assert(result.isError === true, 'Uncontinuable exceptions fail the whole call');
  assertEqual(result.content.length, 1, 'Internal exceptions are not ordinary request failures');
  assertNotIncludes(
    getResultText(result),
    'private-internal-detail',
    'Unexpected implementation details remain private',
  );
  assertNotIncludes(
    getResultText(result),
    'Selected content:',
    'An incomplete call does not pretend to finish business results',
  );
}

async function testPreCancelledAndLimitBeforeSources(): Promise<void> {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const cancelled = await readInternalForTests.read(
    { include: files },
    context(),
    createTestToolInvocationContext({ signal: controller.signal }),
    async () => {
      calls++;
      return { ok: true, kind: 'text', lines: ['never'] };
    },
  );
  assert(cancelled.isError === true, 'An already-cancelled call fails');
  assertEqual(calls, 0, 'An already-cancelled call starts no source read');

  const limited = await readInternalForTests.read(
    {
      include: [
        ...Array.from({ length: MAX_READ_REQUESTS }, () => ({
          file_path: 'a.txt',
          start_line: 99,
        })),
        'b.txt',
      ],
    },
    context(),
    createTestToolInvocationContext(),
    async (file) => {
      calls++;
      assertEqual(
        path.basename(file.readPath),
        'a.txt',
        'A source used only by an over-limit request is never opened',
      );
      return { ok: true, kind: 'text', lines: ['a'] };
    },
  );
  assert(limited.isError === true, 'All within-limit fragments fail without backfill');
  assertEqual(calls, 1, 'The limit precedes source grouping and one source is read once');
}

await runTestSuite({
  title: 'Testing read source identity, workers, and cancellation',
  beforeAll: setup,
  afterAll: cleanupFixtures,
  tests: [
    {
      name: 'same-source fragments and regex positioning share one read per call',
      run: testOncePerSourceAndNoCrossCallCache,
    },
    {
      name: 'realpath identity unifies aliases and isolates source failures',
      run: testIdentityAndSourceFailures,
    },
    {
      name: 'bounded workers preserve final request order',
      run: testBoundedWorkersAndStableOrder,
    },
    {
      name: 'cancellation stops scheduling and drains active readers',
      run: testCancellationDrainsAndStopsScheduling,
    },
    {
      name: 'internal exceptions stop scheduling and drain before a whole-call error',
      run: testInternalExceptionDrainsAndStopsScheduling,
    },
    {
      name: 'pre-cancelled calls and over-limit requests start no extra sources',
      run: testPreCancelledAndLimitBeforeSources,
    },
  ],
});
