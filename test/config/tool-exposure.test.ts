import { ConfigError } from '../../src/config.js';
import {
  readOptionalWorkspaceToolsConfig,
  type ParsedWorkspaceToolsConfig,
} from '../../src/config/tool-exposure.js';
import { assert, assertEqual, assertIncludes, runTestSuite } from '../test-utils.js';

const CONFIG_FILE = 'E:/config/workspace.json';

function parse(value: unknown): ParsedWorkspaceToolsConfig {
  return readOptionalWorkspaceToolsConfig(value, {
    configFilePath: CONFIG_FILE,
    fieldPath: 'tools',
  });
}

function captureError(value: unknown): ConfigError {
  try {
    parse(value);
  } catch (error: unknown) {
    assert(error instanceof ConfigError, 'Expected a structured ConfigError');
    return error;
  }

  throw new Error('Expected tools parsing to fail.');
}

function testMissingAndEmptyDefaultToAll(): void {
  for (const value of [undefined, {}]) {
    const tools = parse(value);
    assertEqual(tools.exposure.mode, 'all', 'Missing selectors should expose all effective tools');
    assertEqual(tools.toolConfigFile, undefined, 'Missing toolConfigFile should remain absent');
    assert(Object.isFrozen(tools), 'Parsed workspace tools should be frozen');
    assert(Object.isFrozen(tools.exposure), 'Parsed exposure should be frozen');
  }
}

function testToolConfigAndSelectorsCanCoexist(): void {
  const enabled = parse({
    toolConfigFile: 'E:/config/tool-config.json',
    enabled: ['read_file', 'workspace.custom-tool'],
  });
  assertEqual(
    enabled.toolConfigFile,
    'E:/config/tool-config.json',
    'toolConfigFile should be preserved',
  );
  assertEqual(enabled.exposure.mode, 'enable', 'enabled should select enable mode');
  assertEqual(
    enabled.exposure.mode === 'all' ? '' : enabled.exposure.names.join(','),
    'read_file,workspace.custom-tool',
    'Selectors should accept built-in and not-yet-loaded custom names',
  );

  const disabled = parse({ disabled: [] });
  assertEqual(disabled.exposure.mode, 'disable', 'disabled should select disable mode');
  assertEqual(
    disabled.exposure.mode === 'all' ? -1 : disabled.exposure.names.length,
    0,
    'An empty disabled list should remain distinct from all mode',
  );
}

function testSelectorsAreOptionalButMutuallyExclusive(): void {
  const error = captureError({ enabled: [], disabled: [] });
  assertEqual(error.fieldPath, 'tools', 'Mutual-exclusion failure should belong to tools');
  assertIncludes(
    error.message,
    'cannot configure enabled and disabled',
    'Error should explain mutual exclusion',
  );
}

function testUnknownFieldAndInvalidPathFailPrecisely(): void {
  const unknown = captureError({ custom: true });
  assertEqual(unknown.fieldPath, 'tools.custom', 'Unknown field should identify its path');

  const relative = captureError({ toolConfigFile: './tools.json' });
  assertEqual(
    relative.fieldPath,
    'tools.toolConfigFile',
    'Invalid path should identify toolConfigFile',
  );
  assertIncludes(
    relative.message,
    'absolute local path',
    'Invalid path should explain the local absolute requirement',
  );
}

function testSelectorGrammarAndDuplicates(): void {
  const cases = [
    { value: '', expected: 'non-empty string' },
    { value: ' custom', expected: 'leading or trailing whitespace' },
    { value: 'custom/tool', expected: 'must match' },
    { value: 'a'.repeat(129), expected: 'at most 128' },
  ];

  for (const testCase of cases) {
    const error = captureError({ enabled: [testCase.value] });
    assertEqual(
      error.fieldPath,
      'tools.enabled[0]',
      'Invalid selector should identify its array item',
    );
    assertIncludes(
      error.message,
      testCase.expected,
      'Invalid selector should explain its grammar failure',
    );
  }

  const duplicate = captureError({ disabled: ['custom_tool', 'custom_tool'] });
  assertEqual(
    duplicate.fieldPath,
    'tools.disabled[1]',
    'Duplicate should identify the repeated entry',
  );
  assertIncludes(
    duplicate.message,
    'Duplicate tool name',
    'Duplicate error should explain the conflict',
  );
}

function testContainerAndArrayTypesAreStrict(): void {
  for (const value of [null, [], 'tools', 1, true]) {
    const error = captureError(value);
    assertEqual(error.fieldPath, 'tools', 'Non-object tools should belong to tools');
  }

  const error = captureError({ enabled: 'read_file' });
  assertEqual(error.fieldPath, 'tools.enabled', 'Non-array selector should identify enabled');
  assertIncludes(
    error.message,
    'must be an array',
    'Non-array selector should explain the expected type',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing workspace tools structure parsing',
    tests: [
      { name: 'missing and empty tools default to all', run: testMissingAndEmptyDefaultToAll },
      { name: 'tool config and selectors can coexist', run: testToolConfigAndSelectorsCanCoexist },
      {
        name: 'selectors are optional but mutually exclusive',
        run: testSelectorsAreOptionalButMutuallyExclusive,
      },
      {
        name: 'unknown field and invalid path fail precisely',
        run: testUnknownFieldAndInvalidPathFailPrecisely,
      },
      {
        name: 'selector grammar and duplicates are validated',
        run: testSelectorGrammarAndDuplicates,
      },
      { name: 'container and array types are strict', run: testContainerAndArrayTypesAreStrict },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
