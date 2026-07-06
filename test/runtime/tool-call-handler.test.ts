import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeRulesConfig } from '../../src/config.js';
import type { ConfigStore } from '../../src/runtime/config-store.js';
import { runWithRequestHeaderContext } from '../../src/runtime/request-context.js';
import type { RequestHeaderPolicyLogMetadata } from '../../src/runtime/request-header-policy.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request-header-view.js';
import { createToolCallRequestHandler } from '../../src/runtime/tool-call-handler.js';
import type { ToolRuntimeContext } from '../../src/runtime/tool-context.js';
import type { JsonValue, ToolCallResult } from '../../src/tools/types.js';
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

function assertMatchedMetadata(metadata: RequestHeaderPolicyLogMetadata | undefined): void {
  assert(metadata !== undefined, 'Logger should receive request header rules metadata');
  assertEqual(metadata.rulesConfigured, true, 'Metadata should report configured request header rules');
  assertEqual(metadata.matchedRuleLocations.join(','), 'rules.requestHeaders[0]', 'Metadata should include matched rule locations');
  assertEqual(metadata.enabledFeatures.join(','), 'structuredContent', 'Metadata should include enabled features');
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

function reservedResult(text: string, payload: JsonValue): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
    structuredPayload: payload,
    structuredContent: { stale: true },
    marker: `marker:${text}`,
  };
}

function assertNoReservedFields(result: ToolCallResult, message: string): void {
  assert(!('structuredPayload' in result), `${message}: structuredPayload should be removed`);
  assert(!('structuredContent' in result), `${message}: handler-supplied structuredContent should be removed`);
}

async function testHandlerAdaptsAndLogsMatchedResult(): Promise<void> {
  const { store, getCount } = createCountingStore(matchingRules());
  const routerResult = textResult('ok');
  let loggedResult: ToolCallResult | undefined;
  let loggedMetadata: RequestHeaderPolicyLogMetadata | undefined;
  let routerContext: ToolRuntimeContext | undefined;
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult(_toolName, result, _durationMs, rulesMetadata) {
        loggedResult = result;
        loggedMetadata = rulesMetadata;
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

  assert(returned !== routerResult, 'Matched policy should return an adapted public result object');
  assertEqual(loggedResult, returned, 'Logger should receive the same adapted result returned to the transport');
  assertMatchedMetadata(loggedMetadata);
  assertEqual(returned.content, routerResult.content, 'Adapted result should keep router result content');
  assertEqual(returned.isError, false, 'Adapted result should keep success status');
  assertEqual(returned.structuredContent, '\nok\n', 'Matched text result should use fixed text fallback');
  assert(!('structuredPayload' in returned), 'Matched text fallback should not expose structuredPayload');
  assert(routerContext !== undefined, 'Router should receive a ToolRuntimeContext');
  assertContextHasNoRequestPolicyFields(routerContext);
  assertEqual(getCount(), 1, 'Handler should read snapshot once per tool call');
}

async function testHandlerWithoutRequestContextCleansReservedFields(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  const payload = { ok: true };
  const routerResult = reservedResult('ok', payload);
  let loggedResult: ToolCallResult | undefined;
  let loggedMetadata: RequestHeaderPolicyLogMetadata | undefined;
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult(_toolName, result, _durationMs, rulesMetadata) {
        loggedResult = result;
        loggedMetadata = rulesMetadata;
      },
    },
    routeToolCall: async () => routerResult,
  });

  const returned = await handler({ params: { name: 'fake_tool', arguments: {} } });

  assert(returned !== routerResult, 'Missing request context should return a cleaned public result object');
  assertEqual(loggedResult, returned, 'Logger should receive the cleaned public result');
  assertEqual(returned.content, routerResult.content, 'Cleaned result should keep content');
  assertEqual(returned.marker, routerResult.marker, 'Cleaned result should keep unrelated extensions');
  assertNoReservedFields(returned, 'Missing request context result');
  assertNoMatchMetadata(loggedMetadata);
  assertEqual(routerResult.structuredPayload, payload, 'Router result should remain unchanged');
  assertEqual(
    (routerResult.structuredContent as { stale?: boolean }).stale,
    true,
    'Router stale structuredContent should remain unchanged',
  );
}

async function testHandlerInvalidRequestViewCleansReservedFieldsAndLogsNoMatchMetadata(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  const routerResult = reservedResult('ok', { ok: true });
  let loggedResult: ToolCallResult | undefined;
  let loggedMetadata: RequestHeaderPolicyLogMetadata | undefined;
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult(_toolName, result, _durationMs, rulesMetadata) {
        loggedResult = result;
        loggedMetadata = rulesMetadata;
      },
    },
    routeToolCall: async () => routerResult,
  });

  const returned = await runWithRequestHeaderContext(
    createStrictRequestHeaderView(['X-Client']),
    () => handler({ params: { name: 'fake_tool', arguments: {} } }),
  );

  assertEqual(loggedResult, returned, 'Logger should receive cleaned result for invalid strict view');
  assertNoReservedFields(returned, 'Invalid strict view result');
  assertNoMatchMetadata(loggedMetadata);
}

async function testHandlerCleansReservedFieldsForMatchedAndUnmatchedPolicies(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  const matchedPayload = { matched: true };
  const unmatchedPayload = { matched: false };
  const loggedResults = new Map<string, ToolCallResult>();
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult(toolName, result) {
        loggedResults.set(toolName, result);
      },
    },
    routeToolCall: async (name) => (
      name === 'matched_tool'
        ? reservedResult('matched', matchedPayload)
        : reservedResult('unmatched', unmatchedPayload)
    ),
  });

  const matched = await runWithRequestHeaderContext(
    createStrictRequestHeaderView(['X-Client', 'android-studio']),
    () => handler({ params: { name: 'matched_tool', arguments: {} } }),
  );
  const unmatched = await runWithRequestHeaderContext(
    createStrictRequestHeaderView(['X-Client', 'other-client']),
    () => handler({ params: { name: 'unmatched_tool', arguments: {} } }),
  );

  assertEqual(matched.structuredContent, matchedPayload, 'Matched policy should expose adapter-generated payload');
  assert(!('structuredPayload' in matched), 'Matched policy should remove internal structuredPayload');
  assertEqual(matched.marker, 'marker:matched', 'Matched policy should keep unrelated extensions');
  assertNoReservedFields(unmatched, 'Unmatched policy result');
  assertEqual(unmatched.marker, 'marker:unmatched', 'Unmatched policy should keep unrelated extensions');
  assertEqual(loggedResults.get('matched_tool'), matched, 'Matched logger result should equal returned public result');
  assertEqual(loggedResults.get('unmatched_tool'), unmatched, 'Unmatched logger result should equal returned public result');
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
  assertEqual(returned.structuredContent, '\nok\n', 'Returned result should be the adapted result');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing tool-call handler request policy adaptation',
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'handler adapts and logs matched result', run: testHandlerAdaptsAndLogsMatchedResult },
      { name: 'handler without request context cleans reserved fields', run: testHandlerWithoutRequestContextCleansReservedFields },
      { name: 'handler invalid request view cleans reserved fields and logs no-match metadata', run: testHandlerInvalidRequestViewCleansReservedFieldsAndLogsNoMatchMetadata },
      { name: 'handler cleans reserved fields for matched and unmatched policies', run: testHandlerCleansReservedFieldsForMatchedAndUnmatchedPolicies },
      { name: 'handler order uses adapted result for logger', run: testHandlerOrderUsesAdaptedResultForLogger },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
