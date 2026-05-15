import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';
import {
  assertErrorResult,
  assertFixtureContent,
  assertJsonNoteIncludes,
  assertNoSpan,
  assertSuccessResult,
  callReplace,
  cleanupFixtures,
  createTestConfig,
  fixturePath,
  FIXTURES_DIR,
  makeFixtureDir,
  resetFixtures,
  writeFixture,
} from './helpers.js';

async function testAbsolutePathInsideRootEchoesOriginalPath(): Promise<void> {
  await resetFixtures();
  const absolutePath = await writeFixture('absolute.txt', 'alpha\n');

  const result = await callReplace({
    file_path: absolutePath,
    target: 'alpha',
    replacement: 'beta',
  });

  const json = assertSuccessResult(result);
  assertEqual(json.file_path, absolutePath, 'Absolute file_path should be echoed unchanged');
  await assertFixtureContent('absolute.txt', 'beta\n', 'Absolute path inside root should be writable');
}

async function testOutsideRootPathRejected(): Promise<void> {
  await resetFixtures();
  const outsidePath = path.join(path.dirname(FIXTURES_DIR), 'outside-root.txt');
  await fs.rm(outsidePath, { force: true });

  const result = await callReplace({
    file_path: outsidePath,
    target: '',
    replacement: 'nope',
  });

  const json = assertErrorResult(result);
  assertNoSpan(json, 'Outside root path should be preflight failure');
  assertJsonNoteIncludes(json, 'outside', 'Outside root note should explain path rejection');

  try {
    await fs.stat(outsidePath);
    assert(false, 'Outside root path should not be created');
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') throw error;
  }
}

async function testDirectoryPathRejected(): Promise<void> {
  await resetFixtures();
  await makeFixtureDir('as-directory');

  const result = await callReplace({
    file_path: 'as-directory',
    target: 'alpha',
    replacement: 'beta',
  });

  const json = assertErrorResult(result);
  assertNoSpan(json, 'Directory path should have no span');
  assertJsonNoteIncludes(json, 'directory', 'Directory path note should explain the issue');
}

async function testKnownBinaryExtensionRejected(): Promise<void> {
  await resetFixtures();
  const binaryContent = Buffer.from([0, 1, 2, 3, 4]);
  await writeFixture('image.png', binaryContent);

  const result = await callReplace({
    file_path: 'image.png',
    target: 'alpha',
    replacement: 'beta',
  });

  const json = assertErrorResult(result);
  assertNoSpan(json, 'Known binary path should have no span');
  assertJsonNoteIncludes(json, 'binary', 'Known binary note should explain rejection');
  const raw = await fs.readFile(fixturePath('image.png'));
  assertEqual(Buffer.compare(raw, binaryContent), 0, 'Binary file should remain unchanged');
}

async function testContentDetectedBinaryRejected(): Promise<void> {
  await resetFixtures();
  const binaryContent = Buffer.from([97, 0, 98, 1, 2, 3]);
  await writeFixture('binary.unknown', binaryContent);

  const result = await callReplace({
    file_path: 'binary.unknown',
    target: 'a',
    replacement: 'b',
  });

  const json = assertErrorResult(result);
  assertJsonNoteIncludes(json, 'binary', 'Content-detected binary note should explain rejection');
  const raw = await fs.readFile(fixturePath('binary.unknown'));
  assertEqual(Buffer.compare(raw, binaryContent), 0, 'Content-detected binary should remain unchanged');
}

async function testOversizedFileRejectedBeforeWrite(): Promise<void> {
  await resetFixtures();
  await writeFixture('large.txt', Buffer.alloc(21 * 1024 * 1024, 'a'));

  const result = await callReplace({
    file_path: 'large.txt',
    target: 'a',
    replacement: 'b',
    allow_multiple: true,
  });

  const json = assertErrorResult(result);
  assertNoSpan(json, 'Oversized file should not be scanned');
  assertJsonNoteIncludes(json, '20MB', 'Oversized file note should mention size limit');
}

async function testAutoLineEndingPreservesExistingCrlf(): Promise<void> {
  await resetFixtures();
  await writeFixture('auto-crlf.txt', 'alpha\r\nbeta\r\n');

  const result = await callReplace({
    file_path: 'auto-crlf.txt',
    target: 'alpha',
    replacement: 'ALPHA',
  });

  const json = assertSuccessResult(result);
  assertEqual(json.file_line_count.previous, 3, 'CRLF previous line count should use LF-normalized content');
  const raw = await fs.readFile(fixturePath('auto-crlf.txt'), 'utf-8');
  assertEqual(raw, 'ALPHA\r\nbeta\r\n', 'auto lineEnding should preserve CRLF');
}

async function testConfiguredLfConvertsExistingCrlf(): Promise<void> {
  await resetFixtures();
  await writeFixture('force-lf.txt', 'alpha\r\nbeta\r\n');

  const result = await callReplace(
    {
      file_path: 'force-lf.txt',
      target: 'alpha',
      replacement: 'ALPHA',
    },
    createTestConfig('lf'),
  );

  assertSuccessResult(result);
  const raw = await fs.readFile(fixturePath('force-lf.txt'), 'utf-8');
  assertEqual(raw, 'ALPHA\nbeta\n', 'lf lineEnding should write LF');
}

async function testConfiguredCrlfConvertsExistingLf(): Promise<void> {
  await resetFixtures();
  await writeFixture('force-crlf.txt', 'alpha\nbeta\n');

  const result = await callReplace(
    {
      file_path: 'force-crlf.txt',
      target: 'alpha',
      replacement: 'ALPHA',
    },
    createTestConfig('crlf'),
  );

  assertSuccessResult(result);
  const raw = await fs.readFile(fixturePath('force-crlf.txt'), 'utf-8');
  assertEqual(raw, 'ALPHA\r\nbeta\r\n', 'crlf lineEnding should write CRLF');
}

async function testNewFileAutoLineEndingUsesLf(): Promise<void> {
  await resetFixtures();

  const result = await callReplace({
    file_path: 'new-auto.txt',
    target: '',
    replacement: 'alpha\nbeta',
  });

  assertSuccessResult(result);
  const raw = await fs.readFile(fixturePath('new-auto.txt'), 'utf-8');
  assertEqual(raw, 'alpha\nbeta', 'New file in auto mode should use LF');
}

async function testSameFileConcurrentReplacementsAreSerialized(): Promise<void> {
  await resetFixtures();
  await writeFixture('concurrent.txt', 'alpha\nbeta\n');

  const [first, second] = await Promise.all([
    callReplace({
      file_path: 'concurrent.txt',
      target: 'alpha',
      replacement: 'ALPHA',
    }),
    callReplace({
      file_path: 'concurrent.txt',
      target: 'beta',
      replacement: 'BETA',
    }),
  ]);

  assertSuccessResult(first);
  assertSuccessResult(second);
  await assertFixtureContent(
    'concurrent.txt',
    'ALPHA\nBETA\n',
    'Same-file concurrent replacements should not lose updates',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text v2 I/O safety tests',
    details: 'Covers path safety, binary/size rejection, lineEnding behavior, and file-lock serialization.',
    afterAll: cleanupFixtures,
    tests: [
      {
        name: 'Absolute path inside root echoes original path',
        run: testAbsolutePathInsideRootEchoesOriginalPath,
      },
      { name: 'Outside root path is rejected', run: testOutsideRootPathRejected },
      { name: 'Directory path is rejected', run: testDirectoryPathRejected },
      { name: 'Known binary extension is rejected', run: testKnownBinaryExtensionRejected },
      { name: 'Content-detected binary is rejected', run: testContentDetectedBinaryRejected },
      { name: 'Oversized file is rejected before write', run: testOversizedFileRejectedBeforeWrite },
      {
        name: 'auto lineEnding preserves existing CRLF',
        run: testAutoLineEndingPreservesExistingCrlf,
      },
      {
        name: 'lf lineEnding converts existing CRLF',
        run: testConfiguredLfConvertsExistingCrlf,
      },
      {
        name: 'crlf lineEnding converts existing LF',
        run: testConfiguredCrlfConvertsExistingLf,
      },
      { name: 'New file auto lineEnding uses LF', run: testNewFileAutoLineEndingUsesLf },
      {
        name: 'Same-file concurrent replacements are serialized',
        run: testSameFileConcurrentReplacementsAreSerialized,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
