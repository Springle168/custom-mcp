import {
  Ajv2020,
  type ErrorObject,
  type SchemaObject,
} from 'ajv/dist/2020.js';

export interface InputSchemaValidationIssue {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type InputSchemaValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly errors: readonly InputSchemaValidationIssue[];
    };

export interface InputSchemaValidator {
  /** Validates synchronously without coercing, defaulting, or removing input values. */
  validate(value: unknown): InputSchemaValidationResult;
}

export class InputSchemaCompilationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'InputSchemaCompilationError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: cause,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }
}

const VALID_RESULT = Object.freeze({ valid: true as const });

/**
 * Compiles one Draft 2020-12 schema in its own resolver context. No schemas are
 * shared between calls, so references must resolve within this document.
 */
export function compileInputSchemaValidator(
  schema: Readonly<Record<string, unknown>>,
): InputSchemaValidator {
  try {
    const ajv = new Ajv2020({
      strict: false,
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
      validateFormats: false,
    });
    const compiled = ajv.compile(schema as SchemaObject);

    if ('$async' in compiled && compiled.$async === true) {
      throw new InputSchemaCompilationError(
        'Asynchronous JSON Schema validation is not supported for tool input schemas.',
      );
    }

    return Object.freeze({
      validate(value: unknown): InputSchemaValidationResult {
        if (compiled(value)) {
          return VALID_RESULT;
        }

        // Ajv updates `errors` on every invocation. Copy it before returning so
        // a later call cannot mutate an earlier validation result.
        const errors = Object.freeze(
          (compiled.errors ?? [fallbackValidationError()]).map(copyValidationIssue),
        );
        return Object.freeze({ valid: false as const, errors });
      },
    });
  } catch (error: unknown) {
    if (error instanceof InputSchemaCompilationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new InputSchemaCompilationError(
      `Failed to compile JSON Schema Draft 2020-12 input schema: ${message}`,
      error,
    );
  }
}

function copyValidationIssue(error: ErrorObject): InputSchemaValidationIssue {
  return Object.freeze({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? 'Input does not satisfy the configured schema.',
    params: freezeObjectCopy(error.params),
  });
}

function fallbackValidationError(): ErrorObject {
  return {
    instancePath: '',
    schemaPath: '',
    keyword: 'validation',
    params: {},
    message: 'Input does not satisfy the configured schema.',
  };
}

function freezeObjectCopy(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const copy: Record<string, unknown> = {};
  for (const [key, propertyValue] of Object.entries(value)) {
    copy[key] = freezeValueCopy(propertyValue);
  }
  return Object.freeze(copy);
}

function freezeValueCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeValueCopy));
  }
  if (typeof value === 'object' && value !== null) {
    return freezeObjectCopy(value as Readonly<Record<string, unknown>>);
  }
  return value;
}
