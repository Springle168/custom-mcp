import { textErrorResult, textResult } from '../../src/tools/results.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

function assertNoStructuredPayload(result: ToolCallResult, message: string): void {
  assert(!('structuredPayload' in result), message);
}

function testTextResultOmitsStructuredPayloadWithoutOptions(): void {
  const result = textResult('ok');

  assertEqual(result.content[0]?.text, 'ok', 'textResult should keep text content');
  assertNoStructuredPayload(result, 'textResult without options should not write structuredPayload');
}

function testTextErrorResultOmitsStructuredPayloadWithoutOptions(): void {
  const result = textErrorResult('failed');

  assertEqual(result.content[0]?.text, 'failed', 'textErrorResult should keep text content');
  assertNoStructuredPayload(result, 'textErrorResult without options should not write structuredPayload');
}

function testUndefinedStructuredPayloadIsOmitted(): void {
  const success = textResult('ok', { structuredPayload: undefined });
  const failure = textErrorResult('failed', { structuredPayload: undefined });

  assertNoStructuredPayload(success, 'textResult should omit structuredPayload when option value is undefined');
  assertNoStructuredPayload(failure, 'textErrorResult should omit structuredPayload when option value is undefined');
}

function testNullStructuredPayloadIsWritten(): void {
  const success = textResult('ok', { structuredPayload: null });
  const failure = textErrorResult('failed', { structuredPayload: null });

  assert('structuredPayload' in success, 'textResult should write structuredPayload when value is null');
  assert('structuredPayload' in failure, 'textErrorResult should write structuredPayload when value is null');
  assertEqual(success.structuredPayload, null, 'textResult should preserve null payload');
  assertEqual(failure.structuredPayload, null, 'textErrorResult should preserve null payload');
}

function testIsErrorSemantics(): void {
  const success = textResult('ok');
  const failure = textErrorResult('failed');

  assertEqual(success.isError, false, 'textResult should return isError false');
  assertEqual(failure.isError, true, 'textErrorResult should return isError true');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing tool result helpers',
    tests: [
      { name: 'textResult omits structuredPayload without options', run: testTextResultOmitsStructuredPayloadWithoutOptions },
      { name: 'textErrorResult omits structuredPayload without options', run: testTextErrorResultOmitsStructuredPayloadWithoutOptions },
      { name: 'undefined structuredPayload is omitted', run: testUndefinedStructuredPayloadIsOmitted },
      { name: 'null structuredPayload is written', run: testNullStructuredPayloadIsWritten },
      { name: 'isError semantics are preserved', run: testIsErrorSemantics },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
