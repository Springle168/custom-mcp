import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import {
  pendingQuestions,
  type AskUserAnswerPayload,
  type AskUserQuestion,
} from '../../src/tools/ask-user.js';
import { registerAskUserRoutes } from '../../src/tools/ask-user-routes.js';
import {
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

let server: Server | undefined;
let baseUrl = '';

const QUESTIONS: AskUserQuestion[] = [
  {
    question: 'Which libraries are acceptable?',
    header: 'Libraries',
    type: 'choice',
    multiSelect: true,
    options: [
      { label: 'React', description: 'UI library' },
      { label: 'Vue', description: 'UI framework' },
    ],
  },
  {
    question: 'Please describe the migration constraints?',
    header: 'Details',
    type: 'text',
  },
];

function setPendingQuestion(
  sessionId: string,
  questions: AskUserQuestion[],
): Promise<AskUserAnswerPayload | null> {
  return new Promise((resolve) => {
    pendingQuestions.set(sessionId, {
      questions,
      resolve,
      createdAt: Date.now(),
    });
  });
}

async function startTestServer(): Promise<void> {
  const app = express();
  registerAskUserRoutes(app);

  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected ask_user test server to bind a TCP port');
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopTestServer(): Promise<void> {
  pendingQuestions.clear();

  if (!server) {
    return;
  }

  const activeServer = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => {
    activeServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function testRendersPendingQuestionForm(): Promise<void> {
  const sessionId = 'form-session';
  setPendingQuestion(sessionId, QUESTIONS);

  const response = await fetch(`${baseUrl}/ask/${sessionId}`);

  assertEqual(response.status, 200, 'Known pending session should render a form');
  const html = await response.text();
  assertIncludes(html, 'Which libraries are acceptable?', 'Form should include question text');
  assertIncludes(
    html,
    `action="/answer/${sessionId}"`,
    'Form should post answers to its matching session',
  );
}

async function testAnswerResolvesNormalizedPayload(): Promise<void> {
  const sessionId = 'answer-session';
  const answerPromise = setPendingQuestion(sessionId, QUESTIONS);
  const form = new URLSearchParams();
  form.append('question_0', 'React');
  form.append('question_0', 'Vue');
  form.set('note_0', '  Start with React  ');
  form.set('question_1', 'Keep downtime below five minutes.');

  const response = await fetch(`${baseUrl}/answer/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  assertEqual(response.status, 200, 'Answer submission should succeed');
  assertIncludes(await response.text(), '<h1>Submitted</h1>', 'Answer route should confirm submission');
  assertEqual(
    JSON.stringify(await answerPromise),
    JSON.stringify({
      answers: {
        '0': { answer: 'React\nVue', note: 'Start with React' },
        '1': { answer: 'Keep downtime below five minutes.' },
      },
    }),
    'Answer route should normalize form data before resolving the pending question',
  );
}

async function testCancelResolvesNull(): Promise<void> {
  const sessionId = 'cancel-session';
  const answerPromise = setPendingQuestion(sessionId, QUESTIONS);

  const response = await fetch(`${baseUrl}/cancel/${sessionId}`, {
    method: 'POST',
  });

  assertEqual(response.status, 200, 'Cancel submission should succeed');
  assertEqual(
    await response.text(),
    JSON.stringify({ success: true }),
    'Cancel route should return its success response',
  );
  assertEqual(await answerPromise, null, 'Cancel route should resolve the pending question with null');
}

async function testUnknownSessionsReturnExpectedErrors(): Promise<void> {
  const formResponse = await fetch(`${baseUrl}/ask/missing-session`);
  assertEqual(formResponse.status, 404, 'Unknown form session should return 404');
  assertIncludes(
    await formResponse.text(),
    'Session not found or expired',
    'Unknown form session should use the existing HTML error message',
  );

  const answerResponse = await fetch(`${baseUrl}/answer/missing-session`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assertEqual(answerResponse.status, 404, 'Unknown answer session should return 404');
  assertIncludes(
    await answerResponse.text(),
    'Session not found or expired',
    'Unknown answer session should use the existing HTML error message',
  );

  const cancelResponse = await fetch(`${baseUrl}/cancel/missing-session`, {
    method: 'POST',
  });
  assertEqual(cancelResponse.status, 404, 'Unknown cancel session should return 404');
  assertEqual(
    await cancelResponse.text(),
    JSON.stringify({ error: 'Session not found' }),
    'Unknown cancel session should use the existing JSON error response',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'ask_user HTTP route tests',
    beforeAll: startTestServer,
    afterAll: stopTestServer,
    tests: [
      { name: 'pending session renders form', run: testRendersPendingQuestionForm },
      { name: 'answer resolves normalized payload', run: testAnswerResolvesNormalizedPayload },
      { name: 'cancel resolves null', run: testCancelResolvesNull },
      { name: 'unknown sessions return expected errors', run: testUnknownSessionsReturnExpectedErrors },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
