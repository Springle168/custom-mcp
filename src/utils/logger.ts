import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
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

function ts(): string {
  const now = new Date();

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}${timezoneOffset(now)}`;
}

export class Logger {
  private stream: WriteStream;
  readonly logFile: string;
  constructor(logsDir: string) {
    mkdirSync(logsDir, { recursive: true });
    const name = ts()
      .replace(/T/, '_')
      .replace(/:/g, '-')
      .replace(/\..+/, '');
    this.logFile = join(logsDir, `${name}.log`);
    this.stream = createWriteStream(this.logFile, { flags: 'a' });
  }

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

  logToolCall(toolName: string, args: Record<string, unknown>) {
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
    const consoleText = `\n${separator}\n${chalk.gray(`[${timestamp}]`)} ${chalk.cyan('← CALL')} ${chalk.yellow(toolName)}\n${consoleBody}\n`;
    const fileText = `\n[${timestamp}] ← CALL ${toolName}\n${fileBody}\n`;

    this.write(consoleText, fileText);
  }

  logToolResult(
    toolName: string,
    result: ToolCallResult,
    durationMs?: number,
  ) {
    const timestamp = ts();
    const isError = result.isError === true;
    const status = isError ? 'FAIL' : 'OK';
    const duration = durationMs !== undefined ? ` (${durationMs}ms)` : '';
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
    const consoleText = `${chalk.gray(`[${timestamp}]`)} ${statusColor(`→ ${status}`)} ${chalk.yellow(toolName)}${chalk.gray(duration)}\n${consoleBody}\n`;
    const fileText = `[${timestamp}] → ${status} ${toolName}${duration}\n${fileBody}\n`;

    this.write(consoleText, fileText);
  }

  close(): Promise<void> {
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
