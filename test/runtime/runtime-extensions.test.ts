import { readFile } from 'node:fs/promises';
import type { RuntimeRulesConfig } from '../../src/config.js';
import { createRequestHeaderExtensions } from '../../src/runtime/request/request-header-extensions.js';
import { getCurrentRequestHeaderView } from '../../src/runtime/request/request-context.js';
import type { WorkspaceToolService } from '../../src/tools/index.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import { createTestRuntimeConfigSnapshot } from '../helpers/runtime-config.js';
import { assert, assertEqual, assertNotIncludes, runTestSuite } from '../test-utils.js';

function rules(initialization: boolean, results: boolean): RuntimeRulesConfig {
  return {
    requestHeaders: {
      onInitialize: initialization ? [{ readHeader: 'x-tools', apply: 'setToolList' }] : [],
      onCallToolResult: results
        ? [{ match: [{ name: 'x-client', value: 'matched' }], enable: ['structuredContentDup'] }]
        : [],
    },
  };
}

const service: WorkspaceToolService = {
  getDefinitions: () => [
    { name: 'read', description: 'Test tool', inputSchema: { type: 'object' } },
  ],
  routeToolCall: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
};

function testConfiguredStageCombinations(): void {
  for (const initialization of [false, true]) {
    for (const results of [false, true]) {
      const extensions = createRequestHeaderExtensions(rules(initialization, results), {
        info() {},
      });
      assertEqual(
        extensions.prepareSession !== undefined,
        initialization,
        'Only configured initialization stage should be installed',
      );
      assertEqual(
        extensions.defaultSessionOptions?.prepareToolResult !== undefined,
        results,
        'Only configured result stage should be installed',
      );
      assertEqual(
        extensions.runWithPostContext !== undefined,
        results,
        'POST context bridge is only needed for result capture',
      );
    }
  }
}

async function testPostBridgeAndCapture(): Promise<void> {
  const configuration = rules(false, true);
  const extensions = createRequestHeaderExtensions(configuration, { info() {} });
  const snapshot = createTestRuntimeConfigSnapshot({
    rootDir: process.cwd(),
    rules: configuration,
  });
  const run = extensions.runWithPostContext;
  const prepare = extensions.defaultSessionOptions?.prepareToolResult;
  assert(
    run !== undefined && prepare !== undefined,
    'Result stage should include its context bridge',
  );
  const original: ToolCallResult = { content: [{ type: 'text', text: 'ok' }], isError: false };
  const captured = run(['X-Client', 'matched'], () => {
    assert(getCurrentRequestHeaderView() !== undefined, 'Bridge must establish POST-local context');
    return prepare(snapshot);
  });
  assertEqual(getCurrentRequestHeaderView(), undefined, 'Context must not escape bridge');
  const adapted = captured.adaptResult(original);
  assert(
    adapted !== original && adapted.structuredContent !== undefined,
    'Captured plan must apply outside the original POST scope',
  );
  assertNotIncludes(
    JSON.stringify(captured.getLogSummary?.()),
    'x-client',
    'Safe summary must not expose header names',
  );
  const unmatched = run(['X-Client', 'other'], () => prepare(snapshot));
  assertEqual(
    unmatched.adaptResult(original),
    original,
    'Another POST must not inherit captured policy',
  );
  const asynchronous = await run(['X-Client', 'matched'], async () => {
    await Promise.resolve();
    return prepare(snapshot).adaptResult(original);
  });
  assert(
    asynchronous.structuredContent !== undefined,
    'Generic bridge must preserve async callback results and context',
  );
}

function testInitializeOnlyDoesNotRequireBridge(): void {
  const configuration = rules(true, false);
  const extensions = createRequestHeaderExtensions(configuration, { info() {} });
  assert(extensions.prepareSession !== undefined, 'Initialization stage should be installed');
  const prepared = extensions.prepareSession(['X-Tools', '{"toolList":[]}'], {
    toolService: service,
  });
  assert(prepared.accepted, 'Valid parameters should prepare session');
  assertEqual(
    prepared.options.toolService.getDefinitions().length,
    0,
    'Initialization can parse raw input directly without ALS',
  );
  assertEqual(
    getCurrentRequestHeaderView(),
    undefined,
    'Initialization must not create persistent request context',
  );
}

async function testCoreDependencyBoundary(): Promise<void> {
  const coreFiles = [
    'src/runtime/runtime-extensions.ts',
    'src/runtime/mcp/http-app.ts',
    'src/runtime/mcp/mcp-post-handler.ts',
    'src/runtime/mcp/mcp-server.ts',
    'src/runtime/invocation/tool-call-handler.ts',
    'src/runtime/invocation/tool-call-log-context.ts',
    'src/utils/logger.ts',
  ];
  const root = new URL('../../', import.meta.url);
  for (const file of coreFiles) {
    const source = await readFile(new URL(file, root), 'utf8');
    assert(
      !/(?:from\s*|import\s*\()['"][^'"]*\/request\//u.test(source),
      `${file} must not import policy implementation or context`,
    );
    for (const term of [
      'RequestHeaderPolicy',
      'InitializeHeaderPolicy',
      'requestedToolNames',
      'structuredContentDup',
      'rules.requestHeaders',
      'Rules:',
    ]) {
      assertNotIncludes(
        source,
        term,
        `${file} must depend on stage contracts rather than policy details`,
      );
    }
  }
}

await runTestSuite({
  title: 'Testing runtime extension composition and dependency boundaries',
  tests: [
    { name: 'factory installs only configured stage hooks', run: testConfiguredStageCombinations },
    { name: 'POST bridge preserves scope and captured result plan', run: testPostBridgeAndCapture },
    {
      name: 'initialization-only preparation needs no POST bridge',
      run: testInitializeOnlyDoesNotRequireBridge,
    },
    {
      name: 'core runtime and logger are independent of policy implementation',
      run: testCoreDependencyBoundary,
    },
  ],
});
