import { getAllToolDefinitions } from '../../src/tools/index.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';
import {
  assertDeepEqual,
  createReplaceTextFixtureHarness,
  parseResultJson,
} from './helpers.js';

const {
  callReplace,
  cleanupFixtures,
  createTestToolContext,
  resetFixtures,
  writeFixture,
} = createReplaceTextFixtureHarness('schema');

function getReplaceDefinition(): Record<string, unknown> {
  const definition = getAllToolDefinitions().find((tool) => tool.name === 'replace_text');
  assert(definition !== undefined, 'replace_text definition should be registered');
  return definition as unknown as Record<string, unknown>;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  assert(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    message,
  );
  return value as Record<string, unknown>;
}

function getSchemaLayers(): {
  inputSchema: Record<string, unknown>;
  files: Record<string, unknown>;
  fileItem: Record<string, unknown>;
  fileProperties: Record<string, unknown>;
  replacements: Record<string, unknown>;
  replacementItem: Record<string, unknown>;
  replacementProperties: Record<string, unknown>;
} {
  const definition = getReplaceDefinition();
  const inputSchema = asRecord(definition.inputSchema, 'inputSchema should be an object');
  const rootProperties = asRecord(inputSchema.properties, 'root properties should be an object');
  const files = asRecord(rootProperties.files, 'files should be an object');
  const fileItem = asRecord(files.items, 'files items should be an object');
  const fileProperties = asRecord(fileItem.properties, 'file properties should be an object');
  const replacements = asRecord(fileProperties.replacements, 'replacements should be an object');
  const replacementItem = asRecord(replacements.items, 'replacement items should be an object');
  const replacementProperties = asRecord(
    replacementItem.properties,
    'replacement properties should be an object',
  );
  return {
    inputSchema,
    files,
    fileItem,
    fileProperties,
    replacements,
    replacementItem,
    replacementProperties,
  };
}

function testInputSchemaUsesBatchShape(): void {
  const {
    inputSchema,
    files,
    fileItem,
    fileProperties,
    replacements,
    replacementItem,
    replacementProperties,
  } = getSchemaLayers();

  assertDeepEqual(inputSchema.required, ['files'], 'Root should require files');
  assertEqual(inputSchema.additionalProperties, false, 'Root should reject unknown fields');
  assertEqual(files.type, 'array', 'files should be an array');
  assertEqual(files.minItems, 1, 'files should be non-empty');
  assertDeepEqual(
    Object.keys(fileProperties).sort(),
    ['allow_multiple', 'file_path', 'match_mode', 'regex_flags', 'replacements'],
    'File items should expose only file-scoped fields',
  );
  assertDeepEqual(fileItem.required, ['file_path', 'replacements'], 'File item required fields');
  assertEqual(fileItem.additionalProperties, false, 'File items should reject unknown fields');
  assertEqual(
    asRecord(fileProperties.file_path, 'file_path schema').minLength,
    1,
    'file_path should be non-empty',
  );
  assertEqual(replacements.type, 'array', 'replacements should be an array');
  assertEqual(replacements.minItems, 1, 'replacements should be non-empty');
  assertDeepEqual(
    Object.keys(replacementProperties).sort(),
    ['replacement', 'target'],
    'Replacement items should expose target and replacement',
  );
  assertDeepEqual(
    replacementItem.required,
    ['target', 'replacement'],
    'Replacement item required fields',
  );
  assertEqual(
    replacementItem.additionalProperties,
    false,
    'Replacement items should reject unknown fields',
  );
}

function testMatchModeSchema(): void {
  const { fileProperties } = getSchemaLayers();
  const matchMode = asRecord(fileProperties.match_mode, 'match_mode schema');
  assertDeepEqual(matchMode.enum, ['default', 'regex'], 'match_mode enum');
}

function testDescriptionsFollowSchemaResponsibilities(): void {
  const definition = getReplaceDefinition();
  const description = String(definition.description ?? '').toLowerCase();
  const {
    files,
    fileProperties,
    replacements,
    replacementProperties,
  } = getSchemaLayers();

  assertIncludes(description, 'ordered batch', 'Tool description should describe batching');
  assertIncludes(description, 'does not roll back', 'Tool description should describe partial success');
  assert(!description.includes('regex_flags'), 'Tool description should not duplicate nested flag details');

  assertIncludes(String(files.description).toLowerCase(), 'ordered', 'files should describe ordering');
  assertIncludes(String(files.description).toLowerCase(), 'repeated path', 'files should describe repeated paths');
  assertIncludes(
    String(replacements.description),
    're-reads',
    'replacements should describe state refresh',
  );
  assertIncludes(
    String(asRecord(fileProperties.allow_multiple, 'allow_multiple schema').description),
    'exactly one',
    'allow_multiple should describe match-count behavior',
  );
  assertIncludes(
    String(asRecord(fileProperties.regex_flags, 'regex_flags schema').description),
    'g is always enabled',
    'regex_flags should describe forced global matching',
  );
  assertIncludes(
    String(asRecord(replacementProperties.target, 'target schema').description),
    'exact literal',
    'target should describe default matching',
  );
  assertIncludes(
    String(asRecord(replacementProperties.replacement, 'replacement schema').description),
    '$!n',
    'replacement should describe capture expansion',
  );
}

function testNoOutputSchemaOnDefinition(): void {
  const definition = getReplaceDefinition();
  assert(!('outputSchema' in definition), 'replace_text should not expose MCP outputSchema');
}

async function testToolResultHasNoStructuredContent(): Promise<void> {
  await resetFixtures();
  await writeFixture('schema-result.txt', 'alpha\n');
  const result = await callReplace({
    file_path: 'schema-result.txt',
    target: 'alpha',
    replacement: 'beta',
  }, createTestToolContext());
  assert(!('structuredContent' in result), 'Tool result should not include structuredContent');
  parseResultJson(result);
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text batch schema tests',
    details: 'Covers nested input schema, layered descriptions, and output transport shape.',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'Input schema uses strict non-empty batch shape', run: testInputSchemaUsesBatchShape },
      { name: 'Input schema defines match_mode enum', run: testMatchModeSchema },
      { name: 'Descriptions follow schema-layer responsibilities', run: testDescriptionsFollowSchemaResponsibilities },
      { name: 'Definition does not expose outputSchema', run: testNoOutputSchemaOnDefinition },
      { name: 'Tool result does not expose structuredContent', run: testToolResultHasNoStructuredContent },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
