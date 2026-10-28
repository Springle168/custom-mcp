import { once } from 'node:events';
import { request } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolResultSchema,
  InitializeResultSchema,
  JSONRPCErrorSchema,
  JSONRPCResponseSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeRulesConfig } from '../../src/config.js';
import { ApplicationLifecycle } from '../../src/runtime/application/application-lifecycle.js';
import { createMcpHttpApp } from '../../src/runtime/mcp/http-app.js';
import type { McpPostSession } from '../../src/runtime/mcp/mcp-post-handler.js';
import type { McpPendingSession } from '../../src/runtime/mcp/pending-session.js';
import type { WorkspaceToolService } from '../../src/tools/index.js';
import type {
  ToolCallResultLogContext,
  ToolResultLogSummary,
} from '../../src/runtime/invocation/tool-call-log-context.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import type { ToolCallPipelineDiagnostic } from '../../src/runtime/invocation/tool-call-handler.js';
import type {
  RequestHeaderFeatureRegistry,
  ResultFeatureBinding,
  ResultTransform,
} from '../../src/runtime/request/feature-contracts.js';
import { REQUEST_HEADER_FEATURE_REGISTRY } from '../../src/runtime/request/feature-registry.js';
import { createRequestHeaderExtensions } from '../../src/runtime/request/request-header-extensions.js';
import { createTestConfigStore } from '../helpers/runtime-config.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';

const TOOL_HEADER = 'x-session-tools';
const INSTRUCTIONS_HEADER = 'x-session-instructions';
const RULES: RuntimeRulesConfig = {
  requestHeaders: {
    onInitialize: [
      { readHeader: TOOL_HEADER, apply: 'setToolList' },
      { readHeader: INSTRUCTIONS_HEADER, apply: 'setInstructions' },
    ],
    onCallToolResult: [
      {
        match: [{ name: 'x-result-client', value: 'duplicate' }],
        enable: ['structuredContentDup'],
      },
    ],
  },
};

function initialize(id: string | number = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'header-integration', version: '1.0.0' },
    },
  };
}

interface HttpReply {
  readonly status: number;
  readonly sessionId: string | undefined;
  readonly text: string;
  readonly message: unknown;
}

// Raw headers retain duplicate field lines instead of fetch/Headers coalescing them.
async function post(
  url: string,
  body: unknown,
  headers: readonly string[] = [],
): Promise<HttpReply> {
  const serializedBody = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: [
          'Host',
          new URL(url).host,
          'Content-Type',
          'application/json',
          'Content-Length',
          String(Buffer.byteLength(serializedBody)),
          'Accept',
          'application/json, text/event-stream',
          ...headers,
        ],
      },
      (res) => {
        res.setEncoding('utf8');
        let text = '';
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const data = text.split('\n').find((line) => line.startsWith('data: '));
            const serialized = data === undefined ? text : data.slice(6);
            const sid = res.headers['mcp-session-id'];
            resolve({
              status: res.statusCode ?? 0,
              sessionId: typeof sid === 'string' ? sid : undefined,
              text,
              message: serialized.trim() === '' ? undefined : JSON.parse(serialized),
            });
          } catch (error: unknown) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5_000, () => req.destroy(new Error('HTTP integration request did not settle')));
    req.end(serializedBody);
  });
}

async function createHarness(
  rules: RuntimeRulesConfig = RULES,
  failInfoLogging = false,
  registry?: RequestHeaderFeatureRegistry,
) {
  const sessions = new Map<string, McpPostSession>();
  const pendingSessions = new Set<McpPendingSession>();
  const messages: string[] = [];
  const resultPolicies: (ToolResultLogSummary | undefined)[] = [];
  const diagnostics: ToolCallPipelineDiagnostic[] = [];
  const calls: string[] = [];
  const definitions = ['alpha_tool', 'custom_only_tool'].map((name) => ({
    name,
    description: `Tests ${name}`,
    inputSchema: { type: 'object' },
  }));
  const service: WorkspaceToolService = {
    getDefinitions: () => definitions,
    async routeToolCall(name) {
      calls.push(name);
      return { content: [{ type: 'text', text: `Executed ${name}` }], isError: false };
    },
  };
  const logger = {
    info(message: string) {
      messages.push(message);
      if (failInfoLogging) {
        throw new Error('Policy logger unavailable');
      }
    },
    logToolCall() {},
    logToolResult(
      _name: string,
      _result: ToolCallResult,
      _duration: number,
      context: ToolCallResultLogContext,
    ) {
      resultPolicies.push(context.resultSummary);
    },
  };
  const app = createMcpHttpApp({
    configStore: createTestConfigStore({ rootDir: process.cwd(), rules }),
    extensions: createRequestHeaderExtensions(rules, logger, registry),
    toolService: service,
    sessions,
    pendingSessions,
    logger,
    onToolCallDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    isAcceptingNewSessions: () => lifecycle.isAcceptingNewSessions,
    closeSession: (id) => lifecycle.closeSession(id),
  });
  const listener = app.listen(0, '127.0.0.1');
  const lifecycle: ApplicationLifecycle = new ApplicationLifecycle({
    listener,
    sessions,
    pendingSessions,
    androidRuntime: { close() {} },
    externalRuntime: { close() {} },
    logger: { close() {} },
  });
  await once(listener, 'listening');
  const address = listener.address();
  assert(address !== null && typeof address !== 'string', 'Harness must listen on loopback');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    sessions,
    pendingSessions,
    messages,
    calls,
    resultPolicies,
    diagnostics,
    close: () => lifecycle.close(),
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function startSession(harness: Harness, headers: readonly string[] = [], batch = false) {
  const reply = await post(
    harness.url,
    batch ? [initialize('batch-id')] : initialize('init-id'),
    headers,
  );
  assertEqual(reply.status, 200, `Valid initialization should succeed; response: ${reply.text}`);
  const response = JSONRPCResponseSchema.parse(reply.message);
  assertEqual(response.id, batch ? 'batch-id' : 'init-id', 'Initialization must retain request ID');
  assert('result' in response, 'Initialization must return a result, not a protocol error');
  const result = InitializeResultSchema.parse(response.result);
  assert(reply.sessionId !== undefined, 'Successful initialization must return a session ID');
  // Publication must not wait for notifications/initialized from the client.
  assert(
    harness.sessions.has(reply.sessionId),
    'Completed initialize must publish before initialized notification',
  );
  assertEqual(harness.pendingSessions.size, 0, 'Published session must leave pending ownership');
  return { sessionId: reply.sessionId, result };
}

async function list(harness: Harness, sessionId: string, headers: readonly string[] = []) {
  const reply = await post(harness.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, [
    'mcp-session-id',
    sessionId,
    ...headers,
  ]);
  assertEqual(reply.status, 200, 'tools/list should succeed');
  const response = JSONRPCResponseSchema.parse(reply.message);
  assert('result' in response, 'tools/list must return a result');
  return ListToolsResultSchema.parse(response.result).tools.map((tool) => tool.name);
}

async function call(
  harness: Harness,
  sessionId: string,
  name: string,
  headers: readonly string[] = [],
) {
  const reply = await post(
    harness.url,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name, arguments: {} },
    },
    ['mcp-session-id', sessionId, ...headers],
  );
  assertEqual(reply.status, 200, 'tools/call should return an MCP result');
  const response = JSONRPCResponseSchema.parse(reply.message);
  assert('result' in response, 'tools/call must return a result');
  return CallToolResultSchema.parse(response.result);
}

async function testSessionSettingsAndSingleElementBatch(): Promise<void> {
  const harness = await createHarness();
  const instructions = '  Session A\n\u8bf4\u660e ${do_not_execute}  ';
  try {
    for (const batch of [false, true]) {
      const selected = await startSession(
        harness,
        [
          'X-Session-Tools',
          JSON.stringify({ toolList: ['custom_only_tool', 'disabled_tool', 'alpha_tool'] }),
          INSTRUCTIONS_HEADER,
          JSON.stringify({ instructions }).replace(
            /[\u0080-\uffff]/g,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
          ),
        ],
        batch,
      );
      assertEqual(
        (await list(harness, selected.sessionId)).join(','),
        'alpha_tool,custom_only_tool',
        'Selection must intersect workspace exposure and retain workspace order',
      );
      assertEqual(
        selected.result.instructions,
        instructions,
        'Instructions must retain whitespace, Unicode, and escaped newline',
      );
      const hidden = await call(harness, selected.sessionId, 'disabled_tool');
      assertEqual(hidden.isError, true, 'Unexposed tool must remain inaccessible');
      assertEqual(harness.calls.length, 0, 'Hidden tools must not enter the executor');
    }
    const first = await startSession(harness, [
      TOOL_HEADER,
      '{"toolList":["custom_only_tool"]}',
      INSTRUCTIONS_HEADER,
      '{"instructions":"first session"}',
    ]);
    const second = await startSession(harness);
    assertEqual(
      (await list(harness, first.sessionId)).join(','),
      'custom_only_tool',
      'Session A should have a smaller tool list',
    );
    assertEqual(
      (await list(harness, second.sessionId)).join(','),
      'alpha_tool,custom_only_tool',
      'Missing header must use workspace defaults, independently of session A',
    );
    assertEqual(
      first.result.instructions,
      'first session',
      'First session should retain its instructions',
    );
    assert(
      !('instructions' in second.result),
      'Instructions should not leak into a default session',
    );
    const denied = await call(harness, first.sessionId, 'alpha_tool');
    assertIncludes(
      JSON.stringify(denied.content),
      'Unknown tool: alpha_tool',
      'Session-hidden tool must return standard Unknown tool result',
    );
    assertEqual(harness.calls.length, 0, 'Denied session call must not invoke workspace service');
    await call(harness, second.sessionId, 'alpha_tool');
    assertEqual(
      harness.calls.join(','),
      'alpha_tool',
      'Default session must still route the same tool',
    );
    assertNotIncludes(
      harness.messages.join('\n'),
      instructions,
      'Successful policy logs must not contain instructions',
    );
    assertNotIncludes(
      harness.messages.join('\n'),
      'first session',
      'Session-specific instructions must not enter diagnostics',
    );
    assertNotIncludes(
      harness.messages.join('\n'),
      'disabled_tool',
      'Requested tool names must not enter policy diagnostics',
    );
    assertNotIncludes(
      harness.messages.join('\n'),
      TOOL_HEADER,
      'Policy diagnostics must not expose bound header names',
    );
  } finally {
    await harness.close();
  }
}

async function testEmptyListsAndInstructions(): Promise<void> {
  const harness = await createHarness();
  try {
    for (const toolList of [[], ['not_in_workspace']]) {
      const selected = await startSession(harness, [
        TOOL_HEADER,
        JSON.stringify({ toolList }),
        INSTRUCTIONS_HEADER,
        '{"instructions":""}',
      ]);
      assertEqual(
        (await list(harness, selected.sessionId)).length,
        0,
        'Empty or wholly filtered selection should expose no tools',
      );
      assert(
        selected.result.capabilities.tools !== undefined,
        'Empty tool list must retain tools capability',
      );
      assert(
        !('instructions' in selected.result),
        'Explicit empty instructions should not be sent',
      );
      const denied = await call(harness, selected.sessionId, 'alpha_tool', [
        'x-result-client',
        'duplicate',
      ]);
      assertEqual(denied.isError, true, 'Empty view must deny guessed tool names');
      assert(
        denied.structuredContent !== undefined,
        'Denied calls must still pass through current result adaptation',
      );
    }
    assertEqual(harness.calls.length, 0, 'Empty views must never enter workspace execution');
  } finally {
    await harness.close();
  }
}

async function testSafeInvalidParametersAndAtomicInitialization(): Promise<void> {
  const harness = await createHarness();
  const secret = 'PRIVATE_HEADER_SENTINEL_98765';
  const invalidHeaders: readonly (readonly string[])[] = [
    [TOOL_HEADER, `{"toolList":["${secret}`],
    [TOOL_HEADER, ''],
    [TOOL_HEADER, 'null'],
    [TOOL_HEADER, '[]'],
    [TOOL_HEADER, '{}'],
    [TOOL_HEADER, `{"toolList":[],"${secret}":"\\n\\u001b[31m"}`],
    [TOOL_HEADER, `{"toolList":"${secret}"}`],
    [TOOL_HEADER, `{"toolList":["${secret} /invalid"]}`],
    [TOOL_HEADER, '{"toolList":["alpha_tool","alpha_tool"]}'],
    [TOOL_HEADER, '{"toolList":[]}', 'X-Session-Tools', '{"toolList":[]}'],
    [INSTRUCTIONS_HEADER, `{"instructions":{"${secret}":true}}`],
    [INSTRUCTIONS_HEADER, `{"instructions":"${secret}","extra":true}`],
    [
      INSTRUCTIONS_HEADER,
      '{"instructions":"first"}',
      INSTRUCTIONS_HEADER,
      '{"instructions":"first"}',
    ],
    [TOOL_HEADER, '{"toolList":[]}', INSTRUCTIONS_HEADER, `{"instructions":${secret}}`],
  ];
  try {
    for (const [index, headers] of invalidHeaders.entries()) {
      const id = index % 2 === 0 ? `safe-id-${index}` : index;
      const reply = await post(
        harness.url,
        index % 2 === 0 ? initialize(id) : [initialize(id)],
        headers,
      );
      assertEqual(
        reply.status,
        400,
        'Invalid configured initialization payload must fail with HTTP 400',
      );
      const error = JSONRPCErrorSchema.parse(reply.message);
      assertEqual(error.id, id, 'Feature parameter error must correlate legal request ID');
      assertEqual(error.error.code, -32602, 'Feature parameter error must use Invalid params');
      assert(reply.sessionId === undefined, 'Parameter errors must not advertise a session ID');
      assertNotIncludes(
        reply.text,
        secret,
        'Error response must not reflect client parameters or JSON.parse fragments',
      );
      assertEqual(
        harness.sessions.size,
        0,
        'Invalid parameters must not publish a default or partially configured session',
      );
      assertEqual(
        harness.pendingSessions.size,
        0,
        'Invalid parameters must not leave pending resources',
      );
    }
    assertNotIncludes(
      harness.messages.join('\n'),
      secret,
      'Policy diagnostics must not leak header payloads',
    );
    const recovered = await startSession(harness);
    assertEqual(
      (await list(harness, recovered.sessionId)).length,
      2,
      'Bad requests must not poison later initialization',
    );
  } finally {
    await harness.close();
  }
}

async function testLaterHeadersAndPerRequestResultPolicy(): Promise<void> {
  const harness = await createHarness();
  try {
    const selected = await startSession(harness, [
      TOOL_HEADER,
      '{"toolList":["custom_only_tool"]}',
      INSTRUCTIONS_HEADER,
      '{"instructions":"fixed"}',
      'x-result-client',
      'duplicate',
    ]);
    const ordinary = await call(harness, selected.sessionId, 'custom_only_tool');
    assert(
      ordinary.structuredContent === undefined,
      'Initialize result header must not be cached as call policy',
    );
    const damagedInitializeHeaders = [
      TOOL_HEADER,
      'not JSON',
      TOOL_HEADER,
      '{"toolList":[]}',
      INSTRUCTIONS_HEADER,
      'also not JSON',
      INSTRUCTIONS_HEADER,
      '{}',
    ];
    const adapted = await call(harness, selected.sessionId, 'custom_only_tool', [
      ...damagedInitializeHeaders,
      'x-result-client',
      'duplicate',
    ]);
    assert(
      adapted.structuredContent !== undefined,
      'Later damaged initialization headers must not block a matching call',
    );
    assertEqual(
      (await list(harness, selected.sessionId, damagedInitializeHeaders)).join(','),
      'custom_only_tool',
      'Later initialization headers must not mutate the session view',
    );
    const concurrent = await Promise.all([
      call(harness, selected.sessionId, 'custom_only_tool', ['x-result-client', 'duplicate']),
      call(harness, selected.sessionId, 'custom_only_tool', ['x-result-client', 'Duplicate']),
    ]);
    assert(concurrent[0]?.structuredContent !== undefined, 'Matching concurrent POST should adapt');
    assert(
      concurrent[1]?.structuredContent === undefined,
      'Concurrent nonmatching POST must keep its own header context',
    );
    const duplicateResultHeader = await call(harness, selected.sessionId, 'custom_only_tool', [
      'x-result-client',
      'duplicate',
      'X-Result-Client',
      'duplicate',
    ]);
    assert(
      duplicateResultHeader.structuredContent === undefined,
      'Repeated result condition must not match',
    );
    const hidden = await call(harness, selected.sessionId, 'alpha_tool', [
      'x-result-client',
      'duplicate',
    ]);
    assertEqual(hidden.isError, true, 'Restricted view must still deny hidden tool');
    assertEqual(
      JSON.stringify(hidden.structuredContent),
      JSON.stringify({ content: hidden.content, isError: true }),
      'Unknown tool results must use the same per-request adaptation',
    );
    assert(!harness.calls.includes('alpha_tool'), 'Hidden call must not enter workspace routing');
  } finally {
    await harness.close();
  }
}

async function testAllRuleCombinationsUseProductionDefaults(): Promise<void> {
  for (const initialization of [false, true]) {
    for (const results of [false, true]) {
      const harness = await createHarness({
        requestHeaders: {
          onInitialize: initialization ? RULES.requestHeaders.onInitialize : [],
          onCallToolResult: results ? RULES.requestHeaders.onCallToolResult : [],
        },
      });
      try {
        const selected = await startSession(
          harness,
          initialization
            ? [INSTRUCTIONS_HEADER, '{"instructions":"configured"}']
            : [INSTRUCTIONS_HEADER, 'broken', INSTRUCTIONS_HEADER, 'also broken'],
        );
        assertEqual(
          selected.result.instructions,
          initialization ? 'configured' : undefined,
          'Only configured initialization rules should parse or apply parameters',
        );
        const result = await call(harness, selected.sessionId, 'alpha_tool', [
          'x-result-client',
          'duplicate',
        ]);
        assertEqual(
          result.structuredContent !== undefined,
          results,
          'Production default result feature must depend only on result rules',
        );
        if (results) {
          assertEqual(
            JSON.stringify(result.structuredContent),
            JSON.stringify({ content: result.content, isError: false }),
            'The default registered transform must reach the real HTTP handler',
          );
        }
        assertEqual(
          harness.resultPolicies[0] !== undefined,
          results,
          'Only result rules should produce a result policy summary',
        );
      } finally {
        await harness.close();
      }
    }
  }
}

async function testBoundResultsStaySessionLocalAndRequestSelected(): Promise<void> {
  const defaultValue = 'PRIVATE_DEFAULT_BINDING_20481';
  const firstValue = 'PRIVATE_FIRST_BINDING_20482';
  const secondValue = 'PRIVATE_SECOND_BINDING_20483';
  let parsedParameters = 0;
  let boundResults = 0;
  const appliedValues = new Map<string, number>();
  const transform =
    (value: string): ResultTransform =>
    (result) => {
      appliedValues.set(value, (appliedValues.get(value) ?? 0) + 1);
      return { ...result, structuredContent: { testBoundValue: value } };
    };
  const registry: RequestHeaderFeatureRegistry = {
    ...REQUEST_HEADER_FEATURE_REGISTRY,
    initialize: {
      ...REQUEST_HEADER_FEATURE_REGISTRY.initialize,
      setInstructions(payload, invalid) {
        parsedParameters++;
        const { instructions } = REQUEST_HEADER_FEATURE_REGISTRY.initialize.setInstructions(
          payload,
          invalid,
        );
        if (instructions === undefined) {
          return invalid('instructions');
        }
        return {
          resultBindings: [
            {
              feature: 'structuredContentDup',
              bind() {
                boundResults++;
                return transform(instructions);
              },
            },
          ],
        };
      },
    },
    results: [{ feature: 'structuredContentDup', apply: transform(defaultValue) }],
  };
  const harness = await createHarness(RULES, false, registry);
  const matchingHeaders = ['x-result-client', 'duplicate'];
  const damagedInitializeHeaders = [
    INSTRUCTIONS_HEADER,
    'not JSON',
    INSTRUCTIONS_HEADER,
    '{"instructions":"must not replace bound value"}',
  ];
  try {
    const defaults = await startSession(harness, matchingHeaders);
    const [first, second] = await Promise.all(
      [firstValue, secondValue].map((instructions) =>
        startSession(harness, [
          INSTRUCTIONS_HEADER,
          JSON.stringify({ instructions }),
          ...matchingHeaders,
        ]),
      ),
    );
    assert(first !== undefined && second !== undefined, 'Both bound sessions must initialize');
    const sessions = [
      { session: defaults, value: defaultValue },
      { session: first, value: firstValue },
      { session: second, value: secondValue },
    ];
    assertEqual(parsedParameters, 2, 'Missing initialization header must not invoke the parser');
    assertEqual(boundResults, 2, 'Each override must bind once during session preparation');
    assertEqual(appliedValues.size, 0, 'Initialization must not execute result transforms');

    for (const { session } of sessions) {
      assert(
        !('instructions' in session.result),
        'Test result parameters must not become Server instructions',
      );
      const ordinary = await call(harness, session.sessionId, 'alpha_tool');
      assert(
        ordinary.structuredContent === undefined,
        'A matching initialization header must not enable later result processing',
      );
    }
    assertEqual(
      appliedValues.size,
      0,
      'Initialization parameters alone must not enable transforms',
    );

    for (let iteration = 0; iteration < 2; iteration++) {
      const results = await Promise.all(
        sessions.map(({ session }) =>
          call(harness, session.sessionId, 'alpha_tool', [
            ...matchingHeaders,
            ...damagedInitializeHeaders,
          ]),
        ),
      );
      for (const [index, { value }] of sessions.entries()) {
        assertEqual(
          JSON.stringify(results[index]?.structuredContent),
          JSON.stringify({ testBoundValue: value }),
          'Concurrent sessions must apply their own fixed value or the default',
        );
      }

      const unselected = await Promise.all(
        sessions.map(({ session }) =>
          call(harness, session.sessionId, 'alpha_tool', [
            'x-result-client',
            'Duplicate',
            ...damagedInitializeHeaders,
          ]),
        ),
      );
      assert(
        unselected.every((result) => result.structuredContent === undefined),
        'A previous matching call must not cache enablement into later nonmatching POSTs',
      );
    }
    assertEqual(parsedParameters, 2, 'Later damaged initialization headers must not be parsed');
    assertEqual(boundResults, 2, 'Repeated calls must reuse the original session bindings');
    for (const value of [defaultValue, firstValue, secondValue]) {
      assertEqual(appliedValues.get(value), 2, 'Only matching calls may execute each transform');
      assertNotIncludes(
        JSON.stringify({
          messages: harness.messages,
          resultPolicies: harness.resultPolicies,
          diagnostics: harness.diagnostics,
        }),
        value,
        'Bound result parameters must not enter policy summaries or diagnostics',
      );
    }
    assertEqual(harness.resultPolicies.length, 15, 'Every call should produce a policy summary');
    assert(
      harness.resultPolicies.every((summary) => summary !== undefined),
      'Configured result rules must retain safe per-call summaries',
    );
    assertEqual(harness.diagnostics.length, 0, 'Valid bindings must not trigger pipeline failures');
  } finally {
    await harness.close();
  }
}

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

async function testUnconfiguredHeadersAreNotParsedOrLogged(): Promise<void> {
  const harness = await createHarness({
    requestHeaders: { onInitialize: [], onCallToolResult: [] },
  });
  const secret = 'PRIVATE_INSTRUCTIONS_45678';
  try {
    const selected = await startSession(harness, [
      TOOL_HEADER,
      'malformed',
      TOOL_HEADER,
      'also malformed',
      INSTRUCTIONS_HEADER,
      JSON.stringify({ instructions: secret }),
    ]);
    assertEqual(
      (await list(harness, selected.sessionId)).length,
      2,
      'Unconfigured bindings must not parse or restrict tools',
    );
    assert(
      !('instructions' in selected.result),
      'Unconfigured instructions header must not affect response',
    );
    assertNotIncludes(
      harness.messages.join('\n'),
      secret,
      'Raw unconfigured header data must not enter diagnostics',
    );
  } finally {
    await harness.close();
  }
}

async function testPolicyLoggingIsPrivateAndFailureIsolated(): Promise<void> {
  const rules: RuntimeRulesConfig = {
    requestHeaders: { onInitialize: RULES.requestHeaders.onInitialize, onCallToolResult: [] },
  };
  const harness = await createHarness(rules, true);
  const secret = 'PRIVATE_LOGGING_SENTINEL_54321';
  try {
    const selected = await startSession(harness, [
      TOOL_HEADER,
      '{"toolList":["alpha_tool"]}',
      INSTRUCTIONS_HEADER,
      JSON.stringify({ instructions: `${secret}\n\u001b[31mprivate` }),
    ]);
    assertIncludes(
      selected.result.instructions ?? '',
      secret,
      'Logger failure must not change successful instructions',
    );
    await call(harness, selected.sessionId, 'alpha_tool');
    assertEqual(
      harness.resultPolicies[0],
      undefined,
      'Initialization-only rules must not cause a result Rules summary',
    );
    assertNotIncludes(
      harness.messages.join('\n'),
      secret,
      'Successful policy diagnostics must not log client-provided text',
    );
    const failed = await post(harness.url, initialize('logging-error-id'), [
      INSTRUCTIONS_HEADER,
      secret,
    ]);
    assertEqual(
      failed.status,
      400,
      'Logger failure must not rewrite invalid initialization response',
    );
    assertEqual(
      JSONRPCErrorSchema.parse(failed.message).id,
      'logging-error-id',
      'Safe parameter error must retain its ID even if logging fails',
    );
    assertEqual(
      harness.sessions.size,
      1,
      'Failed initialization must not affect the prior successful session',
    );
    assertNotIncludes(
      harness.messages.join('\n'),
      secret,
      'Failure diagnostics must not leak raw JSON.parse input',
    );
  } finally {
    await harness.close();
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
  title: 'Testing real HTTP initialization and per-call request header policy',
  tests: [
    {
      name: 'object and single-element batch settings isolate sessions',
      run: testSessionSettingsAndSingleElementBatch,
    },
    {
      name: 'empty and filtered tool lists retain capability without execution',
      run: testEmptyListsAndInstructions,
    },
    {
      name: 'invalid parameters are safe, correlated, and atomic',
      run: testSafeInvalidParametersAndAtomicInitialization,
    },
    {
      name: 'all four rule combinations use production session defaults',
      run: testAllRuleCombinationsUseProductionDefaults,
    },
    {
      name: 'later initialization headers do not change per-request result policy',
      run: testLaterHeadersAndPerRequestResultPolicy,
    },
    {
      name: 'bound results stay session-local and independently selected per POST',
      run: testBoundResultsStaySessionLocalAndRequestSelected,
    },
    {
      name: 'internal parser, binding, and service failures are safe and recoverable',
      run: testInternalPreparationFailuresAreSafeAndRecoverable,
    },
    {
      name: 'internal ownership conflicts fail before preparation and allow recovery',
      run: testInternalOwnershipConflictsFailBeforePreparation,
    },
    {
      name: 'unconfigured headers are not parsed or logged',
      run: testUnconfiguredHeadersAreNotParsedOrLogged,
    },
    {
      name: 'policy logs stay private and logger failure does not alter protocol',
      run: testPolicyLoggingIsPrivateAndFailureIsolated,
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
