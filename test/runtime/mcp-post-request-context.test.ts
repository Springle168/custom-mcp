import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { RuntimeRulesConfig } from '../../src/config.js';
import { handleMcpPostRequest, type McpPostSession } from '../../src/runtime/mcp/mcp-post-handler.js';
import type { InitializationTrackingTransport } from '../../src/runtime/mcp/initialization-tracking-transport.js';
import type { McpPendingSession } from '../../src/runtime/mcp/pending-session.js';
import { getCurrentRequestHeaderView } from '../../src/runtime/request/request-context.js';
import { assert, assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';

const initialize = {
  jsonrpc: '2.0', id: 7, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};
const rules: RuntimeRulesConfig = {
  requestHeaders: {
    onInitialize: [{ readHeader: 'x-tools', apply: 'setToolList' }],
    onCallToolResult: [],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function request(body: unknown = initialize, rawHeaders: string[] = []): Request {
  return Object.assign(new EventEmitter(), { body, rawHeaders, headers: {}, aborted: false }) as unknown as Request;
}

function response() {
  const events = new EventEmitter();
  const res = Object.assign(events, {
    headersSent: false, writableFinished: false, writableEnded: false, destroyed: false,
    statusCode: 200, jsonValue: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    end() {
      this.headersSent = true; this.writableEnded = true; this.writableFinished = true;
      events.emit('finish'); events.emit('close'); return this;
    },
    json(value: unknown) { this.jsonValue = value; return this.end(); },
  });
  return res;
}

function harness(options: {
  body?: unknown;
  rawHeaders?: string[];
  handle?: (req: Request, res: Response) => Promise<void> | void;
  connect?: () => Promise<void>;
  wait?: () => Promise<boolean>;
  loggerThrows?: boolean;
} = {}) {
  const req = request(options.body ?? initialize, options.rawHeaders);
  const res = response();
  const sessions = new Map<string, McpPostSession>();
  const pendingSessions = new Set<McpPendingSession>();
  const closed = deferred<void>();
  let closeCalls = 0;
  let created = 0;
  let accepting = true;
  let isClosed = false;
  let passedSettings: unknown;
  let passedId: unknown;
  const logs: string[] = [];
  const session: McpPendingSession = {
    transport: {
      sessionId: 'new-session',
      handleRequest: options.handle ?? ((_req, response) => { response.end(); }),
      waitForInitialization: options.wait ?? (async () => true),
      stopInitializationTracking() {},
    } as unknown as InitializationTrackingTransport,
    server: { close() {} },
    get isClosed() { return isClosed; },
    closed: closed.promise,
    connect: options.connect ?? (async () => {}),
    async close() {
      if (!isClosed) { isClosed = true; closeCalls++; closed.resolve(); }
    },
  };
  return {
    req, res, sessions, pendingSessions, session, logs,
    stopAdmission() { accepting = false; },
    created: () => created,
    closes: () => closeCalls,
    settings: () => passedSettings,
    id: () => passedId,
    run: () => handleMcpPostRequest({
      req, res: res as unknown as Response, sessions, pendingSessions, rules,
      logger: { info(message) { logs.push(message); if (options.loggerThrows) { throw new Error('log failure'); } } },
      isAcceptingNewSessions: () => accepting,
      createSession(settings, id) { created++; passedSettings = settings; passedId = id; return session; },
    }),
  };
}

async function testContextAndPublication() {
  const h = harness({
    rawHeaders: ['X-Tools', '{"toolList":[]}'],
    handle(req, res) {
      assert(getCurrentRequestHeaderView()?.kind === 'valid', 'POST should run in strict context');
      req.emit('close'); // A fully received request normally closes before the response.
      res.end();
    },
  });
  await h.run();
  assertEqual(h.sessions.get('new-session'), h.session, 'Committed initialization should publish');
  assertEqual(h.pendingSessions.size, 0, 'Publication should transfer ownership');
  assertEqual(JSON.stringify(h.settings()), '{"requestedToolNames":[]}', 'Settings should precede factory');
  assertEqual(h.id(), 7, 'Verified envelope id should reach observer');
  assertEqual(getCurrentRequestHeaderView(), undefined, 'Context must not leak');
  assertIncludes(h.logs.join('\n'), 'setToolList', 'Policy summary should report safe feature');
}

async function testProtocolInputsDoNotApplyPolicy() {
  for (const body of [
    { ...initialize, jsonrpc: undefined }, { ...initialize, id: undefined },
    { ...initialize, id: null }, { ...initialize, params: {} },
    { jsonrpc: '2.0', id: 8, method: 'tools/list' }, [initialize, initialize],
  ]) {
    const h = harness({ body, rawHeaders: ['X-Tools', 'secret malformed JSON'] });
    await h.run();
    assertEqual(h.created(), 1, 'SDK should still own invalid protocol handling');
    assertEqual(h.id(), undefined, 'Invalid envelope must not provide a policy id');
    assertEqual(h.sessions.size, 0, 'Even an allocated id cannot publish invalid input');
    assertEqual(h.closes(), 1, 'Unpublished protocol resources should close');
  }
  const h = harness({ body: [initialize], rawHeaders: ['X-Tools', '{"toolList":[]}'] });
  await h.run();
  assertEqual(h.sessions.size, 1, 'Single-element initialize array should apply policy');
}

async function testSafeParameterError() {
  const h = harness({ rawHeaders: ['X-Tools', 'secret bad JSON'] });
  await h.run();
  assertEqual(h.res.statusCode, 400, 'Invalid feature parameter should be HTTP400');
  assertEqual(h.created(), 0, 'Parameter error must precede resource construction');
  const json = h.res.jsonValue as { id: number; error: { code: number } };
  assertEqual(json.id, 7, 'Feature error should correlate valid envelope');
  assertEqual(json.error.code, -32602, 'Feature error should use invalid params');
  assert(!JSON.stringify([h.res.jsonValue, h.logs]).includes('secret'), 'Response/logs cannot echo parse input');
}

async function testBothCompletionOrders() {
  const send = deferred<boolean>();
  const h = harness({ wait: () => send.promise });
  const running = h.run();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assertEqual(h.sessions.size, 0, 'HTTP completion alone cannot publish while send is pending');
  assertEqual(h.pendingSessions.size, 1, 'Pending send must retain ownership');
  send.resolve(true);
  await running;
  assertEqual(h.sessions.size, 1, 'Send completion after HTTP finish should publish');

  const handle = deferred<void>();
  const reverse = harness({ handle: () => handle.promise });
  const reverseRun = reverse.run();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assertEqual(reverse.sessions.size, 0, 'Send alone cannot publish before response finish');
  reverse.res.end(); handle.resolve();
  await reverseRun;
  assertEqual(reverse.sessions.size, 1, 'HTTP finish after committed send should publish');
}

async function testFailureAndAbortCleanup() {
  for (const wait of [async () => false, async (): Promise<boolean> => { throw new Error('send failed'); }]) {
    const h = harness({ wait });
    await h.run();
    assertEqual(h.sessions.size, 0, 'Error/rejected send cannot publish');
    assertEqual(h.closes(), 1, 'Failed initialization closes once');
  }
  for (const mode of ['connect', 'handle', 'send']) {
    const never = new Promise<void>(() => {});
    const h = harness({
      ...(mode === 'connect' ? { connect: () => never } : {}),
      ...(mode === 'handle' ? { handle: () => never } : {}),
      ...(mode === 'send' ? { wait: () => never.then(() => true) } : {}),
    });
    const running = h.run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    h.req.emit('aborted');
    await running;
    assertEqual(h.sessions.size, 0, 'Abort must terminate wait without publishing');
    assertEqual(h.closes(), 1, 'Abort must close pending resource');
    assertEqual(h.pendingSessions.size, 0, 'Abort must release pending owner');
    assertEqual(h.req.listenerCount('aborted'), 0, 'Request listeners should release');
    assertEqual(h.res.listenerCount('finish'), 0, 'Response listeners should release');
  }
}

async function testShutdownAndFactoryExceptions() {
  const gate = deferred<void>();
  const h = harness({ connect: () => gate.promise });
  const running = h.run();
  assertEqual(h.pendingSessions.size, 1, 'Pending registration must happen before connect awaits');
  h.stopAdmission();
  await h.session.close();
  await running;
  gate.resolve();
  assertEqual(h.sessions.size, 0, 'Shutdown during connect must forbid late publication');
  assertEqual(h.res.statusCode, 503, 'Shutdown must release unhandled HTTP request');
  assertEqual(h.closes(), 1, 'Entry/shutdown close should be idempotent');

  const broken = harness({ connect: async () => { throw new Error('secret internal failure'); } });
  await broken.run();
  assertEqual(broken.res.statusCode, 500, 'Internal connect failure should send safe response');
  assertEqual(broken.closes(), 1, 'Failed connect must close pending transport');
  assert(!JSON.stringify(broken.res.jsonValue).includes('secret'), 'Internal response cannot echo errors');
}

async function testExistingSessionSkipsInitialization() {
  const h = harness({ rawHeaders: ['X-Tools', 'invalid', 'x-tools', 'also invalid'] });
  h.req.headers['mcp-session-id'] = 'existing';
  h.sessions.set('existing', h.session);
  await h.run();
  assertEqual(h.created(), 0, 'Existing session must not parse initialization parameters');
  assertEqual(h.res.statusCode, 200, 'Damaged initialization headers must not affect later calls');
  const logging = harness({ loggerThrows: true });
  await logging.run();
  assertEqual(logging.sessions.size, 1, 'Failing logger cannot undo successful publication');
}

await runTestSuite({
  title: 'MCP POST policy context and publication lifecycle',
  tests: [
    { name: 'context and atomic publication', run: testContextAndPublication },
    { name: 'joint envelope validation and SDK ownership', run: testProtocolInputsDoNotApplyPolicy },
    { name: 'safe parameter errors before resources', run: testSafeParameterError },
    { name: 'both send and HTTP completion orders', run: testBothCompletionOrders },
    { name: 'send failure and interrupted waits', run: testFailureAndAbortCleanup },
    { name: 'shutdown and connect exceptions', run: testShutdownAndFactoryExceptions },
    { name: 'existing session and logger isolation', run: testExistingSessionSkipsInitialization },
  ],
});
