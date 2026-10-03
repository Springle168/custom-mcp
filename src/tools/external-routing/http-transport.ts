import {
  Agent as HttpAgent,
  request as httpRequest,
  validateHeaderName,
  validateHeaderValue,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { MIMEType } from 'node:util';
import type { Duplex } from 'node:stream';
import type { ExternalHttpEndpointConfig } from './config.js';

/** The fixed v1 limit for both final request and external response entities. */
export const MAX_EXTERNAL_HTTP_BODY_BYTES = 50 * 1024 * 1024;

export type ExternalHttpResponseMode = 'direct' | 'canonical-filter' | 'body-decoder';

export type ExternalHttpTransportFailureCode =
  | 'external_request_too_large'
  | 'external_transport_failed'
  | 'external_timeout'
  | 'external_response_too_large'
  | 'external_protocol_failed'
  | 'cancelled';

export type ExternalHttpTransportStage = 'request' | 'connection' | 'response';

/**
 * Safe transport metadata for diagnostics. It deliberately excludes endpoint
 * URLs, header values, entity bytes, and underlying Node.js exceptions.
 */
export interface ExternalHttpTransportDiagnostics {
  readonly stage: ExternalHttpTransportStage;
  readonly requestBodyBytes: number;
  readonly responseBodyBytes: number;
  readonly statusCode?: number;
}

export interface ExternalHttpTransportSuccess {
  readonly ok: true;
  readonly statusCode: number;
  /** Raw HTTP entity bytes. The transport never performs decompression. */
  readonly body: Uint8Array;
  /** Validated and trimmed response field value, when present. */
  readonly contentType?: string;
  /** Validated, lower-cased comma-separated coding list, when non-empty. */
  readonly contentEncoding?: string;
  readonly diagnostics: ExternalHttpTransportDiagnostics;
}

export interface ExternalHttpTransportFailure {
  readonly ok: false;
  readonly code: ExternalHttpTransportFailureCode;
  /** A controlled message that never contains endpoint or Node.js error data. */
  readonly message: string;
  readonly diagnostics: ExternalHttpTransportDiagnostics;
}

export type ExternalHttpTransportOutcome =
  ExternalHttpTransportSuccess | ExternalHttpTransportFailure;

export interface ExternalHttpTransportRequest {
  /** Startup-validated endpoint snapshot selected by the compiled route. */
  readonly endpoint?: ExternalHttpEndpointConfig;
  /** The final already-encoded entity body. */
  readonly body: Uint8Array;
  /** The request routing strategy's transport-owned media type. */
  readonly contentType: string;
  /** Selects only HTTP representation checks; no canonical protocol is parsed. */
  readonly responseMode: ExternalHttpResponseMode;
  /** Caller cancellation propagated from the active external exchange. */
  readonly signal?: AbortSignal;
}

/**
 * A single HTTP exchange exposes caller settlement separately from local drain.
 * After `settled`, late events cannot revise the outcome. `drained` completes
 * once this transport has detached its local request/response ownership.
 */
export interface ExternalHttpTransportExchange {
  readonly settled: Promise<ExternalHttpTransportOutcome>;
  readonly drained: Promise<void>;
}

export interface ExternalHttpTransport {
  exchange(request: ExternalHttpTransportRequest): ExternalHttpTransportExchange;
  /** Idempotently rejects new exchanges and destroys both dedicated Agents. */
  close(): Promise<void>;
}

const TRANSPORT_OWNED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'accept-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
]);
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_FAILURE_DRAIN_GRACE_MS = 1_000;
const REQUEST_WRITE_CHUNK_BYTES = 16 * 1024;
const IGNORE_LATE_ERROR = (): void => {};

const FAILURE_MESSAGES: Readonly<Record<ExternalHttpTransportFailureCode, string>> = {
  external_request_too_large:
    'The external request body exceeds the configured size limit. No request was sent.',
  external_transport_failed:
    'The external HTTP exchange could not be completed. The external server might have performed the requested action; custom-mcp will not retry it.',
  external_timeout:
    'The external HTTP exchange timed out. The external server might have performed the requested action; custom-mcp will not retry it.',
  external_response_too_large: 'The external HTTP response body exceeds the configured size limit.',
  external_protocol_failed:
    'The external HTTP response did not satisfy the external routing protocol.',
  cancelled:
    'The external HTTP exchange was cancelled. The external server might have performed the requested action; custom-mcp will not retry it.',
};

interface PreparedEndpoint {
  readonly url: URL;
  readonly timeoutMs: number;
  readonly staticHeaders: Readonly<Record<string, string>>;
}

interface ResponseMetadata {
  readonly contentType?: string;
  readonly contentEncoding?: string;
}

interface StagedResponse {
  readonly statusCode: number;
  readonly body: Uint8Array;
  readonly metadata: ResponseMetadata;
}

/**
 * Creates an owner-scoped HTTP transport with dedicated HTTP and HTTPS Agents.
 * Endpoint configuration is expected to have passed startup validation; this
 * defensive boundary still turns malformed runtime input into a safe outcome.
 */
export function createExternalHttpTransport(
  defaultEndpoint?: ExternalHttpEndpointConfig,
): ExternalHttpTransport {
  return new NodeExternalHttpTransport(defaultEndpoint);
}

class NodeExternalHttpTransport implements ExternalHttpTransport {
  readonly #httpAgent = new HttpAgent({ keepAlive: true });
  readonly #httpsAgent = new HttpsAgent({ keepAlive: true });
  readonly #activeExchanges = new Set<ActiveHttpExchange>();
  readonly #defaultEndpoint: ExternalHttpEndpointConfig | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(defaultEndpoint?: ExternalHttpEndpointConfig) {
    this.#defaultEndpoint = defaultEndpoint;
  }

  exchange(request: ExternalHttpTransportRequest): ExternalHttpTransportExchange {
    const configuredEndpoint = request.endpoint ?? this.#defaultEndpoint;
    const endpoint =
      configuredEndpoint === undefined ? undefined : prepareEndpoint(configuredEndpoint);
    const requestBodyBytes = request.body instanceof Uint8Array ? request.body.byteLength : 0;

    if (this.#closed || request.signal?.aborted) {
      return completedExchange(createFailure('cancelled', 'request', requestBodyBytes, 0));
    }
    if (!endpoint || !isValidTransportRequest(request)) {
      return completedExchange(
        createFailure('external_transport_failed', 'request', requestBodyBytes, 0),
      );
    }
    if (request.body.byteLength > MAX_EXTERNAL_HTTP_BODY_BYTES) {
      return completedExchange(
        createFailure('external_request_too_large', 'request', request.body.byteLength, 0),
      );
    }

    const exchange = new ActiveHttpExchange(this, endpoint, request);
    this.#activeExchanges.add(exchange);
    exchange.start();
    return exchange;
  }

  close(): Promise<void> {
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#closed = true;
    const active = [...this.#activeExchanges];
    this.#closePromise = (async () => {
      for (const exchange of active) {
        exchange.cancelForTransportClose();
      }
      await Promise.all(active.map((exchange) => exchange.drained));

      // These are transport-owned Agents, never process-global defaults. Keep
      // them alive until every active exchange detached its local listeners.
      this.#httpAgent.destroy();
      this.#httpsAgent.destroy();
    })();
    return this.#closePromise;
  }

  requestFor(endpoint: PreparedEndpoint, headers: Readonly<Record<string, string>>): ClientRequest {
    const options = {
      method: 'POST',
      headers,
      agent: endpoint.url.protocol === 'https:' ? this.#httpsAgent : this.#httpAgent,
    };
    return endpoint.url.protocol === 'https:'
      ? httpsRequest(endpoint.url, options)
      : httpRequest(endpoint.url, options);
  }

  release(exchange: ActiveHttpExchange): void {
    this.#activeExchanges.delete(exchange);
  }
}

class ActiveHttpExchange implements ExternalHttpTransportExchange {
  readonly settled: Promise<ExternalHttpTransportOutcome>;
  readonly drained: Promise<void>;
  readonly #owner: NodeExternalHttpTransport;
  readonly #endpoint: PreparedEndpoint;
  #requestBody: Buffer | undefined;
  readonly #requestBodyBytes: number;
  #requestHeaders: Readonly<Record<string, string>> | undefined;
  readonly #responseMode: ExternalHttpResponseMode;
  readonly #signal: AbortSignal | undefined;
  #resolveSettled!: (outcome: ExternalHttpTransportOutcome) => void;
  #resolveDrained!: () => void;
  #clientRequest: ClientRequest | undefined;
  #response: IncomingMessage | undefined;
  #responseChunks: Buffer[] | undefined;
  #responseMetadata: ResponseMetadata | undefined;
  #responseStatusCode: number | undefined;
  #timer: NodeJS.Timeout | undefined;
  #abortListener: (() => void) | undefined;
  #requestWriteOffset = 0;
  #requestEnded = false;
  #writeContinuation: NodeJS.Immediate | undefined;
  #requestFinished = false;
  #requestClosed = false;
  #responseClosed = false;
  #settled = false;
  #failureTerminal = false;
  #drained = false;
  #drainTimer: NodeJS.Timeout | undefined;
  #responseBodyBytes = 0;
  #stagedResponse: StagedResponse | undefined;

  readonly #onRequestClose = (): void => {
    this.#requestClosed = true;
    if (!this.#settled && !this.#requestFinished) {
      this.fail('external_transport_failed', 'connection');
    }
    this.tryReleaseFailure();
  };

  readonly #onRequestFinish = (): void => {
    this.#requestFinished = true;
    this.trySettleStagedResponse();
  };

  readonly #onRequestDrain = (): void => {
    this.writeRequestBody();
  };

  readonly #onRequestError = (): void => {
    this.fail('external_transport_failed', 'connection');
  };

  readonly #onRequestResponse = (response: IncomingMessage): void => {
    this.receiveResponse(response);
  };

  readonly #onRequestUpgrade = (response: IncomingMessage, socket: Duplex): void => {
    this.fail('external_protocol_failed', 'response');
    response.on('error', IGNORE_LATE_ERROR);
    response.destroy();
    socket.destroy();
  };

  readonly #onRequestConnect = (response: IncomingMessage, socket: Duplex): void => {
    this.fail('external_protocol_failed', 'response');
    response.on('error', IGNORE_LATE_ERROR);
    response.destroy();
    socket.destroy();
  };

  readonly #onRequestInformation = (): void => {
    // Node emits interim 1xx responses here; only `response` is final.
  };

  readonly #onResponseClose = (): void => {
    const response = this.#response;
    this.#responseClosed = true;
    if (response && !response.complete) {
      this.fail('external_transport_failed', 'response', this.#responseStatusCode);
    }
    this.tryReleaseFailure();
  };

  readonly #onResponseData = (chunk: Buffer): void => {
    if (this.#settled) {
      return;
    }
    this.#responseBodyBytes += chunk.byteLength;
    if (this.#responseBodyBytes > MAX_EXTERNAL_HTTP_BODY_BYTES) {
      this.fail('external_response_too_large', 'response', this.#responseStatusCode);
      return;
    }
    this.#responseChunks?.push(chunk);
  };

  readonly #onResponseEnd = (): void => {
    if (this.#settled) {
      return;
    }
    const response = this.#response;
    const statusCode = this.#responseStatusCode;
    const metadata = this.#responseMetadata;
    const chunks = this.#responseChunks;
    if (!response || statusCode === undefined || !metadata || !chunks) {
      this.fail('external_transport_failed', 'response', statusCode);
      return;
    }
    if (!response.complete) {
      this.fail('external_transport_failed', 'response', statusCode);
      return;
    }
    if (this.#responseBodyBytes === 0) {
      this.fail('external_protocol_failed', 'response', statusCode);
      return;
    }
    this.#stagedResponse = {
      statusCode,
      body: Buffer.concat(chunks, this.#responseBodyBytes),
      metadata,
    };
    this.#responseChunks = undefined;
    this.trySettleStagedResponse();
  };

  readonly #onResponseAborted = (): void => {
    this.fail('external_transport_failed', 'response', this.#responseStatusCode);
  };

  readonly #onResponseError = (): void => {
    this.fail('external_transport_failed', 'response', this.#responseStatusCode);
  };

  constructor(
    owner: NodeExternalHttpTransport,
    endpoint: PreparedEndpoint,
    request: ExternalHttpTransportRequest,
  ) {
    this.#owner = owner;
    this.#endpoint = endpoint;
    this.#requestBody = Buffer.from(request.body);
    this.#requestBodyBytes = this.#requestBody.byteLength;
    this.#requestHeaders = buildRequestHeaders(
      endpoint.staticHeaders,
      request.contentType,
      this.#requestBodyBytes,
    );
    this.#responseMode = request.responseMode;
    this.#signal = request.signal;
    this.settled = new Promise<ExternalHttpTransportOutcome>((resolve) => {
      this.#resolveSettled = resolve;
    });
    this.drained = new Promise<void>((resolve) => {
      this.#resolveDrained = resolve;
    });
  }

  start(): void {
    this.#timer = setTimeout(() => {
      this.fail('external_timeout', 'connection');
    }, this.#endpoint.timeoutMs);

    if (this.#signal) {
      this.#abortListener = () => this.fail('cancelled', 'connection');
      this.#signal.addEventListener('abort', this.#abortListener, { once: true });
      if (this.#signal.aborted) {
        this.fail('cancelled', 'connection');
        return;
      }
    }

    const requestHeaders = this.#requestHeaders;
    const requestBody = this.#requestBody;
    if (!requestHeaders || !requestBody) {
      this.fail('external_transport_failed', 'request');
      return;
    }

    let clientRequest: ClientRequest;
    try {
      clientRequest = this.#owner.requestFor(this.#endpoint, requestHeaders);
    } catch {
      this.fail('external_transport_failed', 'connection');
      return;
    }

    this.#clientRequest = clientRequest;
    clientRequest.once('close', this.#onRequestClose);
    clientRequest.once('finish', this.#onRequestFinish);
    clientRequest.on('error', this.#onRequestError);
    clientRequest.on('response', this.#onRequestResponse);
    clientRequest.on('upgrade', this.#onRequestUpgrade);
    clientRequest.on('connect', this.#onRequestConnect);
    clientRequest.on('information', this.#onRequestInformation);

    this.writeRequestBody();
  }

  cancelForTransportClose(): void {
    this.fail('cancelled', 'connection');
  }

  /**
   * Writes incrementally so an early final response cannot be promoted before
   * the client has actually finished its entity. Backpressure also avoids
   * copying a 50 MiB body into Node's writable queue in one turn.
   */
  private writeRequestBody(): void {
    if (this.#settled || this.#requestEnded) {
      return;
    }
    const clientRequest = this.#clientRequest;
    const requestBody = this.#requestBody;
    if (!clientRequest || !requestBody) {
      this.fail('external_transport_failed', 'request');
      return;
    }

    if (this.#requestWriteOffset >= requestBody.byteLength) {
      this.#requestEnded = true;
      try {
        clientRequest.end();
      } catch {
        this.fail('external_transport_failed', 'request');
      }
      return;
    }

    const nextOffset = Math.min(
      this.#requestWriteOffset + REQUEST_WRITE_CHUNK_BYTES,
      requestBody.byteLength,
    );
    const chunk = requestBody.subarray(this.#requestWriteOffset, nextOffset);
    this.#requestWriteOffset = nextOffset;

    try {
      if (!clientRequest.write(chunk)) {
        clientRequest.once('drain', this.#onRequestDrain);
        return;
      }
    } catch {
      this.fail('external_transport_failed', 'request');
      return;
    }

    this.scheduleRequestWrite();
  }

  private scheduleRequestWrite(): void {
    if (this.#settled || this.#writeContinuation) {
      return;
    }
    this.#writeContinuation = setImmediate(() => {
      this.#writeContinuation = undefined;
      this.writeRequestBody();
    });
  }

  private receiveResponse(response: IncomingMessage): void {
    if (this.#settled) {
      response.on('error', IGNORE_LATE_ERROR);
      response.destroy();
      return;
    }
    if (this.#response) {
      this.fail('external_protocol_failed', 'response');
      response.on('error', IGNORE_LATE_ERROR);
      response.destroy();
      return;
    }

    this.#response = response;
    response.once('close', this.#onResponseClose);

    const statusCode = response.statusCode;
    this.#responseStatusCode = typeof statusCode === 'number' ? statusCode : undefined;
    if (
      typeof statusCode !== 'number' ||
      statusCode === 101 ||
      statusCode < 200 ||
      statusCode > 599
    ) {
      this.fail('external_protocol_failed', 'response');
      return;
    }
    if (statusCode >= 300 && statusCode < 400) {
      this.fail('external_transport_failed', 'response', statusCode);
      return;
    }

    const metadata = parseResponseMetadata(response.rawHeaders, this.#responseMode);
    if (!metadata) {
      this.fail('external_protocol_failed', 'response', statusCode);
      return;
    }

    const declaredLength = readDeclaredContentLength(response.rawHeaders);
    if (declaredLength !== undefined && declaredLength > MAX_EXTERNAL_HTTP_BODY_BYTES) {
      this.fail('external_response_too_large', 'response', statusCode);
      return;
    }

    this.#responseMetadata = metadata;
    this.#responseChunks = [];
    response.on('data', this.#onResponseData);
    response.once('end', this.#onResponseEnd);
    response.once('aborted', this.#onResponseAborted);
    response.on('error', this.#onResponseError);
  }

  private trySettleStagedResponse(): void {
    if (this.#settled || !this.#requestFinished || !this.#stagedResponse) {
      return;
    }

    const response = this.#stagedResponse;
    this.settle({
      ok: true,
      statusCode: response.statusCode,
      body: response.body,
      contentType: response.metadata.contentType,
      contentEncoding: response.metadata.contentEncoding,
      diagnostics: createDiagnostics(
        'response',
        this.#requestBodyBytes,
        this.#responseBodyBytes,
        response.statusCode,
      ),
    });
  }

  private fail(
    code: ExternalHttpTransportFailureCode,
    stage: ExternalHttpTransportStage,
    statusCode?: number,
  ): void {
    this.settle(
      createFailure(code, stage, this.#requestBodyBytes, this.#responseBodyBytes, statusCode),
    );
  }

  private settle(outcome: ExternalHttpTransportOutcome): void {
    if (this.#settled) {
      return;
    }
    this.#settled = true;
    this.clearTerminalWaiters();
    this.#resolveSettled(outcome);

    if (!outcome.ok) {
      this.#failureTerminal = true;
      // Never resume an unbounded rejected body. Destroying the response,
      // request, and its socket makes each failure path locally terminal.
      this.#response?.destroy();
      this.#clientRequest?.destroy();
      this.#clientRequest?.socket?.destroy();
      this.tryReleaseFailure();
      return;
    }

    this.release();
  }

  private clearTerminalWaiters(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#writeContinuation) {
      clearImmediate(this.#writeContinuation);
      this.#writeContinuation = undefined;
    }
    if (this.#signal && this.#abortListener) {
      this.#signal.removeEventListener('abort', this.#abortListener);
      this.#abortListener = undefined;
    }
  }

  private tryReleaseFailure(): void {
    if (!this.#failureTerminal || this.#drained) {
      return;
    }
    if (
      (this.#clientRequest === undefined || this.#requestClosed) &&
      (this.#response === undefined || this.#responseClosed)
    ) {
      this.release();
      return;
    }
    if (!this.#drainTimer) {
      // destroy() is normally followed by close. Do not make application
      // shutdown wait indefinitely if a defective peer never confirms it.
      this.#drainTimer = setTimeout(() => this.release(), HTTP_FAILURE_DRAIN_GRACE_MS);
    }
  }

  private release(): void {
    if (this.#drained) {
      return;
    }
    if (this.#drainTimer) {
      clearTimeout(this.#drainTimer);
      this.#drainTimer = undefined;
    }
    this.detachLocalResources();
    this.#drained = true;
    this.#owner.release(this);
    this.#resolveDrained();
  }

  private detachLocalResources(): void {
    const clientRequest = this.#clientRequest;
    if (clientRequest) {
      clientRequest.removeListener('close', this.#onRequestClose);
      clientRequest.removeListener('finish', this.#onRequestFinish);
      clientRequest.removeListener('drain', this.#onRequestDrain);
      clientRequest.removeListener('error', this.#onRequestError);
      clientRequest.removeListener('response', this.#onRequestResponse);
      clientRequest.removeListener('upgrade', this.#onRequestUpgrade);
      clientRequest.removeListener('connect', this.#onRequestConnect);
      clientRequest.removeListener('information', this.#onRequestInformation);
      clientRequest.on('error', IGNORE_LATE_ERROR);
      this.#clientRequest = undefined;
    }

    const response = this.#response;
    if (response) {
      response.removeListener('close', this.#onResponseClose);
      response.removeListener('data', this.#onResponseData);
      response.removeListener('end', this.#onResponseEnd);
      response.removeListener('aborted', this.#onResponseAborted);
      response.removeListener('error', this.#onResponseError);
      response.on('error', IGNORE_LATE_ERROR);
      this.#response = undefined;
    }

    this.#requestBody = undefined;
    this.#requestHeaders = undefined;
    this.#responseChunks = undefined;
    this.#responseMetadata = undefined;
    this.#stagedResponse = undefined;
  }
}

function completedExchange(outcome: ExternalHttpTransportFailure): ExternalHttpTransportExchange {
  return {
    settled: Promise.resolve(outcome),
    drained: Promise.resolve(),
  };
}

function prepareEndpoint(endpoint: ExternalHttpEndpointConfig): PreparedEndpoint | undefined {
  try {
    const url = new URL(endpoint.url);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.hostname.length === 0 ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0 ||
      !Number.isSafeInteger(endpoint.timeoutMs) ||
      endpoint.timeoutMs <= 0
    ) {
      return undefined;
    }
    const staticHeaders = prepareStaticHeaders(endpoint.headers);
    if (!staticHeaders) {
      return undefined;
    }
    return Object.freeze({ url, timeoutMs: endpoint.timeoutMs, staticHeaders });
  } catch {
    return undefined;
  }
}

function prepareStaticHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  const prepared: Record<string, string> = Object.create(null) as Record<string, string>;
  const seen = new Set<string>();

  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (
      seen.has(normalizedName) ||
      TRANSPORT_OWNED_HEADERS.has(normalizedName) ||
      !isValidHeader(name, value)
    ) {
      return undefined;
    }
    seen.add(normalizedName);
    prepared[name] = value;
  }

  return Object.freeze(prepared);
}

function isValidTransportRequest(request: ExternalHttpTransportRequest): boolean {
  if (
    !(request.body instanceof Uint8Array) ||
    typeof request.contentType !== 'string' ||
    !isValidHeader('Content-Type', request.contentType)
  ) {
    return false;
  }
  try {
    new MIMEType(request.contentType);
  } catch {
    return false;
  }
  return (
    request.responseMode === 'direct' ||
    request.responseMode === 'canonical-filter' ||
    request.responseMode === 'body-decoder'
  );
}

function buildRequestHeaders(
  staticHeaders: Readonly<Record<string, string>>,
  contentType: string,
  bodyBytes: number,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = Object.assign(
    Object.create(null) as Record<string, string>,
    staticHeaders,
  );
  headers['Content-Type'] = contentType;
  headers['Content-Length'] = String(bodyBytes);
  return Object.freeze(headers);
}

function isValidHeader(name: string, value: string): boolean {
  try {
    // Apply the same name/value policy Node uses when it writes the outgoing
    // request, while converting validation failures into a safe local result.
    validateHeaderName(name);
    validateHeaderValue(name, value);
    return true;
  } catch {
    return false;
  }
}

function parseResponseMetadata(
  rawHeaders: readonly string[],
  responseMode: ExternalHttpResponseMode,
): ResponseMetadata | undefined {
  const contentType = readSingleRawHeader(rawHeaders, 'content-type');
  const contentEncoding = readSingleRawHeader(rawHeaders, 'content-encoding');
  if (contentType === null || contentEncoding === null) {
    return undefined;
  }

  const normalizedContentType =
    contentType === undefined ? undefined : parseContentType(contentType);
  if (contentType !== undefined && normalizedContentType === undefined) {
    return undefined;
  }

  const normalizedContentEncoding =
    contentEncoding === undefined ? undefined : parseContentEncoding(contentEncoding);
  if (normalizedContentEncoding === null) {
    return undefined;
  }

  if (responseMode === 'direct' || responseMode === 'canonical-filter') {
    if (!normalizedContentType || !isUtf8JsonContentType(normalizedContentType)) {
      return undefined;
    }
    if (normalizedContentEncoding !== undefined && normalizedContentEncoding !== 'identity') {
      return undefined;
    }
  }

  return Object.freeze({
    contentType: normalizedContentType,
    contentEncoding: normalizedContentEncoding,
  });
}

/** Returns null for invalid/duplicate fields and undefined when the field is absent. */
function readSingleRawHeader(
  rawHeaders: readonly string[],
  expectedName: string,
): string | undefined | null {
  let value: string | undefined;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const rawValue = rawHeaders[index + 1];
    if (name === undefined || rawValue === undefined || name.toLowerCase() !== expectedName) {
      continue;
    }
    if (value !== undefined || !isValidHeader(name, rawValue)) {
      return null;
    }
    value = rawValue;
  }
  return value;
}

function parseContentType(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || hasRepeatedMediaTypeParameter(trimmed)) {
    return undefined;
  }
  try {
    new MIMEType(trimmed);
    return trimmed;
  } catch {
    return undefined;
  }
}

function hasRepeatedMediaTypeParameter(value: string): boolean {
  const parameters = splitOutsideQuotedString(value, ';');
  if (parameters.length === 0) {
    return true;
  }

  const seen = new Set<string>();
  for (let index = 1; index < parameters.length; index++) {
    const parameter = parameters[index]?.trim();
    if (!parameter) {
      return true;
    }
    const equalsIndex = parameter.indexOf('=');
    if (equalsIndex <= 0) {
      return true;
    }
    const name = parameter.slice(0, equalsIndex).trim().toLowerCase();
    if (!HTTP_TOKEN_RE.test(name) || seen.has(name)) {
      return true;
    }
    seen.add(name);
  }
  return false;
}

function splitOutsideQuotedString(value: string, delimiter: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  if (quoted || escaped) {
    return [];
  }
  parts.push(value.slice(start));
  return parts;
}

function isUtf8JsonContentType(value: string): boolean {
  try {
    const mimeType = new MIMEType(value);
    if (mimeType.essence.toLowerCase() !== 'application/json') {
      return false;
    }
    const charset = mimeType.params.get('charset');
    return charset === null || charset.toLowerCase() === 'utf-8';
  } catch {
    return false;
  }
}

/** Returns undefined for a present-but-empty Content-Encoding field. */
function parseContentEncoding(value: string): string | undefined | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const codings = trimmed.split(',').map((item) => item.trim());
  if (codings.some((coding) => coding.length === 0 || !HTTP_TOKEN_RE.test(coding))) {
    return null;
  }
  return codings.map((coding) => coding.toLowerCase()).join(', ');
}

function readDeclaredContentLength(rawHeaders: readonly string[]): number | undefined {
  const header = readSingleRawHeader(rawHeaders, 'content-length');
  if (header === null || header === undefined) {
    return undefined;
  }
  const trimmed = header.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return undefined;
  }
  const length = Number(trimmed);
  return Number.isSafeInteger(length) ? length : undefined;
}

function createFailure(
  code: ExternalHttpTransportFailureCode,
  stage: ExternalHttpTransportStage,
  requestBodyBytes: number,
  responseBodyBytes: number,
  statusCode?: number,
): ExternalHttpTransportFailure {
  return Object.freeze({
    ok: false as const,
    code,
    message: FAILURE_MESSAGES[code],
    diagnostics: createDiagnostics(stage, requestBodyBytes, responseBodyBytes, statusCode),
  });
}

function createDiagnostics(
  stage: ExternalHttpTransportStage,
  requestBodyBytes: number,
  responseBodyBytes: number,
  statusCode?: number,
): ExternalHttpTransportDiagnostics {
  return Object.freeze(
    statusCode === undefined
      ? { stage, requestBodyBytes, responseBodyBytes }
      : { stage, requestBodyBytes, responseBodyBytes, statusCode },
  );
}
