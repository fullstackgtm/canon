export type RateBucket = { windowStart: number; count: number };
export function rateLimitHit(bucket: RateBucket | null, now: number, rule: { limit: number; windowMs: number }): { allowed: boolean; next: RateBucket } {
  if (!bucket || now - bucket.windowStart >= rule.windowMs) return { allowed: true, next: { windowStart: now, count: 1 } };
  if (bucket.count >= rule.limit) return { allowed: false, next: bucket };
  return { allowed: true, next: { windowStart: bucket.windowStart, count: bucket.count + 1 } };
}

