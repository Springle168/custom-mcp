import type { Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InitializationTrackingTransport } from '../../src/runtime/mcp/initialization-tracking-transport.js';
import {
  createPendingSession,
  type McpPendingSession,
} from '../../src/runtime/mcp/pending-session.js';
import {
  ApplicationLifecycle,
  ApplicationLifecycleCloseError,
  type ApplicationLifecycleClosable,
} from '../../src/runtime/application/application-lifecycle.js';
import type { McpPostSession, McpPostTransport } from '../../src/runtime/mcp/mcp-post-handler.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

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
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
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
    pendingSessions: new Set(),
    androidRuntime: createClosable(events, 'android.close'),
    externalRuntime: createClosable(events, 'external.close'),
    logger: createClosable(events, 'logger.close'),
  });

  await lifecycle.close();

  assertEqual(
    events.join(','),
    'listener.close,android.close,session.first.close,session.second.close,external.close,logger.close',
    'Application shutdown should stop admission, start Android drain, close every MCP session, drain external runtime, then close logging.',
  );
  assertEqual(sessions.size, 0, 'Application shutdown should remove every closed session.');
}

async function testCloseIsIdempotentAndStopsSessionAdmissionImmediately(): Promise<void> {
  const events: string[] = [];
  const listenerDrain = deferred<void>();
  const listener = createListener(events, { complete: listenerDrain });
  const sessions = new Map<string, McpPostSession>([['only', createSession(events, 'only')]]);
  const lifecycle = new ApplicationLifecycle({
    listener: asHttpServer(listener),
    sessions,
    pendingSessions: new Set(),
    androidRuntime: createClosable(events, 'android.close'),
    externalRuntime: createClosable(events, 'external.close'),
    logger: createClosable(events, 'logger.close'),
  });

  const firstClose = lifecycle.close();
  const secondClose = lifecycle.close();

  assert(
    Object.is(firstClose, secondClose),
    'Every application close() call should return the same promise.',
  );
  assert(
    !lifecycle.isAcceptingNewSessions,
    'Application close should reject new session admission immediately.',
  );
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

async function testStartsAndroidCloseBeforeBlockedSessionDrain(): Promise<void> {
  const events: string[] = [];
  const sessionDrain = deferred<void>();
  const androidDrain = deferred<void>();
  const sessions = new Map<string, McpPostSession>([
    ['blocked', createSession(events, 'blocked', () => sessionDrain.promise)],
  ]);
  const lifecycle = new ApplicationLifecycle({
    listener: asHttpServer(createListener(events)),
    sessions,
    pendingSessions: new Set(),
    androidRuntime: createClosable(events, 'android.close', () => androidDrain.promise),
    externalRuntime: createClosable(events, 'external.close'),
    logger: createClosable(events, 'logger.close'),
  });

  const close = lifecycle.close();
  await Promise.resolve();
  await Promise.resolve();

  assert(
    events.includes('android.close'),
    'Android runtime close should start without waiting for MCP session cancellation.',
  );
  assert(
    !events.includes('external.close'),
    'External runtime should wait for the Android and session barriers.',
  );

  sessionDrain.resolve();
  androidDrain.resolve();
  await close;
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
    pendingSessions: new Set(),
    androidRuntime: createClosable(events, 'android.close'),
    externalRuntime: createClosable(events, 'external.close'),
    logger: createClosable(events, 'logger.close'),
  });

  const firstClose = lifecycle.closeSession('only');
  const secondClose = lifecycle.closeSession('only');

  assert(
    Object.is(firstClose, secondClose),
    'Concurrent closeSession() calls should share one session close.',
  );
  sessionDrain.resolve();
  await firstClose;
  await lifecycle.closeSession('only');

  assertEqual(
    sessions.size,
    0,
    'Single session close should remove only that closed session from the map.',
  );
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
  const androidFailure = new Error('android runtime failed');
  const runtimeFailure = new Error('runtime failed');
  const sessions = new Map<string, McpPostSession>([
    [
      'failed',
      createSession(events, 'failed', () => {
        throw sessionFailure;
      }),
    ],
    ['succeeds', createSession(events, 'succeeds')],
  ]);
  const lifecycle = new ApplicationLifecycle({
    listener: asHttpServer(createListener(events, { error: listenerFailure })),
    sessions,
    pendingSessions: new Set(),
    androidRuntime: createClosable(events, 'android.close', () => {
      throw androidFailure;
    }),
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
    assertEqual(
      error.failures.length,
      4,
      'Listener, session, Android, and external runtime failures should be retained.',
    );
    assertEqual(
      error.failures[0]?.phase,
      'mcp-session',
      'Session failures should be reported first after listener admission stops.',
    );
    assertEqual(
      error.failures[1]?.phase,
      'http-listener',
      'Listener drain failure should be reported after session closure.',
    );
    assertEqual(
      error.failures[2]?.phase,
      'android-runtime',
      'Android drain failure should have its own shutdown phase.',
    );
    assertEqual(
      error.failures[3]?.phase,
      'external-runtime',
      'External runtime failure should be reported before logger closure.',
    );
    assertEqual(error.errors.length, 4, 'AggregateError should retain the underlying failures.');

    assertEqual(
      events.join(','),
      'listener.close,android.close,session.failed.close,session.succeeds.close,external.close,logger.close',
      'Failures must not prevent later sessions, runtime drain, or logger close from running.',
    );
    assertEqual(
      sessions.size,
      0,
      'Failed session closure should still remove every captured session from the map.',
    );
    return;
  }

  throw new Error('Expected application close to report aggregate shutdown failure.');
}

function createPendingFixture(
  events: string[],
  name: string,
  closeOperation: () => Promise<void> | void = () => {},
): McpPendingSession {
  const server = new Server({ name: 'application-lifecycle-test', version: '1.0.0' });
  const transport = new InitializationTrackingTransport({}, 'initialize');
  const closeTransport = transport.close.bind(transport);
  transport.close = async () => {
    events.push(`pending.${name}.close`);
    await closeOperation();
    await closeTransport();
  };
  return createPendingSession(server, transport, () => {
    events.push(`pending.${name}.closed`);
  });
}

async function testPendingCloseReleasesListenerDrain(): Promise<void> {
  const events: string[] = [];
  const listenerDrain = deferred<void>();
  const pending = createPendingFixture(events, 'initializing', () => listenerDrain.resolve());
  const pendingSessions = new Set([pending]);
  const sessions = new Map<string, McpPostSession>([
    ['published', createSession(events, 'published')],
  ]);
  const lifecycle = new ApplicationLifecycle({
    listener: asHttpServer(createListener(events, { complete: listenerDrain })),
    sessions,
    pendingSessions,
    androidRuntime: createClosable(events, 'android.close'),
    externalRuntime: createClosable(events, 'external.close'),
    logger: createClosable(events, 'logger.close'),
  });
  const closing = lifecycle.close();
  try {
    await Promise.resolve();
    await Promise.resolve();
    assert(
      !lifecycle.isAcceptingNewSessions,
      'Shutdown must prohibit pending publication immediately',
    );
    assert(
      events.includes('pending.initializing.close'),
      'Pending closure must start before waiting on listener drain',
    );
    await closing;
  } finally {
    // Keep a failed ordering assertion from leaving a blocked shutdown promise behind.
    listenerDrain.resolve();
    await closing;
  }
  assertEqual(pendingSessions.size, 0, 'Shutdown should remove pending resources after closing');
  assertEqual(sessions.size, 0, 'Shutdown should also close published sessions');
  assert(
    events.indexOf('pending.initializing.closed') < events.indexOf('external.close'),
    'Shared runtime drain should follow pending resource closure',
  );
}

async function testConcurrentPendingCleanupSharesCloseFact(): Promise<void> {
  const events: string[] = [];
  const pendingDrain = deferred<void>();
  const pending = createPendingFixture(events, 'shared', () => pendingDrain.promise);
  const pendingSessions = new Set([pending]);
  const lifecycle = new ApplicationLifecycle({
    listener: asHttpServer(createListener(events)),
    sessions: new Map(),
    pendingSessions,
    androidRuntime: createClosable(events, 'android.close'),
    externalRuntime: createClosable(events, 'external.close'),
    logger: createClosable(events, 'logger.close'),
  });
  const entryCleanup = pending.close();
  const applicationCleanup = lifecycle.close();
  try {
    await Promise.resolve();
    await Promise.resolve();
    assert(
      pending.close() === entryCleanup,
      'Entry cleanup and shutdown should share pending close work',
    );
    assertEqual(
      events.filter((event) => event === 'pending.shared.close').length,
      1,
      'Transport cleanup should start once despite concurrent owners',
    );
    assertEqual(
      pendingSessions.size,
      1,
      'Ownership must stay tracked while physical cleanup is pending',
    );
    assert(
      !events.includes('external.close'),
      'Shared runtimes must not close before pending cleanup completes',
    );
  } finally {
    pendingDrain.resolve();
    await Promise.all([entryCleanup, applicationCleanup]);
  }
  assertEqual(
    pendingSessions.size,
    0,
    'Completed pending cleanup should remove the ownership entry',
  );
  assertEqual(
    events.filter((event) => event === 'pending.shared.close').length,
    1,
    'Shutdown must not independently close the same transport again',
  );
}

async function testPendingFailureDoesNotBlockOtherCleanup(): Promise<void> {
  const events: string[] = [];
  const failure = new Error('pending transport close failed');
  const failed = createPendingFixture(events, 'failed', () => {
    throw failure;
  });
  const healthy = createPendingFixture(events, 'healthy');
  const pendingSessions = new Set([failed, healthy]);
  const sessions = new Map<string, McpPostSession>([
    ['published', createSession(events, 'published')],
  ]);
  const lifecycle = new ApplicationLifecycle({
    listener: asHttpServer(createListener(events)),
    sessions,
    pendingSessions,
    androidRuntime: createClosable(events, 'android.close'),
    externalRuntime: createClosable(events, 'external.close'),
    logger: createClosable(events, 'logger.close'),
  });
  const rejected = await lifecycle.close().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert(
    rejected instanceof ApplicationLifecycleCloseError,
    'Pending close failures should be aggregated',
  );
  assertEqual(rejected.failures.length, 1, 'The pending failure should be reported once');
  assertEqual(
    rejected.failures[0]?.phase,
    'mcp-session',
    'Pending resources should retain the MCP session shutdown phase',
  );
  assertEqual(
    rejected.failures[0]?.sessionId,
    undefined,
    'Unpublished resources must not be logged with a temporary session ID',
  );
  assert(
    rejected.failures[0]?.error === failure,
    'The original cleanup failure should be preserved',
  );
  assertEqual(
    pendingSessions.size,
    0,
    'Failed and successful pending resources must both leave the ownership set',
  );
  assertEqual(sessions.size, 0, 'Pending failure must not prevent published session cleanup');
  assert(events.includes('pending.healthy.closed'), 'Other pending resources must still close');
  assert(
    events.includes('external.close') && events.includes('logger.close'),
    'Pending failure must not prevent downstream runtime and logging cleanup',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing application lifecycle shutdown ownership',
    tests: [
      {
        name: 'closes resources in application shutdown order',
        run: testClosesResourcesInApplicationShutdownOrder,
      },
      {
        name: 'is idempotent and stops session admission immediately',
        run: testCloseIsIdempotentAndStopsSessionAdmissionImmediately,
      },
      {
        name: 'starts Android close before blocked session drain',
        run: testStartsAndroidCloseBeforeBlockedSessionDrain,
      },
      {
        name: 'keeps single-session close separate and cleans session state',
        run: testSingleSessionCloseIsSeparateAndCleansTheSessionMap,
      },
      {
        name: 'continues after failures and reports them together',
        run: testContinuesClosingAfterFailuresAndReportsThemTogether,
      },
      {
        name: 'pending close releases listener drain before shutdown waits',
        run: testPendingCloseReleasesListenerDrain,
      },
      {
        name: 'entry cleanup and shutdown share pending close facts',
        run: testConcurrentPendingCleanupSharesCloseFact,
      },
      {
        name: 'pending failures do not prevent other resource cleanup',
        run: testPendingFailureDoesNotBlockOtherCleanup,
      },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
