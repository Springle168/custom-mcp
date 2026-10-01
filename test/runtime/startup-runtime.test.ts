import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../src/config.js';
import { loadApplicationRuntime } from '../../src/runtime/application/startup-runtime.js';
import { createToolRuntimeContext } from '../../src/runtime/invocation/tool-context.js';
import type { ToolInvocationContext } from '../../src/runtime/invocation/tool-invocation-context.js';
import { createWorkspaceToolService } from '../../src/tools/index.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  getResultText,
  runTestSuite,
  writeSplitConfigFixture,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'startup-runtime');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const ROOT_DIR = path.join(FIXTURES_DIR, 'workspace');
const OTHER_ROOT_DIR = path.join(FIXTURES_DIR, 'other-workspace');
const TOOL_CONFIG_FILE = path.join(FIXTURES_DIR, 'tool-config.json');
const DEFINITION_FILE = path.join(FIXTURES_DIR, 'custom-tool.json');
const EXTERNAL_ROUTING_CONFIG_FILE = path.join(FIXTURES_DIR, 'external-routing-config.json');
const PROCESSOR_CONFIG_FILE = path.join(FIXTURES_DIR, 'processor-config.json');
const ENDPOINT_CONFIG_FILE = path.join(FIXTURES_DIR, 'endpoint-config.json');
const UNSELECTED_TOOL_CONFIG_FILE = path.join(FIXTURES_DIR, 'unselected-tool-config.json');
const UNSELECTED_EXTERNAL_ROUTING_CONFIG_FILE = path.join(
  FIXTURES_DIR,
  'missing-unselected-external-routing-config.json',
);

interface CustomToolFixtureDefinition {
  readonly id: string;
  readonly toolDefinitionFile: string;
  readonly name: string;
  readonly inputSchema?: unknown;
}

interface ExternalRouteFixture {
  readonly definitionId: string;
  readonly endpointConfigFile: string;
  readonly endpointUrl?: string;
  readonly requestStage?: Record<string, unknown>;
  readonly responseStage?: Record<string, unknown>;
}

async function prepareFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });
  await fs.mkdir(ROOT_DIR, { recursive: true });
  await fs.mkdir(OTHER_ROOT_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

function workspace(
  id: string,
  rootDir: string,
  tools?: unknown,
): Record<string, unknown> {
  return {
    id,
    rootDir,
    port: id === 'selected' ? 4901 : 4902,
    lineEnding: 'auto',
    ...(tools === undefined ? {} : { tools }),
  };
}

async function writeCustomToolFiles(options: {
  definitions?: readonly CustomToolFixtureDefinition[];
  externalRoutingConfigFile?: string;
} = {}): Promise<void> {
  const definitions = options.definitions ?? [{
    id: 'custom-tool',
    toolDefinitionFile: DEFINITION_FILE,
    name: 'custom_tool',
  }];
  for (const definition of definitions) {
    await fs.writeFile(definition.toolDefinitionFile, JSON.stringify({
      name: definition.name,
      description: `A workspace-only tool named ${definition.name}.`,
      inputSchema: definition.inputSchema ?? {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
    }), 'utf-8');
  }
  await fs.writeFile(TOOL_CONFIG_FILE, JSON.stringify({
    version: 2,
    definitions: definitions.map((definition) => ({
      id: definition.id,
      toolDefinitionFile: definition.toolDefinitionFile,
    })),
    ...(options.externalRoutingConfigFile === undefined
      ? {}
      : { externalRoutingConfigFile: options.externalRoutingConfigFile }),
  }), 'utf-8');
}

async function writeExternalRoutingFiles(options: {
  routes?: readonly ExternalRouteFixture[];
  processorConfigFile?: string;
  processors?: readonly unknown[];
} = {}): Promise<void> {
  const routes = options.routes ?? [{
    definitionId: 'custom-tool',
    endpointConfigFile: ENDPOINT_CONFIG_FILE,
  }];
  for (const route of routes) {
    await fs.writeFile(route.endpointConfigFile, JSON.stringify({
      version: 1,
      url: route.endpointUrl ?? 'http://127.0.0.1:1/unreachable',
      timeoutMs: 1_000,
      headers: {},
    }), 'utf-8');
  }
  if (options.processorConfigFile !== undefined) {
    await fs.writeFile(options.processorConfigFile, JSON.stringify({
      version: 2,
      processors: options.processors ?? [],
    }), 'utf-8');
  }
  await fs.writeFile(EXTERNAL_ROUTING_CONFIG_FILE, JSON.stringify({
    version: 2,
    ...(options.processorConfigFile === undefined
      ? {}
      : { processorConfigFile: options.processorConfigFile }),
    routes: routes.map((route) => ({
      definitionId: route.definitionId,
      routingMode: 'http',
      httpEndpointConfigFile: route.endpointConfigFile,
      routingStrategy: {
        'request-to-external': [route.requestStage ?? { mode: 'direct' }],
        'response-from-external': [route.responseStage ?? { mode: 'direct' }],
      },
    })),
  }), 'utf-8');
}

function loadSelected() {
  return loadApplicationRuntime({
    homeDir: HOME_DIR,
    workspaceId: 'selected',
    env: {},
  });
}

function createToolInvocationContext(): ToolInvocationContext {
  return {
    callId: 'startup-runtime-test-call',
    requestId: undefined,
    sessionId: undefined,
    signal: new AbortController().signal,
  };
}

async function testStartupCompilesCustomCatalogAndExposure(): Promise<void> {
  await writeCustomToolFiles();
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [workspace('selected', ROOT_DIR, {
      toolConfigFile: TOOL_CONFIG_FILE,
      enabled: ['read_file', 'custom_tool'],
    })],
  });

  const runtime = loadSelected();
  assertEqual(
    runtime.toolCatalog.definitions.map((definition) => definition.name).join(','),
    'read_file,custom_tool',
    'Startup should expose built-in and custom-only definitions from one catalog',
  );
  assert(!('toolExposure' in runtime.snapshot), 'Runtime snapshot should not own exposure');
  assert(!('toolCatalog' in runtime.snapshot), 'Runtime snapshot should not own the catalog');
  assert(!('externalRoutingConfig' in runtime), 'No routing config should leave external routing disabled');
  await runtime.close();
}

async function testSelectorMembershipUsesEffectiveCatalog(): Promise<void> {
  await writeCustomToolFiles();
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [workspace('selected', ROOT_DIR, {
      toolConfigFile: TOOL_CONFIG_FILE,
      enabled: ['missing_tool'],
    })],
  });

  try {
    loadSelected();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Unknown effective selector should be a ConfigError');
    assertEqual(error.fieldPath, 'tools.enabled[0]', 'Error should identify the selector item');
    assertIncludes(error.message, 'Unknown effective tool name', 'Error should explain catalog membership');
    assertIncludes(error.configFilePath ?? '', 'workspace-0.json', 'Error should belong to the workspace config');
    return;
  }
  throw new Error('Expected unknown effective selector to fail startup.');
}

async function testUnselectedWorkspaceToolFilesAreNotRead(): Promise<void> {
  await fs.writeFile(UNSELECTED_TOOL_CONFIG_FILE, JSON.stringify({
    version: 2,
    definitions: [],
    externalRoutingConfigFile: UNSELECTED_EXTERNAL_ROUTING_CONFIG_FILE,
  }), 'utf-8');
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [
      workspace('selected', ROOT_DIR),
      workspace('unselected', OTHER_ROOT_DIR, {
        toolConfigFile: UNSELECTED_TOOL_CONFIG_FILE,
      }),
    ],
  });

  const runtime = loadSelected();
  try {
    assertEqual(runtime.toolCatalog.definitions.length > 0, true, 'Selected workspace should start with built-in tools');
  } finally {
    await runtime.close();
  }
}

async function testCustomOnlyDefinitionBindsExternalRouteByReferenceId(): Promise<void> {
  await writeExternalRoutingFiles();
  await writeCustomToolFiles({ externalRoutingConfigFile: EXTERNAL_ROUTING_CONFIG_FILE });
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [workspace('selected', ROOT_DIR, {
      toolConfigFile: TOOL_CONFIG_FILE,
      enabled: ['custom_tool'],
    })],
  });

  const runtime = loadSelected();
  try {
    const externalEntry = runtime.toolCatalog.effectiveEntries.find(
      (entry) => entry.definition.name === 'custom_tool',
    );
    assert(runtime.externalRoutingConfig !== undefined, 'Configured routes should expose the compiled routing config');
    assert(runtime.externalRouting !== undefined, 'Configured routes should create an external routing runtime');
    assertEqual(
      runtime.externalRoutingConfig.routesByDefinitionId.get('custom-tool')?.toolName,
      'custom_tool',
      'The configured route should resolve the definition reference id to the Tool name',
    );
    assert(externalEntry !== undefined, 'Custom-only tool should remain in the effective catalog');
    assertEqual(externalEntry.binding, 'external', 'The configured definition id should bind the external executor');
    if (externalEntry.binding !== 'external') {
      throw new Error('Expected custom-only entry to bind the route-bound external executor.');
    }
    assertEqual(
      externalEntry.source.kind,
      'custom',
      'The external catalog entry should retain its custom definition source identity',
    );
    if (externalEntry.source.kind === 'custom') {
      assertEqual(
        externalEntry.source.referenceId,
        'custom-tool',
        'The catalog binding should use the definition reference id rather than the Tool name',
      );
    }
  } finally {
    await runtime.close();
    await runtime.close();
  }
}

async function testConfiguredExternalRouteRejectsBuiltInOverride(): Promise<void> {
  await writeExternalRoutingFiles();
  await writeCustomToolFiles({
    definitions: [{
      id: 'custom-tool',
      toolDefinitionFile: DEFINITION_FILE,
      name: 'read_file',
    }],
    externalRoutingConfigFile: EXTERNAL_ROUTING_CONFIG_FILE,
  });
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [workspace('selected', ROOT_DIR, {
      toolConfigFile: TOOL_CONFIG_FILE,
    })],
  });

  try {
    loadSelected();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'A route for a built-in override should be a ConfigError');
    assertEqual(
      error.configFilePath,
      EXTERNAL_ROUTING_CONFIG_FILE,
      'Route binding errors should belong to the external routing config',
    );
    assertEqual(
      error.fieldPath,
      'routes[0].definitionId',
      'Route binding errors should identify the referenced definition id',
    );
    assertIncludes(error.message, 'custom-only Tool definition', 'Error should explain the external routing requirement');
    return;
  }
  throw new Error('Expected a built-in override route to fail startup.');
}

async function testHiddenCustomOnlyToolStillLoadsExternalRouteButCannotBeCalled(): Promise<void> {
  await writeExternalRoutingFiles();
  await writeCustomToolFiles({ externalRoutingConfigFile: EXTERNAL_ROUTING_CONFIG_FILE });
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [workspace('selected', ROOT_DIR, {
      toolConfigFile: TOOL_CONFIG_FILE,
      enabled: [],
    })],
  });

  const runtime = loadSelected();
  try {
    const externalEntry = runtime.toolCatalog.effectiveEntries.find(
      (entry) => entry.definition.name === 'custom_tool',
    );
    assert(runtime.externalRoutingConfig !== undefined, 'Hidden custom-only routes must still be compiled');
    assert(runtime.externalRouting !== undefined, 'Hidden custom-only routes must still create required resources');
    assert(externalEntry !== undefined, 'Hidden custom-only tool should remain in the effective catalog');
    assertEqual(externalEntry.binding, 'external', 'Hidden custom-only tool should retain its external binding');
    assertEqual(runtime.toolCatalog.definitions.length, 0, 'Hidden custom-only tool should not be exposed');

    const service = createWorkspaceToolService(runtime.toolCatalog);
    const result = await service.routeToolCall(
      'custom_tool',
      { value: 'ok' },
      createToolRuntimeContext(runtime.snapshot),
      createToolInvocationContext(),
    );
    assertIncludes(getResultText(result), 'Unknown tool', 'Hidden custom-only tool calls should be unreachable');
  } finally {
    await runtime.close();
  }
}

async function testEmptyRoutesExposeConfiguredConfigWithoutResources(): Promise<void> {
  await writeExternalRoutingFiles({ routes: [] });
  await writeCustomToolFiles({ externalRoutingConfigFile: EXTERNAL_ROUTING_CONFIG_FILE });
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [workspace('selected', ROOT_DIR, {
      toolConfigFile: TOOL_CONFIG_FILE,
      enabled: ['custom_tool'],
    })],
  });

  const runtime = loadSelected();
  try {
    assert(runtime.externalRoutingConfig !== undefined, 'An empty routing file should still expose compiled configuration');
    assertEqual(
      runtime.externalRoutingConfig.routesByDefinitionId.size,
      0,
      'An empty routing file should preserve its zero-route compiled state',
    );
    assert(!('externalRouting' in runtime), 'Empty routes must not create external routing resources');
    const entry = runtime.toolCatalog.effectiveEntries.find(
      (candidate) => candidate.definition.name === 'custom_tool',
    );
    assertEqual(entry?.binding, 'unavailable', 'Custom-only definitions without routes should remain unavailable');

    const service = createWorkspaceToolService(runtime.toolCatalog);
    const result = await service.routeToolCall(
      'custom_tool',
      { value: 'ok' },
      createToolRuntimeContext(runtime.snapshot),
      createToolInvocationContext(),
    );
    assertIncludes(
      getResultText(result),
      'no execution route is configured',
      'Exposed custom-only definitions without routes should return the deterministic unavailable error',
    );
  } finally {
    await runtime.close();
    await runtime.close();
  }
}

async function testProcessorRunnerIsCreatedOnlyWhenARouteUsesProcessors(): Promise<void> {
  await writeExternalRoutingFiles();
  await writeCustomToolFiles({ externalRoutingConfigFile: EXTERNAL_ROUTING_CONFIG_FILE });
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [workspace('selected', ROOT_DIR, {
      toolConfigFile: TOOL_CONFIG_FILE,
    })],
  });

  const directRuntime = loadSelected();
  try {
    assert(directRuntime.externalRouting !== undefined, 'A direct route should create the shared external runtime');
    assert(
      !('processorRunner' in directRuntime.externalRouting),
      'Direct-only routes must not create a Processor runner',
    );
  } finally {
    await directRuntime.close();
  }

  await writeExternalRoutingFiles({
    processorConfigFile: PROCESSOR_CONFIG_FILE,
    processors: [{
      name: 'request-codec',
      executable: { resolution: 'path-search', command: 'node' },
      arguments: [],
      workingDirectory: ROOT_DIR,
      timeoutMs: 1_000,
    }],
    routes: [{
      definitionId: 'custom-tool',
      endpointConfigFile: ENDPOINT_CONFIG_FILE,
      requestStage: { mode: 'canonical-filter', processor: 'request-codec' },
    }],
  });

  const processorRuntime = loadSelected();
  try {
    assert(processorRuntime.externalRouting !== undefined, 'A Processor route should create the shared external runtime');
    assert(
      'processorRunner' in processorRuntime.externalRouting,
      'A route with a Processor stage should create the shared Processor runner',
    );
  } finally {
    await processorRuntime.close();
  }
}

async function testHiddenInvalidDefinitionStillFailsStartup(): Promise<void> {
  await writeCustomToolFiles({
    definitions: [{
      id: 'custom-tool',
      toolDefinitionFile: DEFINITION_FILE,
      name: 'custom_tool',
      inputSchema: { type: 'string' },
    }],
  });
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [workspace('selected', ROOT_DIR, {
      toolConfigFile: TOOL_CONFIG_FILE,
      enabled: [],
    })],
  });

  try {
    loadSelected();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Invalid hidden definition should be a ConfigError');
    assertEqual(error.configFilePath, DEFINITION_FILE, 'Error should belong to the definition file');
    assertEqual(error.fieldPath, 'inputSchema.type', 'Error should identify the invalid schema field');
    return;
  }
  throw new Error('Expected hidden invalid definition to fail startup.');
}

async function testCompiledCatalogDoesNotRereadFiles(): Promise<void> {
  await writeCustomToolFiles();
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [workspace('selected', ROOT_DIR, {
      toolConfigFile: TOOL_CONFIG_FILE,
      enabled: ['custom_tool'],
    })],
  });
  const runtime = loadSelected();
  try {
    const service = createWorkspaceToolService(runtime.toolCatalog);

    await fs.rm(TOOL_CONFIG_FILE);
    await fs.rm(DEFINITION_FILE);

    assertEqual(service.getDefinitions()[0]?.name, 'custom_tool', 'Compiled definitions should remain available');
    const result = await service.routeToolCall(
      'custom_tool',
      { value: 'ok' },
      createToolRuntimeContext(runtime.snapshot),
      createToolInvocationContext(),
    );
    assertIncludes(getResultText(result), 'no execution route is configured', 'Routing should use the compiled unavailable executor');
  } finally {
    await runtime.close();
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing application startup tool catalog compilation',
    beforeAll: prepareFixtures,
    afterAll: cleanupFixtures,
    tests: [
      { name: 'startup compiles custom catalog and exposure', run: testStartupCompilesCustomCatalogAndExposure },
      { name: 'selector membership uses effective catalog', run: testSelectorMembershipUsesEffectiveCatalog },
      { name: 'unselected workspace external artifacts are not read', run: testUnselectedWorkspaceToolFilesAreNotRead },
      { name: 'custom-only definition binds external route by reference id', run: testCustomOnlyDefinitionBindsExternalRouteByReferenceId },
      { name: 'configured external route rejects a built-in override', run: testConfiguredExternalRouteRejectsBuiltInOverride },
      { name: 'hidden custom-only tool still loads external route but cannot be called', run: testHiddenCustomOnlyToolStillLoadsExternalRouteButCannotBeCalled },
      { name: 'empty routes expose configuration without resources', run: testEmptyRoutesExposeConfiguredConfigWithoutResources },
      { name: 'Processor runner is created only when a route uses Processors', run: testProcessorRunnerIsCreatedOnlyWhenARouteUsesProcessors },
      { name: 'hidden invalid definition still fails startup', run: testHiddenInvalidDefinitionStillFailsStartup },
      { name: 'compiled catalog does not reread files', run: testCompiledCatalogDoesNotRereadFiles },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
