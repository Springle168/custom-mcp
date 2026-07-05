import type { RuntimeRulesConfig } from '../../src/config.js';
import { evaluateRequestHeaderPolicy } from '../../src/runtime/request-header-policy.js';
import { createStrictRequestHeaderView } from '../../src/runtime/request-header-view.js';
import {
  assertEqual,
  runTestSuite,
} from '../test-utils.js';

function rulesConfig(requestHeaders: RuntimeRulesConfig['requestHeaders']): RuntimeRulesConfig {
  return { requestHeaders };
}

function testRuleOrAndRuleInternalAnd(): void {
  const rules = rulesConfig([
    {
      match: [
        { name: 'x-client', value: 'android-studio' },
        { name: 'x-compat', value: 'structured-content' },
      ],
      enable: ['structuredContent'],
    },
    {
      match: [{ name: 'x-client', value: 'other-client' }],
      enable: ['structuredContent'],
    },
  ]);

  const firstPolicy = evaluateRequestHeaderPolicy(
    rules,
    createStrictRequestHeaderView([
      'X-Client', 'android-studio',
      'X-Compat', 'structured-content',
    ]),
  );
  assertEqual(firstPolicy.matchedRuleIndexes.join(','), '0', 'First rule should match only when all conditions match');

  const secondPolicy = evaluateRequestHeaderPolicy(
    rules,
    createStrictRequestHeaderView(['X-Client', 'other-client']),
  );
  assertEqual(secondPolicy.matchedRuleIndexes.join(','), '1', 'Rules should be ORed across requestHeaders entries');
}

function testExactValueMatchIsCaseSensitiveAndDoesNotTrim(): void {
  const rules = rulesConfig([
    {
      match: [{ name: 'x-client', value: 'android-studio' }],
      enable: ['structuredContent'],
    },
  ]);

  const casePolicy = evaluateRequestHeaderPolicy(
    rules,
    createStrictRequestHeaderView(['X-Client', 'Android-Studio']),
  );
  const whitespacePolicy = evaluateRequestHeaderPolicy(
    rules,
    createStrictRequestHeaderView(['X-Client', ' android-studio ']),
  );

  assertEqual(casePolicy.enabledFeatures.length, 0, 'Request value matching should be case-sensitive');
  assertEqual(whitespacePolicy.enabledFeatures.length, 0, 'Request value matching should not trim values');
}

function testDuplicateMissingInvalidAndMissingContextDoNotMatch(): void {
  const rules = rulesConfig([
    {
      match: [{ name: 'x-client', value: 'android-studio' }],
      enable: ['structuredContent'],
    },
  ]);

  const duplicatePolicy = evaluateRequestHeaderPolicy(
    rules,
    createStrictRequestHeaderView(['X-Client', 'android-studio', 'x-client', 'android-studio']),
  );
  const missingPolicy = evaluateRequestHeaderPolicy(rules, createStrictRequestHeaderView(['X-Other', 'value']));
  const invalidPolicy = evaluateRequestHeaderPolicy(rules, createStrictRequestHeaderView(['X-Client']));
  const missingContextPolicy = evaluateRequestHeaderPolicy(rules, undefined);

  assertEqual(duplicatePolicy.enabledFeatures.length, 0, 'Duplicate referenced header should not match');
  assertEqual(missingPolicy.enabledFeatures.length, 0, 'Missing referenced header should not match');
  assertEqual(invalidPolicy.enabledFeatures.length, 0, 'Invalid strict view should not match');
  assertEqual(missingContextPolicy.enabledFeatures.length, 0, 'Missing request context should not match');
  assertEqual(missingContextPolicy.rulesConfigured, true, 'rulesConfigured should still reflect selected workspace rules');
}

function testUnreferencedDuplicateDoesNotAffectMatch(): void {
  const policy = evaluateRequestHeaderPolicy(
    rulesConfig([
      {
        match: [{ name: 'x-client', value: 'android-studio' }],
        enable: ['structuredContent'],
      },
    ]),
    createStrictRequestHeaderView([
      'X-Client', 'android-studio',
      'X-Other', 'a',
      'x-other', 'b',
    ]),
  );

  assertEqual(policy.matchedRuleIndexes.join(','), '0', 'Duplicate headers not referenced by a rule should not affect matching');
  assertEqual(policy.enabledFeatures.join(','), 'structuredContent', 'Matched rule should enable structuredContent');
}

function testMatchedIndexesStableAndFeaturesDeduped(): void {
  const policy = evaluateRequestHeaderPolicy(
    rulesConfig([
      {
        match: [{ name: 'x-client', value: 'android-studio' }],
        enable: ['structuredContent'],
      },
      {
        match: [{ name: 'x-compat', value: 'structured-content' }],
        enable: ['structuredContent'],
      },
    ]),
    createStrictRequestHeaderView([
      'X-Client', 'android-studio',
      'X-Compat', 'structured-content',
    ]),
  );

  assertEqual(policy.matchedRuleIndexes.join(','), '0,1', 'Matched rule indexes should be stable');
  assertEqual(policy.enabledFeatures.join(','), 'structuredContent', 'Enabled features should be deduplicated');
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing request header policy evaluation',
    tests: [
      { name: 'rule OR and rule-internal AND', run: testRuleOrAndRuleInternalAnd },
      { name: 'exact value match is case-sensitive and does not trim', run: testExactValueMatchIsCaseSensitiveAndDoesNotTrim },
      { name: 'duplicate, missing, invalid view, and missing context do not match', run: testDuplicateMissingInvalidAndMissingContextDoNotMatch },
      { name: 'unreferenced duplicate does not affect match', run: testUnreferencedDuplicateDoesNotAffectMatch },
      { name: 'matched indexes are stable and features are deduped', run: testMatchedIndexesStableAndFeaturesDeduped },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
