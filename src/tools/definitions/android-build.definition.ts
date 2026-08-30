import type { MCPTool } from '../types.js';

const ANDROID_GRADLE_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    quiet: {
      type: 'boolean',
      description: 'Reduces Gradle output when true. Defaults to true.',
    },
    stacktrace: {
      type: 'boolean',
      description: 'Includes a Gradle stack trace on failure when true. Defaults to false.',
    },
    offline: {
      type: 'boolean',
      description:
        "Uses Gradle's offline dependency resolution when true; required dependencies must already be cached. Defaults to false.",
    },
    include_log_tail: {
      type: 'boolean',
      description:
        'Includes a bounded tail of the normalized raw Gradle output on failure. Defaults to false.',
    },
  },
  additionalProperties: false,
} as const;

export const ANDROID_ASSEMBLE_DEBUG_TOOL_DEFINITION = {
  name: 'android_assembleDebug',
  description:
    'Builds the Android project debug variant with quiet Gradle output by default. Success returns BUILD SUCCESSFUL. Failure returns compact JSON with the failed task and a cleaned first error block. Set include_log_tail=true only when the default diagnosis is insufficient.',
  inputSchema: ANDROID_GRADLE_TOOL_INPUT_SCHEMA,
} as const satisfies MCPTool['definition'];

export const ANDROID_TEST_DEBUG_UNIT_TEST_TOOL_DEFINITION = {
  name: 'android_testDebugUnitTest',
  description:
    'Runs the Android project debug unit tests with quiet Gradle output by default. Success returns BUILD SUCCESSFUL. Failure returns compact JSON with the failed task and a cleaned first error block. Set include_log_tail=true only when the default diagnosis is insufficient.',
  inputSchema: ANDROID_GRADLE_TOOL_INPUT_SCHEMA,
} as const satisfies MCPTool['definition'];
