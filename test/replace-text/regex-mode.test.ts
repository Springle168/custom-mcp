import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';
import {
  assertErrorResult,
  assertFixtureContent,
  assertJsonNoteIncludes,
  assertNoSpan,
  assertSpan,
  assertSuccessResult,
  callReplace,
  cleanupFixtures,
  fixtureExists,
  resetFixtures,
  writeFixture,
} from './helpers.js';

async function testRegexSingleMatch(): Promise<void> {
  await resetFixtures();
  await writeFixture('single.txt', 'one\nabc-123\nthree\n');

  const result = await callReplace({
    file_path: 'single.txt',
    target: '[a-z]+-\\d+',
    replacement: 'matched',
    match_mode: 'regex',
  });

  const json = assertSuccessResult(result);
  assertEqual(json.match_mode, 'regex', 'Should report regex mode');
  assertEqual(json.matched_targets, 1, 'Regex should match once');
  assertEqual(json.replacement_count, 1, 'Regex should replace once');
  assertSpan(json, 2, 2, 'Regex single-match span');
  await assertFixtureContent(
    'single.txt',
    'one\nmatched\nthree\n',
    'Regex single match should be replaced',
  );
}

async function testRegexCrossLineDotAllSpan(): Promise<void> {
  await resetFixtures();
  await writeFixture('dotall.txt', 'before\nstart\nmiddle\nend\nafter\n');

  const result = await callReplace({
    file_path: 'dotall.txt',
    target: 'start.*end',
    replacement: 'done',
    match_mode: 'regex',
  });

  const json = assertSuccessResult(result);
  assertSpan(json, 2, 4, 'Regex dot-all cross-line span');
  assertEqual(json.file_line_count.previous, 6, 'Previous line count');
  assertEqual(json.file_line_count.current, 4, 'Current line count after multi-line collapse');
  await assertFixtureContent(
    'dotall.txt',
    'before\ndone\nafter\n',
    'Regex dot should cross line because s flag is enabled by default',
  );
}

async function testRegexFlagsCanDisableDotAll(): Promise<void> {
  await resetFixtures();
  await writeFixture('flags-no-dotall.txt', 'before\nstart end\nstart\nmiddle\nend\nafter\n');

  const result = await callReplace({
    file_path: 'flags-no-dotall.txt',
    target: '^start.*end$',
    replacement: 'done',
    match_mode: 'regex',
    regex_flags: 'm',
  });

  const json = assertSuccessResult(result);
  assertSpan(json, 2, 2, 'Regex flags without s should keep dot line-local');
  await assertFixtureContent(
    'flags-no-dotall.txt',
    'before\ndone\nstart\nmiddle\nend\nafter\n',
    'regex_flags=m should disable dotAll while preserving multiline anchors',
  );
}

async function testRegexFlagsCanDisableMultilineAnchors(): Promise<void> {
  await resetFixtures();
  await writeFixture('flags-no-multiline.txt', 'before\ntarget\nafter\n');

  const result = await callReplace({
    file_path: 'flags-no-multiline.txt',
    target: '^target$',
    replacement: 'hit',
    match_mode: 'regex',
    regex_flags: 's',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 0, 'Regex flags without m should not match line anchors');
  assertNoSpan(json, 'Regex flags without m should have no span');
  await assertFixtureContent(
    'flags-no-multiline.txt',
    'before\ntarget\nafter\n',
    'regex_flags=s should disable multiline anchors',
  );
}

async function testRegexFlagsEmptyUsesGlobalOnly(): Promise<void> {
  await resetFixtures();
  await writeFixture('flags-global-only.txt', 'before\nstart end\nstart\nmiddle\nend\nafter\n');

  const result = await callReplace({
    file_path: 'flags-global-only.txt',
    target: 'start.*end',
    replacement: 'done',
    match_mode: 'regex',
    regex_flags: '',
  });

  const json = assertSuccessResult(result);
  assertSpan(json, 2, 2, 'Empty regex_flags should compile with global flag only');
  await assertFixtureContent(
    'flags-global-only.txt',
    'before\ndone\nstart\nmiddle\nend\nafter\n',
    'Empty regex_flags should disable m and s while retaining global scan',
  );
}

async function testRegexFlagsExplicitGWarns(): Promise<void> {
  await resetFixtures();
  await writeFixture('flags-explicit-g.txt', 'id=7\n');

  const result = await callReplace({
    file_path: 'flags-explicit-g.txt',
    target: 'id=(\\d)',
    replacement: 'id:$!1',
    match_mode: 'regex',
    regex_flags: 'gm',
  });

  const json = assertSuccessResult(result);
  assertJsonNoteIncludes(json, "'g'", 'Explicit g flag should warn');
  await assertFixtureContent(
    'flags-explicit-g.txt',
    'id:7\n',
    'Explicit g in regex_flags should still succeed',
  );
}

async function testRegexMultilineMatchWarns(): Promise<void> {
  await resetFixtures();
  await writeFixture('dotall-warning.txt', 'before\nstart\nmiddle\nend\nafter\n');

  const result = await callReplace({
    file_path: 'dotall-warning.txt',
    target: 'start.*end',
    replacement: 'done',
    match_mode: 'regex',
  });

  const json = assertSuccessResult(result);
  assertSpan(json, 2, 4, 'Regex dotAll warning span');
  assertJsonNoteIncludes(json, 'matched across multiple lines', 'Multiline regex match warning');
}

async function testRegexMultilineAnchors(): Promise<void> {
  await resetFixtures();
  await writeFixture('multiline-anchor.txt', 'one\ntarget\nthree\n');

  const result = await callReplace({
    file_path: 'multiline-anchor.txt',
    target: '^target$',
    replacement: 'hit',
    match_mode: 'regex',
  });

  const json = assertSuccessResult(result);
  assertSpan(json, 2, 2, 'Regex m flag should allow line anchors');
  await assertFixtureContent(
    'multiline-anchor.txt',
    'one\nhit\nthree\n',
    'Regex ^ and $ should operate in multiline mode',
  );
}

async function testRegexSlashSyntaxIsLiteralPatternText(): Promise<void> {
  await resetFixtures();
  await writeFixture('slash-syntax.txt', 'foo\n');

  const result = await callReplace({
    file_path: 'slash-syntax.txt',
    target: '/foo/g',
    replacement: 'bar',
    match_mode: 'regex',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 0, 'Slash syntax should not match bare foo');
  assertNoSpan(json, 'Slash syntax no-match span');
  await assertFixtureContent(
    'slash-syntax.txt',
    'foo\n',
    'Slash syntax should not be interpreted as /pattern/flags',
  );
}

async function testRegexDoesNotUseDefaultLiteralMatching(): Promise<void> {
  await resetFixtures();
  await writeFixture('no-fallback.txt', 'hello world\n');

  const result = await callReplace({
    file_path: 'no-fallback.txt',
    target: 'hello   world',
    replacement: 'matched',
    match_mode: 'regex',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 0, 'Regex no-match should not use default literal matching');
  assertNoSpan(json, 'Regex no default literal match should have no span');
  await assertFixtureContent(
    'no-fallback.txt',
    'hello world\n',
    'Regex no-match should not write via default literal matching',
  );
}

async function testRegexMultipleMatchesRejectedWithoutAllowMultiple(): Promise<void> {
  await resetFixtures();
  await writeFixture('multi-reject.txt', 'id=1\nmid\nid=2\n');

  const result = await callReplace({
    file_path: 'multi-reject.txt',
    target: 'id=\\d',
    replacement: 'id=x',
    match_mode: 'regex',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 2, 'Regex multi-match rejection should report matches');
  assertEqual(json.replacement_count, 0, 'Regex multi-match rejection should not replace');
  assertSpan(json, 1, 3, 'Regex multi-match rejection span');
  await assertFixtureContent(
    'multi-reject.txt',
    'id=1\nmid\nid=2\n',
    'Regex multi-match rejection should not write',
  );
}

async function testRegexAllowMultipleReplacesAllMatches(): Promise<void> {
  await resetFixtures();
  await writeFixture('multi-allow.txt', 'id=1\nmid\nid=2\n');

  const result = await callReplace({
    file_path: 'multi-allow.txt',
    target: 'id=(\\d)',
    replacement: 'id:$!1',
    allow_multiple: true,
    match_mode: 'regex',
  });

  const json = assertSuccessResult(result);
  assertEqual(json.allow_multiple, true, 'Should echo allow_multiple=true');
  assertEqual(json.matched_targets, 2, 'Regex allow_multiple should match all');
  assertEqual(json.replacement_count, 2, 'Regex allow_multiple should replace all');
  assertSpan(json, 1, 3, 'Regex allow_multiple span should cover all matches');
  await assertFixtureContent(
    'multi-allow.txt',
    'id:1\nmid\nid:2\n',
    'Regex allow_multiple should replace every match',
  );
}

async function testRegexInvalidPatternFailsWithoutWriting(): Promise<void> {
  await resetFixtures();
  await writeFixture('invalid-pattern.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'invalid-pattern.txt',
    target: '(',
    replacement: 'beta',
    match_mode: 'regex',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 0, 'Invalid regex should report zero matches');
  assertNoSpan(json, 'Invalid regex should not report span');
  await assertFixtureContent(
    'invalid-pattern.txt',
    'alpha\n',
    'Invalid regex should not write',
  );
}

async function testRegexEmptyTargetFailsWithoutCreating(): Promise<void> {
  await resetFixtures();

  const result = await callReplace({
    file_path: 'regex-empty-target.txt',
    target: '',
    replacement: 'created',
    match_mode: 'regex',
  });

  const json = assertErrorResult(result);
  assertEqual(json.file_line_count.previous, 0, 'Regex empty target previous line count');
  assertEqual(json.file_line_count.current, 0, 'Regex empty target current line count');
  assertNoSpan(json, 'Regex empty target should not report span');
  assertEqual(
    await fixtureExists('regex-empty-target.txt'),
    false,
    'Regex empty target should not create a file',
  );
}

async function testRegexMissingFileFailsWithoutCreating(): Promise<void> {
  await resetFixtures();

  const result = await callReplace({
    file_path: 'regex-missing-file.txt',
    target: 'alpha',
    replacement: 'beta',
    match_mode: 'regex',
  });

  const json = assertErrorResult(result);
  assertEqual(json.file_line_count.previous, 0, 'Regex missing file previous line count');
  assertEqual(json.file_line_count.current, 0, 'Regex missing file current line count');
  assertNoSpan(json, 'Regex missing file should not report span');
  assertEqual(
    await fixtureExists('regex-missing-file.txt'),
    false,
    'Regex missing file should not create a file',
  );
}

async function testRegexZeroLengthMatchFailsWithoutPartialWrite(): Promise<void> {
  await resetFixtures();
  await writeFixture('zero-length.txt', 'aaa\n');

  const result = await callReplace({
    file_path: 'zero-length.txt',
    target: 'a*',
    replacement: 'b',
    allow_multiple: true,
    match_mode: 'regex',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 0, 'Zero-length regex failure should report zero matches');
  assertEqual(json.replacement_count, 0, 'Zero-length regex failure should not replace');
  assertNoSpan(json, 'Zero-length regex failure should not report span');
  await assertFixtureContent(
    'zero-length.txt',
    'aaa\n',
    'Zero-length regex failure should not partially write',
  );
}

async function testRegexCaptureGroupsAndWholeMatch(): Promise<void> {
  await resetFixtures();
  await writeFixture('captures-basic.txt', 'name: Ada Lovelace\n');

  const result = await callReplace({
    file_path: 'captures-basic.txt',
    target: 'name: (\\w+) (\\w+)',
    replacement: '$!2, $!1 ($!0)',
    match_mode: 'regex',
  });

  const json = assertSuccessResult(result);
  assertEqual(json.replacement_line_count, 1, 'Capture replacement should count one input line');
  await assertFixtureContent(
    'captures-basic.txt',
    'Lovelace, Ada (name: Ada Lovelace)\n',
    'Regex should expand $!0, $!1, and $!2',
  );
}

async function testRegexMultiDigitAndLeadingZeroCaptureGroups(): Promise<void> {
  await resetFixtures();
  await writeFixture('captures-numbering.txt', 'abcdefghij\n');

  const result = await callReplace({
    file_path: 'captures-numbering.txt',
    target: '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)',
    replacement: '$!10|$!1-0|$!01|$!00',
    match_mode: 'regex',
  });

  assertSuccessResult(result);
  await assertFixtureContent(
    'captures-numbering.txt',
    'j|a-0|a|abcdefghij\n',
    '$!10 should use group 10, while $!01 and $!00 use leading-zero rules',
  );
}

async function testRegexMissingAndUnmatchedCaptureGroupsBecomeEmpty(): Promise<void> {
  await resetFixtures();
  await writeFixture('captures-empty.txt', 'foo\n');

  const result = await callReplace({
    file_path: 'captures-empty.txt',
    target: '(foo)(bar)?',
    replacement: '$!1:$!2:$!3',
    match_mode: 'regex',
  });

  assertSuccessResult(result);
  await assertFixtureContent(
    'captures-empty.txt',
    'foo::\n',
    'Unmatched and missing capture groups should expand to empty strings',
  );
}

async function testRegexDollarEscaping(): Promise<void> {
  await resetFixtures();
  await writeFixture('dollar-escaping.txt', 'abc\n');

  const result = await callReplace({
    file_path: 'dollar-escaping.txt',
    target: '(abc)',
    replacement: '$$|$$!1|$$$!1',
    match_mode: 'regex',
  });

  assertSuccessResult(result);
  await assertFixtureContent(
    'dollar-escaping.txt',
    '$|$!1|$abc\n',
    'Regex replacement should apply $$ before $!n capture expansion',
  );
}

async function testRegexNativeReplacementSyntaxStaysLiteral(): Promise<void> {
  await resetFixtures();
  await writeFixture('native-syntax.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'native-syntax.txt',
    target: '(alpha)',
    replacement: "$1|$&|$`|$'|$!1",
    match_mode: 'regex',
  });

  assertSuccessResult(result);
  await assertFixtureContent(
    'native-syntax.txt',
    "$1|$&|$`|$'|alpha\n",
    'Regex replacement should not use JavaScript native replacement tokens',
  );
}

async function testRegexInvalidCaptureSyntaxWarnsButWritesLiteral(): Promise<void> {
  await resetFixtures();
  await writeFixture('invalid-capture-syntax.txt', 'abc\n');

  const result = await callReplace({
    file_path: 'invalid-capture-syntax.txt',
    target: '(abc)',
    replacement: '$!|$!x|$!1',
    match_mode: 'regex',
  });

  const json = assertSuccessResult(result);
  assert(typeof json.note === 'string', 'Invalid $! syntax should include note');
  assertJsonNoteIncludes(json, '$!', 'Invalid $! syntax note should mention capture syntax');
  await assertFixtureContent(
    'invalid-capture-syntax.txt',
    '$!|$!x|abc\n',
    'Invalid $! syntax should be written literally while valid capture expands',
  );
}

async function testRegexNoOpWholeMatchFails(): Promise<void> {
  await resetFixtures();
  await writeFixture('no-op-whole-match.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'no-op-whole-match.txt',
    target: '(alpha)',
    replacement: '$!0',
    match_mode: 'regex',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 1, 'Regex no-op should report actual match count');
  assertEqual(json.replacement_count, 0, 'Regex no-op should not replace');
  assertSpan(json, 1, 1, 'Regex no-op should report actual span');
  await assertFixtureContent(
    'no-op-whole-match.txt',
    'alpha\n',
    'Regex no-op should not write',
  );
}

async function testRegexNoOpExpandedCaptureFails(): Promise<void> {
  await resetFixtures();
  await writeFixture('no-op-capture.txt', 'alpha\n');

  const result = await callReplace({
    file_path: 'no-op-capture.txt',
    target: '(al)(pha)',
    replacement: '$!1$!2',
    match_mode: 'regex',
  });

  const json = assertErrorResult(result);
  assertEqual(json.matched_targets, 1, 'Capture no-op should report one match');
  assertEqual(json.replacement_count, 0, 'Capture no-op should not replace');
  assertSpan(json, 1, 1, 'Capture no-op should report span');
  await assertFixtureContent(
    'no-op-capture.txt',
    'alpha\n',
    'Capture-expanded no-op should not write',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text v2 regex mode tests',
    details: 'Covers explicit regex matching, default gms behavior, regex_flags, capture replacement syntax, no fallback, no-op, and zero-length safety.',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'Regex single match replaces once', run: testRegexSingleMatch },
      { name: 'Regex dot-all matches across lines', run: testRegexCrossLineDotAllSpan },
      {
        name: 'regex_flags can disable dotAll',
        run: testRegexFlagsCanDisableDotAll,
      },
      {
        name: 'regex_flags can disable multiline anchors',
        run: testRegexFlagsCanDisableMultilineAnchors,
      },
      {
        name: 'regex_flags empty string uses global only',
        run: testRegexFlagsEmptyUsesGlobalOnly,
      },
      {
        name: 'regex_flags explicit g warns',
        run: testRegexFlagsExplicitGWarns,
      },
      {
        name: 'Regex multiline match warns',
        run: testRegexMultilineMatchWarns,
      },
      { name: 'Regex multiline anchors match per line', run: testRegexMultilineAnchors },
      { name: 'Regex slash syntax is not /pattern/flags', run: testRegexSlashSyntaxIsLiteralPatternText },
      {
        name: 'Regex mode does not use default literal matching',
        run: testRegexDoesNotUseDefaultLiteralMatching,
      },
      {
        name: 'Regex multiple matches rejected without allow_multiple',
        run: testRegexMultipleMatchesRejectedWithoutAllowMultiple,
      },
      {
        name: 'Regex allow_multiple replaces all matches',
        run: testRegexAllowMultipleReplacesAllMatches,
      },
      { name: 'Regex invalid pattern fails without writing', run: testRegexInvalidPatternFailsWithoutWriting },
      { name: 'Regex empty target fails without creating', run: testRegexEmptyTargetFailsWithoutCreating },
      { name: 'Regex missing file fails without creating', run: testRegexMissingFileFailsWithoutCreating },
      { name: 'Regex zero-length match fails without partial write', run: testRegexZeroLengthMatchFailsWithoutPartialWrite },
      { name: 'Regex expands whole match and capture groups', run: testRegexCaptureGroupsAndWholeMatch },
      {
        name: 'Regex supports multi-digit and leading-zero captures',
        run: testRegexMultiDigitAndLeadingZeroCaptureGroups,
      },
      {
        name: 'Regex missing and unmatched captures become empty',
        run: testRegexMissingAndUnmatchedCaptureGroupsBecomeEmpty,
      },
      { name: 'Regex dollar escaping follows $$/ $!n rules', run: testRegexDollarEscaping },
      {
        name: 'Regex native replacement syntax stays literal',
        run: testRegexNativeReplacementSyntaxStaysLiteral,
      },
      {
        name: 'Regex invalid $! syntax warns but writes literal',
        run: testRegexInvalidCaptureSyntaxWarnsButWritesLiteral,
      },
      { name: 'Regex $!0 no-op fails', run: testRegexNoOpWholeMatchFails },
      {
        name: 'Regex expanded capture no-op fails',
        run: testRegexNoOpExpandedCaptureFails,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
