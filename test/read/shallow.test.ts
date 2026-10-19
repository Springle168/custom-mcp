import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';
import { block, body, cleanupFixtures, prepareFixtures, read } from './fixtures.js';

const fragments = [
  { file_path: 'crlf.txt', start_line: 1, end_line: 2 },
  { file_path: 'crlf.txt', start_line: 1, end_line: 2 },
  { file_path: 'crlf.txt', start_line: 2, end_line: 3, show_line_numbers: false },
];
const expectedBodies = ['1: 中文\n2: 😀', '1: 中文\n2: 😀', '😀\n'];
const totalBytes = expectedBodies.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);

async function testFullAndBooleanShallow(): Promise<void> {
  const full = await read({ include: fragments, show_line_numbers: true, shallow_read: false });
  assert(full.isError === false, 'Explicit full read succeeds');
  assertEqual(full.content.length, 4, 'Every successful fragment has a body');
  expectedBodies.forEach((expected, index) =>
    assertEqual(
      body(full, index + 1),
      expected,
      'Per-object false overrides global line numbering',
    ),
  );
  assertIncludes(
    block(full, 0),
    `Selected content: 6 lines, ${totalBytes} bytes.`,
    'Repeated fragments, UTF-8, LF, and line numbers all count',
  );
  assertNotIncludes(block(full, 0), 'Notes:', 'No policy notes appear without policy effects');

  const shallow = await read({ include: fragments, show_line_numbers: true, shallow_read: true });
  assert(shallow.isError === false, 'Omitting bodies does not change success');
  assertEqual(shallow.content.length, 1, 'Boolean shallow omits all successful bodies');
  assertIncludes(
    block(shallow, 0),
    `Selected content: 6 lines, ${totalBytes} bytes.`,
    'Shallow uses actual selected content size, not disk bytes or distinct files',
  );
  assertIncludes(block(shallow, 0), 'omitted', 'Summary explains omission');
  assertNotIncludes(block(shallow, 0), '中文', 'Summary does not contain selected text');
}

async function testThresholdBoundary(): Promise<void> {
  const atLimit = await read({
    include: fragments,
    show_line_numbers: true,
    shallow_read: totalBytes,
  });
  assertEqual(atLimit.content.length, 4, 'Threshold equality includes every successful body');
  expectedBodies.forEach((expected, index) =>
    assertEqual(
      body(atLimit, index + 1),
      expected,
      'Threshold returns the complete formatted fragments',
    ),
  );
  assertIncludes(
    block(atLimit, 0),
    `${totalBytes} bytes`,
    'Threshold is reported as integer bytes',
  );

  const overLimit = await read({
    include: fragments,
    show_line_numbers: true,
    shallow_read: totalBytes - 1,
  });
  assert(overLimit.isError === false, 'Exceeding the content budget is not an error');
  assertEqual(
    overLimit.content.length,
    1,
    'Budget is all-or-none rather than filled in input order',
  );
  assertIncludes(block(overLimit, 0), 'omitted', 'Summary reports successful body omission');
  assertIncludes(
    block(overLimit, 0),
    `${totalBytes - 1} bytes`,
    'Threshold is distinct from selected content bytes',
  );
}

async function testFailuresRemainInShallowOrder(): Promise<void> {
  for (const shallow_read of [true, 1, 1000]) {
    const result = await read({
      include: [
        'missing-first.txt',
        'b.txt',
        { file_path: 'a.txt', start_line: 99 },
        'c.txt',
        'missing-last.txt',
      ],
      shallow_read,
    });
    assert(result.isError === false, 'Partial success survives body omission');
    assertIncludes(
      block(result, 0),
      'Selected content: 2 lines, 12 bytes.',
      'Failures contribute no content statistics',
    );
    const retainedIndices = shallow_read === 1000 ? [0, 1, 2, 3, 4] : [0, 2, 4];
    assertEqual(
      result.content.length,
      retainedIndices.length + 1,
      'Shallow never hides failure blocks',
    );
    retainedIndices.forEach((inputIndex, index) =>
      assertIncludes(
        block(result, index + 1),
        `include[${inputIndex}]`,
        'Remaining blocks keep relative request order',
      ),
    );
    const summary = block(result, 0);
    assertIncludes(summary, 'include[0] missing-first.txt: failed.', 'Summary retains failures');
    assertNotIncludes(summary, 'missing-first.txt: lines', 'Failures do not fabricate line counts');
  }
}

async function testEmptySourceThreshold(): Promise<void> {
  const empty = await read({ include: ['empty.txt'], shallow_read: 1 });
  assert(empty.isError === false, 'Empty source success is retained');
  assertEqual(empty.content.length, 2, 'An empty successful body is within a positive threshold');
  assertEqual(body(empty), '', 'The empty body is complete');
  assertIncludes(
    block(empty, 0),
    'Selected content: 1 lines, 0 bytes.',
    'Empty files retain one line and zero body bytes',
  );

  const numbered = await read({ include: ['empty.txt'], show_line_numbers: true, shallow_read: 1 });
  assert(numbered.isError === false, 'Line-number formatting does not change success');
  assertEqual(numbered.content.length, 1, 'The line-number prefix alone can exceed the threshold');
  assertIncludes(
    block(numbered, 0),
    'Selected content: 1 lines, 3 bytes.',
    'Even empty-line numbering counts as returned content',
  );
}

await runTestSuite({
  title: 'Testing read shallow statistics and result blocks',
  beforeAll: prepareFixtures,
  afterAll: cleanupFixtures,
  tests: [
    {
      name: 'full/boolean shallow uses actual UTF-8 formatted fragment size',
      run: testFullAndBooleanShallow,
    },
    {
      name: 'numeric shallow includes at equality and otherwise omits the entire batch',
      run: testThresholdBoundary,
    },
    {
      name: 'shallow retains failure blocks and final request order',
      run: testFailuresRemainInShallowOrder,
    },
    {
      name: 'empty source statistics include line-number formatting',
      run: testEmptySourceThreshold,
    },
  ],
});
