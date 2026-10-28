import { spawn, type ChildProcess } from 'node:child_process';
import { executeTestScript, runTestScripts } from '../run-tests.js';
import { assert, assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';
import { fakeChild } from './fakes.js';
import { terminateTestProcess, tryKill } from './termination.js';

const HANGING_SCRIPT = 'test/runner/fixtures/hanging-script.ts';
const SUCCESSFUL_SCRIPT = 'test/runner/fixtures/successful-script.ts';

async function testRealHangTimesOutAndContinues(): Promise<void> {
  let ownedChild: ChildProcess | undefined;
  // Independent watchdog uses direct-child kill only, never taskkill in this suite.
  const watchdog = setTimeout(() => {
    if (ownedChild) tryKill(ownedChild);
    process.stderr.write('Runner real-fixture watchdog expired.\n');
    process.exit(1);
  }, 8_000);
  try {
    const summary = await runTestScripts(
      [HANGING_SCRIPT, SUCCESSFUL_SCRIPT],
      false,
      (testPath, verbose) =>
        executeTestScript(testPath, verbose, 1_000, {
          spawnChild(command, args, options) {
            ownedChild = spawn(command, args, options);
            return ownedChild;
          },
          // The fixture has no descendants. Exercise real process timeout without
          // granting ordinary tests permission to kill Windows process trees.
          terminate: (child, signal) => terminateTestProcess(child, signal, { platform: 'linux' }),
        }),
    );
    const first = summary.results[0];
    assertEqual(first?.timedOut, true, 'Should expire a genuinely hanging script');
    assertEqual(first?.cleanupConfirmed, true, 'Should observe close after direct-child kill');
    assertEqual(first?.timeoutMs, 1_000, 'Should retain the script deadline');
    assertIncludes(first?.output, 'hanging fixture stdout', 'Should retain stdout before timeout');
    assertIncludes(first?.output, 'hanging fixture stderr', 'Should retain stderr before timeout');
    assertIncludes(first?.output, 'truncated at 256 KB', 'Timed-out output must remain bounded');
    assert((first?.output?.length ?? 0) < 263_000, 'Should bound captured timeout output');
    assertEqual(summary.results[1]?.passed, true, 'Should continue after confirmed cleanup');
    assertEqual(summary.failed, 1, 'Timeout should count as exactly one failure');
    assertEqual(summary.notRun.length, 0, 'Both scripts should be executed');
  } finally {
    clearTimeout(watchdog);
    if (ownedChild && ownedChild.exitCode === null && ownedChild.signalCode === null) {
      tryKill(ownedChild);
    }
  }
}

async function testLateZeroCloseCannotPass(): Promise<void> {
  const fake = fakeChild();
  const summary = await runTestScripts(['late.ts'], false, (testPath, verbose) =>
    executeTestScript(testPath, verbose, 10, {
      spawnChild: () => fake.child,
      terminate: async () => {
        fake.child.emit('close', 0, null);
        return { confirmed: true };
      },
      cleanupTimeoutMs: 100,
    }),
  );
  assertEqual(summary.failed, 1, 'Zero exit after deadline must not pass');
  assertEqual(summary.results[0]?.exitCode, 0, 'Should preserve the late exit code');
  assertEqual(summary.results[0]?.timedOut, true, 'Timeout is sticky');
}

async function testExitWithoutCloseStillTimesOut(): Promise<void> {
  const fake = fakeChild();
  let terminationCalled = false;
  const resultPromise = executeTestScript('root-exited.ts', false, 10, {
    spawnChild: () => fake.child,
    terminate: async () => {
      terminationCalled = true;
      fake.child.emit('close', 0, null);
      return { confirmed: true };
    },
    cleanupTimeoutMs: 100,
  });
  fake.child.emit('exit', 0, null);
  const result = await resultPromise;
  assert(!terminationCalled, 'Should not target a PID after observing its root exit');
  assertEqual(result.timedOut, true, 'Only close completes the normal lifecycle');
  assertEqual(result.cleanupConfirmed, false, 'Inherited pipe holders cannot be confirmed stopped');
  assertIncludes(result.cleanupError, 'former PID', 'Should explain why tree cleanup is unsafe');
}

async function testUnconfirmedCleanupStopsFollowingScripts(): Promise<void> {
  const fake = fakeChild();
  const helper = fakeChild(8765);
  let calls = 0;
  const summary = await runTestScripts(
    ['stuck.ts', 'must-not-run.ts'],
    false,
    (testPath, verbose) => {
      calls++;
      return executeTestScript(testPath, verbose, 10, {
        spawnChild: () => fake.child,
        cleanupTimeoutMs: 200,
        terminate: (child, signal) =>
          terminateTestProcess(child, signal, {
            platform: 'win32',
            spawnHelper: () => helper.child,
            attemptTimeoutMs: 10,
            reapGraceMs: 10,
          }),
      });
    },
  );
  const result = summary.results[0];
  assertEqual(calls, 1, 'Unconfirmed termination must stop the serial runner');
  assertEqual(
    result?.cleanupConfirmed,
    false,
    'Unref and local stream release are not confirmation',
  );
  assertIncludes(result?.cleanupError, 'did not close', 'Should diagnose an unreaped helper');
  assertEqual(summary.notRun.join(','), 'must-not-run.ts', 'Should record unrun scripts');
  assertIncludes(summary.stopReason, 'stuck.ts', 'Stop reason should identify ownership');
  assert(fake.isDetached() && helper.isDetached(), 'Should release only local owned handles');
  assert(fake.stdout.destroyed && fake.stderr.destroyed, 'Should destroy stuck child pipes');
  assert(helper.kills.length > 0, 'Should request helper termination before detaching');
  helper.child.emit('close', 0, null);
  fake.child.emit('close', 0, null);
  fake.child.emit('error', new Error('late event'));
  assertEqual(result?.cleanupConfirmed, false, 'Late events cannot rewrite settled failure');
}

async function testOverallCleanupDeadlineBoundsHungDependency(): Promise<void> {
  const fake = fakeChild();
  let cleanupSignal: AbortSignal | undefined;
  const startedAt = performance.now();
  const result = await executeTestScript('hung-cleanup.ts', false, 10, {
    spawnChild: () => fake.child,
    cleanupTimeoutMs: 30,
    terminate: (_child, signal) => {
      cleanupSignal = signal;
      return new Promise(() => {});
    },
  });
  assertEqual(result.cleanupConfirmed, false, 'Unsettled cleanup cannot confirm termination');
  assertIncludes(result.cleanupError, 'Overall cleanup deadline', 'Should diagnose total budget');
  assert(cleanupSignal?.aborted === true, 'Should cancel an in-flight helper at overall deadline');
  assert(performance.now() - startedAt < 1_000, 'Cleanup budget must not accumulate without bound');
  assert(fake.isDetached(), 'Should detach locally after the overall budget');
}

async function testCloseAloneDoesNotConfirmWindowsTree(): Promise<void> {
  const fake = fakeChild();
  const result = await executeTestScript('root-only.ts', false, 10, {
    spawnChild: () => fake.child,
    cleanupTimeoutMs: 100,
    terminate: async () => {
      fake.child.emit('close', 0, null);
      return { confirmed: false, detail: 'taskkill failed' };
    },
  });
  assertEqual(result.cleanupConfirmed, false, 'Root close does not override helper failure');
}

async function testHelperSuccessStillRequiresChildClose(): Promise<void> {
  const fake = fakeChild();
  const result = await executeTestScript('pipes-stuck.ts', false, 10, {
    spawnChild: () => fake.child,
    terminate: async () => ({ confirmed: true }),
    cleanupTimeoutMs: 20,
  });
  assertEqual(result.cleanupConfirmed, false, 'Helper success cannot replace child close');
}

async function testRejectedTerminationIsUnconfirmed(): Promise<void> {
  const fake = fakeChild();
  const result = await executeTestScript('rejects.ts', false, 10, {
    spawnChild: () => fake.child,
    terminate: () => {
      throw new Error('injected failure');
    },
    cleanupTimeoutMs: 100,
  });
  assertEqual(result.cleanupConfirmed, false, 'Thrown cleanup must fail closed');
  assertIncludes(result.cleanupError, 'injected failure', 'Should retain cleanup error');
}

async function testSpawnFailures(): Promise<void> {
  const thrown = await executeTestScript('throws.ts', false, 100, {
    spawnChild: () => {
      throw new Error('spawn threw');
    },
  });
  assertEqual(thrown.error?.message, 'spawn threw', 'Should handle synchronous spawn failure');
  const fake = fakeChild();
  const pending = executeTestScript('error.ts', false, 100, { spawnChild: () => fake.child });
  fake.child.emit('error', new Error('spawn event'));
  fake.child.emit('close', -2, null);
  const result = await pending;
  assertEqual(result.error?.message, 'spawn event', 'Should retain spawn error until close');
  assertEqual(result.timedOut, false, 'Timely spawn failure is not a timeout');
}

async function testNormalCloseCancelsDeadlineAndIgnoresLateEvents(): Promise<void> {
  const fake = fakeChild();
  let terminateCalls = 0;
  const pending = executeTestScript('normal.ts', false, 10, {
    spawnChild: () => fake.child,
    terminate: async () => {
      terminateCalls++;
      return { confirmed: true };
    },
  });
  fake.stdout.write('before close');
  fake.child.emit('close', 0, null);
  const result = await pending;
  fake.child.emit('error', new Error('late error'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEqual(terminateCalls, 0, 'Normal close must cancel the script deadline');
  assertEqual(result.error, undefined, 'Settled success cannot be mutated by late error');
  assertEqual(result.output, 'before close', 'Should retain output through normal close');
  assertEqual(fake.stdout.listenerCount('data'), 0, 'Should remove output listeners');
}

async function testVerboseUsesPipesAndStreamsOutput(): Promise<void> {
  const fake = fakeChild();
  let piped = false;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const streamed: string[] = [];
  process.stdout.write = ((chunk: Buffer) => {
    streamed.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = process.stdout.write;
  try {
    const pending = executeTestScript('verbose.ts', true, 100, {
      spawnChild: (_command, args, options) => {
        piped = JSON.stringify(options.stdio) === '["ignore","pipe","pipe"]';
        assert(args.includes('--verbose'), 'Should forward verbose to the script');
        return fake.child;
      },
    });
    fake.stdout.write('streamed stdout');
    fake.stderr.write('streamed stderr');
    fake.child.emit('close', 1, null);
    const result = await pending;
    assert(piped, 'Verbose must retain pipes so deadline covers inherited pipe holders');
    assertEqual(
      streamed.join(','),
      'streamed stdout,streamed stderr',
      'Should stream both channels',
    );
    assertIncludes(result.output, 'streamed stdout', 'Verbose capture should remain available');
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

// Separate from all injected execution/cleanup clocks.
const watchdog = setTimeout(() => {
  process.stderr.write('Runner lifecycle suite watchdog expired.\n');
  process.exit(1);
}, 20_000);
try {
  await runTestSuite({
    title: 'Testing script execution deadlines',
    tests: [
      { name: 'real hang times out and continues', run: testRealHangTimesOutAndContinues },
      { name: 'late zero close cannot pass', run: testLateZeroCloseCannotPass },
      { name: 'exit without close still times out', run: testExitWithoutCloseStillTimesOut },
      {
        name: 'unconfirmed cleanup stops following scripts',
        run: testUnconfirmedCleanupStopsFollowingScripts,
      },
      {
        name: 'overall cleanup deadline bounds hung dependency',
        run: testOverallCleanupDeadlineBoundsHungDependency,
      },
      {
        name: 'close alone does not confirm Windows tree',
        run: testCloseAloneDoesNotConfirmWindowsTree,
      },
      {
        name: 'helper success still requires child close',
        run: testHelperSuccessStillRequiresChildClose,
      },
      { name: 'rejected termination is unconfirmed', run: testRejectedTerminationIsUnconfirmed },
      { name: 'spawn failures', run: testSpawnFailures },
      {
        name: 'normal close cancels deadline and ignores late events',
        run: testNormalCloseCancelsDeadlineAndIgnoresLateEvents,
      },
      { name: 'verbose uses pipes and streams output', run: testVerboseUsesPipesAndStreamsOutput },
    ],
  });
} finally {
  clearTimeout(watchdog);
}
