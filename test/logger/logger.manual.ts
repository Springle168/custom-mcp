/**
 * 人工视觉验证 Logger 的终端输出与日志文件。
 *
 * 此脚本不由 npm test 执行：颜色呈现需要人工确认，而 --verbose 模式会输出大量 JSON。
 * 运行：node --import tsx test/logger/logger.manual.ts
 */
import { Logger } from '../../src/utils/logger.js';
import type { ToolCallResultLogContext } from '../../src/runtime/tool-call-log-context.js';
import { isVerboseTestOutput } from '../test-utils.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

function demoLogContext(callId: string): ToolCallResultLogContext {
  return {
    sessionId: 'session_logger_demo',
    callId,
    requestHeaderPolicy: {
      rulesConfigured: false,
      matchedRuleLocations: [],
      enabledFeatures: [],
    },
  };
}

async function assertMissingLogsRootFails(): Promise<void> {
  await mkdir(testLogsDir, { recursive: true });
  const missingLogsRoot = join(testLogsDir, 'missing-root');
  await rm(missingLogsRoot, { recursive: true, force: true });

  try {
    const unexpectedLogger = new Logger(missingLogsRoot, {
      workspaceId: 'missing-root-workspace',
    });
    await unexpectedLogger.close();
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.message.includes('Logger logsDir must be an existing directory')
    ) {
      return;
    }

    throw error;
  }

  throw new Error('Expected Logger construction to fail when logsDir root is missing');
}

async function assertFileLogsRootFails(): Promise<void> {
  await mkdir(testLogsDir, { recursive: true });
  const fileLogsRoot = join(testLogsDir, 'file-root.log');

  try {
    await writeFile(fileLogsRoot, 'not a directory', 'utf-8');

    try {
      const unexpectedLogger = new Logger(fileLogsRoot, {
        workspaceId: 'file-root-workspace',
      });
      await unexpectedLogger.close();
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes('Logger logsDir must be an existing directory')
      ) {
        return;
      }

      throw error;
    }

    throw new Error('Expected Logger construction to fail when logsDir root is a file');
  } finally {
    await rm(fileLogsRoot, { force: true });
  }
}

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

await assertMissingLogsRootFails();
await assertFileLogsRootFails();
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
  const replaceTextContext = demoLogContext('call_replace_text_demo');
  logger.logToolCall('replace_text', {
    files: [{
      file_path: 'src/index.ts',
      replacements: [{
        target: 'const port = 3000;',
        replacement: 'const port = 3100;',
      }],
    }],
  }, replaceTextContext);

  logger.logToolResult(
    'replace_text',
    {
      content: [
        {
          type: 'text',
          text: '{"success":true,"files":[{"success":true,"file_path":"src/index.ts","match_mode":"default","allow_multiple":false,"replacements":[{"success":true,"matched_targets":1,"replacement_count":1,"matched_span":{"start_line":1,"end_line":1},"replacement_line_count":1,"file_line_count":{"previous":10,"current":10}}]}]}',
        },
      ],
      isError: false,
    },
    45,
    replaceTextContext,
  );

  // 测试 3: 失败结果
  const readManyFilesContext = demoLogContext('call_read_many_files_demo');
  logger.logToolCall('read_many_files', {
    include: ['src/**/*.ts', 'config.json'],
    exclude: ['**/*.test.ts'],
  }, readManyFilesContext);

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
    12,
    readManyFilesContext,
  );

  // 测试 4: 嵌套 JSON
  const complexToolContext = demoLogContext('call_complex_tool_demo');
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
  }, complexToolContext);

  logger.logToolResult(
    'complex_tool',
    {
      content: [{ type: 'text', text: 'Operation completed successfully.' }],
      isError: false,
    },
    123,
    complexToolContext,
  );

  // 测试 5: 超大 JSON（测试 50KB 阈值）。Agent 运行时要非常谨慎：
  // 这段会向终端写入大量 JSON 噪音，默认跳过；需要验证大输出降级行为时使用 --verbose。
  if (isVerboseTestOutput()) {
    const largeDataContext = demoLogContext('call_large_data_demo');
    const largeObject: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) {
      largeObject[`key_${i}`] = `value_${i}_${'x'.repeat(50)}`;
    }

    logger.logToolCall('large_data_tool', largeObject, largeDataContext);

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
      567,
      largeDataContext,
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
