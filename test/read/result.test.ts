import { renderReadResult } from '../../src/tools/built-in/files/read-result.js';
import { MAX_READ_REQUESTS } from '../../src/tools/built-in/files/read.limits.js';
import type { SourceFileResult } from '../../src/utils/file-read.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';
import { block, body } from './fixtures.js';

type ReadResult = Parameters<typeof renderReadResult>[0][number];
type SourceImage = Extract<SourceFileResult, { kind: 'image' }>;

function image(bytes = Buffer.from([0, 255, 1])): SourceImage {
  return { ok: true, kind: 'image', format: 'png', bytes };
}

function imageRequest(source: SourceImage, displayPath: string, includeIndex: number): ReadResult {
  return { ok: true, kind: 'image', image: source, displayPath, includeIndex };
}

function textRequest(content: string, includeIndex = 0): ReadResult {
  return {
    ok: true,
    kind: 'text',
    displayPath: 'text.txt',
    includeIndex,
    selected: {
      content,
      startLine: 2,
      endLine: 2,
      totalLines: 4,
      lineCount: 1,
      bytes: Buffer.byteLength(content, 'utf8'),
    },
  };
}

function failure(includeIndex = 3): ReadResult {
  return {
    ok: false,
    includeIndex,
    displayPath: 'missing.png',
    reason: 'controlled failure',
    denied: false,
  };
}

function testMixedBlocksAndEscaping(): void {
  const source = image();
  const unsafePath = 'alias/&"<>\r\n\t.png';
  const results = [
    textRequest('2: 中文'),
    imageRequest(source, unsafePath, 7),
    failure(8),
    imageRequest(source, 'second.png', 9),
  ];
  const result = renderReadResult(results, false, false, false, false);
  assertEqual(result.isError, false, 'Text and image success keep mixed results successful');
  assertEqual(
    result.content.length,
    9,
    'Summary, text, two image groups, and failure stay distinct',
  );
  assertEqual(body(result, 1), '2: 中文', 'Existing text body framing is unchanged');
  assertEqual(
    block(result, 2),
    '<image path="alias/&amp;&quot;&lt;&gt;&#13;&#10;&#9;.png" include_index="7" mime_type="image/png">',
    'All XML attribute delimiters and control whitespace are escaped on one line',
  );
  for (const index of [3, 7]) {
    const item = result.content[index];
    assert(item?.type === 'image', 'The middle block in each group is an image');
    assertEqual(item.mimeType, 'image/png', 'Image MIME agrees with its opening tag');
    assertEqual(item.data, source.bytes.toString('base64'), 'Image data is bare base64');
    assertEqual(block(result, index + 1), '</image>', 'Every image group has its own close tag');
  }
  assertIncludes(block(result, 5), 'include[8] missing.png: failed', 'Failures retain mixed order');
  assertEqual(
    block(result, 6),
    '<image path="second.png" include_index="9" mime_type="image/png">',
    'Repeated images retain their own request association',
  );
  assert(
    result.content[3] !== result.content[7],
    'Repeated requests get independent output blocks',
  );
  const summary = block(result, 0);
  assertIncludes(summary, 'Selected content: 1 lines, 9 bytes.', 'Only formatted text contributes');
  assertIncludes(
    summary,
    'Image content is not included in line or byte statistics.',
    'Image statistics are explicit',
  );
  assertIncludes(
    summary,
    '- include[9] second.png\n',
    'Image summary has only request index and path',
  );
  assertNotIncludes(summary, 'second.png: lines', 'Images do not fabricate text line counts');
  assertNotIncludes(summary, 'image/png', 'Image summary does not expose MIME or metadata');
}

function testUnifiedShallowAndFailures(): void {
  const source = image();
  const results = [imageRequest(source, 'first.png', 0), textRequest('中文', 1), failure()];
  for (const shallow of [false, true, 5, 6, 7]) {
    const result = renderReadResult(results, shallow, false, false, false);
    const returned = shallow !== true && shallow !== 5;
    assertEqual(result.isError, false, 'Omission does not turn success into failure');
    assertEqual(
      result.content.length,
      returned ? 6 : 2,
      'One text-byte decision controls all successful bodies',
    );
    assertIncludes(
      block(result, 0),
      'Selected content: 1 lines, 6 bytes.',
      'Image bytes do not affect the threshold',
    );
    assertIncludes(
      block(result, returned ? 5 : 1),
      'controlled failure',
      'Shallow always retains failures',
    );
    if (typeof shallow === 'number') {
      assertIncludes(block(result, 0), 'text', 'Numeric shallow explains its text-only comparison');
    }
    if (!returned) {
      assertNotIncludes(
        JSON.stringify(result.content),
        '<image',
        'Omitted image groups leave no empty tags',
      );
    }
  }

  const onlyImage = renderReadResult(
    [imageRequest(source, 'image.png', 0)],
    1,
    false,
    false,
    false,
  );
  assertEqual(onlyImage.content.length, 4, 'Pure images fit every positive text-byte threshold');
  assertIncludes(block(onlyImage, 0), '0 lines, 0 bytes.', 'Pure images have zero text statistics');
  const emptyText = renderReadResult(
    [textRequest(''), imageRequest(source, 'image.png', 1)],
    1,
    false,
    false,
    false,
  );
  assertEqual(emptyText.content.length, 5, 'An empty successful text body does not hide images');
  assertEqual(body(emptyText), '', 'Empty successful text is preserved');
}

function testLazyEncodingAndPerSourceReuse(): void {
  const bytes = Buffer.from([0, 255, 1]);
  const encode = bytes.toString.bind(bytes);
  let encodings = 0;
  bytes.toString = (encoding, start, end) => {
    assertEqual(encoding, 'base64', 'Image bytes are never decoded as UTF-8');
    encodings++;
    return encode(encoding, start, end);
  };
  const source = image(bytes);
  const results = [
    imageRequest(source, 'one.png', 0),
    imageRequest(source, 'two.png', 1),
    textRequest('text', 2),
  ];
  renderReadResult(results, true, false, false, false);
  renderReadResult(results, 3, false, false, false);
  assertEqual(encodings, 0, 'Omitted successful bodies do not encode images');

  const full = renderReadResult(results, 4, false, false, false);
  assertEqual(encodings, 1, 'Repeated requests encode one shared source image only once');
  assertEqual(full.content.length, 8, 'Encoding reuse never collapses explicit requests');
  renderReadResult(results, false, false, false, false);
  assertEqual(encodings, 2, 'The encoding cache does not survive a render call');

  const distinctSource = image(bytes);
  renderReadResult(
    [imageRequest(source, 'one.png', 0), imageRequest(distinctSource, 'two.png', 1)],
    false,
    false,
    false,
    false,
  );
  assertEqual(encodings, 4, 'Reuse is keyed by source image object, not byte Buffer identity');
}

function testSuccessAndPolicyNotes(): void {
  const result = renderReadResult(
    [imageRequest(image(), 'visible.png', 0)],
    true,
    true,
    true,
    true,
  );
  assertEqual(result.isError, false, 'Summary-only image success remains successful');
  assertEqual(result.content.length, 1, 'Boolean shallow omits the complete image group');
  const summary = block(result, 0);
  assertIncludes(
    summary,
    `Only the first ${MAX_READ_REQUESTS} final requests were processed.`,
    'Image-only results retain request-limit diagnostics',
  );
  assertIncludes(
    summary,
    'Some glob-discovered paths were filtered by configured ignoreFiles rules.',
    'Image success enables ignore notes',
  );
  assertIncludes(
    summary,
    'Some paths were blocked by the file access deny policy.',
    'Image success enables deny notes',
  );

  const failed = renderReadResult([failure()], true, false, true, true);
  assertEqual(failed.isError, true, 'All request failures remain errors');
  assertNotIncludes(
    block(failed, 0),
    'ignoreFiles',
    'No-success calls do not reveal ignored discovery',
  );
  assertNotIncludes(
    block(failed, 0),
    'deny policy',
    'Hidden deny alone does not reveal discovery without success',
  );
  const empty = renderReadResult([], false, false, false, false);
  assertEqual(empty.isError, true, 'Zero matches remain an error');
  assertEqual(empty.content.length, 1, 'Zero matches return summary only');
}

await runTestSuite({
  title: 'Testing pure read image and text result rendering',
  tests: [
    {
      name: 'mixed request order, three-block associations, and XML attribute escaping',
      run: testMixedBlocksAndEscaping,
    },
    {
      name: 'one text-byte shallow decision controls all bodies while retaining failures',
      run: testUnifiedShallowAndFailures,
    },
    {
      name: 'image encoding is lazy, source-shared, and scoped to one render',
      run: testLazyEncodingAndPerSourceReuse,
    },
    {
      name: 'image-only success enables policy notes even when bodies are omitted',
      run: testSuccessAndPolicyNotes,
    },
  ],
});
