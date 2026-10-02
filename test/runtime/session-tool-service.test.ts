import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileWorkspaceToolCatalog, type CompiledBuiltInTool } from '../../src/tools/catalog.js';
import type { CompiledCustomToolDefinition } from '../../src/tools/custom-tool-config.js';
import { createWorkspaceToolService, type WorkspaceToolService } from '../../src/tools/index.js';
import { compileInputSchemaValidator } from '../../src/tools/input-schema-validator.js';
import type { JsonObject } from '../../src/config/json-file.js';
import { createSessionToolService } from '../../src/runtime/mcp/session-tool-service.js';
import { createToolCallRequestHandler } from '../../src/runtime/invocation/tool-call-handler.js';
import { runWithRequestHeaderContext } from '../../src/runtime/request/request-context.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request/request-header-view.js';
import type { ToolInvocationContext } from '../../src/runtime/invocation/tool-invocation-context.js';
import { createTestConfigStore, createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import { assert, assertEqual, assertIncludes, getResultText, runTestSuite } from '../test-utils.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const context = createTestToolRuntimeContext({ rootDir: ROOT_DIR });
const invocation: ToolInvocationContext = Object.freeze({ callId: 'call_session_view', requestId: undefined, sessionId: undefined, signal: new AbortController().signal });

function spyWorkspace() {
  const definitions = Object.freeze(['built_in', 'custom_tool', 'last_tool'].map((name) => Object.freeze({
    name, description: name, inputSchema: Object.freeze({ type: 'object' }),
  })));
  let calls = 0;
  let seenArgs: unknown;
  let seenContext: unknown;
  let seenInvocation: unknown;
  const result = { content: [{ type: 'text' as const, text: 'shared result' }], isError: false };
  const service: WorkspaceToolService = Object.freeze({
    getDefinitions: () => definitions,
    async routeToolCall(_name, args, toolContext, toolInvocation) {
      calls++;
      seenArgs = args;
      seenContext = toolContext;
      seenInvocation = toolInvocation;
      return result;
    },
  } satisfies WorkspaceToolService);
  return { service, result, calls: () => calls, seenArgs: () => seenArgs, seenContext: () => seenContext, seenInvocation: () => seenInvocation };
}

async function testIntersectionOrderAndAdmission(): Promise<void> {
  const workspace = spyWorkspace();
  const requested = ['last_tool', 'not_exposed', 'custom_tool', 'workspace_disabled'];
  const session = createSessionToolService(workspace.service, requested);
  requested.push('built_in');
  assertEqual(session.getDefinitions().map((definition) => definition.name).join(','), 'custom_tool,last_tool', 'Intersection should preserve workspace ordering and ignore later input changes');
  assert(Object.isFrozen(session) && Object.isFrozen(session.getDefinitions()), 'View and definition array should be frozen');
  assertEqual(session.getDefinitions(), session.getDefinitions(), 'View should be stable');
  assertEqual(session.getDefinitions()[0], workspace.service.getDefinitions()[1], 'Definitions should be reused rather than copied or recompiled');
  for (const name of ['built_in', 'not_exposed', 'workspace_disabled']) {
    const result = await session.routeToolCall(name, {}, context, invocation);
    assertEqual(getResultText(result), `Unknown tool: ${name}`, 'Hidden and unknown calls should use the normal unknown tool result');
    assertEqual(result.isError, true, 'Admission failure should be a ToolCallResult error');
  }
  assertEqual(workspace.calls(), 0, 'Rejected calls must not enter workspace validators or executors');
  const args = { value: 'shared' };
  const result = await session.routeToolCall('custom_tool', args, context, invocation);
  assertEqual(result, workspace.result, 'Allowed results should pass through unmodified');
  assertEqual(workspace.seenArgs(), args, 'Argument identity should be preserved');
  assertEqual(workspace.seenContext(), context, 'Runtime resources should be shared');
  assertEqual(workspace.seenInvocation(), invocation, 'Cancellation and invocation identity should be preserved');
}

async function testDefaultEmptyAndSessionIsolation(): Promise<void> {
  const workspace = spyWorkspace();
  const defaults = createSessionToolService(workspace.service);
  assertEqual(defaults.getDefinitions().length, 3, 'Absent selection should preserve the workspace catalog');
  for (const requested of [[], ['unknown'], ['BUILT_IN']]) {
    const empty = createSessionToolService(workspace.service, requested);
    assertEqual(empty.getDefinitions().length, 0, 'Empty and completely filtered selections should remain empty');
    assertEqual((await empty.routeToolCall('built_in', {}, context, invocation)).isError, true, 'An empty list must also block calls');
  }
  const first = createSessionToolService(workspace.service, ['built_in']);
  const second = createSessionToolService(workspace.service, ['custom_tool']);
  await first.routeToolCall('built_in', {}, context, invocation);
  await second.routeToolCall('custom_tool', {}, context, invocation);
  assertEqual((await first.routeToolCall('custom_tool', {}, context, invocation)).isError, true, 'Session A must not adopt B selection');
  assertEqual((await second.routeToolCall('built_in', {}, context, invocation)).isError, true, 'Session B must not adopt A selection');
  assertEqual(workspace.calls(), 2, 'Allowed calls in both sessions should share the workspace service');
  assertEqual(workspace.service.getDefinitions().length, 3, 'Session selection must not mutate workspace exposure');
}

function custom(name: string, schema: JsonObject): CompiledCustomToolDefinition {
  return {
    definition: Object.freeze({ name, description: name, inputSchema: schema }),
    validator: compileInputSchemaValidator(schema),
    source: { toolConfigFilePath: 'tool-config.json', definitionIndex: 0, referenceId: name, toolDefinitionFilePath: `${name}.json` },
  };
}

async function testCatalogContractsAndExternalBindingsRemainShared(): Promise<void> {
  let builtInCalls = 0;
  let externalCalls = 0;
  const builtIn: CompiledBuiltInTool = {
    definition: { name: 'override_tool', description: 'built-in', inputSchema: { type: 'object' } },
    implementationValidator: compileInputSchemaValidator({ type: 'object', required: ['implementation'] }),
    executor: async () => {
      builtInCalls++;
      return { content: [{ type: 'text', text: 'built-in' }], isError: false };
    },
  };
  const catalog = compileWorkspaceToolCatalog({
    builtInTools: [builtIn],
    customDefinitions: [
      custom('override_tool', { type: 'object', required: ['effective'] }),
      custom('external_tool', { type: 'object', required: ['value'] }),
      custom('unavailable_tool', { type: 'object' }),
      custom('disabled_tool', { type: 'object' }),
    ],
    exposure: { mode: 'disable', names: ['disabled_tool'] },
    workspaceConfigFilePath: 'workspace.json',
    externalBindingsByDefinitionId: new Map([['external_tool', {
      execute: async () => {
        externalCalls++;
        return { content: [{ type: 'text', text: `external-${externalCalls}` }], isError: false };
      },
    }]]),
  });
  const workspace = createWorkspaceToolService(catalog);
  const first = createSessionToolService(workspace, ['override_tool', 'external_tool', 'unavailable_tool', 'disabled_tool']);
  const second = createSessionToolService(workspace, ['external_tool']);
  assertIncludes(getResultText(await first.routeToolCall('override_tool', {}, context, invocation)), 'configured input schema', 'Effective validation must remain active');
  assertIncludes(getResultText(await first.routeToolCall('override_tool', { effective: true }, context, invocation)), 'current executor', 'Implementation validation must remain active');
  assertEqual(builtInCalls, 0, 'Failed validators must still stop executors');
  await first.routeToolCall('override_tool', { effective: true, implementation: true }, context, invocation);
  assertEqual(builtInCalls, 1, 'A valid override should reuse the built-in executor');
  assertIncludes(getResultText(await first.routeToolCall('external_tool', {}, context, invocation)), 'configured input schema', 'Custom-only validation remains active');
  assertEqual(getResultText(await first.routeToolCall('external_tool', { value: true }, context, invocation)), 'external-1', 'First session should use original binding');
  assertEqual(getResultText(await second.routeToolCall('external_tool', { value: true }, context, invocation)), 'external-2', 'Second session should share original binding state');
  assertIncludes(getResultText(await first.routeToolCall('unavailable_tool', {}, context, invocation)), 'no execution route', 'Unavailable binding must retain normal route error');
  assertEqual(getResultText(await first.routeToolCall('disabled_tool', {}, context, invocation)), 'Unknown tool: disabled_tool', 'Session request cannot restore workspace-disabled tools');
}

async function testAdmissionErrorsStillAdaptPerCall(): Promise<void> {
  const workspace = spyWorkspace();
  const session = createSessionToolService(workspace.service, []);
  const configStore = createTestConfigStore({
    rootDir: ROOT_DIR,
    rules: { requestHeaders: {
      onInitialize: [{ readHeader: 'x-tools', apply: 'setToolList' }],
      onCallToolResult: [{ match: [{ name: 'x-format', value: 'dup' }], enable: ['structuredContentDup'] }],
    } },
  });
  const handler = createToolCallRequestHandler({ configStore, routeToolCall: session.routeToolCall, logger: { logToolCall() {}, logToolResult() {} } });
  const matching = await runWithRequestHeaderContext(createStrictRequestHeaderView([
    'x-format', 'dup', 'x-tools', 'broken', 'X-Tools', 'still broken',
  ]), () => handler({ params: { name: 'built_in' } }));
  assertEqual(matching.isError, true, 'Admission failure remains an error');
  assert('structuredContent' in matching, 'Admission errors must use the current result policy despite broken later initialization headers');
  const unmatched = await handler({ params: { name: 'built_in' } });
  assert(!('structuredContent' in unmatched), 'Next call must not inherit any matching or initialization headers');
  assertEqual(workspace.calls(), 0, 'Adapted admission failures must not enter workspace routing');
}

await runTestSuite({
  title: 'Testing session tool service views',
  tests: [
    { name: 'intersection, workspace ordering, immutability and admission', run: testIntersectionOrderAndAdmission },
    { name: 'default, empty views and independent sessions', run: testDefaultEmptyAndSessionIsolation },
    { name: 'catalog validation and external bindings remain shared', run: testCatalogContractsAndExternalBindingsRemainShared },
    { name: 'session admission errors still adapt per invocation', run: testAdmissionErrorsStillAdaptPerCall },
  ],
});
