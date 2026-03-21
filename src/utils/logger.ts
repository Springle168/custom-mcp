import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCallResult } from '../tools/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'logs');

function ts(): string {
  return new Date().toISOString();
}

export class Logger {
  private stream: WriteStream;
  readonly logFile: string;

  constructor() {
    mkdirSync(LOGS_DIR, { recursive: true });
    const name = ts()
      .replace(/T/, '_')
      .replace(/:/g, '-')
      .replace(/\..+/, '');
    this.logFile = join(LOGS_DIR, `${name}.log`);
    this.stream = createWriteStream(this.logFile, { flags: 'a' });
  }

  private write(entry: string) {
    process.stdout.write(entry);
    this.stream.write(entry);
  }

  info(message: string) {
    this.write(`[${ts()}] ${message}\n`);
  }

  logToolCall(toolName: string, args: Record<string, unknown>) {
    const body = JSON.stringify(args, null, 2)
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n');
    this.write(`\n[${ts()}] ← CALL ${toolName}\n${body}\n`);
  }

  logToolResult(
    toolName: string,
    result: ToolCallResult,
    durationMs?: number,
  ) {
    const isError = result.isError === true;
    const status = isError ? 'FAIL' : 'OK';
    const duration = durationMs !== undefined ? ` (${durationMs}ms)` : '';
    const text = result.content
      .map((c) => c.text ?? '')
      .filter(Boolean)
      .join('\n');
    const body = text
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n');
    this.write(`[${ts()}] → ${status} ${toolName}${duration}\n${body}\n`);
  }

  close() {
    this.stream.end();
  }
}
