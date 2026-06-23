import * as path from 'node:path';
import {
  readExistingDirectoryPath,
} from '../../src/config/path-policy.js';
import type { ValuePolicyResult } from '../../src/config/value-policy.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

type FakeEntry = 'dir' | 'file';

function expectOk<T>(result: ValuePolicyResult<T>, message: string): T {
  if (!result.ok) {
    throw new Error(`${message}: ${result.error.message}`);
  }

  return result.value;
}

function expectError<T>(
  result: ValuePolicyResult<T>,
  expectedMessage: string,
  message: string,
): void {
  assert(!result.ok, `${message}: expected an error`);
  assertIncludes(result.error.message, expectedMessage, message);
}

function createFakeStat(entries: ReadonlyMap<string, FakeEntry>): (targetPath: string) => { isDirectory(): boolean } {
  return (targetPath: string) => {
    const entry = entries.get(targetPath);
    if (entry === undefined) {
      throw new Error('missing path');
    }

    return { isDirectory: () => entry === 'dir' };
  };
}

function resolveFor(platform: NodeJS.Platform, value: string): string {
  return platform === 'win32'
    ? path.win32.resolve(value)
    : path.posix.resolve(value.replace(/\\/g, '/'));
}

function fakeEntries(
  platform: NodeJS.Platform,
  entries: ReadonlyArray<readonly [string, FakeEntry]>,
): ReadonlyMap<string, FakeEntry> {
  return new Map(entries.map(([value, entry]) => [resolveFor(platform, value), entry]));
}

function testWindowsDriveAbsoluteDirectoryIsAccepted(): void {
  const platform: NodeJS.Platform = 'win32';
  const directory = 'C:/Work Dir/project';
  const result = readExistingDirectoryPath(directory, {
    fieldPath: 'workspaces[0].rootDir',
    platform,
    stat: createFakeStat(fakeEntries(platform, [[directory, 'dir']])),
  });

  assertEqual(
    expectOk(result, 'Windows drive-absolute directory should parse'),
    directory,
    'Path policy should preserve the original legal input string',
  );
}

function testTypedStringWhitespaceIsRejectedBeforePathShape(): void {
  const platform: NodeJS.Platform = 'win32';
  const stat = createFakeStat(fakeEntries(platform, [['C:/repo', 'dir']]));

  expectError(
    readExistingDirectoryPath(' C:/repo', { fieldPath: 'rootDir', platform, stat }),
    'rootDir must not contain leading or trailing whitespace',
    'Leading whitespace should not be trimmed before path parsing',
  );
  expectError(
    readExistingDirectoryPath('C:/repo ', { fieldPath: 'rootDir', platform, stat }),
    'rootDir must not contain leading or trailing whitespace',
    'Trailing whitespace should not be trimmed before path parsing',
  );
}

function testWindowsUnsupportedPathShapesAreRejected(): void {
  const platform: NodeJS.Platform = 'win32';
  const stat = createFakeStat(new Map());
  const cases = [
    { name: 'relative path', value: 'relative/project' },
    { name: 'UNC slash path', value: '//server/share/project' },
    { name: 'UNC backslash path', value: '\\\\server\\share\\project' },
    { name: 'namespace path', value: '\\\\?\\C:\\project' },
    { name: 'device namespace path', value: '\\\\.\\C:\\project' },
    { name: 'drive-relative path', value: 'C:project' },
    { name: 'rooted without drive slash path', value: '/project' },
    { name: 'rooted without drive backslash path', value: '\\project' },
  ];

  for (const testCase of cases) {
    expectError(
      readExistingDirectoryPath(testCase.value, { fieldPath: 'rootDir', platform, stat }),
      'rootDir must be an absolute local path',
      `${testCase.name} should be rejected before filesystem probing`,
    );
  }
}

function testTildeExpansionIsRejected(): void {
  expectError(
    readExistingDirectoryPath('~/project', {
      fieldPath: 'rootDir',
      platform: 'win32',
      stat: createFakeStat(new Map()),
    }),
    'cannot use ~ expansion',
    'Path policy should not expand home shorthand',
  );
}

function testExistingDirectoryProbe(): void {
  const platform: NodeJS.Platform = 'win32';
  const directory = 'C:/repo';
  const file = 'C:/repo.txt';
  const stat = createFakeStat(fakeEntries(platform, [
    [directory, 'dir'],
    [file, 'file'],
  ]));

  assertEqual(
    expectOk(
      readExistingDirectoryPath(directory, { fieldPath: 'rootDir', platform, stat }),
      'Existing directory should parse',
    ),
    directory,
    'Existing directory should preserve the input string',
  );

  expectError(
    readExistingDirectoryPath('C:/missing', { fieldPath: 'rootDir', platform, stat }),
    'rootDir does not exist or cannot be accessed',
    'Missing paths should fail with existence guidance',
  );
  expectError(
    readExistingDirectoryPath(file, { fieldPath: 'rootDir', platform, stat }),
    'rootDir must point to an existing directory',
    'Files should not satisfy existing-directory policy',
  );
}

function testPosixAbsolutePathSeam(): void {
  const platform: NodeJS.Platform = 'linux';
  const directory = '/tmp/custom mcp/project';
  const stat = createFakeStat(fakeEntries(platform, [[directory, 'dir']]));

  assertEqual(
    expectOk(
      readExistingDirectoryPath(directory, { fieldPath: 'rootDir', platform, stat }),
      'POSIX local absolute directory should parse when the seam allows it',
    ),
    directory,
    'POSIX path policy should preserve the original legal input string',
  );

  expectError(
    readExistingDirectoryPath(directory, {
      fieldPath: 'rootDir',
      platform,
      allowPosixAbsolute: false,
      stat,
    }),
    'rootDir must be an absolute local path',
    'The POSIX path seam should be able to reject POSIX absolute paths',
  );
  expectError(
    readExistingDirectoryPath('//server/share/project', { fieldPath: 'rootDir', platform, stat }),
    'rootDir must be an absolute local path',
    'UNC-like POSIX paths should not be accepted as local paths',
  );
  expectError(
    readExistingDirectoryPath('C:/project', { fieldPath: 'rootDir', platform, stat }),
    'rootDir must be an absolute local path',
    'Windows drive-absolute paths should not be accepted by the POSIX seam',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing config path policy',
    tests: [
      { name: 'Windows drive-absolute directory is accepted', run: testWindowsDriveAbsoluteDirectoryIsAccepted },
      { name: 'typed string whitespace is rejected before path shape', run: testTypedStringWhitespaceIsRejectedBeforePathShape },
      { name: 'Windows unsupported path shapes are rejected', run: testWindowsUnsupportedPathShapesAreRejected },
      { name: 'tilde expansion is rejected', run: testTildeExpansionIsRejected },
      { name: 'existing directory probe', run: testExistingDirectoryProbe },
      { name: 'POSIX absolute path seam', run: testPosixAbsolutePathSeam },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
