import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  rootDir: string;
  lineEnding: 'auto' | 'lf' | 'crlf';
  port: number;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');

export function loadConfig(): Config {
  let fileConfig: Partial<Config> = {};

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    fileConfig = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read config file at ${CONFIG_PATH}`);
    console.error(err);
    process.exit(1);
  }

  const config: Config = {
    rootDir:
      process.env.MCP_ROOT_DIR || fileConfig.rootDir || '',
    lineEnding:
      (process.env.MCP_LINE_ENDING as Config['lineEnding']) ||
      fileConfig.lineEnding ||
      'auto',
    port:
      Number(process.env.MCP_PORT) || fileConfig.port || 3100,
  };

  if (!config.rootDir) {
    console.error(
      'Error: rootDir is not configured.\n' +
        `Please set it in ${CONFIG_PATH} or via MCP_ROOT_DIR environment variable.`,
    );
    process.exit(1);
  }

  return config;
}
