import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isToolCallResult } from '../../runtime/invocation/tool-result-validation.js';
import type { ToolCallResult } from '../types.js';
import type { ExternalMcpServerConfig } from './config.js';
import { TrackedMcpTransport, type TrackedMcpExchange } from './mcp-transport.js';

const RECONNECTION_OPTIONS = Object.freeze({
  initialReconnectionDelay: 1_000,
  maxReconnectionDelay: 30_000,
  reconnectionDelayGrowFactor: 1.5,
  maxRetries: 0,
});
const TERMINATE_SESSION_TIMEOUT_MS = 5_000;

export type McpFailureCode =
  | 'mcp_connection_failed'
  | 'mcp_capability_missing'
  | 'mcp_call_failed'
  | 'mcp_timeout'
  | 'mcp_protocol_failed'
  | 'mcp_result_unsupported'
  | 'mcp_transport_failed'
  | 'external_internal_failed'
  | 'cancelled';

export type McpCallOutcome =
  | { readonly kind: 'result'; readonly result: ToolCallResult }
  | { readonly kind: 'failure'; readonly code: McpFailureCode };

export interface McpCallExchange {
  readonly settled: Promise<McpCallOutcome>;
  readonly drained: Promise<void>;
}

export interface McpConnectionDiagnostic {
  readonly server: string;
  readonly outcome: 'connected' | 'failed';
  readonly phase: 'connect' | 'initialize' | 'capability' | 'call' | 'shutdown';
  readonly classification?: McpFailureCode;
  readonly durationMs: number;
}

export interface McpConnectionManagerOptions {
  readonly fetch?: FetchLike;
  readonly onDiagnostic?: (diagnostic: McpConnectionDiagnostic) => void | Promise<void>;
}

type ManagerState = 'idle' | 'connecting' | 'ready' | 'closing' | 'closed';

interface ReadyConnection {
  readonly client: Client;
  readonly transport: TrackedMcpTransport;
  readonly baseTransport: StreamableHTTPClientTransport;
  readonly controllersByRequestId: Map<string | number, AbortController>;
}

interface ConnectingAttempt {
  readonly promise: Promise<ReadyConnection>;
  transport?: TrackedMcpTransport;
  baseTransport?: StreamableHTTPClientTransport;
}

/** Workspace-owned single-flight MCP Client/session for one server identity. */
export class McpConnectionManager {
  readonly #server: ExternalMcpServerConfig;
  readonly #fetch: FetchLike;
  readonly #onDiagnostic: McpConnectionManagerOptions['onDiagnostic'];
  #state: ManagerState = 'idle';
  #connecting: ConnectingAttempt | undefined;
  #ready: ReadyConnection | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(server: ExternalMcpServerConfig, options: McpConnectionManagerOptions = {}) {
    this.#server = server;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#onDiagnostic = options.onDiagnostic;
  }

  get serverIdentity(): string {
    return safeEndpointIdentity(this.#server.url);
  }

  warmUp(): Promise<void> {
    return this.#ensureConnected()
      .then(() => undefined)
      .catch(() => undefined);
  }

  callTool(options: {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): McpCallExchange {
    const startedAt = Date.now();
    let trackedExchange: TrackedMcpExchange | undefined;
    const operation = this.#ensureConnected(options.signal)
      .then((connection) => {
        if (options.signal?.aborted === true) {
          return { kind: 'failure' as const, code: 'cancelled' as const };
        }
        const controller = new AbortController();
        const relayAbort = (): void => controller.abort(options.signal?.reason);
        options.signal?.addEventListener('abort', relayAbort, { once: true });
        if (options.signal?.aborted) relayAbort();

        let captured: { readonly result: Promise<unknown>; readonly exchange: TrackedMcpExchange };
        try {
          captured = connection.transport.captureCall(() =>
            connection.client.callTool(
              { name: options.name, arguments: options.arguments },
              undefined,
              {
                signal: controller.signal,
                timeout: this.#server.timeoutMs,
                resetTimeoutOnProgress: false,
              },
            ),
          );
        } catch {
          options.signal?.removeEventListener('abort', relayAbort);
          return { kind: 'failure' as const, code: 'external_internal_failed' as const };
        }
        trackedExchange = captured.exchange;
        connection.controllersByRequestId.set(captured.exchange.requestId, controller);

        return captured.result
          .then(
            (candidate: unknown) => this.#mapResult(candidate, captured.exchange),
            (error: unknown) => this.#mapCallFailure(error, controller.signal, captured.exchange),
          )
          .finally(() => {
            options.signal?.removeEventListener('abort', relayAbort);
            connection.controllersByRequestId.delete(captured.exchange.requestId);
            captured.exchange.markCallerSettled();
          });
      })
      .then((outcome) => outcome)
      .catch((error: unknown): McpCallOutcome => ({
        kind: 'failure',
        code: options.signal?.aborted === true ? 'cancelled' : classifyConnectionFailure(error),
      }));
    const settled = operation.then((outcome) => {
      if (outcome.kind === 'failure') {
        this.#report({
          server: this.serverIdentity,
          outcome: 'failed',
          phase: 'call',
          classification: outcome.code,
          durationMs: Date.now() - startedAt,
        });
      }
      return outcome;
    });

    const drained = settled.then(async () => {
      if (trackedExchange !== undefined) {
        await trackedExchange.drained;
      }
    });
    return Object.freeze({ settled, drained });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#state = 'closing';
    this.#closePromise = this.#closeInternal();
    return this.#closePromise;
  }

  async #ensureConnected(signal?: AbortSignal): Promise<ReadyConnection> {
    if (this.#state === 'closing' || this.#state === 'closed') {
      throw new Error('MCP connection manager is closed.');
    }
    if (this.#ready !== undefined) return waitForCaller(this.#ready, signal);
    if (this.#connecting === undefined) {
      const attempt: ConnectingAttempt = { promise: Promise.resolve(undefined as never) };
      const promise = this.#connect(attempt);
      Object.assign(attempt, { promise });
      this.#connecting = attempt;
      this.#state = 'connecting';
    }
    return waitForCaller(this.#connecting.promise, signal);
  }

  async #connect(attempt: ConnectingAttempt): Promise<ReadyConnection> {
    const startedAt = Date.now();
    const controllersByRequestId = new Map<string | number, AbortController>();
    let sharedStreamTerminated = false;
    let protocolFailed = false;
    const proxyFetch: FetchLike = (url, init) => ownedFetch(url, init);
    const baseTransport = new StreamableHTTPClientTransport(new URL(this.#server.url), {
      requestInit: { headers: this.#server.headers },
      fetch: proxyFetch,
      reconnectionOptions: RECONNECTION_OPTIONS,
    });
    const tracked: TrackedMcpTransport = new TrackedMcpTransport(baseTransport, {
      onRequestBodyTerminated: (requestId) => controllersByRequestId.get(requestId)?.abort(),
      onSharedStreamTerminated: () => {
        sharedStreamTerminated = true;
        this.#invalidateConnection(tracked);
      },
      onTransportFailure: () => this.#invalidateConnection(tracked),
      onProtocolError: () => {
        protocolFailed = true;
        this.#invalidateConnection(tracked);
      },
    });
    const ownedFetch: FetchLike = tracked.createFetch(this.#fetch);
    attempt.transport = tracked;
    attempt.baseTransport = baseTransport;
    const client = new Client(
      { name: 'custom-mcp-external-routing', version: '1' },
      { capabilities: {} },
    );
    const connection: ReadyConnection = {
      client,
      transport: tracked,
      baseTransport,
      controllersByRequestId,
    };

    try {
      await withDeadline(
        client.connect(tracked, { timeout: this.#server.timeoutMs }),
        this.#server.timeoutMs,
        () => tracked.close(),
      );
      if (sharedStreamTerminated || protocolFailed) {
        await tracked.close().catch(() => undefined);
        throw new Error('Downstream shared SSE stream failed during connection.');
      }
      if (client.getServerCapabilities()?.tools === undefined) {
        await tracked.close().catch(() => undefined);
        throw new McpCapabilityMissingError();
      }
      if (this.#state === 'closing' || this.#state === 'closed') {
        await tracked.close().catch(() => undefined);
        throw new Error('MCP connection manager closed during connect.');
      }
      const clientOnClose = tracked.onclose;
      tracked.onclose = () => {
        clientOnClose?.();
        this.#invalidateConnection(tracked);
      };
      this.#ready = connection;
      this.#state = 'ready';
      this.#report({
        server: this.serverIdentity,
        outcome: 'connected',
        phase: 'connect',
        durationMs: Date.now() - startedAt,
      });
      return connection;
    } catch (error: unknown) {
      await tracked.close().catch(() => undefined);
      if (this.#state !== 'closing' && this.#state !== 'closed') this.#state = 'idle';
      this.#report({
        server: this.serverIdentity,
        outcome: 'failed',
        phase: error instanceof McpCapabilityMissingError ? 'capability' : 'initialize',
        classification: classifyConnectionFailure(error),
        durationMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      if (this.#connecting === attempt) this.#connecting = undefined;
    }
  }

  #mapResult(candidate: unknown, exchange: TrackedMcpExchange): McpCallOutcome {
    if (!exchange.rawContentPresent) {
      this.#invalidateReadyForProtocolFailure();
      return { kind: 'failure', code: 'mcp_protocol_failed' };
    }
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      this.#invalidateReadyForProtocolFailure();
      return { kind: 'failure', code: 'mcp_protocol_failed' };
    }
    const normalized = {
      ...(candidate as Record<string, unknown>),
      isError: (candidate as Record<string, unknown>).isError === true,
    };
    if (isToolCallResult(normalized)) {
      return { kind: 'result', result: normalized };
    }
    const content = (candidate as Record<string, unknown>).content;
    if (
      Array.isArray(content) &&
      content.some(
        (block) =>
          typeof block === 'object' &&
          block !== null &&
          !['text', 'image'].includes(String((block as Record<string, unknown>).type)),
      )
    ) {
      return { kind: 'failure', code: 'mcp_result_unsupported' };
    }
    this.#invalidateReadyForProtocolFailure();
    return { kind: 'failure', code: 'mcp_protocol_failed' };
  }

  #mapCallFailure(
    error: unknown,
    signal: AbortSignal,
    exchange: TrackedMcpExchange,
  ): McpCallOutcome {
    if (signal.aborted) {
      if (exchange.protocolFailed) {
        this.#invalidateReadyForProtocolFailure();
        return { kind: 'failure', code: 'mcp_protocol_failed' };
      }
      return {
        kind: 'failure',
        code: exchange.transportFailed ? 'mcp_transport_failed' : 'cancelled',
      };
    }
    if (
      error instanceof McpError &&
      error.code === ErrorCode.RequestTimeout &&
      !exchange.responseSeen
    ) {
      return { kind: 'failure', code: 'mcp_timeout' };
    }
    if (exchange.protocolFailed) {
      this.#invalidateReadyForProtocolFailure();
      return { kind: 'failure', code: 'mcp_protocol_failed' };
    }
    if (exchange.transportFailed || error instanceof StreamableHTTPError) {
      this.#invalidateReadyForTransportFailure();
      return { kind: 'failure', code: 'mcp_transport_failed' };
    }
    if (error instanceof McpError) {
      return { kind: 'failure', code: 'mcp_call_failed' };
    }
    this.#invalidateReadyForProtocolFailure();
    return { kind: 'failure', code: 'mcp_protocol_failed' };
  }

  #invalidateReadyForProtocolFailure(): void {
    const ready = this.#ready;
    if (ready !== undefined) this.#invalidateConnection(ready.transport);
  }

  #invalidateReadyForTransportFailure(): void {
    const ready = this.#ready;
    if (ready !== undefined) this.#invalidateConnection(ready.transport);
  }

  #invalidateConnection(transport: TrackedMcpTransport): void {
    if (this.#ready?.transport !== transport) return;
    const ready = this.#ready;
    this.#ready = undefined;
    if (this.#state !== 'closing' && this.#state !== 'closed') this.#state = 'idle';
    for (const controller of ready.controllersByRequestId.values()) controller.abort();
    void ready.client.close().catch(() => undefined);
  }

  async #closeInternal(): Promise<void> {
    const connecting = this.#connecting;
    const ready = this.#ready;
    this.#ready = undefined;

    const tasks: Promise<unknown>[] = [];
    if (connecting?.transport !== undefined) {
      tasks.push(connecting.transport.close());
    }
    if (connecting !== undefined) {
      tasks.push(connecting.promise.catch(() => undefined));
    }
    if (ready !== undefined) {
      for (const controller of ready.controllersByRequestId.values()) controller.abort();
      tasks.push(this.#terminateAndClose(ready));
    }
    await Promise.allSettled(tasks);
    this.#state = 'closed';
  }

  async #terminateAndClose(connection: ReadyConnection): Promise<void> {
    const startedAt = Date.now();
    try {
      await withDeadline(
        connection.baseTransport.terminateSession(),
        TERMINATE_SESSION_TIMEOUT_MS,
        () => connection.transport.close(),
      );
    } catch {
      this.#report({
        server: this.serverIdentity,
        outcome: 'failed',
        phase: 'shutdown',
        classification: 'mcp_transport_failed',
        durationMs: Date.now() - startedAt,
      });
    } finally {
      await connection.client.close().catch(() => undefined);
      await connection.transport.close().catch(() => undefined);
    }
  }

  #report(diagnostic: McpConnectionDiagnostic): void {
    try {
      void Promise.resolve(this.#onDiagnostic?.(Object.freeze(diagnostic))).catch(() => undefined);
    } catch {
      // Diagnostics never participate in connection or cleanup control flow.
    }
  }
}

class McpCapabilityMissingError extends Error {}

function classifyConnectionFailure(error: unknown): McpFailureCode {
  if (error instanceof McpCapabilityMissingError) return 'mcp_capability_missing';
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return 'mcp_timeout';
  return 'mcp_connection_failed';
}

function waitForCaller<T>(promise: Promise<T> | T, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Cancelled'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      operation();
    };
    const abort = (): void => finish(() => reject(signal.reason ?? new Error('Cancelled')));
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve(promise).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void> | void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new McpError(ErrorCode.RequestTimeout, 'MCP operation timed out.'));
      void Promise.resolve(onTimeout()).catch(() => undefined);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void operation.catch(() => undefined);
  }
}

function safeEndpointIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return 'unavailable';
  }
}
