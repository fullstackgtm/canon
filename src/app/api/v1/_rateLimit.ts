/**
 * Request budgets for the record API (docs/record-api.md, Rate limits) and the
 * MCP tools. Counted in this app process with the fixed window of
 * convex/lib/rateLimit.ts, so a request costs no Convex call or write: hosted
 * Canon runs one app container and self-hosting documents one replica, so the
 * process sees every request. A deployment that runs N app replicas allows up
 * to N times each budget.
 *
 * Two ceilings apply at once: the caller's token, and their workspace, so
 * many tokens in one workspace cannot multiply the allowance. Reads and writes
 * have separate budgets: a write appends to the ledger and waits for the
 * projector; a read is one record-service query.
 */
import { createHash } from "node:crypto";
import { rateLimitHit, type RateBucket } from "../../../../convex/lib/rateLimit.ts";

export type RateKind = "read" | "write";
export type RateLimits = { token: Record<RateKind, number>; workspace: Record<RateKind, number>; windowMs: number };

/** Requests per minute. Measured costs and the reasoning are in docs/record-api.md, Rate limits. */
export const DEFAULT_LIMITS: RateLimits = { token: { read: 600, write: 300 }, workspace: { read: 1200, write: 600 }, windowMs: 60_000 };

export const LIMIT_ENV = {
  token: { read: "CANON_API_TOKEN_READS_PER_MINUTE", write: "CANON_API_TOKEN_WRITES_PER_MINUTE" },
  workspace: { read: "CANON_API_WORKSPACE_READS_PER_MINUTE", write: "CANON_API_WORKSPACE_WRITES_PER_MINUTE" },
} as const;

/** The deployment's limits: each variable a whole number of requests per minute, `0` for no limit; anything else keeps the default. */
export function limitsFrom(env: Record<string, string | undefined>): RateLimits {
  const read = (scope: "token" | "workspace", kind: RateKind) => {
    const raw = env[LIMIT_ENV[scope][kind]]?.trim();
    if (!raw || !/^\d+$/.test(raw)) return DEFAULT_LIMITS[scope][kind];
    return Number(raw) === 0 ? Infinity : Number(raw);
  };
  return {
    token: { read: read("token", "read"), write: read("token", "write") },
    workspace: { read: read("workspace", "read"), write: read("workspace", "write") },
    windowMs: DEFAULT_LIMITS.windowMs,
  };
}

/** A key for a bearer token that does not keep the token itself in memory. */
export const tokenKey = (token: string) => `token:${createHash("sha256").update(token).digest("base64url").slice(0, 32)}`;

export type Scope = { key: string; limit: number };
export type Decision = { allowed: boolean; limit: number; remaining: number; resetSeconds: number };

const MAX_KEYS = 50_000;

export class RateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly windowMs: number;
  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** Whether every scope has room. Counted only when all do, so a refused request spends nothing. */
  admit(scopes: readonly Scope[], now: number): Decision {
    const bounded = scopes.filter((s) => Number.isFinite(s.limit));
    const steps = bounded.map((s) => ({ scope: s, ...rateLimitHit(this.buckets.get(s.key) ?? null, now, { limit: s.limit, windowMs: this.windowMs }) }));
    const blocked = steps.find((s) => !s.allowed);
    if (!blocked) for (const s of steps) this.buckets.set(s.scope.key, s.next);
    if (this.buckets.size > MAX_KEYS) this.sweep(now);
    // The headers describe the tightest scope: the one with the fewest requests left.
    const binding = blocked ?? [...steps].sort((a, b) => (a.scope.limit - a.next.count) - (b.scope.limit - b.next.count))[0];
    if (!binding) return { allowed: true, limit: Infinity, remaining: Infinity, resetSeconds: 0 };
    return {
      allowed: !blocked,
      limit: binding.scope.limit,
      remaining: Math.max(0, binding.scope.limit - binding.next.count),
      resetSeconds: Math.max(1, Math.ceil((binding.next.windowStart + this.windowMs - now) / 1000)),
    };
  }

  /** Whether `key` is already out of requests, without counting one: lets a runaway loop be refused before auth. */
  exhausted(key: string, limit: number, now: number): boolean {
    const b = this.buckets.get(key);
    return Number.isFinite(limit) && b !== undefined && now - b.windowStart < this.windowMs && b.count >= limit;
  }

  private sweep(now: number) {
    for (const [key, b] of this.buckets) if (now - b.windowStart >= this.windowMs) this.buckets.delete(key);
  }
}

/** The standard response headers for a decision (IETF RateLimit fields), and Retry-After when refused. */
export function rateHeaders(d: Decision): Record<string, string> {
  if (!Number.isFinite(d.limit)) return {};
  return {
    "RateLimit-Limit": String(d.limit),
    "RateLimit-Remaining": String(d.remaining),
    "RateLimit-Reset": String(d.resetSeconds),
    ...(d.allowed ? {} : { "Retry-After": String(d.resetSeconds) }),
  };
}

/** This process's limiter, shared by the record API and the MCP tools so one token has one budget across both. */
export const apiLimiter = new RateLimiter(DEFAULT_LIMITS.windowMs);
