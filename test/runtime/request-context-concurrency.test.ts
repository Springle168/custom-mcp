import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeRulesConfig } from '../../src/config.js';
import type { ConfigStore } from '../../src/runtime/config-store.js';
import { runWithRequestHeaderContext } from '../../src/runtime/request-context.js';
import type { RequestHeaderPolicyLogMetadata } from '../../src/runtime/request-header-policy.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request-header-view.js';
import { createToolCallRequestHandler } from '../../src/runtime/tool-call-handler.js';
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
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'request-context-concurrency');
const PRIMARY_DIR = path.join(FIXTURES_DIR, 'primary');

interface LoggedResult {
  readonly result: ToolCallResult;
  readonly metadata: RequestHeaderPolicyLogMetadata | undefined;
}

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

function createCountingStore(rules: RuntimeRulesConfig): {
  readonly store: ConfigStore;
  readonly getCount: () => number;
} {
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

function reservedResult(text: string): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
    structuredPayload: { toolName: text },
    structuredContent: { stale: true },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasStructuredContent(result: ToolCallResult): boolean {
  return 'structuredContent' in result;
}

function hasStructuredPayload(result: ToolCallResult): boolean {
  return 'structuredPayload' in result;
}

function getStructuredContentRecord(result: ToolCallResult): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  assert(
    typeof structuredContent === 'object' && structuredContent !== null && !Array.isArray(structuredContent),
    'Expected structuredContent payload object',
  );
  return structuredContent as Record<string, unknown>;
}

function assertMatchedMetadata(metadata: RequestHeaderPolicyLogMetadata | undefined): void {
  assert(metadata !== undefined, 'Logger should receive metadata for matched request');
  assertEqual(metadata.rulesConfigured, true, 'Matched metadata should report configured rules');
  assertEqual(metadata.matchedRuleLocations.join(','), 'rules.requestHeaders[0]', 'Matched metadata should include rule location');
  assertEqual(metadata.enabledFeatures.join(','), 'structuredContent', 'Matched metadata should include enabled feature');
}

function assertNoMatchMetadata(metadata: RequestHeaderPolicyLogMetadata | undefined): void {
  assert(metadata !== undefined, 'Logger should receive metadata for unmatched request');
  assertEqual(metadata.rulesConfigured, true, 'No-match metadata should report configured rules');
  assertEqual(metadata.matchedRuleLocations.length, 0, 'No-match metadata should not include matched rules');
  assertEqual(metadata.enabledFeatures.length, 0, 'No-match metadata should not include enabled features');
}

async function testConcurrentContextsDoNotCrossTalk(): Promise<void> {
  const { store } = createCountingStore(matchingRules());
  const loggedResults = new Map<string, LoggedResult>();
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult(toolName, result, _durationMs, metadata) {
        loggedResults.set(toolName, { result, metadata });
      },
    },
    routeToolCall: async (name) => {
      await delay(name === 'matching_tool' ? 20 : 5);
      return reservedResult(name);
    },
  });

  const [matchedResult, unmatchedResult] = await Promise.all([
    runWithRequestHeaderContext(
      createStrictRequestHeaderView(['X-Client', 'android-studio']),
      () => handler({ params: { name: 'matching_tool', arguments: {} } }),
    ),
    runWithRequestHeaderContext(
      createStrictRequestHeaderView(['X-Client', 'other-client']),
      () => handler({ params: { name: 'unmatched_tool', arguments: {} } }),
    ),
  ]);

  assert(hasStructuredContent(matchedResult), 'Matched concurrent request should receive structuredContent');
  assert(!hasStructuredContent(unmatchedResult), 'Unmatched concurrent request should not receive structuredContent');
  assertEqual(getStructuredContentRecord(matchedResult).toolName, 'matching_tool', 'Matched concurrent request should receive its own payload');
  assert(!hasStructuredPayload(matchedResult), 'Matched concurrent request should not leak structuredPayload');
  assert(!hasStructuredPayload(unmatchedResult), 'Unmatched concurrent request should not leak structuredPayload');
  assertMatchedMetadata(loggedResults.get('matching_tool')?.metadata);
  assertNoMatchMetadata(loggedResults.get('unmatched_tool')?.metadata);
  assertEqual(loggedResults.get('matching_tool')?.result, matchedResult, 'Matched logger result should equal returned result');
  assertEqual(loggedResults.get('unmatched_tool')?.result, unmatchedResult, 'Unmatched logger result should equal returned result');
}

async function testSameContextSharesViewAndReadsSnapshotPerCall(): Promise<void> {
  const { store, getCount } = createCountingStore(matchingRules());
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall() {},
      logToolResult() {},
    },
    routeToolCall: async (name) => reservedResult(name),
  });
  const view = createStrictRequestHeaderView(['X-Client', 'android-studio']);

  const [firstResult, secondResult] = await runWithRequestHeaderContext(view, async () => {
    const first = await handler({ params: { name: 'first_tool', arguments: {} } });
    const second = await handler({ params: { name: 'second_tool', arguments: {} } });
    return [first, second] as const;
  });

  assert(hasStructuredContent(firstResult), 'First call in the same request context should match shared strict view');
  assert(hasStructuredContent(secondResult), 'Second call in the same request context should match shared strict view');
  assertEqual(getStructuredContentRecord(firstResult).toolName, 'first_tool', 'First call should use first payload');
  assertEqual(getStructuredContentRecord(secondResult).toolName, 'second_tool', 'Second call should use second payload');
  assert(!hasStructuredPayload(firstResult), 'First call should not leak structuredPayload');
  assert(!hasStructuredPayload(secondResult), 'Second call should not leak structuredPayload');
  assertEqual(getCount(), 2, 'Each tools/call should read the snapshot at call start');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing request context concurrency isolation',
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'concurrent request contexts do not cross-talk', run: testConcurrentContextsDoNotCrossTalk },
      { name: 'same context shares view and reads snapshot per call', run: testSameContextSharesViewAndReadsSnapshotPerCall },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
