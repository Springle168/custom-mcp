import { pendingQuestions } from '../../src/tools/ask-user.js';
import { compileWorkspaceToolCatalog } from '../../src/tools/catalog.js';
import type { JsonObject } from '../../src/config/json-file.js';
import type { CompiledCustomToolDefinition } from '../../src/tools/custom-tool-config.js';
import { compileInputSchemaValidator } from '../../src/tools/input-schema-validator.js';
import {
  createWorkspaceToolService,
  getAllToolDefinitions,
  getCompiledBuiltInTools,
} from '../../src/tools/index.js';
import { TOOL_NAMES } from '../../src/tools/names.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';

function definitionNames(definitions: readonly { readonly name: string }[]): string[] {
  return definitions.map((definition) => definition.name);
}

function createContext() {
  return createTestToolRuntimeContext({ rootDir: process.cwd() });
}

function customDefinition(
  name: string,
  inputSchema: JsonObject = {
    type: 'object',
    additionalProperties: false,
  },
  description = `Custom definition for ${name}`,
  index = 0,
): CompiledCustomToolDefinition {
  const definition = Object.freeze({
    name,
    description,
    inputSchema: Object.freeze(inputSchema),
  });
  return Object.freeze({
    definition,
    validator: compileInputSchemaValidator(definition.inputSchema),
    source: Object.freeze({
      toolConfigFilePath: 'E:/tools/tool-config.json',
      definitionIndex: index,
      referenceId: `ref-${index}`,
      toolDefinitionFilePath: `E:/tools/${name}.json`,
    }),
  });
}

function createCatalog(options: {
  customDefinitions?: readonly CompiledCustomToolDefinition[];
  exposure?:
    | { readonly mode: 'all' }
    | { readonly mode: 'enable' | 'disable'; readonly names: readonly string[] };
} = {}) {
  return compileWorkspaceToolCatalog({
    builtInTools: getCompiledBuiltInTools(),
    customDefinitions: options.customDefinitions ?? [],
    exposure: options.exposure ?? { mode: 'all' },
    workspaceConfigFilePath: 'E:/config/workspace.json',
  });
}

function testRegistryMatchesCanonicalNames(): void {
  const names = definitionNames(getAllToolDefinitions());
  assertEqual(names.join(','), TOOL_NAMES.join(','), 'Built-in registry order should remain canonical');
  assertEqual(new Set(names).size, names.length, 'Built-in registry names should be unique');
}

function testOverrideAndCustomOnlyOrdering(): void {
  const readOverride = customDefinition(
    'read_file',
    { type: 'object', properties: { alias: { type: 'string' } }, required: ['alias'] },
    'Workspace read contract',
    0,
  );
  const firstCustom = customDefinition('custom.first', undefined, undefined, 1);
  const secondCustom = customDefinition('custom.second', undefined, undefined, 2);
  const catalog = createCatalog({ customDefinitions: [readOverride, firstCustom, secondCustom] });
  const names = definitionNames(catalog.definitions);

  assertEqual(names.slice(0, TOOL_NAMES.length).join(','), TOOL_NAMES.join(','), 'Override should retain the built-in position');
  assertEqual(names.slice(TOOL_NAMES.length).join(','), 'custom.first,custom.second', 'Custom-only tools should append in reference order');
  const effectiveRead = catalog.definitions.find((definition) => definition.name === 'read_file');
  assertEqual(effectiveRead?.description, 'Workspace read contract', 'Override should replace the public description');
  assertEqual(effectiveRead?.inputSchema, readOverride.definition.inputSchema, 'Override should replace the public schema without merging');
}

function testExposureFiltersWithoutReordering(): void {
  const custom = customDefinition('custom_tool');
  const enabled = createCatalog({
    customDefinitions: [custom],
    exposure: { mode: 'enable', names: ['custom_tool', 'read_file', 'replace_text'] },
  });
  assertEqual(
    definitionNames(enabled.definitions).join(','),
    'replace_text,read_file,custom_tool',
    'Enabled selector should filter canonical/effective order rather than selector order',
  );

  const disabled = createCatalog({
    customDefinitions: [custom],
    exposure: { mode: 'disable', names: ['read_file', 'custom_tool'] },
  });
  assert(!definitionNames(disabled.definitions).includes('read_file'), 'Disabled built-in should be removed');
  assert(!definitionNames(disabled.definitions).includes('custom_tool'), 'Disabled custom tool should be removed');
}

async function testOverrideUsesBothContracts(): Promise<void> {
  const override = customDefinition('read_file', {
    type: 'object',
    properties: { alias: { type: 'string' } },
    required: ['alias'],
    additionalProperties: false,
  });
  const service = createWorkspaceToolService(createCatalog({ customDefinitions: [override] }));

  const effectiveFailure = await service.routeToolCall('read_file', {}, createContext());
  assertIncludes(getResultText(effectiveFailure), 'configured input schema', 'Effective schema should run first');
  assert(
    !getResultText(effectiveFailure).includes('E:/tools/'),
    'Call validation errors should not expose local definition paths',
  );

  const implementationFailure = await service.routeToolCall('read_file', { alias: 'x' }, createContext());
  assertIncludes(getResultText(implementationFailure), 'not supported by its current executor', 'Built-in implementation contract should protect overridden executors');
}

async function testCustomOnlyValidationAndUnavailableExecutor(): Promise<void> {
  const custom = customDefinition('custom_tool', {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  });
  const service = createWorkspaceToolService(createCatalog({ customDefinitions: [custom] }));

  for (const args of [{}, null, [], 'value']) {
    const invalid = await service.routeToolCall('custom_tool', args, createContext());
    assertIncludes(
      getResultText(invalid),
      'configured input schema',
      'Custom-only tools should validate unchanged JSON arguments before routing',
    );
  }

  const unavailable = await service.routeToolCall('custom_tool', { value: 'ok' }, createContext());
  assertEqual(unavailable.isError, true, 'Unavailable executor should return a tool error');
  assertEqual(
    getResultText(unavailable),
    'Tool "custom_tool" is exposed, but no execution route is configured for it.',
    'Unavailable executor should return the deterministic route error',
  );
}

async function testHiddenAndUnknownShareBoundary(): Promise<void> {
  const service = createWorkspaceToolService(createCatalog({
    exposure: { mode: 'enable', names: ['read_file'] },
  }));
  for (const name of ['write_file', 'never_registered']) {
    const result = await service.routeToolCall(name, null, createContext());
    assertEqual(getResultText(result), `Unknown tool: ${name}`, 'Hidden and unknown tools should be indistinguishable');
  }
}

async function testDisabledAskUserDoesNotReachExecutor(): Promise<void> {
  const service = createWorkspaceToolService(createCatalog({
    exposure: { mode: 'disable', names: ['ask_user'] },
  }));
  const beforeCount = pendingQuestions.size;
  await service.routeToolCall('ask_user', {
    questions: [{ question: 'Proceed?', header: 'Confirm', type: 'yesno' }],
  }, createContext());
  assertEqual(pendingQuestions.size, beforeCount, 'Hidden ask_user should not create pending state');
}

function testCatalogAndServiceFacadesAreFrozen(): void {
  const catalog = createCatalog();
  const service = createWorkspaceToolService(catalog);
  assert(Object.isFrozen(catalog), 'Catalog facade should be frozen');
  assert(Object.isFrozen(catalog.effectiveEntries), 'Effective entries should be frozen');
  assert(Object.isFrozen(catalog.exposedEntries), 'Exposed entries should be frozen');
  assert(Object.isFrozen(catalog.definitions), 'Definitions view should be frozen');
  assert(Object.isFrozen(service), 'Workspace tool service should be frozen');
  assertEqual(service.getDefinitions(), catalog.definitions, 'Service should expose the catalog-owned definitions view');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing effective workspace tool catalog',
    tests: [
      { name: 'built-in registry remains canonical', run: testRegistryMatchesCanonicalNames },
      { name: 'override and custom-only ordering', run: testOverrideAndCustomOnlyOrdering },
      { name: 'exposure filters without reordering', run: testExposureFiltersWithoutReordering },
      { name: 'override uses effective and implementation contracts', run: testOverrideUsesBothContracts },
      { name: 'custom-only validation precedes unavailable executor', run: testCustomOnlyValidationAndUnavailableExecutor },
      { name: 'hidden and unknown tools share a boundary', run: testHiddenAndUnknownShareBoundary },
      { name: 'disabled ask_user does not reach executor', run: testDisabledAskUserDoesNotReachExecutor },
      { name: 'catalog and service facades are frozen', run: testCatalogAndServiceFacadesAreFrozen },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
