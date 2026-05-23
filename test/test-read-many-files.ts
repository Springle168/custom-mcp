// test/test-read-many-files.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import readManyFilesTool from '../src/tools/read-many-files.js';
import {
  assert,
  assertIncludes,
  assertNotIncludes,
  getResultText,
  runTestSuite,
} from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fixtures directory
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'read-many-files');

// Test config
const testConfig: Config = {
  rootDir: FIXTURES_DIR,
  otherRootDirs: [],
  lineEnding: 'auto',
  port: 3100,
};

// ================
// Test Cases
// ================

async function testSingleFileAbsolutePath() {
  
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
  
}

async function testGlobPattern() {
  
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
  
}

async function testMixedPathsAndGlobs() {
  
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
  
}

async function testGlobStartingWithSlash() {
  
  const result = await readManyFilesTool.handler(
    { include: ['/**/Foo.kt'] },  // 以 / 开头但包含 glob 元字符
    testConfig
  );
  
  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Foo.kt', 'Should find Foo.kt');
  
}

async function testDefaultExcludes() {
  
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
  
}

async function testDefaultExcludesDisabled() {
  
  const result = await readManyFilesTool.handler(
    { include: ['**/*.txt'], useDefaultExcludes: false },
    testConfig
  );
  
  assert(!result.isError, 'Should succeed');
  const text = getResultText(result);
  
  // Should now read .txt files in node_modules and build
  assertIncludes(text, 'Read 2 file(s)', 'Should read 2 txt files');
  assertIncludes(text, 'excluded.txt', 'Should include excluded.txt files');
  
}

async function testAbsolutePathBypassesExcludes() {
  
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
  
}

async function testFileNotFound() {
  
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
  
}

async function testNoMatches() {
  
  const result = await readManyFilesTool.handler(
    { include: ['**/*.xyz'] },
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error');
  const text = getResultText(result);
  
  assertIncludes(text, 'No files matched', 'Should report no matches');
  assertIncludes(text, 'Verify the paths/patterns', 'Should provide guidance');
  
}

async function testPathOutsideRoot() {
  
  const outsidePath = path.join(FIXTURES_DIR, '..', '..', '..', 'etc', 'passwd');
  const result = await readManyFilesTool.handler(
    { include: [outsidePath] },
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error when all files fail');
  const text = getResultText(result);
  
  assertIncludes(text, 'skipped', 'Should report file skipped');
  assertIncludes(text, 'outside workspace', 'Should explain security reason');
  
}

async function testAbsoluteGlobInOtherRootDir() {
  const otherRootDir = path.join(__dirname, 'fixtures', 'read-many-files-other-root');
  const srcDir = path.join(otherRootDir, 'src');
  const otherFilePath = path.join(srcDir, 'Other.kt');
  const config: Config = {
    ...testConfig,
    otherRootDirs: [otherRootDir],
  };

  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(
    otherFilePath,
    'package other\n\nclass OtherFromOtherRoot\n',
    'utf-8',
  );

  try {
    const relativeResult = await readManyFilesTool.handler(
      { include: ['src/*.kt'] },
      config,
    );
    assert(relativeResult.isError !== true, 'Relative glob should still succeed in rootDir');
    assertNotIncludes(
      getResultText(relativeResult),
      'OtherFromOtherRoot',
      'Relative glob should not scan otherRootDirs',
    );

    const driveRelativeResult = await readManyFilesTool.handler(
      { include: ['C:src/*.kt'] },
      config,
    );
    assert(driveRelativeResult.isError === true, 'Drive-relative include should fail');
    assertIncludes(
      getResultText(driveRelativeResult),
      'Drive-relative include paths',
      'Should reject drive-relative include paths',
    );

    const traversalPattern = path
      .join('..', 'read-many-files-other-root', 'src', '*.kt')
      .replace(/\\/g, '/');
    const traversalResult = await readManyFilesTool.handler(
      { include: [traversalPattern] },
      config,
    );
    assert(traversalResult.isError === true, 'Relative traversal glob should not match otherRootDirs');
    assertNotIncludes(
      getResultText(traversalResult),
      'OtherFromOtherRoot',
      'Relative traversal glob should not read otherRootDirs',
    );

    const absolutePattern = path.join(srcDir, '*.kt').replace(/\\/g, '/');
    const absoluteResult = await readManyFilesTool.handler(
      { include: [absolutePattern] },
      config,
    );
    assert(absoluteResult.isError !== true, 'Absolute glob in otherRootDirs should succeed');
    const text = getResultText(absoluteResult);
    assertIncludes(text, otherFilePath, 'Should display absolute path for absolute glob');
    assertIncludes(text, 'OtherFromOtherRoot', 'Should read files matched in otherRootDirs');
  } finally {
    await fs.rm(otherRootDir, { recursive: true, force: true });
  }
}

async function testEmptyInclude() {
  
  const result = await readManyFilesTool.handler(
    { include: [] },
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error');
  const text = getResultText(result);
  
  assertIncludes(text, 'non-empty array', 'Should report validation error');
  
}

async function testInvalidIncludeType() {
  
  const result = await readManyFilesTool.handler(
    { include: 'not-an-array' },
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error');
  const text = getResultText(result);
  
  assertIncludes(text, 'non-empty array', 'Should report validation error');
  
}

async function testCustomExclude() {
  
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
  
}

async function testPartialSuccess() {
  
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
  
}

async function testRelativePathWithGlobChars() {
  
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
  
}

async function testRelativePathWithBraces() {
  
  const result = await readManyFilesTool.handler(
    { include: ['special-names/file{brace}.kt'] },
    testConfig
  );
  
  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Read 1 file(s)', 'Should read 1 file');
  assertIncludes(text, 'file{brace}.kt', 'Should include the file with braces');
  assertIncludes(text, 'class FileWithBraces', 'Should include file content');
  
}

async function testPathIsDirectory() {
  
  const dirPath = path.join(FIXTURES_DIR, 'src');
  const result = await readManyFilesTool.handler(
    { include: [dirPath] },
    testConfig
  );
  
  assert(result.isError === true, 'Should be an error when all files fail');
  const text = getResultText(result);
  
  assertIncludes(text, 'skipped 1', 'Should report 1 item skipped');
  assertIncludes(text, 'not a file', 'Should explain it is a directory');
  
}

async function testBinaryFileSkipped() {
  
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
  
}

async function testBinaryFileInGlob() {
  
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
  
}

async function testShallowRead() {

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

}

async function testShowLineNumbers() {

  const result = await readManyFilesTool.handler(
    { include: ['src/Foo.kt'], show_line_numbers: true },
    testConfig
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'No truncation: all returned file contents are complete.', 'Should state no truncation');
  assertIncludes(text, '1: package com.example.demo', 'Should prefix first line');
  assertIncludes(text, '6: data class Foo(', 'Should preserve original line numbers');

}

// ================
// Main Test Runner
// ================

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing read_many_files tool',
    details: `Fixtures directory: ${FIXTURES_DIR}`,
    tests: [
      { name: 'Single file with absolute path', run: testSingleFileAbsolutePath },
      { name: 'Glob pattern matching multiple files', run: testGlobPattern },
      { name: 'Mixed absolute paths and glob patterns', run: testMixedPathsAndGlobs },
      { name: 'Glob pattern starting with / (should work as relative glob)', run: testGlobStartingWithSlash },
      { name: 'Default excludes (node_modules, build)', run: testDefaultExcludes },
      { name: 'Default excludes disabled', run: testDefaultExcludesDisabled },
      { name: 'Absolute path bypasses default excludes', run: testAbsolutePathBypassesExcludes },
      { name: 'File not found', run: testFileNotFound },
      { name: 'No matches for glob', run: testNoMatches },
      { name: 'Path outside root', run: testPathOutsideRoot },
      { name: 'Absolute glob in otherRootDirs', run: testAbsoluteGlobInOtherRootDir },
      { name: 'Empty include array', run: testEmptyInclude },
      { name: 'Invalid include type', run: testInvalidIncludeType },
      { name: 'Custom exclude patterns', run: testCustomExclude },
      { name: 'Partial success with skipped file', run: testPartialSuccess },
      { name: 'Relative path with glob chars in filename', run: testRelativePathWithGlobChars },
      { name: 'Relative path with braces in filename', run: testRelativePathWithBraces },
      { name: 'Path pointing to a directory', run: testPathIsDirectory },
      { name: 'Binary file is skipped (extension-based detection)', run: testBinaryFileSkipped },
      { name: 'Binary files are filtered out in glob results', run: testBinaryFileInGlob },
      { name: 'Shallow read returns file list and line counts', run: testShallowRead },
      { name: 'show_line_numbers prefixes returned content lines', run: testShowLineNumbers },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
