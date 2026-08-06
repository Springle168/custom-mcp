import express, { type Express } from 'express';
import {
  generateQuestionForm,
  normalizeAskUserAnswerPayload,
  pendingQuestions,
} from './ask-user.js';

/**
 * Registers the browser endpoints that deliver and resolve ask_user prompts.
 *
 * These routes deliberately share the tool's pending-question store rather than
 * MCP HTTP sessions: a browser submission only needs the generated prompt ID.
 */
export function registerAskUserRoutes(app: Express): void {
  app.get('/ask/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const pending = pendingQuestions.get(sessionId);

    if (!pending) {
      res.status(404).send('<h1>Session not found or expired</h1>');
      return;
    }

    const html = generateQuestionForm(sessionId, pending.questions);
    res.send(html);
  });

  app.post(
    '/answer/:sessionId',
    express.urlencoded({ extended: true }),
    (req, res) => {
      const { sessionId } = req.params;
      const pending = pendingQuestions.get(sessionId);

      if (!pending) {
        res.status(404).send('<h1>Session not found or expired</h1>');
        return;
      }

      const payload = normalizeAskUserAnswerPayload(
        pending.questions,
        req.body as Record<string, unknown>,
      );

      pending.resolve(payload);

      res.send(`
        <h1>Submitted</h1>
        <p>Your answers have been recorded. You can close this window.</p>
      `);
    },
  );

  app.post('/cancel/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const pending = pendingQuestions.get(sessionId);

    if (!pending) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    pending.resolve(null);

    res.json({ success: true });
  });
}
