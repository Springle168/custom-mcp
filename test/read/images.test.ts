import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { classifyFileContent } from '../../src/engine/file-content.js';
import { readInternalForTests } from '../../src/tools/built-in/files/read.js';
import { MAX_READ_REQUESTS } from '../../src/tools/built-in/files/read.limits.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import { createFileAccessPolicyContext } from '../../src/utils/file-access-policy.js';
import { readSourceFile } from '../../src/utils/file-read.js';
import { FILE_READ_CONCURRENCY } from '../../src/utils/file-read-policy.js';
import { supportedImages, unsupportedImage, animatedPng } from '../file-content/fixtures.js';
import { callBuiltInTool } from '../helpers/built-in-tool-call.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';
import {
  block,
  body,
  cleanupFixtures,
  context,
  FIXTURES_DIR,
  prepareFixtures,
  read,
} from './fixtures.js';

const imageNames = supportedImages.map((image) => `image-${image.format}.txt`);
const workerNames = Array.from(
  { length: FILE_READ_CONCURRENCY + 1 },
  (_, index) => `image-worker-${index}.png`,
);

async function setup(): Promise<void> {
  assert(
    workerNames.length <= MAX_READ_REQUESTS,
    'Image worker tests require within-limit sources beyond the first worker wave',
  );
  await prepareFixtures();
  for (const [index, image] of supportedImages.entries()) {
    await fs.writeFile(path.join(FIXTURES_DIR, imageNames[index]!), image.bytes);
  }
  await fs.writeFile(path.join(FIXTURES_DIR, 'text.png'), '<svg>plain text</svg>');
  await fs.writeFile(path.join(FIXTURES_DIR, 'unsupported.gif'), unsupportedImage);
  await fs.writeFile(path.join(FIXTURES_DIR, 'animated.png'), animatedPng);
  for (const name of workerNames) {
    await fs.writeFile(path.join(FIXTURES_DIR, name), supportedImages[0]!.bytes);
  }
  for (const name of ['visible.png', 'ignored.png', 'secret.png']) {
    await fs.mkdir(path.join(FIXTURES_DIR, 'policy'), { recursive: true });
    await fs.writeFile(path.join(FIXTURES_DIR, 'policy', name), supportedImages[0]!.bytes);
  }
}

function assertImage(
  result: ToolCallResult,
  offset: number,
  name: string,
  includeIndex: number,
  format = 'png',
  bytes = supportedImages[0]!.bytes,
): void {
  const mime = `image/${format}`;
  assertEqual(
    block(result, offset),
    `<image path="${path.normalize(name)}" include_index="${includeIndex}" mime_type="${mime}">`,
    'Opening tag identifies this exact image request',
  );
  const image = result.content[offset + 1];
  assert(image?.type === 'image', 'The next block is the associated image');
  assertEqual(image.mimeType, mime, 'MIME derives from classified bytes');
  assertEqual(
    image.data,
    bytes.toString('base64'),
    'Original complete bytes are returned without transcoding',
  );
  assertEqual(
    Buffer.compare(Buffer.from(image.data, 'base64'), bytes),
    0,
    'Base64 round-trips exact source bytes',
  );
  assertEqual(
    block(result, offset + 2),
    '</image>',
    'The image group ends before any later request',
  );
}

async function testFormatsAndContentClassification(): Promise<void> {
  const result = await read({
    include: [...imageNames, 'text.png', 'unsupported.gif', 'animated.png'],
  });
  assertEqual(result.isError, false, 'Image and SVG text successes survive unsupported siblings');
  assertEqual(
    result.content.length,
    13,
    'Supported images each have three blocks and other requests one',
  );
  supportedImages.forEach((image, index) => {
    assertImage(result, 1 + index * 3, imageNames[index]!, index, image.format, image.bytes);
  });
  assertEqual(
    body(result, 10),
    '<svg>plain text</svg>',
    'A .png suffix does not turn actual SVG text into an image',
  );
  assertIncludes(block(result, 11), 'non-text', 'GIF is not broadly admitted as image/*');
  assertIncludes(block(result, 12), 'non-text', 'APNG does not acquire plain PNG support');
  assertIncludes(
    block(result, 0),
    'Selected content: 1 lines, 21 bytes.',
    'Only actual text contributes statistics',
  );
}

async function testRangePrevalidationAndIgnoredLegalRanges(): Promise<void> {
  const invalid = [
    { start_line: 4, end_line: 2 },
    { start_line: '2' },
    { read_mode: 'regex', start_line: 2 },
    { read_mode: 'regex', start_line: '[' },
    { read_mode: 'regex', end_line: '[' },
  ];
  let reads = 0;
  const reader: Parameters<typeof readInternalForTests.read>[3] = (file, signal) => {
    reads++;
    return readSourceFile(file.readPath, signal);
  };
  const failed = await readInternalForTests.read(
    {
      include: [
        imageNames[0],
        ...invalid.map((options) => ({ file_path: imageNames[0], ...options })),
      ],
    },
    context(),
    createTestToolInvocationContext(),
    reader,
  );
  assertEqual(reads, 0, 'All invalid objects override the default and never read image content');
  assertEqual(failed.isError, true, 'Prevalidation failures remain failures for images');
  assertEqual(
    failed.content.length,
    invalid.length + 1,
    'Every explicit invalid object remains separate',
  );

  const result = await readInternalForTests.read(
    {
      include: [
        { file_path: imageNames[0], start_line: 4, end_line: 2 },
        { file_path: imageNames[0], start_line: 999999, end_line: 1000000 },
        {
          file_path: imageNames[0],
          read_mode: 'regex',
          start_line: '^never matches$',
          end_line: '^nor this$',
          show_line_numbers: false,
        },
      ],
      show_line_numbers: true,
    },
    context(),
    createTestToolInvocationContext(),
    reader,
  );
  assertEqual(
    reads,
    1,
    'Legal sibling objects share one source read despite a prevalidation failure',
  );
  assertEqual(
    result.content.length,
    8,
    'Invalid range fails locally and both legal ranges return whole images',
  );
  assertIncludes(
    block(result, 1),
    'failed',
    'Invalid range is not overwritten by the shared source success',
  );
  assertImage(result, 2, imageNames[0]!, 1);
  assertImage(result, 5, imageNames[0]!, 2);
  assertNotIncludes(
    block(result, 0),
    'warning',
    'Ignored legal text options do not produce warnings',
  );
}

async function testSchemaBeforeExecution(): Promise<void> {
  const invalidArgs = [
    { include: [{ file_path: imageNames[0], start_line: 0 }] },
    { include: [{ file_path: imageNames[0], read_mode: 'binary' }] },
    { include: [{ file_path: imageNames[0], unknown: true }] },
    { include: [imageNames[0]], show_line_numbers: 'yes' },
    { include: [imageNames[0]], shallow_read: 0 },
  ];
  const controller = new AbortController();
  controller.abort();
  for (const args of invalidArgs) {
    const result = await callBuiltInTool(
      'read',
      args,
      context(),
      createTestToolInvocationContext({ signal: controller.signal }),
    );
    assertEqual(result.isError, true, 'Schema restrictions also apply to image requests');
    assertEqual(result.content.length, 1, 'Invalid input never enters per-request rendering');
    assertIncludes(
      block(result, 0),
      'input schema',
      'Input validation takes precedence even over pre-admission cancellation',
    );
    assertNotIncludes(
      block(result, 0),
      'cancelled',
      'The executor cancellation boundary was not reached',
    );
  }
}

async function testAliasObjectsShareReadAndClassification(): Promise<void> {
  const alias = path.join(FIXTURES_DIR, 'image-alias');
  await fs.symlink(FIXTURES_DIR, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let reads = 0;
  let classifications = 0;
  try {
    const result = await readInternalForTests.read(
      {
        include: [
          imageNames[0],
          { file_path: `image-alias/${imageNames[0]}` },
          { file_path: imageNames[0] },
          { file_path: imageNames[0] },
        ],
      },
      context(),
      createTestToolInvocationContext(),
      (file, signal) => {
        reads++;
        return readSourceFile(file.readPath, signal, (bytes, detectedSignal) => {
          classifications++;
          return classifyFileContent(bytes, detectedSignal);
        });
      },
    );
    assertEqual(reads, 1, 'Realpath aliases share one source read');
    assertEqual(classifications, 1, 'Realpath aliases share one classification');
    assertEqual(
      result.content.length,
      10,
      'Objects override the default without deduplicating explicit repetitions',
    );
    assertImage(result, 1, `image-alias/${imageNames[0]}`, 1);
    assertImage(result, 4, imageNames[0]!, 2);
    assertImage(result, 7, imageNames[0]!, 3);
    assertNotIncludes(
      JSON.stringify(result.content),
      FIXTURES_DIR,
      'Image output does not reveal the internal absolute source path',
    );
  } finally {
    await fs.unlink(alias);
  }
}

async function testMixedOrderAndUnifiedShallow(): Promise<void> {
  const include = [imageNames[0], 'b.txt', imageNames[1], 'missing.png'];
  for (const shallow_read of [false, true, 5, 6, 7]) {
    const result = await read({ include, shallow_read });
    const returned = shallow_read !== true && shallow_read !== 5;
    assertEqual(result.isError, false, 'Omitted images and text still count as success');
    assertIncludes(
      block(result, 0),
      'Selected content: 1 lines, 6 bytes.',
      'Only successful text controls the batch threshold',
    );
    assertEqual(
      result.content.length,
      returned ? 9 : 2,
      'All text and image bodies share one shallow decision',
    );
    if (returned) {
      assertImage(result, 1, imageNames[0]!, 0);
      assertEqual(body(result, 4), 'B-body', 'Text stays between image groups in include order');
      assertImage(result, 5, imageNames[1]!, 2, 'jpeg', supportedImages[1]!.bytes);
    }
    assertIncludes(
      block(result, returned ? 8 : 1),
      'include[3] missing.png: failed',
      'Failure survives every shallow mode',
    );
  }
  const pure = await read({ include: [imageNames[0]], shallow_read: 1 });
  assertImage(pure, 1, imageNames[0]!, 0);
  const omitted = await read({ include: [imageNames[0]], shallow_read: true });
  assertEqual(omitted.isError, false, 'Pure image shallow is a success');
  assertEqual(omitted.content.length, 1, 'Pure image shallow returns no wrapper remnants');
}

async function testImageSuccessPolicyNotes(): Promise<void> {
  const base = context();
  const root = base.pathSafetyContext.primaryRoot;
  const guarded = {
    ...base,
    fileAccessPolicyContext: createFileAccessPolicyContext(base.pathSafetyContext, [
      {
        rootDir: root.rootDir,
        realRootDir: root.realRootDir ?? root.rootDir,
        ignore: { isIgnored: (candidate: string) => candidate === 'policy/ignored.png' },
        deny: { isIgnored: (candidate: string) => candidate === 'policy/secret.png' },
      },
    ]),
  };
  const result = await readInternalForTests.read(
    { include: ['policy/*.png'], shallow_read: true },
    guarded,
    createTestToolInvocationContext(),
  );
  assertEqual(result.isError, false, 'Summary-only image success enables discovery policy notes');
  assertEqual(result.content.length, 1, 'Filtered entries never become per-request failures');
  const summary = block(result, 0);
  assertIncludes(
    summary,
    `include[0] ${path.join('policy', 'visible.png')}`,
    'Only the visible image remains selected',
  );
  assertIncludes(
    summary,
    'Some glob-discovered paths were filtered by configured ignoreFiles rules.',
    'Image success enables the ignore note',
  );
  assertIncludes(
    summary,
    'Some paths were blocked by the file access deny policy.',
    'Image success enables the hidden deny note',
  );
  assertNotIncludes(summary, 'ignored.png', 'Ignore note does not disclose filtered paths');
  assertNotIncludes(summary, 'secret.png', 'Deny note does not disclose hidden paths');
}

async function testEncodingFailureIsWholeCallSafe(): Promise<void> {
  const bytes = Buffer.from(supportedImages[0]!.bytes);
  let encodings = 0;
  bytes.toString = () => {
    encodings++;
    throw new Error(`private-encoding-detail:${FIXTURES_DIR}`);
  };
  const result = await readInternalForTests.read(
    { include: ['b.txt', imageNames[0]] },
    context(),
    createTestToolInvocationContext(),
    async (file) =>
      path.basename(file.readPath) === 'b.txt'
        ? { ok: true, kind: 'text', lines: ['partial-text-body'] }
        : { ok: true, kind: 'image', format: 'png', bytes },
  );
  assertEqual(encodings, 1, 'The failure actually occurs during image encoding');
  assertEqual(result.isError, true, 'Encoding exceptions fail the entire call');
  assertEqual(result.content.length, 1, 'No summary, text, or partial image groups escape');
  assertIncludes(
    block(result, 0),
    'unexpected internal error',
    'The handler emits a controlled whole-call error',
  );
  for (const privateText of [
    'private-encoding-detail',
    FIXTURES_DIR,
    'partial-text-body',
    '<image',
    'Selected content:',
  ]) {
    assertNotIncludes(
      block(result, 0),
      privateText,
      'Partial results and internal details remain private',
    );
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function testImageCancellationDrainsWorkers(): Promise<void> {
  const startedWave = deferred();
  const release = deferred();
  const controller = new AbortController();
  let started = 0;
  let active = 0;
  let settled = false;
  let encodings = 0;
  const bytes = Buffer.from(supportedImages[0]!.bytes);
  bytes.toString = () => {
    encodings++;
    return 'unexpected';
  };
  const pending = readInternalForTests
    .read(
      { include: workerNames },
      context(),
      createTestToolInvocationContext({ signal: controller.signal }),
      async (_file, signal) => {
        assertEqual(
          signal,
          controller.signal,
          'Image readers receive the invocation cancellation signal',
        );
        active++;
        if (++started === FILE_READ_CONCURRENCY) startedWave.resolve();
        try {
          await release.promise;
          return { ok: true, kind: 'image', format: 'png', bytes };
        } finally {
          active--;
        }
      },
    )
    .then((result) => {
      settled = true;
      return result;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      startedWave.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for image workers')), 5000);
      }),
    ]);
    controller.abort();
    await nextTurn();
    assertEqual(started, FILE_READ_CONCURRENCY, 'Cancellation never starts queued image sources');
    assert(!settled, 'Cancellation waits for already-started image readers');
  } finally {
    clearTimeout(timer);
    controller.abort();
    release.resolve();
  }
  const result = await pending;
  assertEqual(active, 0, 'All active image readers drain before returning');
  assertEqual(
    started,
    FILE_READ_CONCURRENCY,
    'Remaining image sources stay unscheduled after drain',
  );
  assertEqual(encodings, 0, 'Cancelled images never reach encoding');
  assertEqual(result.isError, true, 'Image cancellation fails the entire call');
  assertEqual(result.content.length, 1, 'No partial image business result is returned');
  assertIncludes(block(result, 0), 'cancelled', 'The whole-call error explains cancellation');
}

await runTestSuite({
  title: 'Testing read image integration and lifecycle',
  beforeAll: setup,
  afterAll: cleanupFixtures,
  tests: [
    {
      name: 'PNG, JPEG, and WebP preserve exact bytes and classify independently of suffix',
      run: testFormatsAndContentClassification,
    },
    {
      name: 'range prevalidation precedes reading while legal text ranges do not affect images',
      run: testRangePrevalidationAndIgnoredLegalRanges,
    },
    {
      name: 'catalog schema rejects invalid image arguments before execution',
      run: testSchemaBeforeExecution,
    },
    {
      name: 'alias and repeated image objects share source reading and classification',
      run: testAliasObjectsShareReadAndClassification,
    },
    {
      name: 'mixed image and text order uses one shallow threshold decision',
      run: testMixedOrderAndUnifiedShallow,
    },
    {
      name: 'image-only shallow success retains private ignore and deny policy hints',
      run: testImageSuccessPolicyNotes,
    },
    {
      name: 'image encoding exceptions discard all partial output with a safe whole-call error',
      run: testEncodingFailureIsWholeCallSafe,
    },
    {
      name: 'image cancellation stops scheduling and drains workers before returning',
      run: testImageCancellationDrainsWorkers,
    },
  ],
});
