import type { Request, Response } from 'express';
import type { RuntimeRulesConfig } from '../../src/config.js';
import type { ConfigStore } from '../../src/runtime/config-store.js';
import {
  handleMcpPostRequest,
  type McpPostSession,
  type McpPostTransport,
} from '../../src/runtime/mcp-post-handler.js';
import { getCurrentRequestHeaderView } from '../../src/runtime/request-context.js';
import type { RequestHeaderPolicyLogMetadata } from '../../src/runtime/request-header-policy.js';
import { createToolCallRequestHandler } from '../../src/runtime/tool-call-handler.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import { createTestConfigStore } from '../helpers/runtime-config.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

interface FakeResponse extends Response {
  statusCodeValue?: number;
  ended?: boolean;
}

interface LoggedToolResult {
  readonly result: ToolCallResult;
  readonly metadata: RequestHeaderPolicyLogMetadata | undefined;
}

function matchingRules(): RuntimeRulesConfig {
  return {
    requestHeaders: [
      {
        match: [{ name: 'x-client', value: 'android-studio' }],
        enable: ['structuredContentDup'],
      },
    ],
  };
}

function createToolCallStore(): ConfigStore {
  return createTestConfigStore({
    rootDir: process.cwd(),
    rules: matchingRules(),
  });
}

function createRequest(options: {
  readonly rawHeaders: readonly string[];
  readonly sessionId?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}): Request {
  return {
    rawHeaders: options.rawHeaders,
    body: options.body ?? { jsonrpc: '2.0' },
    headers: {
      ...(options.headers ?? {}),
      ...(options.sessionId !== undefined ? { 'mcp-session-id': options.sessionId } : {}),
    },
  } as unknown as Request;
}

function createResponse(): FakeResponse {
  const response = {
    status(code: number) {
      this.statusCodeValue = code;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    json(value: unknown) {
      this.jsonValue = value;
      return this;
    },
  } as FakeResponse & { jsonValue?: unknown };

  return response;
}

function createSession(transport: McpPostTransport): McpPostSession {
  return {
    transport,
    server: {
      close() {},
    },
  };
}

function readContextHeaderValue(name: string): string | undefined {
  const view = getCurrentRequestHeaderView();
  assert(view?.kind === 'valid', 'Request context should contain a valid strict header view');
  const state = view.headers.get(name);
  assert(state?.kind === 'single', `${name} should be a single header in strict view`);
  return state.value;
}

function textResult(text: string): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

function getStructuredContentWrapper(result: ToolCallResult): Record<string, unknown> {
  const { structuredContent } = result;
  assert(
    typeof structuredContent === 'object' && structuredContent !== null && !Array.isArray(structuredContent),
    'Expected structuredContent wrapper object',
  );
  return structuredContent as Record<string, unknown>;
}

async function testExistingSessionRunsHandleRequestInContext(): Promise<void> {
  const sessions = new Map<string, McpPostSession>();
  const req = createRequest({
    sessionId: 'session-1',
    rawHeaders: ['X-Client', 'from-raw'],
    headers: { 'x-client': 'from-headers' },
  });
  const res = createResponse();
  let handleCalled = false;
  sessions.set('session-1', createSession({
    sessionId: 'session-1',
    handleRequest(receivedReq, receivedRes, body) {
      handleCalled = true;
      assertEqual(receivedReq, req, 'Transport should receive the original request object');
      assertEqual(receivedRes, res, 'Transport should receive the original response object');
      assertEqual(body, req.body, 'POST body should be forwarded to the transport');
      assertEqual(readContextHeaderValue('x-client'), 'from-raw', 'Strict view should come from rawHeaders, not req.headers');
    },
  }));

  await handleMcpPostRequest({
    req,
    res,
    sessions,
    logger: { info() {} },
    createSession() {
      throw new Error('Existing session branch should not create a new session');
    },
  });

  assert(handleCalled, 'Existing session transport should be called');
  assertEqual(getCurrentRequestHeaderView(), undefined, 'Request context should not leak after POST handling');
}

async function testNewSessionRunsHandleRequestInContext(): Promise<void> {
  const sessions = new Map<string, McpPostSession>();
  const req = createRequest({ rawHeaders: ['X-Client', 'new-session-client'] });
  const res = createResponse();
  let createSessionCalled = false;
  let handleCalled = false;

  await handleMcpPostRequest({
    req,
    res,
    sessions,
    logger: { info() {} },
    createSession() {
      createSessionCalled = true;
      return createSession({
        sessionId: 'new-session',
        handleRequest() {
          handleCalled = true;
          assertEqual(readContextHeaderValue('x-client'), 'new-session-client', 'New session branch should run transport in request context');
        },
      });
    },
  });

  assert(createSessionCalled, 'New POST without a session id should create a session');
  assert(handleCalled, 'New session transport should be called');
  assert(sessions.has('new-session'), 'New transport sessionId should be stored after handling');
}

async function testUnknownSessionReturns404WithoutContext(): Promise<void> {
  const sessions = new Map<string, McpPostSession>();
  const req = createRequest({ sessionId: 'missing', rawHeaders: ['X-Client', 'ignored'] });
  const res = createResponse();
  let createSessionCalled = false;

  await handleMcpPostRequest({
    req,
    res,
    sessions,
    logger: { info() {} },
    createSession() {
      createSessionCalled = true;
      return createSession({ handleRequest() {} });
    },
  });

  assertEqual(res.statusCodeValue, 404, 'Unknown session POST should return 404');
  assertEqual(res.ended, true, 'Unknown session POST should end the response');
  assertEqual(createSessionCalled, false, 'Unknown session branch should not create a new session');
  assertEqual(getCurrentRequestHeaderView(), undefined, 'Unknown session branch should not establish request context');
}

async function testShutdownRejectsNewSessionAdmission(): Promise<void> {
  const sessions = new Map<string, McpPostSession>();
  const res = createResponse();
  let createCalls = 0;

  await handleMcpPostRequest({
    req: createRequest({ rawHeaders: [] }),
    res,
    sessions,
    logger: { info() {} },
    isAcceptingNewSessions: () => false,
    createSession() {
      createCalls++;
      return createSession({ handleRequest() {} });
    },
  });

  assertEqual(res.statusCodeValue, 503, 'Shutdown should reject new session initialization');
  assertEqual(res.ended, true, 'Rejected initialization should end the response');
  assertEqual(createCalls, 0, 'Rejected initialization must not allocate an MCP session');
}

async function testShutdownRaceClosesUnpublishedSession(): Promise<void> {
  const sessions = new Map<string, McpPostSession>();
  const res = createResponse();
  let accepting = true;
  let closeCalls = 0;

  await handleMcpPostRequest({
    req: createRequest({ rawHeaders: [] }),
    res,
    sessions,
    logger: { info() {} },
    isAcceptingNewSessions: () => accepting,
    createSession() {
      return {
        transport: {
          sessionId: 'raced-session',
          handleRequest() {
            accepting = false;
          },
        },
        server: {
          close() {
            closeCalls++;
          },
        },
      };
    },
  });

  assertEqual(closeCalls, 1, 'A session initialized during shutdown should be closed immediately');
  assertEqual(sessions.size, 0, 'A shutdown-raced session must never be published');
  assertEqual(res.statusCodeValue, 503, 'An unsent initialization response should report shutdown');
}

async function testSessionCreationHeadersDoNotEnableLaterSessionRequest(): Promise<void> {
  const sessions = new Map<string, McpPostSession>();
  const results: ToolCallResult[] = [];
  const loggedResults: LoggedToolResult[] = [];
  const handler = createToolCallRequestHandler({
    configStore: createToolCallStore(),
    logger: {
      logToolCall() {},
      logToolResult(_toolName, result, _durationMs, context) {
        loggedResults.push({
          result,
          metadata: context.requestHeaderPolicy,
        });
      },
    },
    routeToolCall: async (name) => textResult(name),
  });
  const transport: McpPostTransport = {
    sessionId: 'session-1',
    async handleRequest() {
      const result = await handler({
        params: {
          name: `fake_tool_${results.length}`,
          arguments: {},
        },
      });
      results.push(result);
    },
  };

  await handleMcpPostRequest({
    req: createRequest({ rawHeaders: ['X-Client', 'android-studio'] }),
    res: createResponse(),
    sessions,
    logger: { info() {} },
    createSession() {
      return createSession(transport);
    },
  });

  await handleMcpPostRequest({
    req: createRequest({
      sessionId: 'session-1',
      rawHeaders: ['Mcp-Session-Id', 'session-1'],
    }),
    res: createResponse(),
    sessions,
    logger: { info() {} },
    createSession() {
      throw new Error('Existing session branch should not create a new session');
    },
  });

  assert(sessions.has('session-1'), 'Created session should be retained for the follow-up POST');
  assertEqual(results.length, 2, 'Fake transport should process both POST requests');
  assertEqual(loggedResults.length, 2, 'Tool-call logger should record both POST-scoped calls');

  const [firstResult, secondResult] = results;
  assert(firstResult !== undefined, 'First POST should produce a tool result');
  assert(secondResult !== undefined, 'Second POST should produce a tool result');
  assertEqual(loggedResults[0]?.result, firstResult, 'First POST logger should receive the returned result');
  assertEqual(loggedResults[1]?.result, secondResult, 'Later same-session POST logger should receive the returned result');
  assertEqual(
    getStructuredContentWrapper(firstResult).content,
    firstResult.content,
    'Session creation POST with a matching header should enable structuredContent for that POST only',
  );
  assertEqual(
    getStructuredContentWrapper(firstResult).isError,
    false,
    'Matched POST wrapper should normalize isError',
  );

  assert(!('structuredContent' in secondResult), 'Later same-session POST without matching header should not inherit structuredContent');

  assertEqual(
    loggedResults[0]?.metadata?.enabledFeatures.join(','),
    'structuredContentDup',
    'First POST metadata should report the matched feature',
  );
  assertEqual(
    loggedResults[1]?.metadata?.enabledFeatures.length,
    0,
    'Later same-session POST metadata should report no enabled features',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing MCP POST request header context seam',
    tests: [
      { name: 'existing session runs handleRequest in context', run: testExistingSessionRunsHandleRequestInContext },
      { name: 'new session runs handleRequest in context', run: testNewSessionRunsHandleRequestInContext },
      { name: 'unknown session returns 404 without context', run: testUnknownSessionReturns404WithoutContext },
      { name: 'shutdown rejects new session admission', run: testShutdownRejectsNewSessionAdmission },
      { name: 'shutdown race closes unpublished session', run: testShutdownRaceClosesUnpublishedSession },
      { name: 'session creation headers do not enable later session request', run: testSessionCreationHeadersDoNotEnableLaterSessionRequest },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
