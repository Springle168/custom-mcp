import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { androidGradleInternalForTests } from '../../src/utils/android-gradle.js';
import {
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

interface FakeHelper {
  readonly process: ChildProcess;
  readonly killCalls: () => number;
  readonly unrefCalls: () => number;
}

function createChild(pid: number): ChildProcess {
  return {
    pid,
    kill: () => true,
  } as unknown as ChildProcess;
}

function createHangingHelper(killResult: boolean): FakeHelper {
  const emitter = new EventEmitter();
  let killCalls = 0;
  let unrefCalls = 0;
  const process = Object.assign(emitter, {
    kill() {
      killCalls++;
      return killResult;
    },
    unref() {
      unrefCalls++;
      return process;
    },
  }) as unknown as ChildProcess;
  return {
    process,
    killCalls: () => killCalls,
    unrefCalls: () => unrefCalls,
  };
}

async function testAttemptTimeoutDetachesUnreapedHelper(): Promise<void> {
  if (process.platform !== 'win32') return;
  const helper = createHangingHelper(true);

  await androidGradleInternalForTests.terminateProcessTreeAttempt(
    createChild(101),
    new AbortController().signal,
    {
      spawnHelper: () => helper.process,
      attemptTimeoutMs: 5,
      reapGraceMs: 5,
    },
  );

  assertEqual(helper.killCalls(), 1, 'Attempt timeout should terminate the helper once');
  assertEqual(
    helper.unrefCalls(),
    1,
    'A helper without close confirmation should be unreferenced after reap grace',
  );
}

async function testFailedHelperKillDetachesImmediately(): Promise<void> {
  if (process.platform !== 'win32') return;
  const helper = createHangingHelper(false);

  await androidGradleInternalForTests.terminateProcessTreeAttempt(
    createChild(102),
    new AbortController().signal,
    {
      spawnHelper: () => helper.process,
      attemptTimeoutMs: 5,
      reapGraceMs: 1000,
    },
  );

  assertEqual(helper.killCalls(), 1, 'Attempt timeout should request helper termination');
  assertEqual(
    helper.unrefCalls(),
    1,
    'A helper that cannot be terminated should be unreferenced immediately',
  );
}

async function testCleanupAbortDoesNotWaitForHelperClose(): Promise<void> {
  if (process.platform !== 'win32') return;
  const helper = createHangingHelper(true);
  const controller = new AbortController();
  const attempt = androidGradleInternalForTests.terminateProcessTreeAttempt(
    createChild(103),
    controller.signal,
    {
      spawnHelper: () => helper.process,
      attemptTimeoutMs: 1000,
      reapGraceMs: 1000,
    },
  );

  controller.abort();
  await attempt;

  assertEqual(helper.killCalls(), 1, 'Cleanup abort should terminate the helper once');
  assertEqual(
    helper.unrefCalls(),
    1,
    'Cleanup abort should detach the helper without extending the drain barrier',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing Android Gradle termination helper cleanup',
    tests: [
      { name: 'attempt timeout detaches unreaped helper', run: testAttemptTimeoutDetachesUnreapedHelper },
      { name: 'failed helper kill detaches immediately', run: testFailedHelperKillDetachesImmediately },
      { name: 'cleanup abort does not wait for helper close', run: testCleanupAbortDoesNotWaitForHelperClose },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
