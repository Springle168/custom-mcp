import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { TrackedMcpTransport } from '../../src/tools/external-routing/mcp-transport.js';
import { assertEqual, runTestSuite } from '../test-utils.js';

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport['onmessage'];
  readonly sent: JSONRPCMessage[] = [];

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.sent.push(message);
  }

  async close(): Promise<void> {
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
        tracked.onmessage = () => { forwarded++; };
        const captured = tracked.captureCall(() => tracked.send({
          jsonrpc: '2.0',
          id: 41,
          method: 'tools/call',
          params: { name: 'test', arguments: {} },
        }));
        await captured.result;
        captured.exchange.markCallerSettled();
        await captured.exchange.drained;

        delegate.onmessage?.({
          jsonrpc: '2.0',
          id: 41,
          result: { content: [{ type: 'text', text: 'late secret payload' }] },
        });
        assertEqual(forwarded, 0, 'A tombstoned late response must not reach the SDK Protocol handler.');
      },
    },
    {
      name: 'classifies parser errors without exposing their message to hooks',
      run: async () => {
        const delegate = new FakeTransport();
        let protocolFailures = 0;
        const tracked = new TrackedMcpTransport(delegate, {
          onProtocolError: () => { protocolFailures++; },
        });
        let forwardedErrors = 0;
        tracked.onerror = () => { forwardedErrors++; };

        delegate.onerror?.(new SyntaxError('private downstream payload'));
        assertEqual(protocolFailures, 1, 'Syntax failures should trigger safe protocol invalidation.');
        assertEqual(forwardedErrors, 1, 'The SDK-owned error callback should remain transparently proxied.');
      },
    },
  ],
});
