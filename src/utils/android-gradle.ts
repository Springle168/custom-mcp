import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, delimiter } from 'node:path';
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
}

export interface RunAndroidGradleResult extends ParsedAndroidGradleOutput {
  task: AndroidGradleTask;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export async function runAndroidGradle(
  task: AndroidGradleTask,
  runtimeConfig: AndroidGradleRuntimeConfig,
  options: RunAndroidGradleOptions = {},
): Promise<RunAndroidGradleResult> {
  const args = buildGradleArgs(task, options);
  const gradlewPath = join(runtimeConfig.workspaceRoot, 'gradlew.bat');
  const command = formatDisplayCommand(args);
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
      },
      runtimeConfig,
    );
  }

  try {
    await access(gradlewPath);
  } catch {
    return buildResult(
      {
        task,
        command,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        stdout: '',
        stderr: `error: Gradle wrapper not found: ${gradlewPath}`,
      },
      runtimeConfig,
    );
  }

  return await new Promise<RunAndroidGradleResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(gradlewPath, args, {
      cwd: runtimeConfig.workspaceRoot,
      env: createChildEnv(runtimeConfig.javaHome),
      shell: true,
      windowsHide: true,
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      stderr = appendLine(
        stderr,
        `error: Gradle process timed out after ${runtimeConfig.buildTimeoutMs}ms.`,
      );
      child.kill();
    }, runtimeConfig.buildTimeoutMs);

    timeoutHandle.unref?.();

    const finish = (exitCode: number | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);

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
          },
          runtimeConfig,
        ),
      );
    };

    child.on('error', (error: Error) => {
      stderr = appendLine(
        stderr,
        `error: Failed to start Gradle: ${error.message}`,
      );
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

  if (options.quiet === true) {
    args.push('-q');
  }

  if (options.stacktrace === true) {
    args.push('--stacktrace');
  }

  args.push('--no-daemon');

  return args;
}

function formatDisplayCommand(args: string[]): string {
  return ['.\\gradlew.bat', ...args].join(' ');
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

function buildResult(
  input: {
    task: AndroidGradleTask;
    command: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  },
  runtimeConfig: AndroidGradleRuntimeConfig,
): RunAndroidGradleResult {
  const parsed = parseAndroidGradleOutput({
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    maxErrorBlockChars: runtimeConfig.maxErrorBlockChars,
    maxLogTailChars: runtimeConfig.maxLogTailChars,
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
