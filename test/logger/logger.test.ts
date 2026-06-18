import { Logger } from '../../src/utils/logger.js';
import { isVerboseTestOutput } from '../test-utils.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function logFileStem(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function expectedLogFilePath(logsDir: string, date: Date, workspaceId: string): string {
  return join(
    logsDir,
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    `${workspaceId}_${logFileStem(date)}.log`,
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const testLogsDir = join(__dirname, '..', 'logs');

async function withFixedNow<T>(fixedNow: Date, run: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor();
    constructor(value: string | number);
    constructor(
      year: number,
      monthIndex: number,
      date?: number,
      hours?: number,
      minutes?: number,
      seconds?: number,
      ms?: number,
    );
    constructor(
      ...args:
        | []
        | [string | number]
        | [number, number, number?, number?, number?, number?, number?]
    ) {
      if (args.length === 0) {
        super(fixedNow.getTime());
        return;
      }

      if (args.length === 1) {
        super(args[0]);
        return;
      }

      super(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
    }

    static override now(): number {
      return fixedNow.getTime();
    }
  }

  globalThis.Date = FixedDate as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
}

async function assertLogFileOpenFailureSurfaces(): Promise<void> {
  await mkdir(testLogsDir, { recursive: true });
  const blockedLogsDir = await mkdtemp(join(testLogsDir, 'blocked-open-'));

  try {
    const fixedNow = new Date(2026, 0, 2, 3, 4, 5, 678);
    const blockedLogFile = expectedLogFilePath(blockedLogsDir, fixedNow, 'blocked-workspace');
    await mkdir(blockedLogFile, { recursive: true });

    await withFixedNow(fixedNow, async () => {
      try {
        const unexpectedLogger = new Logger(blockedLogsDir, {
          workspaceId: 'blocked-workspace',
        });
        await unexpectedLogger.close();
        await rm(unexpectedLogger.logFile, { recursive: true, force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          error instanceof Error &&
          error.message.includes('Log file path is not a regular file')
        ) {
          return;
        }

        if (code === 'EISDIR' || code === 'EPERM' || code === 'EACCES') {
          return;
        }

        throw error;
      }

      throw new Error('Expected Logger construction to fail when the target log file cannot be opened');
    });
  } finally {
    await rm(blockedLogsDir, { recursive: true, force: true });
  }
}

await assertLogFileOpenFailureSurfaces();
const fixedNow = new Date(2026, 5, 17, 8, 9, 10, 123);
await withFixedNow(fixedNow, async () => {
  const workspaceId = 'custom-mcp';
  const logger = new Logger(testLogsDir, { workspaceId });
  const expectedLogFile = expectedLogFilePath(testLogsDir, fixedNow, workspaceId);

  if (logger.logFile !== expectedLogFile) {
    throw new Error(
      `Expected logger.logFile to be ${expectedLogFile}, got ${logger.logFile}`,
    );
  }

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

  // 测试 5: 超大 JSON（测试 50KB 阈值）。Agent 运行时要非常谨慎：
  // 这段会向终端写入大量 JSON 噪音，默认跳过；需要验证大输出降级行为时使用 --verbose。
  if (isVerboseTestOutput()) {
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
  } else {
    console.log('\nSkipping large JSON logger demo. Use --verbose to include it.');
  }

  logger.info('Test completed. Check terminal colors and log file.');
  await logger.close();

  if (!existsSync(logger.logFile)) {
    throw new Error(`Expected logger to create a log file at ${logger.logFile}`);
  }

  console.log(`\nLog file: ${logger.logFile}`);
});
