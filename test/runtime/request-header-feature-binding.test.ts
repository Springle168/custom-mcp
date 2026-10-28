import type { RuntimeRulesConfig } from '../../src/config.js';
import type { McpSessionOptions } from '../../src/runtime/runtime-extensions.js';
import type {
  BoundResultFeature,
  InitializeContribution,
  RequestHeaderFeatureRegistry,
  ResultFeatureBinding,
} from '../../src/runtime/request/feature-contracts.js';
import { REQUEST_HEADER_FEATURE_REGISTRY } from '../../src/runtime/request/feature-registry.js';
import { createRequestHeaderExtensions } from '../../src/runtime/request/request-header-extensions.js';
import { adaptToolCallResultForRequestPolicy } from '../../src/runtime/request/tool-result-adapter.js';
import { bindResultFeatures } from '../../src/runtime/request/tool-result-header-extension.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import { createTestRuntimeConfigSnapshot } from '../helpers/runtime-config.js';
import { assert, assertEqual, assertNotIncludes, runTestSuite } from '../test-utils.js';

const RULES: RuntimeRulesConfig = {
  requestHeaders: {
    onInitialize: [
      { readHeader: 'x-first', apply: 'setToolList' },
      { readHeader: 'x-second', apply: 'setInstructions' },
    ],
    onCallToolResult: [
      { match: [{ name: 'x-enable', value: 'yes' }], enable: ['structuredContentDup'] },
    ],
  },
};
const HEADERS = ['x-first', '{}', 'x-second', '{}'];
const ORIGINAL: ToolCallResult = { content: [], isError: false };
const DEFAULTS: McpSessionOptions = {
  toolService: { getDefinitions: () => [], routeToolCall: async () => ORIGINAL },
};

function registry(
  first: InitializeContribution,
  second: InitializeContribution,
  results = REQUEST_HEADER_FEATURE_REGISTRY.results,
): RequestHeaderFeatureRegistry {
  return {
    initialize: { setToolList: () => first, setInstructions: () => second },
    results,
  };
}

function expectInternalFailure(action: () => unknown): void {
  let caught: unknown;
  try {
    action();
  } catch (error: unknown) {
    caught = error;
  }
  assert(caught instanceof Error, 'Conflicting trusted contributions must throw');
  assertNotIncludes(caught.message, 'PRIVATE', 'Internal diagnostics should contain no parameters');
}

function testConflictsPrecedeAllPreparation(): void {
  let prepares = 0;
  let binds = 0;
  const prepareToolService = () => {
    prepares++;
    return DEFAULTS.toolService;
  };
  const binding: ResultFeatureBinding = {
    feature: 'structuredContentDup',
    bind: () => {
      binds++;
      return (result) => result;
    },
  };
  const cases: readonly RequestHeaderFeatureRegistry[] = [
    registry({ prepareToolService, resultBindings: [binding] }, { prepareToolService }),
    registry(
      { prepareToolService, instructions: '', resultBindings: [binding] },
      { instructions: 'PRIVATE' },
    ),
    registry({ prepareToolService, resultBindings: [binding] }, { resultBindings: [binding] }),
    registry({ prepareToolService, resultBindings: [binding] }, {}, []),
  ];
  for (const features of cases) {
    const extension = createRequestHeaderExtensions(RULES, { info() {} }, features);
    expectInternalFailure(() => extension.prepareSession?.(HEADERS, DEFAULTS));
    assertEqual(prepares, 0, 'No service preparation may run before ownership checks finish');
    assertEqual(binds, 0, 'No binding factory may run before ownership checks finish');
  }
}

function testAllParsersFinishBeforePreparation(): void {
  let prepares = 0;
  let binds = 0;
  const features: RequestHeaderFeatureRegistry = {
    ...REQUEST_HEADER_FEATURE_REGISTRY,
    initialize: {
      setToolList: () => ({
        prepareToolService: () => {
          prepares++;
          return DEFAULTS.toolService;
        },
        resultBindings: [
          {
            feature: 'structuredContentDup',
            bind: () => {
              binds++;
              return (result) => result;
            },
          },
        ],
      }),
      setInstructions: (_payload, invalid) => invalid('instructions'),
    },
  };
  const logs: string[] = [];
  const extension = createRequestHeaderExtensions(
    RULES,
    {
      info: (message) => {
        logs.push(message);
      },
    },
    features,
  );
  const preparation = extension.prepareSession?.(HEADERS, DEFAULTS);
  assert(
    preparation !== undefined && !preparation.accepted,
    'A later invalid payload must reject everything',
  );
  assertEqual(prepares, 0, 'Earlier valid contribution must not prepare a service');
  assertEqual(binds, 0, 'Earlier valid contribution must not bind a result');
  assertEqual(logs.length, 1, 'Only a safe rejection should be logged');
}

async function testNoResultStageValidatesWithoutBinding(): Promise<void> {
  let parses = 0;
  let binds = 0;
  const configuration: RuntimeRulesConfig = {
    requestHeaders: { ...RULES.requestHeaders, onCallToolResult: [] },
  };
  const extension = createRequestHeaderExtensions(
    configuration,
    { info() {} },
    {
      ...REQUEST_HEADER_FEATURE_REGISTRY,
      initialize: {
        ...REQUEST_HEADER_FEATURE_REGISTRY.initialize,
        setInstructions: () => {
          parses++;
          return {
            resultBindings: [
              {
                feature: 'structuredContentDup',
                bind: () => {
                  binds++;
                  return (result) => result;
                },
              },
            ],
          };
        },
      },
    },
  );
  const preparation = extension.prepareSession?.(['x-second', '{}'], DEFAULTS);
  assert(
    preparation !== undefined && preparation.accepted,
    'Configured parameter should be accepted',
  );
  assertEqual(parses, 1, 'Configured parameters must still be parsed without result rules');
  assertEqual(binds, 0, 'No result stage means no executable binding is created');
  assertEqual(
    preparation.options.prepareToolResult,
    undefined,
    'Parameters cannot enable result processing',
  );
  assertEqual(
    extension.defaultSessionOptions,
    undefined,
    'No default result hook should be installed',
  );
  assertEqual(
    extension.runWithPostContext,
    undefined,
    'No result context bridge should be installed',
  );
  const messages: string[] = [];
  const observed = createRequestHeaderExtensions(
    configuration,
    {
      info: (message) => {
        messages.push(message);
      },
    },
    {
      ...REQUEST_HEADER_FEATURE_REGISTRY,
      initialize: { setToolList: () => ({}), setInstructions: () => ({}) },
    },
  ).prepareSession?.(['x-second', '{}'], DEFAULTS);
  assert(
    observed !== undefined && observed.accepted,
    'Metadata-only contribution should be accepted',
  );
  await observed.onPublished?.('session');
  assert(
    messages[0]?.includes('onInitialize[1]: setInstructions') === true,
    'Validated parameters still count as applied metadata',
  );
}

function testDefaultsAndBoundCallSelection(): void {
  let binds = 0;
  const features = registry(
    {},
    {
      resultBindings: [
        {
          feature: 'structuredContentDup',
          bind: () => {
            binds++;
            return (result) => ({ ...result, boundValue: 'PRIVATE_OVERRIDE' });
          },
        },
      ],
    },
  );
  const extension = createRequestHeaderExtensions(RULES, { info() {} }, features);
  const defaults = { ...DEFAULTS, ...extension.defaultSessionOptions };
  const missing = extension.prepareSession?.([], defaults);
  assert(missing !== undefined && missing.accepted, 'Missing parameters should preserve defaults');
  assertEqual(
    missing.options.prepareToolResult,
    defaults.prepareToolResult,
    'No overrides should retain default entry identity',
  );
  assertEqual(
    missing.options.toolService,
    DEFAULTS.toolService,
    'No service contribution should allocate a view',
  );
  const overridden = extension.prepareSession?.(['x-second', '{}'], defaults);
  assert(overridden !== undefined && overridden.accepted, 'A result contribution should prepare');
  assertEqual(binds, 1, 'Result parameters bind once during session preparation');
  const prepare = overridden.options.prepareToolResult;
  const run = extension.runWithPostContext;
  assert(
    prepare !== undefined && run !== undefined,
    'Result stage should have a bound entry and context',
  );
  const snapshot = createTestRuntimeConfigSnapshot({ rootDir: process.cwd(), rules: RULES });
  for (let index = 0; index < 2; index++) {
    const unmatched = run([], () => prepare(snapshot));
    assertEqual(
      unmatched.adaptResult(ORIGINAL),
      ORIGINAL,
      'A binding cannot enable its result feature',
    );
    const matched = run(['x-enable', 'yes'], () => prepare(snapshot));
    assertEqual(
      matched.adaptResult(ORIGINAL).boundValue,
      'PRIVATE_OVERRIDE',
      'Matched calls should use the fixed session implementation',
    );
    assertNotIncludes(
      JSON.stringify(matched.getLogSummary?.()),
      'PRIVATE',
      'Summary must not retain binding parameters',
    );
  }
  assertEqual(binds, 1, 'Calls must not rebind session parameters');
}

function testGenericStaticOrderAndValidation(): void {
  type Feature = 'first' | 'second' | 'third';
  const step =
    (value: string) =>
    (result: ToolCallResult): ToolCallResult => ({
      ...result,
      content: [...result.content, { type: 'text', text: value }],
    });
  const features: readonly BoundResultFeature<Feature>[] = [
    { feature: 'first', apply: step('default-first') },
    { feature: 'second', apply: step('default-second') },
    { feature: 'third', apply: step('default-third') },
  ];
  const bindings: readonly ResultFeatureBinding<Feature>[] = [
    { feature: 'third', bind: () => step('bound-third') },
    { feature: 'first', bind: () => step('bound-first') },
  ];
  assertEqual(
    bindResultFeatures(features, []),
    features,
    'Unchanged defaults can share their table',
  );
  const bound = bindResultFeatures(features, bindings);
  assert(Object.isFrozen(bound), 'A session binding table must be immutable');
  assertEqual(bound[1], features[1], 'Untouched transforms should retain default entries');
  const adapted = adaptToolCallResultForRequestPolicy(
    ORIGINAL,
    ['third', 'first', 'second'],
    bound,
  );
  assertEqual(
    JSON.stringify(adapted.content),
    JSON.stringify([
      { type: 'text', text: 'bound-first' },
      { type: 'text', text: 'default-second' },
      { type: 'text', text: 'bound-third' },
    ]),
    'Default registration order must override enable and binding order',
  );
  assertEqual(ORIGINAL.content.length, 0, 'Sequential transforms must not modify the input');
  assertEqual(
    adaptToolCallResultForRequestPolicy(ORIGINAL, [], bound),
    ORIGINAL,
    'An empty selection must preserve input identity',
  );

  let binds = 0;
  const binding: ResultFeatureBinding<Feature> = {
    feature: 'first',
    bind: () => {
      binds++;
      return step('must-not-run');
    },
  };
  expectInternalFailure(() => bindResultFeatures(features, [binding, binding]));
  expectInternalFailure(() => bindResultFeatures(features.slice(1), [binding]));
  assertEqual(binds, 0, 'Invalid binding lists must fail before executing any factory');
}

await runTestSuite({
  title: 'Request header feature contribution binding',
  tests: [
    {
      name: 'all ownership conflicts precede preparation',
      run: testConflictsPrecedeAllPreparation,
    },
    {
      name: 'all parameter parsers finish before preparation',
      run: testAllParsersFinishBeforePreparation,
    },
    {
      name: 'initialization-only parameters validate without binding or enabling results',
      run: testNoResultStageValidatesWithoutBinding,
    },
    {
      name: 'defaults and session binding remain independent of per-call selection',
      run: testDefaultsAndBoundCallSelection,
    },
    {
      name: 'generic binding and execution retain static order and reject invalid bindings',
      run: testGenericStaticOrderAndValidation,
    },
  ],
});
