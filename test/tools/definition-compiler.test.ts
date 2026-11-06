import { ConfigError } from '../../src/config/errors.js';
import type { JsonObject } from '../../src/config/json-file.js';
import type {
  CustomToolDefinitionDeclaration,
  LoadedCustomToolDefinition,
} from '../../src/tools/custom-tool-definition.js';
import {
  compileCustomToolDefinitions,
  type BuiltInToolDefinitionContract,
} from '../../src/tools/definition-compiler.js';
import { compileInputSchemaValidator } from '../../src/tools/input-schema-validator.js';
import { assert, assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';

function loaded(
  declaration: CustomToolDefinitionDeclaration,
  referenceId = 'source-ref',
  index = 0,
): LoadedCustomToolDefinition {
  return {
    declaration,
    source: {
      toolConfigFilePath: 'tool-config.json',
      definitionIndex: index,
      referenceId,
      toolDefinitionFilePath: `${referenceId}.json`,
    },
  };
}

function schema(): JsonObject {
  return {
    type: 'object',
    properties: { value: { type: 'string', description: 'Parameter help' } },
    required: ['value'],
    additionalProperties: false,
  };
}

function builtIn(description: string | undefined = 'Built-in help'): BuiltInToolDefinitionContract {
  const inputSchema = schema();
  return {
    definition: {
      name: 'read',
      ...(description === undefined ? {} : { description }),
      inputSchema,
    },
    implementationValidator: compileInputSchemaValidator(inputSchema),
  };
}

function compileOne(
  declaration: CustomToolDefinitionDeclaration,
  contracts: readonly BuiltInToolDefinitionContract[] = [],
) {
  const result = compileCustomToolDefinitions([loaded(declaration)], contracts)[0];
  assert(result !== undefined, 'Expected one compiled definition');
  return result;
}

function expectError(
  declaration: CustomToolDefinitionDeclaration,
  fieldPath: string,
  message: string,
  contracts: readonly BuiltInToolDefinitionContract[] = [],
): ConfigError {
  try {
    compileOne(declaration, contracts);
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Compilation failures use ConfigError');
    assertEqual(error.code, 'config_validation_failed', 'Compilation failures use validation code');
    assertEqual(
      error.configFilePath,
      'source-ref.json',
      'Compiler errors belong to the definition file',
    );
    assertEqual(error.fieldPath, fieldPath, 'Compiler errors identify the relevant field');
    assertIncludes(error.message, 'source-ref', 'Compiler errors retain reference id');
    assertIncludes(error.message, message, 'Compiler error explains the invalid declaration');
    assertIncludes(
      error.suggestion ?? '',
      'source-ref.json',
      'Recovery guidance retains actual file',
    );
    return error;
  }
  throw new Error('Expected compilation to fail');
}

function testStableIdentityAndCanonicalDefinition(): void {
  const contract = builtIn();
  const input = [
    loaded({
      name: 'read',
      $alias: 'read_tool',
      $inheritTopDescription: true,
      $inheritInputSchema: true,
    }),
    loaded({ name: 'custom', $alias: 'read', inputSchema: schema() }, 'custom-ref', 1),
  ];
  const compiled = compileCustomToolDefinitions(input, [contract]);
  assert(Object.isFrozen(compiled), 'Compiled collection is immutable');
  assertEqual(compiled.length, 2, 'Every loaded source should compile');
  const override = compiled[0];
  const custom = compiled[1];
  assert(override !== undefined && custom !== undefined, 'Both definitions should exist');
  assertEqual(override.stableName, 'read', 'Stable name is not replaced by alias');
  assertEqual(override.kind, 'built-in-override', 'Classification uses the stable name');
  assertEqual(override.definition.name, 'read_tool', 'Alias becomes the public name');
  assertEqual(override.definition.description, 'Built-in help', 'Top-level help can be inherited');
  assertEqual(
    override.validator,
    contract.implementationValidator,
    'Inherited schema reuses implementation validator',
  );
  assertEqual(custom.kind, 'custom-only', 'Alias matching a built-in does not create an override');
  assertEqual(custom.stableName, 'custom', 'Custom stable identity remains intact');
  assertEqual(custom.definition.name, 'read', 'Alias is not recursively resolved');
  assert(
    !('description' in custom.definition),
    'Omitted descriptions are absent, not undefined placeholders',
  );
  assertEqual(
    Object.keys(override.definition).sort().join(','),
    'description,inputSchema,name',
    'Project directives never escape the compiler',
  );
  assertEqual(
    custom.source.referenceId,
    'custom-ref',
    'Source metadata stays attached in reference order',
  );
  assertEqual(
    compileOne({ name: 'same', $alias: 'same', inputSchema: schema() }).definition.name,
    'same',
    'Self-alias is accepted',
  );
  assertEqual(
    compileOne({ name: 'plain', inputSchema: schema() }).definition.name,
    'plain',
    'No alias preserves the stable public name',
  );
  assertEqual(
    compileOne({ name: 'Read', inputSchema: schema() }, [contract]).kind,
    'custom-only',
    'Stable-name matching is case-sensitive',
  );
}

function testDescriptionCombinations(): void {
  const contract = builtIn();
  const cases: readonly [Partial<CustomToolDefinitionDeclaration>, string | undefined][] = [
    [{}, undefined],
    [{ $inheritTopDescription: false }, undefined],
    [{ description: '  Explicit help  ' }, '  Explicit help  '],
    [{ description: 'Explicit help', $inheritTopDescription: false }, 'Explicit help'],
    [{ $inheritTopDescription: true }, 'Built-in help'],
  ];
  for (const [fields, expected] of cases) {
    const compiled = compileOne({ name: 'read', inputSchema: schema(), ...fields }, [contract]);
    assertEqual(
      compiled.definition.description,
      expected,
      'Description combination resolves independently of the schema',
    );
    assertEqual(
      Object.hasOwn(compiled.definition, 'description'),
      expected !== undefined,
      'Absent descriptions omit the property',
    );
  }
  const noDescription: BuiltInToolDefinitionContract = {
    definition: { name: 'read', inputSchema: schema() },
    implementationValidator: contract.implementationValidator,
  };
  const inheritedAbsent = compileOne(
    { name: 'read', $inheritTopDescription: true, inputSchema: schema() },
    [noDescription],
  );
  assert(
    !Object.hasOwn(inheritedAbsent.definition, 'description'),
    'Inheriting an absent built-in description omits the property',
  );

  for (const fields of [
    {},
    { $inheritTopDescription: false },
    { description: 'Custom help', $inheritTopDescription: false },
  ]) {
    const compiled = compileOne({ name: 'custom', inputSchema: schema(), ...fields });
    assertEqual(
      compiled.definition.description,
      'description' in fields ? fields.description : undefined,
      'Custom-only descriptions are optional',
    );
  }
  expectError(
    { name: 'read', description: 'Conflict', $inheritTopDescription: true, inputSchema: schema() },
    '$inheritTopDescription',
    'mutually exclusive',
    [contract],
  );
  expectError(
    { name: 'custom', $inheritTopDescription: true, inputSchema: schema() },
    '$inheritTopDescription',
    'custom-only',
  );
}

function testSchemaCombinations(): void {
  const contract = builtIn();
  for (const fields of [{}, { $inheritInputSchema: false }]) {
    const compiled = compileOne({ name: 'read', inputSchema: schema(), ...fields }, [contract]);
    assert(
      compiled.validator !== contract.implementationValidator,
      'Explicit schemas compile a separate effective validator',
    );
    assert(compiled.validator.validate({ value: 'ok' }).valid, 'Explicit schema is compiled');
    assert(!compiled.validator.validate({ value: 1 }).valid, 'Explicit schema enforces its types');
  }
  const inherited = compileOne(
    { name: 'read', description: 'Custom top help', $inheritInputSchema: true },
    [contract],
  );
  assertEqual(
    inherited.validator,
    contract.implementationValidator,
    'Schema inheritance is independent of description override',
  );
  assertEqual(
    JSON.stringify(inherited.definition.inputSchema),
    JSON.stringify(contract.definition.inputSchema),
    'Inheritance retains parameter descriptions, required and unknown-field rules',
  );
  assert(!inherited.validator.validate({}).valid, 'Inherited required parameters remain enforced');
  assert(
    !inherited.validator.validate({ value: 'ok', extra: true }).valid,
    'Inherited unknown-field rules remain enforced',
  );
  for (const name of ['read', 'custom']) {
    for (const $inheritInputSchema of [undefined, false]) {
      expectError(
        { name, ...($inheritInputSchema === undefined ? {} : { $inheritInputSchema }) },
        'inputSchema',
        'required',
        [contract],
      );
    }
  }
  expectError(
    { name: 'read', inputSchema: schema(), $inheritInputSchema: true },
    '$inheritInputSchema',
    'mutually exclusive',
    [contract],
  );
  expectError({ name: 'custom', $inheritInputSchema: true }, '$inheritInputSchema', 'custom-only');
  expectError(
    { name: 'read', $alias: 'another', $inheritInputSchema: true },
    '$inheritInputSchema',
    'original built-in',
  );

  // Loaded custom definitions are not inheritance candidates, in either order.
  for (const declarations of [
    [
      { name: 'parent', inputSchema: schema() },
      { name: 'child', $alias: 'parent', $inheritInputSchema: true },
    ],
    [
      { name: 'child', $alias: 'parent', $inheritInputSchema: true },
      { name: 'parent', inputSchema: schema() },
    ],
  ] satisfies CustomToolDefinitionDeclaration[][]) {
    try {
      compileCustomToolDefinitions(
        declarations.map((declaration) => loaded(declaration)),
        [],
      );
      throw new Error('Custom-to-custom inheritance should fail');
    } catch (error: unknown) {
      assert(
        error instanceof ConfigError,
        'Custom definitions cannot supply an inheritance target',
      );
      assertEqual(
        error.fieldPath,
        '$inheritInputSchema',
        'Inheritance failure identifies the directive',
      );
    }
  }
}

function testProtocolShapeAndCompilationDiagnostics(): void {
  const cases: readonly [JsonObject, string, string][] = [
    [{ properties: {} }, 'inputSchema.type', 'exactly'],
    [{ type: ['object'] }, 'inputSchema.type', 'exactly'],
    [{ type: 'array' }, 'inputSchema.type', 'exactly'],
    [
      { type: 'object', $schema: 'http://json-schema.org/draft-07/schema#' },
      'inputSchema.$schema',
      'draft/2020-12',
    ],
    [{ type: 'object', $schema: null }, 'inputSchema.$schema', 'exactly'],
    [{ type: 'object', properties: [] }, 'inputSchema.properties', 'JSON object'],
    [{ type: 'object', properties: null }, 'inputSchema.properties', 'JSON object'],
    [
      { type: 'object', properties: { value: false } },
      'inputSchema.properties["value"]',
      'JSON object form',
    ],
    [
      { type: 'object', properties: { 'a.b': true } },
      'inputSchema.properties["a.b"]',
      'JSON object form',
    ],
    [{ type: 'object', required: 'value' }, 'inputSchema', 'compiled'],
    [{ type: 'object', $async: true }, 'inputSchema', 'Asynchronous'],
    [
      { type: 'object', properties: { value: { $ref: 'file:///not-available.json' } } },
      'inputSchema',
      'compiled',
    ],
  ];
  for (const [inputSchema, fieldPath, message] of cases) {
    const error = expectError({ name: 'custom', inputSchema }, fieldPath, message);
    if (fieldPath === 'inputSchema') {
      assert(error.cause instanceof Error, 'Schema compilation retains its cause');
    }
  }
}

function testIsolatedSynchronousValidatorsWithoutInputMutation(): void {
  const inputSchema: JsonObject = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://schemas.example.test/shared',
    type: 'object',
    $defs: { nonEmpty: { type: 'string', minLength: 1 } },
    properties: {
      value: { $ref: '#/$defs/nonEmpty' },
      optional: { type: 'string', default: 'not-injected' },
      emptyList: { type: 'array', items: false, maxItems: 0 },
      formatted: { type: 'string', format: 'workspace-private-format' },
      data: { type: 'object', default: { $alias: 'ordinary-data', $inheritInputSchema: true } },
    },
    required: ['value'],
    additionalProperties: false,
    $alias: 'schema-annotation-not-a-project-directive',
  };
  const publisher = loaded({ name: 'publisher', inputSchema }, 'publisher-ref');
  const consumer = loaded(
    {
      name: 'consumer',
      inputSchema: {
        type: 'object',
        properties: { value: { $ref: 'https://schemas.example.test/shared' } },
      },
    },
    'consumer-ref',
    1,
  );
  try {
    compileCustomToolDefinitions([publisher, consumer], []);
    throw new Error('Cross-document schema resolution should fail');
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Schemas have isolated resolver contexts');
    assertEqual(
      error.configFilePath,
      'consumer-ref.json',
      'Cross-document refs belong to the consuming definition',
    );
    assertIncludes(
      error.message,
      'consumer-ref',
      'Cross-document errors retain reference identity',
    );
  }
  const compiled = compileCustomToolDefinitions([publisher], [])[0];
  assert(compiled !== undefined, 'Local-ref schema should compile');
  const valid: Record<string, unknown> = {
    value: 'ok',
    emptyList: [],
    formatted: 'format-is-not-enforced',
    data: { $inheritTopDescription: true },
  };
  const beforeValid = JSON.stringify(valid);
  assert(
    compiled.validator.validate(valid).valid,
    'Local refs, nested boolean schemas and annotation data are supported',
  );
  assertEqual(
    JSON.stringify(valid),
    beforeValid,
    'Validation never injects defaults or rewrites ordinary data',
  );

  const invalid = { value: 7, unknown: 'retained' };
  const beforeInvalid = JSON.stringify(invalid);
  const result = compiled.validator.validate(invalid);
  assert(!result.valid, 'Types and unknown fields are enforced');
  assertEqual(
    JSON.stringify(invalid),
    beforeInvalid,
    'Validation neither coerces nor removes fields',
  );
  assert(result.errors.length >= 2, 'Validation retains multiple actionable errors');
  const errorsBefore = JSON.stringify(result.errors);
  compiled.validator.validate({ value: 'later' });
  assertEqual(
    JSON.stringify(result.errors),
    errorsBefore,
    'Later validation cannot mutate earlier results',
  );
  for (const value of [result, result.errors, result.errors[0], result.errors[0]?.params]) {
    assert(Object.isFrozen(value), 'Validation result snapshots are deeply immutable');
  }
}

function testSnapshotsDoNotMutateCallerObjects(): void {
  const contract = builtIn();
  const source = loaded({ name: 'read', $alias: 'read_tool', $inheritInputSchema: true });
  const explicit = loaded({ name: 'custom', inputSchema: schema() }, 'explicit-ref', 1);
  const before = JSON.stringify([source, explicit, contract.definition]);
  const compiled = compileCustomToolDefinitions([source, explicit], [contract]);
  const inherited = compiled[0];
  const custom = compiled[1];
  assert(inherited !== undefined && custom !== undefined, 'Both branches compile');
  assertEqual(
    JSON.stringify([source, explicit, contract.definition]),
    before,
    'Compilation does not modify source or built-in data',
  );
  for (const value of [
    source,
    source.source,
    source.declaration,
    explicit.declaration.inputSchema,
    contract,
    contract.definition,
    contract.definition.inputSchema,
  ]) {
    assert(!Object.isFrozen(value), 'Compilation must not freeze caller-owned objects');
  }
  for (const entry of compiled) {
    for (const value of [
      entry,
      entry.source,
      entry.definition,
      entry.definition.inputSchema,
      entry.definition.inputSchema.properties,
      entry.validator,
    ]) {
      assert(Object.isFrozen(value), 'Compiled entries and owned nested values are immutable');
    }
  }
  assert(inherited.source !== source.source, 'Compiler snapshots source metadata');
  assert(
    inherited.definition.inputSchema !== contract.definition.inputSchema,
    'Inherited schema is independently snapshotted',
  );
  assert(
    custom.definition.inputSchema !== explicit.declaration.inputSchema,
    'Explicit schema is independently snapshotted',
  );
  (source.source as { referenceId: string }).referenceId = 'changed';
  (contract.definition.inputSchema as Record<string, unknown>).required = [];
  (explicit.declaration.inputSchema as Record<string, unknown>).type = 'array';
  assertEqual(
    inherited.source.referenceId,
    'source-ref',
    'Source mutations cannot affect compiled metadata',
  );
  assertEqual(
    JSON.stringify(inherited.definition.inputSchema.required),
    '["value"]',
    'Built-in schema mutations cannot affect inherited definition',
  );
  assertEqual(
    custom.definition.inputSchema.type,
    'object',
    'Source schema mutations cannot affect compiled definition',
  );
}

function testInheritedValidatorIsNotRecompiledOrInvoked(): void {
  let validations = 0;
  const validator = Object.freeze({
    validate() {
      validations += 1;
      return { valid: true as const };
    },
  });
  const contract = {
    definition: {
      name: 'read',
      inputSchema: { type: 'object', $ref: 'trusted-contract-not-resolved-here' },
    },
    implementationValidator: validator,
  };
  const compiled = compileOne(
    { name: 'read', $alias: 'read_tool', description: 'Renamed only', $inheritInputSchema: true },
    [contract],
  );
  assertEqual(
    compiled.validator,
    validator,
    'Trusted inherited validator is reused directly rather than compiled again',
  );
  assertEqual(validations, 0, 'Compilation does not execute implementation validation');
}

await runTestSuite({
  title: 'Testing pure custom definition compilation',
  tests: [
    {
      name: 'separates stable identity, public definition and tool kind',
      run: testStableIdentityAndCanonicalDefinition,
    },
    { name: 'resolves all top-level description combinations', run: testDescriptionCombinations },
    {
      name: 'resolves schema combinations without custom inheritance',
      run: testSchemaCombinations,
    },
    {
      name: 'retains strict protocol shape and compilation diagnostics',
      run: testProtocolShapeAndCompilationDiagnostics,
    },
    {
      name: 'compiles isolated synchronous validators without input rewriting',
      run: testIsolatedSynchronousValidatorsWithoutInputMutation,
    },
    {
      name: 'deeply snapshots compiled values without modifying inputs',
      run: testSnapshotsDoNotMutateCallerObjects,
    },
    {
      name: 'does not compile or invoke inherited validators',
      run: testInheritedValidatorIsNotRecompiledOrInvoked,
    },
  ],
});
