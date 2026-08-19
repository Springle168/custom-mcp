import type { RuntimeToolExposure } from '../config.js';
import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import { TOOL_NAMES, type ToolName } from './names.js';
import { textErrorResult } from './results.js';
import type { MCPTool, ToolCallResult } from './types.js';

import replaceTool from './replace.js';
import writeFileTool from './write-file.js';
import readManyFilesTool from './read-many-files.js';
import readFileTool from './read-file.js';
import askUserTool from './ask-user.js';
import androidAssembleDebugTool from './android-assemble-debug.js';
import androidTestDebugUnitTestTool from './android-test-debug-unit-test.js';

const importedTools: readonly MCPTool[] = [
  replaceTool,
  writeFileTool,
  readManyFilesTool,
  readFileTool,
  askUserTool,
  androidAssembleDebugTool,
  androidTestDebugUnitTestTool,
];

const registry = buildCanonicalRegistry(importedTools);

export interface WorkspaceToolService {
  getDefinitions(): readonly MCPTool['definition'][];
  routeToolCall(
    name: string,
    args: Record<string, unknown>,
    context: ToolRuntimeContext,
  ): Promise<ToolCallResult>;
}

export function getAllToolDefinitions(): readonly MCPTool['definition'][] {
  return registry.map((tool) => tool.definition);
}

export function createWorkspaceToolService(
  exposure: RuntimeToolExposure,
): WorkspaceToolService {
  const configuredNames = new Set<ToolName>(exposure.mode === 'all' ? [] : exposure.names);
  const filteredRegistry = registry.filter((tool) => {
    if (exposure.mode === 'all') {
      return true;
    }

    const configured = configuredNames.has(tool.definition.name);
    return exposure.mode === 'enable' ? configured : !configured;
  });
  const definitions = Object.freeze(filteredRegistry.map((tool) => tool.definition));
  const routeMap = new Map<string, MCPTool['handler']>(
    filteredRegistry.map((tool) => [tool.definition.name, tool.handler]),
  );

  return Object.freeze({
    getDefinitions: () => definitions,
    routeToolCall: async (
      name: string,
      args: Record<string, unknown>,
      context: ToolRuntimeContext,
    ): Promise<ToolCallResult> => {
      const handler = routeMap.get(name);
      if (!handler) {
        return textErrorResult(`Unknown tool: ${name}`);
      }

      return handler(args, context);
    },
  });
}

function buildCanonicalRegistry(tools: readonly MCPTool[]): readonly MCPTool[] {
  const toolsByName = new Map<ToolName, MCPTool>();

  for (const tool of tools) {
    const name = tool.definition.name;
    if (toolsByName.has(name)) {
      throw new Error(`Duplicate tool implementation registered for "${name}".`);
    }
    toolsByName.set(name, tool);
  }

  const canonicalRegistry = TOOL_NAMES.map((name) => {
    const tool = toolsByName.get(name);
    if (!tool) {
      throw new Error(`Missing tool implementation for "${name}".`);
    }
    return tool;
  });

  if (toolsByName.size !== TOOL_NAMES.length) {
    throw new Error(
      `Tool registry size ${toolsByName.size} does not match canonical tool name count ${TOOL_NAMES.length}.`,
    );
  }

  return Object.freeze(canonicalRegistry);
}
