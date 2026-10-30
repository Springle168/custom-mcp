import { assert, assertIncludes, getResultText, runTestSuite } from '../test-utils.js';
import { callBuiltInTool } from '../helpers/built-in-tool-call.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import { createReplaceTextFixtureHarness, singleReplaceBatch } from './helpers.js';

const {
  cleanupFixtures,
  createTestToolContext,
  fixturesDir: FIXTURES_DIR,
  resetFixtures: prepareFixtures,
} = createReplaceTextFixtureHarness('smoke');

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
