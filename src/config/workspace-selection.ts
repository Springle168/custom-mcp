import { ConfigError } from './errors.js';
import type { WorkspaceConfigReference } from './global-config-schema.js';
import type { ParsedWorkspaceConfig } from './schema.js';
import { readWorkspaceIdToken } from './value-policy.js';

export interface RuntimeConfigIdentity {
  readonly globalConfigFilePath: string;
  readonly workspaceConfigFilePath: string;
  readonly workspaceId: string;
  readonly rootDir: string;
  readonly host: string;
  readonly port: number;
}

export interface SelectWorkspaceReferenceOptions {
  readonly globalConfigFilePath: string;
  readonly workspaces: readonly WorkspaceConfigReference[];
  readonly workspaceId: string;
}

export function selectWorkspaceReference(
  options: SelectWorkspaceReferenceOptions,
): WorkspaceConfigReference {
  const result = readWorkspaceIdToken(options.workspaceId, { fieldPath: 'workspace' });
  if (!result.ok) {
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: options.globalConfigFilePath,
      fieldPath: result.error.fieldPath,
      message: result.error.message,
      suggestion:
        'Pass --workspace <id> using a valid workspace id token that exists in the global config workspaces array.',
    });
  }

  const workspace = options.workspaces.find((candidate) => candidate.id === result.value);
  if (workspace === undefined) {
    throw new ConfigError({
      code: 'config_validation_failed',
      configFilePath: options.globalConfigFilePath,
      fieldPath: 'workspace',
      message: `Workspace "${result.value}" was not found in the global config.`,
      suggestion:
        `Choose one of the configured workspace ids: ${options.workspaces.map((candidate) => candidate.id).join(', ')}.`,
    });
  }

  return workspace;
}

export function createRuntimeConfigIdentity(options: {
  readonly globalConfigFilePath: string;
  readonly workspaceConfigFilePath: string;
  readonly workspaceId: string;
  readonly workspace: ParsedWorkspaceConfig;
}): RuntimeConfigIdentity {
  return Object.freeze({
    globalConfigFilePath: options.globalConfigFilePath,
    workspaceConfigFilePath: options.workspaceConfigFilePath,
    workspaceId: options.workspaceId,
    rootDir: options.workspace.rootDir,
    host: options.workspace.host,
    port: options.workspace.port,
  });
}
