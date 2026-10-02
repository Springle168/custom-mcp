import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ApplicationLifecycle } from '../../src/runtime/application/application-lifecycle.js';
import type { ToolInvocationContext } from '../../src/runtime/invocation/tool-invocation-context.js';
import { createMcpHttpApp } from '../../src/runtime/mcp/http-app.js';
import type { McpPostSession } from '../../src/runtime/mcp/mcp-post-handler.js';
import type { McpPendingSession } from '../../src/runtime/mcp/pending-session.js';
import type { WorkspaceToolService } from '../../src/tools/index.js';
import { createTestConfigStore } from '../helpers/runtime-config.js';
import { assert, assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';

async function createHarness() {
  const sessions = new Map<string, McpPostSession>();
  const pendingSessions = new Set<McpPendingSession>();
  const invocations: ToolInvocationContext[] = [];
  const messages: string[] = [];
  const closedSessions: string[] = [];
  let accepting = true;
  let listCalls = 0;
  let lifecycle: ApplicationLifecycle;
  const service: WorkspaceToolService = {
    getDefinitions() {
      listCalls++;
      return [{
        name: 'probe_tool',
        description: 'Tests HTTP workspace service wiring.',
        inputSchema: { type: 'object' },
      }];
    },
    async routeToolCall(name, _args, _context, invocation) {
      invocations.push(invocation);
      return {
        content: [{ type: 'text', text: `Called ${name}` }],
        isError: false,
      };
    },
  };
  const app = createMcpHttpApp({
    configStore: createTestConfigStore({
      rootDir: process.cwd(),
      rules: {
        requestHeaders: {
          onInitialize: [],
          onCallToolResult: [{
            match: [{ name: 'x-client', value: 'http-test' }],
            enable: ['structuredContentDup'],
          }],
        },
      },
    }),
    toolService: service,
    sessions,
    pendingSessions,
    logger: {
      info: (message) => messages.push(message),
      logToolCall() {},
      logToolResult() {},
    },
    isAcceptingNewSessions: () => accepting && lifecycle.isAcceptingNewSessions,
    closeSession: (sessionId) => {
      closedSessions.push(sessionId);
      return lifecycle.closeSession(sessionId);
    },
  });
  const listener = app.listen(0, '127.0.0.1');
  lifecycle = new ApplicationLifecycle({
    listener,
    sessions,
    pendingSessions,
    androidRuntime: { close() {} },
    externalRuntime: { close() {} },
    logger: { close() {} },
  });
  await once(listener, 'listening');
  const address = listener.address();
  assert(address !== null && typeof address !== 'string', 'HTTP app should bind a loopback port');

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    sessions,
    invocations,
    messages,
    closedSessions,
    listCalls: () => listCalls,
    stopAdmission: () => { accepting = false; },
    close: () => lifecycle.close(),
  };
}

async function testSessionsShareServiceAndKeepRequestPolicyIsolated(): Promise<void> {
  const harness = await createHarness();
  const first = new Client({ name: 'first-http-client', version: '1.0.0' });
  const second = new Client({ name: 'second-http-client', version: '1.0.0' });
  const firstTransport = new StreamableHTTPClientTransport(new URL(harness.url), {
    requestInit: { headers: { 'X-Client': 'http-test' } },
  });
  const secondTransport = new StreamableHTTPClientTransport(new URL(harness.url));
  try {
    await first.connect(firstTransport);
    await second.connect(secondTransport);
    assertEqual(harness.sessions.size, 2, 'Both initialized sessions should be registered');
    assert(firstTransport.sessionId !== undefined && firstTransport.sessionId.startsWith('session_'), 'Production session IDs should be used');
    assert(secondTransport.sessionId !== firstTransport.sessionId, 'Session identities should be distinct');

    for (const client of [first, second]) {
      const listed = await client.listTools();
      assertEqual(listed.tools.map((tool) => tool.name).join(','), 'probe_tool', 'Both sessions should use the supplied service');
    }
    assertEqual(harness.listCalls(), 2, 'One application service should handle both tools/list calls');

    const firstResult = await first.callTool({ name: 'probe_tool', arguments: {} });
    const secondResult = await second.callTool({ name: 'probe_tool', arguments: {} });
    assert(firstResult.structuredContent !== undefined, 'Matching HTTP headers should enable result adaptation');
    assert(secondResult.structuredContent === undefined, 'Request policy must not leak across sessions');
    assertEqual(harness.invocations.length, 2, 'Both tools/call requests should reach the supplied service');
    assertEqual(harness.invocations[0]?.sessionId, firstTransport.sessionId, 'Invocation should carry the first session ID');
    assertEqual(harness.invocations[1]?.sessionId, secondTransport.sessionId, 'Invocation should carry the second session ID');
    assert(harness.invocations[0]?.signal instanceof AbortSignal, 'Transport cancellation should reach the invocation');

    const firstSessionId = firstTransport.sessionId;
    assert(firstSessionId !== undefined, 'Initialized transport should have a session ID');
    await firstTransport.terminateSession();
    assertEqual(harness.closedSessions[0], firstSessionId, 'DELETE should delegate to the application lifecycle');
    assert(!harness.sessions.has(firstSessionId), 'Deleted session should be removed');
    assertEqual(harness.sessions.size, 1, 'Deleting one session should leave the other session alive');
    await second.listTools();
  } finally {
    await Promise.all([first.close(), second.close()]);
    await harness.close();
  }
}

async function testMissingAndStaleSessionResponses(): Promise<void> {
  const harness = await createHarness();
  try {
    for (const method of ['GET', 'DELETE']) {
      const missing = await fetch(harness.url, { method });
      assertEqual(missing.status, 400, `${method} without session ID should return 400`);
      assertIncludes(await missing.text(), 'Missing session ID', 'Missing-session error text should be preserved');
      const stale = await fetch(harness.url, {
        method,
        headers: { 'mcp-session-id': 'stale-session' },
      });
      assertEqual(stale.status, 404, `${method} with stale session ID should return 404`);
      assertIncludes(await stale.text(), 'Session not found or expired', 'Stale-session error text should be preserved');
    }
    const stalePost = await fetch(harness.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'stale-session' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assertEqual(stalePost.status, 404, 'POST with stale session ID should return 404');
    assertEqual(await stalePost.text(), '', 'Stale POST response should remain empty');
    assertEqual(harness.sessions.size, 0, 'Invalid session requests must not allocate sessions');
  } finally {
    await harness.close();
  }
}

async function testAdmissionCallbackRejectsInitialization(): Promise<void> {
  const harness = await createHarness();
  harness.stopAdmission();
  try {
    const response = await fetch(harness.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assertEqual(response.status, 503, 'Stopped admission should reject initialization before allocating a transport');
    await response.text();
    assertEqual(harness.sessions.size, 0, 'Rejected initialization should not publish a session');
  } finally {
    await harness.close();
  }
}

async function testGetDelegatesToRegisteredTransport(): Promise<void> {
  const harness = await createHarness();
  let calls = 0;
  harness.sessions.set('get-session', {
    transport: {
      sessionId: 'get-session',
      handleRequest(req, res) {
        calls++;
        assertEqual(req.method, 'GET', 'Registered transport should receive the GET request');
        res.status(200).send('registered transport');
      },
    },
    server: { close() {} },
  });
  try {
    const response = await fetch(harness.url, {
      headers: { 'mcp-session-id': 'get-session' },
    });
    assertEqual(await response.text(), 'registered transport', 'GET should forward the transport response');
    assertEqual(calls, 1, 'GET should call the registered transport once');
  } finally {
    await harness.close();
  }
}

await runTestSuite({
  title: 'Testing MCP HTTP application wiring',
  tests: [
    { name: 'sessions share service and isolate request policy', run: testSessionsShareServiceAndKeepRequestPolicyIsolated },
    { name: 'missing and stale session responses', run: testMissingAndStaleSessionResponses },
    { name: 'admission callback rejects initialization', run: testAdmissionCallbackRejectsInitialization },
    { name: 'GET delegates to registered transport', run: testGetDelegatesToRegisteredTransport },
  ],
});
