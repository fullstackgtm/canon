export const SOCIAL_SOURCES = ["reddit", "x", "linkedin_posts", "hn", "jobs", "linkedin_jobs"] as const;
export type SocialSource = typeof SOCIAL_SOURCES[number];
export type SocialSearch = { source: SocialSource; query: string; limit: number };
export type SocialRow = { id: string; source: SocialSource; url: string; author: string; authorUrl: string; postedAt: string; text: string };
export const SOCIAL_MAX_QUERIES = 12;
export const SOCIAL_MAX_ROWS = 25;
export const SOCIAL_TEXT_MAX = 8000;
export const SOCIAL_MAX_USD: Record<SocialSource, number> = { reddit: 0.001, x: 0.00075, linkedin_posts: 0.002, hn: 0, jobs: 0, linkedin_jobs: 0.0286 };

export function socialSearchRequest(args: Record<string, unknown>): SocialSearch {
  if (Object.keys(args).some((k) => !["source", "query", "limit"].includes(k)) || !SOCIAL_SOURCES.includes(args.source as SocialSource) || typeof args.query !== "string" || !args.query.trim() || args.query.length > 500) throw new Error("Choose a social source and a query of at most 500 characters.");
  const limit = args.limit ?? SOCIAL_MAX_ROWS;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > SOCIAL_MAX_ROWS) throw new Error("A social search returns 1 to 25 rows.");
  return { source: args.source as SocialSource, query: args.query.trim(), limit: Number(limit) };
}
