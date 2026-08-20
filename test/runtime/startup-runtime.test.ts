import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../../src/config.js';
import { loadApplicationRuntime } from '../../src/runtime/startup-runtime.js';
import { createToolRuntimeContext } from '../../src/runtime/tool-context.js';
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
  }), 'utf-8');
}

function loadSelected() {
  return loadApplicationRuntime({
    homeDir: HOME_DIR,
    workspaceId: 'selected',
    env: {},
  });
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
  await writeSplitConfigFixture(CONFIG_FILE, {
    workspaces: [
      workspace('selected', ROOT_DIR),
      workspace('unselected', OTHER_ROOT_DIR, {
        toolConfigFile: path.join(FIXTURES_DIR, 'missing-unselected-tool-config.json'),
      }),
    ],
  });

  const runtime = loadSelected();
  assertEqual(runtime.toolCatalog.definitions.length > 0, true, 'Selected workspace should start with built-in tools');
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
      { name: 'unselected workspace tool files are not read', run: testUnselectedWorkspaceToolFilesAreNotRead },
      { name: 'hidden invalid definition still fails startup', run: testHiddenInvalidDefinitionStillFailsStartup },
      { name: 'compiled catalog does not reread files', run: testCompiledCatalogDoesNotRereadFiles },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
