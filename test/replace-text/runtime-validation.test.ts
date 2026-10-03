import { assertEqual, assertIncludes, getResultText, runTestSuite } from '../test-utils.js';
import { callBuiltInTool } from '../helpers/built-in-tool-call.js';
import { createTestToolInvocationContext } from '../helpers/tool-invocation-context.js';
import {
  assertErrorResult,
  assertJsonDefaults,
  assertJsonNoteIncludes,
  assertSuccessResult,
  createReplaceTextFixtureHarness,
} from './helpers.js';

const {
  assertFixtureContent,
  callReplace,
  cleanupFixtures,
  createTestToolContext,
  resetFixtures,
  writeFixture,
} = createReplaceTextFixtureHarness('runtime-validation');

async function assertBuiltInSchemaError(
  args: unknown,
  expectedFragments: readonly string[],
  message: string,
): Promise<void> {
  const result = await callBuiltInTool(
    'replace_text',
    args,
    createTestToolContext(),
    createTestToolInvocationContext(),
  );
  assertEqual(result.isError, true, `${message}: should set isError`);
  const text = getResultText(result);
  assertIncludes(text, 'configured input schema', `${message}: schema error prefix`);
  for (const fragment of expectedFragments) {
    assertIncludes(text, fragment, `${message}: should identify ${fragment}`);
  }
}

function validFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file_path: 'example.txt',
    replacements: [{ target: 'alpha', replacement: 'beta' }],
    ...overrides,
  };
}

async function testDefaults(): Promise<void> {
  await resetFixtures();
  await writeFixture('defaults.txt', 'alpha\n');
  const json = assertSuccessResult(
    await callReplace({
      file_path: 'defaults.txt',
      target: 'alpha',
      replacement: 'beta',
    }),
  );
  assertEqual(json.file_path, 'defaults.txt', 'file_path should echo input');
  assertEqual(json.match_mode, 'default', 'match_mode default');
  assertEqual(json.allow_multiple, false, 'allow_multiple default');
  await assertFixtureContent('defaults.txt', 'beta\n', 'Default batch should write');
}

async function testRootShapeValidation(): Promise<void> {
  await assertBuiltInSchemaError({}, ['files', '[required]'], 'Missing files');
  await assertBuiltInSchemaError({ files: [] }, ['/files', '[minItems]'], 'Empty files');
  await assertBuiltInSchemaError(
    { files: [validFile()], extra: true },
    ['unexpected property "extra"', '[additionalProperties]'],
    'Root unknown field',
  );
}

async function testFileShapeValidation(): Promise<void> {
  await assertBuiltInSchemaError(
    { files: [{ replacements: [{ target: 'a', replacement: 'b' }] }] },
    ['file_path', '[required]'],
    'Missing file_path',
  );
  await assertBuiltInSchemaError(
    { files: [{ file_path: 'a.txt' }] },
    ['replacements', '[required]'],
    'Missing replacements',
  );
  await assertBuiltInSchemaError(
    { files: [validFile({ file_path: '' })] },
    ['/files/0/file_path', '[minLength]'],
    'Empty file_path',
  );
  await assertBuiltInSchemaError(
    { files: [validFile({ replacements: [] })] },
    ['/files/0/replacements', '[minItems]'],
    'Empty replacements',
  );
  await assertBuiltInSchemaError(
    { files: [validFile({ allow_multiple: 'true' })] },
    ['/files/0/allow_multiple', '[type]'],
    'Non-boolean allow_multiple',
  );
  await assertBuiltInSchemaError(
    { files: [validFile({ match_mode: 'regexp' })] },
    ['/files/0/match_mode', '[enum]'],
    'Invalid match_mode',
  );
  await assertBuiltInSchemaError(
    { files: [validFile({ unexpected: true })] },
    ['unexpected property "unexpected"', '[additionalProperties]'],
    'File unknown field',
  );
}

async function testReplacementShapeValidation(): Promise<void> {
  await assertBuiltInSchemaError(
    { files: [validFile({ replacements: [{ replacement: 'b' }] })] },
    ['target', '[required]'],
    'Missing target',
  );
  await assertBuiltInSchemaError(
    { files: [validFile({ replacements: [{ target: 'a' }] })] },
    ['replacement', '[required]'],
    'Missing replacement',
  );
  await assertBuiltInSchemaError(
    { files: [validFile({ replacements: [{ target: [], replacement: 'b' }] })] },
    ['/files/0/replacements/0/target', '[type]'],
    'Non-string target',
  );
  await assertBuiltInSchemaError(
    { files: [validFile({ replacements: [{ target: 'a', replacement: 1 }] })] },
    ['/files/0/replacements/0/replacement', '[type]'],
    'Non-string replacement',
  );
  await assertBuiltInSchemaError(
    { files: [validFile({ replacements: [{ target: 'a', replacement: 'b', extra: true }] })] },
    ['unexpected property "extra"', '[additionalProperties]'],
    'Replacement unknown field',
  );
}

async function testRegexFlagsWithoutRegexModeRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('flags-default.txt', 'alpha\n');
  const json = assertErrorResult(
    await callReplace({
      file_path: 'flags-default.txt',
      target: 'alpha',
      replacement: 'beta',
      regex_flags: 'm',
    }),
  );
  assertJsonNoteIncludes(json, "match_mode is 'regex'", 'regex_flags mode note');
  assertJsonDefaults(json);
  await assertFixtureContent('flags-default.txt', 'alpha\n', 'Invalid flags should not write');
}

async function testInvalidRegexFlagsRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('flags-invalid.txt', 'alpha\n');
  const invalid = assertErrorResult(
    await callReplace({
      file_path: 'flags-invalid.txt',
      target: 'alpha',
      replacement: 'beta',
      match_mode: 'regex',
      regex_flags: 'mi',
    }),
  );
  assertJsonNoteIncludes(invalid, "'g', 'm', and 's'", 'Invalid flag note');
  assertJsonDefaults(invalid);

  const duplicate = assertErrorResult(
    await callReplace({
      file_path: 'flags-invalid.txt',
      target: 'alpha',
      replacement: 'beta',
      match_mode: 'regex',
      regex_flags: 'msm',
    }),
  );
  assertJsonNoteIncludes(duplicate, 'must not repeat flags', 'Duplicate flag note');
  assertJsonDefaults(duplicate);
}

async function testRouteUsesProvidedFixtureRootOnly(): Promise<void> {
  await resetFixtures();
  await writeFixture('fixture-root.txt', 'alpha\n');
  assertSuccessResult(
    await callReplace(
      {
        file_path: 'fixture-root.txt',
        target: 'alpha',
        replacement: 'beta',
      },
      createTestToolContext(),
    ),
  );
  await assertFixtureContent('fixture-root.txt', 'beta\n', 'Should use explicit fixture root');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text batch runtime validation tests',
    details: 'Covers nested schema validation, defaults, and file-level regex semantics.',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'File options apply defaults', run: testDefaults },
      { name: 'Root batch shape is validated', run: testRootShapeValidation },
      { name: 'File item shape is validated', run: testFileShapeValidation },
      { name: 'Replacement item shape is validated', run: testReplacementShapeValidation },
      { name: 'regex_flags requires regex mode', run: testRegexFlagsWithoutRegexModeRejected },
      { name: 'regex_flags syntax is validated', run: testInvalidRegexFlagsRejected },
      { name: 'Tests use explicit fixture root config', run: testRouteUsesProvidedFixtureRootOnly },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
