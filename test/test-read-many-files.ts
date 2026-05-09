// test/test-read-many-files.ts

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import readManyFilesTool from '../src/tools/read-many-files.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fixtures directory
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'read-many-files');

// Test config
const testConfig: Config = {
  rootDir: FIXTURES_DIR,
  lineEnding: 'auto',
  port: 3100,
};

// ================
// Helper Functions
// ================

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertIncludes(text: string, substring: string, message: string): void {
  if (!text.includes(substring)) {
    throw new Error(`Assertion failed: ${message}\nExpected to find: "${substring}"\nIn text: ${text.substring(0, 200)}...`);
  }
}

function assertNotIncludes(text: string, substring: string, message: string): void {
  if (text.includes(substring)) {
    throw new Error(`Assertion failed: ${message}\nDid not expect to find: "${substring}"`);
  }
}

function getResultText(result: any): string {
  return result.content[0].text;
}

// ================
// Test Cases
// ================

async function testSingleFileAbsolutePath() {
  console.log('Test: Single file with absolute path');
  
  const fooPath = path.join(FIXTURES_DIR, 'src', 'Foo.kt');
  const result = await readManyFilesTool.handler(
    { include: [fooPath] },
    testConfig
  );
  
  assert(!result.isError, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Read 1 file(s)', 'Should report 1 file read');
  assertIncludes(text, `--- ${fooPath} ---`, 'Should include file separator with absolute path');
  assertIncludes(text, 'data class Foo', 'Should include file content');
  assertIncludes(text, '--- End of content ---', 'Should include terminator');
  
  console.log('  ✓ Passed\n');
}

async function testGlobPattern() {
  console.log('Test: Glob pattern matching multiple files');
  
  const result = await readManyFilesTool.handler(
    { include: ['src/**/*.kt'] },
    testConfig
  );
  
  assert(!result.isError, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Read 3 file(s)', 'Should read 3 Kotlin files');
  assertIncludes(text, 'Foo.kt', 'Should include Foo.kt');
  assertIncludes(text, 'Bar.kt', 'Should include Bar.kt');
  assertIncludes(text, 'Deep.kt', 'Should include Deep.kt');
  assertIncludes(text, 'data class Foo', 'Should include Foo content');
  assertIncludes(text, 'class Bar', 'Should include Bar content');
  assertIncludes(text, 'object Deep', 'Should include Deep content');
  
  console.log('  ✓ Passed\n');
}

async function testMixedPathsAndGlobs() {
  console.log('Test: Mixed absolute paths and glob patterns');
  
  const readmePath = path.join(FIXTURES_DIR, 'docs', 'README.md');
  const result = await readManyFilesTool.handler(
    { include: [readmePath, 'src/*.kt'] },
    testConfig
  );
  
  assert(!result.isError, 'Should succeed');
  const text = getResultText(result);
  
  // Should read README.md + Foo.kt + Bar.kt (but not nested/Deep.kt)
  assertIncludes(text, 'Read 3 file(s)', 'Should read 3 files');
  assertIncludes(text, 'README.md', 'Should include README.md');
  assertIncludes(text, 'Foo.kt', 'Should include Foo.kt');
  assertIncludes(text, 'Bar.kt', 'Should include Bar.kt');
  assertNotIncludes(text, 'Deep.kt', 'Should not include nested Deep.kt');
  assertIncludes(text, '# Demo Project', 'Should include README content');
  
  console.log('  ✓ Passed\n');
}

async function testGlobStartingWithSlash() {
  console.log('Test: Glob pattern starting with / (should work as relative glob)');
  
  const result = await readManyFilesTool.handler(
    { include: ['/**/Foo.kt'] },  // 以 / 开头但包含 glob 元字符
    testConfig
  );
  
  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Foo.kt', 'Should find Foo.kt');
  
  console.log('  ✓ Passed\n');
}

async function testDefaultExcludes() {
  console.log('Test: Default excludes (node_modules, build)');
  
  const result = await readManyFilesTool.handler(
    { include: ['**/*.txt', '**/*.kt', '**/*.md'] },
    testConfig
  );
  
  assert(!result.isError, 'Should succeed');
  const text = getResultText(result);
  
  // Should read .kt and .md files, but not .txt in node_modules/build
  assertIncludes(text, 'Foo.kt', 'Should include Foo.kt');
  assertIncludes(text, 'README.md', 'Should include README.md');
  assertNotIncludes(text, 'node_modules', 'Should not include node_modules files');
  assertNotIncludes(text, 'build', 'Should not include build files');
  assertNotIncludes(text, 'excluded.txt', 'Should not include excluded.txt');
  
  console.log('  ✓ Passed\n');
}

async function testDefaultExcludesDisabled() {
  console.log('Test: Default excludes disabled');
  
  const result = await readManyFilesTool.handler(
    { include: ['**/*.txt'], useDefaultExcludes: false },
    testConfig
  );
  
  assert(!result.isError, 'Should succeed');
  const text = getResultText(result);
  
  // Should now read .txt files in node_modules and build
  assertIncludes(text, 'Read 2 file(s)', 'Should read 2 txt files');
  assertIncludes(text, 'excluded.txt', 'Should include excluded.txt files');
  
  console.log('  ✓ Passed\n');
}

async function testAbsolutePathBypassesExcludes() {
  console.log('Test: Absolute path bypasses exclude patterns');
  
  const excludedPath = path.join(FIXTURES_DIR, 'node_modules', 'excluded.txt');
  const result = await readManyFilesTool.handler(
    { 
      include: [excludedPath],
      useDefaultExcludes: true  // Even with default excludes on
    },
    testConfig
  );
  
  assert(!result.isError, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Read 1 file(s)', 'Should read the file');
  assertIncludes(text, 'excluded.txt', 'Should include excluded.txt');
  assertIncludes(text, 'This file should be excluded by default', 'Should include file content');
  
  console.log('  ✓ Passed\n');
}

async function testFileNotFound() {
  console.log('Test: File not found');
  
  const nonexistentPath = path.join(FIXTURES_DIR, 'nonexistent.kt');
  const result = await readManyFilesTool.handler(
    { include: [nonexistentPath] },
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error when all files fail');
  const text = getResultText(result);
  
  assertIncludes(text, 'skipped 1', 'Should report 1 file skipped');
  assertIncludes(text, 'Skipped:', 'Should include skipped section');
  assertIncludes(text, 'nonexistent.kt', 'Should mention the file');
  assertIncludes(text, 'file not found', 'Should explain the reason');
  
  console.log('  ✓ Passed\n');
}

async function testNoMatches() {
  console.log('Test: Glob pattern with no matches');
  
  const result = await readManyFilesTool.handler(
    { include: ['**/*.xyz'] },
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error');
  const text = getResultText(result);
  
  assertIncludes(text, 'No files matched', 'Should report no matches');
  assertIncludes(text, 'Verify the paths/patterns', 'Should provide guidance');
  
  console.log('  ✓ Passed\n');
}

async function testPathOutsideRoot() {
  console.log('Test: Path outside rootDir (security check)');
  
  const outsidePath = path.join(FIXTURES_DIR, '..', '..', '..', 'etc', 'passwd');
  const result = await readManyFilesTool.handler(
    { include: [outsidePath] },
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error when all files fail');
  const text = getResultText(result);
  
  assertIncludes(text, 'skipped', 'Should report file skipped');
  assertIncludes(text, 'outside workspace', 'Should explain security reason');
  
  console.log('  ✓ Passed\n');
}

async function testEmptyInclude() {
  console.log('Test: Empty include array');
  
  const result = await readManyFilesTool.handler(
    { include: [] },
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error');
  const text = getResultText(result);
  
  assertIncludes(text, 'non-empty array', 'Should report validation error');
  
  console.log('  ✓ Passed\n');
}

async function testInvalidIncludeType() {
  console.log('Test: Invalid include parameter type');
  
  const result = await readManyFilesTool.handler(
    { include: 'not-an-array' },
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error');
  const text = getResultText(result);
  
  assertIncludes(text, 'non-empty array', 'Should report validation error');
  
  console.log('  ✓ Passed\n');
}

async function testCustomExclude() {
  console.log('Test: Custom exclude pattern');
  
  const result = await readManyFilesTool.handler(
    { 
      include: ['src/**/*.kt'],
      exclude: ['**/nested/**']
    },
    testConfig
  );
  
  assert(!result.isError, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Read 2 file(s)', 'Should read 2 files (excluding nested)');
  assertIncludes(text, 'Foo.kt', 'Should include Foo.kt');
  assertIncludes(text, 'Bar.kt', 'Should include Bar.kt');
  assertNotIncludes(text, 'Deep.kt', 'Should not include Deep.kt (excluded by pattern)');
  
  console.log('  ✓ Passed\n');
}

async function testPartialSuccess() {
  console.log('Test: Partial success (some files read, some skipped)');
  
  const fooPath = path.join(FIXTURES_DIR, 'src', 'Foo.kt');
  const nonexistentPath = path.join(FIXTURES_DIR, 'nonexistent.kt');
  const result = await readManyFilesTool.handler(
    { include: [fooPath, nonexistentPath] },
    testConfig
  );
  
  assert(result.isError !== true, 'Should succeed when at least one file is read');
  const text = getResultText(result);
  
  assertIncludes(text, 'Read 1 file(s), skipped 1', 'Should report both read and skipped');
  assertIncludes(text, 'Foo.kt', 'Should include successful file');
  assertIncludes(text, 'nonexistent.kt', 'Should mention skipped file');
  
  console.log('  ✓ Passed\n');
}

async function testRelativePathWithGlobChars() {
  console.log('Test: Relative path with glob metacharacters (escape logic)');
  
  // 使用相对路径读取文件名含 [ ] 的文件
  const result = await readManyFilesTool.handler(
    { include: ['special-names/file[test].kt'] },
    testConfig
  );
  
  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Read 1 file(s)', 'Should read 1 file');
  assertIncludes(text, 'file[test].kt', 'Should include the file with brackets');
  assertIncludes(text, 'class FileWithBrackets', 'Should include file content');
  
  console.log('  ✓ Passed\n');
}

async function testRelativePathWithBraces() {
  console.log('Test: Relative path with braces in filename');
  
  const result = await readManyFilesTool.handler(
    { include: ['special-names/file{brace}.kt'] },
    testConfig
  );
  
  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Read 1 file(s)', 'Should read 1 file');
  assertIncludes(text, 'file{brace}.kt', 'Should include the file with braces');
  assertIncludes(text, 'class FileWithBraces', 'Should include file content');
  
  console.log('  ✓ Passed\n');
}

async function testPathIsDirectory() {
  console.log('Test: Path pointing to a directory');
  
  const dirPath = path.join(FIXTURES_DIR, 'src');
  const result = await readManyFilesTool.handler(
    { include: [dirPath] },
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error when all files fail');
  const text = getResultText(result);
  
  assertIncludes(text, 'skipped 1', 'Should report 1 item skipped');
  assertIncludes(text, 'not a file', 'Should explain it is a directory');
  
  console.log('  ✓ Passed\n');
}

async function testBinaryFileSkipped() {
  console.log('Test: Binary file is skipped (extension-based detection)');
  
  // 使用绝对路径绕过 exclude，或者关闭 useDefaultExcludes
  const pngPath = path.join(FIXTURES_DIR, 'binary', 'fake.png');
  const result = await readManyFilesTool.handler(
    { include: [pngPath] },  // 绝对路径绕过 exclude
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error when all files fail');
  const text = getResultText(result);
  
  assertIncludes(text, 'skipped 1', 'Should report 1 file skipped');
  assertIncludes(text, 'fake.png', 'Should mention the PNG file');
  assertIncludes(text, 'binary file', 'Should explain it is binary');
  
  console.log('  ✓ Passed\n');
}

async function testBinaryFileInGlob() {
  console.log('Test: Binary files are filtered out in glob results');
  
  const result = await readManyFilesTool.handler(
    { 
      include: ['**/*.{kt,png}'],
      useDefaultExcludes: false  // 关闭默认排除，让 PNG 能被 glob 匹配到
    },
    testConfig
  );
  
  assert(result.isError !== true, 'Should succeed (kt files found)');
  const text = getResultText(result);
  
  // Should read .kt files but skip .png
  assertIncludes(text, 'Foo.kt', 'Should include Kotlin files');
  assertIncludes(text, 'skipped', 'Should report skipped files');
  assertIncludes(text, 'fake.png', 'Should mention the PNG file');
  assertIncludes(text, 'binary file', 'Should explain skip reason');
  
  console.log('  ✓ Passed\n');
}

async function testShallowRead() {
  console.log('Test: Shallow read returns file list and line counts');

  const result = await readManyFilesTool.handler(
    { include: ['src/Foo.kt', 'docs/README.md'], shallow_read: true },
    testConfig
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'Read 2 file(s)', 'Should report 2 files read');
  assertIncludes(text, 'Shallow read: file contents omitted.', 'Should explain shallow mode');
  assertIncludes(text, 'Total lines: 37.', 'Should report total line count');
  assertIncludes(text, 'src\\Foo.kt: 15 line(s), would be truncated: no.', 'Should report Foo line count');
  assertIncludes(text, 'docs\\README.md: 22 line(s), would be truncated: no.', 'Should report README line count');
  assertNotIncludes(text, 'data class Foo', 'Should not include file content');
  assertNotIncludes(text, '--- End of content ---', 'Should not include content terminator');

  console.log('  ✓ Passed\n');
}

async function testShowLineNumbers() {
  console.log('Test: show_line_numbers prefixes returned content lines');

  const result = await readManyFilesTool.handler(
    { include: ['src/Foo.kt'], show_line_numbers: true },
    testConfig
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'No truncation: all returned file contents are complete.', 'Should state no truncation');
  assertIncludes(text, '1: package com.example.demo', 'Should prefix first line');
  assertIncludes(text, '6: data class Foo(', 'Should preserve original line numbers');

  console.log('  ✓ Passed\n');
}

// ================
// Main Test Runner
// ================

async function main() {
  console.log('='.repeat(60));
  console.log('Testing read_many_files tool');
  console.log('='.repeat(60));
  console.log(`Fixtures directory: ${FIXTURES_DIR}\n`);

  const tests = [
    testSingleFileAbsolutePath,
    testGlobPattern,
    testMixedPathsAndGlobs,
    testGlobStartingWithSlash,
    testDefaultExcludes,
    testDefaultExcludesDisabled,
    testAbsolutePathBypassesExcludes,
    testFileNotFound,
    testNoMatches,
    testPathOutsideRoot,
    testEmptyInclude,
    testInvalidIncludeType,
    testCustomExclude,
    testPartialSuccess,
    testRelativePathWithGlobChars,
    testRelativePathWithBraces,
    testPathIsDirectory,
    testBinaryFileSkipped,
    testBinaryFileInGlob,
    testShallowRead,
    testShowLineNumbers,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (error) {
      failed++;
      console.error(`  ✗ Failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
