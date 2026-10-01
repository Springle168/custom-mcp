import type { ToolRuntimeContext } from '../../src/runtime/invocation/tool-context.js';
import type { ToolInvocationContext } from '../../src/runtime/invocation/tool-invocation-context.js';
import { compileWorkspaceToolCatalog } from '../../src/tools/catalog.js';
import {
  createWorkspaceToolService,
  getCompiledBuiltInTools,
} from '../../src/tools/index.js';
import type { ToolName } from '../../src/tools/names.js';
import type { ToolCallResult } from '../../src/tools/types.js';

const builtInToolService = createWorkspaceToolService(
  compileWorkspaceToolCatalog({
    builtInTools: getCompiledBuiltInTools(),
    customDefinitions: [],
    exposure: { mode: 'all' },
    workspaceConfigFilePath: 'test-workspace.json',
  }),
);

export function callBuiltInTool(
  name: ToolName,
  args: unknown,
  context: ToolRuntimeContext,
  invocation: ToolInvocationContext,
): Promise<ToolCallResult> {
  return builtInToolService.routeToolCall(name, args, context, invocation);
}
