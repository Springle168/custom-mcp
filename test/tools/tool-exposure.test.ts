import { pendingQuestions } from '../../src/tools/ask-user.js';
import {
  compileWorkspaceToolCatalog,
  type CompiledBuiltInTool,
  type ExternalToolExecutor,
  type ExternalToolInvocation,
} from '../../src/tools/catalog.js';
import type { JsonObject } from '../../src/config/json-file.js';
import type { ToolInvocationContext } from '../../src/runtime/tool-invocation-context.js';
import type { ToolRuntimeContext } from '../../src/runtime/tool-context.js';
import type { CompiledCustomToolDefinition } from '../../src/tools/custom-tool-config.js';
import { compileInputSchemaValidator } from '../../src/tools/input-schema-validator.js';
import type { ToolCallResult } from '../../src/tools/types.js';
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

function createInvocationContext(callId = 'call_tool_exposure'): ToolInvocationContext {
  return Object.freeze({
    callId,
    requestId: 'request_tool_exposure',
    sessionId: 'session_tool_exposure',
    signal: new AbortController().signal,
  });
}

function textResult(text: string): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
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
  builtInTools?: readonly CompiledBuiltInTool[];
  customDefinitions?: readonly CompiledCustomToolDefinition[];
  externalExecutor?: ExternalToolExecutor;
  exposure?:
    | { readonly mode: 'all' }
    | { readonly mode: 'enable' | 'disable'; readonly names: readonly string[] };
} = {}) {
  return compileWorkspaceToolCatalog({
    builtInTools: options.builtInTools ?? getCompiledBuiltInTools(),
    customDefinitions: options.customDefinitions ?? [],
    exposure: options.exposure ?? { mode: 'all' },
    workspaceConfigFilePath: 'E:/config/workspace.json',
    ...(options.externalExecutor === undefined
      ? {}
      : { externalExecutor: options.externalExecutor }),
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

  const effectiveFailure = await service.routeToolCall(
    'read_file',
    {},
    createContext(),
    createInvocationContext(),
  );
  assertIncludes(getResultText(effectiveFailure), 'configured input schema', 'Effective schema should run first');
  assert(
    !getResultText(effectiveFailure).includes('E:/tools/'),
    'Call validation errors should not expose local definition paths',
  );

  const implementationFailure = await service.routeToolCall(
    'read_file',
    { alias: 'x' },
    createContext(),
    createInvocationContext(),
  );
  assertIncludes(getResultText(implementationFailure), 'not supported by its current executor', 'Built-in implementation contract should protect overridden executors');
}

async function testCustomOnlyValidationAndUnavailableExecutor(): Promise<void> {
  const custom = customDefinition('custom_tool', {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  });
  const catalog = createCatalog({ customDefinitions: [custom] });
  const entry = catalog.effectiveEntries.find((candidate) => candidate.definition.name === 'custom_tool');
  assertEqual(
    entry?.binding,
    'unavailable',
    'Custom-only definitions without an external executor should retain the unavailable binding',
  );
  const service = createWorkspaceToolService(catalog);

  for (const args of [{}, null, [], 'value']) {
    const invalid = await service.routeToolCall(
      'custom_tool',
      args,
      createContext(),
      createInvocationContext(),
    );
    assertIncludes(
      getResultText(invalid),
      'configured input schema',
      'Custom-only tools should validate unchanged JSON arguments before routing',
    );
  }

  const unexpectedProperty = await service.routeToolCall(
    'custom_tool',
    { value: 'ok', remove_me: true },
    createContext(),
    createInvocationContext(),
  );
  assertIncludes(
    getResultText(unexpectedProperty),
    'unexpected property "remove_me"',
    'Additional-property errors should identify the argument the caller must remove',
  );

  const unavailable = await service.routeToolCall(
    'custom_tool',
    { value: 'ok' },
    createContext(),
    createInvocationContext(),
  );
  assertEqual(unavailable.isError, true, 'Unavailable executor should return a tool error');
  assertEqual(
    getResultText(unavailable),
    'Tool "custom_tool" is exposed, but no execution route is configured for it.',
    'Unavailable executor should return the deterministic route error',
  );
}

async function testCustomOnlyExternalRouteUsesSharedBinding(): Promise<void> {
  const custom = customDefinition('custom_tool', {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  });
  const invocations: ExternalToolInvocation[] = [];
  const externalExecutor: ExternalToolExecutor = {
    async execute(invocation) {
      invocations.push(invocation);
      return textResult('External custom tool completed.');
    },
  };
  const catalog = createCatalog({
    customDefinitions: [custom],
    externalExecutor,
  });
  const service = createWorkspaceToolService(catalog);
  const entry = catalog.effectiveEntries.find((candidate) => candidate.definition.name === 'custom_tool');
  assertEqual(entry?.binding, 'external', 'Custom-only definitions should bind the shared external executor');
  assertEqual(
    service.routeToolCall,
    catalog.routeToolCall,
    'Workspace service should retain the catalog-owned route binding',
  );

  const invalid = await service.routeToolCall(
    'custom_tool',
    {},
    createContext(),
    createInvocationContext(),
  );
  assertIncludes(
    getResultText(invalid),
    'configured input schema',
    'External routes should validate custom-only input before execution',
  );
  assertEqual(invocations.length, 0, 'Invalid external input must not reach the executor');

  const args = { value: 'ok' };
  const invocationContext = createInvocationContext('call_external_custom');
  const result = await service.routeToolCall(
    'custom_tool',
    args,
    createContext(),
    invocationContext,
  );
  assertEqual(getResultText(result), 'External custom tool completed.', 'External executor result should be returned');
  assertEqual(invocations.length, 1, 'Valid custom-only input should invoke the external executor once');
  const externalInvocation = invocations[0];
  assertEqual(externalInvocation?.callId, 'call_external_custom', 'External executor should receive the call ID');
  assertEqual(externalInvocation?.name, 'custom_tool', 'External executor should receive the tool name');
  assertEqual(externalInvocation?.arguments, args, 'External executor should receive the validated arguments');
  assertEqual(externalInvocation?.signal, invocationContext.signal, 'External executor should receive the call signal');
}

async function testOverrideRemainsBoundToBuiltInExecutor(): Promise<void> {
  const inputSchema = Object.freeze({
    type: 'object',
    properties: Object.freeze({ value: Object.freeze({ type: 'string' }) }),
    required: Object.freeze(['value']),
    additionalProperties: false,
  });
  const implementationValidator = compileInputSchemaValidator(inputSchema);
  let builtInCalls = 0;
  let externalCalls = 0;
  let receivedBuiltInArgs: Record<string, unknown> | undefined;
  let receivedBuiltInContext: ToolRuntimeContext | undefined;
  const builtIn: CompiledBuiltInTool = Object.freeze({
    definition: Object.freeze({
      name: 'bound_tool',
      description: 'Built-in route binding test tool',
      inputSchema,
    }),
    implementationValidator,
    executor: async (args: Record<string, unknown>, context: ToolRuntimeContext) => {
      builtInCalls++;
      receivedBuiltInArgs = args;
      receivedBuiltInContext = context;
      return textResult('Built-in tool completed.');
    },
  });
  const externalExecutor: ExternalToolExecutor = {
    async execute() {
      externalCalls++;
      return textResult('External tool completed.');
    },
  };
  const catalog = createCatalog({
    builtInTools: [builtIn],
    customDefinitions: [customDefinition('bound_tool', inputSchema)],
    externalExecutor,
  });
  const service = createWorkspaceToolService(catalog);
  const entry = catalog.effectiveEntries[0];
  assertEqual(entry?.binding, 'built-in', 'Overrides should retain their built-in route binding');

  const context = createContext();
  const args = { value: 'ok' };
  const result = await service.routeToolCall(
    'bound_tool',
    args,
    context,
    createInvocationContext('call_override'),
  );
  assertEqual(getResultText(result), 'Built-in tool completed.', 'Override should return the built-in executor result');
  assertEqual(builtInCalls, 1, 'Override should invoke its built-in executor');
  assertEqual(externalCalls, 0, 'Override must not invoke the external executor');
  assertEqual(receivedBuiltInArgs, args, 'Built-in executor should receive its tool arguments');
  assertEqual(receivedBuiltInContext, context, 'Built-in executor should receive workspace runtime context');
}

async function testHiddenAndUnknownDoNotValidateOrExecute(): Promise<void> {
  const original = customDefinition('custom_tool');
  let validationCalls = 0;
  let executionCalls = 0;
  const custom: CompiledCustomToolDefinition = Object.freeze({
    ...original,
    validator: Object.freeze({
      validate(value: unknown) {
        validationCalls++;
        return original.validator.validate(value);
      },
    }),
  });
  const externalExecutor: ExternalToolExecutor = {
    async execute() {
      executionCalls++;
      return textResult('Unexpected external execution.');
    },
  };
  const service = createWorkspaceToolService(createCatalog({
    customDefinitions: [custom],
    externalExecutor,
    exposure: { mode: 'enable', names: ['read_file'] },
  }));

  for (const name of ['write_file', 'never_registered']) {
    const result = await service.routeToolCall(
      name,
      null,
      createContext(),
      createInvocationContext(),
    );
    assertEqual(getResultText(result), `Unknown tool: ${name}`, 'Hidden and unknown tools should be indistinguishable');
  }
  const hiddenCustom = await service.routeToolCall(
    'custom_tool',
    null,
    createContext(),
    createInvocationContext(),
  );
  assertEqual(
    getResultText(hiddenCustom),
    'Unknown tool: custom_tool',
    'Hidden custom-only tools should share the unknown-tool boundary',
  );
  assertEqual(validationCalls, 0, 'Hidden and unknown routes must not run schema validation');
  assertEqual(executionCalls, 0, 'Hidden and unknown routes must not run external executors');
}

async function testDisabledAskUserDoesNotReachExecutor(): Promise<void> {
  const service = createWorkspaceToolService(createCatalog({
    exposure: { mode: 'disable', names: ['ask_user'] },
  }));
  const beforeCount = pendingQuestions.size;
  await service.routeToolCall('ask_user', {
    questions: [{ question: 'Proceed?', header: 'Confirm', type: 'yesno' }],
  }, createContext(), createInvocationContext());
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
      { name: 'custom-only external route uses shared binding', run: testCustomOnlyExternalRouteUsesSharedBinding },
      { name: 'override remains bound to its built-in executor', run: testOverrideRemainsBoundToBuiltInExecutor },
      { name: 'hidden and unknown tools do not validate or execute', run: testHiddenAndUnknownDoNotValidateOrExecute },
      { name: 'disabled ask_user does not reach executor', run: testDisabledAskUserDoesNotReachExecutor },
      { name: 'catalog and service facades are frozen', run: testCatalogAndServiceFacadesAreFrozen },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
