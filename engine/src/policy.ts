import type { GtmPolicy } from "./types.ts";

/**
 * Overlay config policy values onto a base policy; defined values win. Pure, with no Node imports, so Convex's default
 * runtime merges a workspace's hygiene settings through it too (convex/lib/hygienePolicy.ts).
 */
export function mergePolicy(base: GtmPolicy, config?: { policy?: Partial<GtmPolicy> }): GtmPolicy {
  if (!config?.policy) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(config.policy)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}
