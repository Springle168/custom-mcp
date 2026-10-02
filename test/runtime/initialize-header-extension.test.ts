import type { RuntimeRulesConfig } from '../../src/config.js';
import type { McpSessionOptions } from '../../src/runtime/runtime-extensions.js';
import { createInitializeHeaderExtension } from '../../src/runtime/request/initialize-header-extension.js';
import { assert, assertEqual, assertIncludes, assertNotIncludes, runTestSuite } from '../test-utils.js';

const rules: RuntimeRulesConfig = {
  requestHeaders: {
    onInitialize: [
      { readHeader: 'x-tools', apply: 'setToolList' },
      { readHeader: 'x-instructions', apply: 'setInstructions' },
    ],
    onCallToolResult: [],
  },
};

function defaults() {
  let lists = 0;
  const options: McpSessionOptions = {
    toolService: {
      getDefinitions() {
        lists++;
        return ['first', 'second'].map((name) => ({
          name, description: 'Adapter test tool.', inputSchema: { type: 'object' as const },
        }));
      },
      async routeToolCall(name) { return { content: [{ type: 'text', text: name }], isError: false }; },
    },
    instructions: 'default instructions',
  };
  return { options, lists: () => lists };
}

async function testFinalOptionsAndLazyPublicationSummary() {
  const base = defaults();
  const messages: string[] = [];
  const prepare = createInitializeHeaderExtension(rules, { info(message) { messages.push(message); } });
  const prepared = prepare([
    'X-Tools', '{"toolList":["second","unknown","first"]}',
    'X-Instructions', '{"instructions":"  private instructions\\nunchanged  "}',
  ], base.options);
  assert(prepared.accepted, 'Valid parameters should be accepted');
  assert(prepared.options.toolService !== base.options.toolService, 'Explicit tool names should create a session view');
  assertEqual(prepared.options.toolService.getDefinitions().map((tool) => tool.name).join(','), 'first,second', 'Session view should preserve workspace order and filter unknown names');
  assertEqual(prepared.options.instructions, '  private instructions\nunchanged  ', 'Instructions should reach final options unchanged');
  assertEqual(base.lists(), 1, 'Requested tool view should capture workspace definitions once');
  assertEqual(messages.length, 0, 'Policy success must not log before publication');
  assert(prepared.onPublished !== undefined, 'Configured rules should supply publication observation');
  await prepared.onPublished('published-id');
  assertEqual(messages.length, 1, 'Publication should write one policy summary');
  assertIncludes(messages[0]!, 'Session policy: published-id; rules.requestHeaders.onInitialize[0]: setToolList, rules.requestHeaders.onInitialize[1]: setInstructions', 'Summary should preserve rule ordering and features');
  for (const secret of ['x-tools', 'x-instructions', 'private instructions', 'unknown', 'first', 'second']) {
    assertNotIncludes(messages[0]!, secret, 'Summary must not contain client input');
  }
}

async function testMissingEmptyAndUnconfiguredParameters() {
  const base = defaults();
  const messages: string[] = [];
  const prepare = createInitializeHeaderExtension(rules, { info(message) { messages.push(message); } });
  const missing = prepare([], base.options);
  assert(missing.accepted, 'Missing parameters should preserve defaults');
  assertEqual(missing.options.toolService, base.options.toolService, 'Missing names should retain shared service identity');
  assertEqual(missing.options.instructions, base.options.instructions, 'Missing instructions should preserve defaults');
  assertEqual(base.lists(), 0, 'No tool selection should avoid constructing a session view');
  await missing.onPublished?.('missing-id');
  assertEqual(messages[0], 'Session policy: missing-id; none', 'Configured but unapplied rules should report none');

  const empty = prepare(['x-tools', '{"toolList":[]}', 'x-instructions', '{"instructions":""}'], base.options);
  assert(empty.accepted, 'Explicit empty values should be accepted');
  assertEqual(empty.options.toolService.getDefinitions().length, 0, 'Empty names should produce an empty session view');
  assertEqual(empty.options.instructions, '', 'Explicit empty instructions should replace defaults and let Server omit the field');

  const unconfigured = createInitializeHeaderExtension({
    requestHeaders: { onInitialize: [], onCallToolResult: [] },
  }, { info() { throw new Error('must not log'); } })(['odd-invalid-raw-view'], base.options);
  assert(unconfigured.accepted, 'Unconfigured initialization must ignore malformed headers');
  assertEqual(unconfigured.options.toolService, base.options.toolService, 'Unconfigured stage should retain default service');
  assertEqual(unconfigured.onPublished, undefined, 'Unconfigured stage should not create a publication callback');
}

async function testSafeRejectionAndLoggerIsolation() {
  for (const info of [
    (_message: string) => { throw new Error('private logger failure'); },
    (_message: string) => Promise.reject(new Error('private logger rejection')),
  ]) {
    const base = defaults();
    const prepare = createInitializeHeaderExtension(rules, { info });
    const rejected = prepare(['x-tools', 'private invalid JSON'], base.options);
    assert(!rejected.accepted, 'Known parameter failure should become a rejection');
    assertIncludes(rejected.message, 'invalid_json', 'Safe rejection should retain category');
    assertNotIncludes(rejected.message, 'private', 'Safe rejection must not include raw input or logger errors');
    assertEqual(base.lists(), 0, 'Rejected parameters must not allocate a tool view');
    const accepted = prepare([], base.options);
    assert(accepted.accepted, 'Logger failures must not reject valid parameters');
    await accepted.onPublished?.('published-id');
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  const messages: string[] = [];
  const rejected = createInitializeHeaderExtension(rules, { info(message) { messages.push(message); } })([
    'x-tools', '{"toolList":[]}', 'X-Tools', '{"toolList":[]}',
  ], defaults().options);
  assert(!rejected.accepted, 'Duplicate header should reject');
  assertEqual(messages[0], 'Initialize policy rejected: rules.requestHeaders.onInitialize[0]; duplicate_header', 'Failure log should contain only safe rule location and category');
}

async function testUnknownFailuresPropagate() {
  const unexpected = new Error('private unexpected failure');
  const base = defaults();
  const broken: McpSessionOptions = {
    toolService: { ...base.options.toolService, getDefinitions() { throw unexpected; } },
  };
  let caught: unknown;
  try {
    createInitializeHeaderExtension(rules, { info() {} })(['x-tools', '{"toolList":[]}'], broken);
  } catch (error: unknown) {
    caught = error;
  }
  assertEqual(caught, unexpected, 'Unexpected service errors should propagate to the core safe error path');
}

await runTestSuite({
  title: 'Initialization header extension stage adapter',
  tests: [
    { name: 'final session options and deferred private summary', run: testFinalOptionsAndLazyPublicationSummary },
    { name: 'missing, empty and unconfigured parameters', run: testMissingEmptyAndUnconfiguredParameters },
    { name: 'safe parameter rejection and logger isolation', run: testSafeRejectionAndLoggerIsolation },
    { name: 'unexpected failures propagate', run: testUnknownFailuresPropagate },
  ],
});
