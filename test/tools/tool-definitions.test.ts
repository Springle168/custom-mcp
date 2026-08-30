import {
  getAllToolDefinitions,
  getCompiledBuiltInTools,
} from '../../src/tools/index.js';
import type { ToolName } from '../../src/tools/names.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

function testToolDefinitionsDoNotExposeOutputSchema(): void {
  const definitions = getAllToolDefinitions();

  for (const definition of definitions) {
    assert(!('outputSchema' in definition), `${definition.name} should not expose MCP outputSchema`);
  }
}

function validateBuiltInArguments(name: ToolName, args: unknown): boolean {
  const compiledTool = getCompiledBuiltInTools().find(
    ({ definition }) => definition.name === name,
  );
  assert(compiledTool !== undefined, `${name} should be registered`);
  return compiledTool.implementationValidator.validate(args).valid;
}

function assertValid(name: ToolName, args: unknown, message: string): void {
  assert(validateBuiltInArguments(name, args), message);
}

function assertInvalid(name: ToolName, args: unknown, message: string): void {
  assert(!validateBuiltInArguments(name, args), message);
}

function testBuiltInSchemasOwnStructuralContracts(): void {
  assertInvalid(
    'replace_text',
    { file_path: '', target: 'a', replacement: 'b' },
    'replace_text should reject an empty file_path',
  );
  assertInvalid(
    'replace_text',
    { file_path: 'a.txt', target: 'a', replacement: 'b', allow_multiple: 'yes' },
    'replace_text should reject non-boolean allow_multiple',
  );
  assertInvalid(
    'replace_text',
    { file_path: 'a.txt', target: 'a', replacement: 'b', extra: true },
    'replace_text should reject unknown properties',
  );
  assertValid(
    'replace_text',
    { file_path: 'a.txt', target: '', replacement: '' },
    'replace_text should leave empty-target mode semantics to the handler',
  );

  assertInvalid(
    'write_file',
    { file_path: '', content: '' },
    'write_file should reject an empty file_path',
  );
  assertInvalid(
    'write_file',
    { file_path: 'a.txt', content: 1 },
    'write_file should reject non-string content',
  );
  assertValid(
    'write_file',
    { file_path: 'a.txt', content: '' },
    'write_file should accept empty content',
  );

  assertInvalid(
    'read_file',
    { file_path: '' },
    'read_file should reject an empty file_path',
  );
  assertInvalid(
    'read_file',
    { file_path: 'a.txt', start_line: 0 },
    'read_file should reject non-positive numeric ranges',
  );
  assertInvalid(
    'read_file',
    { file_path: 'a.txt', read_mode: 'regex', start_line: '' },
    'read_file should reject empty regex range patterns',
  );
  assertValid(
    'read_file',
    { file_path: 'a.txt', read_mode: 'line', start_line: '1' },
    'read_file should leave mode-specific range types to the handler',
  );

  assertInvalid(
    'read_many_files',
    { include: [] },
    'read_many_files should reject an empty include array',
  );
  assertInvalid(
    'read_many_files',
    { include: ['a.txt'], shallow_read_content_limit_bytes: Number.MAX_SAFE_INTEGER + 1 },
    'read_many_files should reject unsafe integer limits',
  );
  assertValid(
    'read_many_files',
    { include: ['a.txt'], shallow_read_content_limit_bytes: 1 },
    'read_many_files should leave the shallow_read dependency to the handler',
  );

  assertInvalid(
    'discover_guidelines',
    { include: [''] },
    'discover_guidelines should reject empty include items',
  );
  assertInvalid(
    'discover_guidelines',
    { include: ['a.md'], use_ignore_files: 'yes' },
    'discover_guidelines should reject non-boolean use_ignore_files',
  );

  assertInvalid(
    'ask_user',
    { questions: [{ question: '', header: 'Scope', type: 'text' }] },
    'ask_user should reject an empty question',
  );
  assertInvalid(
    'ask_user',
    {
      questions: [{
        question: 'Choose?',
        header: 'Scope',
        type: 'choice',
        options: [
          { label: '   ', description: 'Blank label' },
          { label: 'Valid', description: 'Valid label' },
        ],
      }],
    },
    'ask_user should reject whitespace-only option labels',
  );
  assertValid(
    'ask_user',
    { questions: [{ question: 'Choose?', header: 'Scope', type: 'choice' }] },
    'ask_user should leave the choice-options dependency to the handler',
  );

  for (const name of ['android_assembleDebug', 'android_testDebugUnitTest'] as const) {
    assertInvalid(name, { offline: 'yes' }, `${name} should reject non-boolean options`);
    assertInvalid(name, { profile: true }, `${name} should reject unknown properties`);
    assertValid(name, {}, `${name} should accept omitted options`);
  }
}

function testWriteFileRejectsUnknownProperties(): void {
  const definition = getAllToolDefinitions().find(({ name }) => name === 'write_file');
  assert(definition !== undefined, 'write_file definition should be registered');

  assertEqual(
    definition.inputSchema.additionalProperties,
    false,
    'write_file input schema should reject unknown properties',
  );

  assertInvalid(
    'write_file',
    { file_path: 'example.txt', content: 'content', unexpected: true },
    'write_file implementation validator should reject unknown properties',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing tool definitions response shape',
    tests: [
      { name: 'tool definitions do not expose outputSchema', run: testToolDefinitionsDoNotExposeOutputSchema },
      { name: 'built-in schemas own structural contracts', run: testBuiltInSchemasOwnStructuralContracts },
      { name: 'write_file rejects unknown properties', run: testWriteFileRejectsUnknownProperties },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
