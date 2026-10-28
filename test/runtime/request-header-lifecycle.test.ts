import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { JSONRPCErrorSchema, JSONRPCResponseSchema } from '@modelcontextprotocol/sdk/types.js';
import type { WorkspaceToolService } from '../../src/tools/index.js';
import type {
  RequestHeaderFeatureRegistry,
  ResultFeatureBinding,
} from '../../src/runtime/request/feature-contracts.js';
import { REQUEST_HEADER_FEATURE_REGISTRY } from '../../src/runtime/request/feature-registry.js';
import {
  type Harness,
  type HttpReply,
  INSTRUCTIONS_HEADER,
  RULES,
  TOOL_HEADER,
  call,
  createHarness,
  initialize,
  list,
  post,
  startSession,
} from './helpers/request-header-http.js';
import { assert, assertEqual, assertNotIncludes, runTestSuite } from '../test-utils.js';

function assertInternalInitializationFailure(
  harness: Harness,
  reply: HttpReply,
  requestId: string,
  secret: string,
): void {
  assertEqual(reply.status, 500, 'Internal preparation failure must return HTTP 500');
  const error = JSONRPCErrorSchema.parse(reply.message);
  assertEqual(error.id, requestId, 'Internal error must retain the legal initialization ID');
  assertEqual(
    error.error.code,
    -32603,
    'Internal failure must not become a client parameter error',
  );
  assertEqual(
    error.error.message,
    'Internal initialization error',
    'Internal exception details must be replaced by the safe core diagnostic',
  );
  assert(reply.sessionId === undefined, 'Failed preparation must not advertise a session ID');
  assertEqual(harness.sessions.size, 0, 'Failed preparation must not publish a routable session');
  assertEqual(
    harness.pendingSessions.size,
    0,
    'Failed preparation must not leave pending ownership',
  );
  assertEqual(harness.calls.length, 0, 'Failed initialization must not execute a tool');
  assertNotIncludes(reply.text, secret, 'Internal error response must not reflect private data');
  const diagnostics = JSON.stringify({
    messages: harness.messages,
    resultPolicies: harness.resultPolicies,
    diagnostics: harness.diagnostics,
  });
  assertNotIncludes(
    diagnostics,
    secret,
    'Internal failure diagnostics must not reflect private data',
  );
  assertNotIncludes(diagnostics, 'New session:', 'Failed initialization must not log publication');
  assertNotIncludes(
    diagnostics,
    'Session policy:',
    'Failed initialization must not log policy success',
  );
}

async function testInternalPreparationFailuresAreSafeAndRecoverable(): Promise<void> {
  for (const stage of ['parser', 'binding', 'tool-service'] as const) {
    const secret = `PRIVATE_${stage.toUpperCase()}_FAILURE_73291`;
    let shouldFail = true;
    let parserCalls = 0;
    let preparationCalls = 0;
    const registry: RequestHeaderFeatureRegistry = {
      ...REQUEST_HEADER_FEATURE_REGISTRY,
      initialize: {
        ...REQUEST_HEADER_FEATURE_REGISTRY.initialize,
        setInstructions(payload, invalid) {
          parserCalls++;
          REQUEST_HEADER_FEATURE_REGISTRY.initialize.setInstructions(payload, invalid);
          if (stage === 'parser') {
            if (shouldFail) {
              throw new Error(secret);
            }
            return {};
          }
          if (stage === 'binding') {
            return {
              resultBindings: [
                {
                  feature: 'structuredContentDup',
                  bind() {
                    preparationCalls++;
                    if (shouldFail) {
                      throw new Error(secret);
                    }
                    return (result) => ({
                      ...result,
                      structuredContent: { recoveredBinding: true },
                    });
                  },
                },
              ],
            };
          }
          return {
            prepareToolService(base) {
              preparationCalls++;
              if (shouldFail) {
                throw new Error(secret);
              }
              return base;
            },
          };
        },
      },
    };
    const harness = await createHarness(RULES, false, registry);
    const headers = [INSTRUCTIONS_HEADER, JSON.stringify({ instructions: secret })];
    try {
      const requestId = `internal-${stage}`;
      const failed = await post(harness.url, initialize(requestId), headers);
      assertInternalInitializationFailure(harness, failed, requestId, secret);
      assertEqual(parserCalls, 1, 'The failing request must enter its configured parser');
      assertEqual(
        preparationCalls,
        stage === 'parser' ? 0 : 1,
        'Binding and service failures must occur after successful parsing',
      );

      shouldFail = false;
      const recovered = await startSession(harness, headers);
      assertEqual(
        (await list(harness, recovered.sessionId)).length,
        2,
        'The same application must accept a later legal initialization after internal failure',
      );
      const result = await call(harness, recovered.sessionId, 'alpha_tool', [
        'x-result-client',
        'duplicate',
      ]);
      assertEqual(result.isError, false, 'Recovered session must route tools normally');
      if (stage === 'binding') {
        assertEqual(
          JSON.stringify(result.structuredContent),
          JSON.stringify({ recoveredBinding: true }),
          'Recovery must use the successfully bound session transform, not default fallback',
        );
      }
      assertEqual(parserCalls, 2, 'Recovery must parse its own valid initialization once');
      assertEqual(
        preparationCalls,
        stage === 'parser' ? 0 : 2,
        'Successful recovery must prepare again without repeating work during tools/call',
      );
      assertEqual(
        harness.messages.filter((message) => message.startsWith('New session:')).length,
        1,
        'Only the recovered initialization may publish a session',
      );
      assertEqual(
        harness.messages.filter((message) => message.startsWith('Session policy:')).length,
        1,
        'Only successful recovery may report policy publication',
      );
      assertNotIncludes(
        JSON.stringify([harness.messages, harness.resultPolicies, harness.diagnostics]),
        secret,
        'Failure and recovery observability must both keep parameters and exceptions private',
      );
    } finally {
      await harness.close();
    }
  }
}

async function testInternalOwnershipConflictsFailBeforePreparation(): Promise<void> {
  for (const conflict of [
    'duplicate-binding',
    'unknown-binding',
    'instructions',
    'tool-service',
  ] as const) {
    const secret = `PRIVATE_${conflict.toUpperCase()}_CONFLICT_81357`;
    let shouldConflict = true;
    let preparedServices = 0;
    let boundResults = 0;
    const prepareToolService = (base: WorkspaceToolService) => {
      preparedServices++;
      return base;
    };
    const binding: ResultFeatureBinding = {
      feature: 'structuredContentDup',
      bind() {
        boundResults++;
        return (result) => result;
      },
    };
    const registry: RequestHeaderFeatureRegistry = {
      ...REQUEST_HEADER_FEATURE_REGISTRY,
      ...(conflict === 'unknown-binding' ? { results: [] } : {}),
      initialize: {
        setToolList(payload, invalid) {
          REQUEST_HEADER_FEATURE_REGISTRY.initialize.setToolList(payload, invalid);
          if (!shouldConflict) {
            return {};
          }
          return conflict === 'instructions' ? { instructions: secret } : { prepareToolService };
        },
        setInstructions(payload, invalid) {
          REQUEST_HEADER_FEATURE_REGISTRY.initialize.setInstructions(payload, invalid);
          if (!shouldConflict) {
            return {};
          }
          switch (conflict) {
            case 'duplicate-binding':
              return { resultBindings: [binding, binding] };
            case 'unknown-binding':
              return { resultBindings: [binding] };
            case 'instructions':
              return { instructions: secret };
            case 'tool-service':
              return { prepareToolService };
          }
        },
      },
    };
    const harness = await createHarness(RULES, false, registry);
    const headers = [
      TOOL_HEADER,
      '{"toolList":["alpha_tool"]}',
      INSTRUCTIONS_HEADER,
      JSON.stringify({ instructions: secret }),
    ];
    try {
      const requestId = `conflict-${conflict}`;
      const failed = await post(harness.url, initialize(requestId), headers);
      assertInternalInitializationFailure(harness, failed, requestId, secret);
      assertEqual(preparedServices, 0, 'Ownership conflicts must precede tool service preparation');
      assertEqual(boundResults, 0, 'Ownership conflicts must precede every result binding factory');

      shouldConflict = false;
      const recovered = await startSession(harness, headers);
      assertEqual(
        (await list(harness, recovered.sessionId)).length,
        2,
        'A rejected internal ownership conflict must not poison later session preparation',
      );
      assertEqual(
        preparedServices + boundResults,
        0,
        'Recovery without contributions must keep defaults',
      );
    } finally {
      await harness.close();
    }
  }
}

async function testSdkInvalidInputsNeverPublish(): Promise<void> {
  const harness = await createHarness();
  const legal = initialize();
  const { jsonrpc: _jsonrpc, ...noJsonrpc } = legal;
  const { id: _id, ...noId } = legal;
  const invalid = [
    noJsonrpc,
    noId,
    { ...legal, id: null },
    { ...legal, params: {} },
    { ...legal, params: { ...legal.params, clientInfo: { name: 123, version: '1.0.0' } } },
    [initialize(1), initialize(2)],
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
  ];
  try {
    for (const body of invalid) {
      const reply = await post(harness.url, body, [TOOL_HEADER, 'not JSON']);
      const response = JSONRPCResponseSchema.safeParse(reply.message);
      assert(
        !response.success || !('result' in response.data),
        'Malformed SDK input must not produce successful initialize',
      );
      assertEqual(
        harness.sessions.size,
        0,
        'SDK rejection must not publish even if transport allocated a session ID',
      );
      assertEqual(
        harness.pendingSessions.size,
        0,
        'SDK rejection must release provisional resources',
      );
      const error = JSONRPCErrorSchema.safeParse(reply.message);
      if (error.success) {
        assertNotIncludes(
          error.data.error.message,
          'rules.requestHeaders',
          'Invalid protocol input must not be reclassified as feature parameter validation',
        );
      }
      if (reply.sessionId !== undefined) {
        const reuse = await post(harness.url, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, [
          'mcp-session-id',
          reply.sessionId,
        ]);
        assertEqual(reuse.status, 404, 'Any session ID on SDK rejection must be unusable');
      }
    }
    const recovered = await startSession(harness);
    assertEqual(
      (await list(harness, recovered.sessionId)).length,
      2,
      'SDK errors must not prevent later normal initialization',
    );
  } finally {
    await harness.close();
  }
}

async function testRejectedInitializeSendReleasesHttpAndPendingSession(): Promise<void> {
  const harness = await createHarness();
  const originalSend = StreamableHTTPServerTransport.prototype.send;
  let sendCalls = 0;
  let closeCalls = 0;
  StreamableHTTPServerTransport.prototype.send = async function () {
    sendCalls++;
    const originalClose = this.close.bind(this);
    this.close = async () => {
      closeCalls++;
      await originalClose();
    };
    // Reject before writing/closing the HTTP stream, as a failed SDK send can.
    throw new Error('PRIVATE_SEND_FAILURE');
  };
  try {
    const reply = await post(harness.url, initialize('send-failure'));
    assertEqual(sendCalls, 1, 'Initialization should attempt its response send once');
    const response = JSONRPCResponseSchema.safeParse(reply.message);
    assert(
      !response.success || !('result' in response.data),
      'Rejected send cannot return an initialization result',
    );
    assertEqual(harness.sessions.size, 0, 'Rejected send must never publish the session');
    assertEqual(
      harness.pendingSessions.size,
      0,
      'Rejected send must release pending ownership without client abort',
    );
    assertEqual(closeCalls, 1, 'Rejected send must close the temporary transport exactly once');
    assertNotIncludes(
      reply.text,
      'PRIVATE_SEND_FAILURE',
      'HTTP cleanup must not reflect send errors',
    );
    assertNotIncludes(
      harness.messages.join('\n'),
      'PRIVATE_SEND_FAILURE',
      'Diagnostics must not reflect send errors',
    );
  } finally {
    StreamableHTTPServerTransport.prototype.send = originalSend;
    await harness.close();
  }
}

async function testShutdownOwnsPendingConnectAndPublishedSessions(): Promise<void> {
  const harness = await createHarness();
  await startSession(harness);
  let releaseConnect!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  let enteredConnect!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredConnect = resolve;
  });
  const originalConnect = Server.prototype.connect;
  Server.prototype.connect = async function (...args: Parameters<Server['connect']>) {
    enteredConnect();
    await gate;
    return originalConnect.apply(this, args);
  };
  // Always handle either transport shutdown outcome; response delivery is not a success guarantee.
  const initializing = post(harness.url, initialize('shutdown-id')).catch(() => undefined);
  try {
    await Promise.race([
      entered,
      initializing.then(() => {
        throw new Error('Initialization settled before entering connect');
      }),
    ]);
    assertEqual(
      harness.pendingSessions.size,
      1,
      'Factory must register pending ownership before awaiting connect',
    );
    const closing = harness.close();
    releaseConnect();
    await Promise.all([closing, initializing]);
    assertEqual(
      harness.sessions.size,
      0,
      'Shutdown must close published sessions and prevent late publication',
    );
    assertEqual(harness.pendingSessions.size, 0, 'Shutdown must release pending resources');
  } finally {
    releaseConnect();
    Server.prototype.connect = originalConnect;
    await initializing;
    await harness.close();
  }
}

await runTestSuite({
  title: 'Testing real HTTP initialization failures and session lifecycle',
  tests: [
    {
      name: 'internal parser, binding, and service failures are safe and recoverable',
      run: testInternalPreparationFailuresAreSafeAndRecoverable,
    },
    {
      name: 'internal ownership conflicts fail before preparation and allow recovery',
      run: testInternalOwnershipConflictsFailBeforePreparation,
    },
    {
      name: 'SDK invalid inputs never publish provisional sessions',
      run: testSdkInvalidInputsNeverPublish,
    },
    {
      name: 'rejected initialize send releases HTTP and pending resources',
      run: testRejectedInitializeSendReleasesHttpAndPendingSession,
    },
    {
      name: 'shutdown owns pending connect and published sessions',
      run: testShutdownOwnsPendingConnectAndPublishedSessions,
    },
  ],
});
