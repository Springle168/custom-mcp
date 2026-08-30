import { isMap, isScalar, parseDocument } from 'yaml';

export const MAX_GUIDELINE_NAME_CODE_POINTS = 64;
export const MAX_GUIDELINE_DESCRIPTION_CODE_POINTS = 1024;

export interface GuidelineMetadata {
  readonly name: string;
  readonly description: string;
}

export function extractGuidelineFrontMatterSource(
  prefix: string,
  prefixContainsWholeFile: boolean,
): string | null {
  const text = prefix.startsWith('\uFEFF') ? prefix.slice(1) : prefix;
  let contentStart: number;

  if (text.startsWith('---\r\n')) {
    contentStart = 5;
  } else if (text.startsWith('---\n')) {
    contentStart = 4;
  } else {
    return null;
  }

  let lineStart = contentStart;
  while (lineStart < text.length) {
    const lineFeedIndex = text.indexOf('\n', lineStart);
    if (lineFeedIndex === -1) {
      if (
        prefixContainsWholeFile &&
        text.slice(lineStart) === '---'
      ) {
        return text.slice(contentStart, lineStart);
      }
      return null;
    }

    const lineEnd =
      lineFeedIndex > lineStart && text[lineFeedIndex - 1] === '\r'
        ? lineFeedIndex - 1
        : lineFeedIndex;
    if (text.slice(lineStart, lineEnd) === '---') {
      return text.slice(contentStart, lineStart);
    }
    lineStart = lineFeedIndex + 1;
  }

  return null;
}

function getDirectStringScalar(
  items: ReadonlyArray<{
    readonly key: unknown;
    readonly value: unknown;
  }>,
  fieldName: string,
): string | null {
  const pair = items.find(
    (item) =>
      isScalar(item.key) &&
      typeof item.key.value === 'string' &&
      item.key.value === fieldName,
  );
  if (!pair || !isScalar(pair.value) || typeof pair.value.value !== 'string') {
    return null;
  }
  return pair.value.value;
}

function isValidField(value: string, maxCodePoints: number): boolean {
  return value.trim().length > 0 && Array.from(value).length <= maxCodePoints;
}

/**
 * Extracts guideline metadata without converting the full YAML document to JS.
 * Alias nodes therefore cannot indirectly satisfy required scalar fields.
 */
export function parseGuidelineFrontMatter(
  prefix: string,
  prefixContainsWholeFile: boolean,
): GuidelineMetadata | null {
  const source = extractGuidelineFrontMatterSource(
    prefix,
    prefixContainsWholeFile,
  );
  if (source === null) {
    return null;
  }

  let document;
  try {
    document = parseDocument(source, {
      schema: 'core',
      strict: true,
      uniqueKeys: true,
      customTags: [],
      merge: false,
      resolveKnownTags: false,
      prettyErrors: false,
    });
  } catch {
    return null;
  }
  if (document.errors.length > 0 || !isMap(document.contents)) {
    return null;
  }

  const name = getDirectStringScalar(document.contents.items, 'name');
  const description = getDirectStringScalar(
    document.contents.items,
    'description',
  );
  if (
    name === null ||
    description === null ||
    !isValidField(name, MAX_GUIDELINE_NAME_CODE_POINTS) ||
    !isValidField(description, MAX_GUIDELINE_DESCRIPTION_CODE_POINTS)
  ) {
    return null;
  }

  return { name, description };
}
