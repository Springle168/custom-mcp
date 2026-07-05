import type { Request, Response } from 'express';
import {
  handleMcpPostRequest,
  type McpPostSession,
  type McpPostTransport,
} from '../../src/index.js';
import { getCurrentRequestHeaderView } from '../../src/runtime/request-context.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

interface FakeResponse extends Response {
  statusCodeValue?: number;
  ended?: boolean;
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

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing MCP POST request header context seam',
    tests: [
      { name: 'existing session runs handleRequest in context', run: testExistingSessionRunsHandleRequestInContext },
      { name: 'new session runs handleRequest in context', run: testNewSessionRunsHandleRequestInContext },
      { name: 'unknown session returns 404 without context', run: testUnknownSessionReturns404WithoutContext },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
