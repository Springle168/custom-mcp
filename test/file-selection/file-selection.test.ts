import * as fs from 'node:fs/promises';
import mutableFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';
import {
  createFileAccessPolicyContext,
  resolveFileAccessPath,
  validateFileAccessReadTarget,
  type FileAccessPolicyQuery,
} from '../../src/utils/file-access-policy.js';
import {
  fileIdentityKey,
  selectReadableFiles,
  type ReadableFileSelectionRequest,
} from '../../src/utils/file-selection.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import { assert, assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/file-selection/', import.meta.url));

function query(patterns: readonly string[]): FileAccessPolicyQuery {
  const matcher = ignore({ ignorecase: process.platform === 'win32' });
  matcher.add([...patterns]);
  return { isIgnored: (candidate) => matcher.ignores(candidate) };
}

function request(
  selectors: ReadableFileSelectionRequest['pathSelectors'],
  options: {
    ignore?: readonly string[];
    deny?: readonly string[];
    exclude?: readonly string[];
  } = {},
): ReadableFileSelectionRequest {
  const base = createTestToolRuntimeContext({ rootDir: FIXTURES_DIR });
  return {
    pathSelectors: selectors,
    discoveryExcludePatterns: options.exclude ?? [],
    respectIgnoreFiles: true,
    fileAccessPolicyContext: createFileAccessPolicyContext(
      base.pathSafetyContext,
      base.pathSafetyContext.allowedRoots.map((root) => ({
        rootDir: root.rootDir,
        realRootDir: root.realRootDir ?? root.rootDir,
        ignore: query(options.ignore ?? []),
        deny: query(options.deny ?? []),
      })),
    ),
  };
}

async function setup(): Promise<void> {
  await fs.mkdir(path.join(FIXTURES_DIR, 'files'), { recursive: true });
  await fs.mkdir(path.join(FIXTURES_DIR, 'denied'), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(FIXTURES_DIR, 'files', 'a.md'), 'a'),
    fs.writeFile(path.join(FIXTURES_DIR, 'files', 'c.md'), 'c'),
    fs.writeFile(path.join(FIXTURES_DIR, 'files', 'literal[ab].md'), 'literal'),
    fs.writeFile(path.join(FIXTURES_DIR, 'denied', 'secret.md'), 'secret'),
  ]);
  // Directory junctions do not need Windows symlink privileges. The missing
  // target produces a glob-member read validation failure, not a selector error.
  await fs.symlink(
    path.join(FIXTURES_DIR, 'absent'),
    path.join(FIXTURES_DIR, 'files', 'b.md'),
    'junction',
  );
  await fs.symlink(path.join(FIXTURES_DIR, 'files'), path.join(FIXTURES_DIR, 'alias'), 'junction');
}

async function testProvenanceOrderAndDuplicates(): Promise<void> {
  const result = await selectReadableFiles(request(['files/c.md', 'files/{a,c}.md', 'files/c.md']));
  assertEqual(result.entries.length, 4, 'Selection retains every successful occurrence');
  assertEqual(
    result.entries.map((entry) => entry.includeIndex).join(','),
    '0,1,1,2',
    'Every entry retains its include index',
  );
  assertEqual(
    result.entries
      .map((entry) => (entry.ok ? path.basename(entry.file.displayPath) : 'failed'))
      .join(','),
    'c.md,a.md,c.md,c.md',
    'Only each glob is sorted; include order is preserved',
  );
  assert(
    result.entries.every((entry) => entry.ok),
    'Existing file selectors all resolve',
  );
}

async function testObjectsAreAlwaysLiteralAndFiltersAreDiscoveryOnly(): Promise<void> {
  const result = await selectReadableFiles(
    request(
      [
        'files/literal[ab].md',
        { file_path: 'files/{a,c}.md' },
        { file_path: 'files/a.md' },
        'files/c.md',
        'files/{a,c}.md',
      ],
      { ignore: ['files/a.md'], exclude: ['files/c.md'] },
    ),
  );
  assertEqual(result.entries.length, 4, 'The final glob is filtered, explicit paths are not');
  assert(
    result.entries[0]?.ok === true,
    'A real string file with glob characters wins literal probing',
  );
  const failure = result.entries[1];
  assert(failure?.ok === false, 'An object containing glob magic never expands');
  assertEqual(failure.path, 'files/{a,c}.md', 'A literal failure retains its explicit path');
  assertEqual(failure.denied, false, 'A missing literal is not deny');
  assert(
    result.entries[2]?.ok === true && result.entries[3]?.ok === true,
    'Explicit object and string paths bypass discovery filters',
  );
  assertEqual(result.ignoredByPolicy, true, 'Actual glob ignore filtering is reported');

  const explicitOnly = await selectReadableFiles(
    request([{ file_path: 'files/a.md' }], { ignore: ['files/a.md'] }),
  );
  assertEqual(
    explicitOnly.ignoredByPolicy,
    false,
    'Explicit paths do not query or report ignore matches',
  );
}

async function testLocalFailuresAndDenyIsolation(): Promise<void> {
  const result = await selectReadableFiles(
    request(
      [
        'denied/secret.md',
        'missing.md',
        'files/a.md',
        '../outside.md',
        'denied/*.md',
        'files/c.md',
      ],
      { deny: ['denied/**'] },
    ),
  );
  assertEqual(result.entries.length, 6, 'Selector-local failures do not stop later requests');
  assertEqual(result.blockedByDeny, false, 'Explicit deny is not an automatic-discovery flag');
  for (const index of [0, 4]) {
    const entry = result.entries[index];
    assert(
      entry?.ok === false && entry.denied,
      'Explicit literal and static-base deny are failures at their own position',
    );
  }
  assert(
    result.entries[2]?.ok === true && result.entries[5]?.ok === true,
    'Readable peers survive denied and unsafe selectors',
  );
  const unsafe = result.entries[3];
  assert(
    unsafe?.ok === false && !unsafe.denied,
    'Path safety failures retain a distinct non-deny result',
  );

  const automatic = await selectReadableFiles(request(['**/*.md'], { deny: ['denied/**'] }));
  assertEqual(
    automatic.blockedByDeny,
    true,
    'Automatically hidden deny is recorded only as a flag',
  );
  assert(
    !JSON.stringify(automatic.entries).includes('secret'),
    'Automatic denied paths never appear in entries',
  );
}

async function testGlobSuccessAndFailureShareDisplayOrder(): Promise<void> {
  const result = await selectReadableFiles(
    request(['files/*.md'], { ignore: ['files/b.md'], exclude: ['files/b.md'] }),
  );
  assertEqual(
    result.entries
      .map((entry) => path.basename(entry.ok ? entry.file.displayPath : entry.path))
      .join(','),
    'a.md,b.md,c.md,literal[ab].md',
    'Failed glob members merge with successes by display path',
  );
  const failure = result.entries[1];
  assert(failure?.ok === false, 'The dangling glob member is retained as a failure');
  assertEqual(failure.includeIndex, 0, 'Glob failures retain selector provenance');
  assertEqual(failure.denied, false, 'A failed realpath is not deny');
  assertIncludes(failure.reason, 'not found', 'The member failure reason is preserved');
  assertEqual(
    result.ignoredByPolicy,
    false,
    'Filtering never hides or queries failed member diagnostics',
  );
}

async function testGlobMemberBecomesDirectory(): Promise<void> {
  const originalRealpath = mutableFs.realpath;
  const filePath = path.join(FIXTURES_DIR, 'files', 'c.md');
  const directoryPath = path.join(FIXTURES_DIR, 'files');
  const replacement = mock.method(
    mutableFs,
    'realpath',
    async (input: Parameters<typeof fs.realpath>[0]) =>
      originalRealpath(String(input) === filePath ? directoryPath : input),
  );
  syncBuiltinESMExports();
  try {
    const result = await selectReadableFiles(request(['files/{a,c}.md']));
    assertEqual(
      result.entries.length,
      2,
      'A member that becomes a directory still occupies its position',
    );
    assert(result.entries[0]?.ok === true, 'Readable peers survive a file-kind race');
    const failure = result.entries[1];
    assert(failure?.ok === false, 'The raced directory becomes a local file-selection failure');
    assertEqual(
      failure.path,
      path.join('files', 'c.md'),
      'The raced member keeps its lexical display path',
    );
    assertEqual(failure.reason, 'not a file', 'The file-kind mismatch is explicit');
    assertEqual(failure.denied, false, 'A file-kind race is not deny');
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
}

async function testIdentityAndAliasDisplayPaths(): Promise<void> {
  const result = await selectReadableFiles(request(['alias/{a,c}.md', 'files/a.md']));
  assertEqual(result.entries.length, 3, 'Aliases and repeats are not deduplicated by selection');
  const first = result.entries[0];
  const repeated = result.entries[2];
  assert(first?.ok === true && repeated?.ok === true, 'Alias and direct files resolve safely');
  assertEqual(
    first.file.displayPath,
    path.join('alias', 'a.md'),
    'Alias display path remains lexical',
  );
  assertEqual(
    fileIdentityKey(first.file.readPath),
    fileIdentityKey(repeated.file.readPath),
    'Actual path identity is shared without losing display provenance',
  );
  assertEqual(
    fileIdentityKey('C:/Mixed/Case'),
    process.platform === 'win32' ? 'c:/mixed/case' : 'C:/Mixed/Case',
    'Identity keys respect host case semantics',
  );
}

async function testCancellationBoundaries(): Promise<void> {
  const controller = new AbortController();
  const reason = new Error('selection cancelled');
  controller.abort(reason);
  const result = await selectReadableFiles({
    ...request(['files/a.md']),
    signal: controller.signal,
  }).catch((error: unknown) => error);
  assertEqual(result, reason, 'Pre-cancelled selection propagates the abort reason');

  const midController = new AbortController();
  const baseRequest = request(['files/a.md', 'files/c.md']);
  let checked = 0;
  const policy = createFileAccessPolicyContext(
    baseRequest.fileAccessPolicyContext.pathSafetyContext,
    baseRequest.fileAccessPolicyContext.roots.map((root) => ({
      ...root,
      deny: {
        isIgnored: () => {
          checked += 1;
          midController.abort(reason);
          return false;
        },
      },
    })),
  );
  const midResult = await selectReadableFiles({
    ...baseRequest,
    fileAccessPolicyContext: policy,
    signal: midController.signal,
  }).catch((error: unknown) => error);
  assertEqual(midResult, reason, 'Cancellation during selection prevents a partial result');
  assert(checked > 0, 'The cancellation probe actually ran inside selection');
}

async function testLargeGlobRetainsCandidates(): Promise<void> {
  const selectionRequest = request(['files/c.md', 'files/*.md', 'files/a.md']);
  const policy = selectionRequest.fileAccessPolicyContext;
  const safePath = resolveFileAccessPath('files/a.md', policy);
  assert(safePath.ok, 'The controlled glob target passes lexical validation');
  const target = await validateFileAccessReadTarget(safePath.path, policy);
  assert(target.ok, 'The controlled glob target passes access validation');

  // Model a large expansion without creating hundreds of thousands of disk files.
  // Selection retains all occurrences; caller-specific limits apply afterwards.
  const candidateCount = 150_000;
  const result = await selectReadableFiles(selectionRequest, async (pattern, context) => {
    assertEqual(pattern, 'files/*.md', 'Only the glob selector invokes the expander');
    assertEqual(context, policy, 'The expander receives the original access policy');
    return {
      ok: true,
      expansion: {
        files: Array.from({ length: candidateCount }, () => target.target),
        skipped: [],
        blockedByDeny: false,
      },
    };
  });

  assertEqual(
    result.entries.length,
    candidateCount + 2,
    'Large glob results remain intact for the caller to deduplicate and limit',
  );
  assertEqual(result.entries[0]?.includeIndex, 0, 'The preceding literal retains its position');
  assert(
    result.entries.slice(1, -1).every((entry) => entry.ok && entry.includeIndex === 1),
    'All glob candidates retain their selector provenance',
  );
  assertEqual(
    result.entries.at(-1)?.includeIndex,
    2,
    'A large glob does not prevent subsequent selectors from being processed',
  );
}

await runTestSuite({
  title: 'Readable File Selection Tests',
  beforeAll: setup,
  afterAll: async () => {
    await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  },
  tests: [
    {
      name: 'Selector provenance, per-glob sorting and duplicates',
      run: testProvenanceOrderAndDuplicates,
    },
    {
      name: 'Objects are literal and explicit paths bypass discovery filters',
      run: testObjectsAreAlwaysLiteralAndFiltersAreDiscoveryOnly,
    },
    {
      name: 'Selector failures and explicit deny are isolated',
      run: testLocalFailuresAndDenyIsolation,
    },
    {
      name: 'Glob success and failure share display-path order',
      run: testGlobSuccessAndFailureShareDisplayOrder,
    },
    {
      name: 'A glob member that becomes a directory remains a local failure',
      run: testGlobMemberBecomesDirectory,
    },
    {
      name: 'Realpath identity does not discard alias display paths',
      run: testIdentityAndAliasDisplayPaths,
    },
    { name: 'Cancellation is observed at selection boundaries', run: testCancellationBoundaries },
    {
      name: 'Large glob expansions do not exceed the function argument limit',
      run: testLargeGlobRetainsCandidates,
    },
  ],
});
