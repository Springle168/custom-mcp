import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import { ConfigError } from './errors.js';
import type { ParsedFileAccessConfig, ParsedWorkspaceConfig } from './schema.js';
import { readStrictUtf8RegularFile, StrictUtf8FileError } from './strict-utf8-file.js';
import type { FileAccessPolicyQuery, RootFileAccessPolicy } from '../utils/file-access-policy.js';

export interface CompiledFileAccessPolicy {
  readonly roots: readonly CompiledRootFileAccessPolicy[];
}

export interface RootFileAccessPolicyFiles {
  readonly rootDir: string;
  readonly ignoreFiles: readonly string[];
  readonly denyFiles: readonly string[];
}

export interface CompiledRootFileAccessPolicy {
  readonly policy: RootFileAccessPolicy;
  readonly policyFiles: RootFileAccessPolicyFiles;
}

export interface WorkspaceWithCompiledFileAccessPolicy extends ParsedWorkspaceConfig {
  readonly compiledFileAccessPolicy: CompiledFileAccessPolicy;
}

export function compileWorkspaceFileAccessPolicy(
  configFilePath: string,
  workspaceId: string,
  workspace: ParsedWorkspaceConfig,
): WorkspaceWithCompiledFileAccessPolicy {
  return {
    ...workspace,
    compiledFileAccessPolicy: compileRootPolicies(
      workspace.rootDir,
      workspace.otherRootDirs,
      workspace.fileAccess ?? {
        rootDir: EMPTY_ROOT_POLICY_CONFIG,
        otherRootDirs: Object.freeze({}),
      },
      configFilePath,
      `workspace "${workspaceId}"`,
      undefined,
      new Map(),
    ),
  };
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

function compileRootPolicies(
  rootDir: string,
  otherRootDirs: readonly string[],
  fileAccess: ParsedFileAccessConfig,
  configFilePath: string,
  workspaceLabel: string,
  workspaceIndex: number | undefined,
  fileCache: Map<string, string>,
): CompiledFileAccessPolicy {
  const compiledRoots = [
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
      ),
    ),
  ];

  return Object.freeze({
    roots: Object.freeze(compiledRoots),
  });
}

function compileRootPolicy(
  rootDir: string,
  config: ParsedFileAccessConfig['rootDir'],
  configFilePath: string,
  workspaceLabel: string,
  fieldPath: string,
  fileCache: Map<string, string>,
): CompiledRootFileAccessPolicy {
  let realRootDir: string;
  try {
    realRootDir = realpathSync(rootDir);
  } catch (err: unknown) {
    throwPolicyError(
      configFilePath,
      fieldPath,
      workspaceLabel,
      rootDir,
      'Could not resolve the associated root.',
      err,
    );
  }

  const resolvedRootDir = path.resolve(rootDir);
  const ignorePolicy = compileQuery(
    config.ignoreFiles,
    configFilePath,
    workspaceLabel,
    `${fieldPath}.ignoreFiles`,
    fileCache,
  );
  const denyPolicy = compileQuery(
    config.denyFiles,
    configFilePath,
    workspaceLabel,
    `${fieldPath}.denyFiles`,
    fileCache,
  );

  return Object.freeze({
    policy: Object.freeze({
      rootDir: resolvedRootDir,
      realRootDir,
      ignore: ignorePolicy.query,
      deny: denyPolicy.query,
    }),
    policyFiles: Object.freeze({
      rootDir: resolvedRootDir,
      ignoreFiles: ignorePolicy.policyFiles,
      denyFiles: denyPolicy.policyFiles,
    }),
  });
}

interface CompiledFileAccessQuery {
  readonly query: FileAccessPolicyQuery;
  readonly policyFiles: readonly string[];
}

function compileQuery(
  policyFiles: readonly string[],
  configFilePath: string,
  workspaceLabel: string,
  fieldPath: string,
  fileCache: Map<string, string>,
): CompiledFileAccessQuery {
  const matcher = ignore({ ignorecase: process.platform === 'win32' });
  const resolvedPolicyFiles: string[] = [];

  policyFiles.forEach((policyFile, index) => {
    const entryPath = `${fieldPath}[${index}]`;
    const resolvedPolicyFile = validatePolicyFileReference(
      policyFile,
      configFilePath,
      workspaceLabel,
      entryPath,
    );
    resolvedPolicyFiles.push(resolvedPolicyFile);
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
    query: Object.freeze({
      isIgnored: (candidate: string): boolean => matcher.ignores(candidate),
    }),
    policyFiles: Object.freeze(resolvedPolicyFiles),
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
  return resolvedPolicyFile;
}

function readPolicyFile(
  policyFile: string,
  configFilePath: string,
  workspaceLabel: string,
  fieldPath: string,
): string {
  try {
    return readStrictUtf8RegularFile(policyFile);
  } catch (error: unknown) {
    if (!(error instanceof StrictUtf8FileError)) {
      throw error;
    }

    if (
      error.reason === 'not_found' ||
      error.reason === 'not_regular' ||
      error.reason === 'open_failed' ||
      error.reason === 'inspect_failed'
    ) {
      throwPolicyError(
        configFilePath,
        fieldPath,
        workspaceLabel,
        policyFile,
        'The policy file must exist, be accessible, and resolve to a regular file.',
        error.cause,
      );
    }

    throwPolicyError(
      configFilePath,
      fieldPath,
      workspaceLabel,
      policyFile,
      'The policy file could not be read as strict UTF-8.',
      error.cause,
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

  return (
    path.posix.isAbsolute(value) && !normalized.startsWith('//') && !/^[a-zA-Z]:[\\/]/.test(value)
  );
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
  const pathPrefix =
    workspaceIndex === undefined
      ? 'fileAccess.otherRootDirs'
      : `workspaces[${workspaceIndex}].fileAccess.otherRootDirs`;
  return `${pathPrefix}[${JSON.stringify(rootKey)}]`;
}

const EMPTY_ROOT_POLICY_CONFIG = Object.freeze({
  ignoreFiles: Object.freeze([]) as readonly string[],
  denyFiles: Object.freeze([]) as readonly string[],
});
