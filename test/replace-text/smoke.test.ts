import {
  assert,
  assertEqual,
  assertIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';
import { callBuiltInTool } from '../helpers/built-in-tool-call.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import {
  assertSuccessResult,
  createReplaceTextFixtureHarness,
  singleReplaceBatch,
} from './helpers.js';

const {
  callReplace,
  cleanupFixtures,
  createTestToolContext,
  fixturesDir: FIXTURES_DIR,
  readFixture,
  resetFixtures: prepareFixtures,
  writeFixture,
} = createReplaceTextFixtureHarness('smoke');

async function testWarnsButWritesPlaceholderReplacement(): Promise<void> {
  await writeFixture('warns.ts', 'function demo() {\n  return 1;\n}\n');

  const result = await callReplace({
    file_path: 'warns.ts',
    target: '  return 1;',
    replacement: '  // ...\n  return 2;',
  });

  const payload = assertSuccessResult(result);
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

  const payload = assertSuccessResult(result);
  assertEqual(payload.note, undefined, 'Should not warn for existing placeholder');

  const raw = await readFixture('existing-placeholder.txt');
  assertEqual(
    raw,
    'before\n// ...\nactual content\nafter\n',
    'Should write the replacement without warning',
  );
}

async function testRejectsNonBooleanAllowMultiple(): Promise<void> {
  const result = await callBuiltInTool(
    'replace_text',
    singleReplaceBatch({
      file_path: 'unused.txt',
      target: 'old',
      replacement: 'new',
      allow_multiple: 'false' as unknown as boolean,
    }),
    createTestToolContext(),
    createTestToolInvocationContext(),
  );

  assert(result.isError === true, 'Should fail');
  assertIncludes(getResultText(result), 'must be boolean', 'Should report schema type validation');
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
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
