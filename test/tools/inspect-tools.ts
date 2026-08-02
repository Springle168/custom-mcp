import { getAllToolDefinitions } from '../../src/tools/index.js';

const tools = getAllToolDefinitions();

console.log(`\n已注册工具数量: ${tools.length}`);
console.log('='.repeat(24));

// 输出完整 canonical registry；selected workspace 的实际 tools/list 还会应用 exposure 过滤。
console.log('\n\n=== 完整 canonical 工具 registry ===\n');
console.log(JSON.stringify({ tools }, null, 2));
