import {
  assert,
  assertEqual,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';
import {
  assertErrorResult,
  assertJsonNoteIncludes,
  assertNoSpan,
  assertSpan,
  assertSuccessResult,
  countSpecLines,
  createReplaceTextFixtureHarness,
} from './helpers.js';

const {
  assertFixtureContent,
  callReplace,
  cleanupFixtures,
  fixtureExists,
  resetFixtures,
  writeFixture,
} = createReplaceTextFixtureHarness('default-mode');

async function testExactSingleMatchCountsAndSpan(): Promise<void> {
  await resetFixtures();
  const before = 'line1\nalpha target\nline3\n';
  await writeFixture('exact-single.txt', before);

  const result = await callReplace({
    file_path: 'exact-single.txt',
    target: 'alpha target',
    replacement: 'beta target',
    match_mode: 'default',
  });

  const json = assertSuccessResult(result);
  assertEqual(json.match_mode, 'default', 'Should report default mode');
  assertEqual(json.allow_multiple, false, 'Should report allow_multiple=false');
  assertEqual(json.matched_targets, 1, 'Should match one target');
  assertEqual(json.replacement_count, 1, 'Should replace one target');
  assertSpan(json, 2, 2, 'Single-line exact match span');
  assertEqual(
    json.replacement_line_count,
    1,
    'Single-line replacement should count as one line',
  );
  assertEqual(
    json.file_line_count.previous,
    countSpecLines(before),
    'Previous file line count',
  );
  assertEqual(
    json.file_line_count.current,
    countSpecLines('line1\nbeta target\nline3\n'),
    'Current file line count',
  );
  await assertFixtureContent(
    'exact-single.txt',
    'line1\nbeta target\nline3\n',
    'Exact replacement should update one occurrence',
  );
}

async function testExactCrossLineSpanAndLineCountIncrease(): Promise<void> {
  await resetFixtures();
  const before = 'one\nstart\nmiddle\nend\nfive\n';
  await writeFixture('exact-cross-line.txt', before);

  const result = await callReplace({
    file_path: 'exact-cross-line.txt',
    target: 'start\nmiddle\nend',
    replacement: 'start\ninserted\nmiddle\nend',
  });

  const json = assertSuccessResult(result);
  assertSpan(json, 2, 4, 'Cross-line exact match span');
  assertEqual(json.replacement_line_count, 4, 'Replacement input line count');
  assertEqual(json.file_line_count.previous, 6, 'Previous line count includes trailing newline');
  assertEqual(json.file_line_count.current, 7, 'Current line count should increase by one');
  await assertFixtureContent(
    'exact-cross-line.txt',
    'one\nstart\ninserted\nmiddle\nend\nfive\n',
    'Cross-line exact replacement should write expected content',
  );
}

async function testDefaultTreatsRegexSyntaxLiterally(): Promise<void> {
  await resetFixtures();
  await writeFixture('literal-regex.txt', 'a.b\nacb\na.*b\n');

  const first = await callReplace({
    file_path: 'literal-regex.txt',
    target: 'a.b',
    replacement: 'DOT',
    match_mode: 'default',
  });
  assertSuccessResult(first);

  const second = await callReplace({
    file_path: 'literal-regex.txt',
    target: 'a.*b',
    replacement: 'STAR',
    match_mode: 'default',
  });
  const json = assertSuccessResult(second);
  assertEqual(json.matched_targets, 1, 'Pattern-looking target should match literal text only');
  await assertFixtureContent(
    'literal-regex.txt',
    'DOT\nacb\nSTAR\n',
    'Default mode should not interpret regex metacharacters',
  );
}

async function testDefaultReplacementKeepsSpecialSyntaxLiteral(): Promise<void> {
  await resetFixtures();
  await writeFixture('literal-replacement.txt', 'alpha\n');

  const replacement = '$!0|$!1|$1|$&|$$|$$!1';
  const result = await callReplace({
    file_path: 'literal-replacement.txt',
    target: 'alpha',
    replacement,
    match_mode: 'default',
  });

  const json = assertSuccessResult(result);
  assertEqual(
    json.replacement_line_count,
    1,
    'Literal replacement syntax should still count one line',
  );
  await assertFixtureContent(
    'literal-replacement.txt',
    `${replacement}\n`,
    'Default replacement should not expand regex replacement syntax',
  );
}

async function testDefaultCreateMissingFile(): Promise<void> {
  await resetFixtures();

  const result = await callReplace({
    file_path: 'nested/new-file.txt',
    target: '',
    replacement: 'created\nfile',
    match_mode: 'default',
  });

  const json = assertSuccessResult(result);
  assertEqual(json.matched_targets, 0, 'Create should not report matched targets');
  assertEqual(json.replacement_count, 0, 'Create should not report replacements');
  assertNoSpan(json, 'Create should not report matched span');
  assertEqual(json.file_line_count.previous, 0, 'Created file previous count');
  assertEqual(json.file_line_count.current, 2, 'Created file current count');
  assert(typeof json.note === 'string', 'Create should include a note');
  await assertFixtureContent(
    'nested/new-file.txt',
    'created\nfile',
    'Default empty target should create a missing file',
  );
}

async function testDefaultEmptyTargetExistingFileFails(): Promise<void> {
  await resetFixtures();
  await writeFixture('empty-target-existing.txt', 'keep\n');

  const result = await callReplace({
    file_path: 'empty-target-existing.txt',
    target: '',
    replacement: 'overwrite\n',
    match_mode: 'default',
  });

  const json = assertErrorResult(result);
  assertNoSpan(json, 'Empty target existing file should not have matched span');
  assertEqual(json.replacement_count, 0, 'Empty target existing file should not replace');
  await assertFixtureContent(
    'empty-target-existing.txt',
    'keep\n',
    'Default empty target should not overwrite existing files',
  );
}

async function testDefaultMissingFileWithNonEmptyTargetFails(): Promise<void> {
  await resetFixtures();

  const result = await callReplace({
    file_path: 'missing-nonempty.txt',
    target: 'alpha',
    replacement: 'beta',
    match_mode: 'default',
  });

  const json = assertErrorResult(result);
  assertEqual(json.file_line_count.previous, 0, 'Missing file previous count');
  assertEqual(json.file_line_count.current, 0, 'Missing file current count');
  assertNoSpan(json, 'Missing file should not have matched span');
  assertEqual(
    await fixtureExists('missing-nonempty.txt'),
    false,
    'Missing file with non-empty target should not be created',
  );
}

async function testDefaultNoMatchFailsWithoutWriting(): Promise<void> {
  await resetFixtures();
  await writeFixture('no-match.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'no-match.txt',
    target: 'gamma',
    replacement: 'delta',
    match_mode: 'default',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 0, 'No match should report zero matches');
  assertEqual(json.replacement_count, 0, 'No match should report zero replacements');
  assertNoSpan(json, 'No match should not report span');
  assertEqual(json.file_line_count.previous, 2, 'No match previous line count');
  assertEqual(json.file_line_count.current, 2, 'No match current line count');
  await assertFixtureContent('no-match.txt', 'alpha\n', 'No match should not write');
}

async function testDefaultMultipleMatchesRejectedWithoutAllowMultiple(): Promise<void> {
  await resetFixtures();
  await writeFixture('multi-reject.txt', 'alpha\nmid\nalpha\n');

  const result = await callReplace({
    file_path: 'multi-reject.txt',
    target: 'alpha',
    replacement: 'beta',
    match_mode: 'default',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 2, 'Multi-match rejection should report actual matches');
  assertEqual(json.replacement_count, 0, 'Multi-match rejection should not replace');
  assertSpan(json, 1, 3, 'Multi-match rejection span should cover all matches');
  assertJsonNoteIncludes(
    json,
    'allow_multiple',
    'Multi-match rejection should suggest allow_multiple',
  );
  await assertFixtureContent(
    'multi-reject.txt',
    'alpha\nmid\nalpha\n',
    'Multi-match rejection should not write',
  );
}

async function testDefaultAllowMultipleReplacesAllMatches(): Promise<void> {
  await resetFixtures();
  await writeFixture('multi-allow.txt', 'alpha\nmid\nalpha\n');

  const result = await callReplace({
    file_path: 'multi-allow.txt',
    target: 'alpha',
    replacement: 'beta',
    allow_multiple: true,
    match_mode: 'default',
  });

  const json = assertSuccessResult(result);
  assertEqual(json.allow_multiple, true, 'Should echo allow_multiple=true');
  assertEqual(json.matched_targets, 2, 'Should match all targets');
  assertEqual(json.replacement_count, 2, 'Should replace all targets');
  assertSpan(json, 1, 3, 'Allow-multiple span should cover all matches');
  await assertFixtureContent(
    'multi-allow.txt',
    'beta\nmid\nbeta\n',
    'allow_multiple should replace all literal matches',
  );
}

async function testDefaultNoOpFailsWithoutWriting(): Promise<void> {
  await resetFixtures();
  await writeFixture('no-op.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'no-op.txt',
    target: 'alpha',
    replacement: 'alpha',
    match_mode: 'default',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 1, 'No-op should report actual match count');
  assertEqual(json.replacement_count, 0, 'No-op should report zero replacements');
  assertSpan(json, 1, 1, 'No-op should report actual span');
  assertJsonNoteIncludes(json, 'change', 'No-op note should explain no applicable change');
  await assertFixtureContent('no-op.txt', 'alpha\n', 'No-op should not modify the file');
}

async function testDefaultRejectsDifferentIndentation(): Promise<void> {
  await resetFixtures();
  const before = 'function demo() {\n  const value = 1;\n  return value;\n}\n';
  await writeFixture('different-indentation.txt', before);

  const result = await callReplace({
    file_path: 'different-indentation.txt',
    target: 'const value = 1;\nreturn value;',
    replacement: 'const value = 2;\nreturn value + 1;',
    match_mode: 'default',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 0, 'Different indentation should not match');
  assertNoSpan(json, 'Different indentation should not have a span');
  await assertFixtureContent(
    'different-indentation.txt',
    before,
    'Different indentation should not write',
  );
}

async function testDefaultRejectsDifferentWhitespace(): Promise<void> {
  await resetFixtures();
  const before = 'before\n  if ( foo ) { bar = baz }\nafter\n';
  await writeFixture('different-whitespace.txt', before);

  const result = await callReplace({
    file_path: 'different-whitespace.txt',
    target: 'if(foo){bar=baz}',
    replacement: 'if (foo) {\n  bar = qux\n}',
    match_mode: 'default',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 0, 'Different whitespace should not match');
  assertNoSpan(json, 'Different whitespace should not have a span');
  await assertFixtureContent(
    'different-whitespace.txt',
    before,
    'Different whitespace should not write',
  );
}

async function testDefaultRejectsSmallTextDifference(): Promise<void> {
  await resetFixtures();
  const before = 'before\nThe quik brown fox jumps\nafter\n';
  await writeFixture('different-text.txt', before);

  const result = await callReplace({
    file_path: 'different-text.txt',
    target: 'The quick brown fox jumps',
    replacement: 'The quick brown fox leaps',
    match_mode: 'default',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 0, 'Different text should not match');
  assertNoSpan(json, 'Different text should not have a span');
  await assertFixtureContent(
    'different-text.txt',
    before,
    'Different text should not write',
  );
}

async function testEndLineBelongsToLineBeforeMatchedNewline(): Promise<void> {
  await resetFixtures();
  await writeFixture('newline-span.txt', 'first\nsecond\nthird\n');

  const result = await callReplace({
    file_path: 'newline-span.txt',
    target: 'second\n',
    replacement: 'SECOND\n',
    match_mode: 'default',
  });

  const json = assertSuccessResult(result);
  assertSpan(
    json,
    2,
    2,
    'Match ending on newline should end on the line before that newline',
  );
  await assertFixtureContent(
    'newline-span.txt',
    'first\nSECOND\nthird\n',
    'Replacement ending on newline should preserve surrounding content',
  );
}

async function testReplacementLineCountVariants(): Promise<void> {
  const cases: Array<{ name: string; replacement: string; expectedLines: number }> = [
    { name: 'empty.txt', replacement: '', expectedLines: 0 },
    { name: 'single.txt', replacement: 'abc', expectedLines: 1 },
    { name: 'two-lines.txt', replacement: 'a\nb', expectedLines: 2 },
    { name: 'trailing-newline.txt', replacement: 'a\n', expectedLines: 2 },
    { name: 'newline-only.txt', replacement: '\n', expectedLines: 2 },
    { name: 'crlf-input.txt', replacement: 'a\r\nb', expectedLines: 2 },
  ];

  for (const testCase of cases) {
    await resetFixtures();
    await writeFixture(testCase.name, 'target\n');

    const result = await callReplace({
      file_path: testCase.name,
      target: 'target',
      replacement: testCase.replacement,
      match_mode: 'default',
    });

    const json = assertSuccessResult(result);
    assertEqual(
      json.replacement_line_count,
      testCase.expectedLines,
      `replacement_line_count for ${testCase.name}`,
    );
  }
}

async function testPlaceholderWarningWritesSuccessfully(): Promise<void> {
  await resetFixtures();
  await writeFixture('placeholder-warning.txt', 'function demo() {\n  return 1;\n}\n');

  const result = await callReplace({
    file_path: 'placeholder-warning.txt',
    target: '  return 1;',
    replacement: '  // ...\n  return 2;',
    match_mode: 'default',
  });

  const json = assertSuccessResult(result);
  assert(typeof json.note === 'string', 'Placeholder warning should include note');
  assertJsonNoteIncludes(json, '...', 'Placeholder warning should identify ellipsis');
  await assertFixtureContent(
    'placeholder-warning.txt',
    'function demo() {\n  // ...\n  return 2;\n}\n',
    'Placeholder warning should not block writing',
  );
}

async function testExistingPlaceholderDoesNotWarnAgain(): Promise<void> {
  await resetFixtures();
  await writeFixture('placeholder-existing.txt', 'before\n// ...\nafter\n');

  const result = await callReplace({
    file_path: 'placeholder-existing.txt',
    target: '// ...',
    replacement: '// ...\nactual content',
    match_mode: 'default',
  });

  const json = assertSuccessResult(result);
  if (json.note !== undefined) {
    assertNotIncludes(
      json.note,
      '...',
      'Existing placeholder should not produce a new ellipsis warning',
    );
  }
  await assertFixtureContent(
    'placeholder-existing.txt',
    'before\n// ...\nactual content\nafter\n',
    'Existing placeholder should still be written literally',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text v2 default mode tests',
    details: 'Covers default matching, literal replacement behavior, counts, spans, creation, warnings, and no-op.',
    afterAll: cleanupFixtures,
    tests: [
      {
        name: 'Exact single match reports counts and span',
        run: testExactSingleMatchCountsAndSpan,
      },
      {
        name: 'Exact cross-line match reports span and line count increase',
        run: testExactCrossLineSpanAndLineCountIncrease,
      },
      {
        name: 'Default mode treats regex syntax literally',
        run: testDefaultTreatsRegexSyntaxLiterally,
      },
      {
        name: 'Default replacement keeps special syntax literal',
        run: testDefaultReplacementKeepsSpecialSyntaxLiteral,
      },
      { name: 'Default empty target creates missing file', run: testDefaultCreateMissingFile },
      {
        name: 'Default empty target rejects existing file',
        run: testDefaultEmptyTargetExistingFileFails,
      },
      {
        name: 'Default non-empty target rejects missing file',
        run: testDefaultMissingFileWithNonEmptyTargetFails,
      },
      { name: 'Default no match fails without writing', run: testDefaultNoMatchFailsWithoutWriting },
      {
        name: 'Default multiple matches rejected without allow_multiple',
        run: testDefaultMultipleMatchesRejectedWithoutAllowMultiple,
      },
      {
        name: 'Default allow_multiple replaces all matches',
        run: testDefaultAllowMultipleReplacesAllMatches,
      },
      { name: 'Default no-op fails without writing', run: testDefaultNoOpFailsWithoutWriting },
      {
        name: 'Default mode rejects different indentation',
        run: testDefaultRejectsDifferentIndentation,
      },
      {
        name: 'Default mode rejects different whitespace',
        run: testDefaultRejectsDifferentWhitespace,
      },
      {
        name: 'Default mode rejects small text difference',
        run: testDefaultRejectsSmallTextDifference,
      },
      {
        name: 'End line belongs to line before matched newline',
        run: testEndLineBelongsToLineBeforeMatchedNewline,
      },
      {
        name: 'replacement_line_count follows spec variants',
        run: testReplacementLineCountVariants,
      },
      {
        name: 'Placeholder warning writes successfully',
        run: testPlaceholderWarningWritesSuccessfully,
      },
      {
        name: 'Existing placeholder does not warn again',
        run: testExistingPlaceholderDoesNotWarnAgain,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
