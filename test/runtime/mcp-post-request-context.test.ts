import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { RuntimeRulesConfig } from '../../src/config.js';
import {
  handleMcpPostRequest,
  type McpPostSession,
} from '../../src/runtime/mcp/mcp-post-handler.js';
import type { InitializationTrackingTransport } from '../../src/runtime/mcp/initialization-tracking-transport.js';
import type { McpPendingSession } from '../../src/runtime/mcp/pending-session.js';
import {
  getCurrentRequestHeaderView,
  runWithRequestHeaderContext,
} from '../../src/runtime/request/request-context.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request/request-header-view.js';
import { createInitializeHeaderExtension } from '../../src/runtime/request/initialize-header-extension.js';
import type { McpSessionOptions, RuntimeExtensions } from '../../src/runtime/runtime-extensions.js';
import { assert, assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';

const initialize = {
  jsonrpc: '2.0',
  id: 7,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
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
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function request(body: unknown = initialize, rawHeaders: string[] = []): Request {
  return Object.assign(new EventEmitter(), {
    body,
    rawHeaders,
    headers: {},
    aborted: false,
  }) as unknown as Request;
}

function response() {
  const events = new EventEmitter();
  const res = Object.assign(events, {
    headersSent: false,
    writableFinished: false,
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    jsonValue: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.headersSent = true;
      this.writableEnded = true;
      this.writableFinished = true;
      events.emit('finish');
      events.emit('close');
      return this;
    },
    json(value: unknown) {
      this.jsonValue = value;
      return this.end();
    },
  });
  return res;
}

function harness(
  options: {
    body?: unknown;
    rawHeaders?: string[];
    handle?: (req: Request, res: Response) => Promise<void> | void;
    connect?: () => Promise<void>;
    wait?: () => Promise<boolean>;
    sendRejected?: Promise<void>;
    loggerThrows?: boolean;
    factoryThrows?: boolean;
    extensions?: RuntimeExtensions;
    noExtensions?: boolean;
  } = {},
) {
  const req = request(options.body ?? initialize, options.rawHeaders);
  const res = response();
  const sessions = new Map<string, McpPostSession>();
  const pendingSessions = new Set<McpPendingSession>();
  const closed = deferred<void>();
  let closeCalls = 0;
  let created = 0;
  let accepting = true;
  let isClosed = false;
  let passedSettings: McpSessionOptions | undefined;
  let passedId: unknown;
  const logs: string[] = [];
  const publications: string[] = [];
  let preparations = 0;
  const defaults: McpSessionOptions = {
    toolService: {
      getDefinitions: () => [],
      async routeToolCall() {
        return { content: [], isError: false };
      },
    },
  };
  const logger = {
    info(message: string) {
      logs.push(message);
      if (options.loggerThrows) {
        throw new Error('log failure');
      }
    },
  };
  const selected = options.extensions ?? {
    prepareSession: createInitializeHeaderExtension(rules, logger),
  };
  const extensions: RuntimeExtensions | undefined = options.noExtensions
    ? undefined
    : {
        ...selected,
        ...(selected.prepareSession === undefined
          ? {}
          : {
              prepareSession(rawHeaders, settings) {
                preparations++;
                const prepared = selected.prepareSession!(rawHeaders, settings);
                if (!prepared.accepted) {
                  return prepared;
                }
                return {
                  ...prepared,
                  onPublished(sessionId) {
                    assertEqual(
                      sessions.get(sessionId),
                      session,
                      'Callback must observe the routable session',
                    );
                    assertEqual(
                      pendingSessions.size,
                      0,
                      'Callback must observe transferred pending ownership',
                    );
                    assertEqual(
                      logs[0],
                      `New session: ${sessionId}`,
                      'New session log must precede observation',
                    );
                    publications.push(sessionId);
                    return prepared.onPublished?.(sessionId);
                  },
                };
              },
            }),
      };
  const session: McpPendingSession = {
    transport: {
      sessionId: 'new-session',
      initializationSendRejected: options.sendRejected ?? new Promise<void>(() => {}),
      handleRequest:
        options.handle ??
        ((_req, response) => {
          response.end();
        }),
      waitForInitialization: options.wait ?? (async () => true),
      stopInitializationTracking() {},
    } as unknown as InitializationTrackingTransport,
    server: { close() {} },
    get isClosed() {
      return isClosed;
    },
    closed: closed.promise,
    connect: options.connect ?? (async () => {}),
    async close() {
      if (!isClosed) {
        isClosed = true;
        closeCalls++;
        closed.resolve();
      }
    },
  };
  return {
    req,
    res,
    sessions,
    pendingSessions,
    session,
    logs,
    defaults,
    publications,
    stopAdmission() {
      accepting = false;
    },
    created: () => created,
    closes: () => closeCalls,
    settings: () => passedSettings,
    id: () => passedId,
    preparations: () => preparations,
    run: () =>
      handleMcpPostRequest({
        req,
        res: res as unknown as Response,
        sessions,
        pendingSessions,
        defaultSessionOptions: defaults,
        ...(extensions === undefined ? {} : { extensions }),
        logger,
        isAcceptingNewSessions: () => accepting,
        createSession(settings, id) {
          created++;
          passedSettings = settings;
          passedId = id;
          if (options.factoryThrows) {
            throw new Error('secret factory failure');
          }
          return session;
        },
      }),
  };
}

async function testContextAndPublication() {
  const logs: string[] = [];
  const h = harness({
    rawHeaders: ['X-Tools', '{"toolList":[]}'],
    extensions: {
      prepareSession: createInitializeHeaderExtension(rules, {
        info: (message) => {
          logs.push(message);
        },
      }),
      runWithPostContext: (rawHeaders, action) =>
        runWithRequestHeaderContext(createStrictRequestHeaderView(rawHeaders), action),
    },
    handle(req, res) {
      assert(getCurrentRequestHeaderView()?.kind === 'valid', 'POST should run in strict context');
      req.emit('close'); // A fully received request normally closes before the response.
      res.end();
    },
  });
  await h.run();
  assertEqual(h.sessions.get('new-session'), h.session, 'Committed initialization should publish');
  assertEqual(h.pendingSessions.size, 0, 'Publication should transfer ownership');
  assert(
    h.settings()?.toolService !== h.defaults.toolService,
    'Requested list should create a session service before factory',
  );
  assertEqual(
    h.settings()?.toolService.getDefinitions().length,
    0,
    'Explicit empty list should restrict service',
  );
  assertEqual(h.id(), 7, 'Verified envelope id should reach observer');
  assertEqual(getCurrentRequestHeaderView(), undefined, 'Context must not leak');
  assertIncludes(logs.join('\n'), 'setToolList', 'Policy summary should report safe feature');
  assertEqual(
    h.publications.join(','),
    'new-session',
    'Publication callback should run exactly once',
  );
}

async function testProtocolInputsDoNotApplyPolicy() {
  for (const body of [
    { ...initialize, jsonrpc: undefined },
    { ...initialize, id: undefined },
    { ...initialize, id: null },
    { ...initialize, params: {} },
    { jsonrpc: '2.0', id: 8, method: 'tools/list' },
    [initialize, initialize],
  ]) {
    const h = harness({ body, rawHeaders: ['X-Tools', 'secret malformed JSON'] });
    await h.run();
    assertEqual(h.created(), 1, 'SDK should still own invalid protocol handling');
    assertEqual(h.id(), undefined, 'Invalid envelope must not provide a policy id');
    assertEqual(h.sessions.size, 0, 'Even an allocated id cannot publish invalid input');
    assertEqual(h.closes(), 1, 'Unpublished protocol resources should close');
    assertEqual(h.preparations(), 0, 'Protocol errors must bypass preparation');
    assertEqual(h.publications.length, 0, 'Invalid protocol must not notify publication');
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
  assertEqual(h.publications.length, 0, 'Rejected preparation cannot notify publication');
  const json = h.res.jsonValue as { id: number; error: { code: number } };
  assertEqual(json.id, 7, 'Feature error should correlate valid envelope');
  assertEqual(json.error.code, -32602, 'Feature error should use invalid params');
  assert(
    !JSON.stringify([h.res.jsonValue, h.logs]).includes('secret'),
    'Response/logs cannot echo parse input',
  );
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
  reverse.res.end();
  handle.resolve();
  await reverseRun;
  assertEqual(reverse.sessions.size, 1, 'HTTP finish after committed send should publish');
}

async function testFailureAndAbortCleanup() {
  for (const wait of [
    async () => false,
    async (): Promise<boolean> => {
      throw new Error('send failed');
    },
  ]) {
    const h = harness({ wait });
    await h.run();
    assertEqual(h.sessions.size, 0, 'Error/rejected send cannot publish');
    assertEqual(h.closes(), 1, 'Failed initialization closes once');
    assertEqual(h.publications.length, 0, 'Failed send cannot notify publication');
  }
  const sdkFailure = harness({
    handle() {
      throw new Error('secret SDK failure');
    },
  });
  await sdkFailure.run();
  assertEqual(sdkFailure.sessions.size, 0, 'SDK handleRequest exceptions cannot publish');
  assertEqual(sdkFailure.closes(), 1, 'SDK exceptions should close pending resources');
  assertEqual(sdkFailure.publications.length, 0, 'SDK exceptions cannot notify publication');
  assert(
    !JSON.stringify(sdkFailure.res.jsonValue).includes('secret'),
    'SDK exception text cannot escape',
  );
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
    assertEqual(h.publications.length, 0, 'Abort cannot notify publication');
  }
}

async function testSendRejectionTerminatesPendingHttp() {
  for (const handlePending of [true, false]) {
    const rejected = deferred<void>();
    const h = harness({
      sendRejected: rejected.promise,
      handle: () => (handlePending ? new Promise<void>(() => {}) : undefined),
    });
    const running = h.run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assertEqual(h.pendingSessions.size, 1, 'Unfinished HTTP should retain pending ownership');
    rejected.resolve();
    await running;
    assertEqual(h.sessions.size, 0, 'Rejected send must not publish');
    assertEqual(h.pendingSessions.size, 0, 'Rejected send must release pending ownership');
    assertEqual(h.closes(), 1, 'Rejected send must close pending resources once');
    assertEqual(h.res.statusCode, 500, 'Unsent HTTP response should end as an internal failure');
    assert(h.res.writableEnded, 'Rejected send must end HTTP without client interruption');
    assertEqual(h.res.listenerCount('finish'), 0, 'Rejected send must release HTTP observers');
    assertEqual(h.publications.length, 0, 'Rejected send cannot notify publication');
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
  assertEqual(h.publications.length, 0, 'Shutdown cannot notify publication');

  const broken = harness({
    connect: async () => {
      throw new Error('secret internal failure');
    },
  });
  await broken.run();
  assertEqual(broken.res.statusCode, 500, 'Internal connect failure should send safe response');
  assertEqual(broken.closes(), 1, 'Failed connect must close pending transport');
  assert(
    !JSON.stringify(broken.res.jsonValue).includes('secret'),
    'Internal response cannot echo errors',
  );
  assertEqual(broken.publications.length, 0, 'Connect failure cannot notify publication');

  const factory = harness({ factoryThrows: true });
  await factory.run();
  assertEqual(factory.res.statusCode, 500, 'Factory exceptions should send a safe internal error');
  assertEqual(
    factory.pendingSessions.size,
    0,
    'Factory failure should not register nonexistent resources',
  );
  assertEqual(factory.publications.length, 0, 'Factory failure cannot notify publication');
  assertEqual(
    factory.res.listenerCount('finish'),
    0,
    'Factory failure should release HTTP observers',
  );
}

async function testExistingSessionSkipsInitialization() {
  const h = harness({ rawHeaders: ['X-Tools', 'invalid', 'x-tools', 'also invalid'] });
  h.req.headers['mcp-session-id'] = 'existing';
  h.sessions.set('existing', h.session);
  await h.run();
  assertEqual(h.created(), 0, 'Existing session must not parse initialization parameters');
  assertEqual(h.preparations(), 0, 'Existing session must bypass preparation hook');
  assertEqual(h.publications.length, 0, 'Existing session must not repeat publication observation');
  assertEqual(h.res.statusCode, 200, 'Damaged initialization headers must not affect later calls');
  let bridgeCalls = 0;
  const bridged = harness({
    extensions: {
      prepareSession() {
        throw new Error('existing session must not prepare');
      },
      runWithPostContext: (_rawHeaders, action) => {
        bridgeCalls++;
        return action();
      },
    },
  });
  bridged.req.headers['mcp-session-id'] = 'existing';
  bridged.sessions.set('existing', bridged.session);
  await bridged.run();
  assertEqual(bridgeCalls, 1, 'Existing-session dispatch must still use the injected POST bridge');
  assertEqual(
    bridged.preparations(),
    0,
    'Bridge injection must not trigger initialization preparation',
  );
  const logging = harness({ loggerThrows: true });
  await logging.run();
  assertEqual(logging.sessions.size, 1, 'Failing logger cannot undo successful publication');
}

async function testDefaultAndAlternativeHooks() {
  const plain = harness({
    noExtensions: true,
    rawHeaders: ['X-Tools', 'secret malformed JSON'],
    handle(_req, res) {
      assertEqual(
        getCurrentRequestHeaderView(),
        undefined,
        'Core must not construct a header context without a bridge',
      );
      res.end();
    },
  });
  await plain.run();
  assertEqual(
    plain.settings(),
    plain.defaults,
    'No-hook path should preserve default options identity',
  );
  assertEqual(plain.sessions.size, 1, 'No-hook initialization should ignore policy parameters');
  let prepared = 0;
  const alternative = harness({
    extensions: {
      prepareSession(rawHeaders, defaults) {
        prepared++;
        assertEqual(rawHeaders.length, 0, 'Hook should receive raw input');
        return { accepted: true, options: { ...defaults, instructions: 'alternative extension' } };
      },
    },
  });
  await alternative.run();
  assertEqual(prepared, 1, 'Alternative preparation should run exactly once');
  assertEqual(
    alternative.settings()?.instructions,
    'alternative extension',
    'Final options should reach the factory',
  );
  assertEqual(
    alternative.publications.length,
    1,
    'Alternative callback should run after successful publication',
  );

  const stopped = harness({
    extensions: {
      prepareSession() {
        throw new Error('must not run');
      },
    },
  });
  stopped.stopAdmission();
  await stopped.run();
  assertEqual(stopped.preparations(), 0, 'Admission must precede preparation');
  assertEqual(stopped.created(), 0, 'Stopped admission must not allocate resources');
}

async function testPreparationFailuresAndObservationIsolation() {
  for (const rejected of [true, false]) {
    const h = harness({
      extensions: {
        prepareSession() {
          if (rejected) {
            return { accepted: false, message: 'Safe alternative rejection' };
          }
          throw new Error('secret internal preparation failure');
        },
      },
    });
    await h.run();
    assertEqual(h.created(), 0, 'Preparation failure must precede allocation');
    assertEqual(
      h.res.statusCode,
      rejected ? 400 : 500,
      'Rejection and unexpected errors should use distinct core paths',
    );
    const json = h.res.jsonValue as { id: number; error: { code: number; message: string } };
    assertEqual(json.id, 7, 'Preparation errors should correlate the verified id');
    assertEqual(
      json.error.code,
      rejected ? -32602 : -32603,
      'Core should use safe protocol error codes',
    );
    assert(
      !JSON.stringify(h.res.jsonValue).includes('secret'),
      'Internal preparation exceptions cannot escape',
    );
    assertEqual(h.publications.length, 0, 'Preparation failures cannot notify publication');
  }
  for (const onPublished of [
    () => {
      throw new Error('observer failed');
    },
    () => Promise.reject(new Error('observer rejected')),
    () => new Promise<void>(() => {}),
  ]) {
    const h = harness({
      extensions: {
        prepareSession: (_headers, defaults) => ({
          accepted: true,
          options: defaults,
          onPublished,
        }),
      },
    });
    const completion = deferred<boolean>();
    void h.run().then(
      () => completion.resolve(true),
      () => completion.resolve(false),
    );
    const timeout = setTimeout(() => completion.resolve(false), 1000);
    try {
      assert(
        await completion.promise,
        'Observation throw/rejection/nonsettlement must not block the handshake',
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assertEqual(h.publications.length, 1, 'Observation should run exactly once');
      assertEqual(h.sessions.size, 1, 'Observer failure must not undo publication');
      assertEqual(h.res.statusCode, 200, 'Observer failure must not rewrite response');
      assertEqual(
        h.closes(),
        0,
        'Published resources must not be cleaned up after observer failure',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

await runTestSuite({
  title: 'MCP POST policy context and publication lifecycle',
  tests: [
    { name: 'context and atomic publication', run: testContextAndPublication },
    {
      name: 'joint envelope validation and SDK ownership',
      run: testProtocolInputsDoNotApplyPolicy,
    },
    { name: 'safe parameter errors before resources', run: testSafeParameterError },
    { name: 'both send and HTTP completion orders', run: testBothCompletionOrders },
    { name: 'send failure and interrupted waits', run: testFailureAndAbortCleanup },
    {
      name: 'send rejection terminates pending handler and HTTP waits',
      run: testSendRejectionTerminatesPendingHttp,
    },
    { name: 'shutdown and connect exceptions', run: testShutdownAndFactoryExceptions },
    { name: 'existing session and logger isolation', run: testExistingSessionSkipsInitialization },
    { name: 'default and alternative initialization hooks', run: testDefaultAndAlternativeHooks },
    {
      name: 'preparation failure and observer isolation',
      run: testPreparationFailuresAndObservationIsolation,
    },
  ],
});
