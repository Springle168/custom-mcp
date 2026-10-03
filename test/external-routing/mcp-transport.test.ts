import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TrackedMcpTransport } from '../../src/tools/external-routing/mcp-transport.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];
  readonly sent: JSONRPCMessage[] = [];
  closeCount = 0;
  rejectCancellation = false;
  cancellationError: Error = new Error('cancel notification failed');

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.sent.push(message);
    if (
      'method' in message &&
      message.method === 'notifications/cancelled' &&
      this.rejectCancellation
    ) {
      throw this.cancellationError;
    }
  }

  async close(): Promise<void> {
    this.closeCount++;
    this.onclose?.();
  }
}

await runTestSuite({
  title: 'external MCP tracked transport',
  tests: [
    {
      name: 'suppresses a response that arrives after a fully drained timeout-style settlement',
      run: async () => {
        const delegate = new FakeTransport();
        const tracked = new TrackedMcpTransport(delegate);
        let forwarded = 0;
        tracked.onmessage = () => {
          forwarded++;
        };
        const captured = tracked.captureCall(() =>
          tracked.send({
            jsonrpc: '2.0',
            id: 41,
            method: 'tools/call',
            params: { name: 'test', arguments: {} },
          }),
        );
        await captured.result;
        captured.exchange.markCallerSettled();
        await captured.exchange.drained;

        delegate.onmessage?.({
          jsonrpc: '2.0',
          id: 41,
          result: { content: [{ type: 'text', text: 'late secret payload' }] },
        });
        assertEqual(
          forwarded,
          0,
          'A tombstoned late response must not reach the SDK Protocol handler.',
        );
      },
    },
    {
      name: 'classifies parser errors without exposing their message to hooks',
      run: async () => {
        const delegate = new FakeTransport();
        let protocolFailures = 0;
        const tracked = new TrackedMcpTransport(delegate, {
          onProtocolError: () => {
            protocolFailures++;
          },
        });
        let forwardedErrors = 0;
        tracked.onerror = () => {
          forwardedErrors++;
        };

        delegate.onerror?.(new SyntaxError('private downstream payload'));
        assertEqual(
          protocolFailures,
          1,
          'Syntax failures should trigger safe protocol invalidation.',
        );
        assertEqual(
          forwardedErrors,
          1,
          'The SDK-owned error callback should remain transparently proxied.',
        );
      },
    },
    {
      name: 'does not invalidate the shared session when cancellation notification delivery fails',
      run: async () => {
        const delegate = new FakeTransport();
        const failedRequestIds: Array<string | number | undefined> = [];
        const tracked = new TrackedMcpTransport(delegate, {
          onTransportFailure: (requestId) => failedRequestIds.push(requestId),
        });
        const captured = tracked.captureCall(() =>
          tracked.send({
            jsonrpc: '2.0',
            id: 51,
            method: 'tools/call',
            params: { name: 'test', arguments: {} },
          }),
        );
        await captured.result;

        delegate.rejectCancellation = true;
        await tracked
          .send({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: 51, reason: 'test cancellation' },
          })
          .catch(() => undefined);
        const failingFetch = tracked.createFetch(async () => {
          throw new Error('cancel notification network failure');
        });
        await failingFetch('http://127.0.0.1/mcp', {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: 51, reason: 'test cancellation' },
          }),
        }).catch(() => undefined);
        delegate.cancellationError = new StreamableHTTPError(404, 'invalid session');
        await tracked
          .send({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: 51, reason: 'test cancellation' },
          })
          .catch(() => undefined);
        captured.exchange.markCallerSettled();
        await captured.exchange.drained;

        assertEqual(
          failedRequestIds.length,
          1,
          'Only an explicit invalid-session response should invalidate the connection.',
        );
        assertEqual(
          failedRequestIds[0],
          51,
          'Invalid-session cancellation failure should identify the affected request.',
        );
      },
    },
    {
      name: 'invalidates failed shared GET responses except the optional 405 response',
      run: async () => {
        const delegate = new FakeTransport();
        let sharedFailures = 0;
        const tracked = new TrackedMcpTransport(delegate, {
          onSharedStreamTerminated: () => {
            sharedFailures++;
          },
        });
        const trackedFetch = tracked.createFetch(async () => new Response(null, { status: 404 }));
        await trackedFetch('http://127.0.0.1/mcp', { method: 'GET' });
        assertEqual(
          sharedFailures,
          1,
          'A session-invalid shared GET response should invalidate the session.',
        );

        const optionalFetch = tracked.createFetch(async () => new Response(null, { status: 405 }));
        await optionalFetch('http://127.0.0.1/mcp', { method: 'GET' });
        assertEqual(
          sharedFailures,
          1,
          'A 405 shared GET response is an allowed no-stream capability response.',
        );
      },
    },
    {
      name: 'bounds late-response tombstones by closing an overloaded session',
      run: async () => {
        const delegate = new FakeTransport();
        const tracked = new TrackedMcpTransport(delegate);
        for (let id = 1; id <= 1_025; id++) {
          const captured = tracked.captureCall(() =>
            tracked.send({
              jsonrpc: '2.0',
              id,
              method: 'tools/call',
              params: { name: 'test', arguments: {} },
            }),
          );
          await captured.result;
          captured.exchange.markCallerSettled();
          await captured.exchange.drained;
        }
        await Promise.resolve();
        assert(
          delegate.closeCount > 0,
          'The transport should replace a session before tombstones grow without bound.',
        );
      },
    },
  ],
});
