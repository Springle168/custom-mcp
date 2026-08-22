import {
  CanonicalProtocolValidationError,
  createCanonicalRequest,
  encodeCanonicalRequestDocument,
  isCanonicalSuccessResponse,
  parseCanonicalRequestDocument,
  parseStrictUtf8JsonDocument,
  validateCanonicalErrorResponse,
  validateCanonicalRequest,
  validateCanonicalRequestFilterOutput,
  validateCanonicalResponse,
  validateCanonicalResponseFilterOutput,
  validateCanonicalSuccessResponse,
  type CanonicalProtocolValidationErrorCode,
} from '../../src/tools/external-routing/canonical-protocol.js';
import {
  assert,
  assertEqual,
  assertNotIncludes,
  runTestSuite,
} from '../test-utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function canonicalRequest(
  call: Record<string, unknown> = {
    id: 'call_1',
    name: 'external.tool',
    arguments: { value: 'example' },
  },
  extensions?: unknown,
): Record<string, unknown> {
  const request: Record<string, unknown> = { calls: [call] };
  if (extensions !== undefined) {
    request.extensions = extensions;
  }
  return request;
}

function canonicalSuccess(
  result: Record<string, unknown> = {
    id: 'call_1',
    status: 'completed',
    message: 'done',
  },
  extensions?: unknown,
): Record<string, unknown> {
  const response: Record<string, unknown> = { results: [result] };
  if (extensions !== undefined) {
    response.extensions = extensions;
  }
  return response;
}

function canonicalError(
  error: Record<string, unknown> = {
    code: 'invalid_request',
    message: 'Rejected by endpoint.',
  },
  extensions?: unknown,
): Record<string, unknown> {
  const response: Record<string, unknown> = { error };
  if (extensions !== undefined) {
    response.extensions = extensions;
  }
  return response;
}

function expectProtocolFailure(
  run: () => unknown,
  code: CanonicalProtocolValidationErrorCode,
): CanonicalProtocolValidationError {
  try {
    run();
  } catch (error: unknown) {
    assert(
      error instanceof CanonicalProtocolValidationError,
      'Expected a controlled CanonicalProtocolValidationError.',
    );
    assertEqual(error.code, code, 'Protocol error code should identify the violated boundary.');
    return error;
  }
  throw new Error('Expected canonical protocol validation to fail.');
}

function testCreatesFrozenRequestAndUtf8Json(): void {
  const argumentsValue = {
    nested: {
      values: ['first'],
    },
  };
  const extensions = {
    'example-system': {
      trace: { id: 'trace-1' },
    },
  };

  const request = createCanonicalRequest({
    id: 'call_1',
    name: 'external.tool',
    arguments: argumentsValue,
    extensions,
  });

  argumentsValue.nested.values.push('source-only');
  extensions['example-system'].trace.id = 'changed-source';

  assert(Object.isFrozen(request), 'Canonical request should be frozen.');
  assert(Object.isFrozen(request.calls), 'Canonical calls tuple should be frozen.');
  assert(Object.isFrozen(request.calls[0]), 'Canonical call should be frozen.');
  assert(Object.isFrozen(request.calls[0].arguments), 'Canonical arguments should be frozen.');
  assert(
    Object.isFrozen(request.calls[0].arguments.nested),
    'Nested canonical argument object should be frozen.',
  );
  assert(Object.isFrozen(request.extensions), 'Canonical extensions should be frozen.');
  assertEqual(
    (request.calls[0].arguments.nested as { values: readonly string[] }).values.join(','),
    'first',
    'Canonical request should not retain caller-owned argument references.',
  );
  const requestExtension = request.extensions?.['example-system'];
  assert(requestExtension !== undefined, 'Canonical request should retain the extension namespace.');
  assertEqual(
    (requestExtension.trace as { id: string }).id,
    'trace-1',
    'Canonical request should not retain caller-owned extension references.',
  );

  const json = decoder.decode(encodeCanonicalRequestDocument(request));
  assert(!json.startsWith('\uFEFF'), 'Canonical encoder must not emit a BOM.');
  const encoded = JSON.parse(json) as { calls: Array<{ id: string }> };
  assertEqual(encoded.calls[0]?.id, 'call_1', 'Canonical encoder should preserve the call ID.');
}

function testRejectsInvalidRequestShapeAndJsonValues(): void {
  const unknownField = expectProtocolFailure(
    () => validateCanonicalRequest({ ...canonicalRequest(), secret: 'do-not-leak' }),
    'invalid_request',
  );
  assertNotIncludes(
    unknownField.message,
    'do-not-leak',
    'Protocol error messages must not include unvalidated external values.',
  );

  expectProtocolFailure(
    () => validateCanonicalRequest({ calls: [] }),
    'invalid_request',
  );
  expectProtocolFailure(
    () => validateCanonicalRequest(canonicalRequest({
      id: '',
      name: 'external.tool',
      arguments: {},
    })),
    'invalid_request',
  );
  expectProtocolFailure(
    () => validateCanonicalRequest(canonicalRequest({
      id: 'call_1',
      name: 'not a tool identity',
      arguments: {},
    })),
    'invalid_request',
  );
  expectProtocolFailure(
    () => validateCanonicalRequest(canonicalRequest({
      id: 'call_1',
      name: 'external.tool',
      arguments: [],
    })),
    'invalid_request',
  );
  expectProtocolFailure(
    () => validateCanonicalRequest(canonicalRequest({
      id: 'call_1',
      name: 'external.tool',
      arguments: { invalid: Number.NaN },
    })),
    'invalid_request',
  );
  expectProtocolFailure(
    () => validateCanonicalRequest(canonicalRequest(undefined, {
      'custom-mcp': {},
    })),
    'invalid_request',
  );
  expectProtocolFailure(
    () => validateCanonicalRequest(canonicalRequest(undefined, {
      'example-system': [],
    })),
    'invalid_request',
  );
}

function testStrictUtf8JsonDocumentsAndDuplicateMembers(): void {
  const duplicateIdDocument = encoder.encode(
    ' \n {"calls":[{"id":"obsolete","id":"call_1","name":"external.tool","arguments":{}}]} \t ',
  );
  const request = parseCanonicalRequestDocument(duplicateIdDocument);
  assertEqual(
    request.calls[0].id,
    'call_1',
    'JSON.parse duplicate-member semantics must retain the final member.',
  );

  const parsed = parseStrictUtf8JsonDocument(encoder.encode('{"value":[true,null]}'));
  assert(Object.isFrozen(parsed), 'Parsed JSON object should be frozen.');
  assert(
    Object.isFrozen((parsed as { value: readonly unknown[] }).value),
    'Parsed JSON arrays should be frozen.',
  );

  const validDocument = encoder.encode('{"calls":[{"id":"call_1","name":"external.tool","arguments":{}}]}');
  const withBom = new Uint8Array(validDocument.byteLength + 3);
  withBom.set([0xef, 0xbb, 0xbf]);
  withBom.set(validDocument, 3);
  expectProtocolFailure(() => parseCanonicalRequestDocument(withBom), 'invalid_utf8');
  expectProtocolFailure(
    () => parseStrictUtf8JsonDocument(new Uint8Array([0xc3, 0x28])),
    'invalid_utf8',
  );
  expectProtocolFailure(
    () => parseCanonicalRequestDocument(encoder.encode('{"calls":[]} {}')),
    'invalid_json',
  );
}

function testValidatesExactSuccessAndErrorResponses(): void {
  const success = validateCanonicalSuccessResponse(canonicalSuccess(), 'call_1');
  assertEqual(success.results[0].status, 'completed', 'Completed status should be accepted.');
  assert(Object.isFrozen(success.results[0]), 'Canonical result should be frozen.');

  const failed = validateCanonicalResponse(canonicalSuccess({
    id: 'call_1',
    status: 'failed',
    message: '',
  }), 'call_1');
  assert(isCanonicalSuccessResponse(failed), 'Failed domain outcome remains a success response shape.');
  if (isCanonicalSuccessResponse(failed)) {
    assertEqual(failed.results[0].message, '', 'Result message may be empty.');
  }

  const error = validateCanonicalErrorResponse(canonicalError({
    code: 'invalid_request',
    message: '',
  }));
  assertEqual(error.error.message, '', 'Canonical error message may be empty.');

  expectProtocolFailure(
    () => validateCanonicalResponse({
      ...canonicalSuccess(),
      error: { code: 'nope', message: 'nope' },
    }, 'call_1'),
    'invalid_response',
  );
  expectProtocolFailure(
    () => validateCanonicalResponse(canonicalSuccess({
      id: 'different-call',
      status: 'completed',
      message: 'done',
    }), 'call_1'),
    'invalid_response',
  );
  expectProtocolFailure(
    () => validateCanonicalResponse(canonicalSuccess({
      id: 'call_1',
      status: 'unknown',
      message: 'done',
    }), 'call_1'),
    'invalid_response',
  );
  expectProtocolFailure(
    () => validateCanonicalErrorResponse(canonicalError({ code: '', message: 'nope' })),
    'invalid_error_response',
  );
  expectProtocolFailure(
    () => validateCanonicalResponse({ results: [] }, 'call_1'),
    'invalid_response',
  );
  expectProtocolFailure(
    () => validateCanonicalResponse(canonicalError(undefined, {
      'custom-mcp': {},
    }), 'call_1'),
    'invalid_response',
  );
}

function testEnforcesRequestFilterMutationBoundaries(): void {
  const original = createCanonicalRequest({
    id: 'call_1',
    name: 'original.tool',
    arguments: { old: true },
    extensions: { 'original-system': { retained: false } },
  });
  const filtered = validateCanonicalRequestFilterOutput(canonicalRequest({
    id: 'call_1',
    name: 'translated.tool',
    arguments: { translated: ['value'] },
  }), original);

  assertEqual(filtered.calls[0].name, 'translated.tool', 'Request filter may change tool identity.');
  assertEqual(
    (filtered.calls[0].arguments.translated as readonly string[]).join(','),
    'value',
    'Request filter may change arguments.',
  );
  assertEqual(
    filtered.extensions,
    undefined,
    'Filter output without extensions must be a full replacement, not a merge.',
  );

  expectProtocolFailure(
    () => validateCanonicalRequestFilterOutput(canonicalRequest({
      id: 'different-call',
      name: 'translated.tool',
      arguments: {},
    }), original),
    'request_filter_invariant',
  );
  expectProtocolFailure(
    () => validateCanonicalRequestFilterOutput({
      calls: [
        { id: 'call_1', name: 'translated.tool', arguments: {} },
        { id: 'call_2', name: 'translated.tool', arguments: {} },
      ],
    }, original),
    'invalid_request',
  );
}

function testEnforcesResponseFilterMutationBoundaries(): void {
  const originalSuccess = validateCanonicalResponse(canonicalSuccess(undefined, {
    'original-system': { preserved: false },
  }), 'call_1');
  const removedExtensions = validateCanonicalResponseFilterOutput(
    canonicalSuccess(),
    originalSuccess,
    'call_1',
  );
  assertEqual(
    removedExtensions.extensions,
    undefined,
    'Response filter output without extensions must be a full replacement, not a merge.',
  );

  const filteredSuccess = validateCanonicalResponseFilterOutput(canonicalSuccess({
    id: 'call_1',
    status: 'cancelled',
    message: 'Endpoint cancelled the operation.',
  }, {
    'filter-system': { version: 1 },
  }), originalSuccess, 'call_1');
  assert(isCanonicalSuccessResponse(filteredSuccess), 'Success filter output should remain success.');
  if (isCanonicalSuccessResponse(filteredSuccess)) {
    assertEqual(
      filteredSuccess.results[0].status,
      'cancelled',
      'Response filter may change result status.',
    );
  }

  expectProtocolFailure(
    () => validateCanonicalResponseFilterOutput(canonicalSuccess({
      id: 'different-call',
      status: 'completed',
      message: 'done',
    }), originalSuccess, 'call_1'),
    'response_filter_invariant',
  );
  expectProtocolFailure(
    () => validateCanonicalResponseFilterOutput(
      canonicalError(),
      originalSuccess,
      'call_1',
    ),
    'response_filter_invariant',
  );

  const originalError = validateCanonicalResponse(canonicalError(), 'call_1');
  const filteredError = validateCanonicalResponseFilterOutput(canonicalError({
    code: 'translated_error',
    message: 'Translated rejection.',
  }), originalError, 'call_1');
  assert(!isCanonicalSuccessResponse(filteredError), 'Error filter output should remain an error.');
  if (!isCanonicalSuccessResponse(filteredError)) {
    assertEqual(filteredError.error.code, 'translated_error', 'Response filter may change error code.');
  }
  expectProtocolFailure(
    () => validateCanonicalResponseFilterOutput(
      canonicalSuccess(),
      originalError,
      'call_1',
    ),
    'response_filter_invariant',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external-routing canonical protocol',
    tests: [
      { name: 'creates frozen request and UTF-8 JSON', run: testCreatesFrozenRequestAndUtf8Json },
      { name: 'rejects invalid request shape and JSON values', run: testRejectsInvalidRequestShapeAndJsonValues },
      { name: 'enforces strict UTF-8 JSON documents and duplicate-member semantics', run: testStrictUtf8JsonDocumentsAndDuplicateMembers },
      { name: 'validates exact success and error responses', run: testValidatesExactSuccessAndErrorResponses },
      { name: 'enforces request filter mutation boundaries', run: testEnforcesRequestFilterMutationBoundaries },
      { name: 'enforces response filter mutation boundaries', run: testEnforcesResponseFilterMutationBoundaries },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
