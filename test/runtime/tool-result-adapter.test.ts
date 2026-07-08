import type { ToolCallResult } from '../../src/tools/types.js';
import { adaptToolCallResultForRequestPolicy } from '../../src/runtime/tool-result-adapter.js';
import type { RequestHeaderPolicy } from '../../src/runtime/request-header-policy.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

function policy(enabled: boolean): RequestHeaderPolicy {
  return {
    rulesConfigured: true,
    matchedRuleIndexes: enabled ? [0] : [],
    enabledFeatures: enabled ? ['structuredContentDup'] : [],
  };
}

function result(isError: boolean, extensions: Record<string, unknown> = {}): ToolCallResult {
  return {
    content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
    isError,
    ...extensions,
  };
}

function getStructuredContent(value: ToolCallResult): Record<string, unknown> {
  const structuredContent = value.structuredContent;
  assert(
    typeof structuredContent === 'object' && structuredContent !== null,
    'Expected structuredContent wrapper',
  );
  return structuredContent as Record<string, unknown>;
}

function testNoMatchReturnsOriginalObject(): void {
  const original = result(false);
  const adapted = adaptToolCallResultForRequestPolicy(original, policy(false));

  assertEqual(adapted, original, 'No policy feature should return the original result object');
  assert(!('structuredContent' in adapted), 'No policy feature should not add structuredContent');
}

function testMatchedSuccessAddsWrapper(): void {
  const original = result(false);
  const adapted = adaptToolCallResultForRequestPolicy(original, policy(true));
  const wrapper = getStructuredContent(adapted);

  assert(adapted !== original, 'Matched policy should return a new result object');
  assertEqual(wrapper.content, original.content, 'Wrapper should contain the result content');
  assertEqual(wrapper.isError, false, 'Successful wrapper should expose isError false');
}

function testMatchedErrorAddsWrapper(): void {
  const original = result(true);
  const adapted = adaptToolCallResultForRequestPolicy(original, policy(true));
  const wrapper = getStructuredContent(adapted);

  assertEqual(wrapper.content, original.content, 'Error wrapper should contain the result content');
  assertEqual(wrapper.isError, true, 'Error wrapper should expose isError true');
}

function testWrapperDoesNotCopyOtherExtensions(): void {
  const original = result(false, { metadata: { private: true } });
  const adapted = adaptToolCallResultForRequestPolicy(original, policy(true));
  const wrapper = getStructuredContent(adapted);

  assertEqual(adapted.metadata, original.metadata, 'Top-level extensions should remain on the adapted result');
  assertEqual(Object.keys(wrapper).sort().join(','), 'content,isError', 'Wrapper should only contain content and isError');
}

function testExistingStructuredContentIsOverwrittenWithoutMutation(): void {
  const original = result(false, {
    structuredContent: { stale: true },
  });
  const adapted = adaptToolCallResultForRequestPolicy(original, policy(true));
  const wrapper = getStructuredContent(adapted);

  assertEqual((original.structuredContent as { stale?: boolean }).stale, true, 'Original structuredContent extension should remain unchanged');
  assertEqual(wrapper.content, original.content, 'Adapted result should overwrite structuredContent with the standard wrapper');
  assertEqual(wrapper.isError, false, 'Adapted wrapper should use the normalized error flag');
}

function testAdapterDoesNotMutateHandlerResult(): void {
  const original = result(true);
  const beforeKeys = Object.keys(original).join(',');

  adaptToolCallResultForRequestPolicy(original, policy(true));

  assertEqual(Object.keys(original).join(','), beforeKeys, 'Adapter should not mutate the handler result keys');
  assert(!('structuredContent' in original), 'Adapter should not attach structuredContent to the original result');
}

function testOnlyTrueIsErrorCountsAsError(): void {
  const original = {
    content: [{ type: 'text', text: 'odd result' }],
    isError: 'yes',
  } as unknown as ToolCallResult;
  const adapted = adaptToolCallResultForRequestPolicy(original, policy(true));
  const wrapper = getStructuredContent(adapted);

  assertEqual(wrapper.isError, false, 'Only result.isError === true should be treated as an error');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing tool result request policy adapter',
    tests: [
      { name: 'no match returns original object', run: testNoMatchReturnsOriginalObject },
      { name: 'matched success adds wrapper', run: testMatchedSuccessAddsWrapper },
      { name: 'matched error adds wrapper', run: testMatchedErrorAddsWrapper },
      { name: 'wrapper does not copy other extensions', run: testWrapperDoesNotCopyOtherExtensions },
      { name: 'existing structuredContent is overwritten without mutation', run: testExistingStructuredContentIsOverwrittenWithoutMutation },
      { name: 'adapter does not mutate handler result', run: testAdapterDoesNotMutateHandlerResult },
      { name: 'only true isError counts as error', run: testOnlyTrueIsErrorCountsAsError },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
