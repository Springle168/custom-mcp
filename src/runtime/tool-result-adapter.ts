import type { JsonValue, ToolCallResult } from '../tools/types.js';
import type { RequestHeaderPolicy } from './request-header-policy.js';

export function adaptToolCallResultForRequestPolicy(
  result: ToolCallResult,
  policy: RequestHeaderPolicy,
): ToolCallResult {
  const {
    structuredPayload,
    structuredContent: _handlerStructuredContent,
    ...publicResult
  } = result;

  if (!policy.enabledFeatures.includes('structuredContent')) {
    return publicResult;
  }

  return {
    ...publicResult,
    structuredContent: isJsonValue(structuredPayload)
      ? structuredPayload
      : wrapTextBlock(publicResult.content[0]?.text ?? ''),
  };
}

function wrapTextBlock(text: string): string {
  return `\n${text}\n`;
}

function isJsonValue(value: unknown, ancestors = new WeakSet<object>()): value is JsonValue {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      return isJsonArrayOrObject(value, ancestors);
    default:
      return false;
  }
}

function isJsonArrayOrObject(
  value: object,
  ancestors: WeakSet<object>,
): value is JsonValue[] | { [key: string]: JsonValue } {
  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return isJsonArray(value, ancestors);
    }

    return isJsonPlainObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function isJsonArray(value: readonly unknown[], ancestors: WeakSet<object>): value is JsonValue[] {
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return false;
    }

    let item: unknown;
    try {
      item = value[index];
    } catch {
      return false;
    }

    if (!isJsonValue(item, ancestors)) {
      return false;
    }
  }

  return true;
}

function isJsonPlainObject(value: object, ancestors: WeakSet<object>): value is { [key: string]: JsonValue } {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    let propertyValue: unknown;
    try {
      propertyValue = record[key];
    } catch {
      return false;
    }

    if (!isJsonValue(propertyValue, ancestors)) {
      return false;
    }
  }

  return true;
}
