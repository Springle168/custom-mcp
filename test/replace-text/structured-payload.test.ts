import { adaptToolCallResultForRequestPolicy } from '../../src/runtime/tool-result-adapter.js';
import type { RequestHeaderPolicy } from '../../src/runtime/request-header-policy.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import {
  assert,
  assertEqual,
  runTestSuite,
} from '../test-utils.js';
import {
  assertDeepEqual,
  assertErrorResult,
  assertSuccessResult,
  callReplace,
  cleanupFixtures,
  resetFixtures,
  type ReplaceTextV2Json,
  writeFixture,
} from './helpers.js';

function policy(enabled: boolean): RequestHeaderPolicy {
  return {
    rulesConfigured: true,
    matchedRuleIndexes: enabled ? [0] : [],
    enabledFeatures: enabled ? ['structuredContent'] : [],
  };
}

function assertNoReservedPublicFields(result: ToolCallResult, label: string): void {
  assert(
    !('structuredPayload' in result),
    `${label}: public result should not expose internal structuredPayload`,
  );
  assert(
    !('structuredContent' in result),
    `${label}: feature-off public result should not expose structuredContent`,
  );
}

function assertAdapterUsesReplacePayload(
  rawResult: ToolCallResult,
  payload: ReplaceTextV2Json,
  label: string,
): void {
  assert(
    !('structuredContent' in rawResult),
    `${label}: handler result should not include protocol structuredContent`,
  );

  const featureOff = adaptToolCallResultForRequestPolicy(rawResult, policy(false));
  assertEqual(featureOff.isError, rawResult.isError, `${label}: feature-off isError`);
  assertEqual(
    featureOff.content[0]?.text,
    rawResult.content[0]?.text,
    `${label}: feature-off content text`,
  );
  assertNoReservedPublicFields(featureOff, label);

  const featureOn = adaptToolCallResultForRequestPolicy(rawResult, policy(true));
  assertEqual(featureOn.isError, rawResult.isError, `${label}: feature-on isError`);
  assertEqual(
    featureOn.content[0]?.text,
    rawResult.content[0]?.text,
    `${label}: feature-on content text`,
  );
  assert(
    !('structuredPayload' in featureOn),
    `${label}: feature-on public result should not expose internal structuredPayload`,
  );
  assertDeepEqual(
    featureOn.structuredContent,
    payload,
    `${label}: feature-on structuredContent should equal replace_text payload`,
  );
}

async function testParameterValidationFailurePayload(): Promise<void> {
  await resetFixtures();

  const rawResult = await callReplace({
    target: 'alpha',
    replacement: 'beta',
  });

  const payload = assertErrorResult(rawResult);
  assertAdapterUsesReplacePayload(rawResult, payload, 'parameter validation failure');
}

async function testPathFailurePayload(): Promise<void> {
  await resetFixtures();

  const rawResult = await callReplace({
    file_path: '../outside.txt',
    target: 'alpha',
    replacement: 'beta',
  });

  const payload = assertErrorResult(rawResult);
  assertAdapterUsesReplacePayload(rawResult, payload, 'path safety failure');
}

async function testMatchFailurePayload(): Promise<void> {
  await resetFixtures();
  await writeFixture('no-match.txt', 'alpha\n');

  const rawResult = await callReplace({
    file_path: 'no-match.txt',
    target: 'gamma',
    replacement: 'beta',
  });

  const payload = assertErrorResult(rawResult);
  assertAdapterUsesReplacePayload(rawResult, payload, 'match failure');
}

async function testSuccessPayload(): Promise<void> {
  await resetFixtures();
  await writeFixture('success.txt', 'alpha\n');

  const rawResult = await callReplace({
    file_path: 'success.txt',
    target: 'alpha',
    replacement: 'beta',
  });

  const payload = assertSuccessResult(rawResult);
  assertAdapterUsesReplacePayload(rawResult, payload, 'success');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'replace_text structured payload adapter tests',
    details:
      'Covers handler structuredPayload and runtime adapter output for validation, path, match, and success paths.',
    afterAll: cleanupFixtures,
    tests: [
      {
        name: 'Parameter validation failure provides payload',
        run: testParameterValidationFailurePayload,
      },
      { name: 'Path failure provides payload', run: testPathFailurePayload },
      { name: 'Match failure provides payload', run: testMatchFailurePayload },
      { name: 'Success provides payload', run: testSuccessPayload },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
