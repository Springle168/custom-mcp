import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { callBuiltInTool } from '../helpers/built-in-tool-call.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import readManyFilesTool from '../../src/tools/read-many-files.js';
import {
  cleanupFixtures,
  FIXTURES_DIR,
  prepareFixtures,
} from './fixtures.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';

let testContext: ReturnType<typeof createTestToolRuntimeContext>;

async function prepareTestContext(): Promise<void> {
  await prepareFixtures();
  testContext = createTestToolRuntimeContext({ rootDir: FIXTURES_DIR });
}

async function testSingleFileAbsolutePath() {
  
  const fooPath = path.join(FIXTURES_DIR, 'src', 'Foo.kt');
  const result = await readManyFilesTool.handler(
    { include: [fooPath] },
    testContext, createTestToolInvocationContext()
  );
  
  assert(!result.isError, 'Should succeed');
  const text = getResultText(result);

  assertEqual(result.content.length, 2, 'Should return one summary block and one file block');
  const summaryBlock = result.content[0];
  assert(summaryBlock?.type === 'text', 'The first block should contain the summary');
  assertIncludes(summaryBlock.text, 'Read 1 file(s)', 'The first block should report the summary');
  assert(summaryBlock.text.endsWith('\n'), 'The summary block should end with a newline');
  const fileBlock = result.content[1];
  assert(fileBlock?.type === 'text', 'The second block should contain the file');
  assertIncludes(fileBlock.text, `--- ${fooPath} ---`, 'The file block should identify its path');
  assertIncludes(fileBlock.text, 'data class Foo', 'The file block should contain the file content');
  assertIncludes(text, 'Read 1 file(s)', 'Should report 1 file read');
  assertIncludes(text, `--- ${fooPath} ---`, 'Should include file separator with absolute path');
  assertIncludes(text, 'data class Foo', 'Should include file content');
  
}

async function testGlobPattern() {
  
  const result = await readManyFilesTool.handler(
    { include: ['src/**/*.kt'] },
    testContext, createTestToolInvocationContext()
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
    testContext, createTestToolInvocationContext()
  );
  
  assert(!result.isError, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Read 3 file(s)', 'Should read 3 files');
  assertIncludes(text, 'README.md', 'Should include README.md');
  assertIncludes(text, 'Foo.kt', 'Should include Foo.kt');
  assertIncludes(text, 'Bar.kt', 'Should include Bar.kt');
  assertNotIncludes(text, 'Deep.kt', 'Should not include nested Deep.kt');
  assertIncludes(text, '# Demo Project', 'Should include README content');
  
}

async function testGlobStartingWithSlash() {
  
  const result = await readManyFilesTool.handler(
    { include: ['/**/Foo.kt'] },
    testContext, createTestToolInvocationContext()
  );
  
  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Foo.kt', 'Should find Foo.kt');
  
}

async function testNoBuiltInDefaultExcludes() {
  
  const result = await readManyFilesTool.handler(
    { include: ['**/*.txt', '**/*.kt', '**/*.md'] },
    testContext, createTestToolInvocationContext()
  );
  
  assert(!result.isError, 'Should succeed');
  const text = getResultText(result);
  
  assertIncludes(text, 'Foo.kt', 'Should include Foo.kt');
  assertIncludes(text, 'README.md', 'Should include README.md');
  assertIncludes(text, 'node_modules', 'Should include node_modules without configured ignore');
  assertIncludes(text, 'build', 'Should include build output without configured ignore');
  assertIncludes(text, 'excluded.txt', 'Should include files without configured ignore');
  
}

async function testRejectUseDefaultExcludesAlias() {
  
  const result = await callBuiltInTool(
    'read_many_files',
    { include: ['**/*.txt'], useDefaultExcludes: false },
    testContext,
    createTestToolInvocationContext(),
  );
  
  assert(result.isError === true, 'Removed aliases should be rejected');
  const text = getResultText(result);
  assertIncludes(text, 'unexpected property "useDefaultExcludes"', 'Should identify the unsupported alias');
  
}

async function testAbsoluteLiteralBypassesExcludes() {
  
  const excludedPath = path.join(FIXTURES_DIR, 'node_modules', 'excluded.txt');
  const result = await readManyFilesTool.handler(
    { 
      include: [excludedPath],
      exclude: ['node_modules/**'],
    },
    testContext, createTestToolInvocationContext()
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
    testContext, createTestToolInvocationContext()
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
    testContext, createTestToolInvocationContext()
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
    testContext, createTestToolInvocationContext()
  );
  
  assert(result.isError === true, 'Should be an error when all files fail');
  const text = getResultText(result);
  
  assertIncludes(text, 'skipped', 'Should report file skipped');
  assertIncludes(text, 'configured workspace roots', 'Should explain security reason');
  
}

async function testEmptyInclude() {
  
  const result = await callBuiltInTool(
    'read_many_files',
    { include: [] },
    testContext,
    createTestToolInvocationContext(),
  );
  
  assert(result.isError === true, 'Should be an error');
  const text = getResultText(result);
  
  assertIncludes(text, 'must NOT have fewer than 1 items', 'Should report schema validation error');
  
}

async function testInvalidIncludeType() {
  
  const result = await callBuiltInTool(
    'read_many_files',
    { include: 'not-an-array' },
    testContext,
    createTestToolInvocationContext(),
  );
  
  assert(result.isError === true, 'Should be an error');
  const text = getResultText(result);
  
  assertIncludes(text, 'must be array', 'Should report schema validation error');
  
}

async function testCustomExclude() {
  
  const result = await readManyFilesTool.handler(
    { 
      include: ['src/**/*.kt'],
      exclude: ['**/nested/**']
    },
    testContext, createTestToolInvocationContext()
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
    testContext, createTestToolInvocationContext()
  );
  
  assert(result.isError !== true, 'Should succeed when at least one file is read');
  const text = getResultText(result);
  
  assertIncludes(text, 'Read 1 file(s), skipped 1', 'Should report both read and skipped');
  assertIncludes(text, 'Foo.kt', 'Should include successful file');
  assertIncludes(text, 'nonexistent.kt', 'Should mention skipped file');
  
}

async function testRelativePathWithGlobChars() {
  
  const result = await readManyFilesTool.handler(
    { include: ['special-names/file[test].kt'] },
    testContext, createTestToolInvocationContext()
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
    testContext, createTestToolInvocationContext()
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
    testContext, createTestToolInvocationContext()
  );
  
  assert(result.isError === true, 'Should be an error when all files fail');
  const text = getResultText(result);
  
  assertIncludes(text, 'skipped 1', 'Should report 1 item skipped');
  assertIncludes(text, 'not a file', 'Should explain it is a directory');
  
}

async function testBinaryFileSkipped() {
  
  const pngPath = path.join(FIXTURES_DIR, 'binary', 'fake.png');
  const result = await readManyFilesTool.handler(
    { include: [pngPath] },
    testContext, createTestToolInvocationContext()
  );
  
  assert(result.isError === true, 'Should be an error when all files fail');
  const text = getResultText(result);
  
  assertIncludes(text, 'skipped 1', 'Should report 1 file skipped');
  assertIncludes(text, 'fake.png', 'Should mention the PNG file');
  assertIncludes(text, 'binary file', 'Should explain it is binary');
  
}

async function testBinaryFileInGlob() {
  
  const result = await readManyFilesTool.handler(
    { include: ['**/*.{kt,png}'] },
    testContext, createTestToolInvocationContext()
  );
  
  assert(result.isError !== true, 'Should succeed (kt files found)');
  const text = getResultText(result);
  
  assertIncludes(text, 'Foo.kt', 'Should include Kotlin files');
  assertIncludes(text, 'skipped', 'Should report skipped files');
  assertIncludes(text, 'fake.png', 'Should mention the PNG file');
  assertIncludes(text, 'binary file', 'Should explain skip reason');
  
}

async function testShallowRead() {

  const fooPath = path.join(FIXTURES_DIR, 'src', 'Foo.kt');
  const readmePath = path.join(FIXTURES_DIR, 'docs', 'README.md');
  const [fooStat, readmeStat] = await Promise.all([
    fs.stat(fooPath),
    fs.stat(readmePath),
  ]);
  const result = await readManyFilesTool.handler(
    { include: ['src/Foo.kt', 'docs/README.md'], shallow_read: true },
    testContext, createTestToolInvocationContext()
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertEqual(result.content.length, 1, 'Content-omitting shallow reads should return only the summary block');
  assertIncludes(text, 'Read 2 file(s)', 'Should report 2 files read');
  assertIncludes(text, 'Shallow read: file contents omitted.', 'Should explain shallow mode');
  assertIncludes(text, 'Total lines: 37.', 'Should report total line count');
  assertIncludes(text, `Total size: ${fooStat.size + readmeStat.size} bytes.`, 'Should report total file size');
  assertIncludes(text, `src\\Foo.kt: 15 line(s), ${fooStat.size} bytes, would be truncated: no.`, 'Should report Foo line count and size');
  assertIncludes(text, `docs\\README.md: 22 line(s), ${readmeStat.size} bytes, would be truncated: no.`, 'Should report README line count and size');
  assertNotIncludes(text, 'Recommendation:', 'Should not recommend splitting a small read');
  assertNotIncludes(text, 'data class Foo', 'Should not include file content');

}

async function testShallowReadContentAtConfiguredLimit() {

  const fooPath = path.join(FIXTURES_DIR, 'src', 'Foo.kt');
  const readmePath = path.join(FIXTURES_DIR, 'docs', 'README.md');
  const [fooStat, readmeStat] = await Promise.all([
    fs.stat(fooPath),
    fs.stat(readmePath),
  ]);
  const totalSizeBytes = fooStat.size + readmeStat.size;
  const result = await readManyFilesTool.handler(
    {
      include: ['src/Foo.kt', 'docs/README.md'],
      shallow_read: true,
      shallow_read_content_limit_bytes: totalSizeBytes,
      show_line_numbers: true,
    },
    testContext, createTestToolInvocationContext()
  );

  assert(result.isError !== true, 'Should succeed at the configured limit');
  const text = getResultText(result);

  assertEqual(result.content.length, 3, 'Should return one summary block and two file blocks');
  assertIncludes(
    text,
    `Shallow read: file contents included because total size is within the configured ${totalSizeBytes} bytes limit.`,
    'Should explain why contents are included'
  );
  assertIncludes(text, `Total size: ${totalSizeBytes} bytes.`, 'Should report the compared original file size');
  assertIncludes(text, 'Files:', 'Should retain shallow-read file statistics');
  assertIncludes(text, '1: package com.example.demo', 'Should apply line numbers to included contents');

}

async function testShallowReadContentAboveConfiguredLimit() {

  const fooPath = path.join(FIXTURES_DIR, 'src', 'Foo.kt');
  const readmePath = path.join(FIXTURES_DIR, 'docs', 'README.md');
  const [fooStat, readmeStat] = await Promise.all([
    fs.stat(fooPath),
    fs.stat(readmePath),
  ]);
  const totalSizeBytes = fooStat.size + readmeStat.size;
  const result = await readManyFilesTool.handler(
    {
      include: ['src/Foo.kt', 'docs/README.md'],
      shallow_read: true,
      shallow_read_content_limit_bytes: totalSizeBytes - 1,
    },
    testContext, createTestToolInvocationContext()
  );

  assert(result.isError !== true, 'Should succeed above the configured limit');
  const text = getResultText(result);

  assertEqual(result.content.length, 1, 'Content-omitting shallow reads should return only the summary block');
  assertIncludes(
    text,
    `Shallow read: file contents omitted because total size exceeds the configured ${totalSizeBytes - 1} bytes limit.`,
    'Should explain why contents are omitted'
  );
  assertIncludes(text, `Total size: ${totalSizeBytes} bytes.`, 'Should report the compared original file size');
  assertNotIncludes(text, 'data class Foo', 'Should omit file contents');

}

async function testShallowReadContentLimitValidation() {

  const invalidValues = [0, -1, 1.5, '1024', Number.MAX_SAFE_INTEGER + 1];
  for (const value of invalidValues) {
    const result = await callBuiltInTool(
      'read_many_files',
      {
        include: ['src/Foo.kt'],
        shallow_read: true,
        shallow_read_content_limit_bytes: value,
      },
      testContext,
      createTestToolInvocationContext(),
    );
    assert(result.isError === true, `Should reject invalid limit: ${String(value)}`);
    assertIncludes(
      getResultText(result),
      'configured input schema',
      'Should report the schema validation boundary',
    );
  }

  const withoutShallowRead = await readManyFilesTool.handler(
    {
      include: ['src/Foo.kt'],
      shallow_read_content_limit_bytes: 1024,
    },
    testContext, createTestToolInvocationContext()
  );
  assert(withoutShallowRead.isError === true, 'Should require shallow_read=true');
  assertIncludes(
    getResultText(withoutShallowRead),
    "The 'shallow_read_content_limit_bytes' parameter requires 'shallow_read' to be true.",
    'Should explain the parameter dependency'
  );

}

async function testShallowReadRecommendedBatchWarning() {

  const firstPath = path.join(FIXTURES_DIR, 'shallow-size-a.txt');
  const secondPath = path.join(FIXTURES_DIR, 'shallow-size-b.txt');
  const halfThresholdContent = 'a'.repeat(25 * 1024);

  try {
    await fs.writeFile(firstPath, halfThresholdContent, 'utf-8');
    await fs.writeFile(secondPath, halfThresholdContent, 'utf-8');

    const atThresholdResult = await readManyFilesTool.handler(
      {
        include: [firstPath, secondPath],
        shallow_read: true,
        shallow_read_content_limit_bytes: 51200,
      },
      testContext, createTestToolInvocationContext()
    );
    assert(atThresholdResult.isError !== true, 'Recommended-threshold read should succeed');
    const atThresholdText = getResultText(atThresholdResult);
    assertIncludes(atThresholdText, 'Total size: 50.0 KB (51200 bytes).', 'Should report the exact recommended threshold');
    assertNotIncludes(
      atThresholdText,
      'WARNING: Included file contents exceed the recommended',
      'Should not emit the receiving-side warning at the recommended threshold'
    );

    await fs.appendFile(secondPath, 'b', 'utf-8');

    const overThresholdResult = await readManyFilesTool.handler(
      {
        include: [firstPath, secondPath],
        shallow_read: true,
        shallow_read_content_limit_bytes: 51201,
      },
      testContext, createTestToolInvocationContext()
    );
    assert(overThresholdResult.isError !== true, 'Over-threshold read should succeed');
    const overThresholdText = getResultText(overThresholdResult);
    assertIncludes(overThresholdText, 'Total size: 50.0 KB (51201 bytes).', 'Should report the exact over-threshold total');
    assertIncludes(
      overThresholdText,
      'WARNING: Included file contents exceed the recommended 50.0 KB batch size. The response may be truncated or otherwise limited by the receiving client or host.',
      'Should warn about receiving-side limits above the recommended batch size'
    );
    assertIncludes(overThresholdText, `--- ${firstPath} ---`, 'Should still include contents above the recommended size');
  } finally {
    await Promise.all([
      fs.rm(firstPath, { force: true }),
      fs.rm(secondPath, { force: true }),
    ]);
  }

}

async function testShowLineNumbers() {

  const result = await readManyFilesTool.handler(
    { include: ['src/Foo.kt'], show_line_numbers: true },
    testContext, createTestToolInvocationContext()
  );

  assert(result.isError !== true, 'Should succeed');
  const text = getResultText(result);

  assertIncludes(text, 'No truncation: all returned file contents are complete.', 'Should state no truncation');
  assertIncludes(text, '1: package com.example.demo', 'Should prefix first line');
  assertIncludes(text, '6: data class Foo(', 'Should preserve original line numbers');

}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing read_many_files tool',
    details: `Fixtures directory: ${FIXTURES_DIR}`,
    beforeAll: prepareTestContext,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'Single file with absolute path', run: testSingleFileAbsolutePath },
      { name: 'Glob pattern matching multiple files', run: testGlobPattern },
      { name: 'Mixed absolute paths and glob patterns', run: testMixedPathsAndGlobs },
      { name: 'Glob pattern starting with / (should work as relative glob)', run: testGlobStartingWithSlash },
      { name: 'No built-in default excludes', run: testNoBuiltInDefaultExcludes },
      { name: 'Removed useDefaultExcludes alias is rejected', run: testRejectUseDefaultExcludesAlias },
      { name: 'Absolute literal bypasses excludes', run: testAbsoluteLiteralBypassesExcludes },
      { name: 'File not found', run: testFileNotFound },
      { name: 'No matches for glob', run: testNoMatches },
      { name: 'Path outside root', run: testPathOutsideRoot },
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
      { name: 'Shallow read includes content at the configured limit', run: testShallowReadContentAtConfiguredLimit },
      { name: 'Shallow read omits content above the configured limit', run: testShallowReadContentAboveConfiguredLimit },
      { name: 'Shallow read content limit validates values and dependencies', run: testShallowReadContentLimitValidation },
      { name: 'Shallow read warns above the recommended batch size', run: testShallowReadRecommendedBatchWarning },
      { name: 'show_line_numbers prefixes returned content lines', run: testShowLineNumbers },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
