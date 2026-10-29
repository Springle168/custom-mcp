import type { SelectedTextRange } from '../../../engine/read-range.js';
import type { ToolCallResult } from '../../types.js';
import { MAX_READ_REQUESTS } from './read.definition.js';
import type { ReadResult, RequestSource, SourceImage } from './read-model.js';

const IMAGE_MIME_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
} as const satisfies Record<SourceImage['format'], string>;

function requestLabel(source: RequestSource): string {
  return `include[${source.includeIndex}] ${source.displayPath}`;
}

function rangeLabel(selected: SelectedTextRange): string {
  return `lines ${selected.startLine}-${selected.endLine} of ${selected.totalLines}`;
}

function escapeAttribute(value: string): string {
  const escapes: Record<string, string> = {
    '&': '&amp;',
    '"': '&quot;',
    '<': '&lt;',
    '>': '&gt;',
    '\r': '&#13;',
    '\n': '&#10;',
    '\t': '&#9;',
  };
  return value.replace(/[&"<>\r\n\t]/g, (character) => escapes[character]!);
}

/** Renders ordered semantic results without I/O or runtime policy decisions. */
export function renderReadResult(
  results: readonly ReadResult[],
  shallow: boolean | number,
  limited: boolean,
  blockedByDeny: boolean,
  ignoredByPolicy: boolean,
): ToolCallResult {
  let totalLines = 0;
  let totalBytes = 0;
  let successCount = 0;
  let imageCount = 0;
  for (const result of results) {
    if (!result.ok) continue;
    successCount += 1;
    if (result.kind === 'text') {
      totalLines += result.selected.lineCount;
      totalBytes += result.selected.bytes;
    } else {
      imageCount += 1;
    }
  }

  const includeBodies = shallow === false || (typeof shallow === 'number' && totalBytes <= shallow);
  const summary = [`Selected content: ${totalLines} lines, ${totalBytes} bytes.`];
  if (imageCount > 0) {
    summary.push('Image content is not included in line or byte statistics.');
  }
  if (results.length > 0) {
    summary.push('Files:');
    for (const result of results) {
      if (!result.ok) {
        summary.push(`- ${requestLabel(result)}: failed.`);
      } else if (result.kind === 'image') {
        summary.push(`- ${requestLabel(result)}`);
      } else {
        summary.push(
          `- ${requestLabel(result)}: ${rangeLabel(result.selected)}, ${result.selected.lineCount} lines, ${result.selected.bytes} bytes.`,
        );
      }
    }
  }

  if (shallow !== false) {
    summary.push(
      typeof shallow === 'number'
        ? `Shallow read: successful bodies ${includeBodies ? 'included' : 'omitted'}; ${imageCount > 0 ? 'successful text body size' : 'selected content'} ${includeBodies ? 'is within' : 'exceeds'} the ${shallow} bytes limit.`
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
  // Encoding is output work: omitted bodies neither allocate a cache nor encode bytes.
  const encodedImages = includeBodies ? new Map<SourceImage, string>() : undefined;
  for (const result of results) {
    if (!result.ok) {
      content.push({
        type: 'text',
        text: `--- ${requestLabel(result)}: failed ---\n\n${result.reason}`,
      });
      continue;
    }
    if (!includeBodies) continue;

    if (result.kind === 'text') {
      content.push({
        type: 'text',
        text: `--- ${requestLabel(result)}: ${rangeLabel(result.selected)} ---\n\n${result.selected.content}`,
      });
    } else {
      const { image } = result;
      let data = encodedImages!.get(image);
      if (data === undefined) {
        data = image.bytes.toString('base64');
        encodedImages!.set(image, data);
      }
      const mimeType = IMAGE_MIME_TYPES[image.format];
      content.push(
        {
          type: 'text',
          text: `<image path="${escapeAttribute(result.displayPath)}" include_index="${result.includeIndex}" mime_type="${mimeType}">`,
        },
        { type: 'image', data, mimeType },
        { type: 'text', text: '</image>' },
      );
    }
  }
  return { content, isError: successCount === 0 };
}
