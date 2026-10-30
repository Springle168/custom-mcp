import type { MCPTool } from '../../types.js';

export const DISCOVER_GUIDELINES_TOOL_DEFINITION = {
  name: 'discover_guidelines',
  description: `Discovers available guidelines and what they are for without reading their full Markdown contents.

Use literal paths or glob patterns to find .md guideline files. Returns each guideline's name, description, and file path, but not its body. Use a file-reading tool to read the body of a relevant guideline.`,
  inputSchema: {
    type: 'object',
    properties: {
      include: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        description:
          'Markdown file paths or glob patterns to inspect. Relative paths/globs resolve from the primary workspace root; drive-absolute paths/globs may target any configured workspace root.',
      },
      exclude: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        description:
          'Optional glob patterns applied only to automatically discovered glob results. Literal include paths bypass excludes.',
      },
      use_ignore_files: {
        type: 'boolean',
        description:
          'Whether configured ignoreFiles rules filter automatically discovered glob results. Defaults to false. Literal include paths bypass ignore rules; the file access deny policy always applies.',
      },
    },
    required: ['include'],
    additionalProperties: false,
  },
} as const satisfies MCPTool['definition'];
