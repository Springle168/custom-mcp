import {
  assertEqual,
  runTestSuite,
} from '../test-utils.js';
import {
  assertErrorResult,
  assertFixtureContent,
  assertJsonDefaults,
  assertJsonNoteIncludes,
  assertNoSpan,
  assertSuccessResult,
  callReplace,
  cleanupFixtures,
  createTestConfig,
  resetFixtures,
  writeFixture,
} from './helpers.js';

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
  await resetFixtures();

  const result = await callReplace({
    target: 'alpha',
    replacement: 'beta',
  });

  const json = assertErrorResult(result);
  assertEqual(json.file_path, '', 'Missing file_path should normalize to empty string');
  assertEqual(json.replacement_line_count, 1, 'Valid replacement line count should be preserved');
  assertJsonDefaults(json);
}

async function testMissingTargetRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('missing-target.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'missing-target.txt',
    replacement: 'beta',
  });

  const json = assertErrorResult(result);
  assertEqual(json.file_path, 'missing-target.txt', 'file_path should echo valid input');
  assertEqual(json.replacement_line_count, 1, 'Valid replacement line count should be preserved');
  assertJsonDefaults(json);
  await assertFixtureContent(
    'missing-target.txt',
    'alpha\n',
    'Missing target should not modify the file',
  );
}

async function testMissingReplacementRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('missing-replacement.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'missing-replacement.txt',
    target: 'alpha',
  });

  const json = assertErrorResult(result);
  assertEqual(
    json.replacement_line_count,
    0,
    'Missing replacement should report replacement_line_count=0',
  );
  assertJsonDefaults(json);
  await assertFixtureContent(
    'missing-replacement.txt',
    'alpha\n',
    'Missing replacement should not modify the file',
  );
}

async function testNonStringFilePathRejected(): Promise<void> {
  await resetFixtures();

  const result = await callReplace({
    file_path: 42,
    target: 'alpha',
    replacement: 'beta',
  });

  const json = assertErrorResult(result);
  assertEqual(json.file_path, '', 'Non-string file_path should normalize to empty string');
  assertJsonDefaults(json);
}

async function testNonStringTargetRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('non-string-target.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'non-string-target.txt',
    target: ['alpha'],
    replacement: 'beta',
  });

  const json = assertErrorResult(result);
  assertEqual(json.file_path, 'non-string-target.txt', 'file_path should echo valid input');
  assertJsonDefaults(json);
  await assertFixtureContent(
    'non-string-target.txt',
    'alpha\n',
    'Non-string target should not modify the file',
  );
}

async function testNonStringReplacementRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('non-string-replacement.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'non-string-replacement.txt',
    target: 'alpha',
    replacement: { text: 'beta' },
  });

  const json = assertErrorResult(result);
  assertEqual(
    json.replacement_line_count,
    0,
    'Non-string replacement should report replacement_line_count=0',
  );
  assertJsonDefaults(json);
  await assertFixtureContent(
    'non-string-replacement.txt',
    'alpha\n',
    'Non-string replacement should not modify the file',
  );
}

async function testNonBooleanAllowMultipleRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('bad-allow-multiple.txt', 'alpha alpha\n');

  const result = await callReplace({
    file_path: 'bad-allow-multiple.txt',
    target: 'alpha',
    replacement: 'beta',
    allow_multiple: 'true',
  });

  const json = assertErrorResult(result);
  assertEqual(
    json.allow_multiple,
    false,
    'Non-boolean allow_multiple should normalize to false',
  );
  assertJsonDefaults(json);
  await assertFixtureContent(
    'bad-allow-multiple.txt',
    'alpha alpha\n',
    'Invalid allow_multiple should not modify the file',
  );
}

async function testInvalidMatchModeRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('bad-match-mode.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'bad-match-mode.txt',
    target: 'alpha',
    replacement: 'beta',
    match_mode: 'regexp',
  });

  const json = assertErrorResult(result);
  assertEqual(
    json.match_mode,
    'default',
    'Invalid match_mode should normalize to default',
  );
  assertJsonDefaults(json);
  await assertFixtureContent(
    'bad-match-mode.txt',
    'alpha\n',
    'Invalid match_mode should not modify the file',
  );
}

async function testNonStringRegexFlagsRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('bad-regex-flags-type.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'bad-regex-flags-type.txt',
    target: 'alpha',
    replacement: 'beta',
    match_mode: 'regex',
    regex_flags: ['m'],
  });

  const json = assertErrorResult(result);
  assertJsonNoteIncludes(json, 'regex_flags', 'Invalid regex_flags type note');
  assertJsonDefaults(json);
  await assertFixtureContent(
    'bad-regex-flags-type.txt',
    'alpha\n',
    'Non-string regex_flags should not modify the file',
  );
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
  await resetFixtures();
  await writeFixture('unknown-field.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'unknown-field.txt',
    target: 'alpha',
    replacement: 'beta',
    extra: true,
  });

  const json = assertErrorResult(result);
  assertJsonDefaults(json);
  await assertFixtureContent(
    'unknown-field.txt',
    'alpha\n',
    'Unknown field should not modify the file',
  );
}

async function testLegacyFieldsOnlyRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('legacy-only.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'legacy-only.txt',
    old_string: 'alpha',
    new_string: 'beta',
  });

  const json = assertErrorResult(result);
  assertEqual(
    json.replacement_line_count,
    0,
    'Legacy new_string should not count as replacement',
  );
  assertNoSpan(json, 'Legacy-only call should be a preflight failure');
  await assertFixtureContent(
    'legacy-only.txt',
    'alpha\n',
    'Legacy fields should not be accepted as aliases',
  );
}

async function testLegacyExtraFieldsRejected(): Promise<void> {
  await resetFixtures();
  await writeFixture('legacy-extra.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'legacy-extra.txt',
    target: 'alpha',
    replacement: 'beta',
    old_string: 'alpha',
    new_string: 'beta',
  });

  const json = assertErrorResult(result);
  assertEqual(
    json.replacement_line_count,
    1,
    'Valid replacement should still be counted on unknown-field failure',
  );
  assertNoSpan(json, 'Legacy extra fields should be preflight failure');
  await assertFixtureContent(
    'legacy-extra.txt',
    'alpha\n',
    'Legacy fields as extras should reject without writing',
  );
}

async function testStrictTrueAllowMultipleEchoedOnParameterFailure(): Promise<void> {
  await resetFixtures();

  const result = await callReplace({
    file_path: 'unused.txt',
    target: 'alpha',
    replacement: 'beta',
    allow_multiple: true,
    match_mode: 'invalid',
  });

  const json = assertErrorResult(result);
  assertEqual(
    json.allow_multiple,
    true,
    'Strict true allow_multiple should be preserved even on parameter failure',
  );
  assertEqual(json.match_mode, 'default', 'Invalid match_mode should normalize to default');
  assertJsonDefaults(json);
}

async function testExplicitRegexModeEchoedOnParameterFailure(): Promise<void> {
  await resetFixtures();

  const result = await callReplace({
    file_path: 123,
    target: 'alpha',
    replacement: 'beta',
    match_mode: 'regex',
  });

  const json = assertErrorResult(result);
  assertEqual(json.file_path, '', 'Invalid file_path should normalize to empty string');
  assertEqual(json.match_mode, 'regex', 'Valid regex match_mode should be echoed');
  assertJsonDefaults(json);
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
    createTestConfig(),
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
    details: 'Covers v2 argument names, runtime validation, legacy fields, and failure defaults.',
    afterAll: cleanupFixtures,
    tests: [
      {
        name: 'New parameter names succeed and omitted options default',
        run: testNewParameterNamesAndDefaults,
      },
      { name: 'Missing file_path is rejected', run: testMissingFilePathRejected },
      { name: 'Missing target is rejected', run: testMissingTargetRejected },
      {
        name: 'Missing replacement is rejected',
        run: testMissingReplacementRejected,
      },
      {
        name: 'Non-string file_path is rejected',
        run: testNonStringFilePathRejected,
      },
      {
        name: 'Non-string target is rejected',
        run: testNonStringTargetRejected,
      },
      {
        name: 'Non-string replacement is rejected',
        run: testNonStringReplacementRejected,
      },
      {
        name: 'Non-boolean allow_multiple is rejected',
        run: testNonBooleanAllowMultipleRejected,
      },
      {
        name: 'Invalid match_mode is rejected',
        run: testInvalidMatchModeRejected,
      },
      {
        name: 'Non-string regex_flags is rejected',
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
      { name: 'Unknown field is rejected', run: testUnknownFieldRejected },
      {
        name: 'Legacy fields alone are rejected',
        run: testLegacyFieldsOnlyRejected,
      },
      {
        name: 'Legacy fields as extras are rejected',
        run: testLegacyExtraFieldsRejected,
      },
      {
        name: 'Strict true allow_multiple echoes on parameter failure',
        run: testStrictTrueAllowMultipleEchoedOnParameterFailure,
      },
      {
        name: 'Explicit regex mode echoes on parameter failure',
        run: testExplicitRegexModeEchoedOnParameterFailure,
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
