import { readFileSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import { ConfigError } from './errors.js';
import type { ParsedFileAccessConfig, ParsedWorkspaceConfig } from './schema.js';
import type {
  FileAccessPolicyQuery,
  RootFileAccessPolicy,
} from '../utils/file-access-policy.js';

export interface CompiledFileAccessPolicy {
  readonly roots: readonly RootFileAccessPolicy[];
}

export interface WorkspaceWithCompiledFileAccessPolicy extends ParsedWorkspaceConfig {
  readonly compiledFileAccessPolicy: CompiledFileAccessPolicy;
}

export function compileGlobalFileAccessPolicies(
  configFilePath: string,
  workspaces: readonly ParsedWorkspaceConfig[],
): readonly WorkspaceWithCompiledFileAccessPolicy[] {
  const fileCache = new Map<string, string>();

  return workspaces.map((workspace, workspaceIndex) => ({
    ...workspace,
    compiledFileAccessPolicy: compileWorkspaceFileAccessPolicy(
      configFilePath,
      workspace,
      workspaceIndex,
      fileCache,
    ),
  }));
}

export function createEmptyCompiledFileAccessPolicy(
  rootDir: string,
  otherRootDirs: readonly string[],
): CompiledFileAccessPolicy {
  return compileRootPolicies(
    rootDir,
    otherRootDirs,
    {
      rootDir: EMPTY_ROOT_POLICY_CONFIG,
      otherRootDirs: Object.freeze({}),
    },
    '<runtime snapshot input>',
    'runtime workspace',
    undefined,
    new Map(),
  );
}

function compileWorkspaceFileAccessPolicy(
  configFilePath: string,
  workspace: ParsedWorkspaceConfig,
  workspaceIndex: number,
  fileCache: Map<string, string>,
): CompiledFileAccessPolicy {
  return compileRootPolicies(
    workspace.rootDir,
    workspace.otherRootDirs,
    workspace.fileAccess ?? {
      rootDir: EMPTY_ROOT_POLICY_CONFIG,
      otherRootDirs: Object.freeze({}),
    },
    configFilePath,
    `workspace "${workspace.id}"`,
    workspaceIndex,
    fileCache,
  );
}

function compileRootPolicies(
  rootDir: string,
  otherRootDirs: readonly string[],
  fileAccess: ParsedFileAccessConfig,
  configFilePath: string,
  workspaceLabel: string,
  workspaceIndex: number | undefined,
  fileCache: Map<string, string>,
): CompiledFileAccessPolicy {
  const rootPolicies = [
    compileRootPolicy(
      rootDir,
      fileAccess.rootDir,
      configFilePath,
      workspaceLabel,
      rootPolicyFieldPath(workspaceIndex),
      fileCache,
    ),
    ...otherRootDirs.map((additionalRoot) =>
      compileRootPolicy(
        additionalRoot,
        fileAccess.otherRootDirs[additionalRoot] ?? EMPTY_ROOT_POLICY_CONFIG,
        configFilePath,
        workspaceLabel,
        additionalRootPolicyFieldPath(workspaceIndex, additionalRoot),
        fileCache,
      )
    ),
  ];

  return Object.freeze({
    roots: Object.freeze(rootPolicies),
  });
}

function compileRootPolicy(
  rootDir: string,
  config: ParsedFileAccessConfig['rootDir'],
  configFilePath: string,
  workspaceLabel: string,
  fieldPath: string,
  fileCache: Map<string, string>,
): RootFileAccessPolicy {
  let realRootDir: string;
  try {
    realRootDir = realpathSync(rootDir);
  } catch (err: unknown) {
    throwPolicyError(configFilePath, fieldPath, workspaceLabel, rootDir, 'Could not resolve the associated root.', err);
  }

  return Object.freeze({
    rootDir: path.resolve(rootDir),
    realRootDir,
    ignore: compileQuery(config.ignoreFiles, configFilePath, workspaceLabel, `${fieldPath}.ignoreFiles`, fileCache),
    deny: compileQuery(config.denyFiles, configFilePath, workspaceLabel, `${fieldPath}.denyFiles`, fileCache),
  });
}

function compileQuery(
  policyFiles: readonly string[],
  configFilePath: string,
  workspaceLabel: string,
  fieldPath: string,
  fileCache: Map<string, string>,
): FileAccessPolicyQuery {
  const matcher = ignore({ ignorecase: process.platform === 'win32' });

  policyFiles.forEach((policyFile, index) => {
    const entryPath = `${fieldPath}[${index}]`;
    const resolvedPolicyFile = validatePolicyFileReference(
      policyFile,
      configFilePath,
      workspaceLabel,
      entryPath,
    );
    let contents = fileCache.get(resolvedPolicyFile);
    if (contents === undefined) {
      contents = readPolicyFile(resolvedPolicyFile, configFilePath, workspaceLabel, entryPath);
      fileCache.set(resolvedPolicyFile, contents);
    }

    try {
      matcher.add(contents);
    } catch {
      throwPolicyError(
        configFilePath,
        entryPath,
        workspaceLabel,
        resolvedPolicyFile,
        'The policy file could not be compiled as Gitignore rules.',
      );
    }
  });

  return Object.freeze({
    isIgnored: (candidate: string): boolean => matcher.ignores(candidate),
  });
}

function validatePolicyFileReference(
  policyFile: string,
  configFilePath: string,
  workspaceLabel: string,
  fieldPath: string,
): string {
  if (!isSupportedLocalAbsolutePath(policyFile)) {
    throwPolicyError(
      configFilePath,
      fieldPath,
      workspaceLabel,
      policyFile,
      'Policy file references must use supported absolute local paths.',
    );
  }

  const resolvedPolicyFile = path.resolve(policyFile);
  try {
    const realPolicyFile = realpathSync(resolvedPolicyFile);
    if (!statSync(realPolicyFile).isFile()) {
      throw new Error('The resolved target is not a regular file.');
    }
  } catch (err: unknown) {
    throwPolicyError(
      configFilePath,
      fieldPath,
      workspaceLabel,
      resolvedPolicyFile,
      'The policy file must exist, be accessible, and resolve to a regular file.',
      err,
    );
  }

  return resolvedPolicyFile;
}

function readPolicyFile(
  policyFile: string,
  configFilePath: string,
  workspaceLabel: string,
  fieldPath: string,
): string {
  try {
    const bytes = readFileSync(policyFile);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err: unknown) {
    throwPolicyError(
      configFilePath,
      fieldPath,
      workspaceLabel,
      policyFile,
      'The policy file could not be read as strict UTF-8.',
      err,
    );
  }
}

function isSupportedLocalAbsolutePath(value: string): boolean {
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) return false;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('//?/') || normalized.startsWith('//./')) return false;

  if (process.platform === 'win32') {
    return /^[a-zA-Z]:[\\/]/.test(value);
  }

  return path.posix.isAbsolute(value) &&
    !normalized.startsWith('//') &&
    !/^[a-zA-Z]:[\\/]/.test(value);
}

function throwPolicyError(
  configFilePath: string,
  fieldPath: string,
  workspaceLabel: string,
  policyPath: string,
  detail: string,
  cause?: unknown,
): never {
  const causeMessage = cause instanceof Error ? ` ${cause.message}` : '';
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath,
    fieldPath,
    message: `Invalid file access policy for ${workspaceLabel} at ${fieldPath} (${policyPath}). ${detail}${causeMessage}`,
    suggestion: `Fix ${fieldPath} in ${configFilePath} and restart the server.`,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function rootPolicyFieldPath(workspaceIndex: number | undefined): string {
  return workspaceIndex === undefined
    ? 'fileAccess.rootDir'
    : `workspaces[${workspaceIndex}].fileAccess.rootDir`;
}

function additionalRootPolicyFieldPath(
  workspaceIndex: number | undefined,
  rootKey: string,
): string {
  const pathPrefix = workspaceIndex === undefined
    ? 'fileAccess.otherRootDirs'
    : `workspaces[${workspaceIndex}].fileAccess.otherRootDirs`;
  return `${pathPrefix}[${JSON.stringify(rootKey)}]`;
}

const EMPTY_ROOT_POLICY_CONFIG = Object.freeze({
  ignoreFiles: Object.freeze([]) as readonly string[],
  denyFiles: Object.freeze([]) as readonly string[],
});
