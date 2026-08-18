import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, parseCliArgs } from '../../src/cli.js';
import {
  ConfigError,
  loadRuntimeConfigWithIdentity,
} from '../../src/config.js';
import {
  selectWorkspaceReference,
} from '../../src/config/workspace-selection.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
  writeSplitConfigFixture,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'workspace-selection');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const WORKSPACE_A_CONFIG = path.join(CONFIG_DIR, 'workspace-0.json');
const WORKSPACE_A_DIR = path.join(FIXTURES_DIR, 'workspace-a');
const WORKSPACE_B_DIR = path.join(FIXTURES_DIR, 'workspace-b');

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(DEFAULT_LOGS_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_A_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_B_DIR, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

function embeddedConfig(): Record<string, unknown> {
  return {
    version: 1,
    workspaces: [
      {
        id: 'workspace-a',
        rootDir: WORKSPACE_A_DIR,
        port: 4501,
        lineEnding: 'lf',
      },
      {
        id: 'workspace-b',
        rootDir: WORKSPACE_B_DIR,
        host: '127.0.0.2',
        port: 4502,
        lineEnding: 'crlf',
      },
    ],
  };
}

function captureCliError(run: () => unknown): CliError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof CliError, 'Expected a structured CliError');
    return error;
  }
  throw new Error('Expected CLI parsing to fail.');
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    return error;
  }
  throw new Error('Expected workspace selection to fail.');
}

function testCliRequiresSeparatedWorkspaceArgument(): void {
  const options = parseCliArgs(['--workspace', 'workspace-a']);
  assertEqual(options.workspaceId, 'workspace-a', 'CLI should accept --workspace <id>');

  const missing = captureCliError(() => parseCliArgs([]));
  assertIncludes(missing.message, 'is required', 'CLI should require an explicit workspace');

  const equals = captureCliError(() => parseCliArgs(['--workspace=workspace-a']));
  assertIncludes(equals.message, 'Unknown argument', 'Equals syntax should no longer be supported');
}

function testCliRejectsMissingDuplicateAndInvalidValues(): void {
  const missingValue = captureCliError(() => parseCliArgs(['--workspace']));
  assertIncludes(missingValue.message, 'requires a non-empty workspace id', 'Missing value should fail');

  const duplicate = captureCliError(() =>
    parseCliArgs(['--workspace', 'workspace-a', '--workspace', 'workspace-b'])
  );
  assertIncludes(duplicate.message, 'only be provided once', 'Duplicate workspace argument should fail');

  const invalid = captureCliError(() => parseCliArgs(['--workspace', 'Workspace-A']));
  assertIncludes(invalid.message, 'lowercase', 'Invalid workspace lexical token should fail');
}

function testSelectsReferenceByExplicitId(): void {
  const selected = selectWorkspaceReference({
    globalConfigFilePath: CONFIG_FILE,
    workspaceId: 'workspace-b',
    workspaces: [
      { id: 'workspace-a', configFile: WORKSPACE_A_CONFIG },
      { id: 'workspace-b', configFile: path.join(CONFIG_DIR, 'workspace-b.json') },
    ],
  });
  assertEqual(selected.id, 'workspace-b', 'Selection should use the exact requested id');
}

function testSelectionRejectsUnknownAndInvalidIds(): void {
  const unknown = captureConfigError(() =>
    selectWorkspaceReference({
      globalConfigFilePath: CONFIG_FILE,
      workspaceId: 'missing',
      workspaces: [{ id: 'workspace-a', configFile: WORKSPACE_A_CONFIG }],
    })
  );
  assertEqual(unknown.configFilePath, CONFIG_FILE, 'Unknown id should point to the global index');
  assertIncludes(unknown.message, 'was not found', 'Unknown id should explain selection failure');
  assertIncludes(unknown.suggestion, 'workspace-a', 'Unknown id should list configured ids');

  const invalid = captureConfigError(() =>
    selectWorkspaceReference({
      globalConfigFilePath: CONFIG_FILE,
      workspaceId: 'Workspace-A',
      workspaces: [{ id: 'workspace-a', configFile: WORKSPACE_A_CONFIG }],
    })
  );
  assertEqual(invalid.fieldPath, 'workspace', 'Defensive selection validation should identify workspace');
}

async function testLoaderBuildsIdentityFromIndexAndWorkspaceFile(): Promise<void> {
  await resetFixtures();
  await writeSplitConfigFixture(CONFIG_FILE, embeddedConfig());

  const loaded = loadRuntimeConfigWithIdentity({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-a',
    env: {},
  });

  assertEqual(loaded.identity.globalConfigFilePath, CONFIG_FILE, 'Identity should record the global index');
  assertEqual(loaded.identity.workspaceConfigFilePath, WORKSPACE_A_CONFIG, 'Identity should record the selected workspace file');
  assertEqual(loaded.identity.workspaceId, 'workspace-a', 'Identity id should come from the global index');
  assertEqual(loaded.identity.rootDir, WORKSPACE_A_DIR, 'Identity root should come from the workspace file');
  assertEqual(loaded.identity.port, 4501, 'Identity port should come from the workspace file');
  assert(!('selectionMode' in loaded.identity), 'Identity should not retain a meaningless selection mode');
}

async function testExplicitSelectionDoesNotDependOnCwd(): Promise<void> {
  await resetFixtures();
  await writeSplitConfigFixture(CONFIG_FILE, embeddedConfig());

  const previousCwd = process.cwd();
  process.chdir(WORKSPACE_B_DIR);
  try {
    const loaded = loadRuntimeConfigWithIdentity({
      homeDir: HOME_DIR,
      workspaceId: 'workspace-a',
      env: {},
    });
    assertEqual(loaded.snapshot.workspaceId, 'workspace-a', 'Selection should depend only on the explicit id');
  } finally {
    process.chdir(previousCwd);
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing explicit workspace selection',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'CLI requires separated workspace argument', run: testCliRequiresSeparatedWorkspaceArgument },
      { name: 'CLI rejects missing duplicate and invalid values', run: testCliRejectsMissingDuplicateAndInvalidValues },
      { name: 'selects reference by explicit id', run: testSelectsReferenceByExplicitId },
      { name: 'selection rejects unknown and invalid ids', run: testSelectionRejectsUnknownAndInvalidIds },
      { name: 'loader builds identity from index and workspace file', run: testLoaderBuildsIdentityFromIndexAndWorkspaceFile },
      { name: 'explicit selection does not depend on cwd', run: testExplicitSelectionDoesNotDependOnCwd },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
