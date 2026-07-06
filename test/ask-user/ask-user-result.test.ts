import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptToolCallResultForRequestPolicy } from '../../src/runtime/tool-result-adapter.js';
import type { RequestHeaderPolicy } from '../../src/runtime/request-header-policy.js';
import askUserTool, {
  formatAskUserAnswerResult,
  formatAskUserCanceledResult,
  normalizeAskUserAnswerPayload,
  pendingQuestions,
  type AskUserAnswerPayload,
  type AskUserQuestion,
} from '../../src/tools/ask-user.js';
import type { ToolCallResult } from '../../src/tools/types.js';
import { createTestToolRuntimeContext } from '../helpers/runtime-config.js';
import {
  assert,
  assertEqual,
  getResultText,
  runTestSuite,
} from '../test-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');

function policy(enabled: boolean): RequestHeaderPolicy {
  return {
    rulesConfigured: true,
    matchedRuleIndexes: enabled ? [0] : [],
    enabledFeatures: enabled ? ['structuredContent'] : [],
  };
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function assertNoStructuredContent(result: ToolCallResult, label: string): void {
  assert(!('structuredContent' in result), `${label}: handler result should not include protocol structuredContent`);
}

function assertNoStructuredPayload(result: ToolCallResult, label: string): void {
  assert(!('structuredPayload' in result), `${label}: result should not include internal structuredPayload`);
}

function assertAskUserPayloadResult(
  result: ToolCallResult,
  expectedPayload: AskUserAnswerPayload,
  label: string,
): void {
  assertEqual(result.isError, false, `${label}: isError should be false`);
  assertNoStructuredContent(result, label);
  assert('structuredPayload' in result, `${label}: result should include internal structuredPayload`);
  assertDeepEqual(
    result.structuredPayload,
    expectedPayload,
    `${label}: structuredPayload should equal answer payload`,
  );
  assertEqual(
    getResultText(result),
    JSON.stringify(expectedPayload),
    `${label}: content[0].text should be compact JSON`,
  );
  assertDeepEqual(
    JSON.parse(getResultText(result)) as unknown,
    expectedPayload,
    `${label}: content JSON should parse back to payload`,
  );
}

function assertAnswerPayload(
  actual: AskUserAnswerPayload,
  expected: AskUserAnswerPayload,
  label: string,
): void {
  assertDeepEqual(actual, expected, label);
}

function createQuestions(): AskUserQuestion[] {
  return [
    {
      question: 'Which auth method should we use?',
      header: 'Auth',
      type: 'choice',
      options: [
        { label: 'OAuth 2.0', description: 'Industry standard' },
        { label: 'JWT', description: 'Compact token' },
      ],
    },
    {
      question: 'Please describe the migration constraints?',
      header: 'Details',
      type: 'text',
    },
    {
      question: 'Should we enable rate limiting?',
      header: 'Rate',
      type: 'yesno',
    },
    {
      question: 'Which libraries are acceptable?',
      header: 'Libs',
      type: 'choice',
      multiSelect: true,
      options: [
        { label: 'React', description: 'UI library' },
        { label: 'Vue', description: 'UI framework' },
      ],
    },
  ];
}

function testNormalizeAnswerPayload(): void {
  const payload = normalizeAskUserAnswerPayload(createQuestions(), {
    question_0: 'OAuth 2.0',
    note_0: '  with PKCE  ',
    question_1: 'Keep downtime below 5 minutes.\nPrefer a staged rollout.',
    note_1: '   ',
    question_2: 'Yes',
    question_3: ['React', 'Vue'],
    note_3: '\nship React first\t',
  });

  assertAnswerPayload(
    payload,
    {
      answers: {
        '0': { answer: 'OAuth 2.0', note: 'with PKCE' },
        '1': { answer: 'Keep downtime below 5 minutes.\nPrefer a staged rollout.' },
        '2': { answer: 'Yes' },
        '3': { answer: 'React\nVue', note: 'ship React first' },
      },
    },
    'Normalized payload should cover single choice, text, yes/no, multi-select array, and notes',
  );
}

function testNormalizeMultiSelectSingleValue(): void {
  const payload = normalizeAskUserAnswerPayload(
    [
      {
        question: 'Which auth method should we use?',
        header: 'Auth',
        type: 'choice',
        multiSelect: true,
        options: [
          { label: 'OAuth 2.0', description: 'Industry standard' },
          { label: 'JWT', description: 'Compact token' },
        ],
      },
    ],
    {
      question_0: 'JWT',
      note_0: '   ',
    },
  );

  assertAnswerPayload(
    payload,
    { answers: { '0': { answer: 'JWT' } } },
    'Multi-select single form value should be kept as a single answer and empty note should be omitted',
  );
}

function testFormatAnswerResult(): void {
  const payload: AskUserAnswerPayload = {
    answers: {
      '0': { answer: 'OAuth 2.0', note: 'with PKCE' },
      '1': { answer: 'Yes' },
      '2': { answer: 'React\nVue' },
    },
  };

  assertAskUserPayloadResult(
    formatAskUserAnswerResult(payload),
    payload,
    'Formatted ask_user answer result',
  );
}

function testFormatCanceledResult(): void {
  const result = formatAskUserCanceledResult();

  assertEqual(result.isError, false, 'Cancel result should not be a tool error');
  assertEqual(
    getResultText(result),
    'User dismissed ask_user dialog without answering.',
    'Cancel result should use natural text',
  );
  assertNoStructuredContent(result, 'Cancel result');
  assertNoStructuredPayload(result, 'Cancel result');
}

async function testHandlerAnswerResultHasOnlyInternalPayload(): Promise<void> {
  pendingQuestions.clear();

  const stdout = process.stdout as typeof process.stdout & {
    write: (chunk: unknown, ...args: unknown[]) => boolean;
  };
  const originalWrite = stdout.write;
  stdout.write = () => true;

  try {
    const context = createTestToolRuntimeContext({ rootDir: PROJECT_ROOT });
    const resultPromise = askUserTool.handler(
      {
        questions: [
          {
            question: 'Which auth method should we use?',
            header: 'Auth',
            type: 'choice',
            options: [
              { label: 'OAuth 2.0', description: 'Industry standard' },
              { label: 'JWT', description: 'Compact token' },
            ],
          },
        ],
      },
      context,
    );

    assertEqual(pendingQuestions.size, 1, 'Handler should create one pending ask_user session');
    const pending = [...pendingQuestions.values()][0];
    assert(pending !== undefined, 'Pending session should be available for test resolution');

    const payload: AskUserAnswerPayload = {
      answers: {
        '0': { answer: 'OAuth 2.0', note: 'with PKCE' },
      },
    };
    pending.resolve(payload);

    const result = await resultPromise;
    assertAskUserPayloadResult(result, payload, 'Handler answer result');
    assertEqual(pendingQuestions.size, 0, 'Handler should clean up the pending session');
  } finally {
    stdout.write = originalWrite;
    pendingQuestions.clear();
  }
}

async function testAdapterUsesPayloadAndFallbacks(): Promise<void> {
  const payload: AskUserAnswerPayload = {
    answers: {
      '0': { answer: 'OAuth 2.0' },
    },
  };
  const answerResult = formatAskUserAnswerResult(payload);
  const adaptedAnswer = adaptToolCallResultForRequestPolicy(answerResult, policy(true));

  assertDeepEqual(
    adaptedAnswer.structuredContent,
    payload,
    'Feature-on adapter should expose ask_user answer payload object',
  );
  assert(!('structuredPayload' in adaptedAnswer), 'Adapted answer result should not expose internal structuredPayload');

  const cancelResult = formatAskUserCanceledResult();
  const adaptedCancel = adaptToolCallResultForRequestPolicy(cancelResult, policy(true));
  assertEqual(
    adaptedCancel.structuredContent,
    '\nUser dismissed ask_user dialog without answering.\n',
    'Feature-on adapter should use text fallback for cancellation',
  );

  const validationResult = await askUserTool.handler(
    { questions: [] },
    createTestToolRuntimeContext({ rootDir: PROJECT_ROOT }),
  );
  const adaptedValidation = adaptToolCallResultForRequestPolicy(validationResult, policy(true));
  assertEqual(validationResult.isError, true, 'Invalid ask_user parameters should be a tool error');
  assertNoStructuredPayload(validationResult, 'Validation error');
  assertEqual(
    adaptedValidation.structuredContent,
    '\nAt least one question is required.\n',
    'Feature-on adapter should use text fallback for validation errors',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'ask_user result payload tests',
    afterAll: () => {
      pendingQuestions.clear();
    },
    tests: [
      { name: 'answer normalization covers form shapes', run: testNormalizeAnswerPayload },
      { name: 'multi-select single value normalization', run: testNormalizeMultiSelectSingleValue },
      { name: 'answer result formatter writes internal payload', run: testFormatAnswerResult },
      { name: 'cancel result formatter uses fallback text shape', run: testFormatCanceledResult },
      { name: 'handler answer result does not write protocol field', run: testHandlerAnswerResultHasOnlyInternalPayload },
      { name: 'adapter maps ask_user payload and fallback paths', run: testAdapterUsesPayloadAndFallbacks },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
