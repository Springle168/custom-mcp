import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolRuntimeContext } from '../../src/runtime/tool-context.js';
import {
  createTestLoadedRuntimeConfig,
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

function createSnapshot() {
  return createTestRuntimeConfigSnapshot({
    rootDir: PRIMARY_DIR,
    otherRootDirs: [ADDITIONAL_DIR],
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
  const store = await import('../../src/runtime/config-store.js').then((module) =>
    module.createConfigStore(initialConfig),
  );

  assertEqual(store.getSnapshot(), initialConfig.snapshot, 'ConfigStore should return the initial snapshot');
  assertEqual(store.getIdentity(), initialConfig.identity, 'ConfigStore should return the initial runtime identity');
  assertEqual(store.getSnapshot().snapshotVersion, 1, 'Initial snapshot version should be 1');
  assertEqual(store.getStatus().state, 'ok', 'Initial ConfigStore status should be ok');
}

async function testStoreDoesNotExposeMutableSnapshotWriter(): Promise<void> {
  const initialConfig = createTestLoadedRuntimeConfig({
    rootDir: PRIMARY_DIR,
    otherRootDirs: [ADDITIONAL_DIR],
  });
  const store = await import('../../src/runtime/config-store.js').then((module) =>
    module.createConfigStore(initialConfig),
  );
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
    `http://localhost:${snapshot.port}/ask/session-1`,
    'ask_user URL should be derived from the call snapshot',
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

async function testToolCallStartGetsOneSnapshot(): Promise<void> {
  const snapshot = createSnapshot();
  let getSnapshotCount = 0;
  const store = {
    getSnapshot() {
      getSnapshotCount++;
      return snapshot;
    },
    getStatus() {
      return { state: 'ok' as const };
    },
  };

  const callSnapshot = store.getSnapshot();
  const context = createToolRuntimeContext(callSnapshot);

  assertEqual(getSnapshotCount, 1, 'Tool call start should read the store once');
  assertEqual(
    context.pathSafetyContext,
    snapshot.pathSafetyContext,
    'Tool runtime context should remain tied to the snapshot read at call start',
  );
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
      { name: 'deep-freezes snapshot graph', run: testSnapshotDeepFreeze },
      { name: 'tool call start reads store once', run: testToolCallStartGetsOneSnapshot },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
