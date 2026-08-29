import type { Server as HttpServer } from 'node:http';
import type { McpPostSession } from './mcp-post-handler.js';

export interface ApplicationLifecycleClosable {
  close(): Promise<void> | void;
}

export interface ApplicationLifecycleOptions {
  /**
   * The listener returned by `app.listen()`. Closing it stops network-level
   * admission before application-owned resources begin to drain.
   */
  readonly listener: HttpServer;
  readonly sessions: Map<string, McpPostSession>;
  readonly androidRuntime: ApplicationLifecycleClosable;
  readonly externalRuntime: ApplicationLifecycleClosable;
  readonly logger: ApplicationLifecycleClosable;
}

export type ApplicationShutdownPhase =
  | 'http-listener'
  | 'mcp-session'
  | 'android-runtime'
  | 'external-runtime'
  | 'logger';

export interface ApplicationShutdownFailure {
  readonly phase: ApplicationShutdownPhase;
  readonly error: unknown;
  readonly sessionId?: string;
}

/**
 * Reports every shutdown failure after all remaining shutdown stages have had
 * an opportunity to run.
 */
export class ApplicationLifecycleCloseError extends AggregateError {
  readonly failures: readonly ApplicationShutdownFailure[];

  constructor(failures: readonly ApplicationShutdownFailure[]) {
    super(
      failures.map((failure) => failure.error),
      `Application shutdown failed in ${failures.length} stage(s).`,
    );
    this.name = 'ApplicationLifecycleCloseError';
    this.failures = Object.freeze([...failures]);
  }
}

const CLOSED_SESSION = Promise.resolve();

/**
 * Owns production shutdown ordering without owning request routing itself.
 *
 * Route handlers should reject new session creation once
 * `isAcceptingNewSessions` becomes false. This protects the small interval in
 * which an already accepted HTTP connection can still reach application code
 * after the HTTP listener has stopped accepting new connections.
 */
export class ApplicationLifecycle {
  readonly #listener: HttpServer;
  readonly #sessions: Map<string, McpPostSession>;
  readonly #androidRuntime: ApplicationLifecycleClosable;
  readonly #externalRuntime: ApplicationLifecycleClosable;
  readonly #logger: ApplicationLifecycleClosable;
  readonly #sessionClosePromises = new Map<string, Promise<void>>();
  #applicationClosePromise: Promise<void> | undefined;

  constructor(options: ApplicationLifecycleOptions) {
    this.#listener = options.listener;
    this.#sessions = options.sessions;
    this.#androidRuntime = options.androidRuntime;
    this.#externalRuntime = options.externalRuntime;
    this.#logger = options.logger;
  }

  get isAcceptingNewSessions(): boolean {
    return this.#applicationClosePromise === undefined;
  }

  /**
   * Closes one protocol session without shutting down the complete
   * application. Repeated concurrent calls for the same session share work.
   */
  closeSession(sessionId: string): Promise<void> {
    const inFlight = this.#sessionClosePromises.get(sessionId);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return CLOSED_SESSION;
    }

    // Deferring execution records the promise before server.close() can
    // synchronously trigger a transport onclose callback that re-enters here.
    const closePromise = Promise.resolve()
      .then(() => this.#closeSession(sessionId, session));
    this.#sessionClosePromises.set(sessionId, closePromise);
    return closePromise;
  }

  /**
   * Stops listener admission, starts Android cancellation before MCP session
   * drain, then closes the external runtime and logging. Every caller receives
   * the same promise.
   */
  close(): Promise<void> {
    if (this.#applicationClosePromise === undefined) {
      this.#applicationClosePromise = this.#closeApplication();
    }
    return this.#applicationClosePromise;
  }

  async #closeSession(
    sessionId: string,
    session: McpPostSession,
  ): Promise<void> {
    try {
      // The MCP SDK Server closes its connected Streamable HTTP transport,
      // which aborts in-flight protocol work without calling transport.close()
      // a second time.
      await session.server.close();
    } finally {
      // A transport onclose handler may already have removed this mapping. Do
      // not delete a replacement session should an implementation reuse an id.
      if (this.#sessions.get(sessionId) === session) {
        this.#sessions.delete(sessionId);
      }
      this.#sessionClosePromises.delete(sessionId);
    }
  }

  async #closeApplication(): Promise<void> {
    const failures: ApplicationShutdownFailure[] = [];

    // Invoke close immediately to stop new TCP admission, but wait for its
    // connection drain only after MCP session closure can release long-lived
    // HTTP streams.
    const listenerClose = this.#closeListener();
    void listenerClose.catch(() => {});
    const androidRuntimeClose = Promise.resolve()
      .then(() => this.#androidRuntime.close());
    void androidRuntimeClose.catch(() => {});

    await this.#closeAllSessions(failures);
    await this.#attempt(
      failures,
      { phase: 'http-listener' },
      () => listenerClose,
    );
    await this.#attempt(
      failures,
      { phase: 'android-runtime' },
      () => androidRuntimeClose,
    );
    await this.#attempt(
      failures,
      { phase: 'external-runtime' },
      () => this.#externalRuntime.close(),
    );
    await this.#attempt(
      failures,
      { phase: 'logger' },
      () => this.#logger.close(),
    );

    if (failures.length > 0) {
      throw new ApplicationLifecycleCloseError(failures);
    }
  }

  async #closeAllSessions(
    failures: ApplicationShutdownFailure[],
  ): Promise<void> {
    const sessionIds = [...this.#sessions.keys()];
    await Promise.all(sessionIds.map((sessionId) => this.#attempt(
      failures,
      { phase: 'mcp-session', sessionId },
      () => this.closeSession(sessionId),
    )));
  }

  async #attempt(
    failures: ApplicationShutdownFailure[],
    details: Omit<ApplicationShutdownFailure, 'error'>,
    operation: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await operation();
    } catch (error: unknown) {
      failures.push({ ...details, error });
    }
  }

  #closeListener(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.#listener.close((error?: Error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      } catch (error: unknown) {
        reject(error);
      }
    });
  }
}
