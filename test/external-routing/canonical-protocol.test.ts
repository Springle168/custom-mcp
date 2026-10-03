import {
  CanonicalProtocolValidationError,
  createCanonicalRequest,
  encodeCanonicalRequestDocument,
  isCanonicalSuccessResponse,
  parseCanonicalRequestDocument,
  parseCanonicalResponseDocument,
  parseStrictUtf8JsonDocument,
  validateCanonicalErrorResponse,
  validateCanonicalRequest,
  validateCanonicalRequestFilterOutput,
  validateCanonicalResponse,
  validateCanonicalResponseFilterOutput,
  validateCanonicalSuccessResponse,
  type CanonicalProtocolValidationErrorCode,
} from '../../src/tools/external-routing/canonical-protocol.js';
import { assert, assertEqual, assertNotIncludes, runTestSuite } from '../test-utils.js';

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
    content: [{ type: 'text', text: 'done' }],
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
  assert(
    requestExtension !== undefined,
    'Canonical request should retain the extension namespace.',
  );
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

  expectProtocolFailure(() => validateCanonicalRequest({ calls: [] }), 'invalid_request');
  expectProtocolFailure(
    () =>
      validateCanonicalRequest(
        canonicalRequest({
          id: '',
          name: 'external.tool',
          arguments: {},
        }),
      ),
    'invalid_request',
  );
  expectProtocolFailure(
    () =>
      validateCanonicalRequest(
        canonicalRequest({
          id: 'call_1',
          name: 'not a tool identity',
          arguments: {},
        }),
      ),
    'invalid_request',
  );
  expectProtocolFailure(
    () =>
      validateCanonicalRequest(
        canonicalRequest({
          id: 'call_1',
          name: 'external.tool',
          arguments: [],
        }),
      ),
    'invalid_request',
  );
  expectProtocolFailure(
    () =>
      validateCanonicalRequest(
        canonicalRequest({
          id: 'call_1',
          name: 'external.tool',
          arguments: { invalid: Number.NaN },
        }),
      ),
    'invalid_request',
  );
  expectProtocolFailure(
    () =>
      validateCanonicalRequest(
        canonicalRequest(undefined, {
          'custom-mcp': {},
        }),
      ),
    'invalid_request',
  );
  expectProtocolFailure(
    () =>
      validateCanonicalRequest(
        canonicalRequest(undefined, {
          'example-system': [],
        }),
      ),
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

  const validDocument = encoder.encode(
    '{"calls":[{"id":"call_1","name":"external.tool","arguments":{}}]}',
  );
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

  const failed = validateCanonicalResponse(
    canonicalSuccess({
      id: 'call_1',
      status: 'failed',
      content: [{ type: 'text', text: '' }],
    }),
    'call_1',
  );
  assert(
    isCanonicalSuccessResponse(failed),
    'Failed domain outcome remains a success response shape.',
  );
  if (isCanonicalSuccessResponse(failed)) {
    assertEqual(
      JSON.stringify(failed.results[0].content),
      '[{"type":"text","text":""}]',
      'Result text may be empty.',
    );
  }

  const error = validateCanonicalErrorResponse(
    canonicalError({
      code: 'invalid_request',
      message: '',
    }),
  );
  assertEqual(error.error.message, '', 'Canonical error message may be empty.');

  expectProtocolFailure(
    () =>
      validateCanonicalResponse(
        {
          ...canonicalSuccess(),
          error: { code: 'nope', message: 'nope' },
        },
        'call_1',
      ),
    'invalid_response',
  );
  expectProtocolFailure(
    () =>
      validateCanonicalResponse(
        canonicalSuccess({
          id: 'different-call',
          status: 'completed',
          content: [{ type: 'text', text: 'done' }],
        }),
        'call_1',
      ),
    'invalid_response',
  );
  expectProtocolFailure(
    () =>
      validateCanonicalResponse(
        canonicalSuccess({
          id: 'call_1',
          status: 'unknown',
          content: [{ type: 'text', text: 'done' }],
        }),
        'call_1',
      ),
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
    () =>
      validateCanonicalResponse(
        canonicalError(undefined, {
          'custom-mcp': {},
        }),
        'call_1',
      ),
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
  const filtered = validateCanonicalRequestFilterOutput(
    canonicalRequest({
      id: 'call_1',
      name: 'translated.tool',
      arguments: { translated: ['value'] },
    }),
    original,
  );

  assertEqual(
    filtered.calls[0].name,
    'translated.tool',
    'Request filter may change tool identity.',
  );
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
    () =>
      validateCanonicalRequestFilterOutput(
        canonicalRequest({
          id: 'different-call',
          name: 'translated.tool',
          arguments: {},
        }),
        original,
      ),
    'request_filter_invariant',
  );
  expectProtocolFailure(
    () =>
      validateCanonicalRequestFilterOutput(
        {
          calls: [
            { id: 'call_1', name: 'translated.tool', arguments: {} },
            { id: 'call_2', name: 'translated.tool', arguments: {} },
          ],
        },
        original,
      ),
    'invalid_request',
  );
}

function testEnforcesResponseFilterMutationBoundaries(): void {
  const originalSuccess = validateCanonicalResponse(
    canonicalSuccess(undefined, {
      'original-system': { preserved: false },
    }),
    'call_1',
  );
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

  const filteredSuccess = validateCanonicalResponseFilterOutput(
    canonicalSuccess(
      {
        id: 'call_1',
        status: 'cancelled',
        content: [
          { type: 'unknown', value: null },
          { type: 'image', data: 'AQID', mime_type: 'image/webp' },
        ],
      },
      {
        'filter-system': { version: 1 },
      },
    ),
    originalSuccess,
    'call_1',
  );
  assert(
    isCanonicalSuccessResponse(filteredSuccess),
    'Success filter output should remain success.',
  );
  if (isCanonicalSuccessResponse(filteredSuccess)) {
    assertEqual(
      filteredSuccess.results[0].status,
      'cancelled',
      'Response filter may change result status.',
    );
    assertEqual(
      JSON.stringify(filteredSuccess.results[0].content),
      '[{"type":"unknown","value":null},{"type":"image","data":"AQID","mime_type":"image/webp"}]',
      'Response filter may replace and reorder content without textifying unknown.',
    );
  }
  expectProtocolFailure(
    () =>
      validateCanonicalResponseFilterOutput(
        canonicalSuccess({ id: 'call_1', status: 'completed' }),
        originalSuccess,
        'call_1',
      ),
    'invalid_response',
  );

  expectProtocolFailure(
    () =>
      validateCanonicalResponseFilterOutput(
        canonicalSuccess({
          id: 'different-call',
          status: 'completed',
          content: [{ type: 'text', text: 'done' }],
        }),
        originalSuccess,
        'call_1',
      ),
    'response_filter_invariant',
  );
  expectProtocolFailure(
    () => validateCanonicalResponseFilterOutput(canonicalError(), originalSuccess, 'call_1'),
    'response_filter_invariant',
  );

  const originalError = validateCanonicalResponse(canonicalError(), 'call_1');
  const filteredError = validateCanonicalResponseFilterOutput(
    canonicalError({
      code: 'translated_error',
      message: 'Translated rejection.',
    }),
    originalError,
    'call_1',
  );
  assert(!isCanonicalSuccessResponse(filteredError), 'Error filter output should remain an error.');
  if (!isCanonicalSuccessResponse(filteredError)) {
    assertEqual(
      filteredError.error.code,
      'translated_error',
      'Response filter may change error code.',
    );
  }
  expectProtocolFailure(
    () => validateCanonicalResponseFilterOutput(canonicalSuccess(), originalError, 'call_1'),
    'response_filter_invariant',
  );
}

function responseWithContent(content: unknown, status = 'completed'): Record<string, unknown> {
  return canonicalSuccess({ id: 'call_1', status, content });
}

function unknownResponse(value: unknown): Record<string, unknown> {
  return responseWithContent([{ type: 'unknown', value }]);
}

function testAcceptsAllStatusesAndOrderedContent(): void {
  // Arbitrary bytes exercise encoding only; canonical validation does not inspect image files.
  const content = [
    { type: 'text', text: '' },
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
    { type: 'image', data: 'AQID', mime_type: 'image/png' },
    {
      type: 'unknown',
      value: { type: 'image', url: 'https://example.invalid/image', json: '{"x":1}' },
    },
    { type: 'text', text: 'last' },
  ];
  for (const status of ['completed', 'failed', 'cancelled']) {
    const response = validateCanonicalSuccessResponse(
      responseWithContent(content, status),
      'call_1',
    );
    assertEqual(response.results[0].status, status, 'Every status accepts mixed content.');
    assertEqual(
      JSON.stringify(response.results[0].content),
      JSON.stringify(content),
      'Block order and boundaries remain unchanged.',
    );
    const empty = validateCanonicalSuccessResponse(responseWithContent([], status), 'call_1');
    assertEqual(empty.results[0].content.length, 0, 'Every status accepts empty content.');
    expectProtocolFailure(
      () =>
        validateCanonicalResponse(
          canonicalSuccess({ id: 'call_1', status, message: 'legacy' }),
          'call_1',
        ),
      'invalid_response',
    );
    expectProtocolFailure(
      () =>
        validateCanonicalResponse(
          canonicalSuccess({ id: 'call_1', status, content: [], message: 'legacy' }),
          'call_1',
        ),
      'invalid_response',
    );
  }
  const opaqueId = '  opaque:call/id  ';
  const opaque = validateCanonicalSuccessResponse(
    canonicalSuccess({ id: opaqueId, status: 'completed', content: [] }),
    opaqueId,
  );
  assertEqual(opaque.results[0].id, opaqueId, 'Opaque IDs are not trimmed or parsed.');
}

function testRejectsMalformedContentAndWrappers(): void {
  const extraArray = Object.assign([], { extra: true });
  const symbolArray: unknown[] = [];
  Object.defineProperty(symbolArray, Symbol('hidden'), { value: true });
  const foreignArray: unknown[] = [];
  Object.setPrototypeOf(foreignArray, null);
  for (const content of [
    undefined,
    null,
    {},
    'text',
    new Array(1),
    extraArray,
    symbolArray,
    foreignArray,
  ]) {
    expectProtocolFailure(
      () => validateCanonicalResponse(responseWithContent(content), 'call_1'),
      'invalid_response',
    );
  }
  const invalidBlocks: unknown[] = [
    null,
    [],
    'text',
    {},
    { type: 'audio', data: 'AQID' },
    { type: 'custom', value: null },
    { type: 'text' },
    { type: 'text', text: null },
    { type: 'text', text: 'valid', extra: true },
    { type: 'image', data: 'AQID' },
    { type: 'image', mime_type: 'image/png' },
    { type: 'image', data: 'AQID', mime_type: 'image/png', mimeType: 'image/png' },
    { type: 'unknown' },
    { type: 'unknown', value: null, extra: true },
  ];
  for (const block of invalidBlocks) {
    expectProtocolFailure(
      () =>
        validateCanonicalResponse(
          responseWithContent([{ type: 'text', text: 'valid-prefix' }, block]),
          'call_1',
        ),
      'invalid_response',
    );
  }
  for (const result of [
    { id: 'call_1', status: 'completed' },
    { id: '', status: 'completed', content: [] },
    { id: 'wrong', status: 'completed', content: [] },
    { id: 'call_1', status: 'unknown', content: [] },
    { id: 'call_1', status: 'completed', content: [], images: [] },
    { id: 'call_1', status: 'completed', content: [], isError: false },
  ]) {
    expectProtocolFailure(
      () => validateCanonicalResponse(canonicalSuccess(result), 'call_1'),
      'invalid_response',
    );
  }
  const validResult = { id: 'call_1', status: 'completed', content: [] };
  for (const results of [
    new Array(1),
    [validResult, validResult],
    Object.assign([validResult], { extra: true }),
  ]) {
    expectProtocolFailure(
      () => validateCanonicalResponse({ results }, 'call_1'),
      'invalid_response',
    );
  }
  expectProtocolFailure(() => validateCanonicalResponse({}, 'call_1'), 'invalid_response');
  expectProtocolFailure(
    () => validateCanonicalResponse({ ...canonicalSuccess(), extra: true }, 'call_1'),
    'invalid_response',
  );
  expectProtocolFailure(
    () => validateCanonicalErrorResponse(canonicalError({ code: 'x', message: '', extra: true })),
    'invalid_error_response',
  );
}

function testCanonicalImageEncodingAndMime(): void {
  for (const data of ['AQID', 'AA==', 'AQ==', '/w==', 'AAA=', 'AQI=', '//8=', '++++', '////']) {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
      const response = validateCanonicalSuccessResponse(
        responseWithContent([{ type: 'image', data, mime_type: mimeType }]),
        'call_1',
      );
      const block = response.results[0].content[0];
      assert(block?.type === 'image', 'Valid base64 and MIME should produce an image block.');
      assertEqual(block.data, data, 'Image data is not decoded or rewritten.');
      assertEqual(block.mime_type, mimeType, 'MIME is preserved exactly.');
    }
  }
  for (const data of [
    '',
    'A',
    'AA',
    'AAA',
    'AQID=',
    'AQID====',
    '====',
    'A===',
    'AA=A',
    '=AAA',
    'AA==AAAA',
    'AA===',
    'AQI==',
    'AB==',
    'A/==',
    'AAB=',
    'AA/=',
    'AA-_',
    'AA*=',
    'AA =',
    'AA\t=',
    'AA\n=',
    'AQID\r\n',
    'data:image/png;base64,AQID',
    'https://example.invalid/image',
    'C:\\image.png',
    '/tmp/image.png',
    null,
    123,
    { toString: () => 'AQID' },
  ]) {
    expectProtocolFailure(
      () =>
        validateCanonicalResponse(
          responseWithContent([{ type: 'image', data, mime_type: 'image/png' }]),
          'call_1',
        ),
      'invalid_response',
    );
  }
  for (const mimeType of [
    'image/jpg',
    'IMAGE/PNG',
    'image/PNG',
    'image/png; charset=utf-8',
    ' image/png',
    'image/png ',
    '',
    null,
  ]) {
    expectProtocolFailure(
      () =>
        validateCanonicalResponse(
          responseWithContent([{ type: 'image', data: 'AQID', mime_type: mimeType }]),
          'call_1',
        ),
      'invalid_response',
    );
  }
}

function testUnknownJsonValuesAndImmutableSnapshots(): void {
  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype.key = [null, false, 0, ''];
  for (const value of [
    null,
    false,
    true,
    0,
    -12.5,
    '',
    'hello',
    [],
    [1, null],
    {},
    nullPrototype,
  ]) {
    const response = validateCanonicalSuccessResponse(unknownResponse(value), 'call_1');
    const block = response.results[0].content[0];
    assert(block?.type === 'unknown', 'JSON values remain unknown blocks.');
    assertEqual(JSON.stringify(block.value), JSON.stringify(value), 'JSON semantics are retained.');
  }
  const keys = JSON.parse(
    '{"__proto__":{"safe":true},"constructor":"data","toJSON":"ordinary data"}',
  ) as Record<string, unknown>;
  const shared = { values: ['first'] };
  const source = { keys, left: shared, right: shared, array: [shared] };
  const sourceBlock = { type: 'unknown', value: source };
  const sourceContent = [sourceBlock, { type: 'text', text: 'original' }];
  const extensions = { system: { nested: { values: ['extension'] } } };
  const input = canonicalSuccess(
    { id: 'call_1', status: 'completed', content: sourceContent },
    extensions,
  );
  const response = validateCanonicalSuccessResponse(input, 'call_1');
  const snapshot = JSON.stringify(response);
  shared.values.push('source-only');
  sourceBlock.value = { ...source, left: { values: [] } };
  sourceContent.push({ type: 'text', text: 'new' });
  Object.defineProperty(keys, 'constructor', { value: 'changed' });
  extensions.system.nested.values.push('source-only');
  assertEqual(
    JSON.stringify(response),
    snapshot,
    'All copied content and extensions are independent of source mutations.',
  );
  const block = response.results[0].content[0];
  assert(block?.type === 'unknown', 'The snapshot retains unknown data.');
  assert(block.value !== source, 'Unknown objects are copied.');
  const copied = block.value as Record<string, unknown>;
  assert(copied.left !== copied.right, 'Shared non-cyclic values can be copied at each position.');
  assertEqual(
    Object.getPrototypeOf(copied.keys),
    null,
    'Prototype-related keys cannot change the copied prototype.',
  );
  assertEqual(
    JSON.stringify(copied.keys),
    '{"__proto__":{"safe":true},"constructor":"data","toJSON":"ordinary data"}',
    'Prototype-related keys retain JSON meaning.',
  );
  function assertDeepFrozen(value: unknown): void {
    if (typeof value !== 'object' || value === null) return;
    assert(Object.isFrozen(value), 'Every snapshot container and wrapper is frozen.');
    for (const child of Object.values(value)) assertDeepFrozen(child);
  }
  assertDeepFrozen(response);
}

function testRejectsUnsafeUnknownWithoutExecutingInput(): void {
  let getterCalls = 0;
  let toJsonCalls = 0;
  const accessor = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get: () => {
      getterCalls++;
      return 'unsafe';
    },
  });
  const customToJson = {
    toJSON: () => {
      toJsonCalls++;
      return 'repaired';
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const arrayCycle: unknown[] = [];
  arrayCycle.push(arrayCycle);
  const accessorArray = Object.defineProperty([null], '0', {
    enumerable: true,
    get: () => {
      getterCalls++;
      return null;
    },
  });
  const nonEnumerableArray = Object.defineProperty([null], '0', { enumerable: false });
  const foreignArray: unknown[] = [];
  Object.setPrototypeOf(foreignArray, Object.create(Array.prototype));
  const symbolObject = { [Symbol('secret')]: null };
  const symbolArray = Object.defineProperty([], Symbol('secret'), { value: null });
  class Example {
    value = 1;
  }
  for (const value of [
    undefined,
    1n,
    () => null,
    Symbol('value'),
    NaN,
    Infinity,
    -Infinity,
    { nested: undefined },
    [undefined],
    cycle,
    arrayCycle,
    new Date(),
    new Map(),
    new Set(),
    Buffer.from('data'),
    new Example(),
    accessor,
    customToJson,
    symbolObject,
    symbolArray,
    Object.defineProperty({}, 'hidden', { value: null }),
    new Array(1),
    accessorArray,
    nonEnumerableArray,
    foreignArray,
    Object.assign([], { extra: true }),
    Object.create({ inherited: true }),
  ]) {
    expectProtocolFailure(
      () => validateCanonicalResponse(unknownResponse(value), 'call_1'),
      'invalid_response',
    );
  }
  const getterBlock = Object.defineProperty({ type: 'unknown' }, 'value', {
    enumerable: true,
    get: () => {
      getterCalls++;
      return null;
    },
  });
  expectProtocolFailure(
    () => validateCanonicalResponse(responseWithContent([getterBlock]), 'call_1'),
    'invalid_response',
  );
  assertEqual(getterCalls, 0, 'Validation never reads accessors.');
  assertEqual(toJsonCalls, 0, 'Validation never invokes toJSON to repair input.');
}

function testRejectsResponseProxiesWithoutTraps(): void {
  let trapCalls = 0;
  function trap(): never {
    trapCalls++;
    throw new Error('Proxy trap must never run.');
  }
  function proxy<T extends object>(target: T): T {
    return new Proxy(target, {
      get: trap,
      set: trap,
      has: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      setPrototypeOf: trap,
      defineProperty: trap,
      deleteProperty: trap,
      isExtensible: trap,
      preventExtensions: trap,
    });
  }
  const result = { id: 'call_1', status: 'completed', content: [] };
  const block = { type: 'unknown', value: null };
  const malformed = [
    proxy(canonicalSuccess()),
    proxy(canonicalError()),
    { error: proxy({ code: 'rejected', message: '' }) },
    { results: proxy([result]) },
    { results: [proxy(result)] },
    responseWithContent(proxy([])),
    responseWithContent([proxy(block)]),
    unknownResponse(proxy({ key: null })),
    unknownResponse(proxy([])),
    unknownResponse({ nested: proxy({ key: null }) }),
    unknownResponse([proxy([])]),
    canonicalSuccess(undefined, proxy({ system: {} })),
    canonicalSuccess(undefined, { system: proxy({ key: null }) }),
    canonicalSuccess(undefined, { system: { nested: proxy([]) } }),
    canonicalError(undefined, proxy({ system: {} })),
    canonicalError(undefined, { system: proxy({ key: null }) }),
  ];
  const original = validateCanonicalResponse(canonicalSuccess(), 'call_1');
  for (const input of malformed) {
    expectProtocolFailure(() => validateCanonicalResponse(input, 'call_1'), 'invalid_response');
    expectProtocolFailure(
      () => validateCanonicalResponseFilterOutput(input, original, 'call_1'),
      'invalid_response',
    );
    // Typed original-response inputs remain an untrusted public API boundary.
    expectProtocolFailure(
      () =>
        validateCanonicalResponseFilterOutput(
          canonicalSuccess(),
          input as unknown as typeof original,
          'call_1',
        ),
      'invalid_response',
    );
  }
  expectProtocolFailure(
    () => validateCanonicalSuccessResponse({ results: proxy([result]) }, 'call_1'),
    'invalid_success_response',
  );
  expectProtocolFailure(
    () => validateCanonicalErrorResponse({ error: proxy({ code: 'x', message: '' }) }),
    'invalid_error_response',
  );
  expectProtocolFailure(() => isCanonicalSuccessResponse(proxy(original)), 'invalid_response');
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  expectProtocolFailure(
    () => validateCanonicalResponse(responseWithContent(revoked.proxy), 'call_1'),
    'invalid_response',
  );
  assertEqual(
    trapCalls,
    0,
    'No response, filter, reflection, or array length path invokes a Proxy trap.',
  );
}

function testResponseDocumentsAndExtensionsRemainStrict(): void {
  const document = encoder.encode(
    JSON.stringify(responseWithContent([{ type: 'unknown', value: null }])),
  );
  const parsed = parseCanonicalResponseDocument(document, 'call_1');
  assert(isCanonicalSuccessResponse(parsed), 'Response documents support content.');
  const bom = new Uint8Array(document.length + 3);
  bom.set([0xef, 0xbb, 0xbf]);
  bom.set(document, 3);
  expectProtocolFailure(() => parseCanonicalResponseDocument(bom, 'call_1'), 'invalid_utf8');
  expectProtocolFailure(
    () => parseCanonicalResponseDocument(new Uint8Array([0xc3, 0x28]), 'call_1'),
    'invalid_utf8',
  );
  expectProtocolFailure(
    () => parseCanonicalResponseDocument(encoder.encode('{} {}'), 'call_1'),
    'invalid_json',
  );
  for (const extensions of [
    null,
    [],
    { '': {} },
    { 'custom-mcp': {} },
    { system: [] },
    { system: null },
    { system: { value: undefined } },
  ]) {
    expectProtocolFailure(
      () => validateCanonicalResponse(canonicalSuccess(undefined, extensions), 'call_1'),
      'invalid_response',
    );
    expectProtocolFailure(
      () => validateCanonicalErrorResponse(canonicalError(undefined, extensions)),
      'invalid_error_response',
    );
  }
  const accepted = validateCanonicalErrorResponse(
    canonicalError(undefined, { system: { value: [null, true] } }),
  );
  assert(Object.isFrozen(accepted.error), 'Top-level error wrapper remains frozen.');
  assertEqual(
    JSON.stringify(accepted.extensions),
    '{"system":{"value":[null,true]}}',
    'Valid error extensions remain JSON data.',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing external-routing canonical protocol',
    tests: [
      { name: 'creates frozen request and UTF-8 JSON', run: testCreatesFrozenRequestAndUtf8Json },
      {
        name: 'rejects invalid request shape and JSON values',
        run: testRejectsInvalidRequestShapeAndJsonValues,
      },
      {
        name: 'enforces strict UTF-8 JSON documents and duplicate-member semantics',
        run: testStrictUtf8JsonDocumentsAndDuplicateMembers,
      },
      {
        name: 'validates exact success and error responses',
        run: testValidatesExactSuccessAndErrorResponses,
      },
      {
        name: 'enforces request filter mutation boundaries',
        run: testEnforcesRequestFilterMutationBoundaries,
      },
      {
        name: 'enforces response filter mutation boundaries',
        run: testEnforcesResponseFilterMutationBoundaries,
      },
      {
        name: 'accepts all statuses and ordered content',
        run: testAcceptsAllStatusesAndOrderedContent,
      },
      {
        name: 'rejects malformed content and wrappers',
        run: testRejectsMalformedContentAndWrappers,
      },
      { name: 'checks canonical base64 pad bits and MIME', run: testCanonicalImageEncodingAndMime },
      {
        name: 'copies and deeply freezes unknown JSON snapshots',
        run: testUnknownJsonValuesAndImmutableSnapshots,
      },
      {
        name: 'rejects unsafe unknown without executing input',
        run: testRejectsUnsafeUnknownWithoutExecutingInput,
      },
      {
        name: 'rejects response and filter Proxies without traps',
        run: testRejectsResponseProxiesWithoutTraps,
      },
      {
        name: 'keeps response documents and extensions strict',
        run: testResponseDocumentsAndExtensionsRemainStrict,
      },
    ],
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
