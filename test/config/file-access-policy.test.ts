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
  writeSplitConfigFixture,
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
  await writeSplitConfigFixture(CONFIG_FILE, config);
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
  const primaryDeny = path.join(POLICIES_DIR, 'primary.deny');
  const additionalDeny = path.join(POLICIES_DIR, 'additional.deny');
  await fs.writeFile(
    baseIgnore,
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('generated/**\n', 'utf-8'),
    ]),
  );
  await fs.writeFile(overrideIgnore, '!generated/keep.txt\n', 'utf-8');
  await fs.writeFile(primaryDeny, 'private-primary/**\n', 'utf-8');
  await fs.writeFile(additionalDeny, 'private/**\n', 'utf-8');
  await writeConfig({
    version: 1,
    workspaces: [workspace({
      fileAccess: {
        rootDir: {
          ignoreFiles: [baseIgnore, baseIgnore, overrideIgnore],
          denyFiles: [primaryDeny],
        },
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
  const [primaryFiles, additionalFiles] = snapshot.fileAccessPolicyFiles;
  assert(primaryFiles !== undefined && additionalFiles !== undefined, 'Snapshot should contain policy file metadata for every allowed root');
  assertEqual(
    primaryFiles.ignoreFiles.join('|'),
    [baseIgnore, baseIgnore, overrideIgnore].map((file) => path.resolve(file)).join('|'),
    'Primary ignore file metadata should preserve normalized configuration order and duplicates',
  );
  assertEqual(
    primaryFiles.denyFiles.join('|'),
    path.resolve(primaryDeny),
    'Primary deny file metadata should contain the validated lexical path',
  );
  assertEqual(
    additionalFiles.denyFiles.join('|'),
    path.resolve(additionalDeny),
    'Additional-root deny file metadata should stay associated with its root',
  );
  assert(Object.isFrozen(snapshot.fileAccessPolicyFiles), 'Policy file metadata container should be frozen');
  assert(Object.isFrozen(primaryFiles), 'Each policy file metadata entry should be frozen');
  assert(Object.isFrozen(primaryFiles.ignoreFiles), 'Ignore file metadata arrays should be frozen');
  assert(Object.isFrozen(primaryFiles.denyFiles), 'Deny file metadata arrays should be frozen');
}

async function testOnlySelectedWorkspacePolicyFilesEnterSnapshot(): Promise<void> {
  await resetFixtures();
  const secondaryDeny = path.join(POLICIES_DIR, 'secondary.deny');
  await fs.writeFile(secondaryDeny, 'secondary-private/**\n', 'utf-8');
  await writeConfig({
    version: 1,
    workspaces: [
      workspace(),
      {
        id: 'secondary',
        rootDir: SECONDARY_DIR,
        port: 4902,
        lineEnding: 'auto',
        fileAccess: { rootDir: { denyFiles: [secondaryDeny] } },
      },
    ],
  });

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'primary',
    env: {},
  });
  const listedPolicyFiles = snapshot.fileAccessPolicyFiles.flatMap((root) => [
    ...root.ignoreFiles,
    ...root.denyFiles,
  ]);
  assertEqual(
    listedPolicyFiles.length,
    0,
    'Unselected workspace policy files should not enter the runtime snapshot',
  );
}

async function testDoesNotReadUnselectedWorkspacePolicyFiles(): Promise<void> {
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

  const snapshot = loadRuntimeConfig({
    homeDir: HOME_DIR,
    workspaceId: 'primary',
    env: {},
  });
  assertEqual(
    snapshot.workspaceId,
    'primary',
    'A missing policy referenced only by an unselected workspace must not block startup',
  );
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

  const error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary', env: {} })
  );
  assertEqual(error.fieldPath, 'fileAccess.rootDir.ignoreFiles[0]', 'UTF-8 error should identify the policy array entry');
  assertIncludes(error.message, 'strict UTF-8', 'Invalid UTF-8 must fail closed');
}

async function testPolicyFileBoundaryDiagnosticsAndSymlinks(): Promise<void> {
  await resetFixtures();
  const missingPolicy = path.join(POLICIES_DIR, 'missing.ignore');
  await writeConfig({
    version: 1,
    workspaces: [workspace({
      fileAccess: { rootDir: { ignoreFiles: [missingPolicy] } },
    })],
  });

  let error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary', env: {} })
  );
  assertEqual(error.fieldPath, 'fileAccess.rootDir.ignoreFiles[0]', 'Missing policy should identify its reference');
  assertIncludes(error.message, 'must exist, be accessible', 'Missing policy should use the inaccessible-target diagnostic');

  await writeConfig({
    version: 1,
    workspaces: [workspace({
      fileAccess: { rootDir: { ignoreFiles: [POLICIES_DIR] } },
    })],
  });
  error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary', env: {} })
  );
  assertIncludes(error.message, 'regular file', 'A policy directory should fail the regular-file boundary');

  const loopingPolicy = path.join(POLICIES_DIR, 'looping.ignore');
  try {
    await fs.symlink(loopingPolicy, loopingPolicy, 'file');
  } catch (symlinkError: unknown) {
    const fileError = symlinkError as NodeJS.ErrnoException;
    if (process.platform === 'win32' && fileError.code === 'EPERM') {
      console.log('  - Skipped policy symlink assertion: symlink permission unavailable');
      return;
    }
    throw symlinkError;
  }
  await writeConfig({
    version: 1,
    workspaces: [workspace({
      fileAccess: { rootDir: { ignoreFiles: [loopingPolicy] } },
    })],
  });
  error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary', env: {} })
  );
  assertIncludes(error.message, 'must exist, be accessible', 'A symlink loop should use the inaccessible-target diagnostic');

  await fs.rm(loopingPolicy);
  const targetPolicy = path.join(POLICIES_DIR, 'target.ignore');
  const linkedPolicy = path.join(POLICIES_DIR, 'linked.ignore');
  await fs.writeFile(targetPolicy, 'linked/**\n', 'utf-8');
  await fs.symlink(targetPolicy, linkedPolicy, 'file');
  await writeConfig({
    version: 1,
    workspaces: [workspace({
      fileAccess: { rootDir: { ignoreFiles: [linkedPolicy] } },
    })],
  });

  const snapshot = loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary', env: {} });
  assert(
    snapshot.fileAccessPolicyContext.roots[0]?.ignore.isIgnored('linked/output.txt') === true,
    'A policy symlink should load when its opened target is a regular file',
  );
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

  const error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary', env: {} })
  );
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

  const error = captureConfigError(() =>
    loadRuntimeConfig({ homeDir: HOME_DIR, workspaceId: 'primary', env: {} })
  );
  assertEqual(error.fieldPath, 'envOverrides.allowedFields[0]', 'Forbidden selector should identify its allowlist entry');
  assertIncludes(error.message, 'forbidden field "fileAccess"', 'fileAccess must be forbidden from env overrides');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing file access policy configuration',
    afterAll: cleanupFixtures,
    tests: [
      { name: 'compiles root-specific queries and freezes snapshot', run: testCompilesRootSpecificQueriesAndFreezesSnapshot },
      { name: 'only selected workspace policy files enter snapshot', run: testOnlySelectedWorkspacePolicyFilesEnterSnapshot },
      { name: 'does not read unselected workspace policy files', run: testDoesNotReadUnselectedWorkspacePolicyFiles },
      { name: 'rejects invalid UTF-8 policy file', run: testRejectsInvalidUtf8PolicyFile },
      { name: 'enforces policy file boundary diagnostics and symlink behavior', run: testPolicyFileBoundaryDiagnosticsAndSymlinks },
      { name: 'rejects unassociated additional root key', run: testRejectsUnassociatedAdditionalRootKey },
      { name: 'fileAccess cannot be env overridden', run: testFileAccessCannotBeEnvOverridden },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
