import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeRulesConfig } from '../../src/config.js';
import type { ConfigStore } from '../../src/runtime/config-store.js';
import { runWithRequestHeaderContext } from '../../src/runtime/request-context.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request-header-view.js';
import { createToolCallRequestHandler } from '../../src/runtime/tool-call-handler.js';
import type { ToolRuntimeContext } from '../../src/runtime/tool-context.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import {
  createTestRuntimeConfigIdentity,
  createTestRuntimeConfigSnapshot,
} from '../helpers/runtime-config.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'tool-call-handler');
const PRIMARY_DIR = path.join(FIXTURES_DIR, 'primary');

function matchingRules(): RuntimeRulesConfig {
  return {
    requestHeaders: [
      {
        match: [{ name: 'x-client', value: 'android-studio' }],
        enable: ['structuredContent'],
      },
    ],
  };
}

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(PRIMARY_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

function createCountingStore(rules: RuntimeRulesConfig): { readonly store: ConfigStore; readonly getCount: () => number } {
  const snapshot = createTestRuntimeConfigSnapshot({
    rootDir: PRIMARY_DIR,
    rules,
  });
  let count = 0;

  return {
    getCount: () => count,
    store: {
      getSnapshot() {
        count++;
        return snapshot;
      },
      getIdentity() {
        return createTestRuntimeConfigIdentity(snapshot);
      },
      getStatus() {
        return { state: 'ok' };
      },
    },
  };
}

function assertContextHasNoRequestPolicyFields(context: ToolRuntimeContext): void {
  const record = context as unknown as Record<string, unknown>;

  assert(record.rules === undefined, 'ToolRuntimeContext should not expose rules');
  assert(record.requestHeaderView === undefined, 'ToolRuntimeContext should not expose strict header view');
  assert(record.requestPolicy === undefined, 'ToolRuntimeContext should not expose request policy');
}

function textResult(text: string): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

function getStructuredContent(result: ToolCallResult): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  assert(
    typeof structuredContent === 'object' && structuredContent !== null,
    'Expected adapted result to include structuredContent',
  );
  return structuredContent as Record<string, unknown>;
}

async function testHandlerAdaptsAndLogsMatchedResult(): Promise<void> {
  const { store, getCount } = createCountingStore(matchingRules());
  const routerResult = textResult('ok');
  let loggedResult: ToolCallResult | undefined;
  let routerContext: ToolRuntimeContext | undefined;
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult(_toolName, result) {
        loggedResult = result;
      },
    },
    routeToolCall: async (_name, _args, context) => {
      routerContext = context;
      assertEqual(getCount(), 1, 'Router should run after exactly one snapshot read');
      return routerResult;
    },
  });

  const returned = await runWithRequestHeaderContext(
    createStrictRequestHeaderView(['X-Client', 'android-studio']),
    () => handler({ params: { name: 'fake_tool', arguments: {} } }),
  );
  const wrapper = getStructuredContent(returned);

  assert(returned !== routerResult, 'Matched policy should return an adapted result object');
  assertEqual(loggedResult, returned, 'Logger should receive the same adapted result returned to the transport');
  assertEqual(wrapper.content, routerResult.content, 'Wrapper should contain the router result content');
  assertEqual(wrapper.isError, false, 'Wrapper should use normalized success status');
  assert(routerContext !== undefined, 'Router should receive a ToolRuntimeContext');
  assertContextHasNoRequestPolicyFields(routerContext);
  assertEqual(getCount(), 1, 'Handler should read snapshot once per tool call');
}

async function testHandlerWithoutRequestContextDoesNotAdapt(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  const routerResult = textResult('ok');
  let loggedResult: ToolCallResult | undefined;
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult(_toolName, result) {
        loggedResult = result;
      },
    },
    routeToolCall: async () => routerResult,
  });

  const returned = await handler({ params: { name: 'fake_tool', arguments: {} } });

  assertEqual(returned, routerResult, 'Missing request context should return the original router result');
  assertEqual(loggedResult, routerResult, 'Logger should receive the original result when no policy feature is enabled');
  assert(!('structuredContent' in returned), 'Missing request context should not add structuredContent');
}

async function testHandlerOrderUsesAdaptedResultForLogger(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  const events: string[] = [];
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall(toolName) {
        events.push(`call:${toolName}`);
      },
      logToolResult(_toolName, result) {
        events.push(`logger:${'structuredContent' in result}`);
      },
    },
    now: () => 1000,
    routeToolCall: async () => {
      events.push('route');
      return textResult('ok');
    },
  });

  const returned = await runWithRequestHeaderContext(
    createStrictRequestHeaderView(['X-Client', 'android-studio']),
    () => handler({ params: { name: 'fake_tool', arguments: {} } }),
  );

  assertEqual(events.join('>'), 'call:fake_tool>route>logger:true', 'Handler should route, adapt, then log the adapted result');
  assert('structuredContent' in returned, 'Returned result should be the adapted result');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing tool-call handler request policy adaptation',
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'handler adapts and logs matched result', run: testHandlerAdaptsAndLogsMatchedResult },
      { name: 'handler without request context does not adapt', run: testHandlerWithoutRequestContextDoesNotAdapt },
      { name: 'handler order uses adapted result for logger', run: testHandlerOrderUsesAdaptedResultForLogger },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
