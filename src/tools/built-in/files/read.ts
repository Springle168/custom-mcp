import type { ToolRuntimeContext } from '../../../runtime/invocation/tool-context.js';
import type { ToolInvocationContext } from '../../../runtime/invocation/tool-invocation-context.js';
import { compileReadRange, selectTextRange } from '../../../engine/read-range.js';
import {
  fileIdentityKey,
  selectReadableFiles,
  type SelectedReadableFile,
} from '../../../utils/file-selection.js';
import { mapWithWorkers } from '../../../utils/bounded-workers.js';
import { readSourceFile } from '../../../utils/file-read.js';
import { FILE_READ_CONCURRENCY } from '../../../utils/file-read-policy.js';
import { textErrorResult } from '../../results.js';
import type { MCPTool, ToolCallResult } from '../../types.js';
import { READ_TOOL_DEFINITION } from './read.definition.js';
import { MAX_READ_REQUESTS } from './read.limits.js';
import type {
  LiteralReadRequest,
  PreparedRequest,
  ReadResult,
  SourceReader,
} from './read-model.js';
import { renderReadResult } from './read-result.js';

/** Owns request identity, overrides, and limits; selection retains every input's provenance. */
async function read(
  args: Record<string, unknown>,
  context: ToolRuntimeContext,
  invocation: ToolInvocationContext,
  sourceReader: SourceReader = (file, signal) => readSourceFile(file.readPath, signal),
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
    const sources = await mapWithWorkers(files, FILE_READ_CONCURRENCY, signal, (file) =>
      sourceReader(file, signal),
    );
    const sourceByIdentity = new Map(
      files.map((file, index) => [fileIdentityKey(file.readPath), sources[index]!]),
    );
    signal.throwIfAborted();

    const results: ReadResult[] = requests.map((request) => {
      if (!request.ok) return request;
      const provenance = {
        includeIndex: request.includeIndex,
        displayPath: request.displayPath,
      };
      const source = sourceByIdentity.get(fileIdentityKey(request.file.readPath))!;
      if (!source.ok) {
        return { ...provenance, ok: false, reason: source.reason, denied: false };
      }
      if (source.kind === 'image') {
        return { ...provenance, ok: true, kind: 'image', image: source };
      }
      const selected = selectTextRange(source.lines, request.range, request.showLineNumbers);
      if (!selected.ok) {
        return { ...provenance, ok: false, reason: selected.reason, denied: false };
      }
      return { ...provenance, ok: true, kind: 'text', selected: selected.value };
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
