import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConfigError,
  getDefaultGlobalConfigPath,
} from '../../src/config.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOME_DIR = path.join(__dirname, '..', 'fixtures', 'global-config-path', 'home');

function testResolvesDotdirConfigUnderInjectedHome(): void {
  const location = getDefaultGlobalConfigPath({ homeDir: HOME_DIR });
  const expectedConfigDir = path.join(path.resolve(HOME_DIR), '.custom-mcp');

  assertEqual(location.configDir, expectedConfigDir, 'Config dir should be under the injected home directory');
  assertEqual(location.configFileName, 'config.json', 'Config file name should be stable');
  assertEqual(
    location.configFilePath,
    path.join(expectedConfigDir, 'config.json'),
    'Config file path should be the home-level dotdir config path',
  );
}

function testResolvesRelativeInjectedHomeToAbsolutePath(): void {
  const location = getDefaultGlobalConfigPath({ homeDir: 'relative-home-for-test' });

  assertEqual(
    location.configDir,
    path.join(path.resolve('relative-home-for-test'), '.custom-mcp'),
    'Injected home directories should be resolved before appending the dotdir',
  );
}

function testBlankHomeDirFailsWithConfigError(): void {
  try {
    getDefaultGlobalConfigPath({ homeDir: '   ' });
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Blank home directory should throw ConfigError');
    assertEqual(error.code, 'home_dir_unavailable', 'Error code should identify missing home directory');
    return;
  }

  throw new Error('Expected blank home directory to throw.');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing global config path resolution',
    tests: [
      { name: 'resolves dotdir config under injected home', run: testResolvesDotdirConfigUnderInjectedHome },
      { name: 'resolves relative injected home to an absolute path', run: testResolvesRelativeInjectedHomeToAbsolutePath },
      { name: 'blank home dir fails with structured error', run: testBlankHomeDirFailsWithConfigError },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
