import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';

/** Observes only the public send boundary for one validated initialize request. */
export class InitializationTrackingTransport extends StreamableHTTPServerTransport {
  #requestId: RequestId | undefined;
  #state: 'idle' | 'sending' | 'succeeded' | 'failed' | 'stopped' = 'idle';
  readonly #settled: Promise<boolean>;
  #resolveSettled!: (succeeded: boolean) => void;
  /** A rejected send need not finish HTTP, so the entry must observe it independently. */
  readonly initializationSendRejected: Promise<void>;
  #resolveSendRejected!: () => void;

  constructor(options: StreamableHTTPServerTransportOptions, requestId?: RequestId) {
    super(options);
    this.#requestId = requestId;
    this.#settled = new Promise((resolve) => { this.#resolveSettled = resolve; });
    this.initializationSendRejected = new Promise((resolve) => { this.#resolveSendRejected = resolve; });
  }

  override async send(
    message: JSONRPCMessage,
    options?: Parameters<StreamableHTTPServerTransport['send']>[1],
  ): Promise<void> {
    const observed = this.#state === 'idle'
      && this.#requestId !== undefined
      && 'id' in message && message.id === this.#requestId
      && ('result' in message || 'error' in message);
    if (observed) {
      this.#state = 'sending';
    }
    try {
      await super.send(message, options);
      if (observed && this.#state === 'sending') {
        const succeeded = 'result' in message;
        this.#state = succeeded ? 'succeeded' : 'failed';
        this.#resolveSettled(succeeded);
      }
    } catch (error: unknown) {
      if (observed && this.#state === 'sending') {
        this.#state = 'failed';
        this.#resolveSettled(false);
        this.#resolveSendRejected();
      }
      throw error;
    }
  }

  /** At HTTP completion, no started send means protocol rejection, not a wait. */
  waitForInitialization(): Promise<boolean> {
    return this.#state === 'idle' || this.#state === 'stopped'
      ? Promise.resolve(false)
      : this.#settled;
  }

  stopInitializationTracking(): void {
    this.#requestId = undefined;
    this.#state = 'stopped';
    this.#resolveSettled(false);
  }
}
