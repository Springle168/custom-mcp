import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { InitializationTrackingTransport } from '../../src/runtime/mcp/initialization-tracking-transport.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withPublicSend(
  send: StreamableHTTPServerTransport['send'],
  run: () => Promise<void>,
): Promise<void> {
  const original = StreamableHTTPServerTransport.prototype.send;
  // Exercise the subclass boundary without coupling tests to SDK serialization or private state.
  StreamableHTTPServerTransport.prototype.send = send;
  try {
    await run();
  } finally {
    StreamableHTTPServerTransport.prototype.send = original;
  }
}

const result: JSONRPCMessage = { jsonrpc: '2.0', id: 'initialize', result: {} };
const error: JSONRPCMessage = {
  jsonrpc: '2.0',
  id: 'initialize',
  error: { code: -32602, message: 'rejected' },
};

async function testOnlyMatchingResultAfterSendFulfilled(): Promise<void> {
  const sendDone = deferred<void>();
  let receivedMessage: JSONRPCMessage | undefined;
  let receivedOptions: Parameters<StreamableHTTPServerTransport['send']>[1];
  let receivedTransport: StreamableHTTPServerTransport | undefined;
  await withPublicSend(
    async function (this: StreamableHTTPServerTransport, message, options) {
      receivedMessage = message;
      receivedOptions = options;
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- Capture the actual receiver for the forwarding assertion.
      receivedTransport = this;
      await sendDone.promise;
    },
    async () => {
      const transport = new InitializationTrackingTransport(
        { enableJsonResponse: true },
        'initialize',
      );
      const options = { relatedRequestId: 'initialize' };
      const sending = transport.send(result, options);
      let settled = false;
      const observed = transport.waitForInitialization().then((value) => {
        settled = true;
        return value;
      });
      await Promise.resolve();
      assert(
        !settled,
        'Initialization must wait for the public send promise, not just the send invocation',
      );
      assert(receivedMessage === result, 'The message should pass through unchanged');
      assert(receivedOptions === options, 'Send options should pass through unchanged');
      assert(
        receivedTransport === transport,
        'The inherited send should retain the transport receiver',
      );
      sendDone.resolve();
      await sending;
      assertEqual(await observed, true, 'A matching fulfilled result should permit publication');
      assertEqual(
        await transport.waitForInitialization(),
        true,
        'Successful observation should remain stable',
      );
      transport.stopInitializationTracking();
    },
  );
}

async function testErrorAndSendRejection(): Promise<void> {
  for (const message of [result, error]) {
    const sendDone = deferred<void>();
    await withPublicSend(
      async () => sendDone.promise,
      async () => {
        const transport = new InitializationTrackingTransport({}, 'initialize');
        let sendRejected = false;
        void transport.initializationSendRejected.then(() => {
          sendRejected = true;
        });
        const failure = new Error('public send failed');
        const sending = transport.send(message);
        const rejected = sending.then(
          () => undefined,
          (reason: unknown) => reason,
        );
        const observed = transport.waitForInitialization();
        sendDone.reject(failure);
        assert(
          (await rejected) === failure,
          'Send rejection should propagate its original failure',
        );
        assertEqual(
          await observed,
          false,
          'A rejected result or error send must not publish a session',
        );
        assert(
          sendRejected,
          'Rejected result and error sends must independently terminate HTTP waiting',
        );
        transport.stopInitializationTracking();
      },
    );
  }
  const sendDone = deferred<void>();
  await withPublicSend(
    async () => sendDone.promise,
    async () => {
      const transport = new InitializationTrackingTransport({}, 'initialize');
      let sendRejected = false;
      void transport.initializationSendRejected.then(() => {
        sendRejected = true;
      });
      const sending = transport.send(error);
      let settled = false;
      const observed = transport.waitForInitialization().then((value) => {
        settled = true;
        return value;
      });
      await Promise.resolve();
      assert(!settled, 'Error observation should also wait for the underlying send terminal fact');
      sendDone.resolve();
      await sending;
      assertEqual(
        await observed,
        false,
        'An HTTP-successful protocol error must not count as initialization success',
      );
      assert(
        !sendRejected,
        'A fulfilled error send must allow its HTTP response to finish normally',
      );
      transport.stopInitializationTracking();
    },
  );
}

async function testUnrelatedMessagesAndExactId(): Promise<void> {
  await withPublicSend(
    async () => {},
    async () => {
      const transport = new InitializationTrackingTransport({}, 1);
      assertEqual(
        await transport.waitForInitialization(),
        false,
        'No started matching send must return immediately',
      );
      const unrelated: JSONRPCMessage[] = [
        { jsonrpc: '2.0', id: '1', result: {} },
        { jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'other response' } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 1, method: 'ping' },
      ];
      for (const message of unrelated) {
        await transport.send(message);
        assertEqual(
          await transport.waitForInitialization(),
          false,
          'Only a response with the exact matching ID should be observed',
        );
      }
      await transport.send({ jsonrpc: '2.0', id: 1, result: {} });
      assertEqual(
        await transport.waitForInitialization(),
        true,
        'Ignored messages must not prevent the later matching response',
      );
      transport.stopInitializationTracking();
      const untracked = new InitializationTrackingTransport({});
      await untracked.send(result);
      assertEqual(
        await untracked.waitForInitialization(),
        false,
        'Without a validated request ID nothing should be tracked',
      );
      untracked.stopInitializationTracking();
    },
  );
}

async function testStopReleasesWaitAndIgnoresLateSuccess(): Promise<void> {
  const sendDone = deferred<void>();
  await withPublicSend(
    async () => sendDone.promise,
    async () => {
      const transport = new InitializationTrackingTransport({}, 'initialize');
      const sending = transport.send(result);
      const observed = transport.waitForInitialization();
      transport.stopInitializationTracking();
      transport.stopInitializationTracking();
      assertEqual(
        await observed,
        false,
        'Stop must release an already waiting initialization observer',
      );
      sendDone.resolve();
      await sending;
      assertEqual(
        await transport.waitForInitialization(),
        false,
        'A late fulfilled send cannot resurrect stopped tracking',
      );
      await transport.send(result);
      assertEqual(
        await transport.waitForInitialization(),
        false,
        'Later sends should remain untracked after stop',
      );
    },
  );
  await withPublicSend(
    async () => {},
    async () => {
      const transport = new InitializationTrackingTransport({}, 'initialize');
      transport.stopInitializationTracking();
      await transport.send(result);
      assertEqual(
        await transport.waitForInitialization(),
        false,
        'Stopping before a send must prevent observation',
      );
    },
  );
}

async function testUnrelatedRejectionDoesNotPoisonTracking(): Promise<void> {
  const failure = new Error('unrelated send rejected');
  await withPublicSend(
    async (message) => {
      if ('id' in message && message.id === 'other') {
        throw failure;
      }
    },
    async () => {
      const transport = new InitializationTrackingTransport({}, 'initialize');
      let sendRejected = false;
      void transport.initializationSendRejected.then(() => {
        sendRejected = true;
      });
      const rejected = await transport.send({ jsonrpc: '2.0', id: 'other', result: {} }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      assert(rejected === failure, 'Unrelated send rejection should still propagate');
      assertEqual(
        await transport.waitForInitialization(),
        false,
        'An unrelated rejection must not start a tracked response',
      );
      await transport.send(result);
      assertEqual(
        await transport.waitForInitialization(),
        true,
        'An unrelated rejection must not poison the actual initialization result',
      );
      assert(
        !sendRejected,
        'Unrelated rejection and successful initialization must not interrupt HTTP',
      );
      transport.stopInitializationTracking();
    },
  );
}

async function testFirstMatchingResponseWins(): Promise<void> {
  const firstDone = deferred<void>();
  await withPublicSend(
    async (message) => {
      if (message === error) {
        await firstDone.promise;
      }
    },
    async () => {
      const transport = new InitializationTrackingTransport({}, 'initialize');
      const firstSend = transport.send(error);
      const observed = transport.waitForInitialization();
      await transport.send(result);
      firstDone.resolve();
      await firstSend;
      assertEqual(
        await observed,
        false,
        'A later response must not override the first matching error send',
      );
      transport.stopInitializationTracking();
    },
  );
}

await runTestSuite({
  title: 'Testing public initialization transport observation',
  tests: [
    {
      name: 'matching result waits for send fulfillment and preserves arguments',
      run: testOnlyMatchingResultAfterSendFulfilled,
    },
    { name: 'error responses and send rejection cannot publish', run: testErrorAndSendRejection },
    {
      name: 'unrelated messages and wrong ID types are ignored',
      run: testUnrelatedMessagesAndExactId,
    },
    {
      name: 'stop releases waits and ignores late success',
      run: testStopReleasesWaitAndIgnoresLateSuccess,
    },
    {
      name: 'unrelated send rejection does not poison initialization tracking',
      run: testUnrelatedRejectionDoesNotPoisonTracking,
    },
    { name: 'only the first matching response is observed', run: testFirstMatchingResponseWins },
  ],
});
