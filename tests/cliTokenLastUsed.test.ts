/**
 * A paired token's last-used time is written at most once a minute: every API, MCP and CLI request resolves the
 * token, and a write per request turned each read into a write that parallel requests conflicted on.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

let now = Date.UTC(2026, 10, 10, 12);
const M = loadConvex(["agentIdentity.ts", "agentIdentityData.ts", "cliAuth.ts", "agentAuth.ts"], {}, { Date: class extends Date { static now() { return now; } } });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TOKEN = "fsgtm_paired", AGENT = "fsgtm_agent_reader";

const db = memoryDb({
  organizations: [{ _id: "org", name: "Acme", clerkOrgId: "org_acme" }],
  users: [{ _id: "ada", orgId: "org", clerkUserId: "user_ada", role: "admin", isActive: true }],
  cliTokens: [{ _id: "token", orgId: "org", userId: "ada", tokenHash: sha(TOKEN), createdAt: 0 }],
  agentRegistrations: [{ _id: "agent", name: "Reader", scopes: ["read"], tokenHash: sha(AGENT), expiresAt: now + 86_400_000, createdAt: 0 }],
});
const writes: string[] = [];
const patch = db.patch;
db.patch = async (id, doc) => { writes.push(id); return patch(id, doc); };
const run = (ref: unknown, args: unknown) => {
  const [file, name] = String(ref).split(".").slice(1);
  return M[`${file}.ts`]![name!]!.handler(ctx, args);
};
const ctx = { db, runQuery: run, runMutation: run };

test("requests with one token write its last-used time once a minute, not once each", async () => {
  const resolve = () => M["agentIdentity.ts"]!.resolveCliToken!.handler(ctx, { cliToken: TOKEN });
  const validate = () => M["agentAuth.ts"]!.validate!.handler(ctx, { tokenHash: sha(AGENT) });
  const first = now;
  assert.deepEqual({ ...await resolve() }, { clerkUserId: "user_ada", clerkOrgId: "org_acme" });
  await Promise.all(Array.from({ length: 49 }, resolve));
  await Promise.all(Array.from({ length: 50 }, validate));
  assert.deepEqual(writes, ["token", "agent"]);
  now += 59_999;
  await resolve(); await validate();
  assert.equal(writes.length, 2);
  now += 1;
  await resolve(); await validate();
  assert.deepEqual(writes, ["token", "agent", "token", "agent"]);
  assert.equal((await db.get("token"))!.lastUsedAt, first + 60_000);
});
