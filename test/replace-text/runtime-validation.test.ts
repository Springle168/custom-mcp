import {
  assertEqual,
  assertIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';
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

  assertEqual(result.isError, true, `${message}: result should set isError: true`);
  const text = getResultText(result);
  assertIncludes(
    text,
    'configured input schema',
    `${message}: result should identify the configured input schema`,
  );
  for (const fragment of expectedFragments) {
    assertIncludes(text, fragment, `${message}: schema error should identify ${fragment}`);
  }
}

async function testNewParameterNamesAndDefaults(): Promise<void> {
  await resetFixtures();
  await writeFixture('new-params.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'new-params.txt',
    target: 'alpha',
    replacement: 'beta',
  });

  const json = assertSuccessResult(result);
  assertEqual(json.file_path, 'new-params.txt', 'file_path should echo input');
  assertEqual(json.match_mode, 'default', 'match_mode should default to default');
  assertEqual(json.allow_multiple, false, 'allow_multiple should default to false');
  assertEqual(json.matched_targets, 1, 'Should match once');
  assertEqual(json.replacement_count, 1, 'Should replace once');
  await assertFixtureContent(
    'new-params.txt',
    'beta\n',
    'Should write replacement using v2 parameter names',
  );
}

async function testMissingFilePathRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    target: 'alpha',
    replacement: 'beta',
  }, ['file_path', '[required]'], 'Missing file_path');
}

async function testMissingTargetRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    file_path: 'missing-target.txt',
    replacement: 'beta',
  }, ['target', '[required]'], 'Missing target');
}

async function testMissingReplacementRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    file_path: 'missing-replacement.txt',
    target: 'alpha',
  }, ['replacement', '[required]'], 'Missing replacement');
}

async function testNonStringFilePathRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    file_path: 42,
    target: 'alpha',
    replacement: 'beta',
  }, ['/file_path', '[type]'], 'Non-string file_path');
}

async function testNonStringTargetRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    file_path: 'non-string-target.txt',
    target: ['alpha'],
    replacement: 'beta',
  }, ['/target', '[type]'], 'Non-string target');
}

async function testNonStringReplacementRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    file_path: 'non-string-replacement.txt',
    target: 'alpha',
    replacement: { text: 'beta' },
  }, ['/replacement', '[type]'], 'Non-string replacement');
}

async function testNonBooleanAllowMultipleRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    file_path: 'bad-allow-multiple.txt',
    target: 'alpha',
    replacement: 'beta',
    allow_multiple: 'true',
  }, ['/allow_multiple', '[type]'], 'Non-boolean allow_multiple');
}

async function testInvalidMatchModeRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    file_path: 'bad-match-mode.txt',
    target: 'alpha',
    replacement: 'beta',
    match_mode: 'regexp',
  }, ['/match_mode', '[enum]'], 'Invalid match_mode');
}

async function testNonStringRegexFlagsRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    file_path: 'bad-regex-flags-type.txt',
    target: 'alpha',
    replacement: 'beta',
    match_mode: 'regex',
    regex_flags: ['m'],
  }, ['/regex_flags', '[type]'], 'Non-string regex_flags');
}

async function testRegexFlagsWithoutRegexModeRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('regex-flags-default-mode.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'regex-flags-default-mode.txt',
    target: 'alpha',
    replacement: 'beta',
    regex_flags: 'm',
  });

  const json = assertErrorResult(result);
  assertJsonNoteIncludes(json, "match_mode is 'regex'", 'regex_flags mode note');
  assertJsonDefaults(json);
  await assertFixtureContent(
    'regex-flags-default-mode.txt',
    'alpha\n',
    'regex_flags without regex mode should not modify the file',
  );
}

async function testRegexFlagsInvalidCharacterRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('bad-regex-flags-char.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'bad-regex-flags-char.txt',
    target: 'alpha',
    replacement: 'beta',
    match_mode: 'regex',
    regex_flags: 'mi',
  });

  const json = assertErrorResult(result);
  assertJsonNoteIncludes(json, "'g', 'm', and 's'", 'regex_flags character note');
  assertJsonDefaults(json);
  await assertFixtureContent(
    'bad-regex-flags-char.txt',
    'alpha\n',
    'Invalid regex_flags character should not modify the file',
  );
}

async function testRegexFlagsDuplicateCharacterRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('bad-regex-flags-repeat.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'bad-regex-flags-repeat.txt',
    target: 'alpha',
    replacement: 'beta',
    match_mode: 'regex',
    regex_flags: 'msm',
  });

  const json = assertErrorResult(result);
  assertJsonNoteIncludes(json, 'must not repeat flags', 'regex_flags duplicate note');
  assertJsonDefaults(json);
  await assertFixtureContent(
    'bad-regex-flags-repeat.txt',
    'alpha\n',
    'Duplicate regex_flags character should not modify the file',
  );
}

async function testUnknownFieldRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    file_path: 'unknown-field.txt',
    target: 'alpha',
    replacement: 'beta',
    extra: true,
  }, ['unexpected property "extra"', '[additionalProperties]'], 'Unknown field');
}

async function testLegacyFieldsOnlyRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    file_path: 'legacy-only.txt',
    old_string: 'alpha',
    new_string: 'beta',
  }, [
    'unexpected property "old_string"',
    'unexpected property "new_string"',
    '[additionalProperties]',
    'target',
    'replacement',
    '[required]',
  ], 'Legacy fields only');
}

async function testLegacyExtraFieldsRejected(): Promise<void> {
  await assertBuiltInSchemaError({
    file_path: 'legacy-extra.txt',
    target: 'alpha',
    replacement: 'beta',
    old_string: 'alpha',
    new_string: 'beta',
  }, [
    'unexpected property "old_string"',
    'unexpected property "new_string"',
    '[additionalProperties]',
  ], 'Legacy extra fields');
}

async function testRouteUsesProvidedFixtureRootOnly(): Promise<void> {
  await resetFixtures();
  await writeFixture('fixture-root.txt', 'alpha\n');

  const result = await callReplace(
    {
      file_path: 'fixture-root.txt',
      target: 'alpha',
      replacement: 'beta',
    },
    createTestToolContext(),
  );

  assertSuccessResult(result);
  await assertFixtureContent(
    'fixture-root.txt',
    'beta\n',
    'Test should use explicit fixture root config, not root config.json',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text v2 runtime validation tests',
    details: 'Covers v2 defaults, catalog schema validation, and regex_flags runtime semantics.',
    afterAll: cleanupFixtures,
    tests: [
      {
        name: 'New parameter names succeed and omitted options default',
        run: testNewParameterNamesAndDefaults,
      },
      {
        name: 'Missing file_path is rejected by the input schema',
        run: testMissingFilePathRejected,
      },
      {
        name: 'Missing target is rejected by the input schema',
        run: testMissingTargetRejected,
      },
      {
        name: 'Missing replacement is rejected by the input schema',
        run: testMissingReplacementRejected,
      },
      {
        name: 'Non-string file_path is rejected by the input schema',
        run: testNonStringFilePathRejected,
      },
      {
        name: 'Non-string target is rejected by the input schema',
        run: testNonStringTargetRejected,
      },
      {
        name: 'Non-string replacement is rejected by the input schema',
        run: testNonStringReplacementRejected,
      },
      {
        name: 'Non-boolean allow_multiple is rejected by the input schema',
        run: testNonBooleanAllowMultipleRejected,
      },
      {
        name: 'Invalid match_mode is rejected by the input schema',
        run: testInvalidMatchModeRejected,
      },
      {
        name: 'Non-string regex_flags is rejected by the input schema',
        run: testNonStringRegexFlagsRejected,
      },
      {
        name: 'regex_flags without regex mode is rejected',
        run: testRegexFlagsWithoutRegexModeRejected,
      },
      {
        name: 'regex_flags invalid character is rejected',
        run: testRegexFlagsInvalidCharacterRejected,
      },
      {
        name: 'regex_flags duplicate character is rejected',
        run: testRegexFlagsDuplicateCharacterRejected,
      },
      {
        name: 'Unknown field is rejected by the input schema',
        run: testUnknownFieldRejected,
      },
      {
        name: 'Legacy fields alone are rejected by the input schema',
        run: testLegacyFieldsOnlyRejected,
      },
      {
        name: 'Legacy fields as extras are rejected by the input schema',
        run: testLegacyExtraFieldsRejected,
      },
      {
        name: 'Tests use explicit fixture root config',
        run: testRouteUsesProvidedFixtureRootOnly,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
