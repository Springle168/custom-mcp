import type { CanonicalResponse } from '../../src/tools/external-routing/canonical-protocol.js';
import {
  ExternalRoutingExecutor,
  type ExternalRoutingStrategyOperation,
} from '../../src/tools/external-routing/executor.js';
import type {
  ExternalRoutingStrategyExchange,
  ExternalRoutingStrategyOutcome,
} from '../../src/tools/external-routing/strategy-adapter.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function canonical(response: CanonicalResponse): ExternalRoutingStrategyOutcome {
  if ('error' in response) {
    return { kind: 'canonical', code: 'external_rejected', response };
  }
  const status = response.results[0].status;
  const code = status === 'completed'
    ? 'external_tool_completed'
    : status === 'failed'
      ? 'external_tool_failed'
      : 'external_tool_cancelled';
  return { kind: 'canonical', code, response };
}

function successResponse(status: 'completed' | 'failed' | 'cancelled', message: string): CanonicalResponse {
  return {
    results: [{ id: 'call_test', status, message }],
  };
}

function fixedStrategy(outcome: ExternalRoutingStrategyOutcome): ExternalRoutingStrategyOperation {
  return {
    exchange(): ExternalRoutingStrategyExchange {
      return {
        settled: Promise.resolve(outcome),
        drained: Promise.resolve(),
      };
    },
  };
}

function invocation(overrides: Partial<{
  callId: string;
  name: string;
  arguments: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}> = {}) {
  return {
    callId: overrides.callId ?? 'call_test',
    name: overrides.name ?? 'external_tool',
    arguments: overrides.arguments ?? { value: 'ok' },
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}

async function testMapsCanonicalBusinessOutcomes(): Promise<void> {
  const completedExecutor = new ExternalRoutingExecutor({
    strategy: fixedStrategy(canonical(successResponse('completed', 'done'))),
  });
  const completed = await completedExecutor.execute(invocation());
  assertEqual(completed.isError, false, 'Completed external result should be a successful ToolCallResult');
  assertEqual(getResultText(completed), 'done', 'Completed message should be returned unchanged');
  await completedExecutor.close();

  for (const [status, prefix] of [
    ['failed', 'External tool failed:'] as const,
    ['cancelled', 'External tool reported cancellation:'] as const,
  ]) {
    const executor = new ExternalRoutingExecutor({
      strategy: fixedStrategy(canonical(successResponse(status, 'business message'))),
    });
    const result = await executor.execute(invocation());
    assertEqual(result.isError, true, `${status} should be an MCP tool error`);
    assertIncludes(getResultText(result), prefix, `${status} should use its controlled domain prefix`);
    assertIncludes(getResultText(result), 'business message', 'Validated canonical business output may reach the caller');
    await executor.close();
  }

  const rejectedExecutor = new ExternalRoutingExecutor({
    strategy: fixedStrategy(canonical({
      error: { code: 'invalid_request', message: 'configured rejection' },
    })),
  });
  const rejected = await rejectedExecutor.execute(invocation());
  assertEqual(rejected.isError, true, 'Canonical errors should be MCP tool errors');
  assertIncludes(getResultText(rejected), 'invalid_request', 'Validated rejection code should reach the caller');
  assertIncludes(getResultText(rejected), 'configured rejection', 'Validated rejection message should reach the caller');
  await rejectedExecutor.close();
}

async function testMapsControlledLocalFailuresWithoutRawData(): Promise<void> {
  const codes = [
    'external_request_too_large',
    'external_transport_failed',
    'external_timeout',
    'external_response_too_large',
    'external_protocol_failed',
    'processor_failed',
    'processor_timeout',
    'external_internal_failed',
    'cancelled',
  ] as const;

  for (const code of codes) {
    const executor = new ExternalRoutingExecutor({
      strategy: fixedStrategy({ kind: 'failure', code }),
    });
    const result = await executor.execute(invocation());
    const text = getResultText(result);
    assertEqual(result.isError, true, `${code} should map to a ToolCallResult error`);
    assert(text.length > 0, `${code} should use a controlled actionable message`);
    assertNotIncludes(text, 'query-secret', 'Local templates must not contain endpoint query data');
    assertNotIncludes(text, 'raw-stdio', 'Local templates must not contain Processor stdio');
    await executor.close();
  }
}

async function testRejectsInvalidLocalCanonicalInputWithoutCallingStrategy(): Promise<void> {
  let calls = 0;
  const executor = new ExternalRoutingExecutor({
    strategy: {
      exchange() {
        calls++;
        return fixedStrategy({ kind: 'failure', code: 'external_internal_failed' }).exchange({
          request: undefined as never,
        });
      },
    },
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const result = await executor.execute(invocation({ arguments: cyclic }));
  assertEqual(result.isError, true, 'Non-JSON-compatible arguments should fail locally');
  assertIncludes(getResultText(result), 'internal failure', 'Invalid local input should use a stable internal template');
  assertEqual(calls, 0, 'Invalid local canonical input must not reach strategy execution');
  await executor.close();
}

async function testCancellationSettlesBeforeStrategyDrain(): Promise<void> {
  const settled = deferred<ExternalRoutingStrategyOutcome>();
  const drained = deferred<void>();
  let operationSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const executor = new ExternalRoutingExecutor({
    strategy: {
      exchange(options) {
        operationSignal = options.signal;
        return { settled: settled.promise, drained: drained.promise };
      },
    },
  });

  const resultPromise = executor.execute(invocation({ signal: controller.signal }));
  controller.abort();
  const result = await resultPromise;
  assertEqual(result.isError, true, 'Caller cancellation should settle as a ToolCallResult error');
  assertIncludes(getResultText(result), 'cancelled locally', 'Local cancellation must remain distinct from domain cancellation');
  assertEqual(operationSignal?.aborted, true, 'Runtime should abort its operation-owned signal');
  assertEqual(executor.activeExchangeCount, 1, 'Settled cancellation should retain its slot until strategy drain');

  settled.resolve({ kind: 'failure', code: 'cancelled' });
  drained.resolve();
  await executor.close();
  assertEqual(executor.activeExchangeCount, 0, 'Drain should release the active runtime slot');
}

async function testCloseWaitsForDrainBeforeClosingResourcesAndIsIdempotent(): Promise<void> {
  const settled = deferred<ExternalRoutingStrategyOutcome>();
  const drained = deferred<void>();
  const events: string[] = [];
  const executor = new ExternalRoutingExecutor({
    strategy: {
      exchange() {
        return { settled: settled.promise, drained: drained.promise };
      },
    },
    closeResources: async () => {
      events.push('resources');
    },
  });

  void executor.execute(invocation());
  const firstClose = executor.close();
  const secondClose = executor.close();
  assert(Object.is(firstClose, secondClose), 'Executor close should reuse one idempotent promise');
  await Promise.resolve();
  assertEqual(events.length, 0, 'Owned resources must remain open while the runtime is draining');

  settled.resolve({ kind: 'failure', code: 'cancelled' });
  drained.resolve();
  await firstClose;
  assertEqual(events.join(','), 'resources', 'Resources should close once after runtime drain');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external-routing executor mapping and ownership',
    tests: [
      { name: 'maps canonical business outcomes', run: testMapsCanonicalBusinessOutcomes },
      { name: 'maps controlled local failures without raw data', run: testMapsControlledLocalFailuresWithoutRawData },
      { name: 'rejects invalid local canonical input before strategy', run: testRejectsInvalidLocalCanonicalInputWithoutCallingStrategy },
      { name: 'settles cancellation before strategy drain', run: testCancellationSettlesBeforeStrategyDrain },
      { name: 'closes resources only after runtime drain', run: testCloseWaitsForDrainBeforeClosingResourcesAndIsIdempotent },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
