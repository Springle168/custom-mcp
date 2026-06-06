import { getAllToolDefinitions } from '../../src/tools/index.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';
import {
  assertDeepEqual,
  callReplace,
  cleanupFixtures,
  createTestToolContext,
  parseResultJson,
  resetFixtures,
  writeFixture,
} from './helpers.js';

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

function testInputSchemaUsesV2FieldsOnly(): void {
  const definition = getReplaceDefinition();
  const inputSchema = asRecord(definition.inputSchema, 'inputSchema should be an object');
  const properties = asRecord(inputSchema.properties, 'properties should be an object');

  assertDeepEqual(
    Object.keys(properties).sort(),
    [
      'allow_multiple',
      'file_path',
      'match_mode',
      'regex_flags',
      'replacement',
      'target',
    ],
    'replace_text schema should expose only v2.1 input fields',
  );
  assert(!('old_string' in properties), 'old_string should not be a schema property');
  assert(!('new_string' in properties), 'new_string should not be a schema property');
}

function testInputSchemaRequiredAndAdditionalProperties(): void {
  const definition = getReplaceDefinition();
  const inputSchema = asRecord(definition.inputSchema, 'inputSchema should be an object');

  assertDeepEqual(
    inputSchema.required,
    ['file_path', 'target', 'replacement'],
    'inputSchema required should match v2 required fields',
  );
  assertEqual(
    inputSchema.additionalProperties,
    false,
    'inputSchema should reject additional properties',
  );
}

function testMatchModeSchema(): void {
  const definition = getReplaceDefinition();
  const inputSchema = asRecord(definition.inputSchema, 'inputSchema should be an object');
  const properties = asRecord(inputSchema.properties, 'properties should be an object');
  const matchMode = asRecord(
    properties.match_mode,
    'match_mode property should be an object',
  );

  assertEqual(matchMode.type, 'string', 'match_mode should be a string');
  assertDeepEqual(
    matchMode.enum,
    ['default', 'regex'],
    'match_mode enum should be default | regex',
  );
}

function testDescriptionsDocumentV2Boundaries(): void {
  const definition = getReplaceDefinition();
  const description = String(definition.description ?? '').toLowerCase();
  const inputSchema = asRecord(definition.inputSchema, 'inputSchema should be an object');
  const properties = asRecord(inputSchema.properties, 'properties should be an object');

  assertIncludes(description, 'target', 'Tool description should mention target');
  assertIncludes(
    description,
    'replacement',
    'Tool description should mention replacement',
  );
  assertIncludes(description, 'default', 'Tool description should mention default mode');
  assertIncludes(description, 'regex', 'Tool description should mention regex mode');
  assertIncludes(
    description,
    'regex_flags',
    'Tool description should mention regex_flags',
  );
  assertIncludes(description, 'dotall', 'Tool description should mention dotAll');
  assertIncludes(
    description,
    'unknown',
    'Tool description should mention unknown field rejection',
  );

  assertIncludes(
    String(asRecord(properties.target, 'target schema should be object').description),
    'literal',
    'target description should document default literal behavior',
  );
  assertIncludes(
    String(asRecord(properties.target, 'target schema should be object').description),
    'RegExp',
    'target description should document regex RegExp behavior',
  );
  assertIncludes(
    String(
      asRecord(properties.replacement, 'replacement schema should be object')
        .description,
    ),
    '$!n',
    'replacement description should document regex capture syntax',
  );
  const regexFlagsDescription = String(
    asRecord(properties.regex_flags, 'regex_flags schema should be object')
      .description,
  );
  assertIncludes(
    regexFlagsDescription,
    'g is always enabled',
    'regex_flags description should document forced global matching',
  );
  assertIncludes(
    regexFlagsDescription,
    "'.' must not match newlines",
    'regex_flags description should document disabling dotAll',
  );
}

function testNoOutputSchemaOnDefinition(): void {
  const definition = getReplaceDefinition();
  assert(
    !('outputSchema' in definition),
    'replace_text should not expose MCP outputSchema',
  );
}

async function testToolResultHasNoStructuredContent(): Promise<void> {
  await resetFixtures();
  await writeFixture('schema-result.txt', 'alpha\n');

  const result = await callReplace(
    {
      file_path: 'schema-result.txt',
      target: 'alpha',
      replacement: 'beta',
    },
    createTestToolContext(),
  );

  assert(
    !('structuredContent' in result),
    'Tool call result should not include structuredContent',
  );
  parseResultJson(result);
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text v2 schema tests',
    details: 'Covers tools/list schema, prompt descriptions, and output transport shape.',
    afterAll: cleanupFixtures,
    tests: [
      {
        name: 'Input schema exposes v2 fields only',
        run: testInputSchemaUsesV2FieldsOnly,
      },
      {
        name: 'Input schema required fields and additionalProperties',
        run: testInputSchemaRequiredAndAdditionalProperties,
      },
      {
        name: 'Input schema defines match_mode enum',
        run: testMatchModeSchema,
      },
      {
        name: 'Descriptions document v2 boundaries',
        run: testDescriptionsDocumentV2Boundaries,
      },
      {
        name: 'Definition does not expose outputSchema',
        run: testNoOutputSchemaOnDefinition,
      },
      {
        name: 'Tool result does not expose structuredContent',
        run: testToolResultHasNoStructuredContent,
      },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
