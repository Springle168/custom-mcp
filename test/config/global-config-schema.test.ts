import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadRuntimeConfig } from '../../src/config.js';
import { parseGlobalConfig } from '../../src/config/global-config-schema.js';
import { parseWorkspaceConfig } from '../../src/config/schema.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'global-config-schema');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const WORKSPACE_CONFIG_A = path.join(CONFIG_DIR, 'workspace-a.json');
const WORKSPACE_CONFIG_B = path.join(CONFIG_DIR, 'workspace-b.json');
const ROOT_DIR = path.join(FIXTURES_DIR, 'workspace');

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(DEFAULT_LOGS_DIR, { recursive: true });
  await fs.mkdir(ROOT_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function workspaceConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    rootDir: ROOT_DIR,
    port: 4100,
    lineEnding: 'auto',
    ...overrides,
  };
}

function globalConfig(
  workspaces: unknown[] = [{ id: 'workspace-a', configFile: WORKSPACE_CONFIG_A }],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { version: 2, workspaces, ...overrides };
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    return error;
  }
  throw new Error('Expected configuration validation to fail.');
}

function expectGlobalParseError(
  config: unknown,
  expectedFieldPath: string,
  expectedMessage: string,
): void {
  const error = captureConfigError(() =>
    parseGlobalConfig(config, { configFilePath: CONFIG_FILE })
  );
  assertEqual(error.configFilePath, CONFIG_FILE, 'Global schema errors should point to the global config');
  assertEqual(error.fieldPath, expectedFieldPath, 'Global schema error should identify its field');
  assertIncludes(error.message, expectedMessage, 'Global schema error should explain the failure');
}

function testAcceptsVersionTwoWorkspaceReferences(): void {
  const parsed = parseGlobalConfig(globalConfig([
    { id: 'workspace-a', configFile: WORKSPACE_CONFIG_A },
    { id: 'workspace-b', configFile: WORKSPACE_CONFIG_B },
  ]), { configFilePath: CONFIG_FILE });

  assertEqual(parsed.version, 2, 'Global schema should use version 2');
  assertEqual(parsed.workspaces.length, 2, 'Global schema should retain workspace references');
  assertEqual(parsed.workspaces[0]?.configFile, WORKSPACE_CONFIG_A, 'Reference should retain its absolute config path');
  assert(Object.isFrozen(parsed), 'Parsed global config should be frozen');
  assert(Object.isFrozen(parsed.workspaces), 'Parsed workspace references should be frozen');
}

function testRejectsLegacyAndMalformedGlobalSchemas(): void {
  expectGlobalParseError(globalConfig(undefined, { version: 1 }), 'version', 'number 2');
  expectGlobalParseError(globalConfig(undefined, { version: '2' }), 'version', 'number 2');
  expectGlobalParseError({ version: 2 }, 'workspaces', 'non-empty array');
  expectGlobalParseError({ version: 2, workspaces: [] }, 'workspaces', 'at least one workspace');
  expectGlobalParseError(globalConfig(undefined, { legacy: true }), 'legacy', 'Unknown config field');
  expectGlobalParseError(globalConfig([42]), 'workspaces[0]', 'must be a JSON object');
  expectGlobalParseError(
    globalConfig([{ id: 'workspace-a', configFile: WORKSPACE_CONFIG_A, rootDir: ROOT_DIR }]),
    'workspaces[0].rootDir',
    'Unknown config field',
  );
}

function testValidatesReferenceIds(): void {
  expectGlobalParseError(
    globalConfig([{ configFile: WORKSPACE_CONFIG_A }]),
    'workspaces[0].id',
    'is required',
  );
  expectGlobalParseError(
    globalConfig([{ id: 'Workspace-A', configFile: WORKSPACE_CONFIG_A }]),
    'workspaces[0].id',
    'lowercase',
  );
  expectGlobalParseError(
    globalConfig([
      { id: 'duplicate', configFile: WORKSPACE_CONFIG_A },
      { id: 'duplicate', configFile: WORKSPACE_CONFIG_B },
    ]),
    'workspaces[1].id',
    'must be unique',
  );
}

function testValidatesConfigFileLexicallyWithoutReadingIt(): void {
  expectGlobalParseError(
    globalConfig([{ id: 'workspace-a' }]),
    'workspaces[0].configFile',
    'is required',
  );
  expectGlobalParseError(
    globalConfig([{ id: 'workspace-a', configFile: 'relative/workspace.json' }]),
    'workspaces[0].configFile',
    'absolute local path',
  );
  expectGlobalParseError(
    globalConfig([{ id: 'workspace-a', configFile: ` ${WORKSPACE_CONFIG_A}` }]),
    'workspaces[0].configFile',
    'leading or trailing whitespace',
  );

  const missingConfigFile = path.join(CONFIG_DIR, 'missing.json');
  const parsed = parseGlobalConfig(
    globalConfig([{ id: 'workspace-a', configFile: missingConfigFile }]),
    { configFilePath: CONFIG_FILE },
  );
  assertEqual(
    parsed.workspaces[0]?.configFile,
    missingConfigFile,
    'Global parsing should not stat or read unselected workspace config files',
  );
}

function testAllowsDuplicateConfigFileReferences(): void {
  const parsed = parseGlobalConfig(globalConfig([
    { id: 'workspace-a', configFile: WORKSPACE_CONFIG_A },
    { id: 'workspace-b', configFile: WORKSPACE_CONFIG_A },
  ]), { configFilePath: CONFIG_FILE });

  assertEqual(parsed.workspaces.length, 2, 'Different ids may intentionally share one workspace config file');
}

function testWorkspaceSchemaHasIndependentVersionAndNoId(): void {
  const parsed = parseWorkspaceConfig(workspaceConfig(), {
    configFilePath: WORKSPACE_CONFIG_A,
  });
  assertEqual(parsed.version, 2, 'Workspace config should use its independent version 2 schema');
  assertEqual(parsed.rootDir, ROOT_DIR, 'Workspace schema should parse runtime fields');

  const versionError = captureConfigError(() =>
    parseWorkspaceConfig(workspaceConfig({ version: 1 }), {
      configFilePath: WORKSPACE_CONFIG_A,
    })
  );
  assertEqual(versionError.fieldPath, 'version', 'Workspace version error should use file-local paths');
  assertEqual(versionError.configFilePath, WORKSPACE_CONFIG_A, 'Workspace errors should point to the workspace file');

  const idError = captureConfigError(() =>
    parseWorkspaceConfig(workspaceConfig({ id: 'duplicated-id' }), {
      configFilePath: WORKSPACE_CONFIG_A,
    })
  );
  assertEqual(idError.fieldPath, 'id', 'Workspace id should be rejected as an unknown field');
}

async function testLoadsOnlySelectedWorkspaceConfig(): Promise<void> {
  await resetFixtures();
  await writeJson(WORKSPACE_CONFIG_A, workspaceConfig());
  await writeJson(CONFIG_FILE, globalConfig([
    { id: 'workspace-a', configFile: WORKSPACE_CONFIG_A },
    { id: 'workspace-b', configFile: WORKSPACE_CONFIG_B },
  ]));

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-a',
    env: {},
  });
  assertEqual(snapshot.workspaceId, 'workspace-a', 'Selected valid workspace should load');
  assertEqual(
    snapshot.workspaceConfigFilePath,
    WORKSPACE_CONFIG_A,
    'Snapshot should identify the selected workspace config source',
  );
}

async function testAllowsRootAndPortReuseAcrossWorkspaceFiles(): Promise<void> {
  await resetFixtures();
  await writeJson(WORKSPACE_CONFIG_A, workspaceConfig());
  await writeJson(WORKSPACE_CONFIG_B, workspaceConfig());
  await writeJson(CONFIG_FILE, globalConfig([
    { id: 'workspace-a', configFile: WORKSPACE_CONFIG_A },
    { id: 'workspace-b', configFile: WORKSPACE_CONFIG_B },
  ]));

  const first = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: {} });
  const second = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-b', env: {} });
  assertEqual(first.rootDir, second.rootDir, 'Workspace roots may be reused globally');
  assertEqual(first.port, second.port, 'Workspace ports may be reused globally');
}

async function testSelectedWorkspaceFailuresPointToWorkspaceFile(): Promise<void> {
  await resetFixtures();
  await writeJson(WORKSPACE_CONFIG_A, workspaceConfig({ rootDir: 'relative' }));
  await writeJson(CONFIG_FILE, globalConfig());

  const error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: {} })
  );
  assertEqual(error.configFilePath, WORKSPACE_CONFIG_A, 'Selected workspace validation should point to its file');
  assertEqual(error.fieldPath, 'rootDir', 'Selected workspace errors should use file-local field paths');
}

async function testSelectedWorkspaceFileReadFailuresAreStructured(): Promise<void> {
  await resetFixtures();
  await writeJson(CONFIG_FILE, globalConfig([
    { id: 'workspace-a', configFile: WORKSPACE_CONFIG_A },
  ]));

  const missing = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: {} })
  );
  assertEqual(missing.code, 'config_file_not_found', 'Missing selected workspace file should have a precise code');
  assertEqual(missing.configFilePath, WORKSPACE_CONFIG_A, 'Missing workspace error should point to the reference target');
  assertIncludes(
    missing.suggestion,
    'fix its configFile entry in the global config',
    'Missing workspace guidance should retain the global reference recovery action',
  );

  await fs.writeFile(WORKSPACE_CONFIG_A, Buffer.from([0xc3, 0x28]));
  const invalidUtf8 = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'workspace-a', env: {} })
  );
  assertEqual(invalidUtf8.code, 'config_file_read_failed', 'Invalid workspace UTF-8 should fail during file reading');
  assertEqual(invalidUtf8.configFilePath, WORKSPACE_CONFIG_A, 'UTF-8 error should point to the selected workspace file');
  assertIncludes(invalidUtf8.message, 'valid UTF-8', 'Workspace config decoding must fail closed');
}

async function main(): Promise<void> {
  await resetFixtures();
  await runTestSuite({
    title: 'Testing global and workspace config schemas',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'accepts version 2 workspace references', run: testAcceptsVersionTwoWorkspaceReferences },
      { name: 'rejects legacy and malformed global schemas', run: testRejectsLegacyAndMalformedGlobalSchemas },
      { name: 'validates reference ids', run: testValidatesReferenceIds },
      { name: 'validates configFile lexically without reading it', run: testValidatesConfigFileLexicallyWithoutReadingIt },
      { name: 'allows duplicate configFile references', run: testAllowsDuplicateConfigFileReferences },
      { name: 'workspace schema has independent version and no id', run: testWorkspaceSchemaHasIndependentVersionAndNoId },
      { name: 'loads only selected workspace config', run: testLoadsOnlySelectedWorkspaceConfig },
      { name: 'allows root and port reuse across workspace files', run: testAllowsRootAndPortReuseAcrossWorkspaceFiles },
      { name: 'selected workspace failures point to workspace file', run: testSelectedWorkspaceFailuresPointToWorkspaceFile },
      { name: 'selected workspace file read failures are structured', run: testSelectedWorkspaceFileReadFailuresAreStructured },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
