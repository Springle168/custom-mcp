import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createExternalRoutingExecutor,
  ExternalRoutingExecutor,
  type ExternalRouteOperation,
} from '../../src/tools/external-routing/executor.js';
import {
  parseCanonicalRequestDocument,
  type CanonicalContentBlock,
  type CanonicalRequest,
} from '../../src/tools/external-routing/canonical-protocol.js';
import type { CompiledHttpRoute } from '../../src/tools/external-routing/config.js';
import { isToolCallResult } from '../../src/runtime/invocation/tool-result-validation.js';
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

function invocation(
  overrides: Partial<{
    callId: string;
    name: string;
    arguments: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
  }> = {},
) {
  return {
    callId: overrides.callId ?? 'call_test',
    name: overrides.name ?? 'external_tool',
    arguments: overrides.arguments ?? { value: 'ok' },
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}

async function withHttpExecutor(
  responseFor: (request: CanonicalRequest) => unknown,
  run: (executor: ExternalRoutingExecutor) => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  const requests: Promise<void>[] = [];
  const server = createServer((request, response) => {
    // Node does not consume listener promises; report fixture failures after cleanup.
    requests.push(
      handleRequest(request, response).catch((error: unknown) => {
        failures.push(error);
        response.destroy();
      }),
    );
  });
  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const canonicalRequest = parseCanonicalRequestDocument(Buffer.concat(chunks));
    const body = JSON.stringify(responseFor(canonicalRequest));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(body);
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address !== 'string', 'HTTP fixture should expose a TCP port');
  const route: CompiledHttpRoute = {
    routingMode: 'http',
    definitionId: 'test-route',
    toolName: 'external_tool',
    endpointConfigFilePath: 'test-endpoint.json',
    endpoint: {
      url: `http://127.0.0.1:${address.port}/canonical`,
      timeoutMs: 5_000,
      headers: {},
    },
    requestStage: { mode: 'direct' },
    responseStage: { mode: 'direct' },
  };
  const { executor } = createExternalRoutingExecutor({
    configFilePath: 'test-routing.json',
    processorsByName: new Map(),
    routes: [route],
    routesByDefinitionId: new Map([[route.definitionId, route]]),
  });
  try {
    await run(executor);
  } catch (error: unknown) {
    failures.push(error);
  }

  try {
    await executor.close();
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  } catch (error: unknown) {
    failures.push(error);
  }
  await Promise.all(requests);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'HTTP executor fixture failed');
  }
}

async function testHttpFixtureFailuresReachTest(): Promise<void> {
  const expectedError = new Error('Fixture response construction failed');
  let failure: unknown;
  try {
    await withHttpExecutor(
      () => {
        throw expectedError;
      },
      async (executor) => {
        const result = await executor.execute('test-route', invocation());
        assertEqual(result.isError, true, 'Destroyed fixture response should settle the call');
      },
    );
  } catch (error: unknown) {
    failure = error;
  }
  assert(failure instanceof AggregateError, 'Fixture failure must reject after cleanup');
  assertEqual(failure.errors[0], expectedError, 'Fixture should retain the original error');
}

async function testHttpCanonicalContentMapping(): Promise<void> {
  // These bytes test encoding only; canonical validation does not inspect image files.
  const content: readonly CanonicalContentBlock[] = [
    { type: 'text', text: 'Preview:' },
    { type: 'image', data: 'AQID', mime_type: 'image/webp' },
    {
      type: 'unknown',
      value: { type: 'image', data: 'example', url: 'https://example.test/image' },
    },
    { type: 'text', text: '' },
    { type: 'text', text: 'adjacent text' },
    ...[null, false, 0, '', 'hello', [1, null]].map((value) => ({
      type: 'unknown' as const,
      value,
    })),
  ];
  const expectedContent = [
    { type: 'text', text: 'Preview:' },
    { type: 'image', data: 'AQID', mimeType: 'image/webp' },
    { type: 'text', text: '{"type":"image","data":"example","url":"https://example.test/image"}' },
    { type: 'text', text: '' },
    { type: 'text', text: 'adjacent text' },
    ...['null', 'false', '0', '""', '"hello"', '[1,null]'].map((text) => ({ type: 'text', text })),
  ];
  await withHttpExecutor(
    (request) => ({
      results: [
        {
          id: request.calls[0].id,
          status: request.calls[0].arguments.status,
          content: request.calls[0].arguments.empty ? [] : content,
        },
      ],
      extensions: { fixture: { notMcpMetadata: true } },
    }),
    async (executor) => {
      for (const status of ['completed', 'failed', 'cancelled'] as const) {
        for (const empty of [false, true]) {
          const result = await executor.execute(
            'test-route',
            invocation({ arguments: { status, empty } }),
          );
          assertEqual(
            result.isError,
            status !== 'completed',
            'Only completed should map to successful MCP status',
          );
          assertEqual(
            JSON.stringify(result.content),
            JSON.stringify(empty ? [] : expectedContent),
            'HTTP mapping must preserve every block, text boundary, JSON value and image byte',
          );
          assertEqual(
            Object.keys(result).sort().join(','),
            'content,isError',
            'Mapping must not add metadata or structuredContent',
          );
          assert(
            isToolCallResult(result),
            'Mapped HTTP results must pass unified runtime validation',
          );
        }
      }
    },
  );
}

async function testHttpRejectionsRemainControlled(): Promise<void> {
  await withHttpExecutor(
    () => ({
      error: { code: 'invalid_request', message: '' },
    }),
    async (executor) => {
      const result = await executor.execute('test-route', invocation());
      assertEqual(result.isError, true, 'Top-level rejection should remain an error');
      assertEqual(
        getResultText(result),
        'External endpoint rejected the tool call (invalid_request): ',
        'Endpoint error mapping should be unchanged',
      );
    },
  );

  for (const invalidContent of [
    [
      { type: 'text', text: 'raw-business-secret' },
      { type: 'image', data: 'bad-image-secret', mime_type: 'image/png' },
    ],
    [{ type: 'unknown', value: null, extra: 'raw-business-secret' }],
  ]) {
    await withHttpExecutor(
      (request) => ({
        results: [{ id: request.calls[0].id, status: 'completed', content: invalidContent }],
      }),
      async (executor) => {
        const result = await executor.execute('test-route', invocation());
        assertEqual(result.isError, true, 'One invalid block should reject the whole response');
        assertEqual(
          result.content.length,
          1,
          'Invalid response must produce only the local failure block',
        );
        assertIncludes(
          getResultText(result),
          'invalid HTTP or canonical response',
          'Protocol failure should use its stable local template',
        );
        assertNotIncludes(
          JSON.stringify(result),
          'secret',
          'Local rejection must not expose partial content or invalid data',
        );
      },
    );
  }
}

async function testHttpAdaptationExceptionIsControlled(): Promise<void> {
  await withHttpExecutor(
    (request) => ({
      results: [
        {
          id: request.calls[0].id,
          status: 'completed',
          content: [
            { type: 'text', text: 'partial-business-secret' },
            { type: 'unknown', value: 'adaptation-failure-fixture' },
          ],
        },
      ],
    }),
    async (executor) => {
      const stringify = JSON.stringify;
      try {
        // Model an unanticipated serialization failure after wire validation.
        JSON.stringify = (value: unknown) => {
          if (value === 'adaptation-failure-fixture') throw new Error('raw-adaptation-secret');
          return stringify(value);
        };
        const result = await executor.execute('test-route', invocation());
        assertEqual(
          result.isError,
          true,
          'Adaptation exceptions should be controlled local failures',
        );
        assertIncludes(
          getResultText(result),
          'internal failure',
          'Adaptation rejection should follow external_internal_failed',
        );
        assertEqual(
          result.content.length,
          1,
          'Adaptation failure must not return any partial business content',
        );
        assertNotIncludes(
          stringify(result),
          'secret',
          'Neither partial content nor thrown details may escape',
        );
      } finally {
        JSON.stringify = stringify;
      }
    },
  );
}

async function testReturnsRouteResults(): Promise<void> {
  const completedExecutor = new ExternalRoutingExecutor({
    routes: fixedRoute(textOutcome('done')),
  });
  const completed = await completedExecutor.execute('test-route', invocation());
  assertEqual(
    completed.isError,
    false,
    'Completed external result should be a successful ToolCallResult',
  );
  assertEqual(getResultText(completed), 'done', 'Completed message should be returned unchanged');
  await completedExecutor.close();

  const failedExecutor = new ExternalRoutingExecutor({
    routes: fixedRoute(textOutcome('business message', true)),
  });
  const failed = await failedExecutor.execute('test-route', invocation());
  assertEqual(failed.isError, true, 'Route business errors should remain ToolCallResult errors');
  assertEqual(
    getResultText(failed),
    'business message',
    'Route result content should remain unchanged',
  );
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
  assertIncludes(
    getResultText(result),
    'cancelled locally',
    'Local cancellation must remain distinct from domain cancellation',
  );
  assertEqual(operationSignal?.aborted, true, 'Runtime should abort its operation-owned signal');
  assertEqual(
    executor.activeExchangeCount,
    1,
    'Settled cancellation should retain its slot until strategy drain',
  );

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
    executor.execute(index % 2 === 0 ? 'route-a' : 'route-b', invocation()),
  );
  await Promise.all(activeCalls);
  const pendingCall = executor.execute('route-b', invocation());
  await Promise.resolve();

  assertEqual(
    executor.activeExchangeCount,
    8,
    'Both routes should consume the same eight active slots.',
  );
  assertEqual(
    executor.pendingExchangeCount,
    1,
    'A call from either route should enter the shared pending FIFO.',
  );
  assertEqual(
    startedDefinitionIds.length,
    8,
    'Pending route work must not start before a shared slot drains.',
  );

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
  assertEqual(
    events.join(','),
    'draining',
    'MCP-owned resources must start closing before active drain completes',
  );
  settled.resolve({ kind: 'failure', code: 'cancelled' });
  await closed;
  assertEqual(
    events.join(','),
    'draining,after-drain',
    'HTTP resources close only after active drain',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external-routing executor mapping and ownership',
    tests: [
      {
        name: 'reports HTTP fixture exceptions after cleanup',
        run: testHttpFixtureFailuresReachTest,
      },
      {
        name: 'maps actual HTTP canonical content for all statuses',
        run: testHttpCanonicalContentMapping,
      },
      {
        name: 'keeps actual HTTP rejections controlled and atomic',
        run: testHttpRejectionsRemainControlled,
      },
      {
        name: 'controls exceptions after HTTP wire validation',
        run: testHttpAdaptationExceptionIsControlled,
      },
      { name: 'returns route results', run: testReturnsRouteResults },
      {
        name: 'maps controlled local failures without raw data',
        run: testMapsControlledLocalFailuresWithoutRawData,
      },
      { name: 'passes route identity and invocation', run: testPassesRouteIdentityAndInvocation },
      {
        name: 'settles cancellation before strategy drain',
        run: testCancellationSettlesBeforeStrategyDrain,
      },
      {
        name: 'shares one admission pool across route-bound calls',
        run: testRouteBoundCallsShareOneAdmissionPool,
      },
      {
        name: 'closes resources only after runtime drain',
        run: testCloseWaitsForDrainBeforeClosingResourcesAndIsIdempotent,
      },
      {
        name: 'starts draining resource close before active drain',
        run: testCloseStartsDrainingResourcesBeforeActiveDrain,
      },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
