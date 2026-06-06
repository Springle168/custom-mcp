import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  assertEqual,
  runTestSuite,
} from '../test-utils.js';
import {
  FIXTURES_DIR,
  assertErrorResult,
  assertFixtureContent,
  assertFixtureMissing,
  assertJsonDefaults,
  assertNoSpan,
  assertSuccessResult,
  callReplace,
  cleanupFixtures,
  createTestToolContext,
  fixturePath,
  makeFixtureDir,
  resetFixtures,
  writeFixture,
} from './helpers.js';

const OUTSIDE_ROOT_FILE = path.join(FIXTURES_DIR, '..', 'outside-root.txt');
const OUTSIDE_CREATE_FILE = path.join(FIXTURES_DIR, '..', 'created-outside.txt');

async function cleanupAll(): Promise<void> {
  await cleanupFixtures();
  await fs.rm(OUTSIDE_ROOT_FILE, { force: true });
  await fs.rm(OUTSIDE_CREATE_FILE, { force: true });
}

async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function assertBinaryFileUnchanged(
  absolutePath: string,
  expected: Uint8Array,
  message: string,
): Promise<void> {
  const actual = await fs.readFile(absolutePath);
  assertEqual(
    JSON.stringify([...actual]),
    JSON.stringify([...expected]),
    message,
  );
}

async function testRelativeRootPathSucceeds(): Promise<void> {
  await resetFixtures();
  await writeFixture('relative.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'relative.txt',
    target: 'alpha',
    replacement: 'beta',
  });

  const json = assertSuccessResult(result);
  assertEqual(json.file_path, 'relative.txt', 'Relative file_path should echo input');
  await assertFixtureContent(
    'relative.txt',
    'beta\n',
    'Relative path inside root should be writable',
  );
}

async function testAbsoluteRootPathSucceedsAndEchoesOriginal(): Promise<void> {
  await resetFixtures();
  const absolutePath = await writeFixture('absolute.txt', 'alpha\n');

  const result = await callReplace({
    file_path: absolutePath,
    target: 'alpha',
    replacement: 'beta',
  });

  const json = assertSuccessResult(result);
  assertEqual(json.file_path, absolutePath, 'Absolute file_path should echo original input');
  await assertFixtureContent(
    'absolute.txt',
    'beta\n',
    'Absolute path inside root should be writable',
  );
}

async function testRootOutsidePathRejectedWithoutModifying(): Promise<void> {
  await resetFixtures();
  await fs.writeFile(OUTSIDE_ROOT_FILE, 'outside\n', 'utf-8');

  const result = await callReplace(
    {
      file_path: OUTSIDE_ROOT_FILE,
      target: 'outside',
      replacement: 'modified',
    },
    createTestToolContext(),
  );

  const json = assertErrorResult(result);
  assertEqual(json.file_path, OUTSIDE_ROOT_FILE, 'Rejected path should echo original string');
  assertJsonDefaults(json);
  assertEqual(
    await fs.readFile(OUTSIDE_ROOT_FILE, 'utf-8'),
    'outside\n',
    'Root-outside file should not be modified',
  );
}

async function testParentTraversalCreateRejected(): Promise<void> {
  await resetFixtures();

  const result = await callReplace({
    file_path: path.join('..', 'created-outside.txt'),
    target: '',
    replacement: 'created\n',
    match_mode: 'default',
  });

  const json = assertErrorResult(result);
  assertNoSpan(json, 'Parent traversal create should be a preflight failure');
  assertEqual(
    await pathExists(OUTSIDE_CREATE_FILE),
    false,
    'Parent traversal create should not create files outside root',
  );
}

async function testDirectoryPathRejectedWithoutWriting(): Promise<void> {
  await resetFixtures();
  await makeFixtureDir('dir-target');

  const result = await callReplace({
    file_path: 'dir-target',
    target: 'alpha',
    replacement: 'beta',
  });

  const json = assertErrorResult(result);
  assertNoSpan(json, 'Directory path should not have matched span');
  const stat = await fs.stat(fixturePath('dir-target'));
  assertEqual(stat.isDirectory(), true, 'Directory target should remain a directory');
}

async function testKnownBinaryExtensionRejectedWithoutWriting(): Promise<void> {
  await resetFixtures();
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  const absolutePath = await writeFixture('image.png', bytes);

  const result = await callReplace({
    file_path: 'image.png',
    target: 'PNG',
    replacement: 'TEXT',
  });

  const json = assertErrorResult(result);
  assertNoSpan(json, 'Known binary extension should not have matched span');
  await assertBinaryFileUnchanged(
    absolutePath,
    bytes,
    'Known binary extension should remain byte-for-byte unchanged',
  );
}

async function testBinaryContentRejectedWithoutWriting(): Promise<void> {
  await resetFixtures();
  const bytes = Uint8Array.from([0x61, 0x00, 0x62, 0x00, 0x63]);
  const absolutePath = await writeFixture('binary-content.dat', bytes);

  const result = await callReplace({
    file_path: 'binary-content.dat',
    target: 'a',
    replacement: 'x',
  });

  const json = assertErrorResult(result);
  assertNoSpan(json, 'Binary content should not have matched span');
  await assertBinaryFileUnchanged(
    absolutePath,
    bytes,
    'Binary-detected content should remain unchanged',
  );
}

async function testOversizeFileRejectedWithoutWriting(): Promise<void> {
  await resetFixtures();
  const sizeLimitPlusOne = 20 * 1024 * 1024 + 1;
  const absolutePath = await writeFixture(
    'oversize.txt',
    Buffer.alloc(sizeLimitPlusOne, 0x61),
  );

  const result = await callReplace({
    file_path: 'oversize.txt',
    target: 'a',
    replacement: 'b',
  });

  const json = assertErrorResult(result);
  assertNoSpan(json, 'Oversize file should not have matched span');
  const stat = await fs.stat(absolutePath);
  assertEqual(stat.size, sizeLimitPlusOne, 'Oversize file size should remain unchanged');
}

async function testUnknownExtensionTextFileCanBeReplaced(): Promise<void> {
  await resetFixtures();
  await writeFixture('unknown.customext', 'alpha\n');

  const result = await callReplace({
    file_path: 'unknown.customext',
    target: 'alpha',
    replacement: 'beta',
  });

  assertSuccessResult(result);
  await assertFixtureContent(
    'unknown.customext',
    'beta\n',
    'Unknown extension with text content should be replaceable',
  );
}

async function testFailureScenariosReturnJsonAndDoNotCreateMissingFiles(): Promise<void> {
  await resetFixtures();

  const result = await callReplace({
    file_path: 'missing-output-safety.txt',
    target: 'alpha',
    replacement: 'beta',
  });

  const json = assertErrorResult(result);
  assertEqual(json.file_line_count.previous, 0, 'Missing file previous line count');
  assertEqual(json.file_line_count.current, 0, 'Missing file current line count');
  assertNoSpan(json, 'Missing file should not report matched span');
  await assertFixtureMissing(
    'missing-output-safety.txt',
    'Missing file failure should not create the file',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text v2 output and file safety tests',
    details: 'Covers JSON failure shape, root sandboxing, directory/binary/oversize safety, and path echoing.',
    afterAll: cleanupAll,
    tests: [
      { name: 'Relative root path succeeds', run: testRelativeRootPathSucceeds },
      {
        name: 'Absolute root path succeeds and echoes original',
        run: testAbsoluteRootPathSucceedsAndEchoesOriginal,
      },
      {
        name: 'Root-outside path rejected without modifying',
        run: testRootOutsidePathRejectedWithoutModifying,
      },
      { name: 'Parent traversal create rejected', run: testParentTraversalCreateRejected },
      { name: 'Directory path rejected without writing', run: testDirectoryPathRejectedWithoutWriting },
      {
        name: 'Known binary extension rejected without writing',
        run: testKnownBinaryExtensionRejectedWithoutWriting,
      },
      { name: 'Binary content rejected without writing', run: testBinaryContentRejectedWithoutWriting },
      { name: 'Oversize file rejected without writing', run: testOversizeFileRejectedWithoutWriting },
      { name: 'Unknown extension text file can be replaced', run: testUnknownExtensionTextFileCanBeReplaced },
      {
        name: 'Failure JSON does not create missing files',
        run: testFailureScenariosReturnJsonAndDoNotCreateMissingFiles,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
