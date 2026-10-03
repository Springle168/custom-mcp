import { ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROCESSOR_STDERR_CAPTURE_LIMIT_BYTES,
  PROCESSOR_STREAM_LIMIT_BYTES,
  ProcessorRunner,
  type ProcessorInvocation,
  type ProcessorInvocationEnvironment,
  type ProcessorRunExchange,
  type ProcessorRunFailure,
  type ProcessorRunOutcome,
  type ProcessorRunSuccess,
} from '../../src/tools/external-routing/processor-runner.js';
import { assert, assertEqual, assertNotIncludes, runTestSuite } from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'processor-runner');
const CONTROLLED_TIMEOUT_MS = 60_000;
const READINESS_WATCHDOG_MS = 15_000;
const READINESS_PAYLOAD = 'ready\n';
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
  fixtureArguments: readonly string[] = [],
): ProcessorInvocation {
  return {
    command: process.execPath,
    arguments: ['--import', 'tsx', path.join(FIXTURES_DIR, fixtureName), ...fixtureArguments],
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

interface ReadinessServer {
  readonly port: number;
  readonly ready: Promise<void>;
  dispose(): Promise<void>;
}

async function createReadinessServer(): Promise<ReadinessServer> {
  const sockets = new Set<net.Socket>();
  let connectionAccepted = false;
  let readySettled = false;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A setup failure can dispose the helper before the test reaches `await ready`.
  void ready.catch(() => {});

  const settleReady = (error?: Error): void => {
    if (readySettled) {
      return;
    }

    readySettled = true;
    clearTimeout(watchdog);
    watchdog = undefined;
    if (error) {
      rejectReady?.(error);
    } else {
      resolveReady?.();
    }
    resolveReady = undefined;
    rejectReady = undefined;
  };

  const server = net.createServer((socket) => {
    if (connectionAccepted) {
      socket.destroy();
      settleReady(new Error('Readiness server received more than one connection.'));
      return;
    }

    connectionAccepted = true;
    sockets.add(socket);
    socket.setEncoding('utf8');
    let payload = '';

    socket.on('data', (chunk: string) => {
      payload += chunk;
      if (!READINESS_PAYLOAD.startsWith(payload)) {
        settleReady(
          new Error(`Readiness server received invalid payload: ${JSON.stringify(payload)}`),
        );
        socket.destroy();
        return;
      }

      if (payload === READINESS_PAYLOAD) {
        settleReady();
        socket.end();
      }
    });
    socket.once('end', () => {
      if (!readySettled) {
        settleReady(new Error('Readiness connection ended before sending the complete payload.'));
      }
    });
    socket.once('error', (error) => {
      settleReady(new Error(`Readiness connection failed: ${error.message}`));
    });
    socket.once('close', () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onListenError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onListenError);
      resolve();
    });
  });
  server.on('error', (error) => {
    settleReady(new Error(`Readiness server failed: ${error.message}`));
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Readiness server did not expose a loopback TCP port.');
  }

  watchdog = setTimeout(() => {
    settleReady(
      new Error(`Timed out after ${READINESS_WATCHDOG_MS}ms waiting for descendant readiness.`),
    );
  }, READINESS_WATCHDOG_MS);

  let disposed = false;
  return {
    port: address.port,
    ready,
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      settleReady(new Error('Readiness server was disposed before readiness completed.'));
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();

      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

interface ControlledTimeoutCapture {
  assertCaptured(): void;
  restore(): void;
  trigger(): void;
}

function installControlledTimeoutCapture(delayMs: number): ControlledTimeoutCapture {
  const originalSetTimeout = globalThis.setTimeout;
  let capturedCallback: (() => void) | undefined;
  let restored = false;
  let triggered = false;

  const wrappedSetTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): NodeJS.Timeout => {
    if (delay === delayMs) {
      if (capturedCallback) {
        throw new Error(`More than one controlled ${delayMs}ms timeout was registered.`);
      }
      capturedCallback = () => {
        callback(...args);
      };
    }

    return Reflect.apply(originalSetTimeout, globalThis, [
      callback,
      delay,
      ...args,
    ]) as NodeJS.Timeout;
  }) as typeof globalThis.setTimeout;

  globalThis.setTimeout = wrappedSetTimeout;

  return {
    assertCaptured(): void {
      assert(
        capturedCallback !== undefined,
        `Expected one controlled ${delayMs}ms timeout registration.`,
      );
    },
    restore(): void {
      if (restored) {
        return;
      }
      restored = true;
      if (globalThis.setTimeout !== wrappedSetTimeout) {
        throw new Error('Controlled timeout wrapper was unexpectedly replaced.');
      }
      globalThis.setTimeout = originalSetTimeout;
    },
    trigger(): void {
      if (!capturedCallback) {
        throw new Error(`Controlled ${delayMs}ms timeout was not registered.`);
      }
      if (triggered) {
        throw new Error(`Controlled ${delayMs}ms timeout was already triggered.`);
      }
      triggered = true;
      capturedCallback();
    },
  };
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
  const outcome = await withEnvironment(
    {
      CUSTOM_MCP_PROCESSOR_ROLE: 'stale-role',
      custom_mcp_external_call_id: 'stale-call-id',
      CUSTOM_MCP_EXTERNAL_HTTP_STATUS: '599',
      CUSTOM_MCP_EXTERNAL_UNRELATED: 'must-not-inherit',
    },
    async () =>
      runner.run(
        fixtureInvocation('echo-environment.ts', responseEnvironment(), {
          stdin: new Uint8Array([0, 1, 2, 253, 254, 255]),
        }),
      ).settled,
  );
  const success = requireSuccess(outcome);
  const echo = JSON.parse(decoder.decode(success.stdout)) as EnvironmentEcho;

  assertEqual(echo.stdinBase64, 'AAEC/f7/', 'Processor should receive stdin bytes exactly once.');
  assertEqual(
    echo.environment.role,
    'response.body-decoder',
    'Response role should override parent environment.',
  );
  assertEqual(echo.environment.callId, 'call_response_1', 'Response call ID should be injected.');
  assertEqual(echo.environment.httpStatus, '207', 'Response HTTP status should be injected.');
  assertEqual(
    echo.environment.contentType,
    'application/vnd.example+json; charset=utf-8',
    'Validated response content type should be injected.',
  );
  assertEqual(
    echo.environment.contentEncoding,
    'gzip, br',
    'Validated content encoding should be injected.',
  );
  assertEqual(
    echo.environment.inheritedExternalVariable,
    null,
    'Reserved external environment variables must be removed case-insensitively.',
  );
  assertEqual(
    success.stderr.byteCount,
    'processor diagnostic'.length,
    'stderr bytes should be counted.',
  );
  assertEqual(success.stderr.truncated, false, 'Small stderr should not be marked truncated.');

  await runner.close();
}

async function testClearsResponseOnlyEnvironmentForRequestProcessor(): Promise<void> {
  const runner = new ProcessorRunner();
  const outcome = await withEnvironment(
    {
      CUSTOM_MCP_EXTERNAL_HTTP_STATUS: '599',
      custom_mcp_external_content_type: 'old-value',
      CUSTOM_MCP_EXTERNAL_CONTENT_ENCODING: 'old-value',
    },
    async () => runner.run(fixtureInvocation('echo-environment.ts', requestEnvironment())).settled,
  );
  const echo = JSON.parse(decoder.decode(requireSuccess(outcome).stdout)) as EnvironmentEcho;

  assertEqual(echo.environment.role, 'request.body-encoder', 'Request role should be injected.');
  assertEqual(echo.environment.callId, 'call_request_1', 'Request call ID should be injected.');
  assertEqual(
    echo.environment.httpStatus,
    null,
    'Request Processors must not inherit HTTP status.',
  );
  assertEqual(
    echo.environment.contentType,
    null,
    'Request Processors must not inherit content type.',
  );
  assertEqual(
    echo.environment.contentEncoding,
    null,
    'Request Processors must not inherit content encoding.',
  );

  await runner.close();
}

async function testBoundsStderrCaptureWhileContinuingToDrain(): Promise<void> {
  const runner = new ProcessorRunner();
  const outcome = requireSuccess(
    await runner.run(fixtureInvocation('stderr-over-limit.ts', requestEnvironment())).settled,
  );

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
  const outcome = requireFailure(
    await runner.run(
      fixtureInvocation('echo-environment.ts', requestEnvironment(), {
        stdin: new Uint8Array(PROCESSOR_STREAM_LIMIT_BYTES + 1),
      }),
    ).settled,
    'stdin_limit',
  );

  assertEqual(outcome.stdoutBytes, 0, 'Rejected stdin must not produce output.');
  assertEqual(runner.activeInvocationCount, 0, 'Rejected stdin must not enter active tracking.');
  await runner.close();
}

async function testTerminatesOnOversizeStdout(): Promise<void> {
  const runner = new ProcessorRunner({
    terminationGracePeriodMs: 25,
    forceTerminationGracePeriodMs: 25,
  });
  const outcome = requireFailure(
    await runner.run(
      fixtureInvocation('stdout-over-limit.ts', requestEnvironment(), { timeoutMs: 5_000 }),
    ).settled,
    'stdout_limit',
  );

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
  const spawnOutcome = requireFailure(
    await spawnRunner.run({
      ...fixtureInvocation('echo-environment.ts', requestEnvironment()),
      command: path.join(FIXTURES_DIR, 'missing-processor-command.exe'),
    }).settled,
    'spawn_error',
  );
  assertNotIncludes(
    JSON.stringify(spawnOutcome),
    'missing-processor-command.exe',
    'Spawn failures must not expose local executable paths.',
  );
  await spawnRunner.close();

  const exitRunner = new ProcessorRunner();
  const exitOutcome = requireFailure(
    await exitRunner.run(fixtureInvocation('non-zero.ts', requestEnvironment())).settled,
    'exit_code',
  );
  assertNotIncludes(
    JSON.stringify(exitOutcome),
    'untrusted',
    'Non-zero Processor stdout and stderr must not escape the runner.',
  );
  await exitRunner.close();

  const signalRunner = new ProcessorRunner();
  requireFailure(
    await signalRunner.run(fixtureInvocation('self-signal.ts', requestEnvironment())).settled,
    process.platform === 'win32' ? 'exit_code' : 'signal',
  );
  await signalRunner.close();

  const stdioRunner = new ProcessorRunner({
    terminationGracePeriodMs: 25,
    forceTerminationGracePeriodMs: 25,
  });
  requireFailure(
    await stdioRunner.run(
      fixtureInvocation('close-stdin.ts', requestEnvironment(), {
        stdin: new Uint8Array(8 * 1024 * 1024),
      }),
    ).settled,
    'stdio_error',
  );
  await stdioRunner.close();
}

async function testTriggersTimeoutAfterDescendantReportsHeldStdio(): Promise<void> {
  const readiness = await createReadinessServer();
  const originalUnref = ChildProcess.prototype.unref;
  let unrefCalls = 0;
  ChildProcess.prototype.unref = function recordUnref(): void {
    unrefCalls++;
    originalUnref.call(this);
  };
  const runner = new ProcessorRunner({
    terminationGracePeriodMs: 50,
    forceTerminationGracePeriodMs: 50,
  });

  try {
    // Capture only the synchronous wall-clock registration; every later timer remains native.
    const timeoutCapture = installControlledTimeoutCapture(CONTROLLED_TIMEOUT_MS);
    let exchange: ProcessorRunExchange;
    try {
      exchange = runner.run(
        fixtureInvocation(
          'spawn-descendant-holding-stdio.ts',
          requestEnvironment(),
          { timeoutMs: CONTROLLED_TIMEOUT_MS },
          [`--ready-port=${readiness.port}`],
        ),
      );
      timeoutCapture.assertCaptured();
    } finally {
      timeoutCapture.restore();
    }

    // The fixture reports only after its detached descendant has inherited the output pipes.
    await readiness.ready;
    timeoutCapture.trigger();

    requireFailure(await exchange.settled, 'timeout');
    assertEqual(
      runner.activeInvocationCount,
      1,
      'Timeout must leave descendant-held stdio active until bounded cleanup drains.',
    );
    const close = runner.close();
    let closeCompleted = false;
    void close.then(() => {
      closeCompleted = true;
    });
    await delay(20);
    assertEqual(
      closeCompleted,
      false,
      'runner.close() must wait while a descendant still holds the direct Processor stdio pipe.',
    );

    const drain = await exchange.drained;
    assertEqual(
      drain.cleanupFailed,
      true,
      'Descendant-held stdio must reach bounded degraded cleanup rather than masquerading as a clean close.',
    );
    assertEqual(
      unrefCalls,
      1,
      'Degraded cleanup must unref the unconfirmed direct Processor child.',
    );
    await close;
    assertEqual(
      runner.activeInvocationCount,
      0,
      'Bounded degraded drain must release local active tracking.',
    );
    requireFailure(
      await runner.run(fixtureInvocation('echo-environment.ts', requestEnvironment())).settled,
      'runner_closed',
    );
  } finally {
    ChildProcess.prototype.unref = originalUnref;
    try {
      await readiness.dispose();
    } finally {
      try {
        await runner.close();
      } finally {
        // The descendant self-terminates after 600ms even when its inherited pipes are detached.
        await delay(750);
      }
    }
  }
}

async function testHandlesTimeoutCancellationAndBoundedDegradedCleanup(): Promise<void> {
  // Intercepting direct-child kill creates a bounded, deterministic cleanup delay.
  // The fixture exits itself soon afterwards, so the test leaves no long-lived orphan.
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
    const timeoutRunner = new ProcessorRunner({
      terminationGracePeriodMs: 50,
      forceTerminationGracePeriodMs: 50,
    });
    const timeoutExchange = timeoutRunner.run(
      fixtureInvocation('unconfirmed-child.ts', requestEnvironment(), { timeoutMs: 10 }),
    );
    requireFailure(await timeoutExchange.settled, 'timeout');
    assertEqual(
      timeoutRunner.activeInvocationCount,
      1,
      'Timeout settlement must retain the active slot until local cleanup drains.',
    );
    const timeoutClose = timeoutRunner.close();
    let timeoutCloseCompleted = false;
    void timeoutClose.then(() => {
      timeoutCloseCompleted = true;
    });
    await delay(20);
    assertEqual(
      timeoutCloseCompleted,
      false,
      'runner.close() must wait for timeout cleanup rather than only caller settlement.',
    );
    const timeoutDrain = await timeoutExchange.drained;
    assertEqual(
      timeoutDrain.cleanupFailed,
      true,
      'Unconfirmed timeout cleanup must be reported by drained.',
    );
    await timeoutClose;
    assertEqual(
      timeoutRunner.activeInvocationCount,
      0,
      'Drain completion must release the active timeout slot.',
    );

    const cancellationRunner = new ProcessorRunner({
      terminationGracePeriodMs: 50,
      forceTerminationGracePeriodMs: 50,
    });
    const controller = new AbortController();
    const cancellationExchange = cancellationRunner.run(
      fixtureInvocation('unconfirmed-child.ts', requestEnvironment(), {
        signal: controller.signal,
      }),
    );
    controller.abort();
    requireFailure(await cancellationExchange.settled, 'cancelled');
    assertEqual(
      cancellationRunner.activeInvocationCount,
      1,
      'Cancellation settlement must retain the active slot until local cleanup drains.',
    );
    const cancellationClose = cancellationRunner.close();
    let cancellationCloseCompleted = false;
    void cancellationClose.then(() => {
      cancellationCloseCompleted = true;
    });
    await delay(20);
    assertEqual(
      cancellationCloseCompleted,
      false,
      'runner.close() must wait for cancellation cleanup rather than only caller settlement.',
    );
    const cancellationDrain = await cancellationExchange.drained;
    assertEqual(
      cancellationDrain.cleanupFailed,
      true,
      'Unconfirmed cancellation cleanup must be reported by drained.',
    );
    await cancellationClose;
    assertEqual(
      cancellationRunner.activeInvocationCount,
      0,
      'Drain completion must release the active cancellation slot.',
    );
    assertEqual(
      unrefCalls,
      2,
      'Every unconfirmed direct child must be unrefed after local cleanup detaches.',
    );
    requireFailure(
      await cancellationRunner.run(fixtureInvocation('echo-environment.ts', requestEnvironment()))
        .settled,
      'runner_closed',
    );
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
  const completeExchange = runner.run(
    fixtureInvocation('complete-output.ts', requestEnvironment()),
  );
  const complete = requireSuccess(await completeExchange.settled);
  assertEqual(
    decoder.decode(complete.stdout),
    'complete-output',
    'Runner must wait for stdout EOF before returning a successful Processors result.',
  );
  const completeDrain = await completeExchange.drained;
  assertEqual(
    completeDrain.cleanupFailed,
    false,
    'Successful Processor cleanup should drain normally.',
  );

  const active = runner.run(fixtureInvocation('wait-forever.ts', requestEnvironment()));
  assertEqual(
    runner.activeInvocationCount,
    1,
    'Long-running Processor should be active before runner shutdown.',
  );
  const firstClose = runner.close();
  const secondClose = runner.close();
  assert(Object.is(firstClose, secondClose), 'Processor runner close must be idempotent.');
  requireFailure(await active.settled, 'cancelled');
  await firstClose;
  assertEqual(runner.activeInvocationCount, 0, 'close() must wait for active local cleanup.');
  requireFailure(
    await runner.run(fixtureInvocation('echo-environment.ts', requestEnvironment())).settled,
    'runner_closed',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external-routing Processor runner',
    tests: [
      {
        name: 'runs bytes and sanitizes response invocation metadata',
        run: testRunsBytesAndSanitizesResponseEnvironment,
      },
      {
        name: 'clears response-only metadata for request Processors',
        run: testClearsResponseOnlyEnvironmentForRequestProcessor,
      },
      {
        name: 'bounds stderr capture while continuing to drain',
        run: testBoundsStderrCaptureWhileContinuingToDrain,
      },
      {
        name: 'rejects oversize stdin before admission',
        run: testRejectsOversizeStdinWithoutStartingAProcess,
      },
      {
        name: 'terminates Processors that exceed stdout limit',
        run: testTerminatesOnOversizeStdout,
      },
      {
        name: 'classifies spawn, exit, signal, and stdio failures',
        run: testClassifiesSpawnExitSignalAndStdioFailures,
      },
      {
        name: 'triggers timeout after descendant reports held stdio',
        run: testTriggersTimeoutAfterDescendantReportsHeldStdio,
      },
      {
        name: 'handles timeout, cancellation, and bounded degraded cleanup',
        run: testHandlesTimeoutCancellationAndBoundedDegradedCleanup,
      },
      {
        name: 'waits for complete output and closes idempotently',
        run: testWaitsForCompleteOutputAndClosesIdempotently,
      },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
