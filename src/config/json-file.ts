import { ConfigError } from './errors.js';
import { readStrictUtf8RegularFile, StrictUtf8FileError } from './strict-utf8-file.js';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface ReadJsonFileOptions {
  /** Human-readable file kind used in startup diagnostics. */
  readonly label: string;
  /** Optional reference identity that should remain visible when the target file fails. */
  readonly referenceId?: string;
  /** Caller-specific recovery guidance for a missing file. */
  readonly notFoundSuggestion?: string;
}

/**
 * Reads and parses one strict UTF-8 JSON document from a regular file.
 */
export function readJsonFile(filePath: string, options: ReadJsonFileOptions): JsonValue {
  const subject =
    options.referenceId === undefined
      ? options.label
      : `${options.label} for definition reference "${options.referenceId}"`;

  let text: string;
  try {
    text = readStrictUtf8RegularFile(filePath);
  } catch (error: unknown) {
    if (!(error instanceof StrictUtf8FileError)) {
      throw error;
    }

    if (error.reason === 'not_found') {
      throw new ConfigError({
        code: 'config_file_not_found',
        configFilePath: filePath,
        message: `${subject} does not exist: ${filePath}`,
        suggestion:
          options.notFoundSuggestion ??
          'Create the referenced JSON file or correct its absolute path, then restart the server.',
        cause: error.cause,
      });
    }

    if (error.reason === 'not_regular') {
      throw new ConfigError({
        code: 'config_file_read_failed',
        configFilePath: filePath,
        message: `${subject} must be a regular file: ${filePath}`,
        suggestion: 'Point the configuration reference to a readable JSON file.',
        cause: error.cause,
      });
    }

    if (error.reason === 'invalid_utf8') {
      throw new ConfigError({
        code: 'config_file_read_failed',
        configFilePath: filePath,
        message: `${subject} must contain valid UTF-8 text: ${filePath}`,
        suggestion: 'Save the JSON file as UTF-8 and restart the server.',
        cause: error.cause,
      });
    }

    const causeMessage = error.cause instanceof Error ? error.cause.message : error.message;
    throw new ConfigError({
      code: 'config_file_read_failed',
      configFilePath: filePath,
      message: `Failed to read ${subject.toLowerCase()} at ${filePath}: ${causeMessage}`,
      suggestion:
        'Check that the file exists, is a regular file, and that the current user can read it.',
      cause: error.cause,
    });
  }

  try {
    return JSON.parse(text) as JsonValue;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError({
      code: 'config_json_invalid',
      configFilePath: filePath,
      message: `${subject} contains invalid JSON: ${message}`,
      suggestion: `Fix the JSON syntax in ${filePath} and restart the server.`,
      cause: error,
    });
  }
}
