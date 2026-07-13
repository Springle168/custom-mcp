import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigStore, type ConfigStore } from '../../src/runtime/config-store.js';
import { createToolCallRequestHandler } from '../../src/runtime/tool-call-handler.js';
import { createToolRuntimeContext } from '../../src/runtime/tool-context.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import {
  createTestLoadedRuntimeConfig,
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
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'runtime-config-store');
const PRIMARY_DIR = path.join(FIXTURES_DIR, 'primary');
const ADDITIONAL_DIR = path.join(FIXTURES_DIR, 'additional');

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(PRIMARY_DIR, { recursive: true });
  await fs.mkdir(ADDITIONAL_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

function createSnapshot(
  options: {
    readonly host?: string;
    readonly port?: number;
    readonly snapshotVersion?: number;
  } = {},
) {
  return createTestRuntimeConfigSnapshot({
    rootDir: PRIMARY_DIR,
    otherRootDirs: [ADDITIONAL_DIR],
    ...(options.host !== undefined ? { host: options.host } : {}),
    port: options.port ?? 3100,
    snapshotVersion: options.snapshotVersion ?? 1,
    android: {
      workspaceRoot: PRIMARY_DIR,
      javaHome: path.join(PRIMARY_DIR, 'jbr'),
      buildTimeoutMs: 1000,
      maxErrorBlockChars: 2500,
      maxLogTailChars: 4000,
    },
  });
}

async function testStoreReturnsInitialSnapshot(): Promise<void> {
  const initialConfig = createTestLoadedRuntimeConfig({
    rootDir: PRIMARY_DIR,
    otherRootDirs: [ADDITIONAL_DIR],
  });
  const store = createConfigStore(initialConfig);
  const logsRootStats = await fs.stat(initialConfig.snapshot.logsDir);

  assertEqual(store.getSnapshot(), initialConfig.snapshot, 'ConfigStore should return the initial snapshot');
  assertEqual(store.getIdentity(), initialConfig.identity, 'ConfigStore should return the initial runtime identity');
  assertEqual(store.getSnapshot().snapshotVersion, 1, 'Initial snapshot version should be 1');
  assert(logsRootStats.isDirectory(), 'Test runtime snapshot helper should provide an existing logs root');
  assertEqual(store.getStatus().state, 'ok', 'Initial ConfigStore status should be ok');
  assert(Object.isFrozen(store), 'ConfigStore should freeze its public facade');
  assert(Object.isFrozen(store.getIdentity()), 'Runtime identity baseline should be frozen');
}

async function testStoreDoesNotExposeMutableSnapshotWriter(): Promise<void> {
  const initialConfig = createTestLoadedRuntimeConfig({
    rootDir: PRIMARY_DIR,
    otherRootDirs: [ADDITIONAL_DIR],
  });
  const store = createConfigStore(initialConfig);
  const unsafeStore = store as unknown as Record<string, unknown>;

  assert(
    unsafeStore.setSnapshot === undefined,
    'ConfigStore should not expose a mutable snapshot writer to tool code',
  );
  assert(Object.isFrozen(store.getSnapshot()), 'Snapshot returned from store should be frozen');
}

async function testToolRuntimeContextDerivesFromSnapshot(): Promise<void> {
  const snapshot = createSnapshot();
  const context = createToolRuntimeContext(snapshot);

  assertEqual(
    context.pathSafetyContext,
    snapshot.pathSafetyContext,
    'ToolRuntimeContext should reuse the call snapshot path safety context',
  );
  assertEqual(context.lineEnding, snapshot.lineEnding, 'ToolRuntimeContext should copy line ending');
  assertEqual(context.android, snapshot.android, 'ToolRuntimeContext should expose snapshot Android config');
  assertEqual(
    context.askUser.makeUrl('session-1'),
    `http://127.0.0.1:${snapshot.port}/ask/session-1`,
    'ask_user URL should be derived from the call snapshot',
  );
}

function testToolRuntimeContextFormatsIpHosts(): void {
  const ipv6Context = createToolRuntimeContext(createSnapshot({ host: '::1' }));
  assertEqual(
    ipv6Context.askUser.makeUrl('session-1'),
    'http://[::1]:3100/ask/session-1',
    'ask_user URL should wrap IPv6 hosts in brackets',
  );

  const ipv4WildcardContext = createToolRuntimeContext(createSnapshot({ host: '0.0.0.0' }));
  assertEqual(
    ipv4WildcardContext.askUser.makeUrl('session-1'),
    'http://127.0.0.1:3100/ask/session-1',
    'IPv4 wildcard binds should produce a local endpoint URL',
  );

  const ipv6WildcardContext = createToolRuntimeContext(createSnapshot({ host: '::' }));
  assertEqual(
    ipv6WildcardContext.askUser.makeUrl('session-1'),
    'http://[::1]:3100/ask/session-1',
    'IPv6 wildcard binds should produce a local endpoint URL',
  );
}

async function testSnapshotDeepFreeze(): Promise<void> {
  const snapshot = createSnapshot();

  assert(Object.isFrozen(snapshot), 'Snapshot should be frozen');
  assert(Object.isFrozen(snapshot.otherRootDirs), 'Snapshot otherRootDirs should be frozen');
  assert(Object.isFrozen(snapshot.android), 'Snapshot android config should be frozen');
  assert(Object.isFrozen(snapshot.pathSafetyContext), 'PathSafetyContext should be frozen');
  assert(Object.isFrozen(snapshot.pathSafetyContext.primaryRoot), 'Primary root should be frozen');
  assert(Object.isFrozen(snapshot.pathSafetyContext.allowedRoots), 'Allowed roots array should be frozen');
  for (const allowedRoot of snapshot.pathSafetyContext.allowedRoots) {
    assert(Object.isFrozen(allowedRoot), 'Each allowed root should be frozen');
  }
}

async function testToolCallHandlerReadsStoreOnce(): Promise<void> {
  const firstSnapshot = createSnapshot({ port: 3101, snapshotVersion: 1 });
  const secondSnapshot = createSnapshot({ port: 3102, snapshotVersion: 2 });
  let getSnapshotCount = 0;
  let now = 1000;
  const result: ToolCallResult = {
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  };
  const loggerEvents: string[] = [];
  const store: ConfigStore = {
    getSnapshot() {
      getSnapshotCount++;
      return getSnapshotCount === 1 ? firstSnapshot : secondSnapshot;
    },
    getIdentity() {
      return createTestRuntimeConfigIdentity(firstSnapshot);
    },
    getStatus() {
      return { state: 'ok' };
    },
  };
  const handler = createToolCallRequestHandler({
    configStore: store,
    logger: {
      logToolCall(toolName, args) {
        loggerEvents.push(`call:${toolName}:${String(args.value)}`);
      },
      logToolResult(toolName, toolResult, durationMs) {
        loggerEvents.push(`result:${toolName}:${toolResult.content[0]?.text}:${durationMs}`);
      },
    },
    now: () => {
      now += 25;
      return now;
    },
    routeToolCall: async (name, args, context) => {
      assertEqual(name, 'fake_tool', 'Handler should pass the requested tool name to the router');
      assertEqual(args.value, 42, 'Handler should pass request arguments to the router');
      assertEqual(getSnapshotCount, 1, 'Router should see exactly one snapshot read at call start');
      assertEqual(
        context.pathSafetyContext,
        firstSnapshot.pathSafetyContext,
        'Router context should be derived from the snapshot read at call start',
      );
      assertEqual(
        context.askUser.makeUrl('session-1'),
        'http://127.0.0.1:3101/ask/session-1',
        'Router context should not switch to a later snapshot during the same tool call',
      );
      return result;
    },
  });

  const actual = await handler({
    params: {
      name: 'fake_tool',
      arguments: { value: 42 },
    },
  });

  assertEqual(actual, result, 'Handler should return the router result');
  assertEqual(getSnapshotCount, 1, 'Tool call handler should read the store once per tool call');
  assertEqual(loggerEvents[0], 'call:fake_tool:42', 'Handler should log the tool call');
  assertEqual(loggerEvents[1], 'result:fake_tool:ok:25', 'Handler should log the tool result duration');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing runtime ConfigStore boundaries',
    details: `Fixtures directory: ${FIXTURES_DIR}`,
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'returns initial snapshot', run: testStoreReturnsInitialSnapshot },
      { name: 'does not expose mutable snapshot writer', run: testStoreDoesNotExposeMutableSnapshotWriter },
      { name: 'derives tool runtime context from snapshot', run: testToolRuntimeContextDerivesFromSnapshot },
      { name: 'formats IP hosts for tool URLs', run: testToolRuntimeContextFormatsIpHosts },
      { name: 'deep-freezes snapshot graph', run: testSnapshotDeepFreeze },
      { name: 'tool call handler reads store once', run: testToolCallHandlerReadsStoreOnce },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
