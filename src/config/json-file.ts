import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { ConfigError } from './errors.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface ReadJsonFileOptions {
  /** Human-readable file kind used in startup diagnostics. */
  readonly label: string;
  /** Optional reference identity that should remain visible when the target file fails. */
  readonly referenceId?: string;
}

/**
 * Reads one JSON document through an opened file descriptor so the regular-file
 * check applies to the target that is actually read, including through symlinks.
 */
export function readJsonFile(
  filePath: string,
  options: ReadJsonFileOptions,
): JsonValue {
  const subject = options.referenceId === undefined
    ? options.label
    : `${options.label} for definition reference "${options.referenceId}"`;

  let fileDescriptor: number | undefined;
  let raw: Buffer;
  try {
    fileDescriptor = openSync(filePath, 'r');
    if (!fstatSync(fileDescriptor).isFile()) {
      throw new ConfigError({
        code: 'config_file_read_failed',
        configFilePath: filePath,
        message: `${subject} must be a regular file: ${filePath}`,
        suggestion: 'Point the configuration reference to a readable JSON file.',
      });
    }
    raw = readFileSync(fileDescriptor);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      throw error;
    }

    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === 'ENOENT') {
      throw new ConfigError({
        code: 'config_file_not_found',
        configFilePath: filePath,
        message: `${subject} does not exist: ${filePath}`,
        suggestion: 'Create the referenced JSON file or correct its absolute path, then restart the server.',
        cause: error,
      });
    }

    throw new ConfigError({
      code: 'config_file_read_failed',
      configFilePath: filePath,
      message: `Failed to read ${subject.toLowerCase()} at ${filePath}: ${fileError.message}`,
      suggestion: 'Check that the file exists, is a regular file, and that the current user can read it.',
      cause: error,
    });
  } finally {
    if (fileDescriptor !== undefined) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // The read result or primary read error is more actionable than a close failure.
      }
    }
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch (error: unknown) {
    throw new ConfigError({
      code: 'config_file_read_failed',
      configFilePath: filePath,
      message: `${subject} must contain valid UTF-8 text: ${filePath}`,
      suggestion: 'Save the JSON file as UTF-8 and restart the server.',
      cause: error,
    });
  }

  // TextDecoder normally consumes a leading UTF-8 BOM; stripping U+FEFF here
  // makes the accepted BOM behavior explicit across supported Node versions.
  if (text.startsWith('\uFEFF')) {
    text = text.slice(1);
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
