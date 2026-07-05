import { createStrictRequestHeaderView } from '../../src/runtime/request-header-view.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

function assertValidView(rawHeaders: readonly unknown[]) {
  const view = createStrictRequestHeaderView(rawHeaders);
  assert(view.kind === 'valid', 'Expected a valid strict request header view');
  return view;
}

function testConstructsStrictViewFromRawHeaders(): void {
  const view = assertValidView(['X-Client', 'android-studio', 'X-Compat', 'structured-content']);

  assertEqual(view.headers.get('x-client')?.kind, 'single', 'Header name should be lowercased');
  const state = view.headers.get('x-client');
  assert(state?.kind === 'single', 'x-client should be a single header');
  assertEqual(state.value, 'android-studio', 'Single header value should be preserved');
}

function testLowercaseLookup(): void {
  const view = assertValidView(['X-CUSTOM-Header', 'value']);

  assertEqual(view.headers.get('x-custom-header')?.kind, 'single', 'Lookup should use lowercase names');
  assertEqual(view.headers.get('X-CUSTOM-Header'), undefined, 'View should not keep original-case lookup keys');
}

function testCaseInsensitiveDuplicateState(): void {
  const view = assertValidView(['X-Client', 'one', 'x-client', 'two']);

  assertEqual(view.headers.get('x-client')?.kind, 'duplicate', 'Case variants should be duplicate state');
}

function testUnreferencedDuplicateDoesNotInvalidateView(): void {
  const view = assertValidView(['X-Client', 'android-studio', 'X-Other', 'a', 'x-other', 'b']);

  assertEqual(view.kind, 'valid', 'Duplicate headers should not make the entire view invalid');
  assertEqual(view.headers.get('x-client')?.kind, 'single', 'Unrelated single headers should remain matchable');
  assertEqual(view.headers.get('x-other')?.kind, 'duplicate', 'Duplicated header should be marked duplicate');
}

function testCommaValueIsNotSplit(): void {
  const view = assertValidView(['X-List', 'one,two']);
  const state = view.headers.get('x-list');

  assert(state?.kind === 'single', 'Comma value should stay a single field value');
  assertEqual(state.value, 'one,two', 'Comma value should not be parsed as a list');
}

function testInvalidRawHeadersReturnInvalidView(): void {
  assertEqual(createStrictRequestHeaderView(['X-Client']).kind, 'invalid', 'Odd rawHeaders length should be invalid');
  assertEqual(createStrictRequestHeaderView(['X-Client', 42]).kind, 'invalid', 'Non-string value should be invalid');
  assertEqual(createStrictRequestHeaderView([42, 'value']).kind, 'invalid', 'Non-string name should be invalid');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing strict request header view',
    tests: [
      { name: 'constructs strict view from raw headers', run: testConstructsStrictViewFromRawHeaders },
      { name: 'lowercase lookup', run: testLowercaseLookup },
      { name: 'case-insensitive duplicates become duplicate state', run: testCaseInsensitiveDuplicateState },
      { name: 'unreferenced duplicate does not invalidate view', run: testUnreferencedDuplicateDoesNotInvalidateView },
      { name: 'comma value is not split', run: testCommaValueIsNotSplit },
      { name: 'invalid rawHeaders return invalid view', run: testInvalidRawHeadersReturnInvalidView },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
