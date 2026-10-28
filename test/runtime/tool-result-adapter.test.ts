import type { ToolCallResult } from '../../src/tools/types.js';
import {
  INITIALIZE_REQUEST_FEATURES,
  REQUEST_FEATURES,
} from '../../src/config/request-header-rules.js';
import { adaptToolCallResultForRequestPolicy } from '../../src/runtime/request/tool-result-adapter.js';
import {
  INITIALIZE_HEADER_FEATURES,
  TOOL_RESULT_FEATURES,
} from '../../src/runtime/request/feature-registry.js';
import { assert, assertEqual, runTestSuite } from '../test-utils.js';

function testRegistryCoversEveryFeatureExactlyOnce(): void {
  assertEqual(
    Object.keys(INITIALIZE_HEADER_FEATURES).sort().join(','),
    [...INITIALIZE_REQUEST_FEATURES].sort().join(','),
    'Initialization parsers should cover exactly the configured feature identities',
  );
  const registeredFeatures = TOOL_RESULT_FEATURES.map(({ feature }) => feature);

  assertEqual(
    new Set(registeredFeatures).size,
    registeredFeatures.length,
    'Each result feature should be registered only once',
  );
  assertEqual(
    registeredFeatures.sort().join(','),
    [...REQUEST_FEATURES].sort().join(','),
    'Registry should cover every feature supported by configuration',
  );
}

function testNoEnabledFeaturesReturnsOriginalObject(): void {
  const original: ToolCallResult = {
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { native: true },
    isError: false,
  };
  const adapted = adaptToolCallResultForRequestPolicy(original, [], TOOL_RESULT_FEATURES);

  assertEqual(adapted, original, 'No enabled features should return the original result object');
}

function testEnabledFeatureIsApplied(): void {
  const original: ToolCallResult = {
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  };
  const adapted = adaptToolCallResultForRequestPolicy(
    original,
    ['structuredContentDup'],
    TOOL_RESULT_FEATURES,
  );

  assert(adapted !== original, 'Enabled feature should adapt the result');
  assertEqual(
    JSON.stringify(adapted.structuredContent),
    JSON.stringify({ content: original.content, isError: original.isError }),
    'Enabled structuredContentDup should produce its result wrapper',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing tool result feature adaptation',
    tests: [
      {
        name: 'registry covers every feature exactly once',
        run: testRegistryCoversEveryFeatureExactlyOnce,
      },
      {
        name: 'no enabled features returns original object',
        run: testNoEnabledFeaturesReturnsOriginalObject,
      },
      { name: 'enabled feature is applied', run: testEnabledFeatureIsApplied },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
