import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError } from '../../src/cli.js';
import { ConfigError } from '../../src/config.js';
import { formatStartupError } from '../../src/runtime/application/startup-errors.js';
import { assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';

function testCliErrorIncludesIndentedSuggestion(): void {
  assertEqual(
    formatStartupError(new CliError('Missing workspace.', 'Choose a workspace.\r\nThen restart.')),
    [
      'Failed to parse command line arguments.',
      'Reason: Missing workspace.',
      '',
      'Next step:',
      '  Choose a workspace.',
      '  Then restart.',
    ].join('\n'),
    'CLI errors should preserve their actionable startup format',
  );
}

function testConfigErrorIncludesFileAndField(): void {
  assertEqual(
    formatStartupError(
      new ConfigError({
        code: 'config_validation_failed',
        message: 'Invalid port.',
        configFilePath: 'C:\\Config\\workspace.json',
        fieldPath: 'port',
        suggestion: 'Use a valid port.',
      }),
    ),
    [
      'Failed to load configuration.',
      'Reason: Invalid port.',
      'Config file: C:\\Config\\workspace.json',
      'Field: port',
      '',
      'Next step:',
      '  Use a valid port.',
    ].join('\n'),
    'Config errors should preserve file, field, and suggestion details',
  );
}

function testErrorsWithoutOptionalDetails(): void {
  assertEqual(
    formatStartupError(new CliError('Bad argument.')),
    'Failed to parse command line arguments.\nReason: Bad argument.',
    'CLI errors without suggestions should not gain empty sections',
  );
  assertEqual(
    formatStartupError(new ConfigError({ code: 'home_dir_unavailable', message: 'No home.' })),
    'Failed to load configuration.\nReason: No home.',
    'Config errors without optional metadata should not gain empty sections',
  );
}

function testEntrypointRejectsMissingWorkspace(): void {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../../src/index.ts', import.meta.url))],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assertEqual(
    result.status,
    1,
    'Missing workspace should cause the executable to exit with status 1',
  );
  assertEqual(result.stdout, '', 'CLI failure must not start a listener or emit startup logs');
  assertIncludes(
    result.stderr,
    'Failed to parse command line arguments.',
    'Entrypoint should use the CLI error formatter',
  );
  assertIncludes(
    result.stderr,
    '--workspace <id> is required.',
    'Entrypoint should preserve the parser reason',
  );
  assertIncludes(result.stderr, 'Next step:', 'Entrypoint should preserve actionable suggestions');
}

await runTestSuite({
  title: 'Testing startup error output',
  tests: [
    { name: 'CLI error includes indented suggestion', run: testCliErrorIncludesIndentedSuggestion },
    { name: 'config error includes file and field', run: testConfigErrorIncludesFileAndField },
    { name: 'errors without optional details', run: testErrorsWithoutOptionalDetails },
    { name: 'entrypoint rejects missing workspace', run: testEntrypointRejectsMissingWorkspace },
  ],
});
