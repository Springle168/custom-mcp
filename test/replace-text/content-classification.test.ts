import * as fs from 'node:fs/promises';
import { classifyFileContent } from '../../src/engine/file-content.js';
import { createReplaceTextHandler } from '../../src/tools/built-in/files/replace.js';
import { createFileAccessPolicyContext } from '../../src/utils/file-access-policy.js';
import { recognizedBinary, supportedImages, unsupportedImage } from '../file-content/fixtures.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import { assertEqual, assertIncludes, assertNotIncludes, runTestSuite } from '../test-utils.js';
import {
  assertErrorResult,
  assertSuccessResult,
  createReplaceTextFixtureHarness,
  parseResultJson,
  singleReplaceBatch,
} from './helpers.js';

const {
  assertFixtureContent,
  assertFixtureMissing,
  callReplace,
  callReplaceBatch,
  callWithHandler,
  cleanupFixtures,
  createTestToolContext,
  fixturePath,
  makeFixtureDir,
  resetFixtures,
  writeFixture,
} = createReplaceTextFixtureHarness('content-classification');

async function testTextIgnoresExtensionsAndPreservesRepresentation(): Promise<void> {
  await resetFixtures();
  const before = '\uFEFFalpha 中文😀\r\nbeta\r\n';
  for (const filePath of [
    'text.png',
    'text.bin',
    'source.ts',
    'source.mts',
    'source.cts',
    'plain',
  ]) {
    await writeFixture(filePath, before);
    const json = assertSuccessResult(
      await callReplace({ file_path: filePath, target: 'alpha', replacement: 'changed' }),
    );
    assertEqual(json.file_line_count.previous, 3, `${filePath}: normalized line count`);
    await assertFixtureContent(
      filePath,
      before.replace('alpha', 'changed'),
      `${filePath}: BOM, Unicode, and CRLF should survive`,
    );
  }
}

async function testMissingAnyExtensionCreatesWithoutClassification(): Promise<void> {
  await resetFixtures();
  let classifications = 0;
  const handler = createReplaceTextHandler({
    classifyFileContent: async () => {
      classifications++;
      throw new Error('Missing files have no content to classify');
    },
  });
  for (const filePath of ['new.png', 'nested/new.bin']) {
    const json = assertSuccessResult(
      await callWithHandler(
        handler,
        singleReplaceBatch({ file_path: filePath, target: '', replacement: 'created\0content' }),
      ),
    );
    assertEqual(json.file_line_count.previous, 0, 'Missing target should have zero previous lines');
    await assertFixtureContent(filePath, 'created\0content', 'Creation must not classify output');
  }
  assertEqual(classifications, 0, 'No classification should occur when creating missing targets');

  const missing = assertErrorResult(
    await callReplace({ file_path: 'missing.png', target: 'content', replacement: 'new' }),
  );
  assertEqual(missing.file_line_count.current, 0, 'Nonempty target still cannot create');
  await assertFixtureMissing('missing.png', 'Creation conditions must not be relaxed');
}

async function testKnownTextExtensionsDoNotBypassFullByteChecks(): Promise<void> {
  await resetFixtures();
  const prefix = Buffer.alloc(5000, 0x61);
  const cases = [
    { name: 'late-nul.txt', bytes: Buffer.concat([prefix, Buffer.from([0])]) },
    { name: 'late-invalid.ts', bytes: Buffer.concat([prefix, Buffer.from([0xc3, 0x28])]) },
    { name: 'controls.mts', bytes: Buffer.from([1, 1, 1, 1, 97, 98, 99, 100, 101, 102]) },
    { name: 'recognized.cts', bytes: recognizedBinary },
  ];
  for (const { name, bytes } of cases) {
    await writeFixture(name, bytes);
    const json = assertErrorResult(
      await callReplace({ file_path: name, target: 'a', replacement: 'changed' }),
    );
    assertEqual(json.file_line_count.previous, null, `${name}: non-text is not decoded`);
    assertIncludes(json.note, 'non-text', `${name}: content should deny modification`);
    assertEqual(
      Buffer.compare(await fs.readFile(fixturePath(name)), bytes),
      0,
      `${name}: rejected content must be unchanged`,
    );
  }
}

async function testImagesAndOtherNonTextAreRejectedRegardlessOfSuffix(): Promise<void> {
  await resetFixtures();
  const cases = [
    ...supportedImages.map(({ format, bytes }) => ({
      name: `${format}.txt`,
      bytes,
      kind: 'image',
    })),
    { name: 'unsupported.ts', bytes: unsupportedImage, kind: 'other' },
    { name: 'recognized', bytes: recognizedBinary, kind: 'other' },
    { name: 'unknown.txt', bytes: Buffer.from([97, 0, 98]), kind: 'unknown' },
  ];
  for (const { name, bytes, kind } of cases) {
    await writeFixture(name, bytes);
    const json = assertErrorResult(
      await callReplace({ file_path: name, target: '', replacement: 'must not overwrite' }),
    );
    assertIncludes(json.note, `content type: ${kind}`, 'Reject non-text before matching');
    assertEqual(json.file_line_count.previous, null, 'Non-text must not produce text line counts');
    assertEqual(
      Buffer.compare(await fs.readFile(fixturePath(name)), bytes),
      0,
      `${name}: rejected content must remain byte-for-byte unchanged`,
    );
  }
}

async function testClassificationErrorsNeverImplyMissingOrExposeRealPaths(): Promise<void> {
  await resetFixtures();
  await writeFixture('existing.png', 'alpha');
  const hiddenPath = fixturePath('private-real-target.txt');
  for (const code of ['ENOENT', 'EACCES']) {
    let classifications = 0;
    const handler = createReplaceTextHandler({
      classifyFileContent: async () => {
        classifications++;
        throw Object.assign(new Error(`Detector failed at ${hiddenPath}`), { code });
      },
    });
    const result = await callWithHandler(handler, {
      files: [
        {
          file_path: 'existing.png',
          replacements: [
            { target: '', replacement: 'must not create' },
            { target: 'alpha', replacement: 'must not overwrite' },
          ],
        },
        {
          file_path: `later-${code}.png`,
          replacements: [{ target: '', replacement: 'later file still runs' }],
        },
      ],
    });
    const batch = parseResultJson(result);
    for (const replacement of batch.files[0]!.replacements) {
      assertEqual(replacement.success, false, `${code}: classifier failure must fail the item`);
      assertEqual(replacement.file_line_count.previous, null, `${code}: existence is not missing`);
      assertEqual(replacement.file_line_count.current, null, `${code}: current state is unknown`);
      assertIncludes(replacement.note, 'classification failed', 'Failure should be actionable');
      assertNotIncludes(replacement.note, hiddenPath, 'Detector details must not leak real paths');
    }
    assertEqual(classifications, 2, 'Every replacement must independently classify existing bytes');
    assertEqual(batch.files[1]?.success, true, 'Later missing file should still be created');
    await assertFixtureContent('existing.png', 'alpha', 'Classification error must prevent writes');
  }
}

async function testClassificationAndDecodeUseTheSameBytes(): Promise<void> {
  await resetFixtures();
  await writeFixture('snapshot.txt', 'alpha\r\nbeta');
  let classifications = 0;
  const handler = createReplaceTextHandler({
    classifyFileContent: async (bytes) => {
      classifications++;
      assertEqual(
        Buffer.from(bytes).toString('utf-8'),
        'alpha\r\nbeta',
        'Read complete bytes once',
      );
      await fs.writeFile(fixturePath('snapshot.txt'), 'external-change', 'utf-8');
      return classifyFileContent(bytes);
    },
  });
  assertSuccessResult(
    await callWithHandler(
      handler,
      singleReplaceBatch({ file_path: 'snapshot.txt', target: 'alpha', replacement: 'changed' }),
    ),
  );
  assertEqual(classifications, 1, 'A replacement should classify one complete byte buffer');
  await assertFixtureContent(
    'snapshot.txt',
    'changed\r\nbeta',
    'Decode and line-ending detection must use classified bytes, not a second read',
  );
}

async function testWrittenNonTextRemainsSuccessfulButLaterReadsReject(): Promise<void> {
  await resetFixtures();
  for (const create of [true, false]) {
    const filePath = create ? 'created.txt' : 'existing.ts';
    if (!create) await writeFixture(filePath, 'alpha');
    const result = await callReplaceBatch({
      files: [
        {
          file_path: filePath,
          replacements: [
            { target: create ? '' : 'alpha', replacement: 'a\0b' },
            { target: 'a', replacement: 'must not replace' },
          ],
        },
      ],
    });
    const replacements = parseResultJson(result).files[0]!.replacements;
    assertEqual(replacements[0]?.success, true, 'Writing NUL must remain a successful operation');
    assertEqual(replacements[1]?.success, false, 'The next replacement must reject fresh non-text');
    assertEqual(replacements[1]?.file_line_count.current, null, 'Non-text line count is unknown');
    await assertFixtureContent(filePath, 'a\0b', 'Earlier success must not be rolled back');

    assertErrorResult(
      await callReplace({ file_path: filePath, target: 'a', replacement: 'later' }),
    );
    await assertFixtureContent(filePath, 'a\0b', 'A later call must also refuse non-text output');
  }
}

async function testWriteFailureWithNonTextDiskStateHasUnknownRecovery(): Promise<void> {
  await resetFixtures();
  for (const create of [true, false]) {
    const filePath = create ? 'failed-create.png' : 'failed-existing.ts';
    if (!create) await writeFixture(filePath, 'old\n');
    let writes = 0;
    const handler = createReplaceTextHandler({
      writeTextContent: async (resolved) => {
        writes++;
        await fs.writeFile(resolved, 'partial\0disk\nstate', 'utf-8');
        return 'Injected failure after writing non-text.';
      },
    });
    const result = await callWithHandler(handler, {
      files: [
        {
          file_path: filePath,
          replacements: [
            { target: create ? '' : 'old', replacement: 'new\ncontent' },
            { target: 'partial', replacement: 'must not use cached text' },
          ],
        },
      ],
    });
    const [first, second] = parseResultJson(result).files[0]!.replacements;
    assertEqual(first?.success, false, 'Write failure must stay failed');
    assertEqual(first?.replacement_count, 0, 'Unconfirmed write has zero committed replacements');
    assertEqual(first?.file_line_count.previous, create ? 0 : 2, 'Retain known previous lines');
    assertEqual(first?.file_line_count.current, null, 'Non-text recovery must report unknown');
    assertEqual(second?.success, false, 'Next replacement must independently reject disk content');
    assertIncludes(second?.note, 'non-text', 'Next replacement must classify fresh bytes');
    assertEqual(writes, 1, 'No later write may overwrite non-text from a failed write');
    await assertFixtureContent(filePath, 'partial\0disk\nstate', 'Failure state must be preserved');
  }
}

async function testRecoveryClassificationErrorsAreUnknownEvenWithEnoent(): Promise<void> {
  await resetFixtures();
  for (const create of [true, false]) {
    const filePath = create ? 'recovery-create.bin' : 'recovery-existing.txt';
    if (!create) await writeFixture(filePath, 'old');
    let classifications = 0;
    let writes = 0;
    const handler = createReplaceTextHandler({
      classifyFileContent: async (bytes) => {
        classifications++;
        if (classifications === (create ? 1 : 2)) {
          throw Object.assign(new Error(`Private detector detail ${fixturePath('hidden')}`), {
            code: 'ENOENT',
          });
        }
        return classifyFileContent(bytes);
      },
      writeTextContent: async (resolved, content) => {
        writes++;
        await fs.writeFile(resolved, content, 'utf-8');
        return writes === 1 ? 'Injected write failure.' : null;
      },
    });
    const result = await callWithHandler(handler, {
      files: [
        {
          file_path: filePath,
          replacements: [
            { target: create ? '' : 'old', replacement: 'written' },
            { target: 'written', replacement: 'verified' },
          ],
        },
      ],
    });
    const [first, second] = parseResultJson(result).files[0]!.replacements;
    assertEqual(first?.success, false, 'Recovery cannot upgrade the failed write');
    assertEqual(first?.replacement_count, 0, 'Failed write count must remain zero');
    assertEqual(first?.file_line_count.current, null, 'Detector ENOENT is not confirmed absence');
    assertEqual(
      second?.success,
      true,
      'Later replacement must classify again after recovery error',
    );
    assertEqual(
      classifications,
      create ? 2 : 3,
      'Initial, recovery, and later reads are independent',
    );
    await assertFixtureContent(filePath, 'verified', 'Later item should use actual on-disk text');
  }
}

async function testConfirmedMissingRecoveryReportsZero(): Promise<void> {
  await resetFixtures();
  await writeFixture('removed.txt', 'old');
  let classifications = 0;
  const handler = createReplaceTextHandler({
    classifyFileContent: async (bytes) => {
      classifications++;
      return classifyFileContent(bytes);
    },
    writeTextContent: async (resolved) => {
      await fs.unlink(resolved);
      return 'Injected write failure after deletion.';
    },
  });
  const json = assertErrorResult(
    await callWithHandler(
      handler,
      singleReplaceBatch({ file_path: 'removed.txt', target: 'old', replacement: 'new' }),
    ),
  );
  assertEqual(json.file_line_count.current, 0, 'Filesystem-confirmed absence reports zero lines');
  assertEqual(classifications, 1, 'Recovery must not classify missing content');
}

async function testSafetyAndSizeChecksPrecedeClassification(): Promise<void> {
  await resetFixtures();
  await writeFixture('blocked.txt', 'private');
  await writeFixture('large.txt', Buffer.alloc(20 * 1024 * 1024 + 1, 0x61));
  const base = createTestToolContext();
  const root = base.pathSafetyContext.primaryRoot;
  const context = {
    ...base,
    fileAccessPolicyContext: createFileAccessPolicyContext(base.pathSafetyContext, [
      {
        rootDir: root.rootDir,
        realRootDir: root.realRootDir ?? root.rootDir,
        ignore: { isIgnored: () => false },
        deny: { isIgnored: (candidate) => candidate === 'blocked.txt' },
      },
    ]),
  };
  let classifications = 0;
  const handler = createReplaceTextHandler({
    classifyFileContent: async () => {
      classifications++;
      throw new Error('Unsafe or oversized paths must never be classified');
    },
  });
  for (const filePath of ['../outside.txt', 'blocked.txt', 'large.txt']) {
    assertErrorResult(
      await callWithHandler(
        handler,
        singleReplaceBatch({ file_path: filePath, target: 'a', replacement: 'b' }),
        context,
      ),
    );
  }

  const workspace = await makeFixtureDir('workspace');
  const outside = await makeFixtureDir('outside');
  await fs.writeFile(fixturePath('outside', 'secret.txt'), 'secret', 'utf-8');
  await fs.symlink(
    outside,
    fixturePath('workspace', 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  assertErrorResult(
    await callWithHandler(
      handler,
      singleReplaceBatch({ file_path: 'link/secret.txt', target: 'secret', replacement: 'leaked' }),
      createTestToolRuntimeContext({ rootDir: workspace }),
    ),
  );
  assertEqual(
    classifications,
    0,
    'Unsafe and oversized targets must fail before content detection',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text content classification tests',
    details:
      'Covers byte-based admission, creation, detector errors, recovery, and safety ordering.',
    afterAll: cleanupFixtures,
    tests: [
      {
        name: 'Text ignores suffixes and preserves BOM, Unicode, and CRLF',
        run: testTextIgnoresExtensionsAndPreservesRepresentation,
      },
      {
        name: 'Missing arbitrary suffixes create without classification',
        run: testMissingAnyExtensionCreatesWithoutClassification,
      },
      {
        name: 'Known text suffixes cannot bypass full byte checks',
        run: testKnownTextExtensionsDoNotBypassFullByteChecks,
      },
      {
        name: 'Images and other non-text are rejected regardless of suffix',
        run: testImagesAndOtherNonTextAreRejectedRegardlessOfSuffix,
      },
      {
        name: 'Classifier errors never imply absence or expose real paths',
        run: testClassificationErrorsNeverImplyMissingOrExposeRealPaths,
      },
      {
        name: 'Classification and decoding use the same complete bytes',
        run: testClassificationAndDecodeUseTheSameBytes,
      },
      {
        name: 'Written non-text succeeds but later replacements and calls refuse it',
        run: testWrittenNonTextRemainsSuccessfulButLaterReadsReject,
      },
      {
        name: 'Failed writes leaving non-text have unknown recovery state',
        run: testWriteFailureWithNonTextDiskStateHasUnknownRecovery,
      },
      {
        name: 'Recovery classification ENOENT is unknown and later items retry',
        run: testRecoveryClassificationErrorsAreUnknownEvenWithEnoent,
      },
      {
        name: 'Filesystem-confirmed missing recovery reports zero',
        run: testConfirmedMissingRecoveryReportsZero,
      },
      {
        name: 'Path safety and size checks precede classification',
        run: testSafetyAndSizeChecksPrecedeClassification,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
