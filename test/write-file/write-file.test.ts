// test/write-file/write-file.test.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import writeFileTool, {
  createWriteFileHandler,
} from '../../src/tools/built-in/files/write-file.js';
import { supportedImages, recognizedBinary, unsupportedImage } from '../file-content/fixtures.js';
import { createFileAccessPolicyContext } from '../../src/utils/file-access-policy.js';
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

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'write-file');

function createToolContext() {
  return createTestToolRuntimeContext({ rootDir: FIXTURES_DIR });
}

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.rm(path.join(__dirname, '..', 'fixtures', 'write-file-outside'), {
    recursive: true,
    force: true,
  });
}

async function removeLinkIfExists(linkPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(linkPath);
    if (stat.isSymbolicLink()) {
      await fs.unlink(linkPath);
      return;
    }
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return;
    throw error;
  }

  await fs.rm(linkPath, { recursive: true, force: true });
}

async function testCreateNestedFile() {
  const result = await writeFileTool.handler(
    { file_path: 'nested/example.txt', content: 'alpha\nbeta' },
    createToolContext(),
    createTestToolInvocationContext(),
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  const displayPath = path.join('nested', 'example.txt');
  assertIncludes(text, `Success: wrote ${displayPath}.`, 'Should report written path');
  assertIncludes(text, 'Total lines: 2.', 'Should report line count');

  const writtenPath = path.join(FIXTURES_DIR, 'nested', 'example.txt');
  const raw = await fs.readFile(writtenPath, 'utf-8');
  assertEqual(raw, 'alpha\nbeta', 'Should write the provided text exactly for new files');
}

async function testOverwriteExistingFilePreservesLineEnding() {
  const targetPath = path.join(FIXTURES_DIR, 'existing.txt');
  await fs.writeFile(targetPath, 'old1\r\nold2\r\n', 'utf-8');

  const result = await writeFileTool.handler(
    { file_path: 'existing.txt', content: 'new1\nnew2' },
    createToolContext(),
    createTestToolInvocationContext(),
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'Success: wrote existing.txt.', 'Should report written path');
  assertIncludes(text, 'Total lines: 2.', 'Should report line count');

  const raw = await fs.readFile(targetPath, 'utf-8');
  assertEqual(raw, 'new1\r\nnew2', 'Should preserve the original CRLF line endings');
}

async function testInputLineEndingsAndTrailingNewlines() {
  const cases = [
    { content: 'alpha\rbeta', normalized: 'alpha\nbeta' },
    { content: 'alpha\r\nbeta\ngamma\r', normalized: 'alpha\nbeta\ngamma\n' },
    { content: 'alpha', normalized: 'alpha' },
    { content: 'alpha\n', normalized: 'alpha\n' },
    { content: 'alpha\n\n', normalized: 'alpha\n\n' },
    { content: '', normalized: '' },
  ];

  for (const existing of [false, true]) {
    for (const [index, testCase] of cases.entries()) {
      const filePath = `line-endings-${existing}-${index}.txt`;
      const targetPath = path.join(FIXTURES_DIR, filePath);
      if (existing) {
        await fs.writeFile(targetPath, 'old\r\n', 'utf-8');
      }

      const result = await writeFileTool.handler(
        { file_path: filePath, content: testCase.content },
        createToolContext(),
        createTestToolInvocationContext(),
      );

      assert(result.isError !== true, 'Should write the provided content');
      const expected = existing ? testCase.normalized.replace(/\n/g, '\r\n') : testCase.normalized;
      const raw = await fs.readFile(targetPath, 'utf-8');
      assertEqual(raw, expected, 'Line ending style must not change the trailing newline count');
    }
  }
}

async function testRejectOutsideWorkspace() {
  const outsidePath = path.join(__dirname, 'write-file-outside.txt');
  const result = await writeFileTool.handler(
    { file_path: outsidePath, content: 'nope' },
    createToolContext(),
    createTestToolInvocationContext(),
  );

  assert(result.isError === true, 'Should fail');
  assertIncludes(
    getResultText(result),
    'configured workspace roots',
    'Should explain path rejection',
  );

  await fs.rm(outsidePath, { force: true });
}

async function testRejectBinaryTarget() {
  const contents = [
    ...supportedImages.map((image) => image.bytes),
    recognizedBinary,
    unsupportedImage,
    Buffer.from([0, 1, 2, 3]),
    Buffer.concat([Buffer.alloc(5000, 0x61), Buffer.from([0xff])]),
    Buffer.concat([Buffer.alloc(5000, 0x61), Buffer.from([0])]),
  ];
  for (const [index, bytes] of contents.entries()) {
    const file_path = `non-text-${index}.txt`;
    const target = path.join(FIXTURES_DIR, file_path);
    await fs.writeFile(target, bytes);
    const result = await writeFileTool.handler(
      { file_path, content: 'nope' },
      createToolContext(),
      createTestToolInvocationContext(),
    );

    assert(result.isError === true, 'Existing non-text content must fail regardless of suffix');
    assertIncludes(getResultText(result), 'non-text', 'Should explain content rejection');
    assertEqual((await fs.readFile(target)).equals(bytes), true, 'Rejected bytes remain unchanged');
  }
}

async function testArbitrarySuffixAndUnrestrictedOutput() {
  for (const suffix of ['png', 'bin']) {
    const file_path = `new/deep/file.${suffix}`;
    const target = path.join(FIXTURES_DIR, file_path);
    const create = await writeFileTool.handler(
      { file_path, content: '\uFEFFold\r\ntext' },
      createToolContext(),
      createTestToolInvocationContext(),
    );
    assertEqual(create.isError, false, 'Missing files may be created at any suffix');
    await fs.writeFile(target, '\uFEFFold\r\ntext');
    const overwrite = await writeFileTool.handler(
      { file_path, content: '\uFEFFnew\ntext' },
      createToolContext(),
      createTestToolInvocationContext(),
    );
    assertEqual(overwrite.isError, false, 'Actual text at a binary suffix may be overwritten');
    assertEqual(
      await fs.readFile(target, 'utf8'),
      '\uFEFFnew\r\ntext',
      'Validated bytes retain BOM and line endings',
    );
  }

  for (const existing of [false, true]) {
    const file_path = `nul-output-${existing}.png`;
    const target = path.join(FIXTURES_DIR, file_path);
    if (existing) await fs.writeFile(target, 'old');
    const first = await writeFileTool.handler(
      { file_path, content: 'new\0content' },
      createToolContext(),
      createTestToolInvocationContext(),
    );
    assertEqual(first.isError, false, 'New and overwritten output strings are not classified');
    const second = await writeFileTool.handler(
      { file_path, content: 'repair' },
      createToolContext(),
      createTestToolInvocationContext(),
    );
    assertEqual(second.isError, true, 'A later call reclassifies the non-text target');
    assertEqual(
      await fs.readFile(target, 'utf8'),
      'new\0content',
      'Later rejection preserves successful output',
    );
  }
}

async function testDetectorErrorsAndMissingTargets() {
  const target = path.join(FIXTURES_DIR, 'detector.txt');
  await fs.writeFile(target, 'original');
  let calls = 0;
  const handler = createWriteFileHandler(async () => {
    calls++;
    throw Object.assign(new Error('private-detector-realpath'), { code: 'ENOENT' });
  });
  const failed = await handler(
    { file_path: 'detector.txt', content: 'overwrite' },
    createToolContext(),
    createTestToolInvocationContext(),
  );
  assertEqual(failed.isError, true, 'Detector ENOENT cannot authorize creation or overwrite');
  assertIncludes(getResultText(failed), 'Could not classify', 'Detector failure stays distinct');
  assertNotIncludes(
    getResultText(failed),
    'private-detector',
    'Raw detector details are not exposed',
  );
  assertEqual(
    await fs.readFile(target, 'utf8'),
    'original',
    'Detector failure leaves original bytes intact',
  );
  const created = await handler(
    { file_path: 'missing-detector.png', content: 'created' },
    createToolContext(),
    createTestToolInvocationContext(),
  );
  assertEqual(created.isError, false, 'Confirmed missing targets do not require classification');
  assertEqual(calls, 1, 'Classifier is never called on a missing target');
}

async function testNoExtraSizeLimit() {
  const target = path.join(FIXTURES_DIR, 'over-20MiB.bin');
  await fs.writeFile(target, 'a'.repeat(20 * 1024 * 1024 + 1));
  const result = await writeFileTool.handler(
    { file_path: 'over-20MiB.bin', content: 'small' },
    createToolContext(),
    createTestToolInvocationContext(),
  );
  assertEqual(result.isError, false, 'write_file has no read/replace 20MiB admission limit');
  assertEqual(await fs.readFile(target, 'utf8'), 'small', 'Large text can be overwritten');
}

async function testSafetyBeforeClassification() {
  const base = createToolContext();
  const root = base.pathSafetyContext.primaryRoot;
  const guarded = {
    ...base,
    fileAccessPolicyContext: createFileAccessPolicyContext(base.pathSafetyContext, [
      {
        rootDir: root.rootDir,
        realRootDir: root.realRootDir ?? root.rootDir,
        ignore: { isIgnored: () => false },
        deny: { isIgnored: (candidate: string) => candidate === 'denied.txt' },
      },
    ]),
  };
  await fs.writeFile(path.join(FIXTURES_DIR, 'denied.txt'), 'denied');
  const link = path.join(FIXTURES_DIR, 'unsafe-content-link');
  await fs.symlink(
    path.dirname(FIXTURES_DIR),
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  let calls = 0;
  const handler = createWriteFileHandler(async () => {
    calls++;
    return { kind: 'text' };
  });
  try {
    for (const file_path of ['denied.txt', '../outside.txt', 'unsafe-content-link/outside.txt']) {
      const result = await handler(
        { file_path, content: 'never' },
        guarded,
        createTestToolInvocationContext(),
      );
      assertEqual(result.isError, true, 'Unsafe targets fail before classification');
    }
    assertEqual(calls, 0, 'Denied and escaped targets never reach classification');
  } finally {
    await fs.unlink(link);
  }
}

async function testRejectSymlinkEscapingWorkspace() {
  const outsideDir = path.join(__dirname, '..', 'fixtures', 'write-file-outside');
  const linkPath = path.join(FIXTURES_DIR, 'escape-link');
  await fs.mkdir(outsideDir, { recursive: true });

  try {
    try {
      await fs.symlink(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      console.log(`  - Skipped symlink assertion: ${error.message}\n`);
      return;
    }

    const result = await writeFileTool.handler(
      { file_path: path.join('escape-link', 'escaped.txt'), content: 'nope' },
      createToolContext(),
      createTestToolInvocationContext(),
    );

    assert(result.isError === true, 'Should fail');
    assertIncludes(
      getResultText(result),
      'matched workspace root',
      'Should reject symlink path escapes',
    );

    try {
      await fs.stat(path.join(outsideDir, 'escaped.txt'));
      assert(false, 'Should not write through the symlink');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') throw error;
    }
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing write_file tool',
    details: `Fixtures directory: ${FIXTURES_DIR}`,
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'Create nested file', run: testCreateNestedFile },
      {
        name: 'Overwrite existing file and keep CRLF',
        run: testOverwriteExistingFilePreservesLineEnding,
      },
      {
        name: 'Normalize input line endings and honor trailing newline count',
        run: testInputLineEndingsAndTrailingNewlines,
      },
      { name: 'Reject path outside workspace', run: testRejectOutsideWorkspace },
      { name: 'Reject binary target', run: testRejectBinaryTarget },
      {
        name: 'Arbitrary suffixes and unrestricted output',
        run: testArbitrarySuffixAndUnrestrictedOutput,
      },
      {
        name: 'Detector errors cannot imply missing targets',
        run: testDetectorErrorsAndMissingTargets,
      },
      { name: 'No extra 20MiB limit for write_file', run: testNoExtraSizeLimit },
      { name: 'Safety checks precede content classification', run: testSafetyBeforeClassification },
      { name: 'Reject symlink escaping workspace', run: testRejectSymlinkEscapingWorkspace },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
