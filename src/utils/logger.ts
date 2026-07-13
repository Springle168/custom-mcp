import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  statSync,
  createWriteStream,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import type {
  ToolCallLogContext,
  ToolCallResultLogContext,
} from '../runtime/tool-call-log-context.js';
import type { RequestHeaderPolicyLogMetadata } from '../runtime/request-header-policy.js';
import type { ToolCallResult } from '../tools/types.js';

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

function timezoneOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;

  return `${sign}${pad(hours)}:${pad(minutes)}`;
}

function ts(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${timezoneOffset(date)}`;
}

function logFileTimestampStem(date: Date): string {
  return ts(date)
    .replace(/T/, '_')
    .replace(/:/g, '-')
    .replace(/\..+/, '');
}

export interface LoggerOptions {
  readonly workspaceId: string;
}

function assertExistingLogsRoot(logsDir: string): void {
  try {
    if (statSync(logsDir).isDirectory()) {
      return;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Logger logsDir must be an existing directory: ${logsDir}. ${message}`);
  }

  throw new Error(`Logger logsDir must be an existing directory: ${logsDir}.`);
}

export class Logger {
  private stream: WriteStream;
  private streamError: Error | undefined;
  readonly logFile: string;

  constructor(logsDir: string, options: LoggerOptions) {
    assertExistingLogsRoot(logsDir);

    const createdAt = new Date();
    const yearDir = String(createdAt.getFullYear());
    const monthDir = pad(createdAt.getMonth() + 1);
    const dayDir = pad(createdAt.getDate());
    const dateDir = join(logsDir, yearDir, monthDir, dayDir);

    mkdirSync(dateDir, { recursive: true });
    this.logFile = join(dateDir, `${options.workspaceId}_${logFileTimestampStem(createdAt)}.log`);
    // Open synchronously so user-configured logsDir failures stay in startup.
    const fd = openSync(this.logFile, 'a');
    try {
      // Windows can open a directory handle here; logging needs a regular file.
      if (!fstatSync(fd).isFile()) {
        throw new Error(`Log file path is not a regular file: ${this.logFile}`);
      }

      this.stream = createWriteStream(this.logFile, { flags: 'a', fd });
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    this.stream.on('error', this.handleRuntimeStreamError);
  }

  private handleRuntimeStreamError = (error: Error) => {
    this.streamError = error;
    process.stderr.write(`Logger stream error (${this.logFile}): ${error.message}\n`);
  };

  private write(consoleText: string, fileText: string) {
    process.stdout.write(consoleText);
    this.stream.write(fileText);
  }

  private colorizeJson(json: string): string {
    const MAX_SIZE = 50 * 1024; // 50KB
    if (json.length > MAX_SIZE) {
      return chalk.dim(json);
    }

    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        if (match.startsWith('"')) {
          if (match.endsWith(':')) {
            // Key
            return chalk.cyan(match);
          } else {
            // String value
            return chalk.green(match);
          }
        } else if (match === 'true' || match === 'false') {
          return chalk.magenta(match);
        } else if (match === 'null') {
          return chalk.dim(match);
        } else {
          // Number
          return chalk.yellow(match);
        }
      }
    );
  }

  info(message: string) {
    const timestamp = ts();
    const consoleText = `${chalk.gray(`[${timestamp}]`)} ${message}\n`;
    const fileText = `[${timestamp}] ${message}\n`;
    this.write(consoleText, fileText);
  }

  logToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallLogContext,
  ) {
    const timestamp = ts();
    const plainJson = JSON.stringify(args, null, 2);
    const fileBody = plainJson
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n');

    const coloredJson = this.colorizeJson(plainJson);
    const consoleBody = coloredJson
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n');

    const separator = chalk.gray('─'.repeat(60));
    const consoleContext = this.formatToolCallConsoleContext(context);
    const fileContext = this.formatToolCallFileContext(context);
    const consoleText = `\n${separator}\n${chalk.gray(`[${timestamp}]`)} ${chalk.cyan('← CALL')} ${chalk.yellow(toolName)}\n${consoleContext}${consoleBody}\n`;
    const fileText = `\n[${timestamp}] ← CALL ${toolName}\n${fileContext}${fileBody}\n`;

    this.write(consoleText, fileText);
  }

  logToolResult(
    toolName: string,
    result: ToolCallResult,
    durationMs: number | undefined,
    context: ToolCallResultLogContext,
  ) {
    const timestamp = ts();
    const isError = result.isError === true;
    const status = isError ? 'FAIL' : 'OK';
    const duration = durationMs !== undefined ? ` (${durationMs}ms)` : '';
    const rulesFileLine = this.formatRulesFileLine(context.requestHeaderPolicy);
    const rulesConsoleLine = this.formatRulesConsoleLine(context.requestHeaderPolicy);
    const text = result.content
      .map((c) => c.text ?? '')
      .filter(Boolean)
      .join('\n');

    const fileBody = text
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n');

    const consoleBody = chalk.dim(
      text
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n')
    );

    const statusColor = isError ? chalk.red : chalk.green;
    const consoleContext = this.formatToolCallConsoleContext(context);
    const fileContext = this.formatToolCallFileContext(context);
    const consoleRules = rulesConsoleLine === undefined ? '' : `  ${rulesConsoleLine}\n`;
    const fileRules = rulesFileLine === undefined ? '' : `  ${rulesFileLine}\n`;
    const consoleText = `${chalk.gray(`[${timestamp}]`)} ${statusColor(`→ ${status}`)} ${chalk.yellow(toolName)}${chalk.gray(duration)}\n${consoleContext}${consoleRules}${consoleBody}\n`;
    const fileText = `[${timestamp}] → ${status} ${toolName}${duration}\n${fileContext}${fileRules}${fileBody}\n`;

    this.write(consoleText, fileText);
  }

  private formatToolCallFileContext(
    context: ToolCallLogContext,
  ): string {
    const sessionId = context.sessionId ?? 'unavailable (session ID missing)';
    return `  Session: ${sessionId}\n  Call ID: ${context.callId}\n`;
  }

  private formatToolCallConsoleContext(
    context: ToolCallLogContext,
  ): string {
    const sessionId = context.sessionId ?? 'unavailable (session ID missing)';
    return `  ${chalk.cyan('Session:')} ${chalk.magenta(sessionId)}\n  ${chalk.cyan('Call ID:')} ${chalk.magenta(context.callId)}\n`;
  }

  private formatRulesFileLine(
    metadata: RequestHeaderPolicyLogMetadata | undefined,
  ): string | undefined {
    if (metadata?.rulesConfigured !== true) {
      return undefined;
    }

    if (metadata.matchedRuleLocations.length === 0) {
      return 'Rules: no match';
    }

    return `Rules: matched ${metadata.matchedRuleLocations.join(', ')}; enabled ${metadata.enabledFeatures.join(', ')}`;
  }

  private formatRulesConsoleLine(
    metadata: RequestHeaderPolicyLogMetadata | undefined,
  ): string | undefined {
    if (metadata?.rulesConfigured !== true) {
      return undefined;
    }

    if (metadata.matchedRuleLocations.length === 0) {
      return `${chalk.cyan('Rules:')} ${chalk.dim('no match')}`;
    }

    const matchedLocations = metadata.matchedRuleLocations.join(chalk.dim(', '));
    const enabledFeatures = metadata.enabledFeatures
      .map((feature) => chalk.magenta(feature))
      .join(chalk.dim(', '));

    return `${chalk.cyan('Rules:')} ${chalk.green('matched')} ${matchedLocations}; ${chalk.cyan('enabled')} ${enabledFeatures}`;
  }

  close(): Promise<void> {
    if (this.streamError) {
      return Promise.reject(this.streamError);
    }

    if (this.stream.closed || this.stream.destroyed) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.stream.off('error', onError);
        this.stream.off('finish', onFinish);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onFinish = () => {
        cleanup();
        resolve();
      };

      this.stream.once('error', onError);
      this.stream.once('finish', onFinish);
      this.stream.end();
    });
  }
}
