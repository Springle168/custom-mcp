import type { Config } from '../config.js';
import type { MCPTool, ToolCallResult } from './types.js';

// =============================
// 在这里导入所有工具
// 加新工具时只需要在这里加一行 import + 加到 registry 数组里
// =============================
import replaceTool from './replace.js';
import readManyFilesTool from './read-many-files.js';
import askUserTool from './ask-user.js';

const registry: MCPTool[] = [
  replaceTool,
  readManyFilesTool,
  askUserTool,
  // 未来: import xxxTool from './xxx.js'; 然后加在这里
];

// 构建路由表（name → handler）
const routeMap = new Map<string, MCPTool['handler']>(
  registry.map((t) => [t.definition.name, t.handler]),
);

/**
 * 返回所有工具定义，供 tools/list 使用
 */
export function getAllToolDefinitions() {
  return registry.map((t) => t.definition);
}

/**
 * 路由工具调用，供 tools/call 使用
 */
export async function routeToolCall(
  name: string,
  args: Record<string, unknown>,
  config: Config,
): Promise<ToolCallResult> {
  const handler = routeMap.get(name);

  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  return handler(args, config);
}
