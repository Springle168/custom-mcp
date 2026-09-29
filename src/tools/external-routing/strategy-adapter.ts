import {
  encodeCanonicalRequestDocument,
  isCanonicalSuccessResponse,
  parseCanonicalResponseDocument,
  parseStrictUtf8JsonDocument,
  validateCanonicalRequest,
  validateCanonicalRequestFilterOutput,
  validateCanonicalResponseFilterOutput,
  type CanonicalRequest,
  type CanonicalResponse,
} from './canonical-protocol.js';
import type {
  CompiledHttpRoute,
  ExternalProcessorDefinition,
} from './config.js';
import type {
  ExternalHttpTransportExchange,
  ExternalHttpTransportOutcome,
  ExternalHttpTransportRequest,
} from './http-transport.js';
import type {
  ProcessorInvocation,
  ProcessorRunDrainMetadata,
  ProcessorRunExchange,
  ProcessorRunOutcome,
} from './processor-runner.js';

const CANONICAL_JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Minimal Processor dependency required by strategy orchestration. The runner
 * remains responsible for subprocess lifecycle, limits, and cancellation.
 */
export interface ExternalRoutingProcessorRunner {
  run(invocation: ProcessorInvocation): ProcessorRunExchange;
}

/**
 * Minimal HTTP dependency required by strategy orchestration. The owner of
 * this dependency retains responsibility for transport admission and close.
 */
export interface ExternalRoutingHttpTransport {
  exchange(request: ExternalHttpTransportRequest): ExternalHttpTransportExchange;
}

/**
 * Safe cleanup metadata emitted after one Processor invocation drains. It
 * deliberately excludes executable paths, argv, stderr text, stdout bytes,
 * and every other subprocess-owned value.
 */
export interface ExternalRoutingProcessorDrainDiagnostic {
  readonly definitionId: string;
  readonly toolName: string;
  readonly role: ProcessorInvocation['environment']['role'];
  readonly processorName: string;
  readonly cleanupFailed: boolean;
  readonly settledDurationMs: number;
  readonly drainDurationMs: number;
  readonly stdinBytes: number;
  readonly stdoutBytes: number;
  readonly stderrByteCount: number;
  readonly stderrCapturedByteCount: number;
  readonly stderrTruncated: boolean;
}

export interface ExternalRoutingStrategyAdapterOptions {
  /** Startup-validated configuration snapshot for this external route. */
  readonly route: CompiledHttpRoute;
  readonly processorsByName: ReadonlyMap<string, ExternalProcessorDefinition>;
  readonly processorRunner?: ExternalRoutingProcessorRunner;
  readonly httpTransport: ExternalRoutingHttpTransport;
  /**
   * Optional owner-supplied diagnostic sink. It is invoked after Processor
   * drain and is fully isolated from caller outcome and cleanup completion.
   */
  readonly onProcessorDrain?: (
    diagnostic: ExternalRoutingProcessorDrainDiagnostic,
  ) => void | Promise<void>;
}

export interface ExecuteExternalRoutingStrategyOptions {
  /** The already-admitted, single-call canonical request for this exchange. */
  readonly request: CanonicalRequest;
  /** Local caller or shutdown cancellation for this exchange. */
  readonly signal?: AbortSignal;
}

export type ExternalRoutingStrategyFailureCode =
  | 'external_request_too_large'
  | 'external_transport_failed'
  | 'external_timeout'
  | 'external_response_too_large'
  | 'external_protocol_failed'
  | 'processor_failed'
  | 'processor_timeout'
  | 'external_internal_failed'
  | 'cancelled';

export type ExternalRoutingCanonicalOutcomeCode =
  | 'external_tool_completed'
  | 'external_tool_failed'
  | 'external_tool_cancelled'
  | 'external_rejected';

/** A validated remote business outcome, still independent from MCP results. */
export interface ExternalRoutingCanonicalOutcome {
  readonly kind: 'canonical';
  readonly code: ExternalRoutingCanonicalOutcomeCode;
  readonly response: CanonicalResponse;
}

/** A local routing failure without body, stdout, stderr, or exception data. */
export interface ExternalRoutingStrategyFailure {
  readonly kind: 'failure';
  readonly code: ExternalRoutingStrategyFailureCode;
}

export type ExternalRoutingStrategyOutcome =
  | ExternalRoutingCanonicalOutcome
  | ExternalRoutingStrategyFailure;

/**
 * One strategy invocation's dual completion. `settled` is caller-facing and
 * terminal; `drained` completes only after all started Processor/HTTP stages
 * have completed their local cleanup.
 */
export interface ExternalRoutingStrategyExchange {
  readonly settled: Promise<ExternalRoutingStrategyOutcome>;
  readonly drained: Promise<void>;
}

type RequestAdaptation =
  | {
      readonly kind: 'success';
      readonly body: Uint8Array;
      readonly contentType: string;
    }
  | ExternalRoutingStrategyFailure;

type ResponseAdaptation =
  | CanonicalResponse
  | ExternalRoutingStrategyFailure;

/**
 * Combines configured request/response strategies without owning admission,
 * MCP result mapping, or HTTP/Processor resource shutdown. Each started stage
 * may settle before cleanup; only the returned `drained` waits for all of it.
 */
export class ExternalRoutingStrategyAdapter {
  readonly #route: CompiledHttpRoute;
  readonly #processorsByName: ReadonlyMap<string, ExternalProcessorDefinition>;
  readonly #processorRunner: ExternalRoutingProcessorRunner | undefined;
  readonly #httpTransport: ExternalRoutingHttpTransport;
  readonly #onProcessorDrain: ExternalRoutingStrategyAdapterOptions['onProcessorDrain'];

  constructor(options: ExternalRoutingStrategyAdapterOptions) {
    this.#route = options.route;
    this.#processorsByName = options.processorsByName;
    this.#processorRunner = options.processorRunner;
    this.#httpTransport = options.httpTransport;
    this.#onProcessorDrain = options.onProcessorDrain;
  }

  /**
   * Starts one already-admitted external exchange. A successful stage starts
   * the next one immediately after its `settled` completion; stage cleanup is
   * aggregated separately into the outer `drained` promise.
   */
  exchange(
    options: ExecuteExternalRoutingStrategyOptions,
  ): ExternalRoutingStrategyExchange {
    const drains = new DrainTracker();
    let resolveSettled: (outcome: ExternalRoutingStrategyOutcome) => void;
    const settled = new Promise<ExternalRoutingStrategyOutcome>((resolve) => {
      resolveSettled = resolve;
    });
    let settledOnce = false;
    const settle = (outcome: ExternalRoutingStrategyOutcome): void => {
      if (settledOnce) {
        return;
      }
      settledOnce = true;
      resolveSettled(outcome);
    };
    const isSettled = (): boolean => settledOnce;

    const signal = options.signal;
    const onAbort = (): void => settle(failure('cancelled'));
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    const pipeline = this.#runPipeline(options, drains, settle, isSettled)
      .catch(() => {
        // This is the final adapter boundary. Never expose an exception from a
        // malformed injected dependency or local orchestration defect.
        settle(failure('external_internal_failed'));
      });
    const drained = (async (): Promise<void> => {
      try {
        await pipeline;
        await drains.wait();
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    })().catch(() => {
      // Drained is a lifecycle completion, not an exception channel. Concrete
      // runners/transports must contain their own cleanup diagnostics.
    });

    return { settled, drained };
  }

  /**
   * Test convenience for callers interested only in caller-facing settlement.
   * Runtime owners must use `exchange()` and retain the matching `drained`.
   */
  execute(
    options: ExecuteExternalRoutingStrategyOptions,
  ): Promise<ExternalRoutingStrategyOutcome> {
    return this.exchange(options).settled;
  }

  async #runPipeline(
    options: ExecuteExternalRoutingStrategyOptions,
    drains: DrainTracker,
    settle: (outcome: ExternalRoutingStrategyOutcome) => void,
    isSettled: () => boolean,
  ): Promise<void> {
    if (isSettled()) {
      return;
    }

    let request: CanonicalRequest;
    try {
      // The executor normally constructs this document, but revalidation keeps
      // injected callers from turning local invalid data into HTTP bytes.
      request = validateCanonicalRequest(options.request);
    } catch {
      settle(failure('external_internal_failed'));
      return;
    }

    const requestAdaptation = await this.#adaptRequest(
      request,
      options.signal,
      drains,
      isSettled,
    );
    if (isSettled()) {
      return;
    }
    if (requestAdaptation.kind === 'failure') {
      settle(requestAdaptation);
      return;
    }

    const transportOutcome = await this.#runTransport({
      endpoint: this.#route.endpoint,
      body: requestAdaptation.body,
      contentType: requestAdaptation.contentType,
      responseMode: this.#route.responseStage.mode,
      signal: options.signal,
    }, drains);
    if (isSettled()) {
      return;
    }
    if (transportOutcome === undefined) {
      settle(failure('external_transport_failed'));
      return;
    }
    if (!transportOutcome.ok) {
      settle(failure(transportOutcome.code));
      return;
    }

    const response = await this.#adaptResponse(
      transportOutcome.body,
      transportOutcome.statusCode,
      transportOutcome.contentType,
      transportOutcome.contentEncoding,
      request.calls[0].id,
      options.signal,
      drains,
      isSettled,
    );
    if (isSettled()) {
      return;
    }
    if (isFailure(response)) {
      settle(response);
      return;
    }

    settle(canonicalOutcome(response));
  }

  async #adaptRequest(
    request: CanonicalRequest,
    signal: AbortSignal | undefined,
    drains: DrainTracker,
    isSettled: () => boolean,
  ): Promise<RequestAdaptation> {
    if (isSettled()) {
      return failure('cancelled');
    }

    let requestBytes: Uint8Array;
    try {
      requestBytes = encodeCanonicalRequestDocument(request);
    } catch {
      return failure('external_internal_failed');
    }

    const strategy = this.#route.requestStage;
    if (strategy.mode === 'direct') {
      return {
        kind: 'success',
        body: requestBytes,
        contentType: CANONICAL_JSON_CONTENT_TYPE,
      };
    }

    const processor = this.#processorFor(strategy.processor);
    if (!processor) {
      return failure('processor_failed');
    }

    const processorOutcome = await this.#runProcessor(
      processor,
      requestBytes,
      strategy.mode === 'canonical-filter'
        ? { role: 'request.canonical-filter', callId: request.calls[0].id }
        : { role: 'request.body-encoder', callId: request.calls[0].id },
      signal,
      drains,
    );
    if (isSettled()) {
      return failure('cancelled');
    }
    if (isFailure(processorOutcome)) {
      return processorOutcome;
    }

    if (strategy.mode === 'body-encoder') {
      return {
        kind: 'success',
        body: processorOutcome,
        contentType: strategy.contentType,
      };
    }

    try {
      const filtered = validateCanonicalRequestFilterOutput(
        parseStrictUtf8JsonDocument(processorOutcome),
        request,
      );
      return {
        kind: 'success',
        body: encodeCanonicalRequestDocument(filtered),
        contentType: CANONICAL_JSON_CONTENT_TYPE,
      };
    } catch {
      // A filter's stdout is owned by the local Processor boundary, not by the
      // external HTTP peer, even when its contract is canonical JSON.
      return failure('processor_failed');
    }
  }

  async #adaptResponse(
    body: Uint8Array,
    statusCode: number,
    contentType: string | undefined,
    contentEncoding: string | undefined,
    callId: string,
    signal: AbortSignal | undefined,
    drains: DrainTracker,
    isSettled: () => boolean,
  ): Promise<ResponseAdaptation> {
    if (isSettled()) {
      return failure('cancelled');
    }

    const strategy = this.#route.responseStage;
    if (strategy.mode === 'direct') {
      const response = parseExternalCanonicalResponse(body, callId);
      if (isFailure(response)) {
        return response;
      }
      return hasLegalResponseStatus(statusCode, response)
        ? response
        : failure('external_protocol_failed');
    }

    if (strategy.mode === 'canonical-filter') {
      const externalResponse = parseExternalCanonicalResponse(body, callId);
      if (isFailure(externalResponse)) {
        return externalResponse;
      }
      if (!hasLegalResponseStatus(statusCode, externalResponse)) {
        return failure('external_protocol_failed');
      }
      if (isSettled()) {
        return failure('cancelled');
      }

      const processor = this.#processorFor(strategy.processor);
      if (!processor) {
        return failure('processor_failed');
      }
      const processorOutcome = await this.#runProcessor(
        processor,
        encodeCanonicalResponseDocument(externalResponse),
        {
          role: 'response.canonical-filter',
          callId,
          httpStatus: statusCode,
          ...(contentType === undefined ? {} : { contentType }),
          ...(contentEncoding === undefined ? {} : { contentEncoding }),
        },
        signal,
        drains,
      );
      if (isSettled()) {
        return failure('cancelled');
      }
      if (isFailure(processorOutcome)) {
        return processorOutcome;
      }

      try {
        const filtered = validateCanonicalResponseFilterOutput(
          parseStrictUtf8JsonDocument(processorOutcome),
          externalResponse,
          callId,
        );
        return hasLegalResponseStatus(statusCode, filtered)
          ? filtered
          : failure('external_protocol_failed');
      } catch {
        return failure('processor_failed');
      }
    }

    const processor = this.#processorFor(strategy.processor);
    if (!processor) {
      return failure('processor_failed');
    }
    const processorOutcome = await this.#runProcessor(
      processor,
      body,
      {
        role: 'response.body-decoder',
        callId,
        httpStatus: statusCode,
        ...(contentType === undefined ? {} : { contentType }),
        ...(contentEncoding === undefined ? {} : { contentEncoding }),
      },
      signal,
      drains,
    );
    if (isSettled()) {
      return failure('cancelled');
    }
    if (isFailure(processorOutcome)) {
      return processorOutcome;
    }

    const response = parseProcessorCanonicalResponse(processorOutcome, callId);
    if (isFailure(response)) {
      return response;
    }
    if (hasLegalResponseStatus(statusCode, response)) {
      return response;
    }

    // The body-decoder owns the construction of this otherwise-valid canonical
    // response. A success response for an HTTP error status is therefore a
    // Processor contract violation, rather than invalid direct HTTP input.
    return isClientOrServerErrorStatus(statusCode) && isCanonicalSuccessResponse(response)
      ? failure('processor_failed')
      : failure('external_protocol_failed');
  }

  async #runProcessor(
    processor: ExternalProcessorDefinition,
    stdin: Uint8Array,
    environment: ProcessorInvocation['environment'],
    signal: AbortSignal | undefined,
    drains: DrainTracker,
  ): Promise<Uint8Array | ExternalRoutingStrategyFailure> {
    const processorRunner = this.#processorRunner;
    if (processorRunner === undefined) {
      return failure('processor_failed');
    }

    let exchange: ProcessorRunExchange;
    try {
      exchange = processorRunner.run({
        command: commandFor(processor),
        arguments: processor.arguments,
        workingDirectory: processor.workingDirectory,
        timeoutMs: processor.timeoutMs,
        stdin,
        environment,
        signal,
      });
      drains.track(this.#observeProcessorDrain(
        processor.name,
        environment.role,
        exchange,
      ));
    } catch {
      return failure('processor_failed');
    }

    let outcome: ProcessorRunOutcome;
    try {
      outcome = await exchange.settled;
    } catch {
      return failure('processor_failed');
    }
    if (outcome.kind === 'success') {
      return outcome.stdout;
    }
    if (outcome.reason === 'cancelled') {
      return failure('cancelled');
    }
    return failure(outcome.reason === 'timeout' ? 'processor_timeout' : 'processor_failed');
  }

  async #observeProcessorDrain(
    processorName: string,
    role: ProcessorInvocation['environment']['role'],
    exchange: ProcessorRunExchange,
  ): Promise<void> {
    let outcome: ProcessorRunOutcome;
    try {
      outcome = await exchange.settled;
    } catch {
      return;
    }

    let drainMetadata: ProcessorRunDrainMetadata;
    try {
      drainMetadata = await exchange.drained;
    } catch {
      return;
    }

    this.#emitProcessorDrainDiagnostic({
      definitionId: this.#route.definitionId,
      toolName: this.#route.toolName,
      role,
      processorName,
      cleanupFailed: drainMetadata.cleanupFailed,
      settledDurationMs: outcome.durationMs,
      drainDurationMs: drainMetadata.durationMs,
      stdinBytes: outcome.stdinBytes,
      stdoutBytes: outcome.stdoutBytes,
      stderrByteCount: outcome.stderr.byteCount,
      stderrCapturedByteCount: outcome.stderr.capturedByteCount,
      stderrTruncated: outcome.stderr.truncated,
    });
  }

  #emitProcessorDrainDiagnostic(
    diagnostic: ExternalRoutingProcessorDrainDiagnostic,
  ): void {
    const callback = this.#onProcessorDrain;
    if (!callback) {
      return;
    }

    try {
      // Do not await arbitrary owner diagnostics: a slow or failing sink must
      // neither revise the exchange outcome nor delay lifecycle cleanup.
      void Promise.resolve(callback(diagnostic)).catch(ignoreProcessorDrainDiagnosticFailure);
    } catch {
      // Synchronous sink failures are isolated just like asynchronous ones.
    }
  }

  async #runTransport(
    request: ExternalHttpTransportRequest,
    drains: DrainTracker,
  ): Promise<ExternalHttpTransportOutcome | undefined> {
    let exchange: ExternalHttpTransportExchange;
    try {
      exchange = this.#httpTransport.exchange(request);
      drains.track(exchange.drained);
    } catch {
      return undefined;
    }

    try {
      return await exchange.settled;
    } catch {
      // A real transport resolves controlled outcomes, but injected fakes must
      // not permit an exception to cross this strategy boundary.
      return undefined;
    }
  }

  #processorFor(name: string): ExternalProcessorDefinition | undefined {
    return this.#processorsByName.get(name);
  }
}

class DrainTracker {
  readonly #drains: Promise<void>[] = [];

  track(drain: Promise<unknown>): void {
    // Do not turn cleanup into a raw exception channel. The underlying owner
    // owns diagnostics, while this adapter provides a reliable lifecycle wait.
    this.#drains.push(drain.then(() => undefined, ignoreDrainFailure));
  }

  async wait(): Promise<void> {
    await Promise.all(this.#drains);
  }
}

function parseExternalCanonicalResponse(
  bytes: Uint8Array,
  callId: string,
): CanonicalResponse | ExternalRoutingStrategyFailure {
  try {
    return parseCanonicalResponseDocument(bytes, callId);
  } catch {
    // HTTP response bodies are external peer input, including direct and the
    // input side of canonical response filters.
    return failure('external_protocol_failed');
  }
}

function parseProcessorCanonicalResponse(
  bytes: Uint8Array,
  callId: string,
): CanonicalResponse | ExternalRoutingStrategyFailure {
  try {
    return parseCanonicalResponseDocument(bytes, callId);
  } catch {
    return failure('processor_failed');
  }
}

function encodeCanonicalResponseDocument(response: CanonicalResponse): Uint8Array {
  // Every input has passed canonical validation, so JSON.stringify cannot
  // invoke custom serialization or produce non-JSON values here.
  return new TextEncoder().encode(JSON.stringify(response));
}

function hasLegalResponseStatus(statusCode: number, response: CanonicalResponse): boolean {
  if (!Number.isInteger(statusCode)) {
    return false;
  }
  if (statusCode >= 200 && statusCode < 300) {
    return true;
  }
  if (isClientOrServerErrorStatus(statusCode)) {
    return !isCanonicalSuccessResponse(response);
  }
  return false;
}

function isClientOrServerErrorStatus(statusCode: number): boolean {
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600;
}

function canonicalOutcome(response: CanonicalResponse): ExternalRoutingCanonicalOutcome {
  if (!isCanonicalSuccessResponse(response)) {
    return { kind: 'canonical', code: 'external_rejected', response };
  }

  const result = response.results[0];
  const code: ExternalRoutingCanonicalOutcomeCode = result.status === 'completed'
    ? 'external_tool_completed'
    : result.status === 'failed'
      ? 'external_tool_failed'
      : 'external_tool_cancelled';
  return { kind: 'canonical', code, response };
}

function commandFor(processor: ExternalProcessorDefinition): string {
  return processor.executable.resolution === 'absolute-path'
    ? processor.executable.path
    : processor.executable.command;
}

function failure(code: ExternalRoutingStrategyFailureCode): ExternalRoutingStrategyFailure {
  return { kind: 'failure', code };
}

function isFailure(value: unknown): value is ExternalRoutingStrategyFailure {
  return typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'failure';
}

function ignoreDrainFailure(): void {
  // Underlying runner/transport cleanup failures are intentionally opaque here.
}

function ignoreProcessorDrainDiagnosticFailure(): void {
  // Owner diagnostic sinks cannot affect exchange settlement or cleanup.
}
