import type { MCPTool } from '../../types.js';

export const REPLACE_TOOL_DEFINITION = {
  name: 'replace_text',
  description: `Applies an ordered batch of local text replacements and returns a JSON result. File entries and their replacements run in array order. Each replacement re-reads the file state produced by earlier work. A failure does not roll back successful writes or stop later items.`,
  inputSchema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        minItems: 1,
        description:
          'Ordered file modification entries. At least one is required. Entries run sequentially; a repeated path re-reads the state present when that entry starts.',
        items: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              minLength: 1,
              description: 'Path of the file to modify.',
            },
            allow_multiple: {
              type: 'boolean',
              description:
                'Defaults to false for every replacement in this file entry. When true, each replacement replaces all matches; otherwise exactly one match is required.',
            },
            match_mode: {
              type: 'string',
              enum: ['default', 'regex'],
              description:
                "Matching mode shared by this file entry's replacements. Defaults to default; regex compiles each target as a bare JavaScript RegExp pattern.",
            },
            regex_flags: {
              type: 'string',
              description:
                "Available only when match_mode is regex. Defaults to ms and accepts each of g, m, and s at most once; g is always enabled internally. Use m for multiline anchors and omit s when '.' must not match newlines.",
            },
            replacements: {
              type: 'array',
              minItems: 1,
              description:
                'Ordered replacements for this file entry. At least one is required, and each item re-reads the file after earlier items complete.',
              items: {
                type: 'object',
                properties: {
                  target: {
                    type: 'string',
                    description:
                      'Content to locate. In default mode this is exact literal text, including whitespace and newlines; in regex mode this is a bare JavaScript RegExp pattern. An empty target creates only a missing file in default mode.',
                  },
                  replacement: {
                    type: 'string',
                    description:
                      'Complete replacement text without omission placeholders. In regex mode only $!n capture references and $$ dollar escaping are interpreted; JavaScript native replacement tokens remain literal.',
                  },
                },
                required: ['target', 'replacement'],
                additionalProperties: false,
              },
            },
          },
          required: ['file_path', 'replacements'],
          additionalProperties: false,
        },
      },
    },
    required: ['files'],
    additionalProperties: false,
  },
} as const satisfies MCPTool['definition'];
