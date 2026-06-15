import { ConfigError } from './errors.js';
import { normalizeLogsDirPath } from './path-validation.js';
import type {
  ParsedAndroidConfig,
  ParsedLineEnding,
  ParsedWorkspaceConfig,
} from './schema.js';

export interface ApplyEnvOverridesOptions {
  readonly configFilePath: string;
  readonly workspace: ParsedWorkspaceConfig;
  readonly workspaceIndex: number;
  readonly env?: NodeJS.ProcessEnv;
}

type EnvOverrideField = keyof typeof ALLOWED_FIELD_ENV_VARS;

const ALLOWED_FIELD_ENV_VARS = {
  lineEnding: 'MCP_LINE_ENDING',
  logsDir: 'MCP_LOGS_DIR',
  'android.workspaceRoot': 'ANDROID_WORKSPACE_ROOT',
  'android.javaHome': 'ANDROID_JAVA_HOME',
  'android.buildTimeoutMs': 'ANDROID_BUILD_TIMEOUT_MS',
  'android.maxErrorBlockChars': 'ANDROID_MAX_ERROR_BLOCK_CHARS',
  'android.maxLogTailChars': 'ANDROID_MAX_LOG_TAIL_CHARS',
} as const;

const FORBIDDEN_FIELDS = new Set([
  'version',
  'workspaces',
  'id',
  'rootDir',
  'port',
  'otherRootDirs',
  'rules',
  'MCP_ROOT_DIR',
  'MCP_PORT',
]);

const LINE_ENDINGS = new Set<ParsedLineEnding>(['auto', 'lf', 'crlf']);

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
  const lineEnding = readLineEndingOverride(options, env, validatedFields) ?? options.workspace.lineEnding;
  const logsDir = readLogsDirOverride(options, env, validatedFields);
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
  allowedFields: readonly string[],
): EnvOverrideField[] {
  return allowedFields.map((field, index) => {
    const fieldPath = allowedFieldPath(options, index);
    if (FORBIDDEN_FIELDS.has(field)) {
      fail(
        options,
        fieldPath,
        `envOverrides.allowedFields contains forbidden field "${field}". Boundary fields cannot be overridden by environment variables.`,
      );
    }

    if (!isEnvOverrideField(field)) {
      fail(
        options,
        fieldPath,
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

  fail(
    options,
    allowedFieldPath(options, androidFieldIndex),
    `envOverrides.allowedFields contains Android field "${allowedFields[androidFieldIndex]}", but workspaces[${options.workspaceIndex}].android is not configured. Android env overrides can only override an existing complete android config block.`,
  );
}

function readLineEndingOverride(
  options: ApplyEnvOverridesOptions,
  env: NodeJS.ProcessEnv,
  allowedFields: readonly EnvOverrideField[],
): ParsedLineEnding | undefined {
  if (!allowedFields.includes('lineEnding')) {
    return undefined;
  }

  const rawValue = readEnvValue(env, ALLOWED_FIELD_ENV_VARS.lineEnding);
  if (rawValue === undefined) {
    return undefined;
  }

  if (isLineEnding(rawValue)) {
    return rawValue;
  }

  fail(
    options,
    `${workspaceFieldPath(options)}.lineEnding`,
    `${ALLOWED_FIELD_ENV_VARS.lineEnding} must be one of: ${Array.from(LINE_ENDINGS).join(', ')}.`,
  );
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
      readStringOverride(env, allowedFields, 'android.workspaceRoot') ?? android.workspaceRoot,
    javaHome:
      readStringOverride(env, allowedFields, 'android.javaHome') ?? android.javaHome,
    buildTimeoutMs:
      readPositiveIntegerOverride(options, env, allowedFields, 'android.buildTimeoutMs') ?? android.buildTimeoutMs,
    maxErrorBlockChars:
      readPositiveIntegerOverride(options, env, allowedFields, 'android.maxErrorBlockChars') ?? android.maxErrorBlockChars,
    maxLogTailChars:
      readPositiveIntegerOverride(options, env, allowedFields, 'android.maxLogTailChars') ?? android.maxLogTailChars,
  };
}

function readLogsDirOverride(
  options: ApplyEnvOverridesOptions,
  env: NodeJS.ProcessEnv,
  allowedFields: readonly EnvOverrideField[],
): string | undefined {
  if (!allowedFields.includes('logsDir')) {
    return undefined;
  }

  const rawValue = readEnvValue(env, ALLOWED_FIELD_ENV_VARS.logsDir);
  if (rawValue === undefined) {
    return undefined;
  }

  try {
    return normalizeLogsDirPath(rawValue, ALLOWED_FIELD_ENV_VARS.logsDir);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    fail(options, `${workspaceFieldPath(options)}.logsDir`, message);
  }
}

function readStringOverride(
  env: NodeJS.ProcessEnv,
  allowedFields: readonly EnvOverrideField[],
  field: EnvOverrideField,
): string | undefined {
  if (!allowedFields.includes(field)) {
    return undefined;
  }

  return readEnvValue(env, ALLOWED_FIELD_ENV_VARS[field]);
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
  const rawValue = readEnvValue(env, envVar);
  if (rawValue === undefined) {
    return undefined;
  }

  const trimmed = rawValue.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    fail(
      options,
      `${workspaceFieldPath(options)}.${field}`,
      `${envVar} must be a positive integer.`,
    );
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(
      options,
      `${workspaceFieldPath(options)}.${field}`,
      `${envVar} must be a positive integer.`,
    );
  }

  return parsed;
}

function readEnvValue(env: NodeJS.ProcessEnv, envVar: string): string | undefined {
  const rawValue = env[envVar];
  if (rawValue === undefined || rawValue === '') {
    return undefined;
  }

  return rawValue;
}

function isEnvOverrideField(field: string): field is EnvOverrideField {
  return Object.prototype.hasOwnProperty.call(ALLOWED_FIELD_ENV_VARS, field);
}

function isLineEnding(value: string): value is ParsedLineEnding {
  return LINE_ENDINGS.has(value as ParsedLineEnding);
}

function workspaceFieldPath(options: ApplyEnvOverridesOptions): string {
  return `workspaces[${options.workspaceIndex}]`;
}

function allowedFieldPath(options: ApplyEnvOverridesOptions, index: number): string {
  return `${workspaceFieldPath(options)}.envOverrides.allowedFields[${index}]`;
}

function fail(
  options: ApplyEnvOverridesOptions,
  fieldPath: string,
  message: string,
): never {
  throw new ConfigError({
    code: 'config_validation_failed',
    configFilePath: options.configFilePath,
    fieldPath,
    message,
    suggestion: `Fix ${fieldPath} in ${options.configFilePath}, or remove that field from envOverrides.allowedFields.`,
  });
}
