export type StrictRequestHeaderValueState =
  { readonly kind: 'single'; readonly value: string } | { readonly kind: 'duplicate' };

export type StrictRequestHeaderView =
  | {
      readonly kind: 'valid';
      readonly headers: ReadonlyMap<string, StrictRequestHeaderValueState>;
    }
  | { readonly kind: 'invalid' };

export function createStrictRequestHeaderView(
  rawHeaders: readonly unknown[],
): StrictRequestHeaderView {
  if (rawHeaders.length % 2 !== 0) {
    return { kind: 'invalid' };
  }

  const headers = new Map<string, StrictRequestHeaderValueState>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];

    if (typeof name !== 'string' || typeof value !== 'string') {
      return { kind: 'invalid' };
    }

    const normalizedName = name.toLowerCase();
    const existing = headers.get(normalizedName);
    headers.set(
      normalizedName,
      existing === undefined ? { kind: 'single', value } : { kind: 'duplicate' },
    );
  }

  return { kind: 'valid', headers };
}
