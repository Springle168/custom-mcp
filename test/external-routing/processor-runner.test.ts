import { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROCESSOR_STDERR_CAPTURE_LIMIT_BYTES,
  PROCESSOR_STREAM_LIMIT_BYTES,
  ProcessorRunner,
  type ProcessorInvocation,
  type ProcessorInvocationEnvironment,
  type ProcessorRunFailure,
  type ProcessorRunOutcome,
  type ProcessorRunSuccess,
} from '../../src/tools/external-routing/processor-runner.js';
import {
  assert,
  assertEqual,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'processor-runner');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface EnvironmentEcho {
  readonly stdinBase64: string;
  readonly environment: {
    readonly role: string | null;
    readonly callId: string | null;
    readonly httpStatus: string | null;
    readonly contentType: string | null;
    readonly contentEncoding: string | null;
    readonly inheritedExternalVariable: string | null;
  };
}

function fixtureInvocation(
  fixtureName: string,
  environment: ProcessorInvocationEnvironment,
  options: Partial<Pick<ProcessorInvocation, 'stdin' | 'timeoutMs' | 'signal'>> = {},
): ProcessorInvocation {
  return {
    command: process.execPath,
    arguments: ['--import', 'tsx', path.join(FIXTURES_DIR, fixtureName)],
    workingDirectory: PROJECT_ROOT,
    timeoutMs: 3_000,
    stdin: encoder.encode('processor input'),
    environment,
    ...options,
  };
}

function responseEnvironment(): ProcessorInvocationEnvironment {
  return {
    role: 'response.body-decoder',
    callId: 'call_response_1',
    httpStatus: 207,
    contentType: 'application/vnd.example+json; charset=utf-8',
    contentEncoding: 'gzip, br',
  };
}

function requestEnvironment(): ProcessorInvocationEnvironment {
  return {
    role: 'request.body-encoder',
    callId: 'call_request_1',
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function requireSuccess(outcome: ProcessorRunOutcome): ProcessorRunSuccess {
  assertEqual(outcome.kind, 'success', 'Processor invocation should succeed.');
  if (outcome.kind !== 'success') {
    throw new Error('Expected a successful Processor outcome.');
  }
  return outcome;
}

function requireFailure(
  outcome: ProcessorRunOutcome,
  reason: ProcessorRunFailure['reason'],
): ProcessorRunFailure {
  assertEqual(outcome.kind, 'failure', `Processor should fail with ${reason}.`);
  if (outcome.kind !== 'failure') {
    throw new Error(`Expected Processor failure ${reason}.`);
  }
  assertEqual(outcome.reason, reason, 'Processor failure reason should be stable.');
  return outcome;
}

async function withEnvironment<T>(
  values: Readonly<Record<string, string>>,
  run: () => Promise<T>,
): Promise<T> {
  const previousValues = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previousValues.set(name, process.env[name]);
    process.env[name] = value;
  }

  try {
    return await run();
  } finally {
    for (const [name, previousValue] of previousValues) {
      if (previousValue === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previousValue;
      }
    }
  }
}

async function testRunsBytesAndSanitizesResponseEnvironment(): Promise<void> {
  const runner = new ProcessorRunner();
  const outcome = await withEnvironment({
    CUSTOM_MCP_PROCESSOR_ROLE: 'stale-role',
    custom_mcp_external_call_id: 'stale-call-id',
    CUSTOM_MCP_EXTERNAL_HTTP_STATUS: '599',
    CUSTOM_MCP_EXTERNAL_UNRELATED: 'must-not-inherit',
  }, async () => runner.run(fixtureInvocation('echo-environment.ts', responseEnvironment(), {
    stdin: new Uint8Array([0, 1, 2, 253, 254, 255]),
  })));
  const success = requireSuccess(outcome);
  const echo = JSON.parse(decoder.decode(success.stdout)) as EnvironmentEcho;

  assertEqual(echo.stdinBase64, 'AAEC/f7/', 'Processor should receive stdin bytes exactly once.');
  assertEqual(echo.environment.role, 'response.body-decoder', 'Response role should override parent environment.');
  assertEqual(echo.environment.callId, 'call_response_1', 'Response call ID should be injected.');
  assertEqual(echo.environment.httpStatus, '207', 'Response HTTP status should be injected.');
  assertEqual(
    echo.environment.contentType,
    'application/vnd.example+json; charset=utf-8',
    'Validated response content type should be injected.',
  );
  assertEqual(echo.environment.contentEncoding, 'gzip, br', 'Validated content encoding should be injected.');
  assertEqual(
    echo.environment.inheritedExternalVariable,
    null,
    'Reserved external environment variables must be removed case-insensitively.',
  );
  assertEqual(success.stderr.byteCount, 'processor diagnostic'.length, 'stderr bytes should be counted.');
  assertEqual(success.stderr.truncated, false, 'Small stderr should not be marked truncated.');

  await runner.close();
}

async function testClearsResponseOnlyEnvironmentForRequestProcessor(): Promise<void> {
  const runner = new ProcessorRunner();
  const outcome = await withEnvironment({
    CUSTOM_MCP_EXTERNAL_HTTP_STATUS: '599',
    custom_mcp_external_content_type: 'old-value',
    CUSTOM_MCP_EXTERNAL_CONTENT_ENCODING: 'old-value',
  }, async () => runner.run(fixtureInvocation('echo-environment.ts', requestEnvironment())));
  const echo = JSON.parse(decoder.decode(requireSuccess(outcome).stdout)) as EnvironmentEcho;

  assertEqual(echo.environment.role, 'request.body-encoder', 'Request role should be injected.');
  assertEqual(echo.environment.callId, 'call_request_1', 'Request call ID should be injected.');
  assertEqual(echo.environment.httpStatus, null, 'Request Processors must not inherit HTTP status.');
  assertEqual(echo.environment.contentType, null, 'Request Processors must not inherit content type.');
  assertEqual(echo.environment.contentEncoding, null, 'Request Processors must not inherit content encoding.');

  await runner.close();
}

async function testBoundsStderrCaptureWhileContinuingToDrain(): Promise<void> {
  const runner = new ProcessorRunner();
  const outcome = requireSuccess(await runner.run(
    fixtureInvocation('stderr-over-limit.ts', requestEnvironment()),
  ));

  assertEqual(
    decoder.decode(outcome.stdout),
    'stderr-drained',
    'A Processor should complete after stderr exceeds its retained capture limit.',
  );
  assertEqual(
    outcome.stderr.byteCount,
    PROCESSOR_STDERR_CAPTURE_LIMIT_BYTES + 257,
    'stderr total byte count should continue after capture truncation.',
  );
  assertEqual(
    outcome.stderr.capturedByteCount,
    PROCESSOR_STDERR_CAPTURE_LIMIT_BYTES,
    'stderr retention must stop at its fixed capture limit.',
  );
  assertEqual(outcome.stderr.truncated, true, 'Over-limit stderr should be marked truncated.');

  await runner.close();
}

async function testRejectsOversizeStdinWithoutStartingAProcess(): Promise<void> {
  const runner = new ProcessorRunner();
  const outcome = requireFailure(await runner.run(fixtureInvocation('echo-environment.ts', requestEnvironment(), {
    stdin: new Uint8Array(PROCESSOR_STREAM_LIMIT_BYTES + 1),
  })), 'stdin_limit');

  assertEqual(outcome.stdoutBytes, 0, 'Rejected stdin must not produce output.');
  assertEqual(runner.activeInvocationCount, 0, 'Rejected stdin must not enter active tracking.');
  await runner.close();
}

async function testTerminatesOnOversizeStdout(): Promise<void> {
  const runner = new ProcessorRunner({
    terminationGracePeriodMs: 25,
    forceTerminationGracePeriodMs: 25,
  });
  const outcome = requireFailure(await runner.run(
    fixtureInvocation('stdout-over-limit.ts', requestEnvironment(), { timeoutMs: 5_000 }),
  ), 'stdout_limit');

  assert(
    outcome.stdoutBytes > PROCESSOR_STREAM_LIMIT_BYTES,
    'Runner must count the chunk that exceeds the stdout limit.',
  );
  assertNotIncludes(
    JSON.stringify(outcome),
    'oooooooo',
    'Failed Processor output must not be exposed in structured runner outcomes.',
  );

  await runner.close();
}

async function testClassifiesSpawnExitSignalAndStdioFailures(): Promise<void> {
  const spawnRunner = new ProcessorRunner();
  const spawnOutcome = requireFailure(await spawnRunner.run({
    ...fixtureInvocation('echo-environment.ts', requestEnvironment()),
    command: path.join(FIXTURES_DIR, 'missing-processor-command.exe'),
  }), 'spawn_error');
  assertNotIncludes(
    JSON.stringify(spawnOutcome),
    'missing-processor-command.exe',
    'Spawn failures must not expose local executable paths.',
  );
  await spawnRunner.close();

  const exitRunner = new ProcessorRunner();
  const exitOutcome = requireFailure(await exitRunner.run(
    fixtureInvocation('non-zero.ts', requestEnvironment()),
  ), 'exit_code');
  assertNotIncludes(
    JSON.stringify(exitOutcome),
    'untrusted',
    'Non-zero Processor stdout and stderr must not escape the runner.',
  );
  await exitRunner.close();

  const signalRunner = new ProcessorRunner();
  requireFailure(await signalRunner.run(
    fixtureInvocation('self-signal.ts', requestEnvironment()),
  ), process.platform === 'win32' ? 'exit_code' : 'signal');
  await signalRunner.close();

  const stdioRunner = new ProcessorRunner({
    terminationGracePeriodMs: 25,
    forceTerminationGracePeriodMs: 25,
  });
  requireFailure(await stdioRunner.run(fixtureInvocation('close-stdin.ts', requestEnvironment(), {
    stdin: new Uint8Array(8 * 1024 * 1024),
  })), 'stdio_error');
  await stdioRunner.close();
}

async function testHandlesTimeoutCancellationAndBoundedDegradedCleanup(): Promise<void> {
  const timeoutRunner = new ProcessorRunner({
    terminationGracePeriodMs: 25,
    forceTerminationGracePeriodMs: 25,
  });
  requireFailure(await timeoutRunner.run(
    fixtureInvocation('wait-forever.ts', requestEnvironment(), { timeoutMs: 50 }),
  ), 'timeout');
  await timeoutRunner.close();

  const cancellationRunner = new ProcessorRunner({
    terminationGracePeriodMs: 25,
    forceTerminationGracePeriodMs: 25,
  });
  const controller = new AbortController();
  const pending = cancellationRunner.run(
    fixtureInvocation('wait-forever.ts', requestEnvironment(), { signal: controller.signal }),
  );
  assertEqual(cancellationRunner.activeInvocationCount, 1, 'Started Processors should remain active until cleanup completes.');
  controller.abort();
  requireFailure(await pending, 'cancelled');
  assertEqual(cancellationRunner.activeInvocationCount, 0, 'Cancelled Processor should leave active tracking after cleanup.');
  await cancellationRunner.close();

  // Intercepting direct-child kill keeps this branch deterministic; the fixture exits itself.
  const originalKill = ChildProcess.prototype.kill;
  const originalUnref = ChildProcess.prototype.unref;
  let unrefCalls = 0;
  ChildProcess.prototype.kill = function suppressTerminationSignal(): boolean {
    return false;
  };
  ChildProcess.prototype.unref = function recordUnref(): void {
    unrefCalls++;
    originalUnref.call(this);
  };
  try {
    const degradedRunner = new ProcessorRunner({
      terminationGracePeriodMs: 1,
      forceTerminationGracePeriodMs: 1,
    });
    const degraded = requireFailure(await degradedRunner.run(
      fixtureInvocation('unconfirmed-child.ts', requestEnvironment(), { timeoutMs: 10 }),
    ), 'timeout');
    assertEqual(degraded.cleanupFailed, true, 'Unconfirmed direct child cleanup must be reported.');
    assertEqual(degradedRunner.activeInvocationCount, 0, 'Degraded cleanup must still release local active tracking.');
    assertEqual(unrefCalls, 1, 'Unconfirmed direct child must be unrefed after local cleanup detaches.');
    requireFailure(await degradedRunner.run(
      fixtureInvocation('echo-environment.ts', requestEnvironment()),
    ), 'runner_closed');
    await degradedRunner.close();
  } finally {
    ChildProcess.prototype.kill = originalKill;
    ChildProcess.prototype.unref = originalUnref;
    await delay(300);
  }
}

async function testWaitsForCompleteOutputAndClosesIdempotently(): Promise<void> {
  const runner = new ProcessorRunner({
    terminationGracePeriodMs: 25,
    forceTerminationGracePeriodMs: 25,
  });
  const complete = requireSuccess(await runner.run(
    fixtureInvocation('complete-output.ts', requestEnvironment()),
  ));
  assertEqual(
    decoder.decode(complete.stdout),
    'complete-output',
    'Runner must wait for stdout EOF before returning a successful Processors result.',
  );

  const active = runner.run(fixtureInvocation('wait-forever.ts', requestEnvironment()));
  assertEqual(runner.activeInvocationCount, 1, 'Long-running Processor should be active before runner shutdown.');
  const firstClose = runner.close();
  const secondClose = runner.close();
  assert(Object.is(firstClose, secondClose), 'Processor runner close must be idempotent.');
  requireFailure(await active, 'cancelled');
  await firstClose;
  assertEqual(runner.activeInvocationCount, 0, 'close() must wait for active local cleanup.');
  requireFailure(await runner.run(
    fixtureInvocation('echo-environment.ts', requestEnvironment()),
  ), 'runner_closed');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external-routing Processor runner',
    tests: [
      { name: 'runs bytes and sanitizes response invocation metadata', run: testRunsBytesAndSanitizesResponseEnvironment },
      { name: 'clears response-only metadata for request Processors', run: testClearsResponseOnlyEnvironmentForRequestProcessor },
      { name: 'bounds stderr capture while continuing to drain', run: testBoundsStderrCaptureWhileContinuingToDrain },
      { name: 'rejects oversize stdin before admission', run: testRejectsOversizeStdinWithoutStartingAProcess },
      { name: 'terminates Processors that exceed stdout limit', run: testTerminatesOnOversizeStdout },
      { name: 'classifies spawn, exit, signal, and stdio failures', run: testClassifiesSpawnExitSignalAndStdioFailures },
      { name: 'handles timeout, cancellation, and bounded degraded cleanup', run: testHandlesTimeoutCancellationAndBoundedDegradedCleanup },
      { name: 'waits for complete output and closes idempotently', run: testWaitsForCompleteOutputAndClosesIdempotently },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
