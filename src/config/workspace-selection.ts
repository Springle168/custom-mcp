import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { ConfigError } from './errors.js';
import type { ParsedWorkspaceConfig } from './schema.js';

export type RuntimeConfigSelectionMode = 'explicit' | 'cwd';

export interface RuntimeConfigIdentity {
  readonly configFilePath: string;
  readonly workspaceId: string;
  readonly rootDir: string;
  readonly port: number;
  readonly selectionMode: RuntimeConfigSelectionMode;
}

export interface RuntimeWorkspaceSelection {
  readonly workspace: ParsedWorkspaceConfig;
  readonly identity: RuntimeConfigIdentity;
}

export interface SelectRuntimeWorkspaceOptions {
  readonly configFilePath: string;
  readonly workspaces: readonly ParsedWorkspaceConfig[];
  readonly workspaceId?: string;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly realpath?: (targetPath: string) => string;
}

interface WorkspaceRealPath {
  readonly workspace: ParsedWorkspaceConfig;
  readonly index: number;
  readonly realRootDir: string;
  readonly identityRootDir: string;
}

export function selectRuntimeWorkspace(
  options: SelectRuntimeWorkspaceOptions,
): RuntimeWorkspaceSelection {
  const requestedWorkspaceId = readRequestedWorkspaceId(options.workspaceId, options.configFilePath);

  if (requestedWorkspaceId !== undefined) {
    return selectExplicitWorkspace(options, requestedWorkspaceId);
  }

  return selectWorkspaceByCwd(options);
}

function readRequestedWorkspaceId(
  workspaceId: string | undefined,
  configFilePath: string,
): string | undefined {
  if (workspaceId === undefined) {
    return undefined;
  }

  const requestedWorkspaceId = workspaceId.trim();
  if (requestedWorkspaceId.length === 0) {
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath,
      fieldPath: 'workspace',
      message: '--workspace must be a non-empty workspace id.',
      suggestion: 'Pass --workspace <id> using an id that exists in the global config workspaces array.',
    });
  }

  return requestedWorkspaceId;
}

function selectExplicitWorkspace(
  options: SelectRuntimeWorkspaceOptions,
  requestedWorkspaceId: string,
): RuntimeWorkspaceSelection {
  const workspace = options.workspaces.find((candidate) => candidate.id === requestedWorkspaceId);

  if (!workspace) {
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: options.configFilePath,
      fieldPath: 'workspace',
      message: `Workspace "${requestedWorkspaceId}" was not found in the global config.`,
      suggestion:
        `Choose one of the configured workspace ids: ${options.workspaces.map((candidate) => candidate.id).join(', ')}.`,
    });
  }

  return {
    workspace,
    identity: createRuntimeConfigIdentity({
      configFilePath: options.configFilePath,
      workspace,
      selectionMode: 'explicit',
    }),
  };
}

function selectWorkspaceByCwd(
  options: SelectRuntimeWorkspaceOptions,
): RuntimeWorkspaceSelection {
  const platform = options.platform ?? process.platform;
  const realpath = options.realpath ?? defaultRealpath;
  const cwd = options.cwd ?? process.cwd();
  const cwdRealPath = resolveRealPathForSelection({
    targetPath: cwd,
    label: 'current working directory',
    configFilePath: options.configFilePath,
    realpath,
    platform,
  });
  const workspaceRealPaths = options.workspaces.map((workspace, index) =>
    resolveWorkspaceRealPath({
      workspace,
      index,
      configFilePath: options.configFilePath,
      realpath,
      platform,
    }),
  );

  const exactMatch = workspaceRealPaths.find((workspaceRoot) =>
    workspaceRoot.identityRootDir === cwdRealPath.identityRootDir
  );

  if (exactMatch) {
    return {
      workspace: exactMatch.workspace,
      identity: createRuntimeConfigIdentity({
        configFilePath: options.configFilePath,
        workspace: exactMatch.workspace,
        selectionMode: 'cwd',
      }),
    };
  }

  const containingWorkspace = workspaceRealPaths.find((workspaceRoot) =>
    isProperPathInsideRoot(cwdRealPath.identityRootDir, workspaceRoot.identityRootDir, platform)
  );

  if (containingWorkspace) {
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: options.configFilePath,
      fieldPath: 'workspace',
      message:
        `Current working directory ${cwdRealPath.realPath} is inside workspace "${containingWorkspace.workspace.id}" ` +
        `(${containingWorkspace.realRootDir}), but default workspace selection requires cwd to equal a workspace root realpath.`,
      suggestion:
        `Start the server from ${containingWorkspace.workspace.rootDir}, or pass --workspace ${containingWorkspace.workspace.id}.`,
    });
  }

  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: options.configFilePath,
    fieldPath: 'workspace',
    message: `Current working directory ${cwdRealPath.realPath} does not match any configured workspace rootDir realpath.`,
    suggestion:
      `Start the server from a configured workspace root, or pass --workspace <id>. Configured workspace ids: ${options.workspaces.map((workspace) => workspace.id).join(', ')}.`,
  });
}

function resolveWorkspaceRealPath(options: {
  readonly workspace: ParsedWorkspaceConfig;
  readonly index: number;
  readonly configFilePath: string;
  readonly realpath: (targetPath: string) => string;
  readonly platform: NodeJS.Platform;
}): WorkspaceRealPath {
  const realPath = resolveRealPathForSelection({
    targetPath: options.workspace.rootDir,
    label: `workspaces[${options.index}].rootDir`,
    configFilePath: options.configFilePath,
    realpath: options.realpath,
    platform: options.platform,
  });

  return {
    workspace: options.workspace,
    index: options.index,
    realRootDir: realPath.realPath,
    identityRootDir: realPath.identityRootDir,
  };
}

function resolveRealPathForSelection(options: {
  readonly targetPath: string;
  readonly label: string;
  readonly configFilePath: string;
  readonly realpath: (targetPath: string) => string;
  readonly platform: NodeJS.Platform;
}): { readonly realPath: string; readonly identityRootDir: string } {
  try {
    const realPath = options.realpath(options.targetPath);
    return {
      realPath,
      identityRootDir: normalizePathIdentity(realPath, options.platform),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: options.configFilePath,
      fieldPath: options.label,
      message: `Could not resolve realpath for ${options.label}: ${options.targetPath}. ${message}`,
      suggestion: 'Check that the directory exists and that the current user can access it.',
      cause: err,
    });
  }
}

function createRuntimeConfigIdentity(options: {
  readonly configFilePath: string;
  readonly workspace: ParsedWorkspaceConfig;
  readonly selectionMode: RuntimeConfigSelectionMode;
}): RuntimeConfigIdentity {
  return Object.freeze({
    configFilePath: options.configFilePath,
    workspaceId: options.workspace.id,
    rootDir: options.workspace.rootDir,
    port: options.workspace.port,
    selectionMode: options.selectionMode,
  });
}

function defaultRealpath(targetPath: string): string {
  return realpathSync.native(targetPath);
}

function normalizePathIdentity(input: string, platform: NodeJS.Platform): string {
  const pathApi = getPathApi(platform);
  const resolvedPath = pathApi.resolve(input);
  const normalizedPath = trimTrailingSeparators(pathApi.normalize(resolvedPath), pathApi);

  return platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
}

function trimTrailingSeparators(
  input: string,
  pathApi: typeof path.win32 | typeof path.posix,
): string {
  const root = pathApi.parse(input).root;
  if (input === root) {
    return input;
  }

  let trimmed = input;
  while (trimmed.length > root.length && /[\\/]/.test(trimmed.at(-1) ?? '')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function isProperPathInsideRoot(
  candidatePathIdentity: string,
  rootIdentity: string,
  platform: NodeJS.Platform,
): boolean {
  if (candidatePathIdentity === rootIdentity) {
    return false;
  }

  const pathApi = getPathApi(platform);
  const relativePath = pathApi.relative(rootIdentity, candidatePathIdentity);
  return relativePath.length > 0 &&
    !relativePath.startsWith('..') &&
    !pathApi.isAbsolute(relativePath);
}

function getPathApi(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}
