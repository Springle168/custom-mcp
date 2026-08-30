import type { ToolRuntimeContext } from '../runtime/tool-context.js';
import type { ToolInvocationContext } from '../runtime/tool-invocation-context.js';
import type {
  CompiledBuiltInTool,
  CompiledWorkspaceToolCatalog,
} from './catalog.js';
import { compileInputSchemaValidator } from './input-schema-validator.js';
import { TOOL_NAMES, type ToolName } from './names.js';
import type {
  MCPTool,
  ToolCallResult,
  ToolDefinition,
} from './types.js';

import replaceTool from './replace.js';
import writeFileTool from './write-file.js';
import readManyFilesTool from './read-many-files.js';
import discoverGuidelinesTool from './discover-guidelines.js';
import readFileTool from './read-file.js';
import askUserTool from './ask-user.js';
import androidAssembleDebugTool from './android-assemble-debug.js';
import androidTestDebugUnitTestTool from './android-test-debug-unit-test.js';

const importedTools: readonly MCPTool[] = [
  replaceTool,
  writeFileTool,
  readManyFilesTool,
  discoverGuidelinesTool,
  readFileTool,
  askUserTool,
  androidAssembleDebugTool,
  androidTestDebugUnitTestTool,
];

const registry = buildCanonicalRegistry(importedTools);
const compiledBuiltInRegistry = Object.freeze(
  registry.map((tool): CompiledBuiltInTool => {
    const definition = cloneAndFreezeDefinition(tool.definition);
    return Object.freeze({
      definition,
      implementationValidator: compileInputSchemaValidator(definition.inputSchema),
      executor: tool.handler,
    });
  }),
);
const builtInDefinitions = Object.freeze(
  compiledBuiltInRegistry.map((tool) => tool.definition),
);

export interface WorkspaceToolService {
  getDefinitions(): readonly ToolDefinition[];
  routeToolCall(
    name: string,
    args: unknown,
    context: ToolRuntimeContext,
    invocationContext: ToolInvocationContext,
  ): Promise<ToolCallResult>;
}

export function getAllToolDefinitions(): readonly ToolDefinition[] {
  return builtInDefinitions;
}

export function getCompiledBuiltInTools(): readonly CompiledBuiltInTool[] {
  return compiledBuiltInRegistry;
}

export function createWorkspaceToolService(
  catalog: CompiledWorkspaceToolCatalog,
): WorkspaceToolService {
  return Object.freeze({
    getDefinitions: () => catalog.definitions,
    routeToolCall: catalog.routeToolCall,
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

function cloneAndFreezeDefinition(
  definition: MCPTool['definition'],
): ToolDefinition {
  return deepFreeze({
    name: definition.name,
    description: definition.description,
    inputSchema: cloneJsonObject(definition.inputSchema),
  });
}

function cloneJsonObject(
  value: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, propertyValue]) => [key, cloneJsonValue(propertyValue)]),
  );
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (typeof value === 'object' && value !== null) {
    return cloneJsonObject(value as Readonly<Record<string, unknown>>);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const propertyValue of Object.values(value as Record<string, unknown>)) {
    deepFreeze(propertyValue);
  }
  return Object.freeze(value);
}
