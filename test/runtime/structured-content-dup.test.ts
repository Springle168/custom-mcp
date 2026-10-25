import type { ToolCallResult } from '../../src/tools/types.js';
import { duplicateStructuredContent } from '../../src/runtime/request/tool-result-features/structured-content-dup.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

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

function testSuccessPreservesMixedContentAndExtensions(): void {
  const original: ToolCallResult = {
    content: [
      { type: 'text', text: 'before', annotations: { audience: ['assistant'] } },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', _meta: { preview: true } },
      { type: 'text', text: 'after' },
    ],
    _meta: { 'example.com/id': 'result-1' },
    extension: { retained: true },
    isError: false,
  };
  const beforeContent = JSON.stringify(original.content);
  const adapted = duplicateStructuredContent(original);
  const wrapper = getStructuredContent(adapted);

  assert(adapted !== original, 'Feature should return a new result object');
  assertEqual(
    adapted.content,
    original.content,
    'Top-level content should retain the original array',
  );
  assertEqual(wrapper.content, adapted.content, 'Wrapper should share the top-level content array');
  assertEqual(
    JSON.stringify(adapted.content),
    beforeContent,
    'Output should preserve mixed content fields and order',
  );
  assertEqual(adapted.isError, false, 'Top-level success status should be preserved');
  assertEqual(wrapper.isError, false, 'Wrapper should copy the success status');
  assertEqual(adapted._meta, original._meta, 'Feature should preserve top-level metadata');
  assertEqual(
    adapted.extension,
    original.extension,
    'Feature should preserve top-level extensions',
  );
}

function testErrorPreservesImageContentAndStatus(): void {
  const original: ToolCallResult = {
    content: [
      { type: 'text', text: 'failed' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
    ],
    isError: true,
  };
  const adapted = duplicateStructuredContent(original);
  const wrapper = getStructuredContent(adapted);

  assertEqual(adapted.content, original.content, 'Error result should retain the content array');
  assertEqual(wrapper.content, adapted.content, 'Error wrapper should share the content array');
  assertEqual(adapted.isError, true, 'Top-level error status should be preserved');
  assertEqual(wrapper.isError, true, 'Wrapper should copy the error status');
}

function testEmptyContent(): void {
  const original: ToolCallResult = { content: [], isError: false };
  const adapted = duplicateStructuredContent(original);
  const wrapper = getStructuredContent(adapted);

  assertEqual(adapted.content, original.content, 'Empty content should retain the original array');
  assertEqual(wrapper.content, adapted.content, 'Wrapper should share the empty content array');
  assertEqual(wrapper.isError, false, 'Empty content should not change the success status');
}

function testWrapperDoesNotCopyOtherExtensions(): void {
  const original = result(false, {
    _meta: { private: true },
    metadata: { private: true },
  });
  const adapted = duplicateStructuredContent(original);
  const wrapper = getStructuredContent(adapted);

  assertEqual(adapted._meta, original._meta, 'Top-level metadata should remain on the result');
  assertEqual(
    adapted.metadata,
    original.metadata,
    'Top-level extensions should remain on the result',
  );
  assertEqual(
    Object.keys(wrapper).sort().join(','),
    'content,isError',
    'Wrapper should only contain content and isError',
  );
}

function testExistingStructuredContentIsOverwrittenWithoutMutation(): void {
  const nativeStructuredContent = { native: true };
  const original = result(false, { structuredContent: nativeStructuredContent });
  const adapted = duplicateStructuredContent(original);
  const wrapper = getStructuredContent(adapted);

  assertEqual(
    original.structuredContent,
    nativeStructuredContent,
    'Original result should retain native structuredContent',
  );
  assert(wrapper !== nativeStructuredContent, 'Feature should replace native structuredContent');
  assertEqual(
    wrapper.content,
    original.content,
    'Replacement wrapper should reference the result content',
  );
  assertEqual(wrapper.isError, false, 'Replacement wrapper should copy the success status');
  assertEqual(
    Object.keys(wrapper).sort().join(','),
    'content,isError',
    'Replacement wrapper should not merge native structuredContent fields',
  );
}

function testDoesNotMutateInput(): void {
  for (const hasStructuredContent of [false, true]) {
    const original = result(true, {
      _meta: { id: 'original' },
      ...(hasStructuredContent ? { structuredContent: { native: true } } : {}),
    });
    const before = JSON.stringify(original);
    Object.freeze(original.content[0]);
    Object.freeze(original.content);
    Object.freeze(original._meta);
    if (hasStructuredContent) {
      Object.freeze(original.structuredContent);
    }
    Object.freeze(original);

    duplicateStructuredContent(original);

    assertEqual(JSON.stringify(original), before, 'Feature should not mutate any input fields');
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing structuredContentDup result feature',
    tests: [
      {
        name: 'success preserves mixed content and extensions',
        run: testSuccessPreservesMixedContentAndExtensions,
      },
      {
        name: 'error preserves image content and status',
        run: testErrorPreservesImageContentAndStatus,
      },
      { name: 'empty content is preserved', run: testEmptyContent },
      {
        name: 'wrapper does not copy other extensions',
        run: testWrapperDoesNotCopyOtherExtensions,
      },
      {
        name: 'existing structuredContent is overwritten without mutation',
        run: testExistingStructuredContentIsOverwrittenWithoutMutation,
      },
      { name: 'input is not mutated', run: testDoesNotMutateInput },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
