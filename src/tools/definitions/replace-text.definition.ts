import type { MCPTool } from '../types.js';

export const REPLACE_TOOL_DEFINITION = {
  name: 'replace_text',
  description: `Replaces text within a file and returns a JSON payload.

- When writing code, do NOT use omission placeholders to represent existing code, such as '(rest of methods ...)', '...', or 'unchanged code'. Write the complete replacement content explicitly. Possible placeholders are written but reported as warnings in note.

Mode boundaries:
- In default mode, target MUST be EXACT literal source text, including all whitespace, indentation, and newlines. Never escape or approximate it. replacement must be complete literal text; no replacement syntax is interpreted.
- In regex mode, target is a bare JavaScript RegExp pattern. Matching is global and defaults to regex_flags='ms'; with dotAll enabled, '.' matches newlines, so prefer '[^\\n]+' for line-local captures.
- Regex replacement interprets only $!n capture references and $$ dollar escaping. JavaScript native replacement tokens like $1, $&, $\`, and $' remain literal.
- Empty target is allowed only in default mode when the file does not exist, to create a new file. Prefer write_file for new file creation.

Parallel calls:
- Parallel replace_text calls may target the same file.
- Same-file calls in a single parallel call batch are applied in listed order; each call matches against the file content produced by previous same-file calls in that batch.

Best practices:
- Always use read_file to examine file content before making replacements.
- Prefer multiple small, atomic replacements over one large replacement.
- For multiple same-file edits in one change set, put the replace_text calls in a single parallel call batch ordered by application sequence; place prerequisite replacements before dependent replacements, and write each target against the content at that step.
- If the target file requires extensive refactoring, it is recommended to first perform a full overwrite of the file using \`write_file\` or a similar file-writing tool, and then perform partial replacements based on needs and subsequent plan adjustments.
- Verify file content after changes.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        minLength: 1,
        description: 'Path of the file to modify.',
      },
      target: {
        type: 'string',
        description:
          'Content to locate. In default mode this is EXACT literal text; in regex mode this is a bare JavaScript RegExp pattern. Empty target is allowed only in default mode for creating a missing file.',
      },
      replacement: {
        type: 'string',
        description:
          'The exact literal replacement text. Must be complete content with no placeholders. In regex mode only $!n capture references and $$ dollar escaping are interpreted.',
      },
      allow_multiple: {
        type: 'boolean',
        description:
          "Defaults to 'false'. If 'true', replace all matches. If false or omitted, exactly one match is required for replacement.",
      },
      match_mode: {
        type: 'string',
        enum: ['default', 'regex'],
        description:
          "Matching mode. Defaults to 'default'. 'regex' compiles target as a bare JavaScript RegExp with global matching plus regex_flags.",
      },
      regex_flags: {
        type: 'string',
        description:
          "Optional only when match_mode='regex'. Defaults to 'ms'. May contain each of g, m, and s at most once; g is always enabled internally and does not need to be specified. Use 'm' to keep multiline anchors and omit 's' when '.' must not match newlines.",
      },
    },
    required: ['file_path', 'target', 'replacement'],
    additionalProperties: false,
  },
} as const satisfies MCPTool['definition'];
