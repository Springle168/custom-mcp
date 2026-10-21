import { isUtf8 } from 'node:buffer';
import { fileTypeFromBuffer } from 'file-type';

export type FileContentClassification =
  | { readonly kind: 'text' }
  | { readonly kind: 'image'; readonly format: 'png' | 'jpeg' | 'webp' }
  | { readonly kind: 'other' }
  | { readonly kind: 'unknown' };

/**
 * Classifies already-read complete bytes without I/O or filename heuristics.
 * Detection failures and cancellation propagate rather than granting text access.
 */
export async function classifyFileContent(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<FileContentClassification> {
  if (bytes.length === 0) {
    return { kind: 'text' };
  }

  const detected = await fileTypeFromBuffer(bytes, { signal });
  switch (detected?.mime) {
    case 'image/png':
      return { kind: 'image', format: 'png' };
    case 'image/jpeg':
      return { kind: 'image', format: 'jpeg' };
    case 'image/webp':
      return { kind: 'image', format: 'webp' };
  }

  if (isTextContent(bytes)) {
    return { kind: 'text' };
  }

  return { kind: detected ? 'other' : 'unknown' };
}

function isTextContent(bytes: Uint8Array): boolean {
  if (!isUtf8(bytes)) {
    return false;
  }

  let controlBytes = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      return false;
    }

    if (byte < 9 || (byte > 13 && byte < 32)) {
      controlBytes++;
    }
  }

  return controlBytes / bytes.length <= 0.3;
}
