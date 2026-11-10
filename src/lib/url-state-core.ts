// Pure parse/serialize helpers behind `useUrlState`. Kept free of React and
// Next imports so they can be unit-tested with plain Node.

export type UrlStateShape = Record<string, string | undefined>;

/** Read each default key from the query string, falling back to the default. */
export function parseUrlState<T extends UrlStateShape>(
  params: { get(key: string): string | null },
  defaults: T,
): T {
  const out: UrlStateShape = {};
  for (const key of Object.keys(defaults)) {
    const raw = params.get(key);
    out[key] = raw === null ? defaults[key] : raw;
  }
  return out as T;
}

/**
 * Apply a patch to the current query string. Keys equal to their default,
 * empty, or undefined are removed so URLs stay short; unrelated params are
 * preserved. Returns the query string without a leading "?".
 */
export function serializeUrlState<T extends UrlStateShape>(
  current: string,
  defaults: T,
  patch: Partial<T>,
): string {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === "" || value === defaults[key]) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  return next.toString();
}
