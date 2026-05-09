// src/utils/file-read.ts

import * as fs from 'node:fs/promises';
import { extname } from 'node:path';

// ================
// Constants
// ================

/** Maximum number of lines to include from a single text file. */
export const MAX_LINES_PER_FILE = 2000;

/** Maximum characters per line. Longer lines are truncated with a marker. */
export const MAX_LINE_LENGTH = 2000;

/** Maximum file size in megabytes. Larger files are skipped entirely. */
export const MAX_FILE_SIZE_MB = 20;

/**
 * Known text file extensions. Files with these extensions skip content-based
 * binary detection. Includes .ts/.mts/.cts which mime libraries misidentify
 * as MPEG transport stream.
 */
const TEXT_EXTENSIONS = new Set([
  // TypeScript / JavaScript
  '.ts', '.mts', '.cts', '.tsx',
  '.js', '.mjs', '.cjs', '.jsx',
  // JVM
  '.kt', '.kts', '.java', '.scala', '.groovy', '.gradle',
  // Systems
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
  '.cs', '.go', '.rs', '.swift',
  // Scripting
  '.py', '.rb', '.lua', '.pl', '.pm', '.php', '.r', '.dart',
  // Web
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  // Data / Config
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.xml', '.xsl', '.xslt', '.svg', '.plist',
  // Documentation
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.rst',
  // Shell
  '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1',
  // Build / Infra
  '.cmake', '.tf', '.hcl',
  // Query / Schema
  '.sql', '.graphql', '.gql', '.proto',
  // Misc
  '.lock', '.log', '.patch', '.diff',
]);

/**
 * Known binary file extensions. Exported so the tool layer can generate
 * glob exclude patterns from them.
 */
export const BINARY_EXTENSIONS = new Set([
  // Executables & Libraries
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.obj', '.o', '.a', '.lib', '.wasm',
  // JVM bytecode
  '.class', '.jar', '.war', '.ear',
  // Python bytecode
  '.pyc', '.pyo',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.rar', '.7z', '.xz',
  // Documents (binary formats)
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.odt', '.ods', '.odp', '.pdf',
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp',
  '.ico', '.tiff', '.tif', '.heic', '.heif', '.avif',
  // Audio
  '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma',
  // Video
  '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Database
  '.sqlite', '.db', '.dat',
  // Android
  '.apk', '.aab', '.dex',
]);

// ================
// Types
// ================

export interface TextFileContent {
  /** File content (after truncation if applicable). */
  content: string;
  /** Whether content was truncated by line count or line length limits. */
  isTruncated: boolean;
  /** Whether the selected line range excludes part of the file. */
  lineCountTruncated: boolean;
  /** Whether any returned line was shortened due to line length limits. */
  lineLengthTruncated: boolean;
  /** Total lines in the original file. */
  originalLineCount: number;
  /** Number of lines included in `content`. */
  linesRead: number;
  /** First original line number included in `content` (1-based). */
  startLine: number;
  /** Last original line number included in `content` (1-based). */
  endLine: number;
}

export interface ReadTextFileOptions {
  /** Optional 1-based line number to start reading from. */
  startLine?: number;
  /** Optional 1-based line number to end reading at, inclusive. */
  endLine?: number;
  /** Prefix each returned line with its original 1-based line number. */
  showLineNumbers?: boolean;
}

export type TextFileResult =
  | ({ ok: true } & TextFileContent)
  | { ok: false; reason: string };

// ================
// Binary Detection
// ================

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
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true; // null byte → binary
      if (buf[i] < 9 || (buf[i] > 13 && buf[i] < 32)) {
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

// ================
// Text File Reading
// ================

/**
 * Reads a text file with automatic truncation for large content.
 *
 * - Files exceeding {@link MAX_FILE_SIZE_MB} are rejected.
 * - Lines beyond {@link MAX_LINES_PER_FILE} are dropped.
 * - Individual lines longer than {@link MAX_LINE_LENGTH} are truncated with a marker.
 *
 * The caller should check {@link isBinaryFile} before calling this function.
 */
export async function readTextFile(
  filePath: string,
  options: ReadTextFileOptions = {},
): Promise<TextFileResult> {
  try {
    const stats = await fs.stat(filePath);

    if (stats.isDirectory()) {
      return { ok: false, reason: 'path is a directory' };
    }

    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > MAX_FILE_SIZE_MB) {
      return {
        ok: false,
        reason: `exceeds ${MAX_FILE_SIZE_MB}MB size limit (${sizeMB.toFixed(1)}MB)`,
      };
    }

    const raw = await fs.readFile(filePath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const originalLineCount = lines.length;

    let sliceStart = 0;
    let sliceEnd = originalLineCount;

    if (options.startLine !== undefined || options.endLine !== undefined) {
      sliceStart = options.startLine !== undefined ? options.startLine - 1 : 0;
      sliceEnd = options.endLine !== undefined
        ? Math.min(options.endLine, originalLineCount)
        : Math.min(sliceStart + MAX_LINES_PER_FILE, originalLineCount);
    } else {
      sliceEnd = Math.min(MAX_LINES_PER_FILE, originalLineCount);
    }

    const actualStart = Math.min(sliceStart, originalLineCount);
    const requestedEnd = Math.max(actualStart, sliceEnd);
    const actualEnd = Math.min(
      requestedEnd,
      actualStart + MAX_LINES_PER_FILE,
      originalLineCount,
    );
    const selectedLines = lines.slice(actualStart, actualEnd);
    const lineCountTruncated =
      actualStart > 0 || actualEnd < originalLineCount || actualEnd < requestedEnd;

    // Truncate long lines
    let lineLengthTruncated = false;
    const formattedLines = selectedLines.map((line, index) => {
      if (line.length > MAX_LINE_LENGTH) {
        lineLengthTruncated = true;
        line = line.substring(0, MAX_LINE_LENGTH) + '... [truncated]';
      }
      if (options.showLineNumbers === true) {
        return `${actualStart + index + 1}: ${line}`;
      }
      return line;
    });

    const linesRead = selectedLines.length;
    const startLine = linesRead > 0 ? actualStart + 1 : actualStart + 1;
    const endLine = linesRead > 0 ? actualStart + linesRead : actualStart;

    return {
      ok: true,
      content: formattedLines.join('\n'),
      isTruncated: lineCountTruncated || lineLengthTruncated,
      lineCountTruncated,
      lineLengthTruncated,
      originalLineCount,
      linesRead,
      startLine,
      endLine,
    };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return { ok: false, reason: 'file not found' };
    }
    return { ok: false, reason: error.message ?? String(err) };
  }
}
