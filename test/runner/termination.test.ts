import type { SpawnOptions } from 'node:child_process';
import { assert, assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';
import { fakeChild } from './fakes.js';
import { terminateTestProcess } from './termination.js';

async function testTargetsOnlyOwnedPid(): Promise<void> {
  const root = fakeChild(1234);
  const helper = fakeChild();
  let command: string | undefined;
  let args: readonly string[] = [];
  let options: SpawnOptions | undefined;
  const pending = terminateTestProcess(root.child, new AbortController().signal, {
    platform: 'win32',
    spawnHelper(cmd, argv, spawnOptions) {
      command = cmd;
      args = argv;
      options = spawnOptions;
      return helper.child;
    },
  });
  helper.child.emit('close', 0, null);
  const result = await pending;
  assertEqual(command, 'taskkill', 'Should invoke the Windows termination utility');
  assertEqual(args.join(' '), '/pid 1234 /t /f', 'Should only target the owned PID and its tree');
  assertEqual(options?.windowsHide, true, 'Should not flash a helper window');
  assertEqual(options?.stdio, 'ignore', 'Helper must not own blocking pipes');
  assertEqual(result.confirmed, true, 'Successful taskkill should confirm its attempt');
  assertEqual(helper.kills.length, 0, 'Successful helper should not need forced reap');
}

async function testHelperFailureRemainsUnconfirmed(): Promise<void> {
  const root = fakeChild();
  const helper = fakeChild();
  const pending = terminateTestProcess(root.child, new AbortController().signal, {
    platform: 'win32',
    spawnHelper: () => helper.child,
  });
  helper.child.emit('close', 5, null);
  const result = await pending;
  assertEqual(result.confirmed, false, 'Root fallback kill cannot confirm Windows descendants');
  assertIncludes(result.detail, 'exited 5', 'Should retain helper exit diagnosis');
  assertEqual(root.kills.length, 1, 'Should still attempt direct-child fallback');
}

async function testSpawnAndEventErrors(): Promise<void> {
  const root = fakeChild();
  const thrown = await terminateTestProcess(root.child, new AbortController().signal, {
    platform: 'win32',
    spawnHelper: () => {
      throw new Error('cannot spawn');
    },
  });
  assertEqual(thrown.confirmed, false, 'Thrown helper spawn should be unconfirmed');
  assertIncludes(thrown.detail, 'cannot spawn', 'Should retain spawn failure');
  const helper = fakeChild();
  const pending = terminateTestProcess(root.child, new AbortController().signal, {
    platform: 'win32',
    spawnHelper: () => helper.child,
  });
  helper.child.kill = (): boolean => {
    helper.child.emit('error', new Error('failed stop request'));
    return false;
  };
  helper.child.emit('error', new Error('ENOENT'));
  helper.child.emit('close', -2, null);
  helper.child.emit('error', new Error('late repeated helper error'));
  const eventError = await pending;
  assertEqual(eventError.confirmed, false, 'Error followed by close must stay failed');
  assertIncludes(eventError.detail, 'ENOENT', 'Should retain the first failure');
}

async function testAttemptAndReapAreBounded(): Promise<void> {
  const root = fakeChild();
  const helper = fakeChild();
  const startedAt = performance.now();
  const result = await terminateTestProcess(root.child, new AbortController().signal, {
    platform: 'win32',
    spawnHelper: () => helper.child,
    attemptTimeoutMs: 10,
    reapGraceMs: 10,
  });
  assertEqual(result.confirmed, false, 'Unreaped helper cannot confirm the tree');
  assert(helper.kills.length > 0, 'Should kill an overdue helper');
  assert(helper.isDetached(), 'Should detach the helper after bounded reap');
  assert(performance.now() - startedAt < 1_000, 'Attempt and reap must have a finite bound');
  helper.child.emit('close', 0, null);
  helper.child.emit('error', new Error('late helper error'));
  assertEqual(result.confirmed, false, 'Late success cannot repair an expired attempt');
}

async function testCloseAfterStopCannotConfirm(): Promise<void> {
  const root = fakeChild();
  const helper = fakeChild();
  helper.child.kill = (): boolean => {
    helper.child.emit('close', 0, null);
    return true;
  };
  const result = await terminateTestProcess(root.child, new AbortController().signal, {
    platform: 'win32',
    spawnHelper: () => helper.child,
    attemptTimeoutMs: 10,
    reapGraceMs: 500,
  });
  assertEqual(result.confirmed, false, 'Even zero exit after forced helper stop is unconfirmed');
  assertIncludes(result.detail, 'attempt deadline', 'Should report attempt expiration');
}

async function testOverallAbortInterruptsHelper(): Promise<void> {
  const root = fakeChild();
  const helper = fakeChild();
  const controller = new AbortController();
  const pending = terminateTestProcess(root.child, controller.signal, {
    platform: 'win32',
    spawnHelper: () => helper.child,
    attemptTimeoutMs: 1_000,
    reapGraceMs: 1_000,
  });
  controller.abort();
  const result = await pending;
  assertEqual(result.confirmed, false, 'Overall deadline cannot report success');
  assert(helper.isDetached(), 'Abort should release the helper without another grace period');
  assertEqual(helper.kills.length, 1, 'Abort should request helper stop');
  assertEqual(root.kills.length, 1, 'Abort should request root fallback stop');
}

async function testAlreadyAbortedDoesNotSpawn(): Promise<void> {
  const root = fakeChild();
  let spawns = 0;
  const result = await terminateTestProcess(root.child, AbortSignal.abort(), {
    platform: 'win32',
    spawnHelper: () => {
      spawns++;
      return fakeChild().child;
    },
  });
  assertEqual(spawns, 0, 'Must not spawn after the overall budget');
  assertEqual(result.confirmed, false, 'Already expired cleanup is unconfirmed');
}

async function testExitedRootDoesNotReusePid(): Promise<void> {
  const root = fakeChild();
  Object.defineProperty(root.child, 'exitCode', { value: 0 });
  let spawns = 0;
  const result = await terminateTestProcess(root.child, new AbortController().signal, {
    platform: 'win32',
    spawnHelper: () => {
      spawns++;
      return fakeChild().child;
    },
  });
  assertEqual(spawns, 0, 'Must not use an exited root PID for taskkill');
  assertEqual(result.confirmed, false, 'Cannot prove descendant termination after root exit');
}

async function testNonWindowsOnlyKillsDirectChild(): Promise<void> {
  const root = fakeChild();
  const result = await terminateTestProcess(root.child, new AbortController().signal, {
    platform: 'linux',
    spawnHelper: () => {
      throw new Error('Must not spawn a Unix process-group utility');
    },
  });
  assertEqual(root.kills.join(','), 'SIGKILL', 'Should kill only the direct child on non-Windows');
  assertEqual(result.confirmed, true, 'Executor still owns confirmation through child close');
}

const watchdog = setTimeout(() => {
  process.stderr.write('Runner termination suite watchdog expired.\n');
  process.exit(1);
}, 5_000);
try {
  await runTestSuite({
    title: 'Testing bounded runner termination',
    tests: [
      { name: 'targets only the owned PID', run: testTargetsOnlyOwnedPid },
      { name: 'helper failure remains unconfirmed', run: testHelperFailureRemainsUnconfirmed },
      { name: 'spawn and event errors', run: testSpawnAndEventErrors },
      { name: 'attempt and reap are bounded', run: testAttemptAndReapAreBounded },
      { name: 'close after stop cannot confirm', run: testCloseAfterStopCannotConfirm },
      { name: 'overall abort interrupts helper', run: testOverallAbortInterruptsHelper },
      { name: 'already aborted does not spawn', run: testAlreadyAbortedDoesNotSpawn },
      { name: 'exited root does not reuse PID', run: testExitedRootDoesNotReusePid },
      { name: 'non-Windows only kills direct child', run: testNonWindowsOnlyKillsDirectChild },
    ],
  });
} finally {
  clearTimeout(watchdog);
}
