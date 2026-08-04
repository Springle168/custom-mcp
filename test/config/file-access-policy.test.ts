import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  loadRuntimeConfig,
} from '../../src/config.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'file-access-policy');
const HOME_DIR = path.join(FIXTURES_DIR, 'home');
const CONFIG_DIR = path.join(HOME_DIR, '.custom-mcp');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOGS_DIR = path.join(CONFIG_DIR, 'logs');
const PRIMARY_DIR = path.join(FIXTURES_DIR, 'primary');
const ADDITIONAL_DIR = path.join(FIXTURES_DIR, 'additional');
const SECONDARY_DIR = path.join(FIXTURES_DIR, 'secondary');
const POLICIES_DIR = path.join(FIXTURES_DIR, 'policies');

async function resetFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
  await Promise.all([
    fs.mkdir(LOGS_DIR, { recursive: true }),
    fs.mkdir(PRIMARY_DIR, { recursive: true }),
    fs.mkdir(ADDITIONAL_DIR, { recursive: true }),
    fs.mkdir(SECONDARY_DIR, { recursive: true }),
    fs.mkdir(POLICIES_DIR, { recursive: true }),
  ]);
}

async function cleanupFixtures(): Promise<void> {
  await fs.rm(FIXTURES_DIR, { recursive: true, force: true });
}

async function writeConfig(config: unknown): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function workspace(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'primary',
    rootDir: PRIMARY_DIR,
    otherRootDirs: [ADDITIONAL_DIR],
    port: 4901,
    lineEnding: 'auto',
    ...overrides,
  };
}

function captureConfigError(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    return error;
  }
  throw new Error('Expected configuration loading to fail.');
}

async function testCompilesRootSpecificQueriesAndFreezesSnapshot(): Promise<void> {
  await resetFixtures();
  const baseIgnore = path.join(POLICIES_DIR, 'base.ignore');
  const overrideIgnore = path.join(POLICIES_DIR, 'override.ignore');
  const additionalDeny = path.join(POLICIES_DIR, 'additional.deny');
  await fs.writeFile(baseIgnore, 'generated/**\n', 'utf-8');
  await fs.writeFile(overrideIgnore, '!generated/keep.txt\n', 'utf-8');
  await fs.writeFile(additionalDeny, 'private/**\n', 'utf-8');
  await writeConfig({
    version: 1,
    workspaces: [workspace({
      fileAccess: {
        rootDir: { ignoreFiles: [baseIgnore, overrideIgnore] },
        otherRootDirs: {
          [`${ADDITIONAL_DIR}${path.sep}`]: { denyFiles: [additionalDeny] },
        },
      },
    })],
  });

  const snapshot = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary', env: {} });
  const [primaryPolicy, additionalPolicy] = snapshot.fileAccessPolicyContext.roots;
  assert(primaryPolicy !== undefined && additionalPolicy !== undefined, 'Snapshot should contain one policy facade per allowed root');
  assert(primaryPolicy.ignore.isIgnored('generated/output.txt'), 'Primary ignore should combine policy files in order');
  assert(!primaryPolicy.ignore.isIgnored('generated/keep.txt'), 'Later negation should override an earlier policy file');
  assert(!primaryPolicy.deny.isIgnored('private/secret.txt'), 'Primary policy should not inherit additional-root deny rules');
  assert(additionalPolicy.deny.isIgnored('private/secret.txt'), 'Additional root should use its associated deny rules');
  assertEqual(
    Object.prototype.hasOwnProperty.call(primaryPolicy.ignore, 'add'),
    false,
    'Query facade must not expose matcher mutation APIs',
  );
  assert(Object.isFrozen(snapshot), 'Runtime snapshot should be frozen');
  assert(Object.isFrozen(snapshot.fileAccessPolicyContext), 'File access policy context should be frozen');
  assert(Object.isFrozen(snapshot.fileAccessPolicyContext.roots), 'Root policy container should be frozen');
  assert(Object.isFrozen(primaryPolicy.ignore), 'Query facade should be frozen');
}

async function testValidatesUnselectedWorkspacePolicyFilesBeforeSelection(): Promise<void> {
  await resetFixtures();
  const missingPolicy = path.join(POLICIES_DIR, 'missing.deny');
  await writeConfig({
    version: 1,
    workspaces: [
      workspace(),
      {
        id: 'secondary',
        rootDir: SECONDARY_DIR,
        port: 4902,
        lineEnding: 'auto',
        fileAccess: { rootDir: { denyFiles: [missingPolicy] } },
      },
    ],
  });

  const error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary', env: {} })
  );
  assertEqual(error.fieldPath, 'workspaces[1].fileAccess.rootDir.denyFiles[0]', 'Error should identify the unselected workspace policy entry');
  assertIncludes(error.message, 'workspace "secondary"', 'Error should identify the workspace id');
  assertIncludes(error.message, missingPolicy, 'Policy I/O error should include the referenced file path');
}

async function testRejectsInvalidUtf8PolicyFile(): Promise<void> {
  await resetFixtures();
  const invalidPolicy = path.join(POLICIES_DIR, 'invalid-utf8.ignore');
  await fs.writeFile(invalidPolicy, Buffer.from([0xc3, 0x28]));
  await writeConfig({
    version: 1,
    workspaces: [workspace({
      fileAccess: { rootDir: { ignoreFiles: [invalidPolicy] } },
    })],
  });

  const error = captureConfigError(() => loadRuntimeConfig({ homeDir: HOME_DIR, env: {} }));
  assertEqual(error.fieldPath, 'workspaces[0].fileAccess.rootDir.ignoreFiles[0]', 'UTF-8 error should identify the policy array entry');
  assertIncludes(error.message, 'strict UTF-8', 'Invalid UTF-8 must fail closed');
}

async function testRejectsUnassociatedAdditionalRootKey(): Promise<void> {
  await resetFixtures();
  await writeConfig({
    version: 1,
    workspaces: [workspace({
      fileAccess: {
        otherRootDirs: {
          [SECONDARY_DIR]: {},
        },
      },
    })],
  });

  const error = captureConfigError(() => loadRuntimeConfig({ homeDir: HOME_DIR, env: {} }));
  assertIncludes(error.fieldPath ?? '', 'fileAccess.otherRootDirs', 'Additional root key error should identify the map');
  assertIncludes(error.message, 'configured otherRootDirs entry', 'Unassociated key should fail lexical association');
}

async function testFileAccessCannotBeEnvOverridden(): Promise<void> {
  await resetFixtures();
  await writeConfig({
    version: 1,
    workspaces: [workspace({
      envOverrides: { allowedFields: ['fileAccess'] },
    })],
  });

  const error = captureConfigError(() => loadRuntimeConfig({ homeDir: HOME_DIR, env: {} }));
  assertEqual(error.fieldPath, 'workspaces[0].envOverrides.allowedFields[0]', 'Forbidden selector should identify its allowlist entry');
  assertIncludes(error.message, 'forbidden field "fileAccess"', 'fileAccess must be forbidden from env overrides');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing file access policy configuration',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'compiles root-specific queries and freezes snapshot', run: testCompilesRootSpecificQueriesAndFreezesSnapshot },
      { name: 'validates unselected workspace policy files before selection', run: testValidatesUnselectedWorkspacePolicyFilesBeforeSelection },
      { name: 'rejects invalid UTF-8 policy file', run: testRejectsInvalidUtf8PolicyFile },
      { name: 'rejects unassociated additional root key', run: testRejectsUnassociatedAdditionalRootKey },
      { name: 'fileAccess cannot be env overridden', run: testFileAccessCannotBeEnvOverridden },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
