import { resolve } from 'node:path';
import type { RuntimeToolExposure } from '../config.js';
import { ConfigError } from './errors.js';
import { readExistingDirectoryPath } from './path-policy.js';
import type { RuntimeRulesConfig } from './request-header-rules.js';
import {
  createEmptyCompiledFileAccessPolicy,
  type CompiledFileAccessPolicy,
  type CompiledRootFileAccessPolicy,
  type RootFileAccessPolicyFiles,
  type WorkspaceWithCompiledFileAccessPolicy,
} from './file-access-policy.js';
import type { ParsedAndroidConfig } from './schema.js';
import { readTypedString } from './value-policy.js';
import {
  createFileAccessPolicyContext,
  type FileAccessPolicyContext,
  type RootFileAccessPolicy,
} from '../utils/file-access-policy.js';
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
  readonly globalConfigFilePath: string;
  readonly workspaceConfigFilePath: string;
  readonly workspaceId: string;
  readonly rootDir: string;
  readonly otherRootDirs: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly lineEnding: LineEnding;
  readonly logsDir: string;
  readonly android?: RuntimeAndroidConfig;
  readonly toolExposure: RuntimeToolExposure;
  readonly rules: RuntimeRulesConfig;
  readonly pathSafetyContext: PathSafetyContext;
  readonly fileAccessPolicyContext: FileAccessPolicyContext;
  readonly fileAccessPolicyFiles: readonly RootFileAccessPolicyFiles[];
}

export interface RuntimeConfigSnapshotInput {
  readonly snapshotVersion?: number;
  readonly globalConfigFilePath: string;
  readonly workspaceConfigFilePath: string;
  readonly workspaceId: string;
  readonly rootDir: string;
  readonly otherRootDirs?: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly lineEnding: LineEnding;
  readonly logsDir: string;
  readonly android?: RuntimeAndroidConfig;
  readonly toolExposure: RuntimeToolExposure;
  readonly rules: RuntimeRulesConfig;
  readonly compiledFileAccessPolicy?: CompiledFileAccessPolicy;
}

export interface BuildRuntimeConfigSnapshotOptions {
  readonly globalConfigFilePath: string;
  readonly workspaceConfigFilePath: string;
  readonly workspaceId: string;
  readonly workspace: WorkspaceWithCompiledFileAccessPolicy;
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
      globalConfigFilePath: options.globalConfigFilePath,
      workspaceConfigFilePath: options.workspaceConfigFilePath,
      workspaceId: options.workspaceId,
      rootDir: workspace.rootDir,
      otherRootDirs: workspace.otherRootDirs,
      host: workspace.host,
      port: workspace.port,
      lineEnding: workspace.lineEnding,
      logsDir,
      ...(workspace.android ? { android: workspace.android } : {}),
      toolExposure: workspace.toolExposure,
      rules: workspace.rules,
      compiledFileAccessPolicy: workspace.compiledFileAccessPolicy,
      snapshotVersion: options.snapshotVersion ?? 1,
    },
  );
}

export function createRuntimeConfigSnapshot(
  input: RuntimeConfigSnapshotInput,
): RuntimeConfigSnapshot {
  assertRuntimeConfigSnapshotInputPreconditions(input);

  const configuredOtherRootDirs = [...(input.otherRootDirs ?? [])];
  const pathSafetyContext = createPathSafetyContextOrThrowConfigError(
    input,
    configuredOtherRootDirs,
  );
  const otherRootDirs = pathSafetyContext.allowedRoots
    .filter((root) => root.kind === 'additional')
    .map((root) => root.rootDir);
  const logsDir = resolve(input.logsDir);
  const android = resolveRuntimeAndroidConfig(input.android);
  const toolExposure = cloneRuntimeToolExposure(input.toolExposure);
  const rules = cloneRuntimeRulesConfig(input.rules);
  const compiledPolicy = input.compiledFileAccessPolicy ??
    createEmptyCompiledFileAccessPolicy(input.rootDir, configuredOtherRootDirs);
  const fileAccessPolicyContext = createFileAccessPolicyContext(
    pathSafetyContext,
    cloneRootFileAccessPolicies(compiledPolicy.roots),
  );
  const fileAccessPolicyFiles = cloneRootFileAccessPolicyFiles(
    compiledPolicy.roots,
  );

  const snapshot: RuntimeConfigSnapshot = {
    snapshotVersion: input.snapshotVersion ?? 1,
    globalConfigFilePath: input.globalConfigFilePath,
    workspaceConfigFilePath: input.workspaceConfigFilePath,
    workspaceId: input.workspaceId,
    rootDir: pathSafetyContext.primaryRoot.rootDir,
    otherRootDirs,
    host: input.host,
    port: input.port,
    lineEnding: input.lineEnding,
    logsDir,
    ...(android ? { android } : {}),
    toolExposure,
    rules,
    pathSafetyContext,
    fileAccessPolicyContext,
    fileAccessPolicyFiles,
  };

  return deepFreeze(snapshot);
}

function readRuntimeLogsDir(options: BuildRuntimeConfigSnapshotOptions): string {
  if (options.workspace.logsDir !== undefined) {
    return options.workspace.logsDir;
  }

  const fieldPath = 'logsDir';
  const result = readExistingDirectoryPath(options.defaultLogsDir, { fieldPath });
  if (result.ok) {
    return result.value;
  }

  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: options.workspaceConfigFilePath,
    fieldPath: result.error.fieldPath,
    message: result.error.message,
    suggestion:
      `Create the default logs root at ${resolve(options.defaultLogsDir)}, ` +
      `or configure ${fieldPath} / allowlisted MCP_LOGS_DIR to an existing local absolute directory.`,
  });
}

function assertRuntimeConfigSnapshotInputPreconditions(
  input: RuntimeConfigSnapshotInput,
): void {
  assertSnapshotPathValue(input, input.rootDir, 'rootDir');

  input.otherRootDirs?.forEach((otherRootDir, index) => {
    assertSnapshotPathValue(
      input,
      otherRootDir,
      `otherRootDirs[${index}]`,
    );
  });

  assertSnapshotPathValue(input, input.logsDir, 'logsDir');

  if (input.android === undefined) {
    return;
  }

  assertSnapshotPathValue(
    input,
    input.android.workspaceRoot,
    'android.workspaceRoot',
  );
  assertSnapshotPathValue(
    input,
    input.android.javaHome,
    'android.javaHome',
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
    configFilePath: input.workspaceConfigFilePath,
    fieldPath: result.error.fieldPath,
    message: result.error.message,
    suggestion:
      `Fix ${result.error.fieldPath} before building the runtime snapshot. ` +
      'Snapshot path-like inputs must already be validated values without leading or trailing whitespace.',
  });
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

function cloneRuntimeToolExposure(
  exposure: RuntimeToolExposure,
): RuntimeToolExposure {
  if (exposure.mode === 'all') {
    return { mode: 'all' };
  }

  return {
    mode: exposure.mode,
    names: [...exposure.names],
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

function cloneRootFileAccessPolicies(
  roots: readonly CompiledRootFileAccessPolicy[],
): readonly RootFileAccessPolicy[] {
  return roots.map(({ policy }) => Object.freeze({
    rootDir: policy.rootDir,
    realRootDir: policy.realRootDir,
    ignore: Object.freeze({ isIgnored: policy.ignore.isIgnored }),
    deny: Object.freeze({ isIgnored: policy.deny.isIgnored }),
  }));
}

function cloneRootFileAccessPolicyFiles(
  roots: readonly CompiledRootFileAccessPolicy[],
): readonly RootFileAccessPolicyFiles[] {
  return roots.map(({ policyFiles }) => ({
    rootDir: policyFiles.rootDir,
    ignoreFiles: [...policyFiles.ignoreFiles],
    denyFiles: [...policyFiles.denyFiles],
  }));
}

function createPathSafetyContextOrThrowConfigError(
  input: RuntimeConfigSnapshotInput,
  otherRootDirs: string[],
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
      configFilePath: input.workspaceConfigFilePath,
      fieldPath: inferAllowedRootFieldPath(message),
      message: `Selected workspace allowed roots are invalid. ${message}`,
      suggestion:
        `Fix the selected workspace rootDir/otherRootDirs in ${input.workspaceConfigFilePath}. ` +
        'Allowed roots must be existing absolute local directories and must not duplicate or contain one another.',
      cause: err,
    });
  }
}

function inferAllowedRootFieldPath(
  message: string,
): string {
  const otherRootMatches = [...message.matchAll(/otherRootDirs\[\d+\]/g)].map((match) => match[0]);

  if (otherRootMatches.length > 0) {
    const selectedMatch = message.includes(' both resolve to ')
      ? otherRootMatches.at(-1)
      : otherRootMatches[0];
    return selectedMatch ?? 'otherRootDirs';
  }

  if (message.includes('rootDir')) {
    return 'rootDir';
  }

  return 'rootDir';
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
