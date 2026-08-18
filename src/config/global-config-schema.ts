import { ConfigError } from './errors.js';
import { readLocalAbsolutePath } from './path-policy.js';
import {
  readWorkspaceIdToken,
  type ValuePolicyResult,
} from './value-policy.js';

export interface WorkspaceConfigReference {
  readonly id: string;
  readonly configFile: string;
}

export interface ParsedGlobalConfig {
  readonly version: 2;
  readonly workspaces: readonly WorkspaceConfigReference[];
}

export interface ParseGlobalConfigOptions {
  readonly configFilePath: string;
}

interface ParseContext {
  readonly configFilePath: string;
}

const TOP_LEVEL_FIELDS = new Set(['version', 'workspaces']);
const WORKSPACE_REFERENCE_FIELDS = new Set(['id', 'configFile']);

export function parseGlobalConfig(
  value: unknown,
  options: ParseGlobalConfigOptions,
): ParsedGlobalConfig {
  const context: ParseContext = { configFilePath: options.configFilePath };
  const rawConfig = readObject(context, value, undefined, 'Global config file must contain a JSON object.');

  assertKnownFields(context, rawConfig, TOP_LEVEL_FIELDS, undefined);

  if (rawConfig.version !== 2) {
    fail(
      context,
      'version',
      'version must be the number 2. The current server only supports global config schema version 2.',
    );
  }

  const rawWorkspaces = rawConfig.workspaces;
  if (!Array.isArray(rawWorkspaces)) {
    fail(context, 'workspaces', 'workspaces must be a non-empty array.');
  }
  if (rawWorkspaces.length === 0) {
    fail(context, 'workspaces', 'workspaces must contain at least one workspace.');
  }

  const seenIds = new Set<string>();
  const workspaces = rawWorkspaces.map((value, index) => {
    const workspace = parseWorkspaceReference(context, value, index);
    if (seenIds.has(workspace.id)) {
      fail(
        context,
        `workspaces[${index}].id`,
        `workspace id "${workspace.id}" must be unique across workspaces.`,
      );
    }
    seenIds.add(workspace.id);
    return workspace;
  });

  return deepFreeze({
    version: 2,
    workspaces,
  });
}

function parseWorkspaceReference(
  context: ParseContext,
  value: unknown,
  index: number,
): WorkspaceConfigReference {
  const fieldPath = `workspaces[${index}]`;
  const rawWorkspace = readObject(
    context,
    value,
    fieldPath,
    `${fieldPath} must be a JSON object.`,
  );
  assertKnownFields(context, rawWorkspace, WORKSPACE_REFERENCE_FIELDS, fieldPath);

  const idPath = `${fieldPath}.id`;
  const configFilePath = `${fieldPath}.configFile`;
  assertRequired(context, rawWorkspace, 'id', idPath);
  assertRequired(context, rawWorkspace, 'configFile', configFilePath);

  return {
    id: unwrapPolicy(context, readWorkspaceIdToken(rawWorkspace.id, { fieldPath: idPath })),
    configFile: unwrapPolicy(
      context,
      readLocalAbsolutePath(rawWorkspace.configFile, { fieldPath: configFilePath }),
    ),
  };
}

function readObject(
  context: ParseContext,
  value: unknown,
  fieldPath: string | undefined,
  message: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(context, fieldPath, message);
  }
  return value as Record<string, unknown>;
}

function assertKnownFields(
  context: ParseContext,
  value: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
  parentPath: string | undefined,
): void {
  for (const key of Object.keys(value)) {
    if (!knownFields.has(key)) {
      const fieldPath = parentPath ? `${parentPath}.${key}` : key;
      fail(
        context,
        fieldPath,
        `Unknown config field ${fieldPath}. Remove it or update the config schema.`,
      );
    }
  }
}

function assertRequired(
  context: ParseContext,
  value: Record<string, unknown>,
  key: string,
  fieldPath: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    fail(context, fieldPath, `${fieldPath} is required.`);
  }
}

function unwrapPolicy<T>(context: ParseContext, result: ValuePolicyResult<T>): T {
  if (!result.ok) {
    fail(context, result.error.fieldPath, result.error.message);
  }
  return result.value;
}

function fail(
  context: ParseContext,
  fieldPath: string | undefined,
  message: string,
): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: context.configFilePath,
    ...(fieldPath ? { fieldPath } : {}),
    message,
    suggestion: `Fix ${fieldPath ?? 'the configuration'} in ${context.configFilePath} and restart the server.`,
  });
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
