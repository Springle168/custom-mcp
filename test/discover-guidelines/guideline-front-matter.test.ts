import {
  MAX_GUIDELINE_DESCRIPTION_CODE_POINTS,
  MAX_GUIDELINE_NAME_CODE_POINTS,
  parseGuidelineFrontMatter,
} from '../../src/engine/guideline-front-matter.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

function parse(source: string, prefixContainsWholeFile = true) {
  return parseGuidelineFrontMatter(source, prefixContainsWholeFile);
}

function testParsesSupportedYamlScalars(): void {
  const metadata = parse(`\uFEFF---\r
name: "release\\nnotes"\r
description: >\r
  Generate release notes\r
  from changes.\r
extra:\r
  deeply:\r
    nested: true\r
---\r
BODY MUST NOT BE RETURNED`);

  assert(metadata !== null, 'Valid BOM and CRLF Front Matter should parse');
  assertEqual(metadata.name, 'release\nnotes', 'Quoted escapes should be resolved');
  assertEqual(
    metadata.description,
    'Generate release notes from changes.\n',
    'Folded block scalars should retain YAML semantics',
  );
}

function testRequiresOpeningDelimiterAtStart(): void {
  assertEqual(
    parse('\n---\nname: x\ndescription: y\n---\n'),
    null,
    'A leading blank line should invalidate Front Matter',
  );
  assertEqual(
    parse(' ---\nname: x\ndescription: y\n---\n'),
    null,
    'Opening delimiter whitespace should be rejected',
  );
}

function testRequiresStrictClosingDelimiter(): void {
  assertEqual(
    parse('---\nname: x\ndescription: y\n--- \n'),
    null,
    'Closing delimiter trailing whitespace should be rejected',
  );
  assertEqual(
    parse('---\nname: x\ndescription: y\n'),
    null,
    'Unclosed Front Matter should be rejected',
  );
  assert(
    parse('---\nname: x\ndescription: y\n---') !== null,
    'A closing delimiter at actual EOF should be accepted',
  );
  assertEqual(
    parse('---\nname: x\ndescription: y\n---', false),
    null,
    'A prefix-limit boundary must not be treated as actual EOF',
  );
}

function testRejectsInvalidYamlShapes(): void {
  const invalidSources = [
    '---\nname: [\ndescription: y\n---\n',
    '---\n- name\n- description\n---\n',
    '---\nname: x\nname: y\ndescription: z\n---\n',
    '---\nname: x\n---\n',
    '---\nname: 42\ndescription: y\n---\n',
    '---\nname: x\ndescription: false\n---\n',
    '---\nname: "   "\ndescription: y\n---\n',
    '---\nname: x\ndescription: " "\n---\n',
  ];

  for (const source of invalidSources) {
    assertEqual(parse(source), null, `Invalid metadata should be ignored: ${source}`);
  }
}

function testRejectsAliasProvidedRequiredFields(): void {
  assertEqual(
    parse(`---
base: &name aliased
name: *name
description: direct
---
`),
    null,
    'An alias node must not satisfy a required direct scalar',
  );
  assert(
    parse(`---
name: direct
description: direct
extra: &value nested
copy: *value
---
`) !== null,
    'Aliases in ignored extra fields need not invalidate direct metadata',
  );
}

function testEnforcesUnicodeCodePointLimits(): void {
  const maxName = '😀'.repeat(MAX_GUIDELINE_NAME_CODE_POINTS);
  const maxDescription = '界'.repeat(MAX_GUIDELINE_DESCRIPTION_CODE_POINTS);
  const metadata = parse(`---\nname: ${maxName}\ndescription: ${maxDescription}\n---\n`);
  assert(metadata !== null, 'Fields at Unicode code point limits should parse');
  assertEqual(
    parse(`---\nname: ${maxName}x\ndescription: ok\n---\n`),
    null,
    'Names above the code point limit should be rejected',
  );
  assertEqual(
    parse(`---\nname: ok\ndescription: ${maxDescription}x\n---\n`),
    null,
    'Descriptions above the code point limit should be rejected',
  );
}

function testPreservesValidScalarText(): void {
  const metadata = parse(
    '---\nname: "  spaced name  "\ndescription: "  spaced description  "\n---\n',
  );
  assert(metadata !== null, 'Non-empty strings with surrounding whitespace are valid');
  assertEqual(metadata.name, '  spaced name  ', 'Name should not be normalized');
  assertEqual(
    metadata.description,
    '  spaced description  ',
    'Description should not be normalized',
  );
}

await runTestSuite({
  title: 'Guideline Front Matter Engine Tests',
  tests: [
    { name: 'Parses supported YAML scalar forms', run: testParsesSupportedYamlScalars },
    { name: 'Requires opening delimiter at file start', run: testRequiresOpeningDelimiterAtStart },
    { name: 'Requires a strict closing delimiter', run: testRequiresStrictClosingDelimiter },
    { name: 'Rejects invalid YAML and metadata shapes', run: testRejectsInvalidYamlShapes },
    { name: 'Rejects alias-provided required fields', run: testRejectsAliasProvidedRequiredFields },
    { name: 'Enforces Unicode code point limits', run: testEnforcesUnicodeCodePointLimits },
    { name: 'Preserves valid scalar text', run: testPreservesValidScalarText },
  ],
});
