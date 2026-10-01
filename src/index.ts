#!/usr/bin/env node

import { CliError, parseCliArgs } from './cli.js';
import { ConfigError } from './config.js';
import { startApplication } from './runtime/application/start-application.js';
import { formatStartupError } from './runtime/application/startup-errors.js';

async function main(): Promise<void> {
  const application = startApplication(parseCliArgs(process.argv.slice(2)));

  const requestShutdown = (signal: 'SIGINT' | 'SIGTERM'): void => {
    void application.close(signal).catch(() => {
      try {
        process.stderr.write('Application shutdown did not complete cleanly.\n');
      } catch {
        // There is no remaining safe reporting channel during failed shutdown.
      }
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', () => requestShutdown('SIGINT'));
  process.once('SIGTERM', () => requestShutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  if (err instanceof CliError || err instanceof ConfigError) {
    console.error(formatStartupError(err));
  } else {
    console.error('Failed to start server:', err);
  }

  process.exit(1);
});
