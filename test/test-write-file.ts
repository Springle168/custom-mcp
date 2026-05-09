// test/test-write-file.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import writeFileTool from '../src/tools/write-file.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'write-file');

const testConfig: Config = {
  rootDir: FIXTURES_DIR,
  lineEnding: 'auto',
  port: 3100,
};

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertIncludes(text: string, substring: string, message: string): void {
  if (!text.includes(substring)) {
    throw new Error(
      `Assertion failed: ${message}\nExpected to find: "${substring}"\nIn text: ${text.substring(0, 200)}...`,
    );
  }
}

function assertEquals(actual: string, expected: string, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
    );
  }
}

function getResultText(result: any): string {
  return result.content[0].text;
}

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
  console.log('Test: Create nested file');

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
  assertEquals(raw, 'alpha\nbeta', 'Should write the provided text exactly for new files');

  console.log('  ✓ Passed\n');
}

async function testOverwriteExistingFilePreservesLineEnding() {
  console.log('Test: Overwrite existing file and keep CRLF');

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
  assertEquals(raw, 'new1\r\nnew2', 'Should preserve the original CRLF line endings');

  console.log('  ✓ Passed\n');
}

async function testRejectOutsideWorkspace() {
  console.log('Test: Reject path outside workspace');

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

  console.log('  ✓ Passed\n');
}

async function testRejectBinaryTarget() {
  console.log('Test: Reject binary target');

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

  console.log('  ✓ Passed\n');
}

async function testRejectPlaceholderContent() {
  console.log('Test: Reject placeholder content');

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

  console.log('  ✓ Passed\n');
}

async function testRejectSymlinkEscapingWorkspace() {
  console.log('Test: Reject symlink escaping workspace');

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

  console.log('  ✓ Passed\n');
}

async function main() {
  console.log('='.repeat(24));
  console.log('Testing write_file tool');
  console.log('='.repeat(24));
  console.log(`Fixtures directory: ${FIXTURES_DIR}\n`);

  await prepareFixtures();

  const tests = [
    testCreateNestedFile,
    testOverwriteExistingFilePreservesLineEnding,
    testRejectOutsideWorkspace,
    testRejectBinaryTarget,
    testRejectPlaceholderContent,
    testRejectSymlinkEscapingWorkspace,
  ];

  let passed = 0;
  let failed = 0;

  try {
    for (const test of tests) {
      try {
        await test();
        passed++;
      } catch (error) {
        failed++;
        console.error(
          `  ✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  } finally {
    await cleanupFixtures();
  }

  console.log('='.repeat(24));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(24));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
