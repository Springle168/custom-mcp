import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolCallResult } from '../tools/types.js';

export function isToolCallResult(value: unknown): value is ToolCallResult {
  try {
    if (!isStableJsonData(value, new Set<object>())) {
      return false;
    }

    if (Array.isArray(value) || value === null || typeof value !== 'object') {
      return false;
    }

    const result = value as Record<string, unknown>;
    if (
      !Object.hasOwn(result, 'content')
      || !Array.isArray(result.content)
      || !Object.hasOwn(result, 'isError')
      || typeof result.isError !== 'boolean'
    ) {
      return false;
    }

    if (!CallToolResultSchema.safeParse(value).success) {
      return false;
    }

    return result.content.every((block) => {
      if (block === null || Array.isArray(block) || typeof block !== 'object') {
        return false;
      }

      const type = (block as Record<string, unknown>).type;
      return type === 'text' || type === 'image';
    });
  } catch {
    // Proxies, accessors, or schema evaluation can throw. They are malformed
    // at this boundary and must not reach the adapter, logger, or transport.
    return false;
  }
}

function isStableJsonData(value: unknown, ancestors: Set<object>): boolean {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (typeof value !== 'object') {
    return false;
  }

  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? isStableJsonArray(value, ancestors)
      : isStableJsonObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function isStableJsonArray(
  value: unknown[],
  ancestors: Set<object>,
): boolean {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1
    || !Object.hasOwn(value, 'length')
  ) {
    return false;
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined
    || !('value' in lengthDescriptor)
    || lengthDescriptor.enumerable
  ) {
    return false;
  }

  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
      || !isStableJsonData(descriptor.value, ancestors)
    ) {
      return false;
    }
  }

  return true;
}

function isStableJsonObject(
  value: object,
  ancestors: Set<object>,
): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') {
      return false;
    }

    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !('value' in descriptor)
      || !isStableJsonData(descriptor.value, ancestors)
    ) {
      return false;
    }
  }

  return true;
}
