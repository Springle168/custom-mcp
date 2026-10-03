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
import { assert, assertEqual, assertNotIncludes, runTestSuite } from '../test-utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

type ProcessorResponder = (invocation: ProcessorInvocation) => ProcessorRunExchange;

type TransportResponder = (request: ExternalHttpTransportRequest) => ExternalHttpTransportExchange;

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
  content: readonly unknown[] = [{ type: 'text', text: 'External result.' }],
): Uint8Array {
  return jsonBytes({
    results: [{ id: 'call_adapter_1', status, content }],
  });
}

function mixedContent(): readonly unknown[] {
  return [
    { type: 'text', text: 'Preview:' },
    // These bytes exercise base64 encoding, not an actual image file format.
    { type: 'image', data: 'AQID', mime_type: 'image/png' },
    { type: 'unknown', value: null },
    { type: 'unknown', value: false },
    { type: 'unknown', value: 0 },
    { type: 'unknown', value: '' },
    { type: 'unknown', value: 'hello' },
    { type: 'unknown', value: [1, null, true] },
    {
      type: 'unknown',
      value: { type: 'image', url: 'https://example.test/image', nested: { value: false } },
    },
    { type: 'text', text: 'Trailing text.' },
    { type: 'text', text: '' },
  ];
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
    () => successfulExchange(canonicalSuccess('completed', mixedContent())),
  ]);
  const route = adapter(spec({ mode: 'direct' }, { mode: 'direct' }), runner, transport);

  const outcome = requireCanonical(
    await route.execute({ request: canonicalRequest() }),
    'external_tool_completed',
  );
  assert(
    isCanonicalSuccessResponse(outcome.response),
    'Completed result should retain the canonical success shape.',
  );
  assertEqual(
    JSON.stringify(outcome.response.results[0].content),
    JSON.stringify(mixedContent()),
    'Direct response should retain all canonical blocks, order, JSON types, and empty text.',
  );
  assertEqual(runner.invocations.length, 0, 'direct/direct must not start a Processor.');
  assertEqual(transport.requests.length, 1, 'direct request should start one HTTP exchange.');
  const request = transport.requests[0];
  assertEqual(
    request?.endpoint?.url,
    'https://external.example.test/tool',
    'The strategy adapter must dispatch through its compiled route endpoint.',
  );
  assertEqual(
    request?.contentType,
    'application/json; charset=utf-8',
    'direct request must own canonical JSON media type.',
  );
  assertEqual(
    request?.responseMode,
    'direct',
    'Response strategy must select transport representation validation.',
  );
  const serialized = JSON.parse(decoder.decode(request?.body)) as {
    calls: Array<{ name: string }>;
  };
  assertEqual(
    serialized.calls[0]?.name,
    'source.tool',
    'direct request must send canonical request bytes.',
  );
}

async function testCanonicalRequestFilter(): Promise<void> {
  const runner = new FakeProcessorRunner([
    () =>
      processorExchange(
        processorSuccess(
          jsonBytes({
            calls: [
              {
                id: 'call_adapter_1',
                name: 'translated.tool',
                arguments: { translated: true },
              },
            ],
          }),
        ),
      ),
  ]);
  const transport = new FakeHttpTransport([() => successfulExchange(canonicalSuccess())]);
  const route = adapter(
    spec({ mode: 'canonical-filter', processor: 'request-filter' }, { mode: 'direct' }, [
      processor('request-filter'),
    ]),
    runner,
    transport,
  );

  requireCanonical(await route.execute({ request: canonicalRequest() }), 'external_tool_completed');
  const invocation = runner.invocations[0];
  assertEqual(
    invocation?.environment.role,
    'request.canonical-filter',
    'Request filter should receive its fixed role.',
  );
  assertEqual(
    invocation?.environment.callId,
    'call_adapter_1',
    'Request filter should receive only canonical correlation.',
  );
  const body = JSON.parse(decoder.decode(transport.requests[0]?.body)) as {
    calls: Array<{ id: string; name: string; arguments: { translated: boolean } }>;
  };
  assertEqual(body.calls[0]?.id, 'call_adapter_1', 'Request filter must preserve the call ID.');
  assertEqual(
    body.calls[0]?.name,
    'translated.tool',
    'Request filter output should replace the outgoing canonical message.',
  );
  assertEqual(body.calls[0]?.arguments.translated, true, 'Request filter may replace arguments.');
}

async function testBodyEncoderRequest(): Promise<void> {
  const finalBody = new Uint8Array([0, 1, 254, 255]);
  const runner = new FakeProcessorRunner([() => processorExchange(processorSuccess(finalBody))]);
  const transport = new FakeHttpTransport([() => successfulExchange(canonicalSuccess())]);
  const route = adapter(
    spec(
      {
        mode: 'body-encoder',
        processor: 'body-encoder',
        contentType: 'application/vnd.example+json; charset=utf-8',
      },
      { mode: 'direct' },
      [processor('body-encoder')],
    ),
    runner,
    transport,
  );

  requireCanonical(await route.execute({ request: canonicalRequest() }), 'external_tool_completed');
  const invocation = runner.invocations[0];
  assertEqual(
    invocation?.environment.role,
    'request.body-encoder',
    'Body encoder should receive its fixed role.',
  );
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
  const replacement = [
    { type: 'unknown', value: { failure: true } },
    { type: 'image', data: 'AQI=', mime_type: 'image/webp' },
    { type: 'text', text: '' },
  ];
  const runner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(canonicalSuccess('failed', replacement))),
  ]);
  const transport = new FakeHttpTransport([
    () =>
      successfulExchange(
        jsonBytes({
          results: [{ id: 'call_adapter_1', status: 'completed', content: mixedContent() }],
          extensions: { endpoint: { retained: false } },
        }),
        207,
        {
          contentType: 'application/json; charset=utf-8',
          contentEncoding: 'identity',
        },
      ),
  ]);
  const route = adapter(
    spec({ mode: 'direct' }, { mode: 'canonical-filter', processor: 'response-filter' }, [
      processor('response-filter'),
    ]),
    runner,
    transport,
  );

  const outcome = requireCanonical(
    await route.execute({ request: canonicalRequest() }),
    'external_tool_failed',
  );
  assert(
    isCanonicalSuccessResponse(outcome.response),
    'Filtered failed result should remain a success response shape.',
  );
  if (isCanonicalSuccessResponse(outcome.response)) {
    assertEqual(
      outcome.response.results[0].status,
      'failed',
      'Response filter may change domain result status.',
    );
    assertEqual(
      JSON.stringify(outcome.response.results[0].content),
      JSON.stringify(replacement),
      'Response filter output must completely replace content without merging original blocks.',
    );
  }
  assertEqual(
    outcome.response.extensions,
    undefined,
    'Omitted extensions must not be restored from endpoint input.',
  );
  const invocation = runner.invocations[0];
  const stdin = JSON.parse(decoder.decode(invocation?.stdin)) as {
    results: Array<{ content: Array<Record<string, unknown>> }>;
  };
  assertEqual(
    JSON.stringify(stdin.results[0]?.content),
    JSON.stringify(mixedContent()),
    'Filter stdin must preserve unknown JSON types and canonical mime_type without MCP mapping.',
  );
  assertEqual(
    stdin.results[0]?.content[1]?.mime_type,
    'image/png',
    'Image wire field should remain mime_type.',
  );
  assertEqual(
    stdin.results[0]?.content[1]?.mimeType,
    undefined,
    'Filter stdin must not contain MCP mimeType.',
  );
  assertEqual(
    stdin.results[0]?.content[2]?.value,
    null,
    'Unknown null must remain JSON null, not text.',
  );
  assertEqual(stdin.results[0]?.content[3]?.value, false, 'Unknown boolean must remain a boolean.');
  assertEqual(stdin.results[0]?.content[4]?.value, 0, 'Unknown number must remain a number.');
  assertEqual(
    invocation?.environment.role,
    'response.canonical-filter',
    'Response filter should receive its fixed role.',
  );
  assertEqual(
    invocation?.environment.callId,
    'call_adapter_1',
    'Response filter should receive canonical correlation.',
  );
  const environment = requireResponseEnvironment(invocation);
  assertEqual(environment.httpStatus, 207, 'Response filter should receive the final HTTP status.');
  assertEqual(
    environment.contentType,
    'application/json; charset=utf-8',
    'Response filter should receive validated representation metadata only.',
  );
}

async function testBodyDecoderResponse(): Promise<void> {
  const rawBody = new Uint8Array([31, 139, 8, 0, 255]);
  const runner = new FakeProcessorRunner([
    () =>
      processorExchange(
        processorSuccess(
          canonicalError('private_protocol_rejection', 'Decoded endpoint rejection.'),
        ),
      ),
  ]);
  const transport = new FakeHttpTransport([
    () =>
      successfulExchange(rawBody, 422, {
        contentType: 'application/vnd.example+json',
        contentEncoding: 'gzip, br',
      }),
  ]);
  const route = adapter(
    spec({ mode: 'direct' }, { mode: 'body-decoder', processor: 'response-decoder' }, [
      processor('response-decoder'),
    ]),
    runner,
    transport,
  );

  requireCanonical(await route.execute({ request: canonicalRequest() }), 'external_rejected');
  const invocation = runner.invocations[0];
  assertEqual(
    invocation?.environment.role,
    'response.body-decoder',
    'Body decoder should receive its fixed role.',
  );
  assertEqual(
    [...(invocation?.stdin ?? [])].join(','),
    [...rawBody].join(','),
    'Body decoder must receive the raw external entity bytes without decompression.',
  );
  const environment = requireResponseEnvironment(invocation);
  assertEqual(environment.httpStatus, 422, 'Body decoder should receive final status metadata.');
  assertEqual(
    environment.contentEncoding,
    'gzip, br',
    'Body decoder should receive normalized content coding metadata.',
  );
  assertEqual(
    transport.requests[0]?.responseMode,
    'body-decoder',
    'Decoder strategy must select permissive body transport mode.',
  );

  const mixedRunner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(canonicalSuccess('completed', mixedContent()))),
  ]);
  const mixedRoute = adapter(
    spec({ mode: 'direct' }, { mode: 'body-decoder', processor: 'response-decoder' }, [
      processor('response-decoder'),
    ]),
    mixedRunner,
    new FakeHttpTransport([
      () => successfulExchange(rawBody, 200, { contentType: 'application/octet-stream' }),
    ]),
  );
  const mixedOutcome = requireCanonical(
    await mixedRoute.execute({ request: canonicalRequest() }),
    'external_tool_completed',
  );
  assert(
    isCanonicalSuccessResponse(mixedOutcome.response),
    'Decoder may construct a results response.',
  );
  assertEqual(
    JSON.stringify(mixedOutcome.response.results[0].content),
    JSON.stringify(mixedContent()),
    'Decoder output should retain mixed canonical blocks without premature MCP mapping.',
  );
}

async function testStatusContract(): Promise<void> {
  for (const mode of ['direct', 'canonical-filter', 'body-decoder'] as const) {
    const responseStage: ExternalResponseRoutingStage =
      mode === 'direct' ? { mode } : { mode, processor: 'response-processor' };
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      for (const statusCode of [200, 422, 503]) {
        const bytes = canonicalSuccess(status, mixedContent());
        const runner = new FakeProcessorRunner([() => processorExchange(processorSuccess(bytes))]);
        const route = adapter(
          spec({ mode: 'direct' }, responseStage, [processor('response-processor')]),
          runner,
          new FakeHttpTransport([() => successfulExchange(bytes, statusCode)]),
        );
        const outcome = await route.execute({ request: canonicalRequest() });
        if (statusCode === 200) {
          const code =
            status === 'completed'
              ? 'external_tool_completed'
              : status === 'failed'
                ? 'external_tool_failed'
                : 'external_tool_cancelled';
          requireCanonical(outcome, code);
        } else {
          requireFailure(
            outcome,
            mode === 'body-decoder' ? 'processor_failed' : 'external_protocol_failed',
          );
          assertEqual(
            runner.invocations.length,
            mode === 'body-decoder' ? 1 : 0,
            'HTTP error results must be rejected before filtering; decoder owns its output violation.',
          );
        }
      }
    }
    for (const statusCode of [204, 422, 503, 302, 199, 600]) {
      const runner = new FakeProcessorRunner([
        () => processorExchange(processorSuccess(canonicalError())),
      ]);
      const route = adapter(
        spec({ mode: 'direct' }, responseStage, [processor('response-processor')]),
        runner,
        new FakeHttpTransport([() => successfulExchange(canonicalError(), statusCode)]),
      );
      const outcome = await route.execute({ request: canonicalRequest() });
      if ([204, 422, 503].includes(statusCode)) {
        requireCanonical(outcome, 'external_rejected');
      } else {
        requireFailure(outcome, 'external_protocol_failed');
      }
    }
  }
}

async function testInvalidContentFailsAtOwningBoundary(): Promise<void> {
  const validResult = { id: 'call_adapter_1', status: 'completed' };
  const malformedResponses = [
    { results: [validResult] },
    { results: [{ ...validResult, message: 'Legacy result.' }] },
    { results: [{ ...validResult, message: 'Mixed legacy result.', content: mixedContent() }] },
    { results: [{ ...validResult, content: null }] },
    {
      results: [
        {
          ...validResult,
          content: [
            { type: 'text', text: 'Valid prefix must not escape.' },
            { type: 'image', data: 'AR==', mime_type: 'image/png' },
          ],
        },
      ],
    },
    {
      results: [
        {
          ...validResult,
          content: [{ type: 'text', text: 'Valid prefix must not escape.' }, { type: 'unknown' }],
        },
      ],
    },
    {
      results: [
        {
          ...validResult,
          content: [
            { type: 'text', text: 'Valid prefix must not escape.' },
            { type: 'audio', data: 'AQID' },
          ],
        },
      ],
    },
  ];
  for (const malformed of malformedResponses) {
    for (const mode of ['direct', 'canonical-filter'] as const) {
      const runner = new FakeProcessorRunner([
        () => processorExchange(processorSuccess(canonicalSuccess())),
      ]);
      const responseStage: ExternalResponseRoutingStage =
        mode === 'direct' ? { mode } : { mode, processor: 'response-processor' };
      const route = adapter(
        spec({ mode: 'direct' }, responseStage, [processor('response-processor')]),
        runner,
        new FakeHttpTransport([() => successfulExchange(jsonBytes(malformed))]),
      );
      const failure = requireFailure(
        await route.execute({ request: canonicalRequest() }),
        'external_protocol_failed',
      );
      assertEqual(
        runner.invocations.length,
        0,
        'Invalid endpoint content cannot be repaired by a filter.',
      );
      assertEqual(
        JSON.stringify(failure),
        '{"kind":"failure","code":"external_protocol_failed"}',
        'Invalid endpoint content must fail wholly without confirming its valid prefix.',
      );
    }
    for (const mode of ['canonical-filter', 'body-decoder'] as const) {
      const runner = new FakeProcessorRunner([
        () => processorExchange(processorSuccess(jsonBytes(malformed))),
      ]);
      const route = adapter(
        spec({ mode: 'direct' }, { mode, processor: 'response-processor' }, [
          processor('response-processor'),
        ]),
        runner,
        new FakeHttpTransport([
          () => successfulExchange(canonicalSuccess('completed', mixedContent())),
        ]),
      );
      const failure = requireFailure(
        await route.execute({ request: canonicalRequest() }),
        'processor_failed',
      );
      assertEqual(
        runner.invocations.length,
        1,
        'Valid endpoint input should reach the response Processor.',
      );
      assertEqual(
        JSON.stringify(failure),
        '{"kind":"failure","code":"processor_failed"}',
        'Invalid Processor output must fail wholly; missing content cannot be restored from input.',
      );
    }
  }
}

async function testBoundaryFailureClassification(): Promise<void> {
  const directRunner = new FakeProcessorRunner([]);
  const directTransport = new FakeHttpTransport([
    () => successfulExchange(encoder.encode('not canonical JSON'), 200),
  ]);
  const directRoute = adapter(
    spec({ mode: 'direct' }, { mode: 'direct' }),
    directRunner,
    directTransport,
  );
  requireFailure(
    await directRoute.execute({ request: canonicalRequest() }),
    'external_protocol_failed',
  );

  const filterRunner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(encoder.encode('not canonical JSON'))),
  ]);
  const filterTransport = new FakeHttpTransport([]);
  const filterRoute = adapter(
    spec({ mode: 'canonical-filter', processor: 'request-filter' }, { mode: 'direct' }, [
      processor('request-filter'),
    ]),
    filterRunner,
    filterTransport,
  );
  requireFailure(await filterRoute.execute({ request: canonicalRequest() }), 'processor_failed');
  assertEqual(
    filterTransport.requests.length,
    0,
    'Invalid request-filter stdout must not start HTTP.',
  );

  const responseFilterRunner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(encoder.encode('not canonical JSON'))),
  ]);
  const responseFilterTransport = new FakeHttpTransport([
    () => successfulExchange(canonicalSuccess()),
  ]);
  const responseFilterRoute = adapter(
    spec({ mode: 'direct' }, { mode: 'canonical-filter', processor: 'response-filter' }, [
      processor('response-filter'),
    ]),
    responseFilterRunner,
    responseFilterTransport,
  );
  requireFailure(
    await responseFilterRoute.execute({ request: canonicalRequest() }),
    'processor_failed',
  );

  const decoderRunner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(canonicalSuccess())),
  ]);
  const decoderTransport = new FakeHttpTransport([
    () => successfulExchange(new Uint8Array([0, 1, 2]), 422),
  ]);
  const decoderRoute = adapter(
    spec({ mode: 'direct' }, { mode: 'body-decoder', processor: 'response-decoder' }, [
      processor('response-decoder'),
    ]),
    decoderRunner,
    decoderTransport,
  );
  requireFailure(await decoderRoute.execute({ request: canonicalRequest() }), 'processor_failed');

  const timeoutDrain = deferred<ProcessorRunDrainMetadata>();
  const timeoutRunner = new FakeProcessorRunner([
    () => processorExchange(processorFailure('timeout'), timeoutDrain.promise),
  ]);
  const timeoutTransport = new FakeHttpTransport([]);
  const timeoutRoute = adapter(
    spec(
      { mode: 'body-encoder', processor: 'body-encoder', contentType: 'application/octet-stream' },
      { mode: 'direct' },
      [processor('body-encoder')],
    ),
    timeoutRunner,
    timeoutTransport,
  );
  const timeoutExchange = timeoutRoute.exchange({ request: canonicalRequest() });
  requireFailure(await timeoutExchange.settled, 'processor_timeout');
  assertEqual(
    timeoutTransport.requests.length,
    0,
    'Timed out request Processor must not start HTTP.',
  );
  let timeoutDrained = false;
  void timeoutExchange.drained.then(() => {
    timeoutDrained = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assertEqual(
    timeoutDrained,
    false,
    'Processor timeout should settle before its local cleanup drains.',
  );
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
  const route = adapter(
    spec({ mode: 'canonical-filter', processor: 'request-filter' }, { mode: 'direct' }, [
      processor('request-filter'),
    ]),
    runner,
    transport,
  );
  const controller = new AbortController();

  const execution = route.exchange({ request: canonicalRequest(), signal: controller.signal });
  await waitFor(() => runner.invocations.length === 1, 'request Processor to start');
  controller.abort();

  requireFailure(await execution.settled, 'cancelled');
  assertEqual(
    transport.requests.length,
    0,
    'Cancellation during request processing must stop HTTP admission.',
  );
  let drained = false;
  void execution.drained.then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assertEqual(drained, false, 'Cancellation must not claim Processor cleanup completed early.');

  pendingProcessor.resolve(
    processorSuccess(
      jsonBytes({
        calls: [{ id: 'call_adapter_1', name: 'translated.tool', arguments: {} }],
      }),
    ),
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assertEqual(
    transport.requests.length,
    0,
    'A late Processor result after abort must not start HTTP.',
  );
  assertEqual(
    drained,
    false,
    'Processor cleanup remains part of outer drain after late settlement.',
  );

  pendingDrain.resolve(processorDrainMetadata());
  await execution.drained;
}

async function testResponseCancellationRejectsLateContent(): Promise<void> {
  for (const mode of ['canonical-filter', 'body-decoder'] as const) {
    for (const cancelDuring of ['http', 'processor'] as const) {
      const transportOutcome = deferred<ExternalHttpTransportOutcome>();
      const transportDrain = deferred<void>();
      const processorOutcome = deferred<ProcessorRunOutcome>();
      const processorDrain = deferred<ProcessorRunDrainMetadata>();
      const runner = new FakeProcessorRunner([
        () => ({ settled: processorOutcome.promise, drained: processorDrain.promise }),
      ]);
      const transport = new FakeHttpTransport([
        () => ({ settled: transportOutcome.promise, drained: transportDrain.promise }),
      ]);
      const route = adapter(
        spec({ mode: 'direct' }, { mode, processor: 'response-processor' }, [
          processor('response-processor'),
        ]),
        runner,
        transport,
      );
      const controller = new AbortController();
      const execution = route.exchange({ request: canonicalRequest(), signal: controller.signal });
      await waitFor(() => transport.requests.length === 1, 'HTTP response stage to start');
      const response: ExternalHttpTransportOutcome = {
        ok: true,
        body: canonicalSuccess('completed', mixedContent()),
        statusCode: 200,
        diagnostics: {
          stage: 'response',
          requestBodyBytes: 1,
          responseBodyBytes: 1,
          statusCode: 200,
        },
      };
      if (cancelDuring === 'processor') {
        transportOutcome.resolve(response);
        await waitFor(() => runner.invocations.length === 1, 'response Processor to start');
        assertEqual(
          runner.invocations[0]?.signal,
          controller.signal,
          'Response Processor should receive the exchange cancellation signal.',
        );
      }

      controller.abort();
      requireFailure(await execution.settled, 'cancelled');
      let drained = false;
      void execution.drained.then(() => {
        drained = true;
      });
      transportOutcome.resolve(response);
      processorOutcome.resolve(processorSuccess(canonicalSuccess('failed', mixedContent())));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      requireFailure(await execution.settled, 'cancelled');
      assertEqual(
        runner.invocations.length,
        cancelDuring === 'http' ? 0 : 1,
        'A late endpoint result cannot start a Processor after cancellation.',
      );
      assertEqual(
        drained,
        false,
        'Cancellation must still wait for HTTP and any started Processor cleanup.',
      );
      transportDrain.resolve();
      if (cancelDuring === 'processor') {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        assertEqual(
          drained,
          false,
          'HTTP drain alone cannot release a started response Processor.',
        );
      }
      processorDrain.resolve(processorDrainMetadata());
      await execution.drained;
    }
  }
}

async function testInvalidResponseStillDrainsStartedStages(): Promise<void> {
  for (const mode of ['canonical-filter', 'body-decoder'] as const) {
    const transportDrain = deferred<void>();
    const processorDrain = deferred<ProcessorRunDrainMetadata>();
    const runner = new FakeProcessorRunner([
      () =>
        processorExchange(
          processorSuccess(
            jsonBytes({
              results: [
                {
                  id: 'call_adapter_1',
                  status: 'completed',
                  content: [
                    { type: 'text', text: 'Must not escape.' },
                    { type: 'image', data: 'bad base64', mime_type: 'image/png' },
                  ],
                },
              ],
            }),
          ),
          processorDrain.promise,
        ),
    ]);
    const transport = new FakeHttpTransport([
      () =>
        successfulExchange(
          canonicalSuccess('completed', mixedContent()),
          200,
          {},
          transportDrain.promise,
        ),
    ]);
    const route = adapter(
      spec({ mode: 'direct' }, { mode, processor: 'response-processor' }, [
        processor('response-processor'),
      ]),
      runner,
      transport,
    );
    const execution = route.exchange({ request: canonicalRequest() });
    requireFailure(await execution.settled, 'processor_failed');
    let drained = false;
    void execution.drained.then(() => {
      drained = true;
    });
    transportDrain.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assertEqual(
      drained,
      false,
      'Invalid canonical content cannot bypass Processor drain after HTTP cleanup.',
    );
    processorDrain.resolve(processorDrainMetadata());
    await execution.drained;
  }
}

async function testSeparatesSettlementFromAllStageDrains(): Promise<void> {
  const processorDrain = deferred<ProcessorRunDrainMetadata>();
  const responseProcessorDrain = deferred<ProcessorRunDrainMetadata>();
  const transportDrain = deferred<void>();
  const filteredRequest = jsonBytes({
    calls: [{ id: 'call_adapter_1', name: 'translated.tool', arguments: {} }],
  });
  const runner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(filteredRequest), processorDrain.promise),
    () =>
      processorExchange(
        processorSuccess(canonicalSuccess('completed', mixedContent())),
        responseProcessorDrain.promise,
      ),
  ]);
  const transport = new FakeHttpTransport([
    () => successfulExchange(canonicalSuccess(), 200, {}, transportDrain.promise),
  ]);
  const diagnostics: ExternalRoutingProcessorDrainDiagnostic[] = [];
  const route = adapter(
    spec(
      { mode: 'canonical-filter', processor: 'request-filter' },
      { mode: 'canonical-filter', processor: 'response-filter' },
      [processor('request-filter'), processor('response-filter')],
    ),
    runner,
    transport,
    {
      onProcessorDrain: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
    },
  );

  const execution = route.exchange({ request: canonicalRequest() });
  requireCanonical(await execution.settled, 'external_tool_completed');
  assertEqual(
    runner.invocations.length,
    2,
    'Both request and response Processors should settle before their drains.',
  );
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
  assertEqual(
    diagnostic?.role,
    'request.canonical-filter',
    'Drain diagnostic should identify the Processor role.',
  );
  assertEqual(
    diagnostic?.processorName,
    'request-filter',
    'Drain diagnostic should identify the configured Processor.',
  );
  assertEqual(
    diagnostic?.cleanupFailed,
    true,
    'Degraded Processor cleanup must remain observable.',
  );
  assertEqual(
    diagnostic?.settledDurationMs,
    1,
    'Drain diagnostic should retain safe settlement duration.',
  );
  assertEqual(
    diagnostic?.drainDurationMs,
    37,
    'Drain diagnostic should retain safe drain duration.',
  );
  assertEqual(diagnostic?.stdinBytes, 1, 'Drain diagnostic should retain safe stdin byte count.');
  assertEqual(
    diagnostic?.stdoutBytes,
    filteredRequest.byteLength,
    'Drain diagnostic should retain safe stdout byte count.',
  );
  assertEqual(drained, false, 'Outer drain must still wait for HTTP cleanup.');
  transportDrain.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assertEqual(drained, false, 'Outer drain must also retain the response Processor cleanup.');
  responseProcessorDrain.resolve(processorDrainMetadata());
  await execution.drained;
  assertEqual(
    diagnostics.length,
    2,
    'Each started Processor should emit its post-drain diagnostic.',
  );
  assertEqual(
    diagnostics[1]?.role,
    'response.canonical-filter',
    'Response drain diagnostic should retain its stage role.',
  );
}

async function testProcessorDrainSinkFailuresAreIsolated(): Promise<void> {
  let callbackCalls = 0;
  const runner = new FakeProcessorRunner([
    () => processorExchange(processorSuccess(new Uint8Array([0, 1, 2]))),
  ]);
  const transport = new FakeHttpTransport([() => successfulExchange(canonicalSuccess())]);
  const route = adapter(
    spec(
      {
        mode: 'body-encoder',
        processor: 'body-encoder',
        contentType: 'application/octet-stream',
      },
      { mode: 'direct' },
      [processor('body-encoder')],
    ),
    runner,
    transport,
    {
      onProcessorDrain: () => {
        callbackCalls++;
        throw new Error('processor drain diagnostic sink failure');
      },
    },
  );

  const execution = route.exchange({ request: canonicalRequest() });
  requireCanonical(await execution.settled, 'external_tool_completed');
  await execution.drained;
  assertEqual(
    callbackCalls,
    1,
    'A throwing drain sink should still receive the safe diagnostic once.',
  );
}

async function testExceptionsDoNotEscapeOrLeak(): Promise<void> {
  const runner = new FakeProcessorRunner([
    () => {
      throw new Error('processor raw stdout secret');
    },
  ]);
  const transport = new FakeHttpTransport([]);
  const route = adapter(
    spec(
      { mode: 'body-encoder', processor: 'body-encoder', contentType: 'application/octet-stream' },
      { mode: 'direct' },
      [processor('body-encoder')],
    ),
    runner,
    transport,
  );

  const outcome = requireFailure(
    await route.execute({ request: canonicalRequest() }),
    'processor_failed',
  );
  assertEqual(
    Object.keys(outcome).join(','),
    'kind,code',
    'Failure outcome must retain only structured classification.',
  );
  assertNotIncludes(
    JSON.stringify(outcome),
    'secret',
    'Raw dependency exceptions must never enter adapter output.',
  );

  const throwingTransport: ExternalRoutingHttpTransport = {
    exchange(): ExternalHttpTransportExchange {
      throw new Error('https://secret.example.test/path?token=raw');
    },
  };
  const transportFailureRoute = new ExternalRoutingStrategyAdapter({
    route: spec({ mode: 'direct' }, { mode: 'direct' }),
    processorsByName: new Map(),
    processorRunner: new FakeProcessorRunner([]),
    httpTransport: throwingTransport,
  });
  const transportOutcome = requireFailure(
    await transportFailureRoute.execute({ request: canonicalRequest() }),
    'external_transport_failed',
  );
  assertNotIncludes(
    JSON.stringify(transportOutcome),
    'secret',
    'Raw transport exceptions must never enter adapter output.',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external-routing strategy adapter',
    tests: [
      {
        name: 'routes direct canonical request and response without a Processor',
        run: testDirectRequestAndResponse,
      },
      { name: 'runs and validates canonical request filters', run: testCanonicalRequestFilter },
      { name: 'uses body encoder stdout as raw HTTP request bytes', run: testBodyEncoderRequest },
      { name: 'runs and validates canonical response filters', run: testCanonicalResponseFilter },
      {
        name: 'runs body decoders with raw entity and response metadata',
        run: testBodyDecoderResponse,
      },
      { name: 'enforces 2xx versus 4xx/5xx canonical status contracts', run: testStatusContract },
      {
        name: 'rejects invalid content wholly at the endpoint or Processor boundary',
        run: testInvalidContentFailsAtOwningBoundary,
      },
      {
        name: 'classifies HTTP and Processor contract failures by boundary',
        run: testBoundaryFailureClassification,
      },
      { name: 'cancellation stops later strategy stages', run: testCancellationStopsLaterStages },
      {
        name: 'response cancellation rejects late content and retains stage drains',
        run: testResponseCancellationRejectsLateContent,
      },
      {
        name: 'invalid response content still drains all started stages',
        run: testInvalidResponseStillDrainsStartedStages,
      },
      {
        name: 'separates fast settlement from aggregate Processor and HTTP drain',
        run: testSeparatesSettlementFromAllStageDrains,
      },
      {
        name: 'isolates Processor drain diagnostic sink failures',
        run: testProcessorDrainSinkFailuresAreIsolated,
      },
      { name: 'contains injected dependency exceptions', run: testExceptionsDoNotEscapeOrLeak },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
