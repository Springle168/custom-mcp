import { pendingQuestions } from '../../src/tools/ask-user.js';
import {
  createWorkspaceToolService,
  getAllToolDefinitions,
} from '../../src/tools/index.js';
import { TOOL_NAMES } from '../../src/tools/names.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import {
  assert,
  assertEqual,
  assertIncludes,
  getResultText,
  runTestSuite,
} from '../test-utils.js';

function definitionNames(
  definitions: readonly { readonly name: string }[],
): string[] {
  return definitions.map((definition) => definition.name);
}

function createContext() {
  return createTestToolRuntimeContext({ rootDir: process.cwd() });
}

function testRegistryMatchesCanonicalNames(): void {
  const names = definitionNames(getAllToolDefinitions());
  const uniqueNames = new Set(names);

  assertEqual(names.join(','), TOOL_NAMES.join(','), 'Registry names and order should match TOOL_NAMES exactly');
  assertEqual(uniqueNames.size, names.length, 'Registry should not contain duplicate tool names');
  assertEqual(names.length, TOOL_NAMES.length, 'Every canonical tool name should have exactly one implementation');
}

function testAllModeReturnsCanonicalRegistry(): void {
  const service = createWorkspaceToolService({ mode: 'all' });
  assertEqual(
    definitionNames(service.getDefinitions()).join(','),
    TOOL_NAMES.join(','),
    'All mode should expose every tool in canonical order',
  );
}

function testEnableModeFiltersAndKeepsCanonicalOrder(): void {
  const service = createWorkspaceToolService({
    mode: 'enable',
    names: ['ask_user', 'read_file', 'replace_text'],
  });
  assertEqual(
    definitionNames(service.getDefinitions()).join(','),
    'replace_text,read_file,ask_user',
    'Enable mode should filter without using config order as display order',
  );
}

function testDisableModeFiltersAndKeepsCanonicalOrder(): void {
  const service = createWorkspaceToolService({
    mode: 'disable',
    names: ['ask_user', 'replace_text'],
  });
  assertEqual(
    definitionNames(service.getDefinitions()).join(','),
    'write_file,read_many_files,read_file,android.assembleDebug,android.testDebugUnitTest',
    'Disable mode should remove configured names and keep canonical order',
  );
}

function testEmptyListsHaveDefinedSemantics(): void {
  const enableNone = createWorkspaceToolService({ mode: 'enable', names: [] });
  const disableNone = createWorkspaceToolService({ mode: 'disable', names: [] });

  assertEqual(enableNone.getDefinitions().length, 0, 'Empty enabled list should expose no tools');
  assertEqual(
    definitionNames(disableNone.getDefinitions()).join(','),
    TOOL_NAMES.join(','),
    'Empty disable-list should expose all tools',
  );
}

async function testEnabledToolReachesHandler(): Promise<void> {
  const service = createWorkspaceToolService({
    mode: 'enable',
    names: ['android.assembleDebug'],
  });
  const result = await service.routeToolCall('android.assembleDebug', {}, createContext());

  assertEqual(result.isError, true, 'Missing Android config should remain an error result');
  assertIncludes(
    getResultText(result),
    'Android build config is not configured',
    'Enabled Android tool should reach its existing handler',
  );
}

async function testExcludedAndUnknownToolsShareUnknownError(): Promise<void> {
  const service = createWorkspaceToolService({
    mode: 'enable',
    names: ['read_file'],
  });

  for (const name of ['write_file', 'never_registered']) {
    const result = await service.routeToolCall(name, { unexpected: true }, createContext());
    assertEqual(result.isError, true, 'Rejected calls should be error results');
    assertEqual(getResultText(result), `Unknown tool: ${name}`, 'Hidden and unknown tools should use identical error semantics');
  }
}

async function testDisabledAndroidToolDoesNotReachHandler(): Promise<void> {
  const service = createWorkspaceToolService({
    mode: 'disable',
    names: ['android.assembleDebug'],
  });
  const result = await service.routeToolCall('android.assembleDebug', {}, createContext());

  assertEqual(getResultText(result), 'Unknown tool: android.assembleDebug', 'Disabled Android tool should not reveal its handler error');
  assert(!getResultText(result).includes('Android build config'), 'Disabled Android tool should not execute the handler');
}

async function testDisabledAskUserDoesNotCreatePendingQuestion(): Promise<void> {
  const service = createWorkspaceToolService({
    mode: 'disable',
    names: ['ask_user'],
  });
  const beforeCount = pendingQuestions.size;
  const result = await service.routeToolCall(
    'ask_user',
    {
      questions: [{ question: 'Proceed?', header: 'Confirm', type: 'yesno' }],
    },
    createContext(),
  );

  assertEqual(getResultText(result), 'Unknown tool: ask_user', 'Disabled ask_user should return unknown tool');
  assertEqual(pendingQuestions.size, beforeCount, 'Disabled ask_user should not create a pending question');
}

function testServiceAndDefinitionsAreFrozen(): void {
  const service = createWorkspaceToolService({ mode: 'all' });
  const definitions = service.getDefinitions();

  assert(Object.isFrozen(service), 'Workspace tool service facade should be frozen');
  assert(Object.isFrozen(definitions), 'Workspace tool definitions array should be frozen');
  assertEqual(service.getDefinitions(), definitions, 'Service should return the same closed-over definitions array');
}

async function testAllModeKeepsAndroidToolsWithoutConfig(): Promise<void> {
  const service = createWorkspaceToolService({ mode: 'all' });
  const names = definitionNames(service.getDefinitions());

  assert(names.includes('android.assembleDebug'), 'All mode should expose android.assembleDebug without Android config');
  assert(names.includes('android.testDebugUnitTest'), 'All mode should expose android.testDebugUnitTest without Android config');

  const result = await service.routeToolCall('android.testDebugUnitTest', {}, createContext());
  assertIncludes(
    getResultText(result),
    'Android build config is not configured',
    'Available Android tool should preserve the existing missing config error',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing workspace tool registry exposure',
    tests: [
      { name: 'registry matches canonical names', run: testRegistryMatchesCanonicalNames },
      { name: 'all mode returns canonical registry', run: testAllModeReturnsCanonicalRegistry },
      { name: 'enable mode filters in canonical order', run: testEnableModeFiltersAndKeepsCanonicalOrder },
      { name: 'disable mode filters in canonical order', run: testDisableModeFiltersAndKeepsCanonicalOrder },
      { name: 'empty lists have defined semantics', run: testEmptyListsHaveDefinedSemantics },
      { name: 'enabled tool reaches handler', run: testEnabledToolReachesHandler },
      { name: 'excluded and unknown tools share error', run: testExcludedAndUnknownToolsShareUnknownError },
      { name: 'disabled Android tool does not reach handler', run: testDisabledAndroidToolDoesNotReachHandler },
      { name: 'disabled ask_user does not create pending question', run: testDisabledAskUserDoesNotCreatePendingQuestion },
      { name: 'service and definitions are frozen', run: testServiceAndDefinitionsAreFrozen },
      { name: 'all mode keeps Android tools without config', run: testAllModeKeepsAndroidToolsWithoutConfig },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
