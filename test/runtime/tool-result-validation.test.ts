import { isToolCallResult } from '../../src/runtime/invocation/tool-result-validation.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

const IMAGE_DATA = 'aW1hZ2UtZGF0YQ==';

function validMixedResult(isError = false): ToolCallResult {
  return {
    content: [
      { type: 'text', text: 'before' },
      { type: 'image', data: IMAGE_DATA, mimeType: 'image/png' },
      { type: 'image', data: '', mimeType: 'image/webp' },
      { type: 'text', text: 'after' },
    ],
    structuredContent: { width: 1, nested: [null, true, 2] },
    _meta: { 'example.com/result-id': 'result-1' },
    extension: { enabled: true },
    isError,
  };
}

function assertMalformed(value: unknown, label: string): void {
  assertEqual(isToolCallResult(value), false, `${label} should be rejected`);
}

function testAcceptsSupportedResults(): void {
  const cases: Array<{ readonly label: string; readonly value: ToolCallResult }> = [
    { label: 'empty content', value: { content: [], isError: false } },
    {
      label: 'text content',
      value: { content: [{ type: 'text', text: 'ok' }], isError: false },
    },
    {
      label: 'image content',
      value: {
        content: [{ type: 'image', data: IMAGE_DATA, mimeType: 'image/png' }],
        isError: false,
      },
    },
    { label: 'mixed success content', value: validMixedResult(false) },
    { label: 'mixed error content', value: validMixedResult(true) },
  ];

  for (const testCase of cases) {
    assert(isToolCallResult(testCase.value), `${testCase.label} should be accepted`);
  }
}

function testRejectsMalformedProtocolFields(): void {
  const cases: Array<{ readonly label: string; readonly value: unknown }> = [
    { label: 'null result', value: null },
    { label: 'array result', value: [] },
    { label: 'missing content', value: { isError: false } },
    { label: 'non-array content', value: { content: {}, isError: false } },
    { label: 'missing isError', value: { content: [] } },
    { label: 'non-boolean isError', value: { content: [], isError: 'false' } },
    {
      label: 'image without data',
      value: { content: [{ type: 'image', mimeType: 'image/png' }], isError: false },
    },
    {
      label: 'image without mimeType',
      value: { content: [{ type: 'image', data: IMAGE_DATA }], isError: false },
    },
    {
      label: 'image with non-string data',
      value: {
        content: [{ type: 'image', data: 1, mimeType: 'image/png' }],
        isError: false,
      },
    },
    {
      label: 'image with invalid base64',
      value: {
        content: [{ type: 'image', data: 'not base64!', mimeType: 'image/png' }],
        isError: false,
      },
    },
    {
      label: 'data URI image',
      value: {
        content: [{
          type: 'image',
          data: 'data:image/png;base64,aW1hZ2U=',
          mimeType: 'image/png',
        }],
        isError: false,
      },
    },
    {
      label: 'audio block',
      value: {
        content: [{ type: 'audio', data: IMAGE_DATA, mimeType: 'audio/wav' }],
        isError: false,
      },
    },
    {
      label: 'resource link block',
      value: {
        content: [{ type: 'resource_link', uri: 'file:///tmp/example' }],
        isError: false,
      },
    },
    {
      label: 'unknown block',
      value: { content: [{ type: 'custom', value: 'x' }], isError: false },
    },
    {
      label: 'non-object _meta',
      value: { content: [], isError: false, _meta: 'metadata' },
    },
    {
      label: 'non-object structuredContent',
      value: { content: [], isError: false, structuredContent: [] },
    },
  ];

  for (const testCase of cases) {
    assertMalformed(testCase.value, testCase.label);
  }
}

function testRejectsUnstableJsonData(): void {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  const sparseContent = new Array(1);
  const arrayWithExtraProperty: unknown[] = [];
  Object.defineProperty(arrayWithExtraProperty, 'extra', {
    value: true,
    enumerable: true,
  });

  const symbolValue = Symbol('value');
  const symbolKey = Symbol('key');
  const objectWithSymbolKey: Record<PropertyKey, unknown> = {};
  objectWithSymbolKey[symbolKey] = true;

  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'hidden', {
    value: true,
    enumerable: false,
  });

  const accessor = {};
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      throw new Error('must not be read');
    },
  });

  const cases: Array<{ readonly label: string; readonly extension: unknown }> = [
    { label: 'undefined', extension: undefined },
    { label: 'bigint', extension: 1n },
    { label: 'symbol', extension: symbolValue },
    { label: 'function', extension: () => undefined },
    { label: 'NaN', extension: Number.NaN },
    { label: 'infinity', extension: Number.POSITIVE_INFINITY },
    { label: 'circular object', extension: circular },
    { label: 'date custom prototype', extension: new Date(0) },
    {
      label: 'custom prototype',
      extension: Object.create({ inherited: true }) as object,
    },
    {
      label: 'custom toJSON',
      extension: { toJSON() { return 'changed'; } },
    },
    { label: 'symbol-keyed property', extension: objectWithSymbolKey },
    { label: 'non-enumerable property', extension: nonEnumerable },
    { label: 'accessor property', extension: accessor },
    { label: 'sparse array', extension: sparseContent },
    { label: 'array extra property', extension: arrayWithExtraProperty },
  ];

  for (const testCase of cases) {
    assertMalformed(
      { content: [], isError: false, extension: testCase.extension },
      testCase.label,
    );
  }
}

function testAllowsAcyclicSharedReferencesAndNullPrototypeObjects(): void {
  const shared = { value: 'shared' };
  const extension = Object.create(null) as Record<string, unknown>;
  extension.first = shared;
  extension.second = shared;

  assert(
    isToolCallResult({ content: [], isError: false, extension }),
    'Acyclic shared references and null-prototype objects should be accepted',
  );
}

function testContainsThrowingProxy(): void {
  const throwingProxy = new Proxy({}, {
    ownKeys() {
      throw new Error('proxy trap failure');
    },
  });

  assertMalformed(
    { content: [], isError: false, extension: throwingProxy },
    'throwing proxy',
  );
}

function testRejectsStatefulProxyBeforeSchemaEvaluation(): void {
  let dataReads = 0;
  const image = new Proxy(
    {
      type: 'image',
      data: IMAGE_DATA,
      mimeType: 'image/png',
    },
    {
      get(target, property, receiver) {
        if (property === 'data') {
          dataReads++;
          return dataReads === 1 ? target.data : 'invalid base64!';
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );

  assertMalformed(
    { content: [image], isError: false },
    'stateful image proxy',
  );
  assertEqual(dataReads, 0, 'Proxy results should be rejected before schema evaluation');
}

function compileTimeContractExamples(): void {
  const richResult = {
    content: [
      { type: 'text', text: 'preview' },
      { type: 'image', data: IMAGE_DATA, mimeType: 'image/png' },
    ],
    structuredContent: { width: 100 },
    _meta: { 'example.com/id': 'example' },
    isError: false,
  } satisfies ToolCallResult;
  void richResult;

  // @ts-expect-error Project results require an explicit isError value.
  const missingIsError: ToolCallResult = { content: [] };
  void missingIsError;

  const unsupportedAudio: ToolCallResult = {
    content: [
      // @ts-expect-error Project results do not support MCP audio content.
      { type: 'audio', data: IMAGE_DATA, mimeType: 'audio/wav' },
    ],
    isError: false,
  };
  void unsupportedAudio;
}

async function main(): Promise<void> {
  compileTimeContractExamples();
  await runTestSuite({
    title: 'Testing tool result validation',
    tests: [
      { name: 'accepts supported text and image results', run: testAcceptsSupportedResults },
      { name: 'rejects malformed protocol fields', run: testRejectsMalformedProtocolFields },
      { name: 'rejects unstable JSON data', run: testRejectsUnstableJsonData },
      { name: 'allows acyclic shared references and null prototypes', run: testAllowsAcyclicSharedReferencesAndNullPrototypeObjects },
      { name: 'contains throwing proxies', run: testContainsThrowingProxy },
      { name: 'rejects stateful proxies before schema evaluation', run: testRejectsStatefulProxyBeforeSchemaEvaluation },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
