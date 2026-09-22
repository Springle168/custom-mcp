import * as fs from 'node:fs/promises';
import { createReplaceTextHandler } from '../../src/tools/replace.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';
import {
  createReplaceTextFixtureHarness,
  parseResultJson,
} from './helpers.js';

const {
  assertFixtureContent,
  callReplace,
  callReplaceBatch,
  callWithHandler,
  cleanupFixtures,
  fixturePath,
  resetFixtures,
  writeFixture,
} = createReplaceTextFixtureHarness('batch');

async function testSameFileEntryUsesWrittenStateAndKeepsPartialSuccess(): Promise<void> {
  await resetFixtures();
  await writeFixture('ordered.txt', 'alpha\n');
  const result = await callReplaceBatch({
    files: [{
      file_path: 'ordered.txt',
      replacements: [
        { target: 'alpha', replacement: 'beta' },
        { target: 'beta', replacement: 'gamma' },
        { target: 'missing', replacement: 'never' },
        { target: 'gamma', replacement: 'delta' },
      ],
    }],
  });

  assertEqual(result.isError, true, 'Any replacement failure should set isError');
  const batch = parseResultJson(result);
  assertEqual(batch.success, false, 'Batch should aggregate failure');
  assertEqual(batch.files[0]?.success, false, 'File should aggregate failure');
  assertEqual(batch.files[0]?.replacements.length, 4, 'All replacements should produce results');
  assertEqual(batch.files[0]?.replacements[0]?.success, true, 'First replacement should succeed');
  assertEqual(batch.files[0]?.replacements[1]?.success, true, 'Second should see first write');
  assertEqual(batch.files[0]?.replacements[2]?.success, false, 'Third should fail');
  assertEqual(batch.files[0]?.replacements[3]?.success, true, 'Fourth should continue after failure');
  await assertFixtureContent('ordered.txt', 'delta\n', 'Successful writes should remain applied');
}

async function testLaterFileAndRepeatedPathEntriesContinueInOrder(): Promise<void> {
  await resetFixtures();
  await writeFixture('staged.txt', 'value=1\n');
  await writeFixture('other.txt', 'before\n');
  const result = await callReplaceBatch({
    files: [
      {
        file_path: 'missing.txt',
        replacements: [{ target: 'x', replacement: 'y' }],
      },
      {
        file_path: 'staged.txt',
        replacements: [{ target: 'value=1', replacement: 'value=2' }],
      },
      {
        file_path: 'other.txt',
        replacements: [{ target: 'before', replacement: 'after' }],
      },
      {
        file_path: 'staged.txt',
        match_mode: 'regex',
        replacements: [{ target: 'value=(\\d+)', replacement: 'result=$!1' }],
      },
    ],
  });

  const batch = parseResultJson(result);
  assertEqual(batch.files.length, 4, 'File result length should match input');
  assertEqual(batch.files[0]?.success, false, 'First file should fail');
  assertEqual(batch.files[1]?.success, true, 'Second file should continue');
  assertEqual(batch.files[2]?.success, true, 'Third file should continue');
  assertEqual(batch.files[3]?.success, true, 'Repeated path regex stage should see prior state');
  await assertFixtureContent('staged.txt', 'result=2\n', 'Repeated path stages should run in order');
  await assertFixtureContent('other.txt', 'after\n', 'Later file should be modified');
}

async function testMissingFileCanFailThenCreateThenModify(): Promise<void> {
  await resetFixtures();
  const result = await callReplaceBatch({
    files: [{
      file_path: 'created.txt',
      replacements: [
        { target: 'absent', replacement: 'nope' },
        { target: '', replacement: 'created' },
        { target: 'created', replacement: 'finished' },
      ],
    }],
  });
  const batch = parseResultJson(result);
  assertEqual(batch.files[0]?.replacements[0]?.file_line_count.previous, 0, 'Missing file is zero lines');
  assertEqual(batch.files[0]?.replacements[1]?.success, true, 'Empty target should create after failure');
  assertEqual(batch.files[0]?.replacements[2]?.success, true, 'Later replacement should read created file');
  await assertFixtureContent('created.txt', 'finished', 'Create chain should finish');
}

async function testLaterReplacementRechecksBinaryState(): Promise<void> {
  await resetFixtures();
  await writeFixture('becomes-binary.custombin', 'alpha\n');
  const result = await callReplaceBatch({
    files: [{
      file_path: 'becomes-binary.custombin',
      replacements: [
        { target: 'alpha', replacement: 'a\0b' },
        { target: 'a', replacement: 'A' },
      ],
    }],
  });
  const batch = parseResultJson(result);
  assertEqual(batch.files[0]?.replacements[0]?.success, true, 'First replacement should write');
  assertEqual(batch.files[0]?.replacements[1]?.success, false, 'Second should reject binary state');
  assertIncludes(
    batch.files[0]?.replacements[1]?.note,
    'binary',
    'Second replacement should report binary readiness failure',
  );
}

async function testLaterReplacementRechecksSizeLimit(): Promise<void> {
  await resetFixtures();
  await writeFixture('becomes-large.txt', 'alpha');
  const oversized = 'x'.repeat(20 * 1024 * 1024 + 1);
  const result = await callReplaceBatch({
    files: [{
      file_path: 'becomes-large.txt',
      replacements: [
        { target: 'alpha', replacement: oversized },
        { target: 'x', replacement: 'y' },
      ],
    }],
  });
  const batch = parseResultJson(result);
  assertEqual(batch.files[0]?.replacements[0]?.success, true, 'First replacement should write a large result');
  assertEqual(batch.files[0]?.replacements[1]?.success, false, 'Second should enforce the size limit');
  assertIncludes(
    batch.files[0]?.replacements[1]?.note,
    '20MB',
    'Second replacement should report the size limit',
  );
}

async function testFileLevelFailureReplicatesForEveryReplacement(): Promise<void> {
  await resetFixtures();
  const result = await callReplaceBatch({
    files: [{
      file_path: '../outside.txt',
      replacements: [
        { target: 'a', replacement: 'b' },
        { target: 'c', replacement: 'd\ne' },
      ],
    }, {
      file_path: 'flags.txt',
      regex_flags: 'm',
      replacements: [
        { target: 'a', replacement: 'b' },
        { target: 'c', replacement: 'd' },
      ],
    }],
  });
  const batch = parseResultJson(result);
  for (const file of batch.files) {
    assertEqual(file.replacements.length, 2, 'Every input replacement should have a result');
    assert(file.replacements.every((item) => !item.success), 'Shared failure should fail every item');
    assert(file.replacements.every((item) => item.file_line_count.previous === null), 'Unsafe unread state should be unknown');
  }
  assertEqual(
    batch.files[0]?.replacements[1]?.replacement_line_count,
    2,
    'Replicated failures should retain each replacement line count',
  );
}

async function testWriteFailureRecoversActualStateAndNextReplacementRereads(): Promise<void> {
  await resetFixtures();
  await writeFixture('write-failure.txt', 'old\n');
  let writeCount = 0;
  const handler = createReplaceTextHandler({
    writeTextContent: async (resolved, content, lineEnding) => {
      writeCount++;
      const physical = lineEnding === '\r\n'
        ? content.replace(/\n/g, '\r\n')
        : content;
      await fs.writeFile(resolved, physical, 'utf-8');
      return writeCount === 1 ? 'Injected write failure.' : null;
    },
  });

  const result = await callWithHandler(handler, {
    files: [{
      file_path: 'write-failure.txt',
      replacements: [
        { target: 'old', replacement: 'written\nstate' },
        { target: 'written', replacement: 'verified' },
      ],
    }],
  });
  const batch = parseResultJson(result);
  const first = batch.files[0]?.replacements[0];
  const second = batch.files[0]?.replacements[1];
  assertEqual(first?.success, false, 'Injected write error should remain a failure');
  assertEqual(first?.replacement_count, 0, 'Failed write should report zero committed replacements');
  assertEqual(first?.file_line_count.previous, 2, 'Failed write previous lines');
  assertEqual(first?.file_line_count.current, 3, 'Recovery should report actual written lines');
  assertIncludes(first?.note, 'may have been truncated', 'Failure should explain uncertain write state');
  assertEqual(second?.success, true, 'Next replacement should re-read the actual disk state');
  await assertFixtureContent('write-failure.txt', 'verified\nstate\n', 'Next replacement should modify recovered content');
}

async function testWriteFailureReportsUnknownWhenRecoveryIsUnsafe(): Promise<void> {
  await resetFixtures();
  await writeFixture('unsafe-recovery.txt', 'old\n');
  const handler = createReplaceTextHandler({
    writeTextContent: async (resolved) => {
      await fs.rm(resolved, { force: true });
      await fs.mkdir(resolved);
      return 'Injected write failure.';
    },
  });

  const result = await callWithHandler(handler, {
    files: [{
      file_path: 'unsafe-recovery.txt',
      replacements: [
        { target: 'old', replacement: 'new' },
        { target: 'new', replacement: 'later' },
      ],
    }],
  });
  const batch = parseResultJson(result);
  const first = batch.files[0]?.replacements[0];
  const second = batch.files[0]?.replacements[1];
  assertEqual(first?.file_line_count.previous, 2, 'Write failure should retain known previous lines');
  assertEqual(first?.file_line_count.current, null, 'Unsafe recovery should report unknown current lines');
  assertEqual(second?.success, false, 'Next replacement should independently reject the directory state');
  assertIncludes(second?.note, 'directory', 'Next replacement should recheck the actual target type');
}

async function testFileEntryLockPreventsExternalInsertion(): Promise<void> {
  await resetFixtures();
  await writeFixture('locked.txt', 'alpha beta\n');
  let releaseFirstWrite!: () => void;
  let markFirstWrite!: () => void;
  const firstWriteReached = new Promise<void>((resolve) => { markFirstWrite = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  let writeCount = 0;
  const handler = createReplaceTextHandler({
    writeTextContent: async (resolved, content) => {
      writeCount++;
      await fs.writeFile(resolved, content, 'utf-8');
      if (writeCount === 1) {
        markFirstWrite();
        await release;
      }
      return null;
    },
  });

  const batchPromise = callWithHandler(handler, {
    files: [{
      file_path: 'locked.txt',
      replacements: [
        { target: 'alpha', replacement: 'ALPHA' },
        { target: 'beta', replacement: 'BETA' },
      ],
    }],
  });
  await firstWriteReached;
  const externalPromise = callReplace({
    file_path: 'locked.txt',
    target: 'BETA',
    replacement: 'FINAL',
  });
  releaseFirstWrite();

  const [batchResult, externalResult] = await Promise.all([batchPromise, externalPromise]);
  assertEqual(parseResultJson(batchResult).success, true, 'Batch file entry should complete successfully');
  assertEqual(parseResultJson(externalResult).success, true, 'External call should run after both batch replacements');
  await assertFixtureContent('locked.txt', 'ALPHA FINAL\n', 'External write should not insert inside file entry');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text batch orchestration tests',
    details: 'Covers ordering, partial success, state refresh, recovery reads, and file-entry locking.',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'Same-file replacements use written state and retain partial success', run: testSameFileEntryUsesWrittenStateAndKeepsPartialSuccess },
      { name: 'Later files and repeated-path stages continue in order', run: testLaterFileAndRepeatedPathEntriesContinueInOrder },
      { name: 'Missing file can fail, then be created and modified', run: testMissingFileCanFailThenCreateThenModify },
      { name: 'Later replacement rechecks binary state', run: testLaterReplacementRechecksBinaryState },
      { name: 'Later replacement rechecks the size limit', run: testLaterReplacementRechecksSizeLimit },
      { name: 'File-level failures replicate across replacement results', run: testFileLevelFailureReplicatesForEveryReplacement },
      { name: 'Write failure recovers actual state and next item re-reads', run: testWriteFailureRecoversActualStateAndNextReplacementRereads },
      { name: 'Write failure reports unknown when recovery is unsafe', run: testWriteFailureReportsUnknownWhenRecoveryIsUnsafe },
      { name: 'File-entry lock prevents external insertion', run: testFileEntryLockPreventsExternalInsertion },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
