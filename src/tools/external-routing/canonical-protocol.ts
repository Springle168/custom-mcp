/**
 * The canonical protocol is the only JSON shape shared by custom-mcp,
 * external endpoints, and Processors. Keep validation here so transports and
 * runners never need to make their own, potentially divergent, assumptions.
 */

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type CanonicalExtensions = Readonly<Record<string, JsonObject>>;

export interface CanonicalCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface CanonicalRequest {
  readonly calls: readonly [CanonicalCall];
  readonly extensions?: CanonicalExtensions;
}

export interface CreateCanonicalRequestOptions {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly extensions?: CanonicalExtensions;
}

export type CanonicalResultStatus = 'completed' | 'failed' | 'cancelled';

export interface CanonicalResult {
  readonly id: string;
  readonly status: CanonicalResultStatus;
  readonly message: string;
}

export interface CanonicalSuccessResponse {
  readonly results: readonly [CanonicalResult];
  readonly extensions?: CanonicalExtensions;
}

export interface CanonicalError {
  readonly code: string;
  readonly message: string;
}

export interface CanonicalErrorResponse {
  readonly error: CanonicalError;
  readonly extensions?: CanonicalExtensions;
}

export type CanonicalResponse =
  | CanonicalSuccessResponse
  | CanonicalErrorResponse;

export type CanonicalProtocolValidationErrorCode =
  | 'invalid_utf8'
  | 'invalid_json'
  | 'invalid_request'
  | 'invalid_success_response'
  | 'invalid_error_response'
  | 'invalid_response'
  | 'request_filter_invariant'
  | 'response_filter_invariant';

/**
 * A safe, stable failure for a document that has not earned treatment as an
 * external Tool result. Its message intentionally never includes body/stdout.
 */
export class CanonicalProtocolValidationError extends Error {
  readonly code: CanonicalProtocolValidationErrorCode;
  readonly path: string | undefined;

  constructor(
    code: CanonicalProtocolValidationErrorCode,
    message: string,
    path?: string,
  ) {
    super(message);
    this.name = 'CanonicalProtocolValidationError';
    this.code = code;
    this.path = path;
  }
}

const TOOL_IDENTITY_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RESERVED_EXTENSION_NAMESPACE = 'custom-mcp';
const REQUEST_FIELDS = new Set(['calls', 'extensions']);
const CALL_FIELDS = new Set(['id', 'name', 'arguments']);
const SUCCESS_RESPONSE_FIELDS = new Set(['results', 'extensions']);
const RESULT_FIELDS = new Set(['id', 'status', 'message']);
const ERROR_RESPONSE_FIELDS = new Set(['error', 'extensions']);
const ERROR_FIELDS = new Set(['code', 'message']);

/**
 * Creates the single-call canonical request used by one external exchange.
 * Values are copied before freezing, so subsequent caller mutations cannot
 * alter the bytes eventually sent to an external endpoint.
 */
export function createCanonicalRequest(
  options: CreateCanonicalRequestOptions,
): CanonicalRequest {
  const value: Record<string, unknown> = {
    calls: [{
      id: options.id,
      name: options.name,
      arguments: options.arguments,
    }],
  };
  if (options.extensions !== undefined) {
    value.extensions = options.extensions;
  }
  return validateCanonicalRequest(value);
}

/**
 * Validates an in-memory canonical request and returns an independent,
 * deeply-frozen representation.
 */
export function validateCanonicalRequest(value: unknown): CanonicalRequest {
  return captureValidationFailure(
    'invalid_request',
    'The canonical request is invalid.',
    () => validateCanonicalRequestInternal(value, 'invalid_request'),
  );
}

/**
 * Parses exactly one strict UTF-8 JSON document, then validates it as a
 * canonical request.
 */
export function parseCanonicalRequestDocument(bytes: Uint8Array): CanonicalRequest {
  return validateCanonicalRequest(parseStrictUtf8JsonDocument(bytes));
}

/**
 * Serializes one valid request as UTF-8 JSON. TextEncoder never adds a BOM.
 */
export function encodeCanonicalRequestDocument(request: CanonicalRequest): Uint8Array {
  const validated = validateCanonicalRequest(request);
  return encodeJsonValue(validated);
}

/**
 * Validates a canonical successful response against the original call ID.
 */
export function validateCanonicalSuccessResponse(
  value: unknown,
  expectedCallId: string,
): CanonicalSuccessResponse {
  return captureValidationFailure(
    'invalid_success_response',
    'The canonical success response is invalid.',
    () => validateCanonicalSuccessResponseInternal(
      value,
      expectedCallId,
      'invalid_success_response',
      true,
    ),
  );
}

/**
 * Validates a canonical endpoint rejection response.
 */
export function validateCanonicalErrorResponse(value: unknown): CanonicalErrorResponse {
  return captureValidationFailure(
    'invalid_error_response',
    'The canonical error response is invalid.',
    () => validateCanonicalErrorResponseInternal(value, 'invalid_error_response'),
  );
}

/**
 * Validates either canonical response shape against the original call ID.
 */
export function validateCanonicalResponse(
  value: unknown,
  expectedCallId: string,
): CanonicalResponse {
  return captureValidationFailure(
    'invalid_response',
    'The canonical response is invalid.',
    () => validateCanonicalResponseInternal(value, expectedCallId, 'invalid_response', true),
  );
}

/**
 * Parses exactly one strict UTF-8 JSON document, then validates it as either
 * canonical response shape.
 */
export function parseCanonicalResponseDocument(
  bytes: Uint8Array,
  expectedCallId: string,
): CanonicalResponse {
  return validateCanonicalResponse(parseStrictUtf8JsonDocument(bytes), expectedCallId);
}

/**
 * Validates canonical-filter output. The output is a full replacement message:
 * extensions omitted by the filter are deliberately not copied from input.
 */
export function validateCanonicalRequestFilterOutput(
  value: unknown,
  originalRequest: CanonicalRequest,
): CanonicalRequest {
  const original = validateCanonicalRequest(originalRequest);
  const filtered = validateCanonicalRequest(value);

  if (filtered.calls[0].id !== original.calls[0].id) {
    throw protocolFailure(
      'request_filter_invariant',
      'A canonical request filter must preserve the original call ID.',
      'calls[0].id',
    );
  }

  return filtered;
}

/**
 * Validates canonical-filter response output. Filters may change business
 * fields, but they cannot change response kind, result cardinality, or result
 * correlation.
 */
export function validateCanonicalResponseFilterOutput(
  value: unknown,
  originalResponse: CanonicalResponse,
  expectedCallId: string,
): CanonicalResponse {
  const original = validateCanonicalResponse(originalResponse, expectedCallId);
  const filtered = captureValidationFailure(
    'invalid_response',
    'The canonical response is invalid.',
    () => validateCanonicalResponseInternal(value, expectedCallId, 'invalid_response', false),
  );

  if (isCanonicalSuccessResponse(original) !== isCanonicalSuccessResponse(filtered)) {
    throw protocolFailure(
      'response_filter_invariant',
      'A canonical response filter must preserve the response kind.',
    );
  }

  if (
    isCanonicalSuccessResponse(original) &&
    isCanonicalSuccessResponse(filtered) &&
    filtered.results[0].id !== original.results[0].id
  ) {
    throw protocolFailure(
      'response_filter_invariant',
      'A canonical response filter must preserve the original result ID.',
      'results[0].id',
    );
  }

  return filtered;
}

/**
 * Decodes one JSON document from strict UTF-8 bytes. A leading BOM is rejected
 * rather than silently consumed, because Processor JSON output is byte-level
 * protocol data rather than a configuration file.
 */
export function parseStrictUtf8JsonDocument(bytes: Uint8Array): JsonValue {
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw protocolFailure(
      'invalid_utf8',
      'Canonical JSON must be strict UTF-8 without a byte order mark.',
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw protocolFailure(
      'invalid_utf8',
      'Canonical JSON must be strict UTF-8 without a byte order mark.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw protocolFailure(
      'invalid_json',
      'Canonical JSON must contain exactly one complete JSON document.',
    );
  }

  return captureValidationFailure(
    'invalid_json',
    'Canonical JSON must contain only JSON-compatible values.',
    () => cloneJsonValue(parsed, 'document', 'invalid_json', new Set<object>()),
  );
}

export function isCanonicalSuccessResponse(
  response: CanonicalResponse,
): response is CanonicalSuccessResponse {
  return Object.prototype.hasOwnProperty.call(response, 'results');
}

function validateCanonicalRequestInternal(
  value: unknown,
  code: CanonicalProtocolValidationErrorCode,
): CanonicalRequest {
  const request = readFields(value, REQUEST_FIELDS, 'request', code);
  const callsValue = readRequiredField(request, 'calls', 'request.calls', code);
  const callValue = readSingleArrayItem(callsValue, 'request.calls', code);
  const call = readFields(callValue, CALL_FIELDS, 'request.calls[0]', code);
  const id = readOpaqueId(
    readRequiredField(call, 'id', 'request.calls[0].id', code),
    'request.calls[0].id',
    code,
  );
  const name = readToolIdentity(
    readRequiredField(call, 'name', 'request.calls[0].name', code),
    'request.calls[0].name',
    code,
  );
  const argumentsValue = readRequiredField(
    call,
    'arguments',
    'request.calls[0].arguments',
    code,
  );
  const argumentsObject = cloneJsonObject(
    argumentsValue,
    'request.calls[0].arguments',
    code,
    new Set<object>(),
  );
  const extensions = request.has('extensions')
    ? cloneExtensions(request.get('extensions'), 'request.extensions', code)
    : undefined;

  const calls: readonly [CanonicalCall] = Object.freeze([
    Object.freeze({ id, name, arguments: argumentsObject }),
  ]) as readonly [CanonicalCall];
  const result: CanonicalRequest = extensions === undefined
    ? { calls }
    : { calls, extensions };
  return Object.freeze(result);
}

function validateCanonicalResponseInternal(
  value: unknown,
  expectedCallId: string,
  code: CanonicalProtocolValidationErrorCode,
  verifyResultId: boolean,
): CanonicalResponse {
  const responseFields = readResponseFields(value, code);
  const hasResults = responseFields.has('results');
  const hasError = responseFields.has('error');

  if (hasResults === hasError) {
    throw protocolFailure(code, 'The canonical response is invalid.', 'response');
  }

  if (hasResults) {
    return validateCanonicalSuccessResponseInternal(
      value,
      expectedCallId,
      code,
      verifyResultId,
    );
  }

  return validateCanonicalErrorResponseInternal(value, code);
}

function validateCanonicalSuccessResponseInternal(
  value: unknown,
  expectedCallId: string,
  code: CanonicalProtocolValidationErrorCode,
  verifyResultId: boolean,
): CanonicalSuccessResponse {
  const expectedId = readOpaqueId(expectedCallId, 'expectedCallId', code);
  const response = readFields(value, SUCCESS_RESPONSE_FIELDS, 'response', code);
  const resultsValue = readRequiredField(response, 'results', 'response.results', code);
  const resultValue = readSingleArrayItem(resultsValue, 'response.results', code);
  const result = readFields(resultValue, RESULT_FIELDS, 'response.results[0]', code);
  const id = readOpaqueId(
    readRequiredField(result, 'id', 'response.results[0].id', code),
    'response.results[0].id',
    code,
  );
  if (verifyResultId && id !== expectedId) {
    throw protocolFailure(code, 'The canonical response is invalid.', 'response.results[0].id');
  }

  const status = readResultStatus(
    readRequiredField(result, 'status', 'response.results[0].status', code),
    'response.results[0].status',
    code,
  );
  const message = readString(
    readRequiredField(result, 'message', 'response.results[0].message', code),
    'response.results[0].message',
    code,
  );
  const extensions = response.has('extensions')
    ? cloneExtensions(response.get('extensions'), 'response.extensions', code)
    : undefined;

  const results: readonly [CanonicalResult] = Object.freeze([
    Object.freeze({ id, status, message }),
  ]) as readonly [CanonicalResult];
  const canonicalResponse: CanonicalSuccessResponse = extensions === undefined
    ? { results }
    : { results, extensions };
  return Object.freeze(canonicalResponse);
}

function validateCanonicalErrorResponseInternal(
  value: unknown,
  code: CanonicalProtocolValidationErrorCode,
): CanonicalErrorResponse {
  const response = readFields(value, ERROR_RESPONSE_FIELDS, 'response', code);
  const error = readFields(
    readRequiredField(response, 'error', 'response.error', code),
    ERROR_FIELDS,
    'response.error',
    code,
  );
  const errorCode = readNonEmptyString(
    readRequiredField(error, 'code', 'response.error.code', code),
    'response.error.code',
    code,
  );
  const message = readString(
    readRequiredField(error, 'message', 'response.error.message', code),
    'response.error.message',
    code,
  );
  const extensions = response.has('extensions')
    ? cloneExtensions(response.get('extensions'), 'response.extensions', code)
    : undefined;

  const canonicalError = Object.freeze({ code: errorCode, message });
  const canonicalResponse: CanonicalErrorResponse = extensions === undefined
    ? { error: canonicalError }
    : { error: canonicalError, extensions };
  return Object.freeze(canonicalResponse);
}

function readResponseFields(
  value: unknown,
  code: CanonicalProtocolValidationErrorCode,
): ReadonlyMap<string, unknown> {
  const fields = readObjectFields(value, 'response', code);
  for (const key of fields.keys()) {
    if (
      key !== 'results' &&
      key !== 'error' &&
      key !== 'extensions'
    ) {
      throw protocolFailure(code, 'The canonical response is invalid.', 'response');
    }
  }
  return fields;
}

function readFields(
  value: unknown,
  allowedFields: ReadonlySet<string>,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): ReadonlyMap<string, unknown> {
  const fields = readObjectFields(value, path, code);
  for (const key of fields.keys()) {
    if (!allowedFields.has(key)) {
      throw protocolFailure(code, 'The canonical message is invalid.', path);
    }
  }
  return fields;
}

function readRequiredField(
  fields: ReadonlyMap<string, unknown>,
  key: string,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): unknown {
  if (!fields.has(key)) {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }
  return fields.get(key);
}

function readSingleArrayItem(
  value: unknown,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): unknown {
  if (!Array.isArray(value) || value.length !== 1) {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }

  const descriptors = readArrayDescriptors(value, path, code);
  const item = descriptors['0'];
  if (!item || !item.enumerable || !('value' in item)) {
    throw protocolFailure(code, 'The canonical message is invalid.', `${path}[0]`);
  }
  return item.value;
}

function readOpaqueId(
  value: unknown,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }
  return value;
}

function readToolIdentity(
  value: unknown,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): string {
  if (typeof value !== 'string' || !TOOL_IDENTITY_RE.test(value)) {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }
  return value;
}

function readResultStatus(
  value: unknown,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): CanonicalResultStatus {
  if (value === 'completed' || value === 'failed' || value === 'cancelled') {
    return value;
  }
  throw protocolFailure(code, 'The canonical message is invalid.', path);
}

function readNonEmptyString(
  value: unknown,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }
  return value;
}

function readString(
  value: unknown,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): string {
  if (typeof value !== 'string') {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }
  return value;
}

function cloneExtensions(
  value: unknown,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): CanonicalExtensions {
  const entries = readObjectEntries(value, path, code);
  const copy: Record<string, JsonObject> = Object.create(null) as Record<string, JsonObject>;

  for (const [namespace, extensionValue] of entries) {
    if (namespace.length === 0 || namespace === RESERVED_EXTENSION_NAMESPACE) {
      throw protocolFailure(code, 'The canonical message is invalid.', path);
    }
    defineJsonProperty(
      copy,
      namespace,
      cloneJsonObject(extensionValue, `${path}.*`, code, new Set<object>()),
    );
  }

  return Object.freeze(copy);
}

function cloneJsonObject(
  value: unknown,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
  ancestors: Set<object>,
): JsonObject {
  const entries = readObjectEntries(value, path, code);
  const source = value as object;
  if (ancestors.has(source)) {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }

  ancestors.add(source);
  try {
    const copy: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, propertyValue] of entries) {
      defineJsonProperty(
        copy,
        key,
        cloneJsonValue(propertyValue, `${path}.*`, code, ancestors),
      );
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(source);
  }
}

function cloneJsonValue(
  value: unknown,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
  ancestors: Set<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw protocolFailure(code, 'The canonical message is invalid.', path);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return cloneJsonArray(value, path, code, ancestors);
  }
  if (typeof value === 'object') {
    return cloneJsonObject(value, path, code, ancestors);
  }
  throw protocolFailure(code, 'The canonical message is invalid.', path);
}

function cloneJsonArray(
  value: readonly unknown[],
  path: string,
  code: CanonicalProtocolValidationErrorCode,
  ancestors: Set<object>,
): readonly JsonValue[] {
  const source = value as object;
  if (ancestors.has(source)) {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }

  const descriptors = readArrayDescriptors(value, path, code);
  ancestors.add(source);
  try {
    const copy: JsonValue[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw protocolFailure(code, 'The canonical message is invalid.', `${path}[${index}]`);
      }
      copy.push(cloneJsonValue(descriptor.value, `${path}[${index}]`, code, ancestors));
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(source);
  }
}

function readObjectEntries(
  value: unknown,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): readonly (readonly [string, unknown])[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw protocolFailure(code, 'The canonical message is invalid.', path);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function readObjectFields(
  value: unknown,
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): ReadonlyMap<string, unknown> {
  return new Map(readObjectEntries(value, path, code));
}

function readArrayDescriptors(
  value: readonly unknown[],
  path: string,
  code: CanonicalProtocolValidationErrorCode,
): Readonly<Record<string, PropertyDescriptor>> {
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw protocolFailure(code, 'The canonical message is invalid.', path);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === 'length') {
      continue;
    }
    if (!isArrayIndexKey(key, value.length)) {
      throw protocolFailure(code, 'The canonical message is invalid.', path);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw protocolFailure(code, 'The canonical message is invalid.', path);
    }
  }
  return descriptors;
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) {
    return false;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function defineJsonProperty(
  target: Record<string, JsonValue> | Record<string, JsonObject>,
  key: string,
  value: JsonValue | JsonObject,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}

function encodeJsonValue(value: unknown): Uint8Array {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw protocolFailure('invalid_request', 'The canonical request is invalid.');
  }
  return new TextEncoder().encode(json);
}

function captureValidationFailure<T>(
  code: CanonicalProtocolValidationErrorCode,
  message: string,
  validate: () => T,
): T {
  try {
    return validate();
  } catch (error: unknown) {
    if (error instanceof CanonicalProtocolValidationError) {
      throw error;
    }
    throw protocolFailure(code, message);
  }
}

function protocolFailure(
  code: CanonicalProtocolValidationErrorCode,
  message: string,
  path?: string,
): CanonicalProtocolValidationError {
  return new CanonicalProtocolValidationError(code, message, path);
}
