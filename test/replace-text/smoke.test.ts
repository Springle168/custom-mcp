import {
  assert,
  assertEqual,
  assertIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';
import { createReplaceTextFixtureHarness } from './helpers.js';

const {
  callReplace,
  cleanupFixtures,
  fixturesDir: FIXTURES_DIR,
  readFixture,
  resetFixtures: prepareFixtures,
  writeFixture,
} = createReplaceTextFixtureHarness('smoke');

interface ReplaceJsonPayload {
  success: boolean;
  note?: string;
  allow_multiple: boolean;
  matched_targets: number;
  replacement_count: number;
  matched_span: { start_line: number; end_line: number } | null;
  file_line_count: { previous: number; current: number };
}

function parsePayload(result: { content?: Array<{ text?: string }> }): ReplaceJsonPayload {
  return JSON.parse(getResultText(result)) as ReplaceJsonPayload;
}

async function testWarnsButWritesPlaceholderReplacement(): Promise<void> {
  await writeFixture('warns.ts', 'function demo() {\n  return 1;\n}\n');

  const result = await callReplace({
    file_path: 'warns.ts',
    target: '  return 1;',
    replacement: '  // ...\n  return 2;',
  });

  assert(result.isError !== true, 'Should succeed');
  const payload = parsePayload(result);
  assert(payload.success, 'Payload should report success');
  assertIncludes(payload.note, 'Warning:', 'Should include a warning');
  assertIncludes(payload.note, "'...'", 'Should name the placeholder');
  assertEqual(payload.matched_targets, 1, 'Should report one matched target');
  assertEqual(payload.replacement_count, 1, 'Should report one replacement');
  assertEqual(
    payload.matched_span?.start_line,
    2,
    'Should report matched start line',
  );

  const raw = await readFixture('warns.ts');
  assertEqual(
    raw,
    'function demo() {\n  // ...\n  return 2;\n}\n',
    'Should still write the requested replacement',
  );
}

async function testDoesNotWarnForExistingPlaceholder(): Promise<void> {
  await writeFixture('existing-placeholder.txt', 'before\n// ...\nafter\n');

  const result = await callReplace({
    file_path: 'existing-placeholder.txt',
    target: '// ...',
    replacement: '// ...\nactual content',
  });

  assert(result.isError !== true, 'Should succeed');
  const payload = parsePayload(result);
  assert(payload.success, 'Payload should report success');
  assertEqual(payload.note, undefined, 'Should not warn for existing placeholder');

  const raw = await readFixture('existing-placeholder.txt');
  assertEqual(
    raw,
    'before\n// ...\nactual content\nafter\n',
    'Should write the replacement without warning',
  );
}

async function testRejectsNonBooleanAllowMultiple(): Promise<void> {
  const result = await callReplace({
    file_path: 'unused.txt',
    target: 'old',
    replacement: 'new',
    allow_multiple: 'false',
  });

  assert(result.isError === true, 'Should fail');
  const payload = parsePayload(result);
  assert(!payload.success, 'Payload should report failure');
  assertEqual(payload.allow_multiple, false, 'Invalid allow_multiple should normalize to false');
}

async function testRejectsOldFieldAliases(): Promise<void> {
  await writeFixture('old-fields.txt', 'old\n');

  const result = await callReplace({
    file_path: 'old-fields.txt',
    old_string: 'old',
    new_string: 'new',
  });

  assert(result.isError === true, 'Should fail');
  const text = getResultText(result);
  assertIncludes(text, 'old_string', 'Should mention rejected old field');
  assertIncludes(text, 'target/replacement', 'Should suggest v2 parameter names');

  const raw = await readFixture('old-fields.txt');
  assertEqual(raw, 'old\n', 'Should not modify the file');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing replace_text tool',
    details: `Fixtures directory: ${FIXTURES_DIR}`,
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      {
        name: 'Warns but writes possible placeholder replacement',
        run: testWarnsButWritesPlaceholderReplacement,
      },
      {
        name: 'Does not warn for placeholder already in target',
        run: testDoesNotWarnForExistingPlaceholder,
      },
      {
        name: 'Rejects non-boolean allow_multiple',
        run: testRejectsNonBooleanAllowMultiple,
      },
      {
        name: 'Rejects old field aliases',
        run: testRejectsOldFieldAliases,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
