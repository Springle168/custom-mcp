import type { MCPTool } from '../types.js';

export const ASK_USER_TOOL_DEFINITION = {
  name: 'ask_user',
  description: `Ask the user 1-4 questions to gather preferences, clarify requirements, or make decisions. Returns structured answers with optional additional notes.

Each item in the questions array must be an object with these fields:
- question (string, required): The complete question text, clear and specific, ending with "?"
- header (string, required): Very short chip/tag label, use abbreviations. e.g. "Auth" not "Authentication", "Library", "Approach"
- type (string, required): "choice" for multiple-choice with options | "text" for free-form input | "yesno" for Yes/No confirmation
- options (array, required when type="choice"): 2-4 selectable choices, each with:
    - label (string): Display text for this option, 1-5 words. e.g. "OAuth 2.0"
    - description (string): Brief explanation. e.g. "Industry standard, supports SSO"
- multi_select (boolean, optional): Only for type="choice". Set true to allow selecting multiple options.
- placeholder (string, optional): Only for type="text". Hint text shown in the input field.`,
  inputSchema: {
    type: 'object',
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
                additionalProperties: false,
              },
            },
            multi_select: {
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
          additionalProperties: false,
        },
      },
    },
    required: ['questions'],
    additionalProperties: false,
  },
} as const satisfies MCPTool['definition'];
