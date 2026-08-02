export const TOOL_NAMES = Object.freeze([
  'replace_text',
  'write_file',
  'read_many_files',
  'read_file',
  'ask_user',
  'android.assembleDebug',
  'android.testDebugUnitTest',
] as const);

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}
