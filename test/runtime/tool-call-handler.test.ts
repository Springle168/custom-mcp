import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeRulesConfig } from '../../src/config.js';
import type { ConfigStore } from '../../src/runtime/application/config-store.js';
import { runWithRequestHeaderContext } from '../../src/runtime/request/request-context.js';
import type { RequestHeaderPolicyLogMetadata } from '../../src/runtime/request/request-header-policy.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request/request-header-view.js';
import {
  createToolCallRequestHandler,
  type ToolCallPipelineDiagnostic,
} from '../../src/runtime/invocation/tool-call-handler.js';
import type {
  ToolCallLogContext,
  ToolCallResultLogContext,
} from '../../src/runtime/invocation/tool-call-log-context.js';
import type { ToolRuntimeContext } from '../../src/runtime/invocation/tool-context.js';
import type { ToolInvocationContext } from '../../src/runtime/invocation/tool-invocation-context.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import {
  createTestRuntimeConfigIdentity,
  createTestRuntimeConfigSnapshot,
} from '../helpers/runtime-config.js';
import {
  assert,
  assertEqual,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'tool-call-handler');
const PRIMARY_DIR = path.join(FIXTURES_DIR, 'primary');

function matchingRules(): RuntimeRulesConfig {
  return {
    requestHeaders: {
      onInitialize: [],
      onCallToolResult: [
        {
          match: [{ name: 'x-client', value: 'android-studio' }],
          enable: ['structuredContentDup'],
        },
      ],
    },
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
  assertEqual(metadata.matchedRuleLocations.join(','), 'rules.requestHeaders.onCallToolResult[0]', 'Metadata should include matched rule locations');
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

function getFirstText(result: ToolCallResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}

async function testHandlerAdaptsAndLogsMatchedResult(): Promise<void> {
  const { store, getCount } = createCountingStore(matchingRules());
  const routerResult = textResult('ok');
  let loggedResult: ToolCallResult | undefined;
  let loggedMetadata: RequestHeaderPolicyLogMetadata | undefined;
  let callLogContext: ToolCallLogContext | undefined;
  let resultLogContext: ToolCallResultLogContext | undefined;
  let routerContext: ToolRuntimeContext | undefined;
  let routerInvocation: ToolInvocationContext | undefined;
  const controller = new AbortController();
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
    generateCallId: () => 'call_test',
    routeToolCall: async (_name, _args, context, invocation) => {
      routerContext = context;
      routerInvocation = invocation;
      assertEqual(getCount(), 1, 'Router should run after exactly one snapshot read');
      return routerResult;
    },
  });

  const returned = await runWithRequestHeaderContext(
    createStrictRequestHeaderView(['X-Client', 'android-studio']),
    () => handler(
      { params: { name: 'fake_tool', arguments: {} } },
      {
        signal: controller.signal,
        sessionId: 'session_test',
        requestId: 'request_test',
      },
    ),
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
  assert(routerInvocation !== undefined, 'Router should receive a ToolInvocationContext');
  assert(Object.isFrozen(routerInvocation), 'ToolInvocationContext should be frozen at the handler boundary');
  assertEqual(routerInvocation.callId, 'call_test', 'Router invocation should reuse the log call ID');
  assertEqual(routerInvocation.requestId, 'request_test', 'Router invocation should retain the SDK request ID');
  assertEqual(routerInvocation.sessionId, 'session_test', 'Router invocation should retain the SDK session ID');
  assertEqual(routerInvocation.signal, controller.signal, 'Router invocation should retain the SDK cancellation signal');
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

async function testArgumentsNormalizeOnlyWhenMissing(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  let loggedArgs: unknown;
  let routedArgs: unknown;
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall(_toolName, args) {
        loggedArgs = args;
      },
      logToolResult() {},
    },
    routeToolCall: async (_name, args) => {
      routedArgs = args;
      return textResult('ok');
    },
  });

  await handler({ params: { name: 'fake_tool', arguments: null } });
  assertEqual(loggedArgs, null, 'Explicit null should be logged without normalization');
  assertEqual(routedArgs, null, 'Explicit null should reach effective validation unchanged');

  await handler({ params: { name: 'fake_tool' } });
  assert(
    typeof loggedArgs === 'object' && loggedArgs !== null && !Array.isArray(loggedArgs),
    'Missing arguments should be logged as an empty object',
  );
  assert(
    typeof routedArgs === 'object' && routedArgs !== null && !Array.isArray(routedArgs),
    'Missing arguments should route as an empty object',
  );
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

async function testHandlerWaitsForAsyncCallLogBeforeRouting(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  const events: string[] = [];
  let resolveCallLog: (() => void) | undefined;
  const callLogCompletion = new Promise<void>((resolve) => {
    resolveCallLog = () => {
      events.push('call:complete');
      resolve();
    };
  });
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {
        events.push('call:start');
        return callLogCompletion;
      },
      logToolResult() {
        events.push('result');
      },
    },
    routeToolCall: async () => {
      events.push('route');
      return textResult('ok');
    },
  });

  const pendingResult = handler({ params: { name: 'async_call_log', arguments: {} } });
  await Promise.resolve();
  assertEqual(
    events.join('>'),
    'call:start',
    'Routing must wait for the asynchronous CALL logger to succeed',
  );
  assert(resolveCallLog !== undefined, 'CALL logger test should expose its completion');
  resolveCallLog();

  const result = await pendingResult;

  assertEqual(
    events.join('>'),
    'call:start>call:complete>route>result',
    'RESULT logging should begin only after a successful asynchronous CALL log',
  );
  assertEqual(result.isError, false, 'Asynchronous CALL logging should preserve the tool result');
}

async function testHandlerContainsRouterFailuresAndMalformedResults(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  const diagnostics: ToolCallPipelineDiagnostic[] = [];
  const loggedResults: ToolCallResult[] = [];
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult(_toolName, result) {
        loggedResults.push(result);
      },
    },
    generateCallId: () => 'call_boundary_test',
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
      if (diagnostic.kind === 'router_exception') {
        throw new Error('diagnostic sink failure');
      }
      return Promise.reject(new Error('async diagnostic sink failure'));
    },
    routeToolCall: async (name) => {
      if (name === 'router_failure') {
        throw new Error('router-secret-detail');
      }
      return {
        content: [{ type: 'text', text: 'not enough' }],
        isError: 'not-a-boolean',
      } as unknown as ToolCallResult;
    },
  });

  const [routerFailure, malformedResult] = await runWithRequestHeaderContext(
    createStrictRequestHeaderView(['X-Client', 'android-studio']),
    async () => Promise.all([
      handler({ params: { name: 'router_failure', arguments: {} } }),
      handler({ params: { name: 'malformed_result', arguments: {} } }),
    ]),
  );

  assert(routerFailure !== undefined, 'Router exception should produce a controlled result');
  assert(malformedResult !== undefined, 'Malformed router result should produce a controlled result');
  assertEqual(routerFailure.isError, true, 'Router exception should become an MCP tool error');
  assertEqual(malformedResult.isError, true, 'Malformed result should become an MCP tool error');
  assert('structuredContent' in routerFailure, 'Router exception should still receive request-policy adaptation');
  assert('structuredContent' in malformedResult, 'Malformed result should still receive request-policy adaptation');
  assertNotIncludes(
    getFirstText(routerFailure),
    'router-secret-detail',
    'Controlled router failure must not expose the original exception detail',
  );
  assertEqual(loggedResults[0], routerFailure, 'Router failure logger should receive the adapted result');
  assertEqual(loggedResults[1], malformedResult, 'Malformed-result logger should receive the adapted result');
  assertEqual(diagnostics.length, 2, 'Each controlled pipeline failure should emit one diagnostic');
  assertEqual(diagnostics[0]?.kind, 'router_exception', 'Router exception diagnostic should be classified');
  assertEqual(diagnostics[1]?.kind, 'malformed_result', 'Malformed result diagnostic should be classified');
  assertEqual(diagnostics[0]?.callId, 'call_boundary_test', 'Diagnostic should use the generated correlation ID');
  assert(Object.isFrozen(diagnostics[0]), 'Diagnostics should be frozen structured metadata');
  assert(
    !('error' in (diagnostics[0] as unknown as Record<string, unknown>)),
    'Diagnostics must not expose raw caught errors',
  );
}

async function testMalformedNestedAccessorIsIsolatedBeforeAdapterAndLogger(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  const diagnostics: ToolCallPipelineDiagnostic[] = [];
  let accessorReads = 0;
  let loggedResult: ToolCallResult | undefined;
  const image = {
    type: 'image',
    mimeType: 'image/png',
  } as Record<string, unknown>;
  Object.defineProperty(image, 'data', {
    enumerable: true,
    get() {
      accessorReads++;
      throw new Error('private accessor failure');
    },
  });

  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult(_toolName, result) {
        loggedResult = result;
      },
    },
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
    },
    routeToolCall: async () => ({
      content: [image],
      isError: false,
    } as unknown as ToolCallResult),
  });

  const returned = await runWithRequestHeaderContext(
    createStrictRequestHeaderView(['X-Client', 'android-studio']),
    () => handler({ params: { name: 'accessor_result', arguments: {} } }),
  );

  assertEqual(accessorReads, 0, 'Validation should reject accessors without evaluating them');
  assertEqual(returned.isError, true, 'Malformed nested accessors should become controlled tool errors');
  assert('structuredContent' in returned, 'Controlled malformed errors should still receive request policy adaptation');
  assertEqual(loggedResult, returned, 'Logger should receive only the controlled adapted error');
  assertEqual(diagnostics.length, 1, 'Malformed nested accessors should emit one diagnostic');
  assertEqual(diagnostics[0]?.kind, 'malformed_result', 'Nested accessor failure should be classified as malformed');
}

async function testLoggerFailuresAreIsolatedAndResultIsAttemptedOnce(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  let routedAfterCallLogFailure = 0;
  let resultAttemptsAfterCallLogFailure = 0;
  const callLogDiagnostics: ToolCallPipelineDiagnostic[] = [];
  const callLoggerFailureHandler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {
        return Promise.reject(new Error('CALL logger failure'));
      },
      logToolResult() {
        resultAttemptsAfterCallLogFailure++;
      },
    },
    routeToolCall: async () => {
      routedAfterCallLogFailure++;
      return textResult('ok');
    },
    onDiagnostic(diagnostic) {
      callLogDiagnostics.push(diagnostic);
    },
  });

  const callLoggerFailureResult = await callLoggerFailureHandler({
    params: { name: 'call_logger_failure', arguments: {} },
  });

  assertEqual(routedAfterCallLogFailure, 1, 'CALL logger failure must not block routing');
  assertEqual(resultAttemptsAfterCallLogFailure, 0, 'RESULT logging should not run without a successful CALL log');
  assertEqual(callLoggerFailureResult.isError, false, 'CALL logger failure must preserve the tool result');
  assertEqual(callLogDiagnostics.length, 1, 'CALL logger failure should emit one safe diagnostic');
  assertEqual(callLogDiagnostics[0]?.kind, 'call_log_failed', 'CALL logger diagnostic should be classified');

  let resultAttempts = 0;
  const resultLogDiagnostics: ToolCallPipelineDiagnostic[] = [];
  const resultLoggerFailureHandler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult() {
        resultAttempts++;
        return Promise.reject(new Error('RESULT logger failure'));
      },
    },
    routeToolCall: async () => textResult('ok'),
    onDiagnostic(diagnostic) {
      resultLogDiagnostics.push(diagnostic);
    },
  });

  const resultLoggerFailureResult = await resultLoggerFailureHandler({
    params: { name: 'result_logger_failure', arguments: {} },
  });

  assertEqual(resultAttempts, 1, 'Successful CALL logging should attempt RESULT logging exactly once');
  assertEqual(resultLoggerFailureResult.isError, false, 'RESULT logger failure must preserve the tool result');
  assertEqual(resultLogDiagnostics.length, 1, 'RESULT logger failure should emit one safe diagnostic');
  assertEqual(resultLogDiagnostics[0]?.kind, 'result_log_failed', 'RESULT logger diagnostic should be classified');
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
      { name: 'arguments normalize only when missing', run: testArgumentsNormalizeOnlyWhenMissing },
      { name: 'handler order uses adapted result for logger', run: testHandlerOrderUsesAdaptedResultForLogger },
      { name: 'handler waits for asynchronous CALL logging', run: testHandlerWaitsForAsyncCallLogBeforeRouting },
      { name: 'router failures and malformed results are contained', run: testHandlerContainsRouterFailuresAndMalformedResults },
      { name: 'malformed nested accessor is isolated before adapter and logger', run: testMalformedNestedAccessorIsIsolatedBeforeAdapterAndLogger },
      { name: 'logger failures are isolated with one RESULT attempt', run: testLoggerFailuresAreIsolatedAndResultIsAttemptedOnce },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
