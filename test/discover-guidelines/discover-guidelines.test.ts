import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';
import discoverGuidelinesTool, {
  discoverGuidelinesInternalForTests,
} from '../../src/tools/built-in/guidelines/discover-guidelines.js';
import {
  MAX_GUIDELINE_FILES,
  MAX_GUIDELINE_PREFIX_BYTES,
} from '../../src/tools/built-in/guidelines/discover-guidelines.limits.js';
import { getAllToolDefinitions } from '../../src/tools/index.js';
import { TOOL_NAMES } from '../../src/tools/names.js';
import {
  createFileAccessPolicyContext,
  type FileAccessPolicyQuery,
  type RootFileAccessPolicy,
} from '../../src/utils/file-access-policy.js';
import { FILE_READ_CONCURRENCY } from '../../src/utils/file-read-policy.js';
import { callBuiltInTool } from '../helpers/built-in-tool-call.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'discover-guidelines');
const ADDITIONAL_ROOT = path.join(__dirname, '..', 'fixtures', 'discover-guidelines-additional');

function numberedGuidelinePath(index: number): string {
  return path.join('many', `${String(index).padStart(String(MAX_GUIDELINE_FILES).length, '0')}.md`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function deadline(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for the controlled inspection boundary')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function guideline(name: string, description = `Description for ${name}`): string {
  return `---
name: ${name}
description: ${description}
---
# ${name}

PRIVATE BODY CONTENT
`;
}

async function resetFixtures(): Promise<void> {
  assert(
    MAX_GUIDELINE_FILES > FILE_READ_CONCURRENCY,
    'Worker lifecycle tests require within-limit files beyond the first worker wave',
  );
  await Promise.all([
    fs.rm(FIXTURES_DIR, { recursive: true, force: true }),
    fs.rm(ADDITIONAL_ROOT, { recursive: true, force: true }),
  ]);
  await Promise.all([
    fs.mkdir(path.join(FIXTURES_DIR, 'guides'), { recursive: true }),
    fs.mkdir(path.join(FIXTURES_DIR, 'ignored'), { recursive: true }),
    fs.mkdir(path.join(FIXTURES_DIR, 'denied'), { recursive: true }),
    fs.mkdir(path.join(FIXTURES_DIR, 'many'), { recursive: true }),
    fs.mkdir(ADDITIONAL_ROOT, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(FIXTURES_DIR, 'guides', 'b.md'), guideline('beta')),
    fs.writeFile(path.join(FIXTURES_DIR, 'guides', 'a.MD'), guideline('alpha')),
    fs.writeFile(path.join(FIXTURES_DIR, 'guides', 'invalid.md'), '# no metadata'),
    fs.writeFile(path.join(FIXTURES_DIR, 'guides', 'plain.txt'), guideline('not-markdown')),
    fs.writeFile(path.join(FIXTURES_DIR, 'ignored', 'soft.md'), guideline('soft')),
    fs.writeFile(path.join(FIXTURES_DIR, 'denied', 'secret.md'), guideline('secret')),
    fs.writeFile(path.join(ADDITIONAL_ROOT, 'additional.md'), guideline('additional')),
    fs.writeFile(
      path.join(FIXTURES_DIR, 'guides', 'over-limit.md'),
      `---\nname: too-large\ndescription: ${'x'.repeat(MAX_GUIDELINE_PREFIX_BYTES)}\n---\n`,
    ),
  ]);
  await Promise.all(
    Array.from({ length: MAX_GUIDELINE_FILES + 1 }, (_, index) =>
      fs.writeFile(
        path.join(FIXTURES_DIR, numberedGuidelinePath(index)),
        guideline(`guide-${index}`),
      ),
    ),
  );
}

async function cleanupFixtures(): Promise<void> {
  await Promise.all([
    fs.rm(FIXTURES_DIR, { recursive: true, force: true }),
    fs.rm(ADDITIONAL_ROOT, { recursive: true, force: true }),
  ]);
}

function query(patterns: readonly string[]): FileAccessPolicyQuery {
  const matcher = ignore({ ignorecase: process.platform === 'win32' });
  matcher.add([...patterns]);
  return Object.freeze({
    isIgnored: (candidate: string) => matcher.ignores(candidate),
  });
}

function createContext(
  options: {
    readonly ignore?: readonly string[];
    readonly deny?: readonly string[];
    readonly additionalRoot?: boolean;
  } = {},
) {
  const base = createTestToolRuntimeContext({
    rootDir: FIXTURES_DIR,
    otherRootDirs: options.additionalRoot ? [ADDITIONAL_ROOT] : [],
  });
  const policies: RootFileAccessPolicy[] = base.pathSafetyContext.allowedRoots.map((root) => ({
    rootDir: root.rootDir,
    realRootDir: root.realRootDir ?? root.rootDir,
    ignore: query(root.rootDir === FIXTURES_DIR ? (options.ignore ?? []) : []),
    deny: query(root.rootDir === FIXTURES_DIR ? (options.deny ?? []) : []),
  }));
  return {
    ...base,
    fileAccessPolicyContext: createFileAccessPolicyContext(base.pathSafetyContext, policies),
  };
}

function payload(result: Awaited<ReturnType<typeof discoverGuidelinesTool.handler>>) {
  return JSON.parse(getResultText(result)) as {
    guidelines: Array<{ name: string; description: string; file_path: string }>;
    note?: string;
  };
}

async function testDefinitionAndValidation(): Promise<void> {
  assertEqual(
    discoverGuidelinesTool.definition.name,
    'discover_guidelines',
    'Tool name should be canonical',
  );
  assert(
    TOOL_NAMES.includes('discover_guidelines'),
    'Canonical tool names should include discover_guidelines',
  );
  assert(
    getAllToolDefinitions().some((definition) => definition.name === 'discover_guidelines'),
    'The built-in registry should expose discover_guidelines',
  );
  const schema = discoverGuidelinesTool.definition.inputSchema;
  assertEqual(schema.additionalProperties, false, 'Schema should reject unknown fields');
  assert(
    Array.isArray(schema.required) && schema.required.includes('include'),
    'Schema should require include',
  );

  for (const args of [
    {},
    { include: [] },
    { include: [''] },
    { include: ['guides/a.MD'], exclude: [1] },
    { include: ['guides/a.MD'], use_ignore_files: 'false' },
    { include: ['guides/a.MD'], extra: true },
  ]) {
    const result = await callBuiltInTool(
      'discover_guidelines',
      args,
      createContext(),
      createTestToolInvocationContext(),
    );
    assert(result.isError, `Invalid catalog args should fail: ${JSON.stringify(args)}`);
    assertIncludes(
      getResultText(result),
      'configured input schema',
      'Invalid arguments should fail at the schema boundary',
    );
  }
}

async function testLiteralGlobSortingAndBodyPrivacy(): Promise<void> {
  const result = await discoverGuidelinesTool.handler(
    { include: ['guides/*'] },
    createContext(),
    createTestToolInvocationContext(),
  );
  assert(!result.isError, 'Mixed Markdown discovery should succeed');
  const text = getResultText(result);
  assertEqual(text.includes('\n'), false, 'JSON result should be compact');
  assertNotIncludes(text, 'PRIVATE BODY CONTENT', 'Markdown body must not be returned');
  const value = payload(result);
  assertEqual(value.guidelines.length, 2, 'Only valid Markdown metadata should be returned');
  assertEqual(
    value.guidelines[0]?.name,
    'alpha',
    'Each glob should follow stable display-path sorting',
  );
  assertEqual(
    value.guidelines[0]?.file_path,
    path.join('guides', 'a.MD'),
    'Relative selectors should use relative display paths',
  );
  assertEqual(value.guidelines[1]?.name, 'beta', 'Second sorted guideline should be returned');
  assertEqual(
    value.note,
    undefined,
    'Invalid peer Markdown should not add noise when valid guides exist',
  );
}

async function testAbsoluteAdditionalRootAndDeduplication(): Promise<void> {
  const additionalFile = path.join(ADDITIONAL_ROOT, 'additional.md');
  const result = await discoverGuidelinesTool.handler(
    { include: [additionalFile, additionalFile] },
    createContext({ additionalRoot: true }),
    createTestToolInvocationContext(),
  );
  const value = payload(result);
  assertEqual(value.guidelines.length, 1, 'Real read paths should be deduplicated');
  assertEqual(
    value.guidelines[0]?.file_path,
    additionalFile,
    'Absolute selectors should retain absolute display paths',
  );
}

async function testIncludeOrderAndFirstIdentityWins(): Promise<void> {
  const absoluteBeta = path.join(FIXTURES_DIR, 'guides', 'b.md');
  const result = await discoverGuidelinesTool.handler(
    { include: [absoluteBeta, 'guides/*', 'guides/b.md'] },
    createContext(),
    createTestToolInvocationContext(),
  );
  const value = payload(result);
  assertEqual(value.guidelines.length, 2, 'Repeated identities should be inspected once');
  assertEqual(value.guidelines[0]?.name, 'beta', 'The first selector wins over global sorting');
  assertEqual(value.guidelines[0]?.file_path, absoluteBeta, 'The first display path is retained');
  assertEqual(value.guidelines[1]?.name, 'alpha', 'A later glob expands at its own position');
}

async function testExcludeAndIgnoreSemantics(): Promise<void> {
  const ignoredContext = createContext({ ignore: ['ignored/**'] });
  const defaultResult = await discoverGuidelinesTool.handler(
    { include: ['ignored/*.md'] },
    ignoredContext,
    createTestToolInvocationContext(),
  );
  assertEqual(payload(defaultResult).guidelines.length, 1, 'ignoreFiles should default to false');

  const filtered = await discoverGuidelinesTool.handler(
    { include: ['**/*.md'], use_ignore_files: true, exclude: ['guides/**', 'many/**'] },
    ignoredContext,
    createTestToolInvocationContext(),
  );
  const filteredPayload = payload(filtered);
  assertEqual(
    filteredPayload.guidelines.length,
    1,
    'Glob ignore and exclude should filter discovered candidates',
  );
  assertEqual(
    filteredPayload.guidelines[0]?.name,
    'secret',
    'Only the unfiltered glob candidate should remain',
  );
  assertIncludes(
    filteredPayload.note,
    'filtered by configured ignoreFiles rules',
    'Mixed ignore filtering should be disclosed',
  );

  const literal = await discoverGuidelinesTool.handler(
    {
      include: ['ignored/soft.md'],
      use_ignore_files: true,
      exclude: ['ignored/**'],
    },
    ignoredContext,
    createTestToolInvocationContext(),
  );
  assertEqual(
    payload(literal).guidelines.length,
    1,
    'Literal paths should bypass ignore and exclude',
  );
}

async function testDenyAndSkippedPrivacyNotes(): Promise<void> {
  const mixed = await discoverGuidelinesTool.handler(
    { include: ['**/*.md'], exclude: ['many/**'] },
    createContext({ deny: ['denied/**'] }),
    createTestToolInvocationContext(),
  );
  const mixedText = getResultText(mixed);
  assertIncludes(
    mixedText,
    'blocked by the file access deny policy',
    'Mixed deny should add a generic note',
  );
  assertNotIncludes(mixedText, 'secret.md', 'Denied paths must not be disclosed');
  assertNotIncludes(mixedText, 'secret', 'Denied metadata must not be returned');

  const skipped = await discoverGuidelinesTool.handler(
    { include: ['missing.md'] },
    createContext(),
    createTestToolInvocationContext(),
  );
  assert(!skipped.isError, 'Selector-local skipped items are a successful empty discovery');
  assertEqual(
    payload(skipped).note,
    'No readable files were selected from the given include selectors. Some include selectors or selected files could not be inspected.',
    'Skipped selectors should use the fixed ordered note',
  );

  const deniedLiteral = await discoverGuidelinesTool.handler(
    { include: ['denied/secret.md'] },
    createContext({ deny: ['denied/**'] }),
    createTestToolInvocationContext(),
  );
  assert(!deniedLiteral.isError, 'An explicit deny should be a successful empty discovery');
  assertEqual(payload(deniedLiteral).guidelines.length, 0, 'Denied files cannot yield metadata');
  assertIncludes(
    payload(deniedLiteral).note,
    'selected files could not be inspected',
    'An explicit deny should retain a selector failure note',
  );

  const deniedAndValid = await discoverGuidelinesTool.handler(
    { include: ['denied/secret.md', 'guides/b.md'] },
    createContext({ deny: ['denied/**'] }),
    createTestToolInvocationContext(),
  );
  assert(!deniedAndValid.isError, 'A denied selector should not fail readable peers');
  assertEqual(payload(deniedAndValid).guidelines[0]?.name, 'beta', 'Readable peers survive deny');
  assertNotIncludes(
    getResultText(deniedAndValid),
    'secret.md',
    'Notes do not enumerate denied paths',
  );
}

async function testEmptyDiscoveryStates(): Promise<void> {
  const cases = [
    {
      args: { include: ['none/*.md'] },
      note: 'No files matched the given include selectors.',
    },
    {
      args: { include: ['guides/plain.txt'] },
      note: 'Matched files were found, but none were Markdown files.',
    },
    {
      args: { include: ['guides/invalid.md'] },
      note: 'Markdown files were found, but none contained valid guideline Front Matter.',
    },
    {
      args: { include: ['guides/over-limit.md'] },
      note: 'Markdown files were found, but none contained valid guideline Front Matter.',
    },
  ];
  for (const testCase of cases) {
    const result = await discoverGuidelinesTool.handler(
      testCase.args,
      createContext(),
      createTestToolInvocationContext(),
    );
    assert(!result.isError, 'Empty discovery states should be successful');
    assertEqual(payload(result).note, testCase.note, 'Empty state note should be stable');
  }
}

async function testControlledInspectionFailuresRemainPartialResults(): Promise<void> {
  const allFailed = await discoverGuidelinesInternalForTests.discoverGuidelines(
    { include: ['guides/a.MD'] },
    createContext(),
    createTestToolInvocationContext(),
    async () => ({ ok: false as const }),
  );
  assert(
    !allFailed.isError,
    'A controlled single-file failure should remain a successful discovery',
  );
  const allFailedPayload = payload(allFailed);
  assertEqual(
    allFailedPayload.guidelines.length,
    0,
    'Failed inspections should not invent metadata',
  );
  assertIncludes(
    allFailedPayload.note,
    'none contained valid guideline Front Matter',
    'An all-failed Markdown selection should retain the primary empty state',
  );
  assertIncludes(
    allFailedPayload.note,
    'selected files could not be inspected',
    'An all-failed Markdown selection should disclose incompleteness',
  );

  const partial = await discoverGuidelinesInternalForTests.discoverGuidelines(
    { include: ['guides/a.MD', 'guides/b.md'] },
    createContext(),
    createTestToolInvocationContext(),
    async (file) =>
      file.displayPath.endsWith('a.MD')
        ? {
            ok: true as const,
            metadata: { name: 'alpha', description: 'Alpha description' },
          }
        : { ok: false as const },
  );
  const partialPayload = payload(partial);
  assertEqual(
    partialPayload.guidelines.length,
    1,
    'Valid peers should survive a controlled inspection failure',
  );
  assertIncludes(
    partialPayload.note,
    'selected files could not be inspected',
    'Partial failures should add only the completeness note',
  );
}

async function testFileLimit(): Promise<void> {
  const exact = await discoverGuidelinesTool.handler(
    {
      include: Array.from({ length: MAX_GUIDELINE_FILES }, (_, index) =>
        numberedGuidelinePath(index),
      ),
    },
    createContext(),
    createTestToolInvocationContext(),
  );
  const exactValue = payload(exact);
  assertEqual(
    exactValue.guidelines.length,
    MAX_GUIDELINE_FILES,
    'An exact-limit batch is complete',
  );
  assertEqual(exactValue.note, undefined, 'An exact-limit batch needs no completeness note');

  const result = await discoverGuidelinesTool.handler(
    { include: ['many/*.md'] },
    createContext(),
    createTestToolInvocationContext(),
  );
  const value = payload(result);
  assertEqual(
    value.guidelines.length,
    MAX_GUIDELINE_FILES,
    'Only the configured number of Markdown files should be inspected',
  );
  assertEqual(value.guidelines[0]?.name, 'guide-0', 'The first sorted file should be inspected');
  assertEqual(
    value.guidelines.at(-1)?.name,
    `guide-${MAX_GUIDELINE_FILES - 1}`,
    'The last within-limit file should be inspected',
  );
  assertIncludes(
    value.note,
    `Only the first ${MAX_GUIDELINE_FILES} matched Markdown files were inspected.`,
    'File limit should add a completeness note',
  );

  const ordered = await discoverGuidelinesTool.handler(
    {
      include: [
        'guides/plain.txt',
        numberedGuidelinePath(MAX_GUIDELINE_FILES),
        numberedGuidelinePath(MAX_GUIDELINE_FILES),
        'many/*.md',
      ],
    },
    createContext(),
    createTestToolInvocationContext(),
  );
  const orderedValue = payload(ordered);
  assertEqual(
    orderedValue.guidelines.length,
    MAX_GUIDELINE_FILES,
    'The limit follows dedup and Markdown filtering',
  );
  assertEqual(
    orderedValue.guidelines[0]?.name,
    `guide-${MAX_GUIDELINE_FILES}`,
    'An explicit first file stays first',
  );
  assertEqual(
    orderedValue.guidelines.at(-1)?.name,
    `guide-${MAX_GUIDELINE_FILES - 2}`,
    'Glob order fills remaining slots',
  );
}

async function testBoundedWorkersAndStableOrder(): Promise<void> {
  const firstWave = deferred();
  const release = deferred();
  let started = 0;
  let active = 0;
  let maxActive = 0;
  const inspection = discoverGuidelinesInternalForTests.discoverGuidelines(
    { include: ['many/*.md'] },
    createContext(),
    createTestToolInvocationContext(),
    async (file) => {
      started += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (started === FILE_READ_CONCURRENCY) firstWave.resolve();
      try {
        await release.promise;
        return {
          ok: true as const,
          metadata: { name: file.displayPath, description: 'Inspected guideline' },
        };
      } finally {
        active -= 1;
      }
    },
  );
  try {
    await deadline(firstWave.promise);
    assertEqual(
      started,
      FILE_READ_CONCURRENCY,
      'Only the configured number of inspections start before any settle',
    );
    assertEqual(active, FILE_READ_CONCURRENCY, 'The first worker wave remains active');
  } finally {
    release.resolve();
  }
  const result = await inspection;
  assertEqual(maxActive, FILE_READ_CONCURRENCY, 'The tool uses the configured concurrency');
  assertEqual(started, MAX_GUIDELINE_FILES, 'Every within-limit file is eventually inspected');
  const value = payload(result);
  assertEqual(value.guidelines.length, MAX_GUIDELINE_FILES, 'Every inspection result is returned');
  value.guidelines.forEach((entry, index) =>
    assertEqual(entry.name, numberedGuidelinePath(index), 'Worker scheduling preserves file order'),
  );
}

async function testCancellationDrainsStartedInspections(): Promise<void> {
  const firstWave = deferred();
  const release = deferred();
  const controller = new AbortController();
  let started = 0;
  let cleaned = 0;
  let settled = false;
  const resultPromise = discoverGuidelinesInternalForTests.discoverGuidelines(
    { include: ['many/*.md'] },
    createContext(),
    createTestToolInvocationContext({ signal: controller.signal }),
    async () => {
      started += 1;
      if (started === FILE_READ_CONCURRENCY) firstWave.resolve();
      try {
        await release.promise;
        return { ok: true as const, metadata: { name: 'late', description: 'late' } };
      } finally {
        cleaned += 1;
      }
    },
  );
  void resultPromise.then(() => {
    settled = true;
  });
  try {
    await deadline(firstWave.promise);
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assertEqual(settled, false, 'Cancellation must wait for already-started inspections to finish');
    assertEqual(started, FILE_READ_CONCURRENCY, 'Cancellation stops scheduling queued files');
  } finally {
    controller.abort();
    release.resolve();
  }
  const result = await resultPromise;
  assert(result.isError, 'Cancellation after reads start should be an error');
  assertIncludes(getResultText(result), 'cancelled', 'Cancellation should use stable error text');
  assertEqual(started, FILE_READ_CONCURRENCY, 'Queued files remain unscheduled after drain');
  assertEqual(cleaned, FILE_READ_CONCURRENCY, 'Every started inspector settles before returning');
}

async function testInternalFailureDrainsStartedInspections(): Promise<void> {
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  let releasePeers!: () => void;
  const peersGate = new Promise<void>((resolve) => {
    releasePeers = resolve;
  });
  let allStarted!: () => void;
  const startedGate = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  let started = 0;
  let cleaned = 0;
  let settled = false;
  const resultPromise = discoverGuidelinesInternalForTests.discoverGuidelines(
    { include: ['many/*.md'] },
    createContext(),
    createTestToolInvocationContext(),
    async () => {
      const index = started++;
      if (started === FILE_READ_CONCURRENCY) allStarted();
      try {
        if (index === 0) {
          await failureGate;
          throw new Error('private internal detail');
        }
        await peersGate;
        return { ok: true as const, metadata: null };
      } finally {
        cleaned += 1;
      }
    },
  );
  void resultPromise.then(() => {
    settled = true;
  });
  try {
    await deadline(startedGate);
    releaseFailure();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assertEqual(started, FILE_READ_CONCURRENCY, 'Internal failure stops claiming files');
    assertEqual(settled, false, 'The tool must not return before peer cleanup');
  } finally {
    releaseFailure();
    releasePeers();
  }
  const result = await resultPromise;
  assertEqual(cleaned, FILE_READ_CONCURRENCY, 'Every started inspector must settle');
  assert(result.isError, 'Unexpected errors remain whole-call errors after drain');
  assertNotIncludes(
    getResultText(result),
    'private internal detail',
    'Internal details remain private',
  );
}

async function testPrefixReadingStopsAfterClosingDelimiter(): Promise<void> {
  const source = Buffer.from(
    `${guideline('bounded')}${'BODY'.repeat(MAX_GUIDELINE_PREFIX_BYTES)}`,
    'utf8',
  );
  let readCalls = 0;
  const fakeHandle = {
    async read(target: Buffer, offset: number, length: number, position: number) {
      readCalls += 1;
      const bytesRead = Math.min(length, source.length - position);
      source.copy(target, offset, position, position + bytesRead);
      return { bytesRead, buffer: target };
    },
  } as unknown as FileHandle;

  const result = await discoverGuidelinesInternalForTests.readBoundedPrefix(
    fakeHandle,
    source.length,
    new AbortController().signal,
  );
  assertEqual(readCalls, 1, 'A closing delimiter in the first chunk should stop further reads');
  assert(
    Buffer.byteLength(result.text, 'utf8') < MAX_GUIDELINE_PREFIX_BYTES,
    'The bounded reader should not fill the prefix budget after finding Front Matter',
  );
}

async function testPreCancelledAndUnexpectedInspectorFailure(): Promise<void> {
  const controller = new AbortController();
  controller.abort();
  const cancelled = await discoverGuidelinesTool.handler(
    { include: ['guides/a.MD'] },
    createContext(),
    createTestToolInvocationContext({ signal: controller.signal }),
  );
  assert(cancelled.isError, 'Pre-cancelled direct handler calls should fail');

  const failed = await discoverGuidelinesInternalForTests.discoverGuidelines(
    { include: ['guides/a.MD'] },
    createContext(),
    createTestToolInvocationContext(),
    async () => {
      throw new Error('private path must not escape');
    },
  );
  assert(failed.isError, 'Unexpected internal failures should be tool errors');
  assertNotIncludes(
    getResultText(failed),
    'private path',
    'Internal exception detail should not leak',
  );
}

await runTestSuite({
  title: 'discover_guidelines Tool Tests',
  beforeAll: resetFixtures,
  afterAll: cleanupFixtures,
  tests: [
    { name: 'Definition and executor validation are strict', run: testDefinitionAndValidation },
    {
      name: 'Literal and glob discovery is sorted and body-private',
      run: testLiteralGlobSortingAndBodyPrivacy,
    },
    {
      name: 'Absolute additional roots and deduplication are preserved',
      run: testAbsoluteAdditionalRootAndDeduplication,
    },
    {
      name: 'Include order and first actual identity win',
      run: testIncludeOrderAndFirstIdentityWins,
    },
    {
      name: 'Exclude and ignore semantics match shared selection',
      run: testExcludeAndIgnoreSemantics,
    },
    {
      name: 'Deny and skipped results preserve privacy semantics',
      run: testDenyAndSkippedPrivacyNotes,
    },
    { name: 'Empty discovery states are successful and explicit', run: testEmptyDiscoveryStates },
    {
      name: 'Controlled inspection failures remain partial results',
      run: testControlledInspectionFailuresRemainPartialResults,
    },
    { name: 'Markdown candidate limit is deterministic', run: testFileLimit },
    { name: 'Tool worker limit preserves file order', run: testBoundedWorkersAndStableOrder },
    {
      name: 'Cancellation stops scheduling and drains inspections',
      run: testCancellationDrainsStartedInspections,
    },
    {
      name: 'Internal failure drains started inspections',
      run: testInternalFailureDrainsStartedInspections,
    },
    {
      name: 'Prefix reading stops after the closing delimiter',
      run: testPrefixReadingStopsAfterClosingDelimiter,
    },
    {
      name: 'Pre-cancellation and internal failures are errors',
      run: testPreCancelledAndUnexpectedInspectorFailure,
    },
  ],
});
