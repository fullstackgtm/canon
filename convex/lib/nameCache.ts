/**
 * The shared company-name cache's rule (companyNames table): a cached name is
 * used, a recent miss (every resolver tried and failed) is skipped, and an
 * old miss is looked up again in case a resolver has learned the company.
 */
export const NAME_MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type CachedName = { domain: string; name: string; linkedinUrl?: string } | { domain: string; miss: true };

export function cacheAnswer(
  row: { domain: string; name?: string; linkedinUrl?: string; updatedAt: number } | null,
  now: number,
): CachedName | null {
  if (!row) return null;
  if (row.name) return { domain: row.domain, name: row.name, ...(row.linkedinUrl ? { linkedinUrl: row.linkedinUrl } : {}) };
  return now - row.updatedAt < NAME_MISS_TTL_MS ? { domain: row.domain, miss: true } : null;
}
