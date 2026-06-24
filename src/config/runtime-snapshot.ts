import { resolve } from 'node:path';
import { ConfigError } from './errors.js';
import { normalizeLogsDirPath } from './path-validation.js';
import type { ParsedAndroidConfig, ParsedWorkspaceConfig } from './schema.js';
import {
  createValidatedPathSafetyContext,
  type PathSafetyContext,
} from '../utils/paths.js';

export type LineEnding = 'auto' | 'lf' | 'crlf';

export interface RuntimeAndroidConfig {
  readonly workspaceRoot: string;
  readonly javaHome: string;
  readonly buildTimeoutMs: number;
  readonly maxErrorBlockChars: number;
  readonly maxLogTailChars: number;
}

export interface RuntimeConfigSnapshot {
  readonly snapshotVersion: number;
  readonly configFilePath: string;
  readonly workspaceId: string;
  readonly rootDir: string;
  readonly otherRootDirs: readonly string[];
  readonly port: number;
  readonly lineEnding: LineEnding;
  readonly logsDir: string;
  readonly android?: RuntimeAndroidConfig;
  readonly pathSafetyContext: PathSafetyContext;
}

export interface RuntimeConfigSnapshotInput {
  readonly snapshotVersion?: number;
  readonly configFilePath: string;
  readonly workspaceId: string;
  readonly rootDir: string;
  readonly otherRootDirs?: readonly string[];
  readonly port: number;
  readonly lineEnding: LineEnding;
  readonly logsDir: string;
  readonly android?: RuntimeAndroidConfig;
}

export interface RuntimeConfigSnapshotErrorContext {
  readonly workspaceIndex?: number;
}

export interface BuildRuntimeConfigSnapshotOptions {
  readonly configFilePath: string;
  readonly workspace: ParsedWorkspaceConfig;
  readonly workspaceIndex: number;
  readonly defaultLogsDir: string;
  readonly snapshotVersion?: number;
}

export function buildRuntimeConfigSnapshot(
  options: BuildRuntimeConfigSnapshotOptions,
): RuntimeConfigSnapshot {
  const { workspace } = options;

  return createRuntimeConfigSnapshot(
    {
      configFilePath: options.configFilePath,
      workspaceId: workspace.id,
      rootDir: workspace.rootDir,
      otherRootDirs: workspace.otherRootDirs,
      port: workspace.port,
      lineEnding: workspace.lineEnding,
      logsDir: workspace.logsDir ?? options.defaultLogsDir,
      ...normalizeRuntimeAndroidConfig(workspace.android),
      snapshotVersion: options.snapshotVersion ?? 1,
    },
    { workspaceIndex: options.workspaceIndex },
  );
}

export function createRuntimeConfigSnapshot(
  input: RuntimeConfigSnapshotInput,
  errorContext: RuntimeConfigSnapshotErrorContext = {},
): RuntimeConfigSnapshot {
  const configuredOtherRootDirs = [...(input.otherRootDirs ?? [])];
  const pathSafetyContext = createPathSafetyContextOrThrowConfigError(
    input,
    configuredOtherRootDirs,
    errorContext,
  );
  const otherRootDirs = pathSafetyContext.allowedRoots
    .filter((root) => root.kind === 'additional')
    .map((root) => root.rootDir);
  const logsDir = normalizeLogsDirForSnapshot(input, errorContext);

  const snapshot: RuntimeConfigSnapshot = {
    snapshotVersion: input.snapshotVersion ?? 1,
    configFilePath: input.configFilePath,
    workspaceId: input.workspaceId,
    rootDir: pathSafetyContext.primaryRoot.rootDir,
    otherRootDirs,
    port: input.port,
    lineEnding: input.lineEnding,
    logsDir,
    ...(input.android ? { android: { ...input.android } } : {}),
    pathSafetyContext,
  };

  return deepFreeze(snapshot);
}

function normalizeLogsDirForSnapshot(
  input: RuntimeConfigSnapshotInput,
  errorContext: RuntimeConfigSnapshotErrorContext,
): string {
  const fieldPath = logsDirFieldPath(errorContext.workspaceIndex);

  try {
    return normalizeLogsDirPath(input.logsDir, fieldPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: input.configFilePath,
      fieldPath,
      message,
      suggestion:
        `Fix ${fieldPath} in ${input.configFilePath}. ` +
        'logsDir must be a local absolute path and is created by the logger at startup if missing.',
      cause: err,
    });
  }
}

function logsDirFieldPath(workspaceIndex: number | undefined): string {
  return workspaceIndex === undefined ? 'logsDir' : `workspaces[${workspaceIndex}].logsDir`;
}

function normalizeRuntimeAndroidConfig(
  android: ParsedAndroidConfig | undefined,
): { readonly android?: RuntimeAndroidConfig } {
  if (android === undefined) {
    return {};
  }

  return {
    android: {
      ...android,
      workspaceRoot: resolve(android.workspaceRoot),
      javaHome: resolve(android.javaHome),
    },
  };
}

function createPathSafetyContextOrThrowConfigError(
  input: RuntimeConfigSnapshotInput,
  otherRootDirs: string[],
  errorContext: RuntimeConfigSnapshotErrorContext,
): PathSafetyContext {
  try {
    return createValidatedPathSafetyContext(input.rootDir, otherRootDirs);
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: input.configFilePath,
      fieldPath: inferAllowedRootFieldPath(message, errorContext.workspaceIndex),
      message: `Selected workspace allowed roots are invalid. ${message}`,
      suggestion:
        `Fix the selected workspace rootDir/otherRootDirs in ${input.configFilePath}. ` +
        'Allowed roots must be existing absolute local directories and must not duplicate or contain one another.',
      cause: err,
    });
  }
}

function inferAllowedRootFieldPath(
  message: string,
  workspaceIndex: number | undefined,
): string {
  const prefix = workspaceIndex === undefined ? '' : `workspaces[${workspaceIndex}].`;
  const otherRootMatches = [...message.matchAll(/otherRootDirs\[\d+\]/g)].map((match) => match[0]);

  if (otherRootMatches.length > 0) {
    const selectedMatch = message.includes(' both resolve to ')
      ? otherRootMatches.at(-1)
      : otherRootMatches[0];
    return `${prefix}${selectedMatch}`;
  }

  if (message.includes('rootDir')) {
    return `${prefix}rootDir`;
  }

  return workspaceIndex === undefined ? 'rootDir' : `workspaces[${workspaceIndex}]`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const propertyValue of Object.values(value as Record<string, unknown>)) {
    deepFreeze(propertyValue);
  }

  return Object.freeze(value);
}
