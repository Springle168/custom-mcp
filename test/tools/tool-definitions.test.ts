import {
  getAllToolDefinitions,
  getCompiledBuiltInTools,
} from '../../src/tools/index.js';
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

function testWriteFileRejectsUnknownProperties(): void {
  const definition = getAllToolDefinitions().find(({ name }) => name === 'write_file');
  assert(definition !== undefined, 'write_file definition should be registered');

  assertEqual(
    definition.inputSchema.additionalProperties,
    false,
    'write_file input schema should reject unknown properties',
  );

  const compiledTool = getCompiledBuiltInTools().find(
    ({ definition: builtInDefinition }) => builtInDefinition.name === 'write_file',
  );
  assert(compiledTool !== undefined, 'compiled write_file tool should be registered');
  const result = compiledTool.implementationValidator.validate({
    file_path: 'example.txt',
    content: 'content',
    unexpected: true,
  });
  assert(!result.valid, 'write_file implementation validator should reject unknown properties');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing tool definitions response shape',
    tests: [
      { name: 'tool definitions do not expose outputSchema', run: testToolDefinitionsDoNotExposeOutputSchema },
      { name: 'write_file rejects unknown properties', run: testWriteFileRejectsUnknownProperties },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
