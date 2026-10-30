import * as fs from 'node:fs/promises';
import { classifyFileContent, type FileContentClassification } from '../engine/file-content.js';
import { fileSystemErrorReason } from './file-system-errors.js';
import { MAX_FILE_SIZE_MB } from './file-read-policy.js';

export type SourceFileResult =
  | { readonly ok: true; readonly kind: 'text'; readonly lines: readonly string[] }
  | {
      readonly ok: true;
      readonly kind: 'image';
      readonly format: Extract<FileContentClassification, { kind: 'image' }>['format'];
      readonly bytes: Buffer;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Loads and classifies one complete source for all requests in a call. Only
 * admitted text is decoded; images retain the same classified source bytes.
 * The caller supplies a real path approved by the file access policy.
 */
export async function readSourceFile(
  filePath: string,
  signal: AbortSignal,
  classify: typeof classifyFileContent = classifyFileContent,
): Promise<SourceFileResult> {
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
    signal.throwIfAborted();
    // The source may grow after stat; oversized bytes must never reach classification.
    if (bytes.length > MAX_FILE_SIZE_MB * 1024 * 1024) {
      return { ok: false, reason: `exceeds ${MAX_FILE_SIZE_MB} MiB size limit` };
    }
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
        return { ok: true, kind: 'text', lines: bytes.toString('utf8').split(/\r?\n/) };
      case 'image':
        return {
          ok: true,
          kind: 'image',
          format: classification.format,
          bytes,
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
