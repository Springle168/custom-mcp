import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, parseCliArgs } from '../../src/cli.js';
import {
  ConfigError,
  loadRuntimeConfigWithIdentity,
} from '../../src/config.js';
import { selectRuntimeWorkspace } from '../../src/config/workspace-selection.js';
import type { ParsedWorkspaceConfig } from '../../src/config/schema.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'workspace-selection');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const WORKSPACE_A_DIR = path.join(FIXTURES_DIR, 'workspace-a');
const WORKSPACE_B_DIR = path.join(FIXTURES_DIR, 'workspace-b');
const WORKSPACE_A_CHILD_DIR = path.join(WORKSPACE_A_DIR, 'child');
const UNMATCHED_DIR = path.join(FIXTURES_DIR, 'unmatched');
const OVERRIDE_DIR = path.join(FIXTURES_DIR, 'override-root');
const ANDROID_WORKSPACE_ROOT = path.join(FIXTURES_DIR, 'android-project');
const ANDROID_JAVA_HOME = path.join(FIXTURES_DIR, 'jbr');
const ANDROID_OVERRIDE_ROOT = path.join(FIXTURES_DIR, 'android-override-project');
const ANDROID_OVERRIDE_JAVA_HOME = path.join(FIXTURES_DIR, 'android-override-jbr');

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await fs.mkdir(DEFAULT_LOGS_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_A_CHILD_DIR, { recursive: true });
  await fs.mkdir(WORKSPACE_B_DIR, { recursive: true });
  await fs.mkdir(UNMATCHED_DIR, { recursive: true });
  await fs.mkdir(OVERRIDE_DIR, { recursive: true });
  await fs.mkdir(ANDROID_WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(ANDROID_JAVA_HOME, { recursive: true });
  await fs.mkdir(ANDROID_OVERRIDE_ROOT, { recursive: true });
  await fs.mkdir(ANDROID_OVERRIDE_JAVA_HOME, { recursive: true });
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function writeGlobalConfig(config: unknown): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function workspace(
  id: string,
  rootDir: string,
  port: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    rootDir,
    port,
    lineEnding: 'auto',
    ...overrides,
  };
}

function globalConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    workspaces: [
      workspace('workspace-a', WORKSPACE_A_DIR, 4501, {
        lineEnding: 'lf',
        android: {
          workspaceRoot: ANDROID_WORKSPACE_ROOT,
          javaHome: ANDROID_JAVA_HOME,
          buildTimeoutMs: 900000,
          maxErrorBlockChars: 2500,
          maxLogTailChars: 4000,
        },
      }),
      workspace('workspace-b', WORKSPACE_B_DIR, 4502, { lineEnding: 'crlf' }),
    ],
    ...overrides,
  };
}

function captureCliError(run: () => unknown): CliError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof CliError, 'Expected a structured CliError');
    return error;
  }

  throw new Error('Expected CLI parsing to throw.');
}

function assertCliErrorIncludes(
  argv: readonly string[],
  expectedMessage: string,
  message: string,
): void {
  const error = captureCliError(() => parseCliArgs(argv));

  assertIncludes(error.message, expectedMessage, message);
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    return error;
  }

  throw new Error('Expected workspace selection to throw.');
}

function parsedWorkspace(
  id: string,
  rootDir: string,
  port: number,
): ParsedWorkspaceConfig {
  return {
    id,
    rootDir,
    port,
    lineEnding: 'auto',
    otherRootDirs: [],
  };
}

function testCliParserSupportsSeparatedWorkspace(): void {
  const options = parseCliArgs(['--workspace', 'workspace-a']);

  assertEqual(options.workspaceId, 'workspace-a', 'CLI parser should read --workspace <id>');
}

function testCliParserSupportsEqualsWorkspace(): void {
  const options = parseCliArgs(['--workspace=workspace-b']);

  assertEqual(options.workspaceId, 'workspace-b', 'CLI parser should read --workspace=<id>');
}

function testCliParserReturnsLegalTokenUnchanged(): void {
  const options = parseCliArgs(['--workspace', 'workspace_1-alpha']);

  assertEqual(
    options.workspaceId,
    'workspace_1-alpha',
    'CLI parser should return the original legal workspace token without normalization',
  );
}

function testCliParserRejectsMissingWorkspaceValue(): void {
  const error = captureCliError(() => parseCliArgs(['--workspace']));

  assertIncludes(error.message, 'requires a non-empty workspace id', 'Missing --workspace value should fail');
}

function testCliParserRejectsInvalidWorkspaceValues(): void {
  const tooLongId = `a${'b'.repeat(64)}`;
  const invalidCases: Array<{
    readonly argv: readonly string[];
    readonly expectedMessage: string;
    readonly message: string;
  }> = [
    {
      argv: ['--workspace='],
      expectedMessage: 'must be a non-empty string',
      message: '--workspace= with an empty value should fail lexical parsing',
    },
    {
      argv: ['--workspace', '--config'],
      expectedMessage: 'requires a non-empty workspace id',
      message: '--workspace followed by another option should be treated as a missing value',
    },
    {
      argv: ['--workspace', '   '],
      expectedMessage: 'must be a non-empty string',
      message: 'Whitespace-only --workspace values should fail before grammar checks',
    },
    {
      argv: ['--workspace', ' workspace-a'],
      expectedMessage: 'must not contain leading or trailing whitespace',
      message: 'Leading whitespace should be rejected instead of trimmed',
    },
    {
      argv: ['--workspace=workspace-a '],
      expectedMessage: 'must not contain leading or trailing whitespace',
      message: 'Trailing whitespace should be rejected instead of trimmed',
    },
    {
      argv: ['--workspace=Workspace-a'],
      expectedMessage: 'must be 1-64 characters',
      message: 'Uppercase workspace ids should fail the lexical grammar',
    },
    {
      argv: ['--workspace=workspace/a'],
      expectedMessage: 'must be 1-64 characters',
      message: 'Slashes should fail the workspace id lexical grammar',
    },
    {
      argv: ['--workspace=workspace.a'],
      expectedMessage: 'must be 1-64 characters',
      message: 'Dots should fail the workspace id lexical grammar',
    },
    {
      argv: ['--workspace', 'workspace a'],
      expectedMessage: 'must be 1-64 characters',
      message: 'Internal spaces should fail the workspace id lexical grammar',
    },
    {
      argv: ['--workspace', tooLongId],
      expectedMessage: 'must be 1-64 characters',
      message: 'Workspace ids longer than 64 characters should fail the lexical grammar',
    },
    {
      argv: ['--workspace', 'workspace-a', '--workspace=Workspace-b'],
      expectedMessage: 'must be 1-64 characters',
      message: 'An invalid repeated --workspace value should still fail lexical parsing as a CliError',
    },
  ];

  for (const invalidCase of invalidCases) {
    assertCliErrorIncludes(
      invalidCase.argv,
      invalidCase.expectedMessage,
      invalidCase.message,
    );
  }
}

function testCliParserRejectsDuplicateWorkspaceArguments(): void {
  const error = captureCliError(() =>
    parseCliArgs(['--workspace', 'workspace-a', '--workspace=workspace-b'])
  );

  assertIncludes(error.message, 'can only be provided once', 'Duplicate --workspace arguments should fail');
}

function testCliParserRejectsUnknownArguments(): void {
  const error = captureCliError(() => parseCliArgs(['--config', 'custom.json']));

  assertIncludes(error.message, 'Unknown argument', 'Unknown CLI arguments should fail');
}

async function testExplicitWorkspaceSelection(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig());

  const loadedConfig = loadRuntimeConfigWithIdentity({
    homeDir: HOME_DIR,
    workspaceId: 'workspace-b',
    cwd: WORKSPACE_A_CHILD_DIR,
    env: {},
  });

  assertEqual(loadedConfig.snapshot.workspaceId, 'workspace-b', 'Explicit --workspace should select the requested id');
  assertEqual(loadedConfig.snapshot.rootDir, WORKSPACE_B_DIR, 'Explicit selection should not require cwd matching');
  assertEqual(loadedConfig.snapshot.port, 4502, 'Snapshot should use selected workspace port');
  assertEqual(loadedConfig.identity.workspaceId, 'workspace-b', 'Identity should record selected workspace id');
  assertEqual(loadedConfig.identity.rootDir, WORKSPACE_B_DIR, 'Identity rootDir should come from the validated workspace root');
  assertEqual(loadedConfig.identity.port, 4502, 'Identity should record selected workspace port');
  assertEqual(loadedConfig.identity.configFilePath, CONFIG_FILE, 'Identity should record the config file path');
  assertEqual(loadedConfig.identity.selectionMode, 'explicit', 'Identity should record explicit selection mode');
}

async function testExplicitWorkspaceMissingFails(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig());

  const error = captureConfigError(() =>
    loadRuntimeConfigWithIdentity({
      homeDir: HOME_DIR,
      workspaceId: 'missing-workspace',
      env: {},
    })
  );

  assertIncludes(error.message, 'missing-workspace', 'Missing explicit workspace id should be reported');
  assertEqual(error.fieldPath, 'workspace', 'Workspace selection errors should identify the selection field');
}

async function testDirectWorkspaceIdLexicalErrorIsConfigError(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig());

  const cases = [
    {
      workspaceId: 'workspace-a ',
      message: 'must not contain leading or trailing whitespace',
      assertion: 'Direct workspaceId seam should reject rather than trim invalid ids',
    },
    {
      workspaceId: 'Workspace-a',
      message: 'must be 1-64 characters',
      assertion: 'Direct workspaceId seam should reject grammar-invalid ids as ConfigError',
    },
  ];

  for (const testCase of cases) {
    const error = captureConfigError(() =>
      loadRuntimeConfigWithIdentity({
        homeDir: HOME_DIR,
        workspaceId: testCase.workspaceId,
        env: {},
      })
    );

    assertIncludes(error.message, testCase.message, testCase.assertion);
    assertEqual(error.fieldPath, 'workspace', 'Direct workspaceId lexical errors should identify the selection field');
  }
}

async function testDefaultCwdSelectionRequiresExactRoot(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig());

  const loadedConfig = loadRuntimeConfigWithIdentity({
    homeDir: HOME_DIR,
    cwd: WORKSPACE_B_DIR,
    env: {},
  });

  assertEqual(loadedConfig.snapshot.workspaceId, 'workspace-b', 'Default selection should choose the workspace whose root realpath equals cwd');
  assertEqual(loadedConfig.identity.selectionMode, 'cwd', 'Identity should record cwd selection mode');
}

function testDefaultCwdSelectionUsesRealpathEquivalence(): void {
  const configuredRoot = '/configured/workspace-link';
  const cwd = '/actual/workspace';
  const realRoot = '/real/workspace';
  const selection = selectRuntimeWorkspace({
    configFilePath: '/home/test/.custom-mcp/config.json',
    workspaces: [parsedWorkspace('realpath-workspace', configuredRoot, 4602)],
    cwd,
    platform: 'linux',
    realpath: (targetPath) => {
      if (targetPath === configuredRoot || targetPath === cwd) {
        return realRoot;
      }
      throw new Error(`Unexpected realpath target: ${targetPath}`);
    },
  });

  assertEqual(selection.workspace.id, 'realpath-workspace', 'Default selection should use directory identity, not raw path equality');
  assertEqual(selection.identity.rootDir, configuredRoot, 'Identity rootDir should keep the validated workspace root, not cwd');
  assertEqual(selection.identity.selectionMode, 'cwd', 'Realpath-equivalent default selection should use cwd mode');
}

async function testDefaultCwdSubdirectoryDoesNotMatch(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig());

  const error = captureConfigError(() =>
    loadRuntimeConfigWithIdentity({
      homeDir: HOME_DIR,
      cwd: WORKSPACE_A_CHILD_DIR,
      env: {},
    })
  );

  assertIncludes(error.message, 'is inside workspace "workspace-a"', 'Cwd inside a workspace root should not count as a default match');
  assertIncludes(error.message, 'requires cwd to equal', 'Error should explain exact-root matching');
}

async function testDefaultCwdUnmatchedFails(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig());

  const error = captureConfigError(() =>
    loadRuntimeConfigWithIdentity({
      homeDir: HOME_DIR,
      cwd: UNMATCHED_DIR,
      env: {},
    })
  );

  assertIncludes(error.message, 'does not match any configured workspace', 'Unmatched cwd should fail startup');
}

function testWindowsPathIdentityIgnoresCaseSeparatorsAndTrailingSlash(): void {
  const selection = selectRuntimeWorkspace({
    configFilePath: 'C:/Users/Test/.custom-mcp/config.json',
    workspaces: [parsedWorkspace('win-workspace', 'C:/Repo/Workspace', 4601)],
    cwd: 'c:\\repo\\workspace\\',
    platform: 'win32',
    realpath: (targetPath) => targetPath,
  });

  assertEqual(selection.workspace.id, 'win-workspace', 'Windows selection should ignore case, separator, and trailing slash differences');
  assertEqual(selection.identity.selectionMode, 'cwd', 'Windows identity should still record cwd selection mode');
}

async function testFirstWorkspaceBridgeIsRemoved(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig());

  const loadedConfig = loadRuntimeConfigWithIdentity({
    homeDir: HOME_DIR,
    cwd: WORKSPACE_B_DIR,
    env: {},
  });

  assertEqual(loadedConfig.snapshot.workspaceId, 'workspace-b', 'Default selection should not fall back to the first workspace');
}

async function testEnvWithoutAllowlistDoesNotAffectSelectionIdentityOrSnapshot(): Promise<void> {
  await resetFixtures();
  await writeGlobalConfig(globalConfig());

  const loadedConfig = loadRuntimeConfigWithIdentity({
    homeDir: HOME_DIR,
    cwd: WORKSPACE_A_DIR,
    env: {
      MCP_ROOT_DIR: OVERRIDE_DIR,
      MCP_PORT: '5500',
      MCP_LINE_ENDING: 'crlf',
      ANDROID_WORKSPACE_ROOT: ANDROID_OVERRIDE_ROOT,
      ANDROID_JAVA_HOME: ANDROID_OVERRIDE_JAVA_HOME,
      ANDROID_BUILD_TIMEOUT_MS: '1111',
      ANDROID_MAX_ERROR_BLOCK_CHARS: '1112',
      ANDROID_MAX_LOG_TAIL_CHARS: '1113',
    },
  });

  assertEqual(loadedConfig.snapshot.workspaceId, 'workspace-a', 'MCP_ROOT_DIR should not affect workspace selection');
  assertEqual(loadedConfig.snapshot.rootDir, WORKSPACE_A_DIR, 'MCP_ROOT_DIR should not affect snapshot rootDir');
  assertEqual(loadedConfig.snapshot.port, 4501, 'MCP_PORT should not affect snapshot port');
  assertEqual(loadedConfig.identity.rootDir, WORKSPACE_A_DIR, 'MCP_ROOT_DIR should not affect runtime identity rootDir');
  assertEqual(loadedConfig.identity.port, 4501, 'MCP_PORT should not affect runtime identity port');
  assertEqual(loadedConfig.snapshot.lineEnding, 'lf', 'MCP_LINE_ENDING should not apply without a selected workspace allowlist');
  assert(loadedConfig.snapshot.android !== undefined, 'Fixture should include Android config');
  assertEqual(loadedConfig.snapshot.android.workspaceRoot, path.resolve(ANDROID_WORKSPACE_ROOT), 'ANDROID_WORKSPACE_ROOT should not apply without a selected workspace allowlist');
  assertEqual(loadedConfig.snapshot.android.javaHome, path.resolve(ANDROID_JAVA_HOME), 'ANDROID_JAVA_HOME should not apply without a selected workspace allowlist');
  assertEqual(loadedConfig.snapshot.android.buildTimeoutMs, 900000, 'ANDROID_BUILD_TIMEOUT_MS should not apply without a selected workspace allowlist');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing workspace selection and CLI parsing',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'CLI parser supports --workspace <id>', run: testCliParserSupportsSeparatedWorkspace },
      { name: 'CLI parser supports --workspace=<id>', run: testCliParserSupportsEqualsWorkspace },
      { name: 'CLI parser returns legal token unchanged', run: testCliParserReturnsLegalTokenUnchanged },
      { name: 'CLI parser rejects missing workspace value', run: testCliParserRejectsMissingWorkspaceValue },
      { name: 'CLI parser rejects invalid workspace values', run: testCliParserRejectsInvalidWorkspaceValues },
      { name: 'CLI parser rejects duplicate workspace arguments', run: testCliParserRejectsDuplicateWorkspaceArguments },
      { name: 'CLI parser rejects unknown arguments', run: testCliParserRejectsUnknownArguments },
      { name: 'explicit workspace selection', run: testExplicitWorkspaceSelection },
      { name: 'explicit missing workspace fails', run: testExplicitWorkspaceMissingFails },
      { name: 'direct workspaceId lexical error is ConfigError', run: testDirectWorkspaceIdLexicalErrorIsConfigError },
      { name: 'default cwd selection requires exact root', run: testDefaultCwdSelectionRequiresExactRoot },
      { name: 'default cwd selection uses realpath equivalence', run: testDefaultCwdSelectionUsesRealpathEquivalence },
      { name: 'default cwd subdirectory does not match', run: testDefaultCwdSubdirectoryDoesNotMatch },
      { name: 'default cwd unmatched fails', run: testDefaultCwdUnmatchedFails },
      { name: 'Windows path identity ignores case, separators, and trailing slash', run: testWindowsPathIdentityIgnoresCaseSeparatorsAndTrailingSlash },
      { name: 'first workspace bridge is removed', run: testFirstWorkspaceBridgeIsRemoved },
      { name: 'env without allowlist does not affect selection, identity, or snapshot', run: testEnvWithoutAllowlistDoesNotAffectSelectionIdentityOrSnapshot },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
