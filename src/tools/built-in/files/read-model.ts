import type {
  CompiledReadRange,
  ReadRangeOptions,
  SelectedTextRange,
} from '../../../engine/read-range.js';
import type { SourceFileResult } from '../../../utils/file-read.js';
import type { SelectedReadableFile } from '../../../utils/file-selection.js';

export interface LiteralReadRequest extends ReadRangeOptions {
  readonly file_path: string;
  readonly show_line_numbers?: boolean;
}

export interface RequestSource {
  readonly includeIndex: number;
  readonly displayPath: string;
}

export interface RequestFailure extends RequestSource {
  readonly ok: false;
  readonly reason: string;
  readonly denied: boolean;
}

export interface PreparedRead extends RequestSource {
  readonly ok: true;
  readonly file: SelectedReadableFile;
  readonly range: CompiledReadRange;
  readonly showLineNumbers: boolean;
}

export type PreparedRequest = PreparedRead | RequestFailure;
export type SourceImage = Extract<SourceFileResult, { readonly kind: 'image' }>;

export interface TextReadResult extends RequestSource {
  readonly ok: true;
  readonly kind: 'text';
  readonly selected: SelectedTextRange;
}

export interface ImageReadResult extends RequestSource {
  readonly ok: true;
  readonly kind: 'image';
  readonly image: SourceImage;
}

export type ReadResult = TextReadResult | ImageReadResult | RequestFailure;

export type SourceReader = (
  file: SelectedReadableFile,
  signal: AbortSignal,
) => Promise<SourceFileResult>;
