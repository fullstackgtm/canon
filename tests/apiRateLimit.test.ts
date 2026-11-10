import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { limitsFrom, rateHeaders, RateLimiter } from "../src/app/api/v1/_rateLimit.ts";

test("a token is refused past its budget until the window resets, and a refused request spends nothing", () => {
  const limiter = new RateLimiter(60_000);
  const scopes = [{ key: "token:a:read", limit: 3 }, { key: "workspace:w:read", limit: 100 }];
  assert.deepEqual([0, 1, 2].map((t) => limiter.admit(scopes, t).remaining), [2, 1, 0]);
  const refused = limiter.admit(scopes, 30_000);
  assert.deepEqual(refused, { allowed: false, limit: 3, remaining: 0, resetSeconds: 30 });
  assert.equal(limiter.exhausted("token:a:read", 3, 30_000), true);
  assert.deepEqual(rateHeaders(refused), { "RateLimit-Limit": "3", "RateLimit-Remaining": "0", "RateLimit-Reset": "30", "Retry-After": "30" });
  // The workspace was not charged for the refused request: 3 of 100 used.
  assert.equal(limiter.admit([{ key: "workspace:w:read", limit: 100 }], 30_000).remaining, 96);
  assert.equal(limiter.admit(scopes, 60_000).allowed, true);
});

test("tokens in one workspace share its ceiling; reads and writes are separate budgets", () => {
  const limiter = new RateLimiter(60_000);
  const req = (token: string, kind: string) => limiter.admit([{ key: `token:${token}:${kind}`, limit: 3 }, { key: `workspace:w:${kind}`, limit: 4 }], 1);
  assert.deepEqual([req("a", "read"), req("a", "read"), req("a", "read"), req("b", "read"), req("b", "read")].map((d) => d.allowed), [true, true, true, true, false]);
  assert.equal(req("b", "read").limit, 4);
  assert.equal(req("a", "write").allowed, true);
});

test("limits come from the deployment's variables: 0 turns one off, anything unreadable keeps the default", () => {
  const limits = limitsFrom({ CANON_API_TOKEN_READS_PER_MINUTE: "2000", CANON_API_TOKEN_WRITES_PER_MINUTE: "0", CANON_API_WORKSPACE_READS_PER_MINUTE: "lots" });
  assert.deepEqual(limits.token, { read: 2000, write: Infinity });
  assert.deepEqual(limits.workspace, { read: 1200, write: 600 });
  assert.deepEqual(new RateLimiter(60_000).admit([{ key: "k", limit: Infinity }], 0), { allowed: true, limit: Infinity, remaining: Infinity, resetSeconds: 0 });
});

const V1 = join(import.meta.dirname, "../src/app/api/v1");
/** Routes that do not count against the record API's budgets, and why. */
const EXEMPT: Record<string, string> = {
  "[...path]": "answers 404 in the error envelope without calling Convex",
  "workspace/export": "an admin's one-hour export key drives long paged exports (canon workspace export); throttling them would fail a large workspace's export",
  "workspace/import": "an admin's one-hour import key drives long paged imports (canon workspace import), as export does",
};

test("every /api/v1 route counts against the rate limits through v1Route, or is exempt with a reason", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n === "route.ts" ? [join(dir, n)] : []));
  const bypass = files(V1).flatMap((file) => {
    const route = file.slice(V1.length + 1, -"/route.ts".length);
    const source = readFileSync(file, "utf8");
    const handlers = [...source.matchAll(/^export (?:const|async function) (GET|POST|PATCH|PUT|DELETE)\b(.*)$/gm)];
    // A re-exported handler is one of methodNotAllowed's 405 answers, or it bypasses the limits.
    const aliased = [...source.matchAll(/^export \{([^}]*)\}/gm)].flatMap(([, list]) => list!.split(",").map((x) => x.trim().split(/\s+as\s+/)))
      .filter(([local, method]) => method !== "OPTIONS" && local !== "deny").map(([, method]) => `${method} ${route}`);
    const unlimited = [...handlers.filter(([, , rest]) => !/^ = v1Route</.test(rest!)).map(([, method]) => `${method} ${route}`), ...aliased];
    return route in EXEMPT ? [] : unlimited;
  });
  assert.deepEqual(bypass, []);
  const routes = files(V1).map((file) => file.slice(V1.length + 1, -"/route.ts".length));
  assert.deepEqual(Object.keys(EXEMPT).filter((r) => !routes.includes(r)), [], "an exemption names a route that no longer exists");
});
