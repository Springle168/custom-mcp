import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InitializationTrackingTransport } from '../../src/runtime/mcp/initialization-tracking-transport.js';
import { createPendingSession } from '../../src/runtime/mcp/pending-session.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class CountingTransport extends InitializationTrackingTransport {
  startCalls = 0;
  closeCalls = 0;
  stopCalls = 0;
  readonly startOperation: () => Promise<void>;

  constructor(startOperation: () => Promise<void> = async () => {}) {
    super({}, 'initialize');
    this.startOperation = startOperation;
  }

  override async start(): Promise<void> {
    this.startCalls++;
    await this.startOperation();
  }

  override async close(): Promise<void> {
    this.closeCalls++;
    await super.close();
  }

  override stopInitializationTracking(): void {
    this.stopCalls++;
    super.stopInitializationTracking();
  }
}

class CountingServer extends Server {
  closeCalls = 0;

  constructor() {
    super({ name: 'pending-session-test', version: '1.0.0' });
  }

  override async close(): Promise<void> {
    this.closeCalls++;
    await super.close();
  }
}

async function testCloseBeforeConnect(): Promise<void> {
  const server = new CountingServer();
  const transport = new CountingTransport();
  let onClosedCalls = 0;
  const session = createPendingSession(server, transport, () => {
    onClosedCalls++;
  });
  const firstClose = session.close();
  assert(session.isClosed, 'Closing should prevent later connect synchronously');
  await session.closed;
  assert(
    firstClose === session.close(),
    'Concurrent close callers should share one cleanup promise',
  );
  await firstClose;
  await session.connect();
  await session.close();
  assertEqual(transport.startCalls, 0, 'Close before connect must not start the transport');
  assertEqual(server.closeCalls, 0, 'An unconnected transport is not owned by Server');
  assertEqual(transport.closeCalls, 1, 'An unconnected transport should be closed directly once');
  assert(
    transport.stopCalls >= 1,
    'Cleanup should stop initialization observation; repeated stops from onclose are harmless',
  );
  assertEqual(onClosedCalls, 1, 'Transport closure should notify the owner once');
}

async function testConnectedCloseUsesServerOwnership(): Promise<void> {
  const server = new CountingServer();
  const transport = new CountingTransport();
  const session = createPendingSession(server, transport, () => {});
  await session.connect();
  assert(
    server.transport === transport,
    'SDK public accessor should reflect connected transport ownership',
  );
  const firstClose = session.close();
  assert(firstClose === session.close(), 'Connected close should be idempotent');
  await firstClose;
  await session.close();
  assertEqual(server.closeCalls, 1, 'Connected resources should close through Server once');
  assertEqual(
    transport.closeCalls,
    1,
    'Server should close the transport without a second independent close',
  );
  assert(session.isClosed, 'Connected closure should settle the closed fact');
}

async function testConnectFailureAfterOwnershipTransfer(): Promise<void> {
  const failure = new Error('transport start rejected');
  const server = new CountingServer();
  const transport = new CountingTransport(async () => {
    throw failure;
  });
  const session = createPendingSession(server, transport, () => {});
  const rejected = await session.connect().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert(rejected === failure, 'Connect should propagate the original start failure');
  assert(
    server.transport === transport,
    'SDK public transport ownership should remain visible after start rejects',
  );
  await session.close();
  assertEqual(
    server.closeCalls,
    1,
    'A partially failed SDK connect should close through Server ownership',
  );
  assertEqual(transport.closeCalls, 1, 'Connect failure cleanup must not double-close transport');
}

async function testConnectFailureBeforeOwnershipTransfer(): Promise<void> {
  const failure = new Error('connect rejected before ownership transfer');
  class RejectingServer extends CountingServer {
    override connect(..._args: Parameters<Server['connect']>): Promise<void> {
      throw failure;
    }
  }
  const server = new RejectingServer();
  const transport = new CountingTransport();
  const session = createPendingSession(server, transport, () => {});
  const rejected = await session.connect().then(
    () => undefined,
    (error: unknown) => error,
  );
  assert(rejected === failure, 'Failure before SDK ownership should remain observable');
  assertEqual(server.transport, undefined, 'Rejected connect should not claim transport ownership');
  await session.close();
  assertEqual(server.closeCalls, 0, 'Server must not close a transport it never owned');
  assertEqual(
    transport.closeCalls,
    1,
    'Owner must directly close a transport when connect never transferred it',
  );
}

async function testCloseDuringConnect(): Promise<void> {
  const startDone = deferred<void>();
  const server = new CountingServer();
  const transport = new CountingTransport(() => startDone.promise);
  let onClosedCalls = 0;
  const session = createPendingSession(server, transport, () => {
    onClosedCalls++;
  });
  const connecting = session.connect();
  assert(
    server.transport === transport,
    'SDK should transfer ownership synchronously before awaiting start',
  );
  const closing = session.close();
  await closing;
  assert(session.isClosed, 'Close during connect must immediately prohibit publication');
  await session.closed;
  startDone.resolve();
  await connecting;
  await session.close();
  assertEqual(
    server.closeCalls,
    1,
    'Close during connect must use the public Server ownership fact',
  );
  assertEqual(
    transport.closeCalls,
    1,
    'Late connect fulfillment must not require a second transport close',
  );
  assertEqual(onClosedCalls, 1, 'Closing while start is pending should notify the owner once');
}

async function testLateConnectFailureAfterClose(): Promise<void> {
  const startDone = deferred<void>();
  const failure = new Error('late start failure');
  const server = new CountingServer();
  const transport = new CountingTransport(async () => {
    await startDone.promise;
    throw failure;
  });
  const session = createPendingSession(server, transport, () => {});
  const rejected = session.connect().then(
    () => undefined,
    (error: unknown) => error,
  );
  await session.close();
  startDone.resolve();
  assert((await rejected) === failure, 'Connect failure after shutdown must still propagate');
  assert(session.isClosed, 'Late connect rejection must not reset the closed fact');
  await session.close();
  assertEqual(
    server.closeCalls,
    1,
    'Late connect rejection must not cause redundant Server closure',
  );
  assertEqual(
    transport.closeCalls,
    1,
    'Late connect rejection must not cause redundant transport closure',
  );
}

async function testCloseRejectionRemainsShared(): Promise<void> {
  const failure = new Error('transport close failed');
  const server = new CountingServer();
  const transport = new CountingTransport();
  transport.close = async () => {
    transport.closeCalls++;
    throw failure;
  };
  const session = createPendingSession(server, transport, () => {});
  const firstClose = session.close();
  assert(firstClose === session.close(), 'Even failing close work should be shared across callers');
  const rejected = await firstClose.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert(rejected === failure, 'Close should retain the resource cleanup failure');
  await session.closed;
  assert(session.isClosed, 'Cleanup failure must not make the session publishable again');
  assert(firstClose === session.close(), 'Later callers should see the same failed cleanup fact');
  assertEqual(transport.closeCalls, 1, 'A failed resource close must not be retried implicitly');
}

async function testTransportAlreadyClosed(): Promise<void> {
  const server = new CountingServer();
  const transport = new CountingTransport();
  let onClosedCalls = 0;
  const session = createPendingSession(server, transport, () => {
    onClosedCalls++;
  });
  await session.connect();
  await transport.close();
  assert(session.isClosed, 'Public transport onclose must mark the session closed');
  await session.closed;
  await session.close();
  await session.connect();
  assertEqual(transport.closeCalls, 1, 'An already closed transport must not be closed again');
  assertEqual(
    server.closeCalls,
    0,
    'An external transport close must not trigger redundant Server closure',
  );
  assertEqual(transport.startCalls, 1, 'An already closed session must not reconnect');
  assertEqual(onClosedCalls, 1, 'Owner should receive the single transport close callback');
}

await runTestSuite({
  title: 'Testing pending MCP session ownership and close races',
  tests: [
    { name: 'close before connect owns transport directly', run: testCloseBeforeConnect },
    {
      name: 'connected close delegates to SDK Server exactly once',
      run: testConnectedCloseUsesServerOwnership,
    },
    {
      name: 'failed connect after ownership transfer is cleaned via Server',
      run: testConnectFailureAfterOwnershipTransfer,
    },
    {
      name: 'failed connect before ownership transfer closes transport directly',
      run: testConnectFailureBeforeOwnershipTransfer,
    },
    {
      name: 'close during connect cannot revive or double-close session',
      run: testCloseDuringConnect,
    },
    {
      name: 'late connect rejection after close does not revive resources',
      run: testLateConnectFailureAfterClose,
    },
    { name: 'close rejection stays shared and terminal', run: testCloseRejectionRemainsShared },
    {
      name: 'already closed transport cannot be closed or connected again',
      run: testTransportAlreadyClosed,
    },
  ],
});
