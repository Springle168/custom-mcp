import { Logger } from '../src/utils/logger.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const testLogsDir = join(__dirname, 'logs');
const logger = new Logger(testLogsDir);

console.log('Testing logger with colors...\n');

// 测试 1: 基本 info
logger.info('Server started on port 3100');

// 测试 2: 小 JSON 参数（各种数据类型）
logger.logToolCall('replace_text', {
  file_path: 'src/index.ts',
  target: 'const port = 3000;',
  replacement: 'const port = 3100;',
  allow_multiple: false,
  match_mode: 'default',
  max_count: 10,
  metadata: null,
});

logger.logToolResult(
  'replace_text',
  {
    content: [
      {
        type: 'text',
        text: '{"success":true,"file_path":"src/index.ts","match_mode":"default","allow_multiple":false,"matched_targets":1,"replacement_count":1,"matched_span":{"start_line":1,"end_line":1},"replacement_line_count":1,"file_line_count":{"previous":10,"current":10}}',
      },
    ],
    isError: false,
  },
  45
);

// 测试 3: 失败结果
logger.logToolCall('read_many_files', {
  include: ['src/**/*.ts', 'config.json'],
  exclude: ['**/*.test.ts'],
});

logger.logToolResult(
  'read_many_files',
  {
    content: [
      {
        type: 'text',
        text: 'Error: Path outside workspace: /etc/passwd\nPlease ensure all paths are within the configured rootDir.',
      },
    ],
    isError: true,
  },
  12
);

// 测试 4: 嵌套 JSON
logger.logToolCall('complex_tool', {
  config: {
    nested: {
      deep: {
        value: 'test',
        enabled: true,
        count: 42,
      },
    },
    items: ['item1', 'item2', 'item3'],
  },
  flags: {
    verbose: false,
    dryRun: true,
  },
});

logger.logToolResult(
  'complex_tool',
  {
    content: [{ type: 'text', text: 'Operation completed successfully.' }],
    isError: false,
  },
  123
);

// 测试 5: 超大 JSON（测试 50KB 阈值）
const largeObject: Record<string, string> = {};
for (let i = 0; i < 2000; i++) {
  largeObject[`key_${i}`] = `value_${i}_${'x'.repeat(50)}`;
}

logger.logToolCall('large_data_tool', largeObject);

logger.logToolResult(
  'large_data_tool',
  {
    content: [
      {
        type: 'text',
        text: 'Processed large dataset. Size exceeded threshold, highlighting disabled.',
      },
    ],
    isError: false,
  },
  567
);

logger.info('Test completed. Check terminal colors and log file.');
logger.close();

console.log(`\nLog file: ${logger.logFile}`);
