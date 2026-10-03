import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigError } from './errors.js';

export interface GlobalConfigLocation {
  readonly configDir: string;
  readonly configFileName: string;
  readonly configFilePath: string;
}

export interface DefaultGlobalConfigPathOptions {
  readonly homeDir?: string;
}

const GLOBAL_CONFIG_DIR_NAME = '.custom-mcp';
const GLOBAL_CONFIG_FILE_NAME = 'config.json';
const GLOBAL_LOGS_DIR_NAME = 'logs';

export function getDefaultGlobalConfigPath(
  options: DefaultGlobalConfigPathOptions = {},
): GlobalConfigLocation {
  const configDir = getDefaultGlobalDotdir(options);
  const configFilePath = path.join(configDir, GLOBAL_CONFIG_FILE_NAME);

  return {
    configDir,
    configFileName: GLOBAL_CONFIG_FILE_NAME,
    configFilePath,
  };
}

export function getDefaultGlobalLogsDir(options: DefaultGlobalConfigPathOptions = {}): string {
  return path.join(getDefaultGlobalDotdir(options), GLOBAL_LOGS_DIR_NAME);
}

function getDefaultGlobalDotdir(options: DefaultGlobalConfigPathOptions): string {
  return path.join(path.resolve(resolveHomeDir(options)), GLOBAL_CONFIG_DIR_NAME);
}

function resolveHomeDir(options: DefaultGlobalConfigPathOptions): string {
  const homeDir = options.homeDir ?? os.homedir();

  if (homeDir.trim().length === 0) {
    throw new ConfigError({
      code: 'home_dir_unavailable',
      message: 'Could not determine the user home directory for the global custom-mcp dotdir.',
      suggestion:
        'Ensure the process has a valid home directory, such as USERPROFILE on Windows or HOME on macOS/Linux.',
    });
  }

  return homeDir;
}
