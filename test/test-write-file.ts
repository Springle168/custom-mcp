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

async function testRejectPlaceholderContent() {
  const cases = ['// rest of code ...', '...', '...\ractual code'];
  for (const content of cases) {
    const result = await writeFileTool.handler(
      { file_path: 'placeholder.txt', content },
      testConfig,
    );

    assert(result.isError === true, `Should fail for ${JSON.stringify(content)}`);
    assertIncludes(
      getResultText(result),
      'omission placeholder',
      'Should reject incomplete content',
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
      { name: 'Reject placeholder content', run: testRejectPlaceholderContent },
      { name: 'Reject symlink escaping workspace', run: testRejectSymlinkEscapingWorkspace },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
