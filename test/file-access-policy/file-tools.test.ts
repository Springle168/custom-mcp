import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';
import readFileTool from '../../src/tools/read-file.js';
import readManyFilesTool from '../../src/tools/read-many-files.js';
import replaceTool from '../../src/tools/replace.js';
import writeFileTool from '../../src/tools/write-file.js';
import {
  createFileAccessPolicyContext,
  createPolicyCandidate,
  type FileAccessPolicyQuery,
  type RootFileAccessPolicy,
} from '../../src/utils/file-access-policy.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  assertNotIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(
  __dirname,
  '..',
  'fixtures',
  'file-access-policy-tools',
);

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await Promise.all([
    fs.mkdir(path.join(FIXTURES_DIR, 'allowed'), { recursive: true }),
    fs.mkdir(path.join(FIXTURES_DIR, 'allowed', 'sub'), { recursive: true }),
    fs.mkdir(path.join(FIXTURES_DIR, 'ignored'), { recursive: true }),
    fs.mkdir(path.join(FIXTURES_DIR, 'denied'), { recursive: true }),
    fs.mkdir(path.join(FIXTURES_DIR, 'node_modules'), { recursive: true }),
    fs.mkdir(path.join(FIXTURES_DIR, '..cache'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(FIXTURES_DIR, 'allowed', 'visible.txt'), 'visible', 'utf-8'),
    fs.writeFile(path.join(FIXTURES_DIR, 'allowed', 'sub', 'nested.txt'), 'nested-visible', 'utf-8'),
    fs.writeFile(path.join(FIXTURES_DIR, 'ignored', 'soft.txt'), 'soft', 'utf-8'),
    fs.writeFile(path.join(FIXTURES_DIR, 'denied', 'secret.txt'), 'secret-value', 'utf-8'),
    fs.writeFile(path.join(FIXTURES_DIR, 'node_modules', 'dependency.txt'), 'dependency', 'utf-8'),
    fs.writeFile(path.join(FIXTURES_DIR, '..cache', 'valid.txt'), 'valid-dot-prefix', 'utf-8'),
  ]);
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

function query(patterns: readonly string[]): FileAccessPolicyQuery {
  const matcher = ignore({ ignorecase: process.platform === 'win32' });
  matcher.add([...patterns]);
  return Object.freeze({
    isIgnored: (candidate: string) => matcher.ignores(candidate),
  });
}

function createContext(options: {
  readonly ignore?: readonly string[];
  readonly deny?: readonly string[];
} = {}) {
  const base = createTestToolRuntimeContext({ rootDir: FIXTURES_DIR });
  const root = base.pathSafetyContext.primaryRoot;
  const policy: RootFileAccessPolicy = {
    rootDir: root.rootDir,
    realRootDir: root.realRootDir ?? root.rootDir,
    ignore: query(options.ignore ?? []),
    deny: query(options.deny ?? []),
  };
  return {
    ...base,
    fileAccessPolicyContext: createFileAccessPolicyContext(
      base.pathSafetyContext,
      [policy],
    ),
  };
}

async function testPolicyCandidateShape(): Promise<void> {
  assertEqual(
    createPolicyCandidate(
      path.join(FIXTURES_DIR, 'allowed', 'visible.txt'),
      FIXTURES_DIR,
      'file',
    ),
    'allowed/visible.txt',
    'File candidates should be root-relative and slash-separated',
  );
  assertEqual(
    createPolicyCandidate(
      path.join(FIXTURES_DIR, 'allowed'),
      FIXTURES_DIR,
      'directory',
    ),
    'allowed/',
    'Directory candidates should preserve one trailing slash',
  );
  assertEqual(
    createPolicyCandidate(FIXTURES_DIR, FIXTURES_DIR, 'directory'),
    null,
    'The root itself should not produce a policy candidate',
  );
}

async function testDotDotPrefixedDirectoryRemainsInsideRoot(): Promise<void> {
  const readResult = await readFileTool.handler(
    { file_path: '..cache/valid.txt' },
    createContext(), createTestToolInvocationContext(),
  );
  assert(readResult.isError !== true, 'A ..-prefixed name is not parent traversal');
  assertIncludes(
    getResultText(readResult),
    'valid-dot-prefix',
    'A valid in-root ..-prefixed directory should be readable',
  );

  const writeResult = await writeFileTool.handler(
    { file_path: '..cache/new.txt', content: 'created' },
    createContext(), createTestToolInvocationContext(),
  );
  assert(writeResult.isError !== true, 'A future target under a ..-prefixed name should be writable');
}

async function testLiteralReadDenyAndIgnoreBypass(): Promise<void> {
  const denied = await readFileTool.handler(
    { file_path: 'denied/secret.txt' },
    createContext({ deny: ['denied/**'] }), createTestToolInvocationContext(),
  );
  assert(denied.isError === true, 'Explicit denied reads should fail');
  const deniedText = getResultText(denied);
  assertIncludes(deniedText, 'file access deny policy', 'Deny should be explicit');
  assertNotIncludes(deniedText, 'secret-value', 'Denied content must not be returned');

  const ignoredLiteral = await readManyFilesTool.handler(
    {
      include: ['ignored/soft.txt'],
      exclude: ['ignored/**'],
      use_ignore_files: true,
    },
    createContext({ ignore: ['ignored/**'] }), createTestToolInvocationContext(),
  );
  assert(ignoredLiteral.isError !== true, 'Literal paths should bypass soft filters');
  assertIncludes(getResultText(ignoredLiteral), 'soft', 'Literal content should be returned');
}

async function testRealpathDenyCannotBeBypassedBySymlink(): Promise<void> {
  const aliasPath = path.join(FIXTURES_DIR, 'alias-dir');
  await fs.symlink(
    path.join(FIXTURES_DIR, 'denied'),
    aliasPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const result = await readFileTool.handler(
    { file_path: 'alias-dir/secret.txt' },
    createContext({ deny: ['denied/**'] }), createTestToolInvocationContext(),
  );
  assert(result.isError === true, 'Realpath deny should reject a lexical alias');
  const text = getResultText(result);
  assertIncludes(text, 'file access deny policy', 'Realpath deny should be explicit');
  assertNotIncludes(text, 'denied\\secret.txt', 'The implicit real target must not be disclosed');
  assertNotIncludes(text, 'secret-value', 'The denied target content must not be returned');
}

async function testGlobIgnoreToggleAndNoBuiltInDefaults(): Promise<void> {
  const filtered = await readManyFilesTool.handler(
    { include: ['**/*.txt'], use_ignore_files: true },
    createContext({ ignore: ['ignored/**'] }), createTestToolInvocationContext(),
  );
  const filteredText = getResultText(filtered);
  assertNotIncludes(filteredText, 'ignored\\soft.txt', 'Configured ignore should filter glob results');
  assertIncludes(filteredText, 'node_modules', 'There should be no hard-coded default ignore patterns');
  assertIncludes(
    filteredText,
    'NOTE: Some glob-discovered paths were filtered by configured ignoreFiles rules.',
    'Mixed results should disclose configured ignore filtering',
  );

  const unfiltered = await readManyFilesTool.handler(
    { include: ['**/*.txt'], use_ignore_files: false },
    createContext({ ignore: ['ignored/**'] }), createTestToolInvocationContext(),
  );
  const unfilteredText = getResultText(unfiltered);
  assertIncludes(
    unfilteredText,
    'ignored\\soft.txt',
    'use_ignore_files=false should disable only the ignore matcher',
  );
  assertNotIncludes(
    unfilteredText,
    'filtered by configured ignoreFiles rules',
    'Disabled ignore filtering should not emit the ignore note',
  );

  const excluded = await readManyFilesTool.handler(
    {
      include: ['**/*.txt'],
      exclude: ['ignored/**'],
      use_ignore_files: false,
    },
    createContext({ ignore: ['ignored/**'] }), createTestToolInvocationContext(),
  );
  assertNotIncludes(
    getResultText(excluded),
    'filtered by configured ignoreFiles rules',
    'Per-call excludes should not emit the ignore note',
  );

  const onlyIgnored = await readManyFilesTool.handler(
    { include: ['ignored/**/*.txt'], use_ignore_files: true },
    createContext({ ignore: ['ignored/**'] }), createTestToolInvocationContext(),
  );
  assert(onlyIgnored.isError === true, 'An all-ignored glob should use the normal error');
  const onlyIgnoredText = getResultText(onlyIgnored);
  assertIncludes(onlyIgnoredText, 'No files matched', 'All-ignored results should remain generic');
  assertNotIncludes(
    onlyIgnoredText,
    'filtered by configured ignoreFiles rules',
    'An all-ignored glob should not emit the ignore note',
  );
}

async function testGlobDenyMixedResultPrivacy(): Promise<void> {
  const result = await readManyFilesTool.handler(
    { include: ['**/*.txt'], use_ignore_files: false },
    createContext({ deny: ['denied/'] }), createTestToolInvocationContext(),
  );
  assert(result.isError !== true, 'Allowed glob results should still be returned');
  const text = getResultText(result);
  assertIncludes(
    text,
    'NOTE: Some paths were blocked by the file access deny policy.',
    'Mixed results should contain the fixed disclosure',
  );
  assertNotIncludes(text, 'secret.txt', 'Denied paths must not be disclosed');
  assertNotIncludes(text, 'secret-value', 'Denied contents must not be disclosed');
}

async function testGlobDenyZeroResultAndStaticBasePrivacy(): Promise<void> {
  const context = createContext({ deny: ['denied/'] });
  const automaticOnly = await readManyFilesTool.handler(
    { include: ['**/secret.txt'] },
    context, createTestToolInvocationContext(),
  );
  assert(automaticOnly.isError === true, 'A zero-result glob should use the normal error');
  assertIncludes(getResultText(automaticOnly), 'No files matched', 'Zero result should remain generic');
  assertNotIncludes(
    getResultText(automaticOnly),
    'blocked by the file access deny policy',
    'A zero-result glob should not disclose automatic deny state',
  );

  const staticBase = await readManyFilesTool.handler(
    { include: ['denied/**/*.txt'] },
    context, createTestToolInvocationContext(),
  );
  assert(staticBase.isError === true, 'An explicitly denied static base should fail');
  assertIncludes(
    getResultText(staticBase),
    'file access deny policy',
    'Static base deny should be reported as an explicit access error',
  );
  assertIncludes(
    getResultText(staticBase),
    'denied/**/*.txt',
    'An explicit static base error may echo the caller input',
  );
}

async function testGlobDoesNotFollowDiscoveredDirectoryLinks(): Promise<void> {
  const aliasPath = path.join(FIXTURES_DIR, 'alias-discovered');
  await fs.symlink(
    path.join(FIXTURES_DIR, 'allowed'),
    aliasPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const result = await readManyFilesTool.handler(
    { include: ['alias-*/visible.txt'] },
    createContext(), createTestToolInvocationContext(),
  );
  assert(result.isError === true, 'A wildcard-discovered directory link should be pruned');
  assertIncludes(getResultText(result), 'No files matched', 'Pruned links should look like no match');
  assertNotIncludes(getResultText(result), 'visible', 'The linked file must not be discovered');
}

async function testGlobAllowsLinksInExplicitStaticBasePrefix(): Promise<void> {
  const aliasPath = path.join(FIXTURES_DIR, 'alias-explicit');
  await fs.symlink(
    path.join(FIXTURES_DIR, 'allowed'),
    aliasPath,
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const result = await readManyFilesTool.handler(
    { include: ['alias-explicit/sub/**/*.txt'] },
    createContext(), createTestToolInvocationContext(),
  );
  assert(result.isError !== true, 'A validated explicit static-base link should be traversable');
  assertIncludes(getResultText(result), 'nested-visible', 'The explicit static-base link should resolve files');
}

async function testDanglingWriteSymlinkIsRejected(): Promise<void> {
  if (process.platform === 'win32') return;
  const linkPath = path.join(FIXTURES_DIR, 'dangling.txt');
  await fs.symlink(path.join(FIXTURES_DIR, 'missing-target.txt'), linkPath, 'file');

  const result = await writeFileTool.handler(
    { file_path: 'dangling.txt', content: 'must-not-follow' },
    createContext(), createTestToolInvocationContext(),
  );
  assert(result.isError === true, 'A dangling write symlink should be rejected');
  assertIncludes(getResultText(result), 'symbolic link', 'The failure should identify the unsafe target type');
}

async function testWriteAndReplaceDenyFutureTargets(): Promise<void> {
  const context = createContext({ deny: ['denied/**'] });
  const writeResult = await writeFileTool.handler(
    { file_path: 'denied/new.txt', content: 'must-not-exist' },
    context, createTestToolInvocationContext(),
  );
  assert(writeResult.isError === true, 'Deny should cover future write targets');
  assertIncludes(getResultText(writeResult), 'file access deny policy', 'Write deny should be explicit');

  const replaceResult = await replaceTool.handler(
    {
      file_path: 'denied/replaced.txt',
      target: '',
      replacement: 'must-not-exist',
    },
    context, createTestToolInvocationContext(),
  );
  assert(replaceResult.isError === true, 'Deny should cover replace create mode');
  assertIncludes(getResultText(replaceResult), 'file access deny policy', 'Replace deny should be explicit');

  for (const fileName of ['new.txt', 'replaced.txt']) {
    try {
      await fs.stat(path.join(FIXTURES_DIR, 'denied', fileName));
      throw new Error(`Denied target ${fileName} was unexpectedly created.`);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      assertEqual(error.code, 'ENOENT', 'Denied target should not exist');
    }
  }
}

async function testDirectoryTypeDenyPrecedesDirectoryError(): Promise<void> {
  const result = await writeFileTool.handler(
    { file_path: 'denied', content: 'must-not-write' },
    createContext({ deny: ['denied/'] }), createTestToolInvocationContext(),
  );
  assert(result.isError === true, 'Writing a denied directory should fail');
  const text = getResultText(result);
  assertIncludes(text, 'file access deny policy', 'Directory candidate deny should win');
  assertNotIncludes(text, 'target path is a directory', 'Directory errors should follow deny checks');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing file access policy integration',
    beforeAll: resetFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'policy candidate shape', run: testPolicyCandidateShape },
      { name: '..-prefixed directory remains inside root', run: testDotDotPrefixedDirectoryRemainsInsideRoot },
      { name: 'literal deny and ignore/exclude bypass', run: testLiteralReadDenyAndIgnoreBypass },
      { name: 'realpath deny cannot be bypassed by symlink', run: testRealpathDenyCannotBeBypassedBySymlink },
      { name: 'glob ignore toggle and no built-in defaults', run: testGlobIgnoreToggleAndNoBuiltInDefaults },
      { name: 'glob deny mixed-result privacy', run: testGlobDenyMixedResultPrivacy },
      { name: 'glob deny zero-result and static-base privacy', run: testGlobDenyZeroResultAndStaticBasePrivacy },
      { name: 'glob does not follow discovered directory links', run: testGlobDoesNotFollowDiscoveredDirectoryLinks },
      { name: 'glob allows links in explicit static-base prefix', run: testGlobAllowsLinksInExplicitStaticBasePrefix },
      { name: 'dangling write symlink is rejected', run: testDanglingWriteSymlinkIsRejected },
      { name: 'write and replace deny future targets', run: testWriteAndReplaceDenyFutureTargets },
      { name: 'directory-type deny precedes directory error', run: testDirectoryTypeDenyPrecedesDirectoryError },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
