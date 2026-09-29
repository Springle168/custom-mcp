import {
  ExternalRoutingExecutor,
  type ExternalRouteOperation,
} from '../../src/tools/external-routing/executor.js';
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

type RouteOutcome = Awaited<ReturnType<ExternalRouteOperation['exchange']>['settled']>;

function textOutcome(message: string, isError = false): RouteOutcome {
  return { kind: 'result', result: { content: [{ type: 'text', text: message }], isError } };
}

function fixedRoute(outcome: RouteOutcome): ExternalRouteOperation {
  return {
    exchange() {
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

async function testReturnsRouteResults(): Promise<void> {
  const completedExecutor = new ExternalRoutingExecutor({
    routes: fixedRoute(textOutcome('done')),
  });
  const completed = await completedExecutor.execute('test-route', invocation());
  assertEqual(completed.isError, false, 'Completed external result should be a successful ToolCallResult');
  assertEqual(getResultText(completed), 'done', 'Completed message should be returned unchanged');
  await completedExecutor.close();

  const failedExecutor = new ExternalRoutingExecutor({
    routes: fixedRoute(textOutcome('business message', true)),
  });
  const failed = await failedExecutor.execute('test-route', invocation());
  assertEqual(failed.isError, true, 'Route business errors should remain ToolCallResult errors');
  assertEqual(getResultText(failed), 'business message', 'Route result content should remain unchanged');
  await failedExecutor.close();
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
    'mcp_connection_failed',
    'mcp_capability_missing',
    'mcp_call_failed',
    'mcp_timeout',
    'mcp_protocol_failed',
    'mcp_result_unsupported',
    'mcp_transport_failed',
    'external_internal_failed',
    'cancelled',
  ] as const;

  for (const code of codes) {
    const executor = new ExternalRoutingExecutor({
      routes: fixedRoute({ kind: 'failure', code }),
    });
    const result = await executor.execute('test-route', invocation());
    const text = getResultText(result);
    assertEqual(result.isError, true, `${code} should map to a ToolCallResult error`);
    assert(text.length > 0, `${code} should use a controlled actionable message`);
    assertNotIncludes(text, 'query-secret', 'Local templates must not contain endpoint query data');
    assertNotIncludes(text, 'raw-stdio', 'Local templates must not contain Processor stdio');
    await executor.close();
  }
}

async function testPassesRouteIdentityAndInvocation(): Promise<void> {
  let receivedDefinitionId: string | undefined;
  let receivedName: string | undefined;
  const executor = new ExternalRoutingExecutor({
    routes: {
      exchange(options) {
        receivedDefinitionId = options.definitionId;
        receivedName = options.invocation.name;
        return fixedRoute(textOutcome('routed')).exchange(options);
      },
    },
  });
  const result = await executor.execute('test-route', invocation());
  assertEqual(getResultText(result), 'routed', 'Route result should reach the caller');
  assertEqual(receivedDefinitionId, 'test-route', 'Route should receive the bound definition ID');
  assertEqual(receivedName, 'external_tool', 'Route should receive the local Tool name');
  await executor.close();
}

async function testCancellationSettlesBeforeStrategyDrain(): Promise<void> {
  const settled = deferred<RouteOutcome>();
  const drained = deferred<void>();
  let operationSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const executor = new ExternalRoutingExecutor({
    routes: {
      exchange(options) {
        operationSignal = options.signal;
        return { settled: settled.promise, drained: drained.promise };
      },
    },
  });

  const resultPromise = executor.execute('test-route', invocation({ signal: controller.signal }));
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

async function testRouteBoundCallsShareOneAdmissionPool(): Promise<void> {
  const drains = Array.from({ length: 9 }, () => deferred<void>());
  const startedDefinitionIds: string[] = [];
  const executor = new ExternalRoutingExecutor({
    routes: {
      exchange(options) {
        const index = startedDefinitionIds.length;
        startedDefinitionIds.push(options.definitionId);
        return {
          settled: Promise.resolve(textOutcome('done')),
          drained: drains[index]?.promise ?? Promise.resolve(),
        };
      },
    },
  });

  const activeCalls = Array.from({ length: 8 }, (_, index) =>
    executor.execute(index % 2 === 0 ? 'route-a' : 'route-b', invocation())
  );
  await Promise.all(activeCalls);
  const pendingCall = executor.execute('route-b', invocation());
  await Promise.resolve();

  assertEqual(executor.activeExchangeCount, 8, 'Both routes should consume the same eight active slots.');
  assertEqual(executor.pendingExchangeCount, 1, 'A call from either route should enter the shared pending FIFO.');
  assertEqual(startedDefinitionIds.length, 8, 'Pending route work must not start before a shared slot drains.');

  drains[0]?.resolve();
  while (startedDefinitionIds.length < 9) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  await pendingCall;
  assertEqual(
    startedDefinitionIds[8],
    'route-b',
    'The pending call should retain its route identity when promoted.',
  );

  for (const drain of drains.slice(1)) {
    drain.resolve();
  }
  await executor.close();
}

async function testCloseWaitsForDrainBeforeClosingResourcesAndIsIdempotent(): Promise<void> {
  const settled = deferred<RouteOutcome>();
  const drained = deferred<void>();
  const events: string[] = [];
  const executor = new ExternalRoutingExecutor({
    routes: {
      exchange() {
        return { settled: settled.promise, drained: drained.promise };
      },
    },
    closeResources: async () => {
      events.push('resources');
    },
  });

  void executor.execute('test-route', invocation());
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

async function testCloseStartsDrainingResourcesBeforeActiveDrain(): Promise<void> {
  const settled = deferred<RouteOutcome>();
  const drained = deferred<void>();
  const events: string[] = [];
  const executor = new ExternalRoutingExecutor({
    routes: {
      exchange() {
        return { settled: settled.promise, drained: drained.promise };
      },
    },
    closeDrainingResources: async () => {
      events.push('draining');
      drained.resolve();
    },
    closeResources: async () => {
      events.push('after-drain');
    },
  });

  void executor.execute('test-route', invocation());
  const closed = executor.close();
  assertEqual(events.join(','), 'draining', 'MCP-owned resources must start closing before active drain completes');
  settled.resolve({ kind: 'failure', code: 'cancelled' });
  await closed;
  assertEqual(events.join(','), 'draining,after-drain', 'HTTP resources close only after active drain');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external-routing executor mapping and ownership',
    tests: [
      { name: 'returns route results', run: testReturnsRouteResults },
      { name: 'maps controlled local failures without raw data', run: testMapsControlledLocalFailuresWithoutRawData },
      { name: 'passes route identity and invocation', run: testPassesRouteIdentityAndInvocation },
      { name: 'settles cancellation before strategy drain', run: testCancellationSettlesBeforeStrategyDrain },
      { name: 'shares one admission pool across route-bound calls', run: testRouteBoundCallsShareOneAdmissionPool },
      { name: 'closes resources only after runtime drain', run: testCloseWaitsForDrainBeforeClosingResourcesAndIsIdempotent },
      { name: 'starts draining resource close before active drain', run: testCloseStartsDrainingResourcesBeforeActiveDrain },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
