import {
  createCanonicalRequest,
  isCanonicalSuccessResponse,
  type CanonicalRequest,
} from '../../src/tools/external-routing/canonical-protocol.js';
import type {
  CompiledHttpRoute,
  ExternalProcessorDefinition,
  ExternalRequestRoutingStage,
  ExternalResponseRoutingStage,
} from '../../src/tools/external-routing/config.js';
import type {
  ExternalHttpTransportExchange,
  ExternalHttpTransportOutcome,
  ExternalHttpTransportRequest,
} from '../../src/tools/external-routing/http-transport.js';
import type {
  ProcessorInvocation,
  ProcessorRunDrainMetadata,
  ProcessorRunExchange,
  ProcessorRunFailure,
  ProcessorRunOutcome,
  ProcessorRunSuccess,
} from '../../src/tools/external-routing/processor-runner.js';
import {
  ExternalRoutingStrategyAdapter,
  type ExternalRoutingCanonicalOutcome,
  type ExternalRoutingHttpTransport,
  type ExternalRoutingProcessorDrainDiagnostic,
  type ExternalRoutingProcessorRunner,
  type ExternalRoutingStrategyAdapterOptions,
  type ExternalRoutingStrategyFailure,
  type ExternalRoutingStrategyOutcome,
} from '../../src/tools/external-routing/strategy-adapter.js';
import {
  assert,
  assertEqual,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

type ProcessorResponder = (
  invocation: ProcessorInvocation,
) => ProcessorRunExchange;

type TransportResponder = (
  request: ExternalHttpTransportRequest,
) => ExternalHttpTransportExchange;

class FakeProcessorRunner implements ExternalRoutingProcessorRunner {
  readonly invocations: ProcessorInvocation[] = [];
  readonly #responders: ProcessorResponder[];

  constructor(responders: readonly ProcessorResponder[]) {
    this.#responders = [...responders];
  }

  run(invocation: ProcessorInvocation): ProcessorRunExchange {
    this.invocations.push(invocation);
    const responder = this.#responders.shift();
    if (!responder) {
      throw new Error('Unexpected Processor invocation.');
    }
    return responder(invocation);
  }
}

class FakeHttpTransport implements ExternalRoutingHttpTransport {
  readonly requests: ExternalHttpTransportRequest[] = [];
  readonly #responders: TransportResponder[];

  constructor(responders: readonly TransportResponder[]) {
    this.#responders = [...responders];
  }

  exchange(request: ExternalHttpTransportRequest): ExternalHttpTransportExchange {
    this.requests.push(request);
    const responder = this.#responders.shift();
    if (!responder) {
      throw new Error('Unexpected HTTP exchange.');
    }
    return responder(request);
  }
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value: T): void {
      resolvePromise?.(value);
    },
    reject(reason: unknown): void {
      rejectPromise?.(reason);
    },
  };
}

function processor(name: string): ExternalProcessorDefinition {
  return {
    name,
    executable: { resolution: 'path-search', command: 'test-processor' },
    arguments: ['--mode', name],
    workingDirectory: 'C:\\test-workspace',
    timeoutMs: 1_000,
  };
}

function spec(
  requestStage: ExternalRequestRoutingStage,
  responseStage: ExternalResponseRoutingStage,
  processors: readonly ExternalProcessorDefinition[] = [],
): CompiledHttpRoute & { readonly processors: readonly ExternalProcessorDefinition[] } {
  return {
    routingMode: 'http',
    definitionId: 'source-definition',
    toolName: 'source.tool',
    endpointConfigFilePath: 'C:\\test-workspace\\endpoint.json',
    endpoint: {
      url: 'https://external.example.test/tool',
      timeoutMs: 1_000,
      headers: {},
    },
    requestStage,
    responseStage,
    processors,
  };
}

function canonicalRequest(): CanonicalRequest {
  return createCanonicalRequest({
    id: 'call_adapter_1',
    name: 'source.tool',
    arguments: { value: 'original' },
  });
}

function canonicalSuccess(
  status: 'completed' | 'failed' | 'cancelled' = 'completed',
  message = 'External result.',
): Uint8Array {
  return jsonBytes({
    results: [{ id: 'call_adapter_1', status, message }],
  });
}

function canonicalError(
  code = 'invalid_request',
  message = 'External request was rejected.',
): Uint8Array {
  return jsonBytes({ error: { code, message } });
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function processorSuccess(stdout: Uint8Array): ProcessorRunSuccess {
  return {
    kind: 'success',
    stdout,
    durationMs: 1,
    stdinBytes: 1,
    stdoutBytes: stdout.byteLength,
    stderr: { byteCount: 0, capturedByteCount: 0, truncated: false },
  };
}

function processorFailure(reason: ProcessorRunFailure['reason']): ProcessorRunFailure {
  return {
    kind: 'failure',
    reason,
    durationMs: 1,
    stdinBytes: 1,
    stdoutBytes: 0,
    stderr: { byteCount: 0, capturedByteCount: 0, truncated: false },
  };
}

function processorDrainMetadata(): ProcessorRunDrainMetadata {
  return { durationMs: 1, cleanupFailed: false };
}

function processorExchange(
  outcome: ProcessorRunOutcome,
  drained: Promise<ProcessorRunDrainMetadata> = Promise.resolve(processorDrainMetadata()),
): ProcessorRunExchange {
  return { settled: Promise.resolve(outcome), drained };
}

function successfulExchange(
  body: Uint8Array,
  statusCode = 200,
  metadata: { contentType?: string; contentEncoding?: string } = {},
  drained: Promise<void> = Promise.resolve(),
): ExternalHttpTransportExchange {
  const outcome: ExternalHttpTransportOutcome = {
    ok: true,
    body,
    statusCode,
    diagnostics: {
      stage: 'response',
      requestBodyBytes: 1,
      responseBodyBytes: body.byteLength,
      statusCode,
    },
    ...metadata,
  };
  return { settled: Promise.resolve(outcome), drained };
}

function adapter(
  routeSpec: CompiledHttpRoute & {
    readonly processors: readonly ExternalProcessorDefinition[];
  },
  runner: FakeProcessorRunner,
  transport: FakeHttpTransport,
  options: Pick<ExternalRoutingStrategyAdapterOptions, 'onProcessorDrain'> = {},
): ExternalRoutingStrategyAdapter {
  return new ExternalRoutingStrategyAdapter({
    route: routeSpec,
    processorsByName: new Map(
      routeSpec.processors.map((definition) => [definition.name, definition]),
    ),
    processorRunner: runner,
    httpTransport: transport,
    ...options,
  });
}

function requireCanonical(
  outcome: ExternalRoutingStrategyOutcome,
  code: ExternalRoutingCanonicalOutcome['code'],
): ExternalRoutingCanonicalOutcome {
  assertEqual(outcome.kind, 'canonical', `Expected canonical outcome ${code}.`);
  if (outcome.kind !== 'canonical') {
    throw new Error(`Expected canonical outcome ${code}.`);
  }
  assertEqual(outcome.code, code, 'Canonical classification should be stable.');
  return outcome;
}

function requireFailure(
  outcome: ExternalRoutingStrategyOutcome,
  code: ExternalRoutingStrategyFailure['code'],
): ExternalRoutingStrategyFailure {
  assertEqual(outcome.kind, 'failure', `Expected controlled failure ${code}.`);
  if (outcome.kind !== 'failure') {
    throw new Error(`Expected controlled failure ${code}.`);
  }
  assertEqual(outcome.code, code, 'Failure classification should be stable.');
  return outcome;
}

function requireResponseEnvironment(
  invocation: ProcessorInvocation | undefined,
): Extract<ProcessorInvocation['environment'], { readonly httpStatus: number }> {
  const environment = invocation?.environment;
  assert(
    environment !== undefined && 'httpStatus' in environment,
    'Response Processor invocation should include response-only metadata.',
  );
  return environment;
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting: ${message}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function testDirectRequestAndResponse(): Promise<void> {
  const runner = new FakeProcessorRunner([]);
  const transport = new FakeHttpTransport([
    () => successfulExchange(canonicalSuccess()),
  ]);
  const route = adapter(spec(
    { mode: 'direct' },
    { mode: 'direct' },
  ), runner, transport);

  const outcome = requireCanonical(await route.execute({ request: canonicalRequest() }), 'external_tool_completed');
  assert(isCanonicalSuccessResponse(outcome.response), 'Completed result should retain the canonical success shape.');
  assertEqual(runner.invocations.length, 0, 'direct/direct must not start a Processor.');
  assertEqual(transport.requests.length, 1, 'direct request should start one HTTP exchange.');
  const request = transport.requests[0];
  assertEqual(
    request?.endpoint?.url,
    'https://external.example.test/tool',
    'The strategy adapter must dispatch through its compiled route endpoint.',
  );
  assertEqual(request?.contentType, 'application/json; charset=utf-8', 'direct request must own canonical JSON media type.');
  assertEqual(request?.responseMode, 'direct', 'Response strategy must select transport representation validation.');
  const serialized = JSON.parse(decoder.decode(request?.body)) as { calls: Array<{ name: string }> };
  assertEqual(serialized.calls[0]?.name, 'source.tool', 'direct request must send canonical request bytes.');
}

async function testCanonicalRequestFilter(): Promise<void> {
  const runner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(jsonBytes({
      calls: [{
        id: 'call_adapter_1',
        name: 'translated.tool',
        arguments: { translated: true },
      }],
    }))),
  ]);
  const transport = new FakeHttpTransport([
    () => successfulExchange(canonicalSuccess()),
  ]);
  const route = adapter(spec(
    { mode: 'canonical-filter', processor: 'request-filter' },
    { mode: 'direct' },
    [processor('request-filter')],
  ), runner, transport);

  requireCanonical(await route.execute({ request: canonicalRequest() }), 'external_tool_completed');
  const invocation = runner.invocations[0];
  assertEqual(invocation?.environment.role, 'request.canonical-filter', 'Request filter should receive its fixed role.');
  assertEqual(invocation?.environment.callId, 'call_adapter_1', 'Request filter should receive only canonical correlation.');
  const body = JSON.parse(decoder.decode(transport.requests[0]?.body)) as {
    calls: Array<{ id: string; name: string; arguments: { translated: boolean } }>;
  };
  assertEqual(body.calls[0]?.id, 'call_adapter_1', 'Request filter must preserve the call ID.');
  assertEqual(body.calls[0]?.name, 'translated.tool', 'Request filter output should replace the outgoing canonical message.');
  assertEqual(body.calls[0]?.arguments.translated, true, 'Request filter may replace arguments.');
}

async function testBodyEncoderRequest(): Promise<void> {
  const finalBody = new Uint8Array([0, 1, 254, 255]);
  const runner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(finalBody)),
  ]);
  const transport = new FakeHttpTransport([
    () => successfulExchange(canonicalSuccess()),
  ]);
  const route = adapter(spec(
    {
      mode: 'body-encoder',
      processor: 'body-encoder',
      contentType: 'application/vnd.example+json; charset=utf-8',
    },
    { mode: 'direct' },
    [processor('body-encoder')],
  ), runner, transport);

  requireCanonical(await route.execute({ request: canonicalRequest() }), 'external_tool_completed');
  const invocation = runner.invocations[0];
  assertEqual(invocation?.environment.role, 'request.body-encoder', 'Body encoder should receive its fixed role.');
  assertEqual(
    transport.requests[0]?.contentType,
    'application/vnd.example+json; charset=utf-8',
    'Body encoder configuration must own the final request media type.',
  );
  assertEqual(
    [...(transport.requests[0]?.body ?? [])].join(','),
    [...finalBody].join(','),
    'Body encoder stdout must become the final raw HTTP body without JSON parsing.',
  );
}

async function testCanonicalResponseFilter(): Promise<void> {
  const runner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(canonicalSuccess('failed', 'Translated domain failure.'))),
  ]);
  const transport = new FakeHttpTransport([
    () => successfulExchange(canonicalSuccess(), 207, {
      contentType: 'application/json; charset=utf-8',
      contentEncoding: 'identity',
    }),
  ]);
  const route = adapter(spec(
    { mode: 'direct' },
    { mode: 'canonical-filter', processor: 'response-filter' },
    [processor('response-filter')],
  ), runner, transport);

  const outcome = requireCanonical(await route.execute({ request: canonicalRequest() }), 'external_tool_failed');
  assert(isCanonicalSuccessResponse(outcome.response), 'Filtered failed result should remain a success response shape.');
  if (isCanonicalSuccessResponse(outcome.response)) {
    assertEqual(outcome.response.results[0].status, 'failed', 'Response filter may change domain result status.');
  }
  const invocation = runner.invocations[0];
  assertEqual(invocation?.environment.role, 'response.canonical-filter', 'Response filter should receive its fixed role.');
  assertEqual(invocation?.environment.callId, 'call_adapter_1', 'Response filter should receive canonical correlation.');
  const environment = requireResponseEnvironment(invocation);
  assertEqual(
    environment.httpStatus,
    207,
    'Response filter should receive the final HTTP status.',
  );
  assertEqual(
    environment.contentType,
    'application/json; charset=utf-8',
    'Response filter should receive validated representation metadata only.',
  );
}

async function testBodyDecoderResponse(): Promise<void> {
  const rawBody = new Uint8Array([31, 139, 8, 0, 255]);
  const runner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(canonicalError('private_protocol_rejection', 'Decoded endpoint rejection.'))),
  ]);
  const transport = new FakeHttpTransport([
    () => successfulExchange(rawBody, 422, {
      contentType: 'application/vnd.example+json',
      contentEncoding: 'gzip, br',
    }),
  ]);
  const route = adapter(spec(
    { mode: 'direct' },
    { mode: 'body-decoder', processor: 'response-decoder' },
    [processor('response-decoder')],
  ), runner, transport);

  requireCanonical(await route.execute({ request: canonicalRequest() }), 'external_rejected');
  const invocation = runner.invocations[0];
  assertEqual(invocation?.environment.role, 'response.body-decoder', 'Body decoder should receive its fixed role.');
  assertEqual(
    [...(invocation?.stdin ?? [])].join(','),
    [...rawBody].join(','),
    'Body decoder must receive the raw external entity bytes without decompression.',
  );
  const environment = requireResponseEnvironment(invocation);
  assertEqual(
    environment.httpStatus,
    422,
    'Body decoder should receive final status metadata.',
  );
  assertEqual(
    environment.contentEncoding,
    'gzip, br',
    'Body decoder should receive normalized content coding metadata.',
  );
  assertEqual(transport.requests[0]?.responseMode, 'body-decoder', 'Decoder strategy must select permissive body transport mode.');
}

async function testStatusContract(): Promise<void> {
  const runner = new FakeProcessorRunner([]);
  const transport = new FakeHttpTransport([
    () => successfulExchange(canonicalError(), 204),
    () => successfulExchange(canonicalSuccess(), 422),
  ]);
  const route = adapter(spec(
    { mode: 'direct' },
    { mode: 'direct' },
  ), runner, transport);

  requireCanonical(await route.execute({ request: canonicalRequest() }), 'external_rejected');
  requireFailure(await route.execute({ request: canonicalRequest() }), 'external_protocol_failed');
}

async function testBoundaryFailureClassification(): Promise<void> {
  const directRunner = new FakeProcessorRunner([]);
  const directTransport = new FakeHttpTransport([
    () => successfulExchange(encoder.encode('not canonical JSON'), 200),
  ]);
  const directRoute = adapter(spec(
    { mode: 'direct' },
    { mode: 'direct' },
  ), directRunner, directTransport);
  requireFailure(await directRoute.execute({ request: canonicalRequest() }), 'external_protocol_failed');

  const filterRunner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(encoder.encode('not canonical JSON'))),
  ]);
  const filterTransport = new FakeHttpTransport([]);
  const filterRoute = adapter(spec(
    { mode: 'canonical-filter', processor: 'request-filter' },
    { mode: 'direct' },
    [processor('request-filter')],
  ), filterRunner, filterTransport);
  requireFailure(await filterRoute.execute({ request: canonicalRequest() }), 'processor_failed');
  assertEqual(filterTransport.requests.length, 0, 'Invalid request-filter stdout must not start HTTP.');

  const responseFilterRunner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(encoder.encode('not canonical JSON'))),
  ]);
  const responseFilterTransport = new FakeHttpTransport([
    () => successfulExchange(canonicalSuccess()),
  ]);
  const responseFilterRoute = adapter(spec(
    { mode: 'direct' },
    { mode: 'canonical-filter', processor: 'response-filter' },
    [processor('response-filter')],
  ), responseFilterRunner, responseFilterTransport);
  requireFailure(await responseFilterRoute.execute({ request: canonicalRequest() }), 'processor_failed');

  const decoderRunner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(canonicalSuccess())),
  ]);
  const decoderTransport = new FakeHttpTransport([
    () => successfulExchange(new Uint8Array([0, 1, 2]), 422),
  ]);
  const decoderRoute = adapter(spec(
    { mode: 'direct' },
    { mode: 'body-decoder', processor: 'response-decoder' },
    [processor('response-decoder')],
  ), decoderRunner, decoderTransport);
  requireFailure(
    await decoderRoute.execute({ request: canonicalRequest() }),
    'processor_failed',
  );

  const timeoutDrain = deferred<ProcessorRunDrainMetadata>();
  const timeoutRunner = new FakeProcessorRunner([
    () => processorExchange(processorFailure('timeout'), timeoutDrain.promise),
  ]);
  const timeoutTransport = new FakeHttpTransport([]);
  const timeoutRoute = adapter(spec(
    { mode: 'body-encoder', processor: 'body-encoder', contentType: 'application/octet-stream' },
    { mode: 'direct' },
    [processor('body-encoder')],
  ), timeoutRunner, timeoutTransport);
  const timeoutExchange = timeoutRoute.exchange({ request: canonicalRequest() });
  requireFailure(await timeoutExchange.settled, 'processor_timeout');
  assertEqual(timeoutTransport.requests.length, 0, 'Timed out request Processor must not start HTTP.');
  let timeoutDrained = false;
  void timeoutExchange.drained.then(() => {
    timeoutDrained = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assertEqual(timeoutDrained, false, 'Processor timeout should settle before its local cleanup drains.');
  timeoutDrain.resolve(processorDrainMetadata());
  await timeoutExchange.drained;
}

async function testCancellationStopsLaterStages(): Promise<void> {
  const pendingProcessor = deferred<ProcessorRunOutcome>();
  const pendingDrain = deferred<ProcessorRunDrainMetadata>();
  const runner = new FakeProcessorRunner([
    () => ({ settled: pendingProcessor.promise, drained: pendingDrain.promise }),
  ]);
  const transport = new FakeHttpTransport([]);
  const route = adapter(spec(
    { mode: 'canonical-filter', processor: 'request-filter' },
    { mode: 'direct' },
    [processor('request-filter')],
  ), runner, transport);
  const controller = new AbortController();

  const execution = route.exchange({ request: canonicalRequest(), signal: controller.signal });
  await waitFor(() => runner.invocations.length === 1, 'request Processor to start');
  controller.abort();

  requireFailure(await execution.settled, 'cancelled');
  assertEqual(transport.requests.length, 0, 'Cancellation during request processing must stop HTTP admission.');
  let drained = false;
  void execution.drained.then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assertEqual(drained, false, 'Cancellation must not claim Processor cleanup completed early.');

  pendingProcessor.resolve(processorSuccess(jsonBytes({
    calls: [{ id: 'call_adapter_1', name: 'translated.tool', arguments: {} }],
  })));
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assertEqual(transport.requests.length, 0, 'A late Processor result after abort must not start HTTP.');
  assertEqual(drained, false, 'Processor cleanup remains part of outer drain after late settlement.');

  pendingDrain.resolve(processorDrainMetadata());
  await execution.drained;
}

async function testSeparatesSettlementFromAllStageDrains(): Promise<void> {
  const processorDrain = deferred<ProcessorRunDrainMetadata>();
  const transportDrain = deferred<void>();
  const filteredRequest = jsonBytes({
    calls: [{ id: 'call_adapter_1', name: 'translated.tool', arguments: {} }],
  });
  const runner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(filteredRequest), processorDrain.promise),
  ]);
  const transport = new FakeHttpTransport([
    () => successfulExchange(canonicalSuccess(), 200, {}, transportDrain.promise),
  ]);
  const diagnostics: ExternalRoutingProcessorDrainDiagnostic[] = [];
  const route = adapter(spec(
    { mode: 'canonical-filter', processor: 'request-filter' },
    { mode: 'direct' },
    [processor('request-filter')],
  ), runner, transport, {
    onProcessorDrain: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });

  const execution = route.exchange({ request: canonicalRequest() });
  requireCanonical(await execution.settled, 'external_tool_completed');
  assertEqual(
    transport.requests.length,
    1,
    'A settled request Processor must allow HTTP to start before that Processor drains.',
  );

  let drained = false;
  void execution.drained.then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assertEqual(drained, false, 'Outer drain must wait for all started stage cleanup.');

  processorDrain.resolve({ durationMs: 37, cleanupFailed: true });
  await waitFor(() => diagnostics.length === 1, 'Processor drain diagnostic');
  const diagnostic = diagnostics[0];
  assertEqual(diagnostic?.role, 'request.canonical-filter', 'Drain diagnostic should identify the Processor role.');
  assertEqual(diagnostic?.processorName, 'request-filter', 'Drain diagnostic should identify the configured Processor.');
  assertEqual(diagnostic?.cleanupFailed, true, 'Degraded Processor cleanup must remain observable.');
  assertEqual(diagnostic?.settledDurationMs, 1, 'Drain diagnostic should retain safe settlement duration.');
  assertEqual(diagnostic?.drainDurationMs, 37, 'Drain diagnostic should retain safe drain duration.');
  assertEqual(diagnostic?.stdinBytes, 1, 'Drain diagnostic should retain safe stdin byte count.');
  assertEqual(diagnostic?.stdoutBytes, filteredRequest.byteLength, 'Drain diagnostic should retain safe stdout byte count.');
  assertEqual(drained, false, 'Outer drain must still wait for HTTP cleanup.');
  transportDrain.resolve();
  await execution.drained;
}

async function testProcessorDrainSinkFailuresAreIsolated(): Promise<void> {
  let callbackCalls = 0;
  const runner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(new Uint8Array([0, 1, 2]))),
  ]);
  const transport = new FakeHttpTransport([
    () => successfulExchange(canonicalSuccess()),
  ]);
  const route = adapter(spec(
    {
      mode: 'body-encoder',
      processor: 'body-encoder',
      contentType: 'application/octet-stream',
    },
    { mode: 'direct' },
    [processor('body-encoder')],
  ), runner, transport, {
    onProcessorDrain: () => {
      callbackCalls++;
      throw new Error('processor drain diagnostic sink failure');
    },
  });

  const execution = route.exchange({ request: canonicalRequest() });
  requireCanonical(await execution.settled, 'external_tool_completed');
  await execution.drained;
  assertEqual(callbackCalls, 1, 'A throwing drain sink should still receive the safe diagnostic once.');
}

async function testExceptionsDoNotEscapeOrLeak(): Promise<void> {
  const runner = new FakeProcessorRunner([
    () => {
      throw new Error('processor raw stdout secret');
    },
  ]);
  const transport = new FakeHttpTransport([]);
  const route = adapter(spec(
    { mode: 'body-encoder', processor: 'body-encoder', contentType: 'application/octet-stream' },
    { mode: 'direct' },
    [processor('body-encoder')],
  ), runner, transport);

  const outcome = requireFailure(await route.execute({ request: canonicalRequest() }), 'processor_failed');
  assertEqual(Object.keys(outcome).join(','), 'kind,code', 'Failure outcome must retain only structured classification.');
  assertNotIncludes(JSON.stringify(outcome), 'secret', 'Raw dependency exceptions must never enter adapter output.');

  const throwingTransport: ExternalRoutingHttpTransport = {
    exchange(): ExternalHttpTransportExchange {
      throw new Error('https://secret.example.test/path?token=raw');
    },
  };
  const transportFailureRoute = new ExternalRoutingStrategyAdapter({
    route: spec(
      { mode: 'direct' },
      { mode: 'direct' },
    ),
    processorsByName: new Map(),
    processorRunner: new FakeProcessorRunner([]),
    httpTransport: throwingTransport,
  });
  const transportOutcome = requireFailure(
    await transportFailureRoute.execute({ request: canonicalRequest() }),
    'external_transport_failed',
  );
  assertNotIncludes(JSON.stringify(transportOutcome), 'secret', 'Raw transport exceptions must never enter adapter output.');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external-routing strategy adapter',
    tests: [
      { name: 'routes direct canonical request and response without a Processor', run: testDirectRequestAndResponse },
      { name: 'runs and validates canonical request filters', run: testCanonicalRequestFilter },
      { name: 'uses body encoder stdout as raw HTTP request bytes', run: testBodyEncoderRequest },
      { name: 'runs and validates canonical response filters', run: testCanonicalResponseFilter },
      { name: 'runs body decoders with raw entity and response metadata', run: testBodyDecoderResponse },
      { name: 'enforces 2xx versus 4xx/5xx canonical status contracts', run: testStatusContract },
      { name: 'classifies HTTP and Processor contract failures by boundary', run: testBoundaryFailureClassification },
      { name: 'cancellation stops later strategy stages', run: testCancellationStopsLaterStages },
      { name: 'separates fast settlement from aggregate Processor and HTTP drain', run: testSeparatesSettlementFromAllStageDrains },
      { name: 'isolates Processor drain diagnostic sink failures', run: testProcessorDrainSinkFailuresAreIsolated },
      { name: 'contains injected dependency exceptions', run: testExceptionsDoNotEscapeOrLeak },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
