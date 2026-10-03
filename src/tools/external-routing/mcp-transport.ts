import type {
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  JSONRPCResponse,
  RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  FetchLike,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MAX_LATE_RESPONSE_TOMBSTONES = 1_024;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

export interface TrackedMcpExchange {
  readonly requestId: RequestId;
  readonly drained: Promise<void>;
  readonly rawContentPresent: boolean;
  readonly responseSeen: boolean;
  readonly transportFailed: boolean;
  readonly protocolFailed: boolean;
  markCallerSettled(): void;
}

interface MutableTrackedMcpExchange extends TrackedMcpExchange {
  rawContentPresent: boolean;
  responseSeen: boolean;
  transportFailed: boolean;
  protocolFailed: boolean;
  requestHttpResponseStarted: boolean;
  callerSettled: boolean;
  pendingLifecycles: number;
  readonly drain: Deferred<void>;
  terminalBodyFailure: boolean;
}

export interface TrackedMcpTransportHooks {
  readonly onRequestBodyTerminated?: (requestId: RequestId) => void;
  readonly onSharedStreamTerminated?: () => void;
  readonly onTransportFailure?: (requestId: RequestId | undefined) => void;
  readonly onProtocolError?: () => void;
}

/**
 * Observes SDK-owned JSON-RPC correlation while delegating all MCP protocol and
 * Streamable HTTP behavior to the official transport.
 */
export class TrackedMcpTransport implements Transport {
  readonly #delegate: Transport;
  readonly #hooks: TrackedMcpTransportHooks;
  readonly #exchanges = new Map<RequestId, MutableTrackedMcpExchange>();
  readonly #settledRequestIds = new Set<RequestId>();
  #registration: ((exchange: MutableTrackedMcpExchange) => void) | undefined;
  #onclose: (() => void) | undefined;
  #onerror: ((error: Error) => void) | undefined;
  #onmessage: Transport['onmessage'];

  constructor(delegate: Transport, hooks: TrackedMcpTransportHooks = {}) {
    this.#delegate = delegate;
    this.#hooks = hooks;
    delegate.onclose = () => {
      this.#failAllOpenExchanges();
      this.#onclose?.();
    };
    delegate.onerror = (error) => {
      if (isProtocolParseError(error)) {
        for (const exchange of this.#exchanges.values()) exchange.protocolFailed = true;
        this.#hooks.onProtocolError?.();
      }
      this.#onerror?.(error);
    };
    delegate.onmessage = (message, extra) => this.#handleMessage(message, extra);
  }

  get sessionId(): string | undefined {
    return this.#delegate.sessionId;
  }

  get onclose(): (() => void) | undefined {
    return this.#onclose;
  }

  set onclose(handler: (() => void) | undefined) {
    this.#onclose = handler;
  }

  get onerror(): ((error: Error) => void) | undefined {
    return this.#onerror;
  }

  set onerror(handler: ((error: Error) => void) | undefined) {
    this.#onerror = handler;
  }

  get onmessage(): Transport['onmessage'] {
    return this.#onmessage;
  }

  set onmessage(handler: Transport['onmessage']) {
    this.#onmessage = handler;
  }

  setProtocolVersion(version: string): void {
    this.#delegate.setProtocolVersion?.(version);
  }

  start(): Promise<void> {
    return this.#delegate.start();
  }

  async close(): Promise<void> {
    try {
      await this.#delegate.close();
    } finally {
      this.#failAllOpenExchanges();
    }
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const request = asToolCallRequest(message);
    if (request !== undefined) {
      const exchange = this.#createExchange(request.id);
      this.#registration?.(exchange);
    }

    const requestExchange = request === undefined ? undefined : this.#exchanges.get(request.id);
    const finishRequestSend =
      requestExchange === undefined ? undefined : this.#attachLifecycle(requestExchange);
    const cancellationId = getCancellationRequestId(message);
    const cancellationExchange =
      cancellationId === undefined ? undefined : this.#exchanges.get(cancellationId);
    const finishCancellationSend =
      cancellationExchange === undefined ? undefined : this.#attachLifecycle(cancellationExchange);

    let sent: Promise<void>;
    try {
      sent = this.#delegate.send(message, options);
    } catch (error: unknown) {
      finishRequestSend?.();
      finishCancellationSend?.();
      if (request !== undefined) {
        this.#markTransportFailure(request.id);
      } else if (cancellationId !== undefined && isSessionInvalidError(error)) {
        this.#markTransportFailure(cancellationId);
      }
      throw error;
    }
    void sent.then(
      () => {
        finishRequestSend?.();
        finishCancellationSend?.();
      },
      (error: unknown) => {
        finishRequestSend?.();
        finishCancellationSend?.();
        if (requestExchange?.requestHttpResponseStarted === true) {
          requestExchange.protocolFailed = true;
          this.#hooks.onProtocolError?.();
        } else if (request !== undefined) {
          this.#markTransportFailure(request.id);
        } else if (cancellationId !== undefined && isSessionInvalidError(error)) {
          this.#markTransportFailure(cancellationId);
        }
      },
    );
    return sent;
  }

  /** Captures the request synchronously emitted by one `Client.callTool()` call. */
  captureCall<T>(start: () => Promise<T>): {
    readonly result: Promise<T>;
    readonly exchange: TrackedMcpExchange;
  } {
    if (this.#registration !== undefined) {
      throw new Error('Nested MCP call registration is not supported.');
    }
    let captured: MutableTrackedMcpExchange | undefined;
    this.#registration = (exchange) => {
      captured = exchange;
    };
    let result: Promise<T>;
    try {
      result = start();
    } finally {
      this.#registration = undefined;
    }
    if (captured === undefined) {
      throw new Error('MCP Client did not synchronously send a tools/call request.');
    }
    return { result, exchange: captured };
  }

  createFetch(baseFetch: FetchLike = globalThis.fetch): FetchLike {
    return async (url, init) => {
      const bodyMessage = parseOutboundBody(init?.body);
      const requestId = getToolCallRequestId(bodyMessage);
      const cancellationId = getCancellationRequestId(bodyMessage);
      const exchange =
        requestId === undefined
          ? cancellationId === undefined
            ? undefined
            : this.#exchanges.get(cancellationId)
          : this.#exchanges.get(requestId);
      const finishBody = exchange === undefined ? undefined : this.#attachLifecycle(exchange);

      let response: Response;
      try {
        response = await baseFetch(url, {
          ...init,
          redirect: 'error',
        });
      } catch (error: unknown) {
        finishBody?.();
        if (init?.method === 'GET') this.#hooks.onSharedStreamTerminated?.();
        if (requestId !== undefined) this.#markTransportFailure(requestId);
        throw error;
      }

      if (exchange !== undefined && requestId !== undefined && response.ok) {
        exchange.requestHttpResponseStarted = true;
      }
      if (init?.method === 'GET') {
        const sharedSse =
          response.ok &&
          response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') ===
            true;
        if (!sharedSse && response.status !== 405) {
          this.#hooks.onSharedStreamTerminated?.();
        }
        return sharedSse
          ? wrapResponseBody(response, () => this.#hooks.onSharedStreamTerminated?.())
          : response;
      }
      if (finishBody === undefined) {
        return response;
      }
      return wrapResponseBody(response, () => {
        finishBody();
        if (requestId === undefined || exchange === undefined) return;
        if (
          response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') !==
          true
        )
          return;

        // The SDK's decoder/parser pipeline may publish the final SSE event one
        // turn after the wrapped source observes EOF. Recheck after that turn
        // before treating an event-less stream end as terminal.
        setTimeout(() => {
          if (exchange.responseSeen || exchange.callerSettled) return;
          exchange.terminalBodyFailure = true;
          exchange.transportFailed = true;
          this.#hooks.onRequestBodyTerminated?.(requestId);
        }, 0);
      });
    };
  }

  #createExchange(requestId: RequestId): MutableTrackedMcpExchange {
    const drain = deferred<void>();
    const exchange: MutableTrackedMcpExchange = {
      requestId,
      drained: drain.promise,
      drain,
      rawContentPresent: false,
      responseSeen: false,
      transportFailed: false,
      protocolFailed: false,
      requestHttpResponseStarted: false,
      terminalBodyFailure: false,
      callerSettled: false,
      pendingLifecycles: 0,
      markCallerSettled: () => {
        exchange.callerSettled = true;
        this.#finishIfDrained(exchange);
      },
    };
    this.#exchanges.set(requestId, exchange);
    return exchange;
  }

  #handleMessage<T extends JSONRPCMessage>(
    message: T,
    extra?: Parameters<NonNullable<Transport['onmessage']>>[1],
  ): void {
    if (isResponse(message) && message.id !== undefined) {
      const exchange = this.#exchanges.get(message.id);
      if (exchange === undefined && this.#settledRequestIds.delete(message.id)) {
        return;
      }
      if (exchange !== undefined) {
        exchange.responseSeen = true;
        exchange.rawContentPresent = hasOwnResultContent(message);
        if (exchange.callerSettled) {
          return;
        }
      }
    }
    this.#onmessage?.(message, extra);
  }

  #attachLifecycle(exchange: MutableTrackedMcpExchange): () => void {
    exchange.pendingLifecycles++;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      exchange.pendingLifecycles = Math.max(0, exchange.pendingLifecycles - 1);
      this.#finishIfDrained(exchange);
    };
  }

  #finishIfDrained(exchange: MutableTrackedMcpExchange): void {
    if (!exchange.callerSettled || exchange.pendingLifecycles !== 0) return;
    if (this.#exchanges.get(exchange.requestId) === exchange) {
      this.#exchanges.delete(exchange.requestId);
    }
    if (!exchange.responseSeen) {
      this.#settledRequestIds.add(exchange.requestId);
      if (this.#settledRequestIds.size > MAX_LATE_RESPONSE_TOMBSTONES) {
        // Dropping an ID would allow a later payload to reach the SDK after its
        // handler was removed. Replace the session instead and clear all state.
        void this.close().catch(() => undefined);
      }
    }
    exchange.drain.resolve();
  }

  #markTransportFailure(requestId: RequestId | undefined): void {
    const exchange = requestId === undefined ? undefined : this.#exchanges.get(requestId);
    if (exchange !== undefined) exchange.transportFailed = true;
    this.#hooks.onTransportFailure?.(requestId);
  }

  #failAllOpenExchanges(): void {
    for (const exchange of this.#exchanges.values()) {
      exchange.transportFailed = true;
      exchange.pendingLifecycles = 0;
      exchange.callerSettled = true;
      exchange.drain.resolve();
    }
    this.#exchanges.clear();
    this.#settledRequestIds.clear();
  }
}

function isProtocolParseError(error: Error): boolean {
  return error instanceof SyntaxError || error.name === 'ZodError';
}

function isSessionInvalidError(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

function parseOutboundBody(body: BodyInit | null | undefined): JSONRPCMessage | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return value as JSONRPCMessage;
  } catch {
    return undefined;
  }
}

function asToolCallRequest(message: JSONRPCMessage): JSONRPCRequest | undefined {
  if ('method' in message && 'id' in message && message.method === 'tools/call') {
    return message as JSONRPCRequest;
  }
  return undefined;
}

function getToolCallRequestId(message: JSONRPCMessage | undefined): RequestId | undefined {
  return message === undefined ? undefined : asToolCallRequest(message)?.id;
}

function getCancellationRequestId(message: JSONRPCMessage | undefined): RequestId | undefined {
  if (
    message === undefined ||
    !('method' in message) ||
    message.method !== 'notifications/cancelled'
  ) {
    return undefined;
  }
  const params = (message as JSONRPCNotification).params as Record<string, unknown> | undefined;
  const requestId = params?.requestId;
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : undefined;
}

function isResponse(message: JSONRPCMessage): message is JSONRPCResponse {
  return 'id' in message && !('method' in message);
}

function hasOwnResultContent(message: JSONRPCResponse): boolean {
  if (!('result' in message) || typeof message.result !== 'object' || message.result === null) {
    return false;
  }
  return (
    Object.hasOwn(message.result, 'content') &&
    Array.isArray((message.result as Record<string, unknown>).content)
  );
}

function wrapResponseBody(response: Response, onFinished: () => void): Response {
  if (response.body === null) {
    onFinished();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    onFinished();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error: unknown) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
