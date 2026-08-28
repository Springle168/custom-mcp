import { access } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { promisify } from 'node:util';
import {
  parseAndroidGradleOutput,
  type ParsedAndroidGradleOutput,
} from '../engine/android-gradle-output.js';

export type AndroidGradleTask = 'assembleDebug' | 'testDebugUnitTest';

export interface AndroidGradleRuntimeConfig {
  workspaceRoot: string;
  javaHome: string;
  buildTimeoutMs: number;
  maxErrorBlockChars: number;
  maxLogTailChars: number;
}

export interface RunAndroidGradleOptions {
  quiet?: boolean;
  stacktrace?: boolean;
  offline?: boolean;
  includeLogTail?: boolean;
}

export interface RunAndroidGradleResult extends ParsedAndroidGradleOutput {
  task: AndroidGradleTask;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

const execFileAsync = promisify(execFile);
const TERMINATION_GRACE_PERIOD_MS = 5000;
const GRADLE_WRAPPER_COMMAND = '.\\gradlew.bat';

export async function runAndroidGradle(
  task: AndroidGradleTask,
  runtimeConfig: AndroidGradleRuntimeConfig,
  options: RunAndroidGradleOptions = {},
): Promise<RunAndroidGradleResult> {
  const args = buildGradleArgs(task, options);
  const gradlewPath = join(runtimeConfig.workspaceRoot, 'gradlew.bat');
  const command = formatDisplayCommand(args);
  const commandLine = buildWindowsCommandLine(args);
  const startedAt = Date.now();

  if (process.platform !== 'win32') {
    return buildResult(
      {
        task,
        command,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        stdout: '',
        stderr:
          'error: This MCP server currently supports Windows only because it runs gradlew.bat.',
        combinedOutput:
          'error: This MCP server currently supports Windows only because it runs gradlew.bat.',
      },
      runtimeConfig,
      options.includeLogTail === true,
    );
  }

  try {
    await access(gradlewPath);
  } catch {
    const message = `error: Gradle wrapper not found: ${gradlewPath}`;

    return buildResult(
      {
        task,
        command,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        stdout: '',
        stderr: message,
        combinedOutput: message,
      },
      runtimeConfig,
      options.includeLogTail === true,
    );
  }

  return await new Promise<RunAndroidGradleResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let combinedOutput = '';
    let timedOut = false;
    let settled = false;
    let forceFinishHandle: NodeJS.Timeout | undefined;

    const child = spawn('cmd.exe', ['/d', '/s', '/c', commandLine], {
      cwd: runtimeConfig.workspaceRoot,
      env: createChildEnv(runtimeConfig.javaHome),
      windowsHide: true,
    });

    const appendStdout = (chunk: string): void => {
      stdout += chunk;
      combinedOutput += chunk;
    };

    const appendStderr = (chunk: string): void => {
      stderr += chunk;
      combinedOutput += chunk;
    };

    const appendSyntheticError = (message: string): void => {
      stderr = appendLine(stderr, message);
      combinedOutput = appendLine(combinedOutput, message);
    };

    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(forceFinishHandle);

      resolve(
        buildResult(
          {
            task,
            command,
            exitCode,
            durationMs: Date.now() - startedAt,
            timedOut,
            stdout,
            stderr,
            combinedOutput,
          },
          runtimeConfig,
          options.includeLogTail === true,
        ),
      );
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      appendStdout(chunk);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      appendStderr(chunk);
    });

    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;
      appendSyntheticError(
        `error: Gradle process timed out after ${runtimeConfig.buildTimeoutMs}ms.`,
      );

      void terminateProcessTree(child);

      forceFinishHandle = setTimeout(() => {
        if (settled) {
          return;
        }

        appendSyntheticError(
          'error: Timed-out Gradle process did not exit after termination request.',
        );
        finish(null);
      }, TERMINATION_GRACE_PERIOD_MS);

      forceFinishHandle.unref?.();
    }, runtimeConfig.buildTimeoutMs);

    timeoutHandle.unref?.();

    child.on('error', (error: Error) => {
      appendSyntheticError(`error: Failed to start Gradle: ${error.message}`);
      finish(null);
    });

    child.on('close', (exitCode: number | null) => {
      finish(exitCode);
    });
  });
}

function buildGradleArgs(
  task: AndroidGradleTask,
  options: RunAndroidGradleOptions,
): string[] {
  const args: string[] = [task];

  if (options.quiet !== false) {
    args.push('-q');
  }

  if (options.stacktrace === true) {
    args.push('--stacktrace');
  }

  if (options.offline === true) {
    args.push('--offline');
  }

  args.push('--no-daemon', '--console=plain');

  return args;
}

function formatDisplayCommand(args: string[]): string {
  return [GRADLE_WRAPPER_COMMAND, ...args].join(' ');
}

function buildWindowsCommandLine(args: string[]): string {
  return [quoteWindowsArgument(GRADLE_WRAPPER_COMMAND), ...args.map(quoteWindowsArgument)].join(
    ' ',
  );
}

function quoteWindowsArgument(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '""')}"`;
}

function createChildEnv(javaHome: string): NodeJS.ProcessEnv {
  const javaBinPath = join(javaHome, 'bin');
  const currentPath = process.env.Path ?? process.env.PATH ?? '';
  const nextPath = currentPath
    ? `${javaBinPath}${delimiter}${currentPath}`
    : javaBinPath;

  return {
    ...process.env,
    ANDROID_JAVA_HOME: javaHome,
    JAVA_HOME: javaHome,
    Path: nextPath,
    PATH: nextPath,
  };
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  try {
    if (child.pid === undefined) {
      child.kill();
      return;
    }

    if (process.platform !== 'win32') {
      child.kill('SIGKILL');
      return;
    }

    await execFileAsync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
    });
  } catch {
    try {
      child.kill();
    } catch {
    }
  }
}

function buildResult(
  input: {
    task: AndroidGradleTask;
    command: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    combinedOutput: string;
  },
  runtimeConfig: AndroidGradleRuntimeConfig,
  includeLogTail: boolean,
): RunAndroidGradleResult {
  const parsed = parseAndroidGradleOutput({
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    combinedOutput: input.combinedOutput,
    maxErrorBlockChars: runtimeConfig.maxErrorBlockChars,
    maxLogTailChars: runtimeConfig.maxLogTailChars,
    includeLogTail,
  });

  return {
    task: input.task,
    command: input.command,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    timedOut: input.timedOut,
    ...parsed,
  };
}

function appendLine(current: string, next: string): string {
  return current ? `${current}\n${next}` : next;
}
