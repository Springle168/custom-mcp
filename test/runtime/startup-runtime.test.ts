import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../src/config.js';
import { loadApplicationRuntime } from '../../src/runtime/startup-runtime.js';
import { createToolRuntimeContext } from '../../src/runtime/tool-context.js';
import type { ToolInvocationContext } from '../../src/runtime/tool-invocation-context.js';
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
const PROCESSOR_CONFIG_FILE = path.join(FIXTURES_DIR, 'processor-config.json');
const ENDPOINT_CONFIG_FILE = path.join(FIXTURES_DIR, 'endpoint-config.json');
const UNSELECTED_TOOL_CONFIG_FILE = path.join(FIXTURES_DIR, 'unselected-tool-config.json');
const UNSELECTED_PROCESSOR_CONFIG_FILE = path.join(FIXTURES_DIR, 'unselected-processor-config.json');
const UNSELECTED_ENDPOINT_CONFIG_FILE = path.join(FIXTURES_DIR, 'missing-unselected-endpoint-config.json');

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
  name?: string;
  inputSchema?: unknown;
  processorConfigFile?: string;
} = {}): Promise<void> {
  await fs.writeFile(DEFINITION_FILE, JSON.stringify({
    name: options.name ?? 'custom_tool',
    description: 'A workspace-only tool.',
    inputSchema: options.inputSchema ?? {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  }), 'utf-8');
  await fs.writeFile(TOOL_CONFIG_FILE, JSON.stringify({
    version: 1,
    definitions: [{ id: 'custom-tool', toolDefinitionFile: DEFINITION_FILE }],
    ...(options.processorConfigFile === undefined
      ? {}
      : { processorConfigFile: options.processorConfigFile }),
  }), 'utf-8');
}

async function writeDirectExternalRoutingFiles(options: {
  processorConfigFile?: string;
  endpointConfigFile?: string;
  endpointUrl?: string;
} = {}): Promise<void> {
  const processorConfigFile = options.processorConfigFile ?? PROCESSOR_CONFIG_FILE;
  const endpointConfigFile = options.endpointConfigFile ?? ENDPOINT_CONFIG_FILE;
  await fs.writeFile(endpointConfigFile, JSON.stringify({
    version: 1,
    url: options.endpointUrl ?? 'http://127.0.0.1:1/unreachable',
    timeoutMs: 1_000,
    headers: {},
  }), 'utf-8');
  await fs.writeFile(processorConfigFile, JSON.stringify({
    version: 1,
    httpEndpointConfigFile: endpointConfigFile,
    processors: [],
    routingStrategy: [
      { strategy: 'request-to-external', mode: 'direct' },
      { strategy: 'response-from-external', mode: 'direct' },
    ],
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
    version: 1,
    definitions: [],
    processorConfigFile: UNSELECTED_PROCESSOR_CONFIG_FILE,
  }), 'utf-8');
  await fs.writeFile(UNSELECTED_PROCESSOR_CONFIG_FILE, JSON.stringify({
    version: 1,
    httpEndpointConfigFile: UNSELECTED_ENDPOINT_CONFIG_FILE,
    processors: [],
    routingStrategy: [
      { strategy: 'request-to-external', mode: 'direct' },
      { strategy: 'response-from-external', mode: 'direct' },
    ],
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
  assertEqual(runtime.toolCatalog.definitions.length > 0, true, 'Selected workspace should start with built-in tools');
}

async function testCustomOnlyToolBindsExternalRoutingWithoutEndpointProbe(): Promise<void> {
  await writeDirectExternalRoutingFiles();
  await writeCustomToolFiles({ processorConfigFile: PROCESSOR_CONFIG_FILE });
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
    assert(runtime.externalRouting !== undefined, 'Custom-only routes should create an external routing runtime');
    assert(externalEntry !== undefined, 'Custom-only tool should remain in the effective catalog');
    assertEqual(externalEntry.binding, 'external', 'Custom-only tool should bind the external executor');
    if (externalEntry.binding !== 'external') {
      throw new Error('Expected custom-only entry to bind the external executor.');
    }
    assertEqual(
      externalEntry.externalExecutor,
      runtime.externalRouting.executor,
      'Custom-only tool should use the startup-owned shared external executor',
    );
  } finally {
    await runtime.close();
    await runtime.close();
  }
}

async function testConfiguredExternalRouteRequiresCustomOnlyDefinition(): Promise<void> {
  await writeDirectExternalRoutingFiles();
  await writeCustomToolFiles({
    name: 'read_file',
    processorConfigFile: PROCESSOR_CONFIG_FILE,
  });
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [workspace('selected', ROOT_DIR, {
      toolConfigFile: TOOL_CONFIG_FILE,
    })],
  });

  try {
    loadSelected();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'External route without a custom-only tool should be a ConfigError');
    assertEqual(error.configFilePath, TOOL_CONFIG_FILE, 'Error should belong to the tool config');
    assertEqual(error.fieldPath, 'processorConfigFile', 'Error should identify processorConfigFile');
    assertIncludes(error.message, 'custom-only Tool definition', 'Error should explain the external routing requirement');
    return;
  }
  throw new Error('Expected external routing without a custom-only definition to fail startup.');
}

async function testHiddenCustomOnlyToolStillLoadsExternalRouteButCannotBeCalled(): Promise<void> {
  await writeDirectExternalRoutingFiles();
  await writeCustomToolFiles({ processorConfigFile: PROCESSOR_CONFIG_FILE });
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
    assert(runtime.externalRouting !== undefined, 'Hidden custom-only tool should still load external routing');
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

async function testHiddenInvalidDefinitionStillFailsStartup(): Promise<void> {
  await writeCustomToolFiles({ inputSchema: { type: 'string' } });
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
      { name: 'custom-only tool binds external routing without endpoint probing', run: testCustomOnlyToolBindsExternalRoutingWithoutEndpointProbe },
      { name: 'configured external route requires a custom-only tool', run: testConfiguredExternalRouteRequiresCustomOnlyDefinition },
      { name: 'hidden custom-only tool still loads external routing but cannot be called', run: testHiddenCustomOnlyToolStillLoadsExternalRouteButCannotBeCalled },
      { name: 'hidden invalid definition still fails startup', run: testHiddenInvalidDefinitionStillFailsStartup },
      { name: 'compiled catalog does not reread files', run: testCompiledCatalogDoesNotRereadFiles },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
