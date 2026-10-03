import { readExistingDirectoryPath } from './path-policy.js';
import { ConfigError } from './errors.js';
import {
  readEnvPositiveInteger,
  readLineEndingToken,
  type ValuePolicyResult,
} from './value-policy.js';
import {
  ENV_OVERRIDE_FIELD_ENV_VARS,
  type ParsedAndroidConfig,
  type ParsedEnvOverrideField,
  type ParsedLineEnding,
  type ParsedWorkspaceConfig,
} from './schema.js';

export interface ApplyEnvOverridesOptions {
  readonly configFilePath: string;
  readonly workspace: ParsedWorkspaceConfig;
  readonly env?: NodeJS.ProcessEnv;
}

type EnvOverrideField = ParsedEnvOverrideField;

const ALLOWED_FIELD_ENV_VARS = ENV_OVERRIDE_FIELD_ENV_VARS;

export function applyEnvOverridesToWorkspace(
  options: ApplyEnvOverridesOptions,
): ParsedWorkspaceConfig {
  const allowedFields = options.workspace.envOverrides?.allowedFields ?? [];
  if (allowedFields.length === 0) {
    return options.workspace;
  }

  const validatedFields = validateAllowedFields(options, allowedFields);
  assertAndroidOverridesHaveBaseConfig(options, validatedFields);

  const env = options.env ?? process.env;
  const lineEnding =
    readLineEndingOverride(options, env, validatedFields) ?? options.workspace.lineEnding;
  const logsDir = readPathOverride(options, env, validatedFields, 'logsDir');
  const android = applyAndroidOverrides(options, env, validatedFields);

  return {
    ...options.workspace,
    lineEnding,
    ...(logsDir !== undefined ? { logsDir } : {}),
    ...(android ? { android } : {}),
  };
}

function validateAllowedFields(
  options: ApplyEnvOverridesOptions,
  allowedFields: readonly ParsedEnvOverrideField[],
): EnvOverrideField[] {
  return allowedFields.map((field, index) => {
    if (!isEnvOverrideField(field)) {
      failConfig(
        options,
        allowedFieldPath(options, index),
        `envOverrides.allowedFields contains unknown field "${field}". Allowed fields are: ${Object.keys(ALLOWED_FIELD_ENV_VARS).join(', ')}.`,
      );
    }

    return field;
  });
}

function assertAndroidOverridesHaveBaseConfig(
  options: ApplyEnvOverridesOptions,
  allowedFields: readonly EnvOverrideField[],
): void {
  if (options.workspace.android !== undefined) {
    return;
  }

  const androidFieldIndex = allowedFields.findIndex((field) => field.startsWith('android.'));
  if (androidFieldIndex === -1) {
    return;
  }

  failConfig(
    options,
    allowedFieldPath(options, androidFieldIndex),
    `envOverrides.allowedFields contains Android field "${allowedFields[androidFieldIndex]}", but android is not configured. Android env overrides can only override an existing complete android config block.`,
  );
}

function readLineEndingOverride(
  options: ApplyEnvOverridesOptions,
  env: NodeJS.ProcessEnv,
  allowedFields: readonly EnvOverrideField[],
): ParsedLineEnding | undefined {
  const field: EnvOverrideField = 'lineEnding';
  if (!allowedFields.includes(field)) {
    return undefined;
  }

  const envVar = ALLOWED_FIELD_ENV_VARS[field];
  const rawValue = readAuthorizedEnvValue(env, envVar);
  if (rawValue === undefined) {
    return undefined;
  }

  return unwrapEnvPolicy(options, field, readLineEndingToken(rawValue, { fieldPath: envVar }));
}

function applyAndroidOverrides(
  options: ApplyEnvOverridesOptions,
  env: NodeJS.ProcessEnv,
  allowedFields: readonly EnvOverrideField[],
): ParsedAndroidConfig | undefined {
  const android = options.workspace.android;
  if (android === undefined) {
    return undefined;
  }

  return {
    workspaceRoot:
      readPathOverride(options, env, allowedFields, 'android.workspaceRoot') ??
      android.workspaceRoot,
    javaHome: readPathOverride(options, env, allowedFields, 'android.javaHome') ?? android.javaHome,
    buildTimeoutMs:
      readPositiveIntegerOverride(options, env, allowedFields, 'android.buildTimeoutMs') ??
      android.buildTimeoutMs,
    maxErrorBlockChars:
      readPositiveIntegerOverride(options, env, allowedFields, 'android.maxErrorBlockChars') ??
      android.maxErrorBlockChars,
    maxLogTailChars:
      readPositiveIntegerOverride(options, env, allowedFields, 'android.maxLogTailChars') ??
      android.maxLogTailChars,
  };
}

function readPathOverride(
  options: ApplyEnvOverridesOptions,
  env: NodeJS.ProcessEnv,
  allowedFields: readonly EnvOverrideField[],
  field: EnvOverrideField,
): string | undefined {
  if (!allowedFields.includes(field)) {
    return undefined;
  }

  const envVar = ALLOWED_FIELD_ENV_VARS[field];
  const rawValue = readAuthorizedEnvValue(env, envVar);
  if (rawValue === undefined) {
    return undefined;
  }

  return unwrapEnvPolicy(
    options,
    field,
    readExistingDirectoryPath(rawValue, { fieldPath: envVar }),
  );
}

function readPositiveIntegerOverride(
  options: ApplyEnvOverridesOptions,
  env: NodeJS.ProcessEnv,
  allowedFields: readonly EnvOverrideField[],
  field: EnvOverrideField,
): number | undefined {
  if (!allowedFields.includes(field)) {
    return undefined;
  }

  const envVar = ALLOWED_FIELD_ENV_VARS[field];
  const rawValue = readAuthorizedEnvValue(env, envVar);
  if (rawValue === undefined) {
    return undefined;
  }

  return unwrapEnvPolicy(
    options,
    field,
    readEnvPositiveInteger(rawValue, { fieldPath: envVar, label: envVar }),
  );
}

function readAuthorizedEnvValue(env: NodeJS.ProcessEnv, envVar: string): string | undefined {
  return env[envVar];
}

function unwrapEnvPolicy<T>(
  options: ApplyEnvOverridesOptions,
  field: EnvOverrideField,
  result: ValuePolicyResult<T>,
): T {
  if (!result.ok) {
    failEnvValue(options, field, result.error.message);
  }

  return result.value;
}

function isEnvOverrideField(field: string): field is EnvOverrideField {
  return Object.prototype.hasOwnProperty.call(ALLOWED_FIELD_ENV_VARS, field);
}

function targetFieldPath(_options: ApplyEnvOverridesOptions, field: EnvOverrideField): string {
  return field;
}

function allowedFieldPath(_options: ApplyEnvOverridesOptions, index: number): string {
  return `envOverrides.allowedFields[${index}]`;
}

function failConfig(options: ApplyEnvOverridesOptions, fieldPath: string, message: string): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: options.configFilePath,
    fieldPath,
    message,
    suggestion: `Fix ${fieldPath} in ${options.configFilePath}, or remove that field from envOverrides.allowedFields.`,
  });
}

function failEnvValue(
  options: ApplyEnvOverridesOptions,
  field: EnvOverrideField,
  message: string,
): never {
  const envVar = ALLOWED_FIELD_ENV_VARS[field];
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: options.configFilePath,
    fieldPath: targetFieldPath(options, field),
    message,
    suggestion: `Fix ${envVar} in the server environment, or remove ${field} from envOverrides.allowedFields.`,
  });
}
