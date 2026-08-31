import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import { ASK_USER_TOOL_DEFINITION } from './definitions/ask-user.definition.js';
import type { MCPTool, ToolCallResult } from './types.js';
import { textErrorResult, textResult } from './results.js';
import crypto from 'crypto';

// 类型定义
export interface AskUserQuestion {
  question: string;
  header: string;
  type: 'choice' | 'text' | 'yesno';
  options?: AskUserOption[];
  multi_select?: boolean;
  placeholder?: string;
}

export interface AskUserOption {
  label: string;
  description: string;
}

interface AskUserParams {
  questions: AskUserQuestion[];
}

export type AskUserAnswer =
  | { answer: string }
  | { answer: string; note: string };

export type AskUserAnswerPayload = {
  answers: Record<string, AskUserAnswer>;
};

interface PendingQuestion {
  questions: AskUserQuestion[];
  resolve: (result: AskUserAnswerPayload | null) => void;
  createdAt: number;
}

// 全局会话存储（供 index.ts 使用）
export const pendingQuestions = new Map<string, PendingQuestion>();

// This cross-field relation deliberately remains an executor-level semantic check.
function validateQuestionRelations(params: AskUserParams): string | null {
  for (const [i, q] of params.questions.entries()) {
    if (q.type === 'choice' && q.options === undefined) {
      return `Question ${i + 1}: type='choice' requires 'options' array with 2-4 items.`;
    }
  }

  return null;
}

// Handler 实现
async function handleAskUser(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
): Promise<ToolCallResult> {
  const params = args as unknown as AskUserParams;

  const validationError = validateQuestionRelations(params);
  if (validationError) {
    return textErrorResult(validationError);
  }

  // 创建会话
  const sessionId = crypto.randomUUID();
  const url = context.askUser.makeUrl(sessionId);

  // 终端响铃提醒
  process.stdout.write('\u0007')

  // 输出 URL（用户需要手动打开浏览器）
  console.log(`\nUser input required: ${url}\n`);

  // 创建 Promise
  const answerPromise = new Promise<AskUserAnswerPayload | null>((resolve) => {
    pendingQuestions.set(sessionId, {
      questions: params.questions,
      resolve,
      createdAt: Date.now(),
    });
  });

  // 等待用户输入
  const result = await answerPromise;

  // 清理会话
  pendingQuestions.delete(sessionId);

  // 处理取消
  if (result === null) {
    return formatAskUserCanceledResult();
  }

  // 返回答案
  return formatAskUserAnswerResult(result);
}

export function normalizeAskUserAnswerPayload(
  questions: readonly AskUserQuestion[],
  body: Record<string, unknown>,
): AskUserAnswerPayload {
  const answers: Record<string, AskUserAnswer> = {};

  for (const [i, question] of questions.entries()) {
    const answerKey = `question_${i}`;
    const noteKey = `note_${i}`;
    const answerValue =
      question.type === 'choice' && question.multi_select
        ? normalizeMultiSelectFormValue(body[answerKey])
        : normalizeSingleFormValue(body[answerKey]);
    const noteValue = normalizeSingleFormValue(body[noteKey]).trim();

    answers[i.toString()] = noteValue
      ? { answer: answerValue, note: noteValue }
      : { answer: answerValue };
  }

  return { answers };
}

export function formatAskUserAnswerResult(
  payload: AskUserAnswerPayload,
): ToolCallResult {
  return textResult(JSON.stringify(payload));
}

export function formatAskUserCanceledResult(): ToolCallResult {
  return textResult('User dismissed ask_user dialog without answering.');
}

function normalizeSingleFormValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(stringifyFormValue).join('\n');
  }

  return stringifyFormValue(value);
}

function normalizeMultiSelectFormValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(stringifyFormValue).join('\n');
  }

  return normalizeSingleFormValue(value);
}

function stringifyFormValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  try {
    return String(value);
  } catch {
    return '';
  }
}

// HTML 表单生成
export function generateQuestionForm(
  sessionId: string,
  questions: AskUserQuestion[],
): string {
  const questionHtml = questions
    .map((q, index) => {
      let inputHtml = '';

      if (q.type === 'choice') {
        const inputType = q.multi_select ? 'checkbox' : 'radio';
        const inputName = `question_${index}`;

        inputHtml = q
          .options!.map(
            (opt, optIndex) => `
        <div>
          <label>
            <input type="${inputType}" name="${inputName}" value="${escapeHtml(opt.label)}" ${!q.multi_select ? 'required' : ''}>
            <strong>${escapeHtml(opt.label)}</strong> - ${escapeHtml(opt.description)}
          </label>
        </div>
      `,
          )
          .join('');
      } else if (q.type === 'yesno') {
        inputHtml = `
        <div>
          <label>
            <input type="radio" name="question_${index}" value="Yes" required>
            Yes
          </label>
        </div>
        <div>
          <label>
            <input type="radio" name="question_${index}" value="No" required>
            No
          </label>
        </div>
      `;
      } else if (q.type === 'text') {
        const placeholder = q.placeholder
          ? ` placeholder="${escapeHtml(q.placeholder)}"`
          : '';
        inputHtml = `
        <textarea name="question_${index}" rows="10" style="width: 100%;"${placeholder} required></textarea>
      `;
      }

      return `
      <div style="margin-bottom: 2em;">
        <h3>${escapeHtml(q.header)}</h3>
        <p>${escapeHtml(q.question)}</p>
        ${inputHtml}
        <div style="margin-top: 1em;">
          <label>
            Additional notes (optional):
            <textarea name="note_${index}" rows="3" style="width: 100%;"></textarea>
          </label>
        </div>
      </div>
    `;
    })
    .join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Answer Questions</title>
</head>
<body>
  <h1>Answer Questions</h1>
  <p>Session created at: ${new Date().toISOString()}</p>
  <form method="POST" action="/answer/${sessionId}">
    ${questionHtml}
    <div>
      <button type="submit">Submit</button>
      <button type="button" onclick="cancel()">Cancel</button>
    </div>
  </form>
  <script>
    function cancel() {
      if (confirm('Are you sure you want to cancel?')) {
        fetch('/cancel/${sessionId}', { method: 'POST' })
          .then(() => {
            document.body.innerHTML = '<h1>Canceled</h1><p>You can close this window.</p>';
          });
      }
    }
  </script>
</body>
</html>
  `;
}

// HTML 转义
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 导出工具
const askUserTool: MCPTool = {
  definition: ASK_USER_TOOL_DEFINITION,
  handler: handleAskUser,
};

export default askUserTool;
