import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';
import { block, body, cleanupFixtures, FIXTURES_DIR, prepareFixtures, read } from './fixtures.js';

async function testInputOrderAndDeduplication(): Promise<void> {
  const absoluteB = path.join(FIXTURES_DIR, 'b.txt');
  const result = await read({ include: [absoluteB, '[abc].txt', 'a.txt', 'b.txt', 'c.txt'] });
  assert(result.isError === false, 'Mixed literals and glob should succeed');
  assertEqual(result.content.length, 4, 'Default requests are deduplicated across selectors');
  assertIncludes(
    block(result, 1),
    `include[0] ${absoluteB}`,
    'First occurrence keeps its absolute display and position',
  );
  assertEqual(body(result, 1), 'B-body', 'Input order is not replaced by a global path sort');
  assertIncludes(
    block(result, 2),
    `include[1] a.txt`,
    'Glob members are sorted within their input position',
  );
  assertEqual(body(result, 3), 'C-body', 'Later duplicate literals add no requests');
}

async function testObjectOverridesInBothDirections(): Promise<void> {
  const result = await read({
    include: [
      '[abc].txt',
      { file_path: 'c.txt', start_line: 1, end_line: 1 },
      { file_path: 'a.txt', start_line: 2, end_line: 2 },
      'a.txt',
      { file_path: 'a.txt', start_line: 2, end_line: 2 },
      { file_path: 'a.txt', start_line: 2, end_line: 3 },
      { file_path: 'b.txt' },
      'b.txt',
    ],
  });
  assert(result.isError === false, 'Object fragments should succeed');
  assertEqual(
    result.content.length,
    6,
    'Objects replace defaults on either side but never each other',
  );
  for (const [blockIndex, inputIndex, expected] of [
    [1, 1, 'C-body'],
    [2, 2, 'beta'],
    [3, 4, 'beta'],
    [4, 5, 'beta\ngamma'],
    [5, 6, 'B-body'],
  ] as const) {
    assertIncludes(
      block(result, blockIndex),
      `include[${inputIndex}]`,
      'Each object retains its declared position',
    );
    assertEqual(
      body(result, blockIndex),
      expected,
      'Repeated and overlapping fragments are kept independently',
    );
  }
}

async function testInvalidObjectStillOverrides(): Promise<void> {
  const result = await read({
    include: ['a.txt', { file_path: 'a.txt', start_line: 3, end_line: 1 }, 'a.txt', 'b.txt'],
  });
  assert(result.isError === false, 'Unrelated defaults remain readable');
  assertEqual(
    result.content.length,
    3,
    'A semantically invalid object still removes all whole-file defaults',
  );
  assertIncludes(block(result, 1), 'include[1]', 'The failure stays at the object position');
  assertIncludes(block(result, 1), 'failed', 'Range failure is reported');
  assertEqual(body(result, 2), 'B-body', 'Later files continue');
}

async function testLiteralObjectsAndFilters(): Promise<void> {
  const result = await read({
    include: [
      'nested/**/*.txt',
      'special/file[test].txt',
      { file_path: 'special/file{a,b}.txt' },
      'nested/z.txt',
      { file_path: 'nested/z.txt' },
    ],
    exclude: ['nested/**', 'special/**'],
  });
  assert(result.isError === false, 'Literal strings and objects bypass excludes');
  assertEqual(
    result.content.length,
    4,
    'Exclude applies to discovered results only, with object override applied afterwards',
  );
  assertEqual(body(result, 1), 'brackets-body', 'Existing bracket names are literal first');
  assertEqual(body(result, 2), 'braces-body', 'Objects can address literal glob metacharacters');
  assertEqual(body(result, 3), 'nested-body', 'Explicit objects bypass exclude');

  const objectGlob = await read({ include: [{ file_path: '[abc].txt' }, 'b.txt'] });
  assertEqual(objectGlob.content.length, 3, 'An object path is never expanded as a glob');
  assertIncludes(block(objectGlob, 1), 'failed', 'A nonexistent literal object is a local failure');
}

async function testSelectionFailuresAndEmptyResults(): Promise<void> {
  const result = await read({
    include: ['missing.txt', 'b.txt', '../outside/**/*.txt', 'missing.txt', 'c.txt'],
  });
  assert(result.isError === false, 'Selector failures do not abort the call');
  assertEqual(
    result.content.length,
    6,
    'Unresolved failures are not deduplicated by lexical spelling',
  );
  assertIncludes(block(result, 1), 'include[0]', 'First failure retains its position');
  assertEqual(body(result, 2), 'B-body', 'A valid file after a failure is returned');
  assertIncludes(block(result, 3), 'include[2]', 'An unsafe static base is independently reported');
  assertIncludes(block(result, 4), 'include[3]', 'Repeated unresolved failure remains independent');
  assertEqual(body(result, 5), 'C-body', 'Subsequent valid selectors continue');

  const noMatches = await read({ include: ['nothing/**/*.absent'] });
  assert(noMatches.isError === true, 'Zero matches is an error for read');
  assertEqual(noMatches.content.length, 1, 'Zero selected requests only produces the summary');
  assertIncludes(
    block(noMatches, 0),
    'Selected content: 0 lines, 0 bytes.',
    'Zero matches has zero successful content',
  );
  assertNotIncludes(
    block(noMatches, 0),
    'Files:',
    'No Files section is fabricated for empty selection',
  );
}

async function testLimitAfterOverridesAndDeduplication(): Promise<void> {
  const result = await read({
    include: [
      ...Array.from({ length: 150 }, () => 'a.txt'),
      ...Array.from({ length: 101 }, (_, index) => ({
        file_path: 'a.txt',
        start_line: index === 0 ? 99 : 2,
        end_line: index === 0 ? 99 : 2,
      })),
    ],
  });
  assert(result.isError === false, 'Limited mixed requests still return successful fragments');
  assertEqual(result.content.length, 101, 'Exactly the first 100 final requests are processed');
  assertIncludes(block(result, 1), 'include[150]', 'The failed first object consumes its slot');
  assertIncludes(
    block(result, 100),
    'include[249]',
    'The last retained request uses the original input index',
  );
  assertNotIncludes(
    block(result, 0),
    'include[250]',
    'A failed request is not replaced by the 101st request',
  );
  assertIncludes(
    block(result, 0),
    'Selected content: 99 lines, 396 bytes.',
    'Only processed successful fragments count',
  );
  assertIncludes(block(result, 0), '100', 'The summary discloses the processing limit');
  assertIncludes(
    block(result, 0),
    'requests',
    'Limit is stated in requests rather than source files',
  );
}

async function testSelectionFailuresConsumeLimit(): Promise<void> {
  const result = await read({
    include: [...Array.from({ length: 100 }, () => 'missing.txt'), 'b.txt'],
  });
  assert(result.isError === true, 'Failures use all slots without backfilling a later success');
  assertEqual(result.content.length, 101, 'Each selected failure consumes one request');
  assertNotIncludes(block(result, 0), 'b.txt', 'Unprocessed inputs have no per-file entry');
  assertIncludes(
    block(result, 100),
    'include[99]',
    'Failure positions are preserved through the limit',
  );
}

async function testGlobLimitAndSlashCompatibility(): Promise<void> {
  const dir = path.join(FIXTURES_DIR, 'limit');
  await fs.mkdir(dir);
  for (let index = 100; index >= 0; index--) {
    await fs.writeFile(path.join(dir, `${String(index).padStart(3, '0')}.txt`), String(index));
  }
  const result = await read({ include: ['limit/*.txt'], shallow_read: true });
  assert(result.isError === false, 'Large globs return a limited successful batch');
  assertIncludes(
    block(result, 0),
    path.join('limit', '000.txt'),
    'Glob ordering is display-path sorted before limiting',
  );
  assertIncludes(
    block(result, 0),
    path.join('limit', '099.txt'),
    'The 100th glob request is selected',
  );
  assertNotIncludes(
    block(result, 0),
    path.join('limit', '100.txt'),
    'The 101st glob request is not processed',
  );

  const slashGlob = await read({ include: ['/**/z.txt'] });
  assertEqual(
    body(slashGlob),
    'nested-body',
    'Slash-leading magic patterns remain primary-root globs',
  );
  const defaults = await read({ include: ['node_modules/*.txt'] });
  assertEqual(body(defaults), 'dependency-body', 'No built-in directory ignore is imposed');
}

await runTestSuite({
  title: 'Testing read selection, object overrides, and request limits',
  beforeAll: prepareFixtures,
  afterAll: cleanupFixtures,
  tests: [
    {
      name: 'input order, glob-local sorting, and first-occurrence deduplication',
      run: testInputOrderAndDeduplication,
    },
    {
      name: 'objects replace defaults before and after without merging fragments',
      run: testObjectOverridesInBothDirections,
    },
    {
      name: 'invalid object ranges do not restore default requests',
      run: testInvalidObjectStillOverrides,
    },
    {
      name: 'literal objects, magic filenames, and discovered-only filtering',
      run: testLiteralObjectsAndFilters,
    },
    {
      name: 'selection failures preserve order and empty selections remain empty',
      run: testSelectionFailuresAndEmptyResults,
    },
    {
      name: '100-request limit follows deduplication and overrides without backfilling',
      run: testLimitAfterOverridesAndDeduplication,
    },
    { name: 'selection failures consume request slots', run: testSelectionFailuresConsumeLimit },
    {
      name: 'glob limits, slash-leading globs, and no implicit ignores',
      run: testGlobLimitAndSlashCompatibility,
    },
  ],
});
