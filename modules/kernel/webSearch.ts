export type WebSearchRequest = { queries: string[] };
export type WebSearchRow = { id: string; url: string; title: string; query: string; text: string };

export function webSearchRequest(args: Record<string, unknown>): WebSearchRequest {
  if (Object.keys(args).some((k) => k !== "queries") || !Array.isArray(args.queries) || args.queries.length < 1 || args.queries.length > 4 || args.queries.some((q) => typeof q !== "string" || !q.trim() || q.length > 200)) throw new Error("web.search requires 1 to 4 nonempty queries, each at most 200 characters.");
  return { queries: [...new Set(args.queries.map((q: string) => q.trim()))] };
}
