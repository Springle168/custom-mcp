import type { Config } from '../config.js';
import type { MCPTool, ToolCallResult } from './types.js';
import { textErrorResult, textResult } from './results.js';
import crypto from 'crypto';

// 类型定义
interface Question {
  question: string;
  header: string;
  type: 'choice' | 'text' | 'yesno';
  options?: Option[];
  multiSelect?: boolean;
  placeholder?: string;
}

interface Option {
  label: string;
  description: string;
}

interface AskUserParams {
  questions: Question[];
}

interface Answer {
  answer: string;
  note?: string;
}

interface PendingQuestion {
  questions: Question[];
  resolve: (result: { answers: Record<string, Answer> } | null) => void;
  createdAt: number;
}

// 全局会话存储（供 index.ts 使用）
export const pendingQuestions = new Map<string, PendingQuestion>();

// Schema 定义
const ASK_USER_TOOL_DEFINITION = {
  name: 'ask_user',
  description: `Ask the user 1-4 questions to gather preferences, clarify requirements, or make decisions. Returns structured answers with optional additional notes.

Each item in the questions array must be an object with these fields:
- question (string, required): The complete question text, clear and specific, ending with "?"
- header (string, required): Very short chip/tag label, use abbreviations. e.g. "Auth" not "Authentication", "Library", "Approach"
- type (string, required): "choice" for multiple-choice with options | "text" for free-form input | "yesno" for Yes/No confirmation
- options (array, required when type="choice"): 2-4 selectable choices, each with:
    - label (string): Display text for this option, 1-5 words. e.g. "OAuth 2.0"
    - description (string): Brief explanation. e.g. "Industry standard, supports SSO"
- multiSelect (boolean, optional): Only for type="choice". Set true to allow selecting multiple options.
- placeholder (string, optional): Only for type="text". Hint text shown in the input field.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      questions: {
        type: 'array',
        description: 'Array of 1-4 questions to ask the user.',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description:
                'The complete question to ask the user. Should be clear, specific, and end with a question mark.',
            },
            header: {
              type: 'string',
              description:
                'Very short label displayed as a chip/tag. Use abbreviations: "Auth" not "Authentication". Examples: "Auth method", "Library", "Approach".',
            },
            type: {
              type: 'string',
              enum: ['choice', 'text', 'yesno'],
              description:
                "Question type: 'choice' for multiple-choice with options, 'text' for free-form input, 'yesno' for Yes/No confirmation.",
            },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              description:
                "The selectable choices for 'choice' type questions. Provide 2-4 options. Not needed for 'text' or 'yesno' types.",
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description:
                      'The display text for this option (1-5 words). Example: "OAuth 2.0"',
                  },
                  description: {
                    type: 'string',
                    description:
                      'Brief explanation of this option. Example: "Industry standard, supports SSO"',
                  },
                },
                required: ['label', 'description'],
              },
            },
            multiSelect: {
              type: 'boolean',
              description:
                "Only applies when type='choice'. Set to true to allow selecting multiple options.",
            },
            placeholder: {
              type: 'string',
              description: "Hint text shown in the input field for type='text'.",
            },
          },
          required: ['question', 'header', 'type'],
        },
      },
    },
    required: ['questions'],
  },
};

// 参数校验
function validateParams(params: AskUserParams): string | null {
  if (!params.questions || params.questions.length === 0) {
    return 'At least one question is required.';
  }

  if (params.questions.length > 4) {
    return 'Maximum 4 questions allowed.';
  }

  for (let i = 0; i < params.questions.length; i++) {
    const q = params.questions[i];

    if (!q.question || typeof q.question !== 'string') {
      return `Question ${i + 1}: 'question' is required and must be a string.`;
    }

    if (!q.header || typeof q.header !== 'string') {
      return `Question ${i + 1}: 'header' is required and must be a string.`;
    }

    if (!q.type || !['choice', 'text', 'yesno'].includes(q.type)) {
      return `Question ${i + 1}: 'type' must be 'choice', 'text', or 'yesno'.`;
    }

    // Validate choice type
    if (q.type === 'choice') {
      if (!q.options || q.options.length < 2) {
        return `Question ${i + 1}: type='choice' requires 'options' array with 2-4 items.`;
      }
      if (q.options.length > 4) {
        return `Question ${i + 1}: 'options' array must have at most 4 items.`;
      }

      // Validate each option
      for (let j = 0; j < q.options.length; j++) {
        const opt = q.options[j];
        if (!opt.label || typeof opt.label !== 'string' || !opt.label.trim()) {
          return `Question ${i + 1}, option ${j + 1}: 'label' is required and must be a non-empty string.`;
        }
        if (
          opt.description === undefined ||
          typeof opt.description !== 'string'
        ) {
          return `Question ${i + 1}, option ${j + 1}: 'description' is required and must be a string.`;
        }
      }
    }
  }

  return null;
}

// Handler 实现
async function handleAskUser(
  args: Record<string, unknown>,
  config: Config,
): Promise<ToolCallResult> {
  const params = args as unknown as AskUserParams;

  // 参数校验
  const validationError = validateParams(params);
  if (validationError) {
    return textErrorResult(validationError);
  }

  // 创建会话
  const sessionId = crypto.randomUUID();
  const url = `http://localhost:${config.port}/ask/${sessionId}`;

  // 终端响铃提醒
  process.stdout.write('\u0007')

  // 输出 URL（用户需要手动打开浏览器）
  console.log(`\nUser input required: ${url}\n`);

  // 创建 Promise
  const answerPromise = new Promise<{ answers: Record<string, Answer> } | null>(
    (resolve) => {
      pendingQuestions.set(sessionId, {
        questions: params.questions,
        resolve,
        createdAt: Date.now(),
      });
    },
  );

  // 等待用户输入
  const result = await answerPromise;

  // 清理会话
  pendingQuestions.delete(sessionId);

  // 处理取消
  if (result === null) {
    return textResult('User dismissed ask_user dialog without answering.');
  }

  // 返回答案
  return textResult(JSON.stringify(result));
}

// HTML 表单生成
export function generateQuestionForm(
  sessionId: string,
  questions: Question[],
): string {
  const questionHtml = questions
    .map((q, index) => {
      let inputHtml = '';

      if (q.type === 'choice') {
        const inputType = q.multiSelect ? 'checkbox' : 'radio';
        const inputName = `question_${index}`;

        inputHtml = q
          .options!.map(
            (opt, optIndex) => `
        <div>
          <label>
            <input type="${inputType}" name="${inputName}" value="${escapeHtml(opt.label)}" ${!q.multiSelect ? 'required' : ''}>
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
