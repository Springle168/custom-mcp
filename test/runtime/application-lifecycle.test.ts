import type { Server as HttpServer } from 'node:http';
import {
  ApplicationLifecycle,
  ApplicationLifecycleCloseError,
  type ApplicationLifecycleClosable,
} from '../../src/runtime/application-lifecycle.js';
import type {
  McpPostSession,
  McpPostTransport,
} from '../../src/runtime/mcp-post-handler.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

interface FakeListener {
  readonly closeCalls: () => number;
  close(callback: (error?: Error) => void): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function asHttpServer(listener: FakeListener): HttpServer {
  return listener as unknown as HttpServer;
}

function createListener(
  events: string[],
  options: {
    readonly complete?: Deferred<void>;
    readonly error?: Error;
  } = {},
): FakeListener {
  let closeCalls = 0;
  return {
    closeCalls: () => closeCalls,
    close(callback) {
      closeCalls++;
      events.push('listener.close');
      if (options.complete !== undefined) {
        void options.complete.promise.then(
          () => callback(options.error),
          (error: unknown) => callback(
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
        return;
      }
      callback(options.error);
    },
  };
}

function createSession(
  events: string[],
  sessionId: string,
  close: () => Promise<void> | void = () => {},
): McpPostSession {
  const transport: McpPostTransport = {
    sessionId,
    handleRequest() {},
  };
  return {
    transport,
    server: {
      async close() {
        events.push(`session.${sessionId}.close`);
        await close();
      },
    },
  };
}

function createClosable(
  events: string[],
  event: string,
  close: () => Promise<void> | void = () => {},
): ApplicationLifecycleClosable {
  return {
    async close() {
      events.push(event);
      await close();
    },
  };
}

async function testClosesResourcesInApplicationShutdownOrder(): Promise<void> {
  const events: string[] = [];
  const sessions = new Map<string, McpPostSession>([
    ['first', createSession(events, 'first')],
    ['second', createSession(events, 'second')],
  ]);
  const lifecycle = new ApplicationLifecycle({
    listener: asHttpServer(createListener(events)),
    sessions,
    externalRuntime: createClosable(events, 'external.close'),
    logger: createClosable(events, 'logger.close'),
  });

  await lifecycle.close();

  assertEqual(
    events.join(','),
    'listener.close,session.first.close,session.second.close,external.close,logger.close',
    'Application shutdown should stop admission, close every MCP session, drain runtime, then close logging.',
  );
  assertEqual(sessions.size, 0, 'Application shutdown should remove every closed session.');
}

async function testCloseIsIdempotentAndStopsSessionAdmissionImmediately(): Promise<void> {
  const events: string[] = [];
  const listenerDrain = deferred<void>();
  const listener = createListener(events, { complete: listenerDrain });
  const sessions = new Map<string, McpPostSession>([
    ['only', createSession(events, 'only')],
  ]);
  const lifecycle = new ApplicationLifecycle({
    listener: asHttpServer(listener),
    sessions,
    externalRuntime: createClosable(events, 'external.close'),
    logger: createClosable(events, 'logger.close'),
  });

  const firstClose = lifecycle.close();
  const secondClose = lifecycle.close();

  assert(Object.is(firstClose, secondClose), 'Every application close() call should return the same promise.');
  assert(!lifecycle.isAcceptingNewSessions, 'Application close should reject new session admission immediately.');
  assertEqual(listener.closeCalls(), 1, 'Listener close should only be started once.');

  listenerDrain.resolve();
  await firstClose;

  assertEqual(
    events.filter((event) => event === 'session.only.close').length,
    1,
    'Idempotent application close should close each MCP session once.',
  );
  assertEqual(
    events.filter((event) => event === 'external.close').length,
    1,
    'Idempotent application close should drain the external runtime once.',
  );
  assertEqual(
    events.filter((event) => event === 'logger.close').length,
    1,
    'Idempotent application close should close the logger once.',
  );
}

async function testSingleSessionCloseIsSeparateAndCleansTheSessionMap(): Promise<void> {
  const events: string[] = [];
  const sessionDrain = deferred<void>();
  const sessions = new Map<string, McpPostSession>([
    ['only', createSession(events, 'only', () => sessionDrain.promise)],
  ]);
  const lifecycle = new ApplicationLifecycle({
    listener: asHttpServer(createListener(events)),
    sessions,
    externalRuntime: createClosable(events, 'external.close'),
    logger: createClosable(events, 'logger.close'),
  });

  const firstClose = lifecycle.closeSession('only');
  const secondClose = lifecycle.closeSession('only');

  assert(Object.is(firstClose, secondClose), 'Concurrent closeSession() calls should share one session close.');
  sessionDrain.resolve();
  await firstClose;
  await lifecycle.closeSession('only');

  assertEqual(sessions.size, 0, 'Single session close should remove only that closed session from the map.');
  assertEqual(
    events.filter((event) => event === 'session.only.close').length,
    1,
    'A closed session should not be closed a second time.',
  );
  assert(
    lifecycle.isAcceptingNewSessions,
    'Single session close should not begin application shutdown or stop new session admission.',
  );
}

async function testContinuesClosingAfterFailuresAndReportsThemTogether(): Promise<void> {
  const events: string[] = [];
  const listenerFailure = new Error('listener failed');
  const sessionFailure = new Error('session failed');
  const runtimeFailure = new Error('runtime failed');
  const sessions = new Map<string, McpPostSession>([
    ['failed', createSession(events, 'failed', () => {
      throw sessionFailure;
    })],
    ['succeeds', createSession(events, 'succeeds')],
  ]);
  const lifecycle = new ApplicationLifecycle({
    listener: asHttpServer(createListener(events, { error: listenerFailure })),
    sessions,
    externalRuntime: createClosable(events, 'external.close', () => {
      throw runtimeFailure;
    }),
    logger: createClosable(events, 'logger.close'),
  });

  try {
    await lifecycle.close();
  } catch (error: unknown) {
    assert(
      error instanceof ApplicationLifecycleCloseError,
      'Application close should aggregate failures after every shutdown phase runs.',
    );
    assertEqual(error.failures.length, 3, 'Listener, failed session, and runtime failures should be retained.');
    assertEqual(error.failures[0]?.phase, 'mcp-session', 'Session failures should be reported first after listener admission stops.');
    assertEqual(error.failures[1]?.phase, 'http-listener', 'Listener drain failure should be reported after session closure.');
    assertEqual(error.failures[2]?.phase, 'external-runtime', 'Runtime drain failure should be reported before logger closure.');
    assertEqual(error.errors.length, 3, 'AggregateError should retain the underlying failures.');

    assertEqual(
      events.join(','),
      'listener.close,session.failed.close,session.succeeds.close,external.close,logger.close',
      'Failures must not prevent later sessions, runtime drain, or logger close from running.',
    );
    assertEqual(sessions.size, 0, 'Failed session closure should still remove every captured session from the map.');
    return;
  }

  throw new Error('Expected application close to report aggregate shutdown failure.');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing application lifecycle shutdown ownership',
    tests: [
      { name: 'closes resources in application shutdown order', run: testClosesResourcesInApplicationShutdownOrder },
      { name: 'is idempotent and stops session admission immediately', run: testCloseIsIdempotentAndStopsSessionAdmissionImmediately },
      { name: 'keeps single-session close separate and cleans session state', run: testSingleSessionCloseIsSeparateAndCleansTheSessionMap },
      { name: 'continues after failures and reports them together', run: testContinuesClosingAfterFailuresAndReportsThemTogether },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
