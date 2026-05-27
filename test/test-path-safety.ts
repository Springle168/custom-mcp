import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import readFileTool from '../src/tools/read-file.js';
import readManyFilesTool from '../src/tools/read-many-files.js';
import writeFileTool from '../src/tools/write-file.js';
import {
  resolveSafeGlobPattern,
  resolveSafePath,
  type PathSafetyErrorCode,
} from '../src/utils/paths.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  getResultText,
  runTestSuite,
} from './test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'path-safety');
const OUTSIDE_DIR = path.join(__dirname, 'fixtures', 'path-safety-outside');

const testConfig: Config = {
  rootDir: FIXTURES_DIR,
  lineEnding: 'auto',
  port: 3100,
};

const symlinkResults: string[] = [];

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.rm(OUTSIDE_DIR, { recursive: true, force: true });

  await fs.mkdir(path.join(FIXTURES_DIR, 'src', 'nested'), { recursive: true });
  await fs.mkdir(path.join(FIXTURES_DIR, 'special'), { recursive: true });
  await fs.mkdir(OUTSIDE_DIR, { recursive: true });

  await fs.writeFile(path.join(FIXTURES_DIR, '.env'), 'SECRET=hidden\n', 'utf-8');
  await fs.writeFile(path.join(FIXTURES_DIR, 'src', 'Foo.ts'), 'export const foo = 1;\n', 'utf-8');
  await fs.writeFile(path.join(FIXTURES_DIR, 'src', 'nested', 'Bar.ts'), 'export const bar = 2;\n', 'utf-8');
  await fs.writeFile(path.join(FIXTURES_DIR, 'special', 'file[test].ts'), 'export const bracket = true;\n', 'utf-8');
  await fs.writeFile(path.join(FIXTURES_DIR, 'special', 'file{brace}.ts'), 'export const brace = true;\n', 'utf-8');
  await fs.writeFile(path.join(FIXTURES_DIR, 'special', 'file{a,b}.ts'), 'export const braceComma = true;\n', 'utf-8');
  await fs.writeFile(path.join(OUTSIDE_DIR, 'outside.ts'), 'export const outside = true;\n', 'utf-8');
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.rm(OUTSIDE_DIR, { recursive: true, force: true });
}

async function removeLinkIfExists(linkPath: string): Promise<void> {
  try {
    await fs.unlink(linkPath);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return;
    await fs.rm(linkPath, { recursive: true, force: true });
  }
}

function assertPathError(input: string, code: PathSafetyErrorCode): void {
  const result = resolveSafePath(input, FIXTURES_DIR);
  assert(result.ok === false, `${input} should be rejected`);
  assertEqual(result.error.code, code, `${input} should fail with ${code}`);
}

async function testRejectsUnsupportedPathShapes(): Promise<void> {
  assertPathError('E:foo.txt', 'drive_relative_path');
  assertPathError('/foo.txt', 'rooted_without_drive');
  assertPathError(String.raw`\foo.txt`, 'rooted_without_drive');
  assertPathError('///foo.txt', 'repeated_rooted_without_drive');
  assertPathError(String.raw`\\\foo.txt`, 'repeated_rooted_without_drive');
  assertPathError('//server/share/foo.txt', 'unc_path');
  assertPathError(String.raw`\\server\share\foo.txt`, 'unc_path');
  assertPathError(String.raw`\\?\E:\Proj\foo.txt`, 'namespace_path');
}

async function testPrefixSiblingIsOutsideRoot(): Promise<void> {
  const siblingDir = `${FIXTURES_DIR}-nested`;
  const siblingFile = path.join(siblingDir, 'Foo.ts');
  await fs.mkdir(siblingDir, { recursive: true });
  await fs.writeFile(siblingFile, 'export const sibling = true;\n', 'utf-8');

  try {
    const result = await readFileTool.handler(
      { file_path: siblingFile },
      testConfig,
    );

    assert(result.isError === true, 'Sibling prefix path should fail');
    assertIncludes(
      getResultText(result),
      'outside the allowed workspace',
      'Failure should explain root boundary rejection',
    );
  } finally {
    await fs.rm(siblingDir, { recursive: true, force: true });
  }
}

async function testDriveAbsoluteGlobStaticBaseAndDisplay(): Promise<void> {
  const pattern = path.join(FIXTURES_DIR, 'src', '**', '*.ts');
  const globSafety = resolveSafeGlobPattern(pattern, FIXTURES_DIR);

  assert(globSafety.ok === true, 'Drive-absolute glob inside root should pass static base validation');
  assertEqual(globSafety.glob.pattern, 'src/**/*.ts', 'Drive-absolute glob should be normalized to a root-relative expansion pattern');
  assertEqual(globSafety.glob.displayKind, 'absolute', 'Drive-absolute glob results should display as absolute paths');

  const result = await readManyFilesTool.handler(
    { include: [pattern], useDefaultExcludes: false },
    testConfig,
  );

  assert(result.isError !== true, 'Drive-absolute glob should read files');
  const text = getResultText(result);
  assertIncludes(text, 'Read 2 file(s)', 'Should read both TypeScript files');
  assertIncludes(text, `--- ${path.join(FIXTURES_DIR, 'src', 'Foo.ts')} ---`, 'Drive-absolute glob should display absolute separators');
  assertIncludes(text, 'export const foo = 1;', 'Should include Foo content');
  assertIncludes(text, 'export const bar = 2;', 'Should include nested Bar content');
}

async function testSlashLeadingGlobIsRelativeButPlainRootedPathFails(): Promise<void> {
  const globSafety = resolveSafeGlobPattern('/**/Foo.ts', FIXTURES_DIR);
  assert(globSafety.ok === true, 'Slash-leading glob with metacharacters should be accepted');
  assertEqual(globSafety.glob.pattern, '**/Foo.ts', 'Slash-leading glob should strip the leading slash and expand relative to root');

  const globResult = await readManyFilesTool.handler(
    { include: ['/**/Foo.ts'] },
    testConfig,
  );

  assert(globResult.isError !== true, 'Slash-leading glob should read within root');
  assertIncludes(getResultText(globResult), 'src\\Foo.ts', 'Slash-leading glob should display root-relative result');

  const plainRootedResult = await readManyFilesTool.handler(
    { include: ['/src/Foo.ts'] },
    testConfig,
  );

  assert(plainRootedResult.isError === true, 'Plain slash-leading non-glob path should fail');
  assertIncludes(
    getResultText(plainRootedResult),
    'rooted without a drive letter',
    'Plain rooted path should not use slash-leading glob compatibility',
  );
}

async function testGlobStaticBaseOutsideRootFailsBeforeReading(): Promise<void> {
  const result = await readManyFilesTool.handler(
    { include: ['../path-safety-outside/**/*.ts'], useDefaultExcludes: false },
    testConfig,
  );

  assert(result.isError === true, 'Outside glob static base should fail');
  const text = getResultText(result);
  assertIncludes(text, 'outside workspace', 'Failure should identify the workspace boundary');
  assertNotIncludes(text, 'export const outside = true;', 'Outside file content must not be read');
}

async function testBraceExpandedParentTraversalFailsBeforeGlob(): Promise<void> {
  const globSafety = resolveSafeGlobPattern('{..,src}/**/*.ts', FIXTURES_DIR);
  assert(globSafety.ok === false, 'Brace-expanded parent traversal should be rejected before glob expansion');
  assertEqual(globSafety.error.code, 'invalid_glob', 'Brace-expanded parent traversal should be an invalid glob');

  const result = await readManyFilesTool.handler(
    { include: ['{..,src}/**/*.ts'], useDefaultExcludes: false },
    testConfig,
  );

  assert(result.isError === true, 'Brace-expanded parent traversal should fail');
  const text = getResultText(result);
  assertIncludes(text, "contains '..'", 'Failure should explain parent traversal in glob remainder');
  assertNotIncludes(text, 'export const outside = true;', 'Outside file content must not be read');
}

async function testLongBraceExpandedParentTraversalFailsClosed(): Promise<void> {
  const alternatives = Array.from({ length: 70 }, (_, index) => `a${index}`);
  alternatives.push('.');
  const pattern = `.{${alternatives.join(',')}}/**/*.ts`;
  const globSafety = resolveSafeGlobPattern(pattern, FIXTURES_DIR);

  assert(globSafety.ok === false, 'Traversal branch after many alternatives should still be rejected');
  assertEqual(globSafety.error.code, 'invalid_glob', 'Long brace traversal should be an invalid glob');
}

async function testExtglobOnlyPatternIsExpanded(): Promise<void> {
  const globSafety = resolveSafeGlobPattern('src/@(Foo).ts', FIXTURES_DIR);
  assert(globSafety.ok === true, 'Extglob-only pattern should be recognized as glob magic');

  const result = await readManyFilesTool.handler(
    { include: ['src/@(Foo).ts'], useDefaultExcludes: false },
    testConfig,
  );

  assert(result.isError !== true, 'Extglob-only pattern should be expanded');
  const text = getResultText(result);
  assertIncludes(text, 'Read 1 file(s)', 'Extglob-only pattern should read Foo.ts');
  assertIncludes(text, 'src\\Foo.ts', 'Extglob-only pattern should display the matched file');
  assertIncludes(text, 'export const foo = 1;', 'Extglob-only pattern should include Foo content');
}

async function testRelativeLiteralPathHonorsDefaultExcludes(): Promise<void> {
  const result = await readManyFilesTool.handler(
    { include: ['.env'] },
    testConfig,
  );

  assert(result.isError === true, 'Relative literal .env should be excluded by default');
  const text = getResultText(result);
  assertIncludes(text, 'excluded by exclude patterns', 'Relative literal should report exclude filtering');
  assertNotIncludes(text, 'SECRET=hidden', 'Excluded relative literal content must not be read');
}

async function testRelativeLiteralPathHonorsBraceAndExtglobExcludes(): Promise<void> {
  const braceResult = await readManyFilesTool.handler(
    { include: ['src/Foo.ts'], exclude: ['src/*.{ts,tsx}'], useDefaultExcludes: false },
    testConfig,
  );

  assert(braceResult.isError === true, 'Brace exclude should filter a relative literal path');
  assertIncludes(getResultText(braceResult), 'excluded by exclude patterns', 'Brace exclude should be reported');
  assertNotIncludes(getResultText(braceResult), 'export const foo = 1;', 'Brace-excluded content must not be read');

  const extglobResult = await readManyFilesTool.handler(
    { include: ['src/Foo.ts'], exclude: ['src/@(Foo).ts'], useDefaultExcludes: false },
    testConfig,
  );

  assert(extglobResult.isError === true, 'Extglob exclude should filter a relative literal path');
  assertIncludes(getResultText(extglobResult), 'excluded by exclude patterns', 'Extglob exclude should be reported');
  assertNotIncludes(getResultText(extglobResult), 'export const foo = 1;', 'Extglob-excluded content must not be read');
}

async function testLiteralFilenamesWithGlobMetacharacters(): Promise<void> {
  const result = await readManyFilesTool.handler(
    {
      include: ['special/file[test].ts', 'special/file{brace}.ts', 'special/file{a,b}.ts'],
      useDefaultExcludes: false,
    },
    testConfig,
  );

  assert(result.isError !== true, 'Literal files containing glob metacharacters should be read');
  const text = getResultText(result);
  assertIncludes(text, 'Read 3 file(s)', 'All literal special-name files should be read');
  assertIncludes(text, 'file[test].ts', 'Bracket filename should appear literally');
  assertIncludes(text, 'file{brace}.ts', 'Brace filename should appear literally');
  assertIncludes(text, 'file{a,b}.ts', 'Brace-comma filename should appear literally');
  assertIncludes(text, 'export const bracket = true;', 'Bracket file content should be returned');
  assertIncludes(text, 'export const brace = true;', 'Brace file content should be returned');
  assertIncludes(text, 'export const braceComma = true;', 'Brace-comma file content should be returned');
}

async function testReadRejectsSymlinkEscapeWhenAvailable(): Promise<void> {
  const linkPath = path.join(FIXTURES_DIR, 'outside-link');
  await removeLinkIfExists(linkPath);

  try {
    try {
      await fs.symlink(
        OUTSIDE_DIR,
        linkPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      symlinkResults.push(`read symlink escape skipped: ${error.message}`);
      return;
    }

    const result = await readFileTool.handler(
      { file_path: path.join('outside-link', 'outside.ts') },
      testConfig,
    );

    assert(result.isError === true, 'read_file should reject symlink escapes');
    assertIncludes(
      getResultText(result),
      'outside the allowed workspace',
      'read_file should report realpath escape',
    );
    symlinkResults.push('read symlink escape: ran');
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function testWriteRejectsSymlinkTargetWhenAvailable(): Promise<void> {
  const realTarget = path.join(FIXTURES_DIR, 'real-target.txt');
  const linkPath = path.join(FIXTURES_DIR, 'write-link.txt');
  await fs.writeFile(realTarget, 'original\n', 'utf-8');
  await removeLinkIfExists(linkPath);

  try {
    try {
      await fs.symlink(realTarget, linkPath, 'file');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      symlinkResults.push(`write target symlink skipped: ${error.message}`);
      return;
    }

    const result = await writeFileTool.handler(
      { file_path: 'write-link.txt', content: 'changed\n' },
      testConfig,
    );

    assert(result.isError === true, 'write_file should reject symlink targets');
    assertIncludes(
      getResultText(result),
      'symbolic link',
      'write_file should explain symlink target rejection',
    );

    const raw = await fs.readFile(realTarget, 'utf-8');
    assertEqual(raw, 'original\n', 'write_file must not write through a symlink');
    symlinkResults.push('write target symlink: ran');
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing path safety refactor',
    details: `Fixtures directory: ${FIXTURES_DIR}`,
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'Reject unsupported path shapes before resolve', run: testRejectsUnsupportedPathShapes },
      { name: 'Reject prefix-sibling path outside root', run: testPrefixSiblingIsOutsideRoot },
      { name: 'Drive-absolute glob validates static base and preserves display kind', run: testDriveAbsoluteGlobStaticBaseAndDisplay },
      { name: 'Slash-leading glob is relative while plain rooted path fails', run: testSlashLeadingGlobIsRelativeButPlainRootedPathFails },
      { name: 'Glob static base outside root fails before reading', run: testGlobStaticBaseOutsideRootFailsBeforeReading },
      { name: 'Brace-expanded parent traversal fails before glob', run: testBraceExpandedParentTraversalFailsBeforeGlob },
      { name: 'Long brace-expanded parent traversal fails closed', run: testLongBraceExpandedParentTraversalFailsClosed },
      { name: 'Extglob-only pattern is expanded', run: testExtglobOnlyPatternIsExpanded },
      { name: 'Relative literal path honors default excludes', run: testRelativeLiteralPathHonorsDefaultExcludes },
      { name: 'Relative literal path honors brace and extglob excludes', run: testRelativeLiteralPathHonorsBraceAndExtglobExcludes },
      { name: 'Literal filenames with glob metacharacters are read safely', run: testLiteralFilenamesWithGlobMetacharacters },
      { name: 'Read rejects symlink escape when available', run: testReadRejectsSymlinkEscapeWhenAvailable },
      { name: 'Write rejects symlink target when available', run: testWriteRejectsSymlinkTargetWhenAvailable },
    ],
  });

  if (symlinkResults.length > 0) {
    console.log('Symlink validation:');
    for (const line of symlinkResults) {
      console.log(`- ${line}`);
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
