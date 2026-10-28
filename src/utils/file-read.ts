import * as fs from 'node:fs/promises';
import { classifyFileContent } from '../engine/file-content.js';
import { fileSystemErrorReason } from './file-system-errors.js';

/** Maximum source file size in MiB, including for range reads. */
export const MAX_FILE_SIZE_MB = 20;

export type TextFileResult =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Loads and classifies one complete source for all requests in a call. Only
 * admitted text is decoded; ranges reuse the same validated bytes as lines.
 * The caller supplies a real path approved by the file access policy.
 */
export async function readTextFile(
  filePath: string,
  signal: AbortSignal,
  classify: typeof classifyFileContent = classifyFileContent,
): Promise<TextFileResult> {
  signal.throwIfAborted();
  let bytes: Buffer;
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return { ok: false, reason: 'not a regular file' };
    }
    if (stats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      return { ok: false, reason: `exceeds ${MAX_FILE_SIZE_MB} MiB size limit` };
    }
    signal.throwIfAborted();
    bytes = await fs.readFile(filePath, { signal });
  } catch (error: unknown) {
    signal.throwIfAborted();
    return { ok: false, reason: fileSystemErrorReason(error) };
  }

  try {
    signal.throwIfAborted();
    const classification = await classify(bytes, signal);
    signal.throwIfAborted();
    switch (classification.kind) {
      case 'text':
        return { ok: true, lines: bytes.toString('utf8').split(/\r?\n/) };
      case 'image':
        return {
          ok: false,
          reason: `image reading is not supported (${classification.format})`,
        };
      case 'other':
        return { ok: false, reason: 'non-text file (recognized binary format)' };
      case 'unknown':
        return { ok: false, reason: 'non-text file (unknown binary content)' };
    }
  } catch {
    signal.throwIfAborted();
    return { ok: false, reason: 'file content could not be classified' };
  }
}
