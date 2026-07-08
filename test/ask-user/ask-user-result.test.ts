import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

function assertNoProtocolStructuredContent(result: ToolCallResult, label: string): void {
  assert(
    !('structuredContent' in result),
    `${label}: handler result should not include protocol structuredContent`,
  );
}

function assertAnswerTextResult(
  result: ToolCallResult,
  expectedPayload: AskUserAnswerPayload,
  label: string,
): void {
  assertEqual(result.isError, false, `${label}: isError should be false`);
  assertNoProtocolStructuredContent(result, label);
  assertEqual(
    getResultText(result),
    JSON.stringify(expectedPayload),
    `${label}: content[0].text should be compact JSON`,
  );
  assertDeepEqual(
    JSON.parse(getResultText(result)) as unknown,
    expectedPayload,
    `${label}: content JSON should parse back to the answer payload`,
  );
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

  assertDeepEqual(
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

  assertDeepEqual(
    payload,
    { answers: { '0': { answer: 'JWT' } } },
    'Multi-select single form value should be kept as one answer and empty note should be omitted',
  );
}

function testNormalizeNonStringValues(): void {
  const valueThatCannotBeStringified = Object.create(null) as Record<string, unknown>;
  const payload = normalizeAskUserAnswerPayload(
    [
      {
        question: 'How many retries?',
        header: 'Retries',
        type: 'text',
      },
      {
        question: 'Which flags?',
        header: 'Flags',
        type: 'choice',
        multiSelect: true,
        options: [
          { label: 'true', description: 'Enable' },
          { label: '3', description: 'Three' },
        ],
      },
      {
        question: 'Any extra detail?',
        header: 'Extra',
        type: 'text',
      },
    ],
    {
      question_0: 3,
      note_0: false,
      question_1: [true, 7, null, undefined],
      question_2: valueThatCannotBeStringified,
    },
  );

  assertDeepEqual(
    payload,
    {
      answers: {
        '0': { answer: '3', note: 'false' },
        '1': { answer: 'true\n7\n\n' },
        '2': { answer: '' },
      },
    },
    'Non-string form values should be safely stringified without throwing',
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

  assertAnswerTextResult(
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
  assertNoProtocolStructuredContent(result, 'Cancel result');
}

async function testHandlerAnswerResult(): Promise<void> {
  pendingQuestions.clear();

  const originalWrite = process.stdout.write;
  process.stdout.write = ((...args: unknown[]) => {
    const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === 'function');
    callback?.();
    return true;
  }) as typeof process.stdout.write;

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
    assertAnswerTextResult(result, payload, 'Handler answer result');
    assertEqual(pendingQuestions.size, 0, 'Handler should clean up the pending session');
  } finally {
    process.stdout.write = originalWrite;
    pendingQuestions.clear();
  }
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'ask_user result formatting tests',
    afterAll: () => {
      pendingQuestions.clear();
    },
    tests: [
      { name: 'answer normalization covers form shapes', run: testNormalizeAnswerPayload },
      { name: 'multi-select single value normalization', run: testNormalizeMultiSelectSingleValue },
      { name: 'non-string form values stringify safely', run: testNormalizeNonStringValues },
      { name: 'answer result formatter writes compact JSON text', run: testFormatAnswerResult },
      { name: 'cancel result formatter uses natural text', run: testFormatCanceledResult },
      { name: 'handler formats answered result', run: testHandlerAnswerResult },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
