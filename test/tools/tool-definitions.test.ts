import { getAllToolDefinitions, getCompiledBuiltInTools } from '../../src/tools/index.js';
import type { ToolName } from '../../src/tools/names.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

function testToolDefinitionsDoNotExposeOutputSchema(): void {
  const definitions = getAllToolDefinitions();

  for (const definition of definitions) {
    assert(
      !('outputSchema' in definition),
      `${definition.name} should not expose MCP outputSchema`,
    );
  }
}

function validateBuiltInArguments(name: ToolName, args: unknown): boolean {
  const compiledTool = getCompiledBuiltInTools().find(({ definition }) => definition.name === name);
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
    {
      files: [
        {
          file_path: '',
          replacements: [{ target: 'a', replacement: 'b' }],
        },
      ],
    },
    'replace_text should reject an empty file_path',
  );
  assertInvalid(
    'replace_text',
    {
      files: [
        {
          file_path: 'a.txt',
          allow_multiple: 'yes',
          replacements: [{ target: 'a', replacement: 'b' }],
        },
      ],
    },
    'replace_text should reject non-boolean allow_multiple',
  );
  assertInvalid(
    'replace_text',
    {
      files: [
        {
          file_path: 'a.txt',
          replacements: [{ target: 'a', replacement: 'b', extra: true }],
        },
      ],
    },
    'replace_text should reject unknown properties',
  );
  assertValid(
    'replace_text',
    {
      files: [
        {
          file_path: 'a.txt',
          replacements: [{ target: '', replacement: '' }],
        },
      ],
    },
    'replace_text should leave empty-target mode semantics to the handler',
  );

  assertInvalid('write_file', { content: '' }, 'write_file should require file_path');
  assertInvalid('write_file', { file_path: 'a.txt' }, 'write_file should require content');
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

  assertInvalid('read', { include: [] }, 'read should require at least one selector');
  assertInvalid('read', { include: [''] }, 'read should require non-empty string selectors');
  assertInvalid(
    'read',
    { include: [{ file_path: '' }] },
    'read should require a literal object path',
  );
  assertInvalid(
    'read',
    { include: [{ file_path: 'a.txt', start_line: 0 }] },
    'read should require positive numeric ranges',
  );
  assertInvalid(
    'read',
    { include: [{ file_path: 'a.txt', read_mode: 'regex', start_line: '' }] },
    'read should require non-empty regex patterns',
  );
  assertInvalid(
    'read',
    { include: [{ file_path: 'a.txt', read_mode: 'unknown' }] },
    'read should validate the range mode',
  );
  assertInvalid(
    'read',
    { include: [{ file_path: 'a.txt', extra: true }] },
    'read should reject unknown object options',
  );
  assertValid(
    'read',
    { include: ['*.txt', { file_path: 'a.txt', read_mode: 'line', start_line: '1' }] },
    'read should leave mode-specific range relationships to per-request semantics',
  );
  for (const shallow_read of [false, true, 1, Number.MAX_SAFE_INTEGER]) {
    assertValid(
      'read',
      { include: ['a.txt'], shallow_read },
      'read should accept boolean or safe positive integer shallow_read',
    );
  }
  for (const shallow_read of [0, -1, 1.5, '1024', Number.MAX_SAFE_INTEGER + 1]) {
    assertInvalid(
      'read',
      { include: ['a.txt'], shallow_read },
      'read should reject invalid shallow_read values',
    );
  }
  assertValid(
    'read',
    {
      include: ['a.txt', { file_path: 'a.txt', show_line_numbers: false }],
      show_line_numbers: true,
    },
    'read should accept per-request line-number overrides',
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
      {
        name: 'tool definitions do not expose outputSchema',
        run: testToolDefinitionsDoNotExposeOutputSchema,
      },
      {
        name: 'built-in schemas own structural contracts',
        run: testBuiltInSchemasOwnStructuralContracts,
      },
      { name: 'write_file rejects unknown properties', run: testWriteFileRejectsUnknownProperties },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
