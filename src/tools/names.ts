export const TOOL_NAMES = Object.freeze([
  'replace_text',
  'write_file',
  'read',
  'discover_guidelines',
  'android_assembleDebug',
  'android_testDebugUnitTest',
] as const);

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}
