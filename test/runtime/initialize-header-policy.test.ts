import type { RuntimeRulesConfig } from '../../src/config.js';
import {
  evaluateInitializeHeaderPolicy,
  InitializeHeaderPolicyError,
  toInitializeHeaderPolicyErrorLogMetadata,
  type InitializeHeaderPolicyErrorCategory,
} from '../../src/runtime/request/initialize-header-policy.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request/request-header-view.js';
import { assert, assertEqual, assertNotIncludes, runTestSuite } from '../test-utils.js';

function rules(
  onInitialize: RuntimeRulesConfig['requestHeaders']['onInitialize'] = [
    { readHeader: 'x-tools', apply: 'setToolList' },
    { readHeader: 'x-instructions', apply: 'setInstructions' },
  ],
): RuntimeRulesConfig {
  return { requestHeaders: { onInitialize, onCallToolResult: [] } };
}

function expectFailure(
  rawHeaders: readonly unknown[],
  code: InitializeHeaderPolicyErrorCategory,
  index = 0,
): InitializeHeaderPolicyError {
  try {
    evaluateInitializeHeaderPolicy(rules(), createStrictRequestHeaderView(rawHeaders));
  } catch (error) {
    assert(error instanceof InitializeHeaderPolicyError, 'Must throw a classified safe error');
    assertEqual(error.category, code, 'Error classification should identify the boundary');
    assertEqual(
      error.ruleLocation,
      `rules.requestHeaders.onInitialize[${index}]`,
      'Error should identify only its configured location',
    );
    return error;
  }
  throw new Error('Expected initialization policy failure');
}

function testMissingAndUnconfiguredHeaders(): void {
  const defaults = evaluateInitializeHeaderPolicy(rules(), createStrictRequestHeaderView([]));
  assertEqual(
    defaults.settings.requestedToolNames,
    undefined,
    'Missing tools header should preserve workspace defaults',
  );
  assertEqual(
    defaults.settings.instructions,
    undefined,
    'Missing instructions should remain absent',
  );
  assertEqual(defaults.metadata.appliedRules.length, 0, 'Missing headers should not apply rules');
  assertEqual(
    defaults.metadata.rulesConfigured,
    true,
    'Bindings remain configured when headers are absent',
  );

  const noBindings = evaluateInitializeHeaderPolicy(rules([]), { kind: 'invalid' });
  assertEqual(
    noBindings.metadata.rulesConfigured,
    false,
    'Unconfigured initialization must not reject invalid views',
  );
  const ignored = evaluateInitializeHeaderPolicy(
    rules([{ readHeader: 'x-instructions', apply: 'setInstructions' }]),
    createStrictRequestHeaderView([
      'X-Tools',
      '{broken',
      'x-tools',
      'null',
      'X-Instructions',
      '{"instructions":"ok"}',
    ]),
  );
  assertEqual(
    ignored.settings.instructions,
    'ok',
    'Malformed duplicate unconfigured headers must not be parsed',
  );
}

function testValidParametersAndImmutableMetadata(): void {
  const instructions = '  Unicode 中文\n\u001b[31m client-secret  ';
  const policy = evaluateInitializeHeaderPolicy(
    rules(),
    createStrictRequestHeaderView([
      'X-Tools',
      JSON.stringify({ toolList: ['custom.Tool-1', 'READ_FILE', 'not_exposed'] }),
      'X-Instructions',
      JSON.stringify({ instructions }),
    ]),
  );
  assertEqual(
    policy.settings.requestedToolNames?.join(','),
    'custom.Tool-1,READ_FILE,not_exposed',
    'Parser should preserve names without filtering or reordering',
  );
  assertEqual(
    policy.settings.instructions,
    instructions,
    'Instructions must retain Unicode, whitespace, escapes and control characters as data',
  );
  assert(Object.isFrozen(policy), 'Settings should be frozen');
  assert(
    Object.isFrozen(policy.settings.requestedToolNames),
    'Requested tool names should be frozen',
  );
  assert(
    Object.isFrozen(policy.metadata.appliedRules) &&
      policy.metadata.appliedRules.every(Object.isFrozen),
    'Applied metadata should be deeply immutable',
  );
  const metadata = policy.metadata;
  assertEqual(
    metadata.appliedRules.map((rule) => rule.ruleLocation).join(','),
    'rules.requestHeaders.onInitialize[0],rules.requestHeaders.onInitialize[1]',
    'Metadata order should follow configuration',
  );
  assertEqual(
    metadata.appliedRules.map((rule) => rule.feature).join(','),
    'setToolList,setInstructions',
    'Metadata should identify only applied features',
  );
  for (const secret of [
    'x-tools',
    'x-instructions',
    'client-secret',
    'custom.Tool-1',
    'not_exposed',
    'toolList',
  ]) {
    assertNotIncludes(
      JSON.stringify(metadata),
      secret,
      'Metadata must not expose parameter data or header names',
    );
  }
}

function testExplicitEmptyValuesAndJsonParseSemantics(): void {
  const empty = evaluateInitializeHeaderPolicy(
    rules(),
    createStrictRequestHeaderView([
      'x-tools',
      '{"toolList":[]}',
      'x-instructions',
      '{"instructions":""}',
    ]),
  );
  assertEqual(
    empty.settings.requestedToolNames?.length,
    0,
    'An explicit empty tool list is not a default',
  );
  assertEqual(
    empty.settings.instructions,
    '',
    'An explicit empty instruction string remains distinguishable from absence',
  );
  assertEqual(empty.metadata.appliedRules.length, 2, 'Explicit empties count as applied');
  const lastProperty = evaluateInitializeHeaderPolicy(
    rules(),
    createStrictRequestHeaderView(['x-tools', '{"toolList":["first"],"toolList":["last"]}']),
  );
  assertEqual(
    lastProperty.settings.requestedToolNames?.join(','),
    'last',
    'Standard JSON.parse duplicate property semantics should be retained',
  );
}

function testInvalidViewsDuplicateAndJson(): void {
  expectFailure(['x-tools'], 'invalid_header_view');
  expectFailure(['x-tools', 5], 'invalid_header_view');
  expectFailure(['x-tools', '{"toolList":[]}', 'X-Tools', '{"toolList":[]}'], 'duplicate_header');
  for (const value of ['', '{secret-broken', 'undefined']) {
    const error = expectFailure(['x-tools', value], 'invalid_json');
    assertNotIncludes(
      error.message,
      'secret-broken',
      'JSON.parse messages must not leak fragments',
    );
  }
  try {
    evaluateInitializeHeaderPolicy(rules(), undefined);
    throw new Error('Expected missing view failure');
  } catch (error) {
    assert(
      error instanceof InitializeHeaderPolicyError,
      'A missing strict view with configured bindings must not default',
    );
    assertEqual(error.category, 'invalid_header_view', 'A missing view has a safe classification');
  }
}

function testStrictPayloadAndNameValidation(): void {
  const invalidTools: unknown[] = [
    null,
    [],
    'string',
    1,
    {},
    { toolList: null },
    { toolList: 'read' },
    { toolList: [], secretKey: true },
    { toolList: [1] },
    { toolList: [''] },
    { toolList: ['has space'] },
    { toolList: [' read'] },
    { toolList: ['x'.repeat(129)] },
    { toolList: ['read', 'read'] },
    { toolList: ['secret\n\u001b[31m'] },
  ];
  for (const payload of invalidTools) {
    const error = expectFailure(['x-tools', JSON.stringify(payload)], 'invalid_payload');
    assertEqual(error.field, 'toolList', 'Safe field location should be an internal contract name');
    assertNotIncludes(
      error.message,
      'secret',
      'Invalid names and unknown JSON keys must not be reflected',
    );
  }
  for (const payload of [
    null,
    [],
    {},
    { instructions: 1 },
    { instructions: null },
    { instructions: [], secretKey: true },
  ]) {
    const error = expectFailure(['x-instructions', JSON.stringify(payload)], 'invalid_payload', 1);
    assertEqual(error.field, 'instructions', 'Instructions errors should have a stable safe field');
  }
  const valid = evaluateInitializeHeaderPolicy(
    rules(),
    createStrictRequestHeaderView([
      'x-tools',
      JSON.stringify({ toolList: ['x'.repeat(128), 'Case', 'case', '._-0'] }),
    ]),
  );
  assertEqual(
    valid.settings.requestedToolNames?.length,
    4,
    'Grammar limits and case-distinct names should be valid',
  );
}

function testAtomicFailureAndSafeErrorMetadata(): void {
  const error = expectFailure(
    [
      'x-tools',
      '{"toolList":["client-secret"]}',
      'x-instructions',
      '{"instructions":false,"secret\\n\\u001b":true}',
    ],
    'invalid_payload',
    1,
  );
  assertEqual(
    JSON.stringify(toInitializeHeaderPolicyErrorLogMetadata(error)),
    '{"ruleLocation":"rules.requestHeaders.onInitialize[1]","category":"invalid_payload"}',
    'Failure metadata should have no settings or raw exception',
  );
  assertNotIncludes(
    error.message,
    'client-secret',
    'A later error must not leak earlier valid settings',
  );
}

await runTestSuite({
  title: 'Testing initialize header policy',
  tests: [
    {
      name: 'missing and unconfigured headers preserve defaults',
      run: testMissingAndUnconfiguredHeaders,
    },
    {
      name: 'valid parameters and immutable safe metadata',
      run: testValidParametersAndImmutableMetadata,
    },
    {
      name: 'explicit empty values and JSON.parse property semantics',
      run: testExplicitEmptyValuesAndJsonParseSemantics,
    },
    {
      name: 'invalid views, duplicate headers and JSON errors',
      run: testInvalidViewsDuplicateAndJson,
    },
    { name: 'strict payload and tool name validation', run: testStrictPayloadAndNameValidation },
    { name: 'atomic failure and safe error metadata', run: testAtomicFailureAndSafeErrorMetadata },
  ],
});
