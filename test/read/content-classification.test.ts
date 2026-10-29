import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { classifyFileContent } from '../../src/engine/file-content.js';
import { readInternalForTests } from '../../src/tools/built-in/files/read.js';
import { readSourceFile } from '../../src/utils/file-read.js';
import { createFileAccessPolicyContext } from '../../src/utils/file-access-policy.js';
import { supportedImages, recognizedBinary, unsupportedImage } from '../file-content/fixtures.js';
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

async function testContentRatherThanSuffix(): Promise<void> {
  const text = '\uFEFF中文 😀\r\nsecond\r\n';
  for (const suffix of ['png', 'bin', 'ts', 'mts', 'cts', '']) {
    const name = suffix ? `text.${suffix}` : 'extensionless';
    await fs.writeFile(path.join(FIXTURES_DIR, name), text);
    const result = await read({ include: [name] });
    assertEqual(result.isError, false, `Actual UTF-8 text is accepted at ${name}`);
    assertEqual(body(result), text.replace(/\r\n/g, '\n'), 'BOM and text are preserved');
  }

  const invalidContents = [
    Buffer.from([0xc3, 0x28]),
    Buffer.concat([Buffer.alloc(5000, 0x61), Buffer.from([0xff])]),
    Buffer.concat([Buffer.alloc(5000, 0x61), Buffer.from([0])]),
    Buffer.from([1, 1, 1, 1, 0x61, 0x61, 0x61, 0x61, 0x61, 0x61]),
  ];
  for (const [index, bytes] of invalidContents.entries()) {
    const name = `invalid-${index}.ts`;
    await fs.writeFile(path.join(FIXTURES_DIR, name), bytes);
    const result = await read({ include: [name] });
    assertEqual(result.isError, true, 'Text suffixes never bypass complete byte validation');
    assertIncludes(block(result, 1), 'non-text', 'Rejected content has no successful body');
    assertIncludes(block(result, 0), '0 lines, 0 bytes', 'Rejected content has no statistics');
  }
}

async function testImagesAndMixedShallow(): Promise<void> {
  const names: string[] = [];
  for (const image of supportedImages) {
    const name = `image-${image.format}.txt`;
    names.push(name);
    await fs.writeFile(path.join(FIXTURES_DIR, name), image.bytes);
  }
  await fs.writeFile(path.join(FIXTURES_DIR, 'recognized.txt'), recognizedBinary);
  await fs.writeFile(path.join(FIXTURES_DIR, 'unsupported.txt'), unsupportedImage);
  for (const shallow_read of [false, true, 1]) {
    const result = await read({
      include: ['b.txt', ...names, 'recognized.txt', 'unsupported.txt'],
      shallow_read,
    });
    assertEqual(result.isError, false, 'A valid sibling keeps mixed content successful');
    assertIncludes(
      block(result, 0),
      'Selected content: 1 lines, 6 bytes.',
      'Only actual text contributes to shallow statistics',
    );
    assertIncludes(
      block(result, 0),
      'Image content is not included in line or byte statistics.',
      'Image successes explain their exclusion from text statistics',
    );
    const includeBodies = shallow_read === false;
    if (includeBodies) {
      for (const [index, image] of supportedImages.entries()) {
        const offset = 2 + index * 3;
        assertIncludes(block(result, offset), names[index]!, 'Image wrapper identifies the source');
        const content = result.content[offset + 1];
        assert(content?.type === 'image', 'Supported images succeed without text decoding');
        assertEqual(content.mimeType, `image/${image.format}`, 'MIME comes from classified bytes');
        assertEqual(content.data, image.bytes.toString('base64'), 'Original bytes are returned');
        assertEqual(block(result, offset + 2), '</image>', 'Each image wrapper is closed');
      }
    }
    const failureOffset = includeBodies ? 2 + names.length * 3 : 1;
    assertIncludes(
      block(result, failureOffset),
      'recognized binary',
      'Known non-text formats fail distinctly',
    );
    assertIncludes(
      block(result, failureOffset + 1),
      'recognized binary',
      'Other image formats are not supported',
    );
    assertEqual(
      result.content.length,
      failureOffset + 2,
      'Shallow omits all successful text and image bodies together',
    );
  }
}

async function testSourceClassificationReuseAndErrors(): Promise<void> {
  let calls = 0;
  const invocation = createTestToolInvocationContext();
  const result = await readInternalForTests.read(
    {
      include: [
        { file_path: 'a.txt', start_line: 1 },
        { file_path: 'a.txt', start_line: 2 },
      ],
    },
    context(),
    invocation,
    (file, signal) =>
      readSourceFile(file.readPath, signal, async (bytes, detectedSignal) => {
        calls++;
        assertEqual(
          detectedSignal,
          invocation.signal,
          'The detector receives invocation cancellation',
        );
        return classifyFileContent(bytes, detectedSignal);
      }),
  );
  assertEqual(result.isError, false, 'Fragments reuse classified source text');
  assertEqual(calls, 1, 'A source is classified once, not once per fragment');

  const failed = await readInternalForTests.read(
    { include: ['a.txt', 'b.txt'] },
    context(),
    invocation,
    (file, signal) =>
      readSourceFile(file.readPath, signal, async () => {
        if (path.basename(file.readPath) === 'a.txt') {
          throw Object.assign(new Error('private-realpath-detector-detail'), { code: 'ENOENT' });
        }
        return { kind: 'text' };
      }),
  );
  assertEqual(failed.isError, false, 'Classification errors isolate the source');
  assertIncludes(
    block(failed, 1),
    'could not be classified',
    'Detector ENOENT is not filesystem absence',
  );
  assertNotIncludes(block(failed, 1), 'private-realpath', 'Detector details stay private');
  assertNotIncludes(block(failed, 1), 'file not found', 'Detector errors are not missing files');
  assertEqual(body(failed, 2), 'B-body', 'Other sources survive detector failure');
}

async function testCancellationDuringClassification(): Promise<void> {
  const controller = new AbortController();
  const result = await readInternalForTests.read(
    { include: ['a.txt'] },
    context(),
    createTestToolInvocationContext({ signal: controller.signal }),
    (file, signal) =>
      readSourceFile(file.readPath, signal, async (_bytes, detectorSignal) => {
        assertEqual(detectorSignal, controller.signal, 'Signal reaches detector');
        controller.abort();
        detectorSignal!.throwIfAborted();
        return { kind: 'text' };
      }),
  );
  assertEqual(result.isError, true, 'Detector cancellation fails the whole read');
  assertEqual(result.content.length, 1, 'No partial business content is returned');
  assertIncludes(
    block(result, 0),
    'cancelled',
    'Cancellation is not a local classification failure',
  );
}

async function testSafetyBeforeContent(): Promise<void> {
  const base = context();
  const root = base.pathSafetyContext.primaryRoot;
  const guarded = {
    ...base,
    fileAccessPolicyContext: createFileAccessPolicyContext(base.pathSafetyContext, [
      {
        rootDir: root.rootDir,
        realRootDir: root.realRootDir ?? root.rootDir,
        ignore: { isIgnored: () => false },
        deny: { isIgnored: (candidate: string) => candidate === 'a.txt' },
      },
    ]),
  };
  const link = path.join(FIXTURES_DIR, 'escape-content');
  await fs.symlink(
    path.dirname(FIXTURES_DIR),
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  let calls = 0;
  try {
    const result = await readInternalForTests.read(
      { include: ['a.txt', '../outside.txt', 'escape-content/outside.txt'] },
      guarded,
      createTestToolInvocationContext(),
      async () => {
        calls++;
        return { ok: true, kind: 'text', lines: ['never'] };
      },
    );
    assert(result.isError === true, 'Unsafe selections fail');
    assertEqual(calls, 0, 'Deny and lexical/realpath escapes are rejected before content access');
  } finally {
    await fs.unlink(link);
  }
}

await runTestSuite({
  title: 'Testing read content classification boundary',
  beforeAll: prepareFixtures,
  afterAll: cleanupFixtures,
  tests: [
    {
      name: 'complete bytes, not suffixes, determine text admission',
      run: testContentRatherThanSuffix,
    },
    {
      name: 'images succeed and shallow statistics count only text',
      run: testImagesAndMixedShallow,
    },
    {
      name: 'classification is shared per source and detector failures are private',
      run: testSourceClassificationReuseAndErrors,
    },
    {
      name: 'classification cancellation retains whole-call semantics',
      run: testCancellationDuringClassification,
    },
    { name: 'unsafe paths never reach content access', run: testSafetyBeforeContent },
  ],
});
