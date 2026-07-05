import { resolve } from 'node:path';
import { ConfigError } from './errors.js';
import { readExistingDirectoryPath } from './path-policy.js';
import type { RuntimeRulesConfig } from './request-header-rules.js';
import type { ParsedAndroidConfig, ParsedWorkspaceConfig } from './schema.js';
import { readTypedString } from './value-policy.js';
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
  readonly rules: RuntimeRulesConfig;
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
  readonly rules: RuntimeRulesConfig;
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
  const logsDir = readRuntimeLogsDir(options);

  return createRuntimeConfigSnapshot(
    {
      configFilePath: options.configFilePath,
      workspaceId: workspace.id,
      rootDir: workspace.rootDir,
      otherRootDirs: workspace.otherRootDirs,
      port: workspace.port,
      lineEnding: workspace.lineEnding,
      logsDir,
      ...(workspace.android ? { android: workspace.android } : {}),
      rules: workspace.rules,
      snapshotVersion: options.snapshotVersion ?? 1,
    },
    { workspaceIndex: options.workspaceIndex },
  );
}

export function createRuntimeConfigSnapshot(
  input: RuntimeConfigSnapshotInput,
  errorContext: RuntimeConfigSnapshotErrorContext = {},
): RuntimeConfigSnapshot {
  assertRuntimeConfigSnapshotInputPreconditions(input, errorContext);

  const configuredOtherRootDirs = [...(input.otherRootDirs ?? [])];
  const pathSafetyContext = createPathSafetyContextOrThrowConfigError(
    input,
    configuredOtherRootDirs,
    errorContext,
  );
  const otherRootDirs = pathSafetyContext.allowedRoots
    .filter((root) => root.kind === 'additional')
    .map((root) => root.rootDir);
  const logsDir = resolve(input.logsDir);
  const android = resolveRuntimeAndroidConfig(input.android);
  const rules = cloneRuntimeRulesConfig(input.rules);

  const snapshot: RuntimeConfigSnapshot = {
    snapshotVersion: input.snapshotVersion ?? 1,
    configFilePath: input.configFilePath,
    workspaceId: input.workspaceId,
    rootDir: pathSafetyContext.primaryRoot.rootDir,
    otherRootDirs,
    port: input.port,
    lineEnding: input.lineEnding,
    logsDir,
    ...(android ? { android } : {}),
    rules,
    pathSafetyContext,
  };

  return deepFreeze(snapshot);
}

function readRuntimeLogsDir(options: BuildRuntimeConfigSnapshotOptions): string {
  if (options.workspace.logsDir !== undefined) {
    return options.workspace.logsDir;
  }

  const fieldPath = logsDirFieldPath(options.workspaceIndex);
  const result = readExistingDirectoryPath(options.defaultLogsDir, { fieldPath });
  if (result.ok) {
    return result.value;
  }

  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: options.configFilePath,
    fieldPath: result.error.fieldPath,
    message: result.error.message,
    suggestion:
      `Create the default logs root at ${resolve(options.defaultLogsDir)}, ` +
      `or configure ${fieldPath} / allowlisted MCP_LOGS_DIR to an existing local absolute directory.`,
  });
}

function assertRuntimeConfigSnapshotInputPreconditions(
  input: RuntimeConfigSnapshotInput,
  errorContext: RuntimeConfigSnapshotErrorContext,
): void {
  assertSnapshotPathValue(input, input.rootDir, rootDirFieldPath(errorContext.workspaceIndex));

  input.otherRootDirs?.forEach((otherRootDir, index) => {
    assertSnapshotPathValue(
      input,
      otherRootDir,
      otherRootDirFieldPath(errorContext.workspaceIndex, index),
    );
  });

  assertSnapshotPathValue(input, input.logsDir, logsDirFieldPath(errorContext.workspaceIndex));

  if (input.android === undefined) {
    return;
  }

  assertSnapshotPathValue(
    input,
    input.android.workspaceRoot,
    androidFieldPath(errorContext.workspaceIndex, 'workspaceRoot'),
  );
  assertSnapshotPathValue(
    input,
    input.android.javaHome,
    androidFieldPath(errorContext.workspaceIndex, 'javaHome'),
  );
}

function assertSnapshotPathValue(
  input: RuntimeConfigSnapshotInput,
  value: string,
  fieldPath: string,
): void {
  const result = readTypedString(value, { fieldPath });
  if (result.ok) {
    return;
  }

  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: input.configFilePath,
    fieldPath: result.error.fieldPath,
    message: result.error.message,
    suggestion:
      `Fix ${result.error.fieldPath} before building the runtime snapshot. ` +
      'Snapshot path-like inputs must already be validated values without leading or trailing whitespace.',
  });
}

function rootDirFieldPath(workspaceIndex: number | undefined): string {
  return workspaceIndex === undefined ? 'rootDir' : `workspaces[${workspaceIndex}].rootDir`;
}

function otherRootDirFieldPath(workspaceIndex: number | undefined, index: number): string {
  const fieldPath = `otherRootDirs[${index}]`;
  return workspaceIndex === undefined ? fieldPath : `workspaces[${workspaceIndex}].${fieldPath}`;
}

function logsDirFieldPath(workspaceIndex: number | undefined): string {
  return workspaceIndex === undefined ? 'logsDir' : `workspaces[${workspaceIndex}].logsDir`;
}

function androidFieldPath(
  workspaceIndex: number | undefined,
  field: 'workspaceRoot' | 'javaHome',
): string {
  const fieldPath = `android.${field}`;
  return workspaceIndex === undefined ? fieldPath : `workspaces[${workspaceIndex}].${fieldPath}`;
}

function resolveRuntimeAndroidConfig(
  android: ParsedAndroidConfig | RuntimeAndroidConfig | undefined,
): RuntimeAndroidConfig | undefined {
  if (android === undefined) {
    return undefined;
  }

  return {
    ...android,
    workspaceRoot: resolve(android.workspaceRoot),
    javaHome: resolve(android.javaHome),
  };
}

function cloneRuntimeRulesConfig(rules: RuntimeRulesConfig): RuntimeRulesConfig {
  return {
    requestHeaders: rules.requestHeaders.map((rule) => ({
      match: rule.match.map((condition) => ({ ...condition })),
      enable: [...rule.enable],
    })),
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
