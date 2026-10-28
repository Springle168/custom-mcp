import { spawn, type ChildProcess } from 'node:child_process';
import { executeTestScript, runTestScripts } from '../run-tests.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';
import { tryKill } from './termination.js';

let ownedRoot: ChildProcess | undefined;
const watchdog = setTimeout(() => {
  if (ownedRoot) tryKill(ownedRoot);
  process.stderr.write('Privileged runner timeout watchdog expired.\n');
  process.exit(1);
}, 10_000);

async function testWindowsTreeTermination(): Promise<void> {
  const summary = await runTestScripts(
    ['test/runner/fixtures/process-tree-script.ts', 'test/runner/fixtures/successful-script.ts'],
    false,
    (testPath, verbose) =>
      executeTestScript(testPath, verbose, 1_500, {
        spawnChild(command, args, options) {
          ownedRoot = spawn(command, args, options);
          return ownedRoot;
        },
      }),
  );
  const result = summary.results[0];
  assertEqual(result?.timedOut, true, 'Should expire the live process tree');
  assertEqual(result?.cleanupConfirmed, true, 'taskkill and root close must both complete');
  const pidText = result?.output?.match(/runner descendant PID: (\d+)/u)?.[1];
  assert(pidText !== undefined, 'Fixture should spawn a descendant before its deadline');
  let descendantAlive = true;
  try {
    process.kill(Number(pidText), 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    descendantAlive = false;
  }
  assert(!descendantAlive, 'Owned descendant should be gone after taskkill confirms the tree');
  assertEqual(summary.results[1]?.passed, true, 'Confirmed tree cleanup should allow continuation');
}

try {
  if (process.platform !== 'win32') {
    console.log('Windows runner process-tree validation skipped on non-Windows.');
  } else {
    await runTestSuite({
      title: 'Testing privileged Windows runner timeouts',
      // Windows Node pipe inheritance does not reliably keep the root's close
      // pending after exit. That event ordering is covered with fake children in
      // script-execution.test.ts, not claimed as a real process-tree assertion here.
      tests: [{ name: 'timeout kills the owned process tree', run: testWindowsTreeTermination }],
    });
  }
} finally {
  clearTimeout(watchdog);
}
