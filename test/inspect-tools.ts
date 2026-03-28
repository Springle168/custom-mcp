import { getAllToolDefinitions } from '../src/tools/index.js';

const tools = getAllToolDefinitions();

console.log(`\n已注册工具数量: ${tools.length}`);
console.log('='.repeat(60));

for (const tool of tools) {
  console.log(`\n工具名: ${tool.name}`);
  console.log(`描述: ${tool.description}`);
  console.log(`\ninputSchema:`);
  console.log(JSON.stringify(tool.inputSchema, null, 2));
  console.log('-'.repeat(60));
}

// 同时输出完整的 tools/list 响应结构，和 MCP 协议一致
console.log('\n\n=== 完整 MCP tools/list 响应格式 ===\n');
console.log(JSON.stringify({ tools }, null, 2));