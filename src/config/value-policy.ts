export interface ValuePolicyError {
  readonly fieldPath: string;
  readonly message: string;
}

export type ValuePolicyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ValuePolicyError };

export interface TypedStringOptions {
  readonly fieldPath: string;
}

export interface TokenOptions<T extends string> extends TypedStringOptions {
  readonly pattern?: RegExp;
  readonly allowedValues?: readonly T[];
  readonly description: string;
}

export interface PositiveIntegerOptions {
  readonly fieldPath: string;
  readonly max?: number;
  readonly rangeDescription?: string;
  readonly label?: string;
}

export interface FreeFormStringOptions {
  readonly fieldPath: string;
  readonly allowEmpty?: boolean;
}

export type LineEndingToken = 'auto' | 'lf' | 'crlf';

export const LINE_ENDING_VALUES = ['auto', 'lf', 'crlf'] as const satisfies readonly LineEndingToken[];
export const WORKSPACE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const WORKSPACE_ID_DESCRIPTION =
  '1-64 characters, start with a lowercase letter or digit, and contain only lowercase letters, digits, hyphens, or underscores';

export function readTypedString(
  value: unknown,
  options: TypedStringOptions,
): ValuePolicyResult<string> {
  if (typeof value !== 'string') {
    return fail(options.fieldPath, `${options.fieldPath} must be a string.`);
  }

  if (value.length === 0 || value.trim().length === 0) {
    return fail(options.fieldPath, `${options.fieldPath} must be a non-empty string.`);
  }

  if (value !== value.trim()) {
    return fail(
      options.fieldPath,
      `${options.fieldPath} must not contain leading or trailing whitespace.`,
    );
  }

  return ok(value);
}

export function readToken<T extends string>(
  value: unknown,
  options: TokenOptions<T>,
): ValuePolicyResult<T> {
  const stringResult = readTypedString(value, options);
  if (!stringResult.ok) return stringResult;

  const token = stringResult.value;
  if (options.allowedValues !== undefined) {
    if ((options.allowedValues as readonly string[]).includes(token)) {
      return ok(token as T);
    }
  } else if (options.pattern?.test(token)) {
    return ok(token as T);
  }

  return fail(options.fieldPath, `${options.fieldPath} must be ${options.description}.`);
}

export function readWorkspaceIdToken(
  value: unknown,
  options: TypedStringOptions,
): ValuePolicyResult<string> {
  return readToken(value, {
    ...options,
    pattern: WORKSPACE_ID_RE,
    description: WORKSPACE_ID_DESCRIPTION,
  });
}

export function readLineEndingToken(
  value: unknown,
  options: TypedStringOptions,
): ValuePolicyResult<LineEndingToken> {
  return readToken(value, {
    ...options,
    allowedValues: LINE_ENDING_VALUES,
    description: `one of: ${LINE_ENDING_VALUES.join(', ')}`,
  });
}

export function readJsonPositiveInteger(
  value: unknown,
  options: PositiveIntegerOptions,
): ValuePolicyResult<number> {
  if (typeof value !== 'number') {
    return fail(options.fieldPath, positiveIntegerMessage(options, 'JSON number positive integer'));
  }

  return validatePositiveInteger(value, options, 'JSON number positive integer');
}

export function readEnvPositiveInteger(
  value: unknown,
  options: PositiveIntegerOptions,
): ValuePolicyResult<number> {
  const stringResult = readTypedString(value, options);
  if (!stringResult.ok) return stringResult;

  if (!/^[1-9]\d*$/.test(stringResult.value)) {
    return fail(options.fieldPath, positiveIntegerMessage(options, 'positive integer'));
  }

  return validatePositiveInteger(Number(stringResult.value), options, 'positive integer');
}

export function readFreeFormString(
  value: unknown,
  options: FreeFormStringOptions,
): ValuePolicyResult<string> {
  if (typeof value !== 'string') {
    return fail(options.fieldPath, `${options.fieldPath} must be a string.`);
  }

  if (options.allowEmpty === false && value.length === 0) {
    return fail(options.fieldPath, `${options.fieldPath} must be a non-empty string.`);
  }

  return ok(value);
}

function validatePositiveInteger(
  value: number,
  options: PositiveIntegerOptions,
  kind: string,
): ValuePolicyResult<number> {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return fail(options.fieldPath, positiveIntegerMessage(options, kind));
  }

  if (options.max !== undefined && value > options.max) {
    return fail(options.fieldPath, positiveIntegerMessage(options, kind));
  }

  return ok(value);
}

function positiveIntegerMessage(
  options: PositiveIntegerOptions,
  kind: string,
): string {
  const label = options.label ?? options.fieldPath;
  return `${label} must be a ${kind}${describeRange(options)}.`;
}

function describeRange(options: PositiveIntegerOptions): string {
  return options.rangeDescription ? ` ${options.rangeDescription}` : '';
}

function ok<T>(value: T): ValuePolicyResult<T> {
  return { ok: true, value };
}

function fail(fieldPath: string, message: string): ValuePolicyResult<never> {
  return { ok: false, error: { fieldPath, message } };
}
