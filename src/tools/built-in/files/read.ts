import type { ToolRuntimeContext } from '../../../runtime/invocation/tool-context.js';
import type { ToolInvocationContext } from '../../../runtime/invocation/tool-invocation-context.js';
import {
  compileReadRange,
  selectTextRange,
  type ReadRangeOptions,
  type CompiledReadRange,
  type SelectedTextRange,
} from '../../../engine/read-range.js';
import {
  fileIdentityKey,
  selectReadableFiles,
  type SelectedReadableFile,
} from '../../../utils/file-selection.js';
import { mapWithWorkers } from '../../../utils/bounded-workers.js';
import { readTextFile, type TextFileResult } from '../../../utils/file-read.js';
import { textErrorResult } from '../../results.js';
import type { MCPTool, ToolCallResult } from '../../types.js';
import { READ_TOOL_DEFINITION, MAX_READ_REQUESTS, MAX_READ_WORKERS } from './read.definition.js';

interface LiteralReadRequest extends ReadRangeOptions {
  readonly file_path: string;
  readonly show_line_numbers?: boolean;
}

interface RequestSource {
  readonly includeIndex: number;
  readonly displayPath: string;
}

interface RequestFailure extends RequestSource {
  readonly ok: false;
  readonly reason: string;
  readonly denied: boolean;
}

interface PreparedRead extends RequestSource {
  readonly ok: true;
  readonly file: SelectedReadableFile;
  readonly range: CompiledReadRange;
  readonly showLineNumbers: boolean;
}

type PreparedRequest = PreparedRead | RequestFailure;
type ReadResult =
  (RequestSource & { readonly ok: true; readonly selected: SelectedTextRange }) | RequestFailure;

type SourceReader = (file: SelectedReadableFile, signal: AbortSignal) => Promise<TextFileResult>;

function requestLabel(source: RequestSource): string {
  return `include[${source.includeIndex}] ${source.displayPath}`;
}

function rangeLabel(selected: SelectedTextRange): string {
  return `lines ${selected.startLine}-${selected.endLine} of ${selected.totalLines}`;
}

function renderReadResult(
  results: readonly ReadResult[],
  shallow: boolean | number,
  limited: boolean,
  blockedByDeny: boolean,
  ignoredByPolicy: boolean,
): ToolCallResult {
  let totalLines = 0;
  let totalBytes = 0;
  let successCount = 0;
  for (const result of results) {
    if (result.ok) {
      totalLines += result.selected.lineCount;
      totalBytes += result.selected.bytes;
      successCount += 1;
    }
  }

  const includeBodies = shallow === false || (typeof shallow === 'number' && totalBytes <= shallow);
  const summary = [`Selected content: ${totalLines} lines, ${totalBytes} bytes.`];
  if (results.length > 0) {
    summary.push('Files:');
    for (const result of results) {
      summary.push(
        result.ok
          ? `- ${requestLabel(result)}: ${rangeLabel(result.selected)}, ${result.selected.lineCount} lines, ${result.selected.bytes} bytes.`
          : `- ${requestLabel(result)}: failed.`,
      );
    }
  }

  if (shallow !== false) {
    summary.push(
      typeof shallow === 'number'
        ? `Shallow read: successful bodies ${includeBodies ? 'included' : 'omitted'}; selected content ${includeBodies ? 'is within' : 'exceeds'} the ${shallow} bytes limit.`
        : 'Shallow read: successful bodies omitted.',
    );
  }
  if (limited) {
    summary.push(
      `Only the first ${MAX_READ_REQUESTS} final requests were processed. Use more specific selectors for a complete result.`,
    );
  }

  const notes: string[] = [];
  if (successCount > 0 && ignoredByPolicy) {
    notes.push('Some glob-discovered paths were filtered by configured ignoreFiles rules.');
  }
  if (
    (successCount > 0 && blockedByDeny) ||
    results.some((result) => !result.ok && result.denied)
  ) {
    notes.push('Some paths were blocked by the file access deny policy.');
  }
  if (notes.length > 0) {
    summary.push('Notes:', ...notes.map((note) => `- ${note}`));
  }

  const content: ToolCallResult['content'] = [{ type: 'text', text: `${summary.join('\n')}\n` }];
  for (const result of results) {
    if (result.ok) {
      if (includeBodies) {
        content.push({
          type: 'text',
          text: `--- ${requestLabel(result)}: ${rangeLabel(result.selected)} ---\n\n${result.selected.content}`,
        });
      }
    } else {
      content.push({
        type: 'text',
        text: `--- ${requestLabel(result)}: failed ---\n\n${result.reason}`,
      });
    }
  }
  return { content, isError: successCount === 0 };
}

/** Owns request identity, overrides, and limits; selection retains every input's provenance. */
async function read(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
  invocation: ToolInvocationContext,
  sourceReader: SourceReader = (file, signal) => readTextFile(file.readPath, signal),
): Promise<ToolCallResult> {
  const { signal } = invocation;
  try {
    signal.throwIfAborted();
    const include = args.include as (string | LiteralReadRequest)[];
    const selection = await selectReadableFiles({
      pathSelectors: include,
      discoveryExcludePatterns: (args.exclude as string[] | undefined) ?? [],
      respectIgnoreFiles: (args.use_ignore_files as boolean | undefined) ?? true,
      fileAccessPolicyContext: context.fileAccessPolicyContext,
      signal,
    });
    signal.throwIfAborted();

    // Determine overrides before semantic validation, even for objects beyond the limit.
    const overridden = new Set<string>();
    for (const entry of selection.entries) {
      if (entry.ok && typeof include[entry.includeIndex] !== 'string') {
        overridden.add(fileIdentityKey(entry.file.readPath));
      }
    }
    const seenDefaults = new Set<string>();
    const retained = selection.entries.filter((entry) => {
      if (!entry.ok || typeof include[entry.includeIndex] !== 'string') return true;
      const key = fileIdentityKey(entry.file.readPath);
      if (overridden.has(key) || seenDefaults.has(key)) return false;
      seenDefaults.add(key);
      return true;
    });
    const limited = retained.length > MAX_READ_REQUESTS;
    const requests: PreparedRequest[] = retained.slice(0, MAX_READ_REQUESTS).map((entry) => {
      if (!entry.ok) {
        return { ...entry, displayPath: entry.path };
      }
      const input = include[entry.includeIndex]!;
      const options = typeof input === 'string' ? undefined : input;
      const source = { includeIndex: entry.includeIndex, displayPath: entry.file.displayPath };
      const range = compileReadRange(options ?? {});
      if (!range.ok) {
        return { ...source, ok: false, reason: range.reason, denied: false };
      }
      return {
        ...source,
        ok: true,
        file: entry.file,
        range: range.value,
        showLineNumbers:
          options?.show_line_numbers ?? (args.show_line_numbers as boolean | undefined) ?? false,
      };
    });

    const filesByIdentity = new Map<string, SelectedReadableFile>();
    for (const request of requests) {
      if (request.ok) {
        const key = fileIdentityKey(request.file.readPath);
        if (!filesByIdentity.has(key)) filesByIdentity.set(key, request.file);
      }
    }
    const files = [...filesByIdentity.values()];
    const sources = await mapWithWorkers(files, MAX_READ_WORKERS, signal, (file) =>
      sourceReader(file, signal),
    );
    const sourceByIdentity = new Map(
      files.map((file, index) => [fileIdentityKey(file.readPath), sources[index]!]),
    );
    signal.throwIfAborted();

    const results: ReadResult[] = requests.map((request) => {
      if (!request.ok) return request;
      const source = sourceByIdentity.get(fileIdentityKey(request.file.readPath))!;
      const selected = source.ok
        ? selectTextRange(source.lines, request.range, request.showLineNumbers)
        : source;
      if (!selected.ok) {
        return { ...request, ok: false, reason: selected.reason, denied: false };
      }
      return { ...request, selected: selected.value };
    });
    signal.throwIfAborted();
    return renderReadResult(
      results,
      (args.shallow_read as boolean | number | undefined) ?? false,
      limited,
      selection.blockedByDeny,
      selection.ignoredByPolicy,
    );
  } catch {
    return textErrorResult(
      signal.aborted
        ? 'The read tool call was cancelled.'
        : 'Reading failed because of an unexpected internal error. Retry with narrower selectors.',
    );
  }
}

export const readInternalForTests = Object.freeze({ read });

const readTool: MCPTool = {
  definition: READ_TOOL_DEFINITION,
  handler: read,
};

export default readTool;
