import type {
  InitializeContribution,
  InitializeFeatureParser,
  InvalidInitializePayload,
} from '../../src/runtime/request/feature-contracts.js';
import { parseSetInstructions } from '../../src/runtime/request/features/set-instructions.js';
import { parseSetToolList } from '../../src/runtime/request/features/set-tool-list.js';
import type { WorkspaceToolService } from '../../src/tools/index.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

const unexpectedInvalid: InvalidInitializePayload = (field) => {
  throw new Error(`Unexpected invalid payload at ${field}`);
};

function expectInvalid(parser: InitializeFeatureParser, payload: unknown, field: string): void {
  const sentinel = new Error('safe invalid callback');
  let calls = 0;
  try {
    parser(payload, (actualField) => {
      calls++;
      assertEqual(actualField, field, 'Invalid callback should receive only its trusted field');
      throw sentinel;
    });
    throw new Error('Expected parser rejection');
  } catch (error) {
    assertEqual(
      error,
      sentinel,
      'Every invalid payload should reject through the supplied callback',
    );
  }
  assertEqual(calls, 1, 'A rejected payload should invoke invalid exactly once');
}

function spyWorkspace(names: readonly string[]) {
  let enumerations = 0;
  const definitions = Object.freeze(
    names.map((name) =>
      Object.freeze({ name, description: name, inputSchema: Object.freeze({ type: 'object' }) }),
    ),
  );
  const service: WorkspaceToolService = Object.freeze({
    getDefinitions: () => {
      enumerations++;
      return definitions;
    },
    routeToolCall: async () => ({ content: [], isError: false }),
  });
  return { service, enumerations: () => enumerations };
}

function prepare(
  contribution: InitializeContribution,
  base: WorkspaceToolService,
): WorkspaceToolService {
  assert(
    contribution.prepareToolService !== undefined,
    'Tool parser should provide delayed preparation',
  );
  return contribution.prepareToolService(base);
}

function testToolListValidGrammarAndWorkspaceOrder(): void {
  const names = ['x'.repeat(128), 'Case', 'case', '._-0', 'custom.Tool-1', 'READ_FILE'];
  const workspace = spyWorkspace([...names].reverse());
  const contribution = parseSetToolList({ toolList: [...names, 'not_exposed'] }, unexpectedInvalid);
  assert(Object.isFrozen(contribution), 'Tool contribution should be immutable');
  assertEqual(contribution.instructions, undefined, 'Tool selection should not own instructions');
  assertEqual(
    contribution.resultBindings,
    undefined,
    'Tool selection should not bind result features',
  );
  assertEqual(workspace.enumerations(), 0, 'Parsing must not enumerate workspace definitions');

  const session = prepare(contribution, workspace.service);
  assertEqual(workspace.enumerations(), 1, 'Only preparation should enumerate the shared service');
  assertEqual(
    session
      .getDefinitions()
      .map(({ name }) => name)
      .join(','),
    [...names].reverse().join(','),
    'Valid names remain case-sensitive; selection intersects exposure in workspace order',
  );
  assertEqual(
    workspace.enumerations(),
    1,
    'Reading a prepared view should not re-enumerate the workspace',
  );
  assert(Object.isFrozen(session), 'Prepared service should be immutable');
  assert(
    Object.isFrozen(session.getDefinitions()),
    'Prepared definition selection should be immutable',
  );
}

function testToolListCapturesOwnedNames(): void {
  const workspace = spyWorkspace(['first', 'second', 'third']);
  const names = ['second', 'first'];
  const payload = { toolList: names };
  const contribution = parseSetToolList(payload, unexpectedInvalid);
  assertEqual(workspace.enumerations(), 0, 'Parsing should leave the base service untouched');
  assert(!Object.isFrozen(names), 'Parser should not freeze caller-owned arrays in place');

  // Mutate both the original array and its owner before the delayed view exists.
  names.splice(0, names.length, 'third');
  payload.toolList = ['third'];
  const session = prepare(contribution, workspace.service);
  assertEqual(
    session
      .getDefinitions()
      .map(({ name }) => name)
      .join(','),
    'first,second',
    'Preparation must use the validated copy rather than later payload mutations',
  );
  const secondSession = prepare(contribution, workspace.service);
  assertEqual(
    secondSession
      .getDefinitions()
      .map(({ name }) => name)
      .join(','),
    'first,second',
    'Repeated preparation should retain the same captured immutable selection',
  );
  assertEqual(workspace.enumerations(), 2, 'Each preparation should create only its own view');
}

function testToolListExplicitEmpty(): void {
  const workspace = spyWorkspace(['read']);
  const contribution = parseSetToolList({ toolList: [] }, unexpectedInvalid);
  assert(Object.isFrozen(contribution), 'Explicit empty selection should still be immutable');
  assertEqual(workspace.enumerations(), 0, 'Even empty selection must defer preparation');
  assertEqual(
    prepare(contribution, workspace.service).getDefinitions().length,
    0,
    'Empty selection should expose no tools rather than use defaults',
  );
}

function testToolListRejectsInvalidPayloads(): void {
  for (const payload of [
    undefined,
    null,
    [],
    '',
    'string',
    0,
    false,
    {},
    { unrelated: [] },
    { toolList: [], privateUnknownField: true },
    { toolList: undefined },
    { toolList: null },
    { toolList: 'read' },
    { toolList: {} },
    { toolList: true },
    { toolList: [1] },
    { toolList: [null] },
    { toolList: [false] },
    { toolList: [{}] },
    { toolList: [[]] },
    { toolList: [''] },
    { toolList: ['has space'] },
    { toolList: [' read'] },
    { toolList: ['read '] },
    { toolList: ['read\n'] },
    { toolList: ['read\r'] },
    { toolList: ['read\r\n'] },
    { toolList: ['read\t'] },
    { toolList: ['has/slash'] },
    { toolList: ['has:colon'] },
    { toolList: ['中文'] },
    { toolList: ['x'.repeat(129)] },
    { toolList: ['read', 'read'] },
    { toolList: ['secret\n\u001b[31m'] },
  ]) {
    expectInvalid(parseSetToolList, payload, 'toolList');
  }
}

function testInstructionsPreserveTextAndOwnSnapshot(): void {
  const instructions = '  Unicode 中文\n\u001b[31m client-secret  ';
  const payload = { instructions };
  const contribution = parseSetInstructions(payload, unexpectedInvalid);
  assert(Object.isFrozen(contribution), 'Instructions contribution should be immutable');
  assertEqual(
    contribution.instructions,
    instructions,
    'Instructions must be preserved without normalization',
  );
  assertEqual(
    contribution.prepareToolService,
    undefined,
    'Instructions should not prepare a tool service',
  );
  assertEqual(
    contribution.resultBindings,
    undefined,
    'Instructions should not bind result features',
  );

  payload.instructions = 'changed after validation';
  assertEqual(
    contribution.instructions,
    instructions,
    'Caller mutation must not alter captured instructions',
  );
  const empty = parseSetInstructions({ instructions: '' }, unexpectedInvalid);
  assert(Object.isFrozen(empty), 'Empty instructions contribution should also be immutable');
  assertEqual(
    empty.instructions,
    '',
    'Explicit empty string must remain distinguishable from absence',
  );
  assert(Object.hasOwn(empty, 'instructions'), 'Explicit empty instructions should own its output');
}

function testInstructionsRejectInvalidPayloads(): void {
  for (const payload of [
    undefined,
    null,
    [],
    '',
    'string',
    1,
    true,
    {},
    { unrelated: 'text' },
    { instructions: 'valid', privateUnknownField: true },
    { instructions: undefined },
    { instructions: null },
    { instructions: 1 },
    { instructions: false },
    { instructions: [] },
    { instructions: {} },
  ]) {
    expectInvalid(parseSetInstructions, payload, 'instructions');
  }
}

await runTestSuite({
  title: 'Testing initialize header feature parsers',
  tests: [
    {
      name: 'tool list valid grammar, deferred preparation and workspace order',
      run: testToolListValidGrammarAndWorkspaceOrder,
    },
    {
      name: 'tool list captures an owned selection before preparation',
      run: testToolListCapturesOwnedNames,
    },
    { name: 'explicit empty tool list does not use defaults', run: testToolListExplicitEmpty },
    {
      name: 'tool list rejects invalid shape, names and duplicates',
      run: testToolListRejectsInvalidPayloads,
    },
    {
      name: 'instructions preserve raw text and explicit empty values',
      run: testInstructionsPreserveTextAndOwnSnapshot,
    },
    {
      name: 'instructions reject invalid shape and values',
      run: testInstructionsRejectInvalidPayloads,
    },
  ],
});
