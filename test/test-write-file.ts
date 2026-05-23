// test/test-write-file.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import writeFileTool from '../src/tools/write-file.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  getResultText,
  runTestSuite,
} from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'write-file');

const testConfig: Config = {
  rootDir: FIXTURES_DIR,
  otherRootDirs: [],
  lineEnding: 'auto',
  port: 3100,
};

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(FIXTURES_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.rm(path.join(__dirname, 'fixtures', 'write-file-outside'), {
    recursive: true,
    force: true,
  });
  await fs.rm(path.join(__dirname, 'fixtures', 'write-file-other-root'), {
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
    testConfig,
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
    testConfig,
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'Success: wrote existing.txt.', 'Should report written path');
  assertIncludes(text, 'Total lines: 2.', 'Should report line count');

  const raw = await fs.readFile(targetPath, 'utf-8');
  assertEqual(raw, 'new1\r\nnew2', 'Should preserve the original CRLF line endings');
}

async function testRejectOutsideWorkspace() {
  const outsidePath = path.join(__dirname, 'write-file-outside.txt');
  const result = await writeFileTool.handler(
    { file_path: outsidePath, content: 'nope' },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  assertIncludes(
    getResultText(result),
    'outside the allowed workspace',
    'Should explain path rejection',
  );

  await fs.rm(outsidePath, { force: true });
}

async function testRejectBinaryTarget() {
  const result = await writeFileTool.handler(
    { file_path: 'binary/fake.png', content: 'nope' },
    testConfig,
  );

  assert(result.isError === true, 'Should fail');
  assertIncludes(
    getResultText(result),
    'Cannot write text content to binary file',
    'Should reject binary files',
  );
}

async function testWarnButWritePlaceholderContent() {
  const cases = ['// rest of code ...', '...', '...\ractual code'];
  for (const [index, content] of cases.entries()) {
    const filePath = `placeholder-${index}.txt`;
    const result = await writeFileTool.handler(
      { file_path: filePath, content },
      testConfig,
    );

    assert(result.isError !== true, `Should succeed for ${JSON.stringify(content)}`);
    const text = getResultText(result);
    assertIncludes(
      text,
      `Success: wrote ${filePath}.`,
      'Should report successful write before the warning',
    );
    assertIncludes(
      text,
      'Warning: content contains possible omission placeholder',
      'Should warn about possible incomplete content',
    );

    const raw = await fs.readFile(path.join(FIXTURES_DIR, filePath), 'utf-8');
    assertEqual(
      raw,
      content.replace(/\r\n|\r/g, '\n'),
      'Should write placeholder content literally',
    );
  }
}

async function testRejectSymlinkEscapingWorkspace() {
  const outsideDir = path.join(__dirname, 'fixtures', 'write-file-outside');
  const linkPath = path.join(FIXTURES_DIR, 'escape-link');
  await fs.mkdir(outsideDir, { recursive: true });

  try {
    try {
      await fs.symlink(
        outsideDir,
        linkPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      console.log(`  - Skipped symlink assertion: ${error.message}\n`);
      return;
    }

    const result = await writeFileTool.handler(
      { file_path: path.join('escape-link', 'escaped.txt'), content: 'nope' },
      testConfig,
    );

    assert(result.isError === true, 'Should fail');
    assertIncludes(
      getResultText(result),
      'resolves outside the allowed workspace',
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

async function testWriteAbsolutePathInOtherRootDir() {
  const otherRootDir = path.join(__dirname, 'fixtures', 'write-file-other-root');
  const targetPath = path.join(otherRootDir, 'created.txt');
  const config: Config = {
    ...testConfig,
    otherRootDirs: [otherRootDir],
  };

  await fs.mkdir(otherRootDir, { recursive: true });
  const result = await writeFileTool.handler(
    { file_path: targetPath, content: 'hello from other root\n' },
    config,
  );

  assert(result.isError !== true, 'Should succeed');
  assertIncludes(
    getResultText(result),
    targetPath,
    'Should report the absolute path in otherRootDirs',
  );
  const raw = await fs.readFile(targetPath, 'utf-8');
  assertEqual(raw, 'hello from other root\n', 'Should write inside otherRootDirs');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing write_file tool',
    details: `Fixtures directory: ${FIXTURES_DIR}`,
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'Create nested file', run: testCreateNestedFile },
      { name: 'Overwrite existing file and keep CRLF', run: testOverwriteExistingFilePreservesLineEnding },
      { name: 'Reject path outside workspace', run: testRejectOutsideWorkspace },
      { name: 'Reject binary target', run: testRejectBinaryTarget },
      { name: 'Warn but write placeholder content', run: testWarnButWritePlaceholderContent },
      { name: 'Reject symlink escaping workspace', run: testRejectSymlinkEscapingWorkspace },
      { name: 'Write absolute path in otherRootDirs', run: testWriteAbsolutePathInOtherRootDir },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
