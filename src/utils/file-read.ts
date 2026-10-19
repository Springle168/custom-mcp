import * as fs from 'node:fs/promises';
import { extname } from 'node:path';

/** Maximum source file size in MiB, including for range reads. */
export const MAX_FILE_SIZE_MB = 20;

/**
 * Known text file extensions. Files with these extensions skip content-based
 * binary detection. Includes .ts/.mts/.cts which mime libraries misidentify
 * as MPEG transport stream.
 */
const TEXT_EXTENSIONS = new Set([
  // TypeScript / JavaScript
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  // JVM
  '.kt',
  '.kts',
  '.java',
  '.scala',
  '.groovy',
  '.gradle',
  // Systems
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.hxx',
  '.cs',
  '.go',
  '.rs',
  '.swift',
  // Scripting
  '.py',
  '.rb',
  '.lua',
  '.pl',
  '.pm',
  '.php',
  '.r',
  '.dart',
  // Web
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.vue',
  '.svelte',
  // Data / Config
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
  '.xml',
  '.xsl',
  '.xslt',
  '.svg',
  '.plist',
  // Documentation
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.tsv',
  '.rst',
  // Shell
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.bat',
  '.cmd',
  '.ps1',
  // Build / Infra
  '.cmake',
  '.tf',
  '.hcl',
  // Query / Schema
  '.sql',
  '.graphql',
  '.gql',
  '.proto',
  // Misc
  '.lock',
  '.log',
  '.patch',
  '.diff',
]);

/** Known binary extensions are rejected without probing content. */
const BINARY_EXTENSIONS = new Set([
  // Executables & Libraries
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.obj',
  '.o',
  '.a',
  '.lib',
  '.wasm',
  // JVM bytecode
  '.class',
  '.jar',
  '.war',
  '.ear',
  // Python bytecode
  '.pyc',
  '.pyo',
  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.rar',
  '.7z',
  '.xz',
  // Documents (binary formats)
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.pdf',
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  '.ico',
  '.tiff',
  '.tif',
  '.heic',
  '.heif',
  '.avif',
  // Audio
  '.mp3',
  '.wav',
  '.flac',
  '.aac',
  '.ogg',
  '.m4a',
  '.wma',
  // Video
  '.mp4',
  '.avi',
  '.mkv',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  // Fonts
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  // Database
  '.sqlite',
  '.db',
  '.dat',
  // Android
  '.apk',
  '.aab',
  '.dex',
]);

export type TextFileResult =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Determines whether a file is likely binary.
 *
 * Two-layer strategy:
 * 1. Extension-based — known text extensions return false immediately,
 *    known binary extensions return true immediately.
 * 2. Content-based — reads up to 4 KB and checks for null bytes or a high
 *    ratio (>30%) of non-printable characters.
 *
 * Returns false on read errors so the caller can handle the failure itself.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  const ext = extname(filePath).toLowerCase();

  // Layer 1: extension fast path
  if (TEXT_EXTENSIONS.has(ext)) return false;
  if (BINARY_EXTENSIONS.has(ext)) return true;

  // Layer 2: content-based detection for unknown extensions
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(filePath, 'r');
    const stats = await fh.stat();
    if (stats.size === 0) return false;

    const sampleSize = Math.min(4096, stats.size);
    const buf = Buffer.alloc(sampleSize);
    const { bytesRead } = await fh.read(buf, 0, sampleSize, 0);
    if (bytesRead === 0) return false;

    let nonPrintableCount = 0;
    for (const byte of buf.subarray(0, bytesRead)) {
      if (byte === 0) return true; // null byte → binary
      if (byte < 9 || (byte > 13 && byte < 32)) {
        nonPrintableCount++;
      }
    }

    return nonPrintableCount / bytesRead > 0.3;
  } catch {
    return false;
  } finally {
    try {
      await fh?.close();
    } catch {
      /* ignore close errors */
    }
  }
}

/**
 * Loads one complete UTF-8 source for all requests in a call. Range selection and
 * formatting are pure operations on these lines, never a second content read.
 * The caller supplies a real path approved by the file access policy.
 */
export async function readTextFile(filePath: string, signal: AbortSignal): Promise<TextFileResult> {
  signal.throwIfAborted();
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return { ok: false, reason: 'not a regular file' };
    }
    if (stats.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      return { ok: false, reason: `exceeds ${MAX_FILE_SIZE_MB} MiB size limit` };
    }
    signal.throwIfAborted();
    if (await isBinaryFile(filePath)) {
      return { ok: false, reason: 'binary file' };
    }
    signal.throwIfAborted();
    const raw = await fs.readFile(filePath, { encoding: 'utf8', signal });
    signal.throwIfAborted();
    return { ok: true, lines: raw.split(/\r?\n/) };
  } catch (error: unknown) {
    signal.throwIfAborted();
    // A real path can differ from the caller's display path; do not echo OS paths.
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT'
        ? 'file not found'
        : code === 'EACCES' || code === 'EPERM'
          ? 'file access failed: permission denied'
          : 'file could not be read';
    return { ok: false, reason };
  }
}
