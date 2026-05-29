import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../src/config.js';
import readFileTool from '../src/tools/read-file.js';
import readManyFilesTool from '../src/tools/read-many-files.js';
import replaceTool from '../src/tools/replace.js';
import writeFileTool from '../src/tools/write-file.js';
import {
  createPathSafetyContext,
  createValidatedPathSafetyContext,
  resolveSafeGlobEntry,
  resolveSafeGlobPattern,
  resolveSafeGlobPatternInContext,
  resolveSafePath,
  resolveSafePathInContext,
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

function createMultiRootConfig(): Config {
  return {
    rootDir: FIXTURES_DIR,
    otherRootDirs: [OUTSIDE_DIR],
    lineEnding: 'auto',
    port: 3100,
    pathSafetyContext: createValidatedPathSafetyContext(
      FIXTURES_DIR,
      [OUTSIDE_DIR],
    ),
  };
}

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.rm(OUTSIDE_DIR, { recursive: true, force: true });

  await fs.mkdir(path.join(FIXTURES_DIR, 'src', 'nested'), { recursive: true });
  await fs.mkdir(path.join(FIXTURES_DIR, 'special'), { recursive: true });
  await fs.mkdir(path.join(OUTSIDE_DIR, 'docs'), { recursive: true });
  await fs.mkdir(path.join(OUTSIDE_DIR, 'node_modules'), { recursive: true });
  await fs.mkdir(OUTSIDE_DIR, { recursive: true });

  await fs.writeFile(path.join(FIXTURES_DIR, '.env'), 'SECRET=hidden\n', 'utf-8');
  await fs.writeFile(path.join(FIXTURES_DIR, '.ENV'), 'SECRET=uppercase\n', 'utf-8');
  await fs.writeFile(path.join(FIXTURES_DIR, 'src', 'Foo.ts'), 'export const foo = 1;\n', 'utf-8');
  await fs.writeFile(path.join(FIXTURES_DIR, 'src', 'nested', 'Bar.ts'), 'export const bar = 2;\n', 'utf-8');
  await fs.writeFile(path.join(FIXTURES_DIR, 'special', 'file[test].ts'), 'export const bracket = true;\n', 'utf-8');
  await fs.writeFile(path.join(FIXTURES_DIR, 'special', 'file{brace}.ts'), 'export const brace = true;\n', 'utf-8');
  await fs.writeFile(path.join(FIXTURES_DIR, 'special', 'file{a,b}.ts'), 'export const braceComma = true;\n', 'utf-8');
  await fs.writeFile(path.join(OUTSIDE_DIR, 'outside.ts'), 'export const outside = true;\n', 'utf-8');
  await fs.writeFile(path.join(OUTSIDE_DIR, 'docs', 'visible.txt'), 'visible additional text\n', 'utf-8');
  await fs.writeFile(path.join(OUTSIDE_DIR, 'node_modules', 'excluded.txt'), 'excluded additional text\n', 'utf-8');
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

async function testSingleRootWrappersAttachPrimaryMatchedRoot(): Promise<void> {
  const normalizedRoot = path.resolve(FIXTURES_DIR);
  const safePathResult = resolveSafePath('src/Foo.ts', FIXTURES_DIR);

  assert(safePathResult.ok === true, 'Single-root path wrapper should still resolve relative paths');
  assertEqual(safePathResult.path.rootDir, normalizedRoot, 'SafePath.rootDir should remain the normalized root');
  assertEqual(safePathResult.path.matchedRoot.kind, 'primary', 'SafePath should carry the primary matched root');
  assertEqual(safePathResult.path.matchedRoot.rootDir, normalizedRoot, 'Matched root should use the normalized root');
  assert(
    safePathResult.path.matchedRoot.permissions.read &&
      safePathResult.path.matchedRoot.permissions.write,
    'Matched root should expose read/write permissions for future root metadata',
  );

  const globResult = resolveSafeGlobPattern('src/**/*.ts', FIXTURES_DIR);
  assert(globResult.ok === true, 'Single-root glob wrapper should still resolve relative globs');
  assertEqual(globResult.glob.rootDir, normalizedRoot, 'SafeGlobPattern.rootDir should remain the normalized root');
  assertEqual(globResult.glob.matchedRoot.kind, 'primary', 'SafeGlobPattern should carry the primary matched root');

  const entryResult = resolveSafeGlobEntry(
    path.join(FIXTURES_DIR, 'src', 'Foo.ts'),
    globResult.glob,
  );
  assert(entryResult.ok === true, 'Glob entry should resolve against the glob matched root');
  assertEqual(entryResult.path.matchedRoot.rootDir, normalizedRoot, 'Glob entry should preserve matched root metadata');
}

async function testContextMatchesAdditionalRootOnlyForAbsoluteInput(): Promise<void> {
  const context = createPathSafetyContext(FIXTURES_DIR, [OUTSIDE_DIR]);
  const additionalFile = path.join(OUTSIDE_DIR, 'outside.ts');
  const absoluteResult = resolveSafePathInContext(additionalFile, context);

  assert(absoluteResult.ok === true, 'Context API should resolve drive-absolute paths in additional roots');
  assertEqual(absoluteResult.path.matchedRoot.kind, 'additional', 'Drive-absolute additional root path should match additional root');
  assertEqual(absoluteResult.path.rootDir, path.resolve(OUTSIDE_DIR), 'SafePath.rootDir should point at the matched additional root');
  assertEqual(absoluteResult.path.displayKind, 'absolute', 'Additional root paths should keep absolute display');
  assertEqual(absoluteResult.path.displayPath, path.resolve(additionalFile), 'Additional root display should be absolute');

  const relativeEscape = resolveSafePathInContext(
    path.join('..', 'path-safety-outside', 'outside.ts'),
    context,
  );
  assert(relativeEscape.ok === false, 'Relative paths must not escape primary root into an additional root');
  assertEqual(relativeEscape.error.code, 'outside_root_dir', 'Relative escape into additional root should fail closed');

  const globResult = resolveSafeGlobPatternInContext(
    path.join(OUTSIDE_DIR, '**', '*.ts'),
    context,
  );
  assert(globResult.ok === true, 'Context API should resolve drive-absolute globs in additional roots');
  assertEqual(globResult.glob.matchedRoot.kind, 'additional', 'Drive-absolute glob should match additional root');
  assertEqual(globResult.glob.rootDir, path.resolve(OUTSIDE_DIR), 'SafeGlobPattern.rootDir should point at the matched additional root');
  assertEqual(globResult.glob.pattern, '**/*.ts', 'Additional root glob should expand relative to the matched root');
  assertEqual(globResult.glob.displayKind, 'absolute', 'Additional root glob results should display as absolute paths');
}

async function testFileToolsAccessAdditionalRootOnlyWithAbsolutePaths(): Promise<void> {
  const multiRootConfig = createMultiRootConfig();
  const additionalFile = path.join(OUTSIDE_DIR, 'outside.ts');

  const readResult = await readFileTool.handler(
    { file_path: additionalFile },
    multiRootConfig,
  );

  assert(readResult.isError !== true, 'read_file should read absolute paths in additional roots');
  assertIncludes(
    getResultText(readResult),
    `--- ${additionalFile} ---`,
    'Additional root read_file display should stay absolute',
  );
  assertIncludes(
    getResultText(readResult),
    'export const outside = true;',
    'Additional root read_file should include file content',
  );

  const relativeEscapeResult = await readFileTool.handler(
    { file_path: path.join('..', 'path-safety-outside', 'outside.ts') },
    multiRootConfig,
  );

  assert(
    relativeEscapeResult.isError === true,
    'Relative paths must not escape primary root into an additional root',
  );
  assertIncludes(
    getResultText(relativeEscapeResult),
    'outside the allowed workspace',
    'Relative escape into additional root should explain boundary rejection',
  );
}

async function testWriteAndReplaceUseAdditionalMatchedRoot(): Promise<void> {
  const multiRootConfig = createMultiRootConfig();
  const writeTarget = path.join(OUTSIDE_DIR, 'written-from-tool.txt');
  const writeResult = await writeFileTool.handler(
    { file_path: writeTarget, content: 'alpha\nbeta' },
    multiRootConfig,
  );

  assert(writeResult.isError !== true, 'write_file should write absolute paths in additional roots');
  assertIncludes(
    getResultText(writeResult),
    `Success: wrote ${writeTarget}.`,
    'Additional root write_file display should stay absolute',
  );
  assertEqual(
    await fs.readFile(writeTarget, 'utf-8'),
    'alpha\nbeta',
    'write_file should write into the additional root target',
  );

  const replaceTarget = path.join(OUTSIDE_DIR, 'replace-from-tool.ts');
  await fs.writeFile(replaceTarget, 'export const flag = true;\n', 'utf-8');
  const replaceResult = await replaceTool.handler(
    {
      file_path: replaceTarget,
      target: 'true',
      replacement: 'false',
    },
    multiRootConfig,
  );

  assert(replaceResult.isError !== true, 'replace_text should modify absolute paths in additional roots');
  assertEqual(
    await fs.readFile(replaceTarget, 'utf-8'),
    'export const flag = false;\n',
    'replace_text should write back to the additional root target',
  );
}

async function testReadManyFilesAdditionalRootGlobAndExcludeSemantics(): Promise<void> {
  const multiRootConfig = createMultiRootConfig();
  const visiblePath = path.join(OUTSIDE_DIR, 'docs', 'visible.txt');
  const excludedPath = path.join(OUTSIDE_DIR, 'node_modules', 'excluded.txt');

  const literalResult = await readManyFilesTool.handler(
    { include: [excludedPath] },
    multiRootConfig,
  );

  assert(
    literalResult.isError !== true,
    'Drive-absolute literal paths in additional roots should bypass excludes',
  );
  assertIncludes(
    getResultText(literalResult),
    'excluded additional text',
    'Drive-absolute literal should read even when default excludes match',
  );

  const globResult = await readManyFilesTool.handler(
    { include: [path.join(OUTSIDE_DIR, '**', '*.txt')] },
    multiRootConfig,
  );

  assert(
    globResult.isError !== true,
    'Drive-absolute glob in additional roots should expand from its matched root',
  );
  const text = getResultText(globResult);
  assertIncludes(text, `--- ${visiblePath} ---`, 'Additional root glob should display absolute file paths');
  assertIncludes(text, 'visible additional text', 'Additional root glob should include non-excluded files');
  assertNotIncludes(text, 'excluded additional text', 'Additional root glob should honor default excludes');
  assertNotIncludes(text, 'node_modules', 'Additional root glob should not list excluded node_modules files');
}

async function testPrimarySymlinkToAdditionalRootStillFailsMatchedRootCheck(): Promise<void> {
  const linkPath = path.join(FIXTURES_DIR, 'link-to-additional');
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
      symlinkResults.push(`primary to additional symlink skipped: ${error.message}`);
      return;
    }

    const result = await readFileTool.handler(
      { file_path: path.join('link-to-additional', 'outside.ts') },
      createMultiRootConfig(),
    );

    assert(
      result.isError === true,
      'Relative access through a primary-root symlink to an additional root should fail',
    );
    assertIncludes(
      getResultText(result),
      'outside the allowed workspace',
      'Matched-root realpath check should reject primary -> additional symlink reads',
    );
    symlinkResults.push('primary to additional symlink: ran');
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function testAdditionalSymlinkToPrimaryRootStillFailsMatchedRootCheck(): Promise<void> {
  const linkPath = path.join(OUTSIDE_DIR, 'link-to-primary');
  await removeLinkIfExists(linkPath);

  try {
    try {
      await fs.symlink(
        FIXTURES_DIR,
        linkPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      symlinkResults.push(`additional to primary symlink skipped: ${error.message}`);
      return;
    }

    const result = await readFileTool.handler(
      { file_path: path.join(linkPath, 'src', 'Foo.ts') },
      createMultiRootConfig(),
    );

    assert(
      result.isError === true,
      'Absolute access through an additional-root symlink to primary should fail',
    );
    assertIncludes(
      getResultText(result),
      'outside the allowed workspace',
      'Matched-root realpath check should reject additional -> primary symlink reads',
    );
    symlinkResults.push('additional to primary symlink: ran');
  } finally {
    await removeLinkIfExists(linkPath);
  }
}

async function testAdditionalWriteParentSymlinkToPrimaryRootFailsMatchedRootCheck(): Promise<void> {
  const linkPath = path.join(OUTSIDE_DIR, 'write-link-to-primary');
  const primaryEscapedPath = path.join(FIXTURES_DIR, 'escaped-from-additional.txt');
  await removeLinkIfExists(linkPath);
  await fs.rm(primaryEscapedPath, { force: true });

  try {
    try {
      await fs.symlink(
        FIXTURES_DIR,
        linkPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      symlinkResults.push(`additional write parent symlink skipped: ${error.message}`);
      return;
    }

    const result = await writeFileTool.handler(
      {
        file_path: path.join(linkPath, 'escaped-from-additional.txt'),
        content: 'nope',
      },
      createMultiRootConfig(),
    );

    assert(
      result.isError === true,
      'write_file should reject additional-root parent symlinks that resolve into primary',
    );
    assertIncludes(
      getResultText(result),
      'resolves outside the allowed workspace',
      'Matched-root realpath check should reject additional -> primary symlink writes',
    );

    try {
      await fs.stat(primaryEscapedPath);
      assert(false, 'write_file must not write through an additional-root symlink into primary');
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') throw error;
    }
    symlinkResults.push('additional write parent symlink: ran');
  } finally {
    await removeLinkIfExists(linkPath);
    await fs.rm(primaryEscapedPath, { force: true });
  }
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

async function testRelativeLiteralPathHonorsCaseInsensitiveExcludesOnWindows(): Promise<void> {
  if (process.platform !== 'win32') return;

  const defaultResult = await readManyFilesTool.handler(
    { include: ['.ENV'] },
    testConfig,
  );

  assert(defaultResult.isError === true, 'Uppercase .ENV should be excluded by default on Windows');
  assertIncludes(getResultText(defaultResult), 'excluded by exclude patterns', 'Uppercase default exclude should be reported');
  assertNotIncludes(getResultText(defaultResult), 'SECRET=uppercase', 'Uppercase .ENV content must not be read');

  const customResult = await readManyFilesTool.handler(
    { include: ['src/Foo.ts'], exclude: ['SRC/*.TS'], useDefaultExcludes: false },
    testConfig,
  );

  assert(customResult.isError === true, 'Case-different custom exclude should filter a relative literal on Windows');
  assertIncludes(getResultText(customResult), 'excluded by exclude patterns', 'Case-different custom exclude should be reported');
  assertNotIncludes(getResultText(customResult), 'export const foo = 1;', 'Case-excluded content must not be read');
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
      { name: 'Single-root wrappers attach primary matched root metadata', run: testSingleRootWrappersAttachPrimaryMatchedRoot },
      { name: 'Context API matches additional root only for absolute input', run: testContextMatchesAdditionalRootOnlyForAbsoluteInput },
      { name: 'File tools access additional root only with absolute paths', run: testFileToolsAccessAdditionalRootOnlyWithAbsolutePaths },
      { name: 'write_file and replace_text use additional matched root', run: testWriteAndReplaceUseAdditionalMatchedRoot },
      { name: 'read_many_files handles additional root glob and exclude semantics', run: testReadManyFilesAdditionalRootGlobAndExcludeSemantics },
      { name: 'Primary symlink to additional root still fails matched-root check', run: testPrimarySymlinkToAdditionalRootStillFailsMatchedRootCheck },
      { name: 'Additional symlink to primary root still fails matched-root check', run: testAdditionalSymlinkToPrimaryRootStillFailsMatchedRootCheck },
      { name: 'Additional write parent symlink to primary root fails matched-root check', run: testAdditionalWriteParentSymlinkToPrimaryRootFailsMatchedRootCheck },
      { name: 'Reject unsupported path shapes before resolve', run: testRejectsUnsupportedPathShapes },
      { name: 'Reject prefix-sibling path outside root', run: testPrefixSiblingIsOutsideRoot },
      { name: 'Drive-absolute glob validates static base and preserves display kind', run: testDriveAbsoluteGlobStaticBaseAndDisplay },
      { name: 'Slash-leading glob is relative while plain rooted path fails', run: testSlashLeadingGlobIsRelativeButPlainRootedPathFails },
      { name: 'Glob static base outside root fails before reading', run: testGlobStaticBaseOutsideRootFailsBeforeReading },
      { name: 'Brace-expanded parent traversal fails before glob', run: testBraceExpandedParentTraversalFailsBeforeGlob },
      { name: 'Long brace-expanded parent traversal fails closed', run: testLongBraceExpandedParentTraversalFailsClosed },
      { name: 'Extglob-only pattern is expanded', run: testExtglobOnlyPatternIsExpanded },
      { name: 'Relative literal path honors default excludes', run: testRelativeLiteralPathHonorsDefaultExcludes },
      { name: 'Relative literal path honors case-insensitive excludes on Windows', run: testRelativeLiteralPathHonorsCaseInsensitiveExcludesOnWindows },
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
