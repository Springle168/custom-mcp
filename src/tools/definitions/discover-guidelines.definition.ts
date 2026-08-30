import type { MCPTool } from '../types.js';

export const MAX_GUIDELINE_FILES = 100;
export const MAX_GUIDELINE_PREFIX_BYTES = 64 * 1024;
export const MAX_GUIDELINE_READ_WORKERS = 8;

export const DISCOVER_GUIDELINES_TOOL_DEFINITION = {
  name: 'discover_guidelines',
  description: `Discovers guideline metadata from YAML Front Matter without returning Markdown body content.

Include selectors support literal paths and glob patterns. Only .md files are inspected, and configured ignoreFiles rules are disabled by default. Use a file-reading tool when the guideline body is needed.`,
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
