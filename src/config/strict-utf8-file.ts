import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

export type StrictUtf8FileErrorReason =
  'not_found' | 'not_regular' | 'open_failed' | 'inspect_failed' | 'read_failed' | 'invalid_utf8';

export class StrictUtf8FileError extends Error {
  readonly reason: StrictUtf8FileErrorReason;

  constructor(reason: StrictUtf8FileErrorReason, filePath: string, cause?: unknown) {
    super(messageForReason(reason, filePath));
    this.name = 'StrictUtf8FileError';
    this.reason = reason;

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

/**
 * Reads strict UTF-8 text from one opened regular file. Non-blocking open flags
 * prevent a POSIX FIFO from waiting for a writer before fstat can reject it.
 */
export function readStrictUtf8RegularFile(filePath: string): string {
  const bytes = readRegularFile(filePath);

  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch (error: unknown) {
    throw new StrictUtf8FileError('invalid_utf8', filePath, error);
  }
}

function readRegularFile(filePath: string): Buffer {
  let fileDescriptor: number;
  try {
    fileDescriptor = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error: unknown) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code === 'ENOENT') {
      throw new StrictUtf8FileError('not_found', filePath, error);
    }
    if (fileError.code === 'EISDIR') {
      throw new StrictUtf8FileError('not_regular', filePath, error);
    }
    throw new StrictUtf8FileError('open_failed', filePath, error);
  }

  try {
    let isRegularFile: boolean;
    try {
      isRegularFile = fstatSync(fileDescriptor).isFile();
    } catch (error: unknown) {
      throw new StrictUtf8FileError('inspect_failed', filePath, error);
    }

    if (!isRegularFile) {
      throw new StrictUtf8FileError('not_regular', filePath);
    }

    try {
      return readFileSync(fileDescriptor);
    } catch (error: unknown) {
      throw new StrictUtf8FileError('read_failed', filePath, error);
    }
  } finally {
    try {
      closeSync(fileDescriptor);
    } catch {
      // A primary read or validation failure is more actionable than close failure.
    }
  }
}

function messageForReason(reason: StrictUtf8FileErrorReason, filePath: string): string {
  switch (reason) {
    case 'not_found':
      return `File does not exist: ${filePath}`;
    case 'not_regular':
      return `File target is not a regular file: ${filePath}`;
    case 'open_failed':
      return `Failed to open file: ${filePath}`;
    case 'inspect_failed':
      return `Failed to inspect opened file: ${filePath}`;
    case 'read_failed':
      return `Failed to read opened file: ${filePath}`;
    case 'invalid_utf8':
      return `File does not contain valid UTF-8 text: ${filePath}`;
  }
}
