import type {
  RequestHeaderFeatureRegistry,
  ResultTransform,
} from '../../src/runtime/request/feature-contracts.js';
import { REQUEST_HEADER_FEATURE_REGISTRY } from '../../src/runtime/request/feature-registry.js';
import {
  INSTRUCTIONS_HEADER,
  RULES,
  TOOL_HEADER,
  call,
  createHarness,
  list,
  startSession,
} from './helpers/request-header-http.js';
import { assert, assertEqual, assertNotIncludes, runTestSuite } from '../test-utils.js';

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

await runTestSuite({
  title: 'Testing real HTTP per-request results and session-local bindings',
  tests: [
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
  ],
});
