import { JSONRPCErrorSchema } from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeRulesConfig } from '../../src/config.js';
import {
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
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';

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

await runTestSuite({
  title: 'Testing real HTTP request header initialization contracts and privacy',
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
      name: 'unconfigured headers are not parsed or logged',
      run: testUnconfiguredHeadersAreNotParsedOrLogged,
    },
    {
      name: 'policy logs stay private and logger failure does not alter protocol',
      run: testPolicyLoggingIsPrivateAndFailureIsolated,
    },
  ],
});
