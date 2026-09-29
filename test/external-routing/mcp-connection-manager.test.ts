import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { McpConnectionManager } from '../../src/tools/external-routing/mcp-connection-manager.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

interface TestMcpServer {
  readonly url: string;
  readonly calls: readonly Record<string, unknown>[];
  initializeCount(): number;
  close(): Promise<void>;
}

async function startMcpServer(options: {
  readonly capabilities?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly hangCalls?: boolean;
  readonly failInitializeCount?: number;
  readonly initializeDelayMs?: number;
  readonly delayFirstCallMs?: number;
  readonly hangInitialize?: boolean;
  readonly jsonRpcErrorCode?: number;
  readonly malformedDirectJson?: boolean;
  readonly requestSseEndDelayMs?: number;
  readonly sharedGetDelayMs?: number;
  readonly malformedRequestSse?: boolean;
} = {}): Promise<TestMcpServer> {
  const calls: Record<string, unknown>[] = [];
  let sharedGetResponse: ServerResponse | undefined;
  const sockets = new Set<Socket>();
  let initializeCount = 0;
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET') {
      if (options.sharedGetDelayMs === undefined) {
        response.writeHead(405).end();
      } else {
        sharedGetResponse = response;
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        response.write('id: shared-stream\n\n');
      }
      return;
    }
    if (request.method === 'DELETE') {
      response.writeHead(200).end();
      return;
    }
    const body = await readBody(request);
    const message = JSON.parse(body) as Record<string, unknown>;
    if (message.method === 'initialize') {
      initializeCount++;
      if (options.hangInitialize === true) return;
      if (options.initializeDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.initializeDelayMs));
      }
      if (initializeCount <= (options.failInitializeCount ?? 0)) {
        response.writeHead(503, { 'Content-Type': 'text/plain' }).end('temporary failure');
        return;
      }
      writeJson(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: options.capabilities ?? { tools: {} },
          serverInfo: { name: 'test-downstream', version: '1' },
        },
      }, { 'Mcp-Session-Id': 'test-session' });
      return;
    }
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
      response.writeHead(202).end();
      return;
    }
    if (message.method === 'tools/call') {
      calls.push(message);
      if (options.hangCalls === true) return;
      if (calls.length === 1 && options.delayFirstCallMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayFirstCallMs));
      }
      if (options.malformedRequestSse === true) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {malformed\n\n');
        return;
      }
      if (options.requestSseEndDelayMs !== undefined) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: options.result ?? { content: [{ type: 'text', text: 'downstream result' }] },
        })}\n\n`);
        setTimeout(() => response.end(), options.requestSseEndDelayMs);
        return;
      }
      if (options.sharedGetDelayMs !== undefined) {
        response.writeHead(202).end();
        const sendSharedResult = (): void => {
          if (sharedGetResponse === undefined) {
            setTimeout(sendSharedResult, 1);
            return;
          }
          sharedGetResponse.write(`data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: options.result ?? { content: [{ type: 'text', text: 'shared result' }] },
          })}\n\n`);
        };
        setTimeout(sendSharedResult, options.sharedGetDelayMs);
        return;
      }
      if (options.malformedDirectJson === true) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{malformed');
        return;
      }
      if (options.jsonRpcErrorCode !== undefined) {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: options.jsonRpcErrorCode, message: 'private downstream error' },
        });
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        }).end(body);
        return;
      }
      writeJson(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: options.result ?? {
          content: [{ type: 'text', text: 'downstream result' }],
        },
      });
      return;
    }
    response.writeHead(400).end();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address !== null && typeof address !== 'string', 'Test server should expose a TCP port.');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    initializeCount: () => initializeCount,
    close: () => closeServer(server, sockets),
  };
}

function createManager(server: TestMcpServer, timeoutMs = 1_000): McpConnectionManager {
  return new McpConnectionManager(Object.freeze({
    identity: server.url,
    url: server.url,
    timeoutMs,
    headers: Object.freeze({ Authorization: 'Bearer test-secret' }),
  }));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(
  response: ServerResponse,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(value);
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

async function closeServer(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

await runTestSuite({
  title: 'external MCP connection manager',
  tests: [
  {
    name: 'single-flight initialize is shared and calls preserve local name and arguments',
    run: async () => {
      const downstream = await startMcpServer();
      const manager = createManager(downstream);
      try {
        const [first, second] = await Promise.all([
          manager.callTool({ name: 'local_tool', arguments: { value: 1 } }).settled,
          manager.callTool({ name: 'local_tool', arguments: { value: 2 } }).settled,
        ]);
        assertEqual(first.kind, 'result', 'First call should return a result.');
        assertEqual(second.kind, 'result', 'Second call should return a result.');
        if (first.kind === 'result') {
          assertEqual(first.result.isError, false, 'Missing downstream isError should normalize to false.');
        }
        assertEqual(downstream.initializeCount(), 1, 'Concurrent calls should share one initialize.');
        assertEqual(downstream.calls.length, 2, 'Both tool calls should be sent once.');
        const params = downstream.calls[0]?.params as Record<string, unknown>;
        assertEqual(params.name, 'local_tool', 'MCP route should use the local definition name.');
        assertEqual((params.arguments as Record<string, unknown>).value, 1, 'Arguments should pass through unchanged.');
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  {
    name: 'missing tools capability fails without sending tools/call',
    run: async () => {
      const downstream = await startMcpServer({ capabilities: {} });
      const manager = createManager(downstream);
      try {
        const outcome = await manager.callTool({ name: 'local_tool', arguments: {} }).settled;
        assertEqual(outcome.kind, 'failure', 'Capability failure should be controlled.');
        if (outcome.kind === 'failure') {
          assertEqual(outcome.code, 'mcp_capability_missing', 'Capability failure should have a stable code.');
        }
        assertEqual(downstream.calls.length, 0, 'No tools/call should be sent without capability.');
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  {
    name: 'manager-owned connection deadline remains classified as timeout',
    run: async () => {
      const downstream = await startMcpServer({ hangInitialize: true });
      const manager = createManager(downstream, 30);
      try {
        const outcome = await manager.callTool({ name: 'local_tool', arguments: {} }).settled;
        assert(outcome.kind === 'failure' && outcome.code === 'mcp_timeout', 'Connection deadline should retain timeout classification.');
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  {
    name: 'warm-up failure returns to idle and a later call reconnects',
    run: async () => {
      const downstream = await startMcpServer({ failInitializeCount: 1 });
      const manager = createManager(downstream);
      try {
        await manager.warmUp();
        const outcome = await manager.callTool({ name: 'local_tool', arguments: {} }).settled;
        assertEqual(outcome.kind, 'result', 'A Tool call should reconnect after warm-up failure.');
        assertEqual(downstream.initializeCount(), 2, 'Warm-up failure should not start a retry loop but a later call may reconnect.');
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  {
    name: 'one cancelled waiter does not cancel shared initialize',
    run: async () => {
      const downstream = await startMcpServer({ initializeDelayMs: 40 });
      const manager = createManager(downstream);
      const controller = new AbortController();
      try {
        const cancelled = manager.callTool({ name: 'local_tool', arguments: { waiter: 1 }, signal: controller.signal });
        const surviving = manager.callTool({ name: 'local_tool', arguments: { waiter: 2 } });
        controller.abort();
        const [cancelledOutcome, survivingOutcome] = await Promise.all([cancelled.settled, surviving.settled]);
        assert(cancelledOutcome.kind === 'failure' && cancelledOutcome.code === 'cancelled', 'Cancelled waiter should stop locally.');
        assertEqual(survivingOutcome.kind, 'result', 'Other waiter should retain the shared connection attempt.');
        assertEqual(downstream.initializeCount(), 1, 'Waiter cancellation must not duplicate or cancel initialize.');
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  {
    name: 'malformed request-scoped SSE invalidates the session as a protocol failure',
    run: async () => {
      const downstream = await startMcpServer({ malformedRequestSse: true });
      const manager = createManager(downstream, 1_000);
      try {
        const outcome = await manager.callTool({ name: 'local_tool', arguments: {} }).settled;
        assert(outcome.kind === 'failure' && outcome.code === 'mcp_protocol_failed', 'Malformed SSE should fail as protocol without waiting for timeout.');
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  {
    name: 'request-scoped SSE result settles before its response body drains',
    run: async () => {
      const downstream = await startMcpServer({ requestSseEndDelayMs: 60 });
      const manager = createManager(downstream);
      try {
        const exchange = manager.callTool({ name: 'local_tool', arguments: {} });
        const outcome = await exchange.settled;
        assertEqual(outcome.kind, 'result', 'SSE result should settle the caller.');
        let drained = false;
        void exchange.drained.then(() => { drained = true; });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assertEqual(drained, false, 'Request-scoped SSE body should retain drain after result.');
        await exchange.drained;
        assertEqual(drained, true, 'SSE EOF should release the request drain.');
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  {
    name: '202 Accepted receives its final result through the shared GET stream',
    run: async () => {
      const downstream = await startMcpServer({ sharedGetDelayMs: 10 });
      const manager = createManager(downstream);
      try {
        await manager.warmUp();
        const exchange = manager.callTool({ name: 'local_tool', arguments: {} });
        const outcome = await exchange.settled;
        assertEqual(outcome.kind, 'result', 'Shared GET response should settle the accepted call.');
        await exchange.drained;
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  {
    name: 'downstream timeout-shaped JSON-RPC error remains a call failure',
    run: async () => {
      const downstream = await startMcpServer({ jsonRpcErrorCode: ErrorCode.RequestTimeout });
      const manager = createManager(downstream);
      try {
        const outcome = await manager.callTool({ name: 'local_tool', arguments: {} }).settled;
        assert(outcome.kind === 'failure' && outcome.code === 'mcp_call_failed', 'Confirmed downstream errors must not masquerade as local timeout.');
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  {
    name: 'malformed direct JSON is classified as protocol failure',
    run: async () => {
      const downstream = await startMcpServer({ malformedDirectJson: true });
      const manager = createManager(downstream);
      try {
        const outcome = await manager.callTool({ name: 'local_tool', arguments: {} }).settled;
        assert(outcome.kind === 'failure' && outcome.code === 'mcp_protocol_failed', 'Malformed successful HTTP response should be a protocol failure.');
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  {
    name: 'unsupported content and raw missing content are rejected',
    run: async () => {
      const audioServer = await startMcpServer({
        result: { content: [{ type: 'audio', data: 'AA==', mimeType: 'audio/wav' }] },
      });
      const audioManager = createManager(audioServer);
      try {
        const audio = await audioManager.callTool({ name: 'local_tool', arguments: {} }).settled;
        assert(audio.kind === 'failure' && audio.code === 'mcp_result_unsupported', 'Audio should be unsupported.');
      } finally {
        await audioManager.close();
        await audioServer.close();
      }

      const missingServer = await startMcpServer({ result: { isError: false } });
      const missingManager = createManager(missingServer);
      try {
        const missing = await missingManager.callTool({ name: 'local_tool', arguments: {} }).settled;
        assert(missing.kind === 'failure' && missing.code === 'mcp_protocol_failed', 'Raw content omission must not be defaulted into success.');
      } finally {
        await missingManager.close();
        await missingServer.close();
      }
    },
  },
  {
    name: 'late response drains without reaching the timed-out caller or invalidating the session',
    run: async () => {
      const downstream = await startMcpServer({ delayFirstCallMs: 70 });
      const manager = createManager(downstream, 30);
      try {
        const exchange = manager.callTool({ name: 'local_tool', arguments: { attempt: 1 } });
        const outcome = await exchange.settled;
        assert(outcome.kind === 'failure' && outcome.code === 'mcp_timeout', 'First call should time out locally.');
        await exchange.drained;
        const next = await manager.callTool({ name: 'local_tool', arguments: { attempt: 2 } }).settled;
        assertEqual(next.kind, 'result', 'A late response should not invalidate an otherwise healthy session.');
        assertEqual(downstream.initializeCount(), 1, 'Timeout alone should not replace the downstream session.');
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  {
    name: 'timeout settles before drain and close releases the hanging HTTP exchange',
    run: async () => {
      const downstream = await startMcpServer({ hangCalls: true });
      const manager = createManager(downstream, 30);
      try {
        const exchange = manager.callTool({ name: 'local_tool', arguments: {} });
        const outcome = await exchange.settled;
        assert(outcome.kind === 'failure' && outcome.code === 'mcp_timeout', 'Hanging call should time out.');
        let drained = false;
        void exchange.drained.then(() => { drained = true; });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assertEqual(drained, false, 'Caller timeout must not release active drain early.');
        await manager.close();
        await exchange.drained;
        assertEqual(drained, true, 'Transport close should release the drain barrier.');
      } finally {
        await manager.close();
        await downstream.close();
      }
    },
  },
  ],
});
