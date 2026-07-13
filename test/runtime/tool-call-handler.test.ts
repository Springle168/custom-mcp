import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeRulesConfig } from '../../src/config.js';
import type { ConfigStore } from '../../src/runtime/config-store.js';
import { runWithRequestHeaderContext } from '../../src/runtime/request-context.js';
import type { RequestHeaderPolicyLogMetadata } from '../../src/runtime/request-header-policy.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request-header-view.js';
import { createToolCallRequestHandler } from '../../src/runtime/tool-call-handler.js';
import type {
  ToolCallLogContext,
  ToolCallResultLogContext,
} from '../../src/runtime/tool-call-log-context.js';
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
        enable: ['structuredContentDup'],
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

function assertMatchedMetadata(metadata: RequestHeaderPolicyLogMetadata | undefined): void {
  assert(metadata !== undefined, 'Logger should receive request header rules metadata');
  assertEqual(metadata.rulesConfigured, true, 'Metadata should report configured request header rules');
  assertEqual(metadata.matchedRuleLocations.join(','), 'rules.requestHeaders[0]', 'Metadata should include matched rule locations');
  assertEqual(metadata.enabledFeatures.join(','), 'structuredContentDup', 'Metadata should include enabled features');
}

function assertNoMatchMetadata(metadata: RequestHeaderPolicyLogMetadata | undefined): void {
  assert(metadata !== undefined, 'Logger should receive request header rules metadata');
  assertEqual(metadata.rulesConfigured, true, 'Metadata should report configured request header rules');
  assertEqual(metadata.matchedRuleLocations.length, 0, 'No-match metadata should not include matched rule locations');
  assertEqual(metadata.enabledFeatures.length, 0, 'No-match metadata should not include enabled features');
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
  let loggedMetadata: RequestHeaderPolicyLogMetadata | undefined;
  let callLogContext: ToolCallLogContext | undefined;
  let resultLogContext: ToolCallResultLogContext | undefined;
  let routerContext: ToolRuntimeContext | undefined;
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall(_toolName, _args, context) {
        callLogContext = context;
      },
      logToolResult(_toolName, result, _durationMs, context) {
        loggedResult = result;
        loggedMetadata = context.requestHeaderPolicy;
        resultLogContext = context;
      },
    },
    getSessionId: () => 'session_test',
    generateCallId: () => 'call_test',
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
  assertMatchedMetadata(loggedMetadata);
  assertEqual(wrapper.content, routerResult.content, 'Wrapper should contain the router result content');
  assertEqual(wrapper.isError, false, 'Wrapper should use normalized success status');
  assertEqual(callLogContext?.sessionId, 'session_test', 'Call log should receive the transport session ID');
  assertEqual(callLogContext?.callId, 'call_test', 'Call log should receive the generated call ID');
  assertEqual(resultLogContext?.sessionId, 'session_test', 'Result log should keep the call session ID');
  assertEqual(resultLogContext?.callId, 'call_test', 'Result log should keep the same call ID');
  assert(routerContext !== undefined, 'Router should receive a ToolRuntimeContext');
  assertContextHasNoRequestPolicyFields(routerContext);
  assertEqual(getCount(), 1, 'Handler should read snapshot once per tool call');
}

async function testHandlerWithoutRequestContextDoesNotAdapt(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  const routerResult = textResult('ok');
  let loggedResult: ToolCallResult | undefined;
  let loggedMetadata: RequestHeaderPolicyLogMetadata | undefined;
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult(_toolName, result, _durationMs, context) {
        loggedResult = result;
        loggedMetadata = context.requestHeaderPolicy;
      },
    },
    routeToolCall: async () => routerResult,
  });

  const returned = await handler({ params: { name: 'fake_tool', arguments: {} } });

  assertEqual(returned, routerResult, 'Missing request context should return the original router result');
  assertEqual(loggedResult, routerResult, 'Logger should receive the original result when no policy feature is enabled');
  assertNoMatchMetadata(loggedMetadata);
  assert(!('structuredContent' in returned), 'Missing request context should not add structuredContent');
}

async function testHandlerInvalidRequestViewLogsNoMatchMetadata(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  const routerResult = textResult('ok');
  let loggedMetadata: RequestHeaderPolicyLogMetadata | undefined;
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult(_toolName, _result, _durationMs, context) {
        loggedMetadata = context.requestHeaderPolicy;
      },
    },
    routeToolCall: async () => routerResult,
  });

  const returned = await runWithRequestHeaderContext(
    createStrictRequestHeaderView(['X-Client']),
    () => handler({ params: { name: 'fake_tool', arguments: {} } }),
  );

  assertEqual(returned, routerResult, 'Invalid strict view should return the original router result');
  assertNoMatchMetadata(loggedMetadata);
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
      { name: 'handler invalid request view logs no-match metadata', run: testHandlerInvalidRequestViewLogsNoMatchMetadata },
      { name: 'handler order uses adapted result for logger', run: testHandlerOrderUsesAdaptedResultForLogger },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
