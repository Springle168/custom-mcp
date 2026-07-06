import type { JsonValue, ToolCallResult } from '../../src/tools/types.js';
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
    enabledFeatures: enabled ? ['structuredContent'] : [],
  };
}

function result(text: string, extensions: Record<string, unknown> = {}): ToolCallResult {
  return {
    content: [{ type: 'text', text }],
    isError: false,
    ...extensions,
  } as ToolCallResult;
}

function resultWithPayload(text: string, structuredPayload: JsonValue): ToolCallResult {
  return result(text, { structuredPayload });
}

function resultWithUnsafePayload(text: string, structuredPayload: unknown): ToolCallResult {
  return result(text, { structuredPayload }) as unknown as ToolCallResult;
}

function assertNoStructuredContent(value: ToolCallResult, message: string): void {
  assert(!('structuredContent' in value), message);
}

function assertNoStructuredPayload(value: ToolCallResult, message: string): void {
  assert(!('structuredPayload' in value), message);
}

function assertFallback(
  structuredContent: unknown,
  expected: string,
  message: string,
): void {
  assertEqual(structuredContent, expected, message);
}

function testFeatureOffCleansReservedFields(): void {
  const original = result('ok', {
    structuredPayload: { ok: true },
    structuredContent: { stale: true },
    metadata: { kept: true },
  });
  const adapted = adaptToolCallResultForRequestPolicy(original, policy(false));

  assert(adapted !== original, 'Adapter should return a cleaned public result object');
  assertEqual(adapted.content, original.content, 'Public result should keep content');
  assertEqual(adapted.isError, original.isError, 'Public result should keep isError');
  assertEqual(adapted.metadata, original.metadata, 'Public result should keep unrelated top-level extensions');
  assertNoStructuredPayload(adapted, 'Feature-off result should not leak structuredPayload');
  assertNoStructuredContent(adapted, 'Feature-off result should not leak handler-supplied structuredContent');
}

function testEnabledPolicyEmitsJsonPayloads(): void {
  const nullPrototypePayload = Object.create(null) as { [key: string]: JsonValue };
  nullPrototypePayload.answer = 'ok';

  const cases: Array<{ readonly name: string; readonly payload: JsonValue }> = [
    { name: 'plain object', payload: { ok: true, nested: { count: 1 } } },
    { name: 'null-prototype object', payload: nullPrototypePayload },
    { name: 'array', payload: ['ok', 1, false, null, { nested: 'value' }] },
    { name: 'string', payload: 'payload text' },
    { name: 'number', payload: 42 },
    { name: 'boolean', payload: true },
    { name: 'null', payload: null },
  ];

  for (const testCase of cases) {
    const original = resultWithPayload('fallback text', testCase.payload);
    const adapted = adaptToolCallResultForRequestPolicy(original, policy(true));

    assertEqual(
      adapted.structuredContent,
      testCase.payload,
      `Enabled policy should emit ${testCase.name} payload directly`,
    );
    assertNoStructuredPayload(adapted, `${testCase.name} payload should not leak internal field`);
  }
}

function testUndefinedPayloadFallsBackToText(): void {
  const original = resultWithUnsafePayload('fallback', undefined);
  const adapted = adaptToolCallResultForRequestPolicy(original, policy(true));

  assertFallback(adapted.structuredContent, '\nfallback\n', 'Undefined payload should use text fallback');
  assertNoStructuredPayload(adapted, 'Undefined payload should be removed from public result');
}

function testInvalidPayloadsFallBackToText(): void {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  const symbolKeyPayload: Record<string | symbol, unknown> = { ok: true };
  symbolKeyPayload[Symbol('secret')] = 'hidden';

  class PayloadClass {
    readonly ok = true;
  }

  const cases: Array<{ readonly name: string; readonly payload: unknown }> = [
    { name: 'Date', payload: new Date('2026-01-01T00:00:00.000Z') },
    { name: 'Map', payload: new Map([['ok', true]]) },
    { name: 'class instance', payload: new PayloadClass() },
    { name: 'own symbol key', payload: symbolKeyPayload },
    { name: 'cycle', payload: cyclic },
    { name: 'nested invalid array', payload: { items: ['ok', [Number.NaN]] } },
  ];

  for (const testCase of cases) {
    const original = resultWithUnsafePayload('fallback', testCase.payload);
    const adapted = adaptToolCallResultForRequestPolicy(original, policy(true));

    assertFallback(
      adapted.structuredContent,
      '\nfallback\n',
      `${testCase.name} payload should use text fallback`,
    );
    assertNoStructuredPayload(adapted, `${testCase.name} payload should not leak internal field`);
  }
}

function testFallbackTextWrapping(): void {
  const cases: Array<{ readonly text: string; readonly expected: string }> = [
    { text: '', expected: '\n\n' },
    { text: 'abc', expected: '\nabc\n' },
    { text: '\nabc\n', expected: '\n\nabc\n\n' },
  ];

  for (const testCase of cases) {
    const adapted = adaptToolCallResultForRequestPolicy(result(testCase.text), policy(true));
    assertFallback(
      adapted.structuredContent,
      testCase.expected,
      `Fallback should wrap ${JSON.stringify(testCase.text)} with fixed newlines`,
    );
  }
}

function testHandlerSuppliedStructuredContentIsDiscarded(): void {
  const payload = { generated: true };
  const original = resultWithPayload('fallback', payload);
  original.structuredContent = { stale: true };

  const adapted = adaptToolCallResultForRequestPolicy(original, policy(true));

  assertEqual(adapted.structuredContent, payload, 'Adapter-generated structuredContent should use valid payload');
  assertEqual(
    (original.structuredContent as { stale?: boolean }).stale,
    true,
    'Adapter should not mutate handler-supplied structuredContent',
  );
}

function testOtherTopLevelExtensionsAreRetained(): void {
  const metadata = { kept: true };
  const adapted = adaptToolCallResultForRequestPolicy(
    result('ok', { metadata }),
    policy(true),
  );

  assertEqual(adapted.metadata, metadata, 'Adapter should retain unrelated top-level extensions');
  assertFallback(adapted.structuredContent, '\nok\n', 'Missing payload should still use fallback');
}

function testAdapterDoesNotMutateHandlerResult(): void {
  const payload = { ok: true };
  const original = resultWithPayload('ok', payload);
  original.structuredContent = { stale: true };
  const beforeKeys = Object.keys(original).sort().join(',');

  adaptToolCallResultForRequestPolicy(original, policy(true));

  assertEqual(Object.keys(original).sort().join(','), beforeKeys, 'Adapter should not mutate handler result keys');
  assertEqual(original.structuredPayload, payload, 'Adapter should not remove original structuredPayload');
  assertEqual(
    (original.structuredContent as { stale?: boolean }).stale,
    true,
    'Adapter should not remove original handler-supplied structuredContent',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing tool result request policy adapter',
    tests: [
      { name: 'feature off cleans reserved fields', run: testFeatureOffCleansReservedFields },
      { name: 'enabled policy emits JSON payloads', run: testEnabledPolicyEmitsJsonPayloads },
      { name: 'undefined payload falls back to text', run: testUndefinedPayloadFallsBackToText },
      { name: 'invalid payloads fall back to text', run: testInvalidPayloadsFallBackToText },
      { name: 'fallback text wrapping', run: testFallbackTextWrapping },
      { name: 'handler-supplied structuredContent is discarded', run: testHandlerSuppliedStructuredContentIsDiscarded },
      { name: 'other top-level extensions are retained', run: testOtherTopLevelExtensionsAreRetained },
      { name: 'adapter does not mutate handler result', run: testAdapterDoesNotMutateHandlerResult },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
