import { ConfigError } from './errors.js';
import { readToken, readTypedString, type ValuePolicyResult } from './value-policy.js';

export const REQUEST_FEATURES = ['structuredContentDup'] as const;
export type RuntimeRequestFeature = (typeof REQUEST_FEATURES)[number];

export const INITIALIZE_REQUEST_FEATURES = ['setToolList', 'setInstructions'] as const;
export type RuntimeInitializeRequestFeature = (typeof INITIALIZE_REQUEST_FEATURES)[number];

/** A single initialization parameter source; each feature and header binds at most once. */
export interface RuntimeInitializeRequestHeaderRule {
  readonly readHeader: string;
  readonly apply: RuntimeInitializeRequestFeature;
}

export interface RuntimeRequestHeaderMatchCondition {
  readonly name: string;
  readonly value: string;
}

export interface RuntimeRequestHeaderRule {
  readonly match: readonly RuntimeRequestHeaderMatchCondition[];
  readonly enable: readonly RuntimeRequestFeature[];
}

export interface RuntimeRequestHeaderRules {
  readonly onInitialize: readonly RuntimeInitializeRequestHeaderRule[];
  readonly onCallToolResult: readonly RuntimeRequestHeaderRule[];
}

export interface RuntimeRulesConfig {
  readonly requestHeaders: RuntimeRequestHeaderRules;
}

export interface RequestHeaderRulesParseContext {
  readonly configFilePath: string;
}

const RULES_FIELDS = new Set(['requestHeaders']);
const REQUEST_HEADERS_FIELDS = new Set(['onInitialize', 'onCallToolResult']);
const INITIALIZE_RULE_FIELDS = new Set(['readHeader', 'apply']);
const REQUEST_HEADER_RULE_FIELDS = new Set(['match', 'enable']);
const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function createEmptyRuntimeRulesConfig(): RuntimeRulesConfig {
  return { requestHeaders: { onInitialize: [], onCallToolResult: [] } };
}

export function readOptionalRulesConfig(
  context: RequestHeaderRulesParseContext,
  value: unknown,
  fieldPath: string,
): RuntimeRulesConfig {
  if (value === undefined) {
    return createEmptyRuntimeRulesConfig();
  }

  const rawRules = readObject(
    context,
    value,
    fieldPath,
    `${fieldPath} must be a JSON object when configured.`,
  );
  assertKnownFields(context, rawRules, RULES_FIELDS, fieldPath);

  if (rawRules.requestHeaders === undefined) {
    return createEmptyRuntimeRulesConfig();
  }

  const headersPath = `${fieldPath}.requestHeaders`;
  const rawHeaders = readObject(
    context,
    rawRules.requestHeaders,
    headersPath,
    `${headersPath} must be a JSON object.`,
  );
  assertKnownFields(context, rawHeaders, REQUEST_HEADERS_FIELDS, headersPath);

  return {
    requestHeaders: {
      onInitialize: readInitializeRequestHeaderRules(
        context,
        rawHeaders.onInitialize,
        `${headersPath}.onInitialize`,
      ),
      onCallToolResult: readRequestHeaderRules(
        context,
        rawHeaders.onCallToolResult,
        `${headersPath}.onCallToolResult`,
      ),
    },
  };
}

function readInitializeRequestHeaderRules(
  context: RequestHeaderRulesParseContext,
  value: unknown,
  fieldPath: string,
): RuntimeInitializeRequestHeaderRule[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(context, fieldPath, `${fieldPath} must be an array.`);
  }

  const seenHeaders = new Set<string>();
  const seenFeatures = new Set<RuntimeInitializeRequestFeature>();
  return value.map((item, index) => {
    const itemPath = `${fieldPath}[${index}]`;
    const rawRule = readObject(context, item, itemPath, `${itemPath} must be a JSON object.`);
    assertKnownFields(context, rawRule, INITIALIZE_RULE_FIELDS, itemPath);
    assertRequired(context, rawRule, 'readHeader', `${itemPath}.readHeader`);
    assertRequired(context, rawRule, 'apply', `${itemPath}.apply`);

    const readHeader = readHeaderName(context, rawRule.readHeader, `${itemPath}.readHeader`);
    const apply = unwrapPolicy(
      context,
      readToken<RuntimeInitializeRequestFeature>(rawRule.apply, {
        fieldPath: `${itemPath}.apply`,
        allowedValues: INITIALIZE_REQUEST_FEATURES,
        description: `one of: ${INITIALIZE_REQUEST_FEATURES.join(', ')}`,
      }),
    );

    if (seenHeaders.has(readHeader)) {
      fail(
        context,
        `${itemPath}.readHeader`,
        `${itemPath}.readHeader duplicates header name after lowercase normalization. Initialization header names must be unique ignoring case.`,
      );
    }
    if (seenFeatures.has(apply)) {
      fail(
        context,
        `${itemPath}.apply`,
        `${itemPath}.apply contains duplicate feature "${apply}". Each initialization feature may be configured only once.`,
      );
    }
    seenHeaders.add(readHeader);
    seenFeatures.add(apply);
    return { readHeader, apply };
  });
}

function readRequestHeaderRules(
  context: RequestHeaderRulesParseContext,
  value: unknown,
  fieldPath: string,
): RuntimeRequestHeaderRule[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(context, fieldPath, `${fieldPath} must be an array.`);
  }

  return value.map((item, index) => readRequestHeaderRule(context, item, `${fieldPath}[${index}]`));
}

function readRequestHeaderRule(
  context: RequestHeaderRulesParseContext,
  value: unknown,
  fieldPath: string,
): RuntimeRequestHeaderRule {
  const rawRule = readObject(context, value, fieldPath, `${fieldPath} must be a JSON object.`);
  assertKnownFields(context, rawRule, REQUEST_HEADER_RULE_FIELDS, fieldPath);
  assertRequired(context, rawRule, 'match', `${fieldPath}.match`);
  assertRequired(context, rawRule, 'enable', `${fieldPath}.enable`);

  return {
    match: readMatchConditions(context, rawRule.match, `${fieldPath}.match`),
    enable: readEnabledFeatures(context, rawRule.enable, `${fieldPath}.enable`),
  };
}

function readMatchConditions(
  context: RequestHeaderRulesParseContext,
  value: unknown,
  fieldPath: string,
): RuntimeRequestHeaderMatchCondition[] {
  const rawMatch = readObject(
    context,
    value,
    fieldPath,
    `${fieldPath} must be a non-empty JSON object.`,
  );
  const entries = Object.entries(rawMatch);
  if (entries.length === 0) {
    fail(context, fieldPath, `${fieldPath} must be a non-empty JSON object.`);
  }

  const seenNames = new Set<string>();
  return entries.map(([headerName, headerValue]) => {
    const headerFieldPath = `${fieldPath}.${headerName}`;
    const normalizedName = readHeaderName(context, headerName, headerFieldPath);

    if (seenNames.has(normalizedName)) {
      fail(
        context,
        headerFieldPath,
        `${headerFieldPath} duplicates header name "${headerName}" after lowercase normalization. Header names in one rule must be unique ignoring case.`,
      );
    }
    seenNames.add(normalizedName);

    return {
      name: normalizedName,
      value: readHeaderValue(context, headerValue, headerFieldPath),
    };
  });
}

function readHeaderName(
  context: RequestHeaderRulesParseContext,
  value: unknown,
  fieldPath: string,
): string {
  if (typeof value !== 'string') {
    fail(context, fieldPath, `${fieldPath} must be a string.`);
  }
  if (!HTTP_HEADER_NAME_RE.test(value)) {
    fail(
      context,
      fieldPath,
      `${fieldPath} contains invalid HTTP header name "${value}". Header names must match ${HTTP_HEADER_NAME_RE.source}.`,
    );
  }

  return value.toLowerCase();
}

function readHeaderValue(
  context: RequestHeaderRulesParseContext,
  value: unknown,
  fieldPath: string,
): string {
  const typedValue = unwrapPolicy(context, readTypedString(value, { fieldPath }));
  const invalidChar = findInvalidHeaderValueCharacter(typedValue);
  if (invalidChar !== undefined) {
    fail(
      context,
      fieldPath,
      `${fieldPath} must be a valid HTTP header field value. ASCII control characters except HTAB are not allowed; DEL is not allowed. Invalid character: ${invalidChar}.`,
    );
  }

  return typedValue;
}

function findInvalidHeaderValueCharacter(value: string): string | undefined {
  for (let index = 0; index < value.length; index++) {
    const codePoint = value.charCodeAt(index);
    if (codePoint === 0x7f || (codePoint <= 0x1f && codePoint !== 0x09)) {
      return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }

  return undefined;
}

function readEnabledFeatures(
  context: RequestHeaderRulesParseContext,
  value: unknown,
  fieldPath: string,
): RuntimeRequestFeature[] {
  if (!Array.isArray(value)) {
    fail(context, fieldPath, `${fieldPath} must be a non-empty array.`);
  }

  if (value.length === 0) {
    fail(context, fieldPath, `${fieldPath} must be a non-empty array.`);
  }

  const seenFeatures = new Set<RuntimeRequestFeature>();
  return value.map((item, index) => {
    const itemPath = `${fieldPath}[${index}]`;
    const feature = unwrapPolicy(
      context,
      readToken<RuntimeRequestFeature>(item, {
        fieldPath: itemPath,
        allowedValues: REQUEST_FEATURES,
        description: `one of: ${REQUEST_FEATURES.join(', ')}`,
      }),
    );

    if (seenFeatures.has(feature)) {
      fail(context, itemPath, `${itemPath} contains duplicate feature "${feature}".`);
    }
    seenFeatures.add(feature);

    return feature;
  });
}

function readObject(
  context: RequestHeaderRulesParseContext,
  value: unknown,
  fieldPath: string,
  message: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(context, fieldPath, message);
  }

  return value as Record<string, unknown>;
}

function assertKnownFields(
  context: RequestHeaderRulesParseContext,
  value: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
  parentPath: string,
): void {
  for (const key of Object.keys(value)) {
    if (!knownFields.has(key)) {
      fail(
        context,
        `${parentPath}.${key}`,
        `Unknown config field ${parentPath}.${key}. Remove it or update the config schema.`,
      );
    }
  }
}

function assertRequired(
  context: RequestHeaderRulesParseContext,
  value: Record<string, unknown>,
  key: string,
  fieldPath: string,
): void {
  if (!hasOwn(value, key)) {
    fail(context, fieldPath, `${fieldPath} is required.`);
  }
}

function unwrapPolicy<T>(context: RequestHeaderRulesParseContext, result: ValuePolicyResult<T>): T {
  if (!result.ok) {
    fail(context, result.error.fieldPath, result.error.message);
  }

  return result.value;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(context: RequestHeaderRulesParseContext, fieldPath: string, message: string): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: context.configFilePath,
    fieldPath,
    message,
    suggestion: `Fix ${fieldPath} in ${context.configFilePath} and restart the server.`,
  });
}
