/**
 * Clerk's membership and organization events, sent signed to the real `/clerk-webhook` handler (convex/http.ts) in
 * process. A member turned off in Canon stays off until a person in Canon turns them back on; Clerk turns back on only
 * a member Clerk turned off. Clerk deleting an organization turns its members off, revokes what Canon issued them
 * there, pauses its agents and rules, and deletes nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Webhook } from "svix";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const SECRET = `whsec_${Buffer.from("canon-clerk-webhook-test-secret").toString("base64")}`;
process.env.CLERK_WEBHOOK_SECRET = SECRET;

const ADA = { _id: "ada", orgId: "acme", clerkUserId: "user_ada", email: "ada@acme.test", name: "Ada", role: "admin", isActive: true };
const M = loadConvex(["http.ts", "users.ts", "organizations.ts", "clerkOrgDeletion.ts"], { "lib.ts": (real) => ({ ...real, requireUser: async () => ADA }) });

/** Enough reps that a deletion takes more than one page. */
const REPS = Array.from({ length: 30 }, (_, i) => `rep${i}`);

function workspace() {
  return memoryDb({
    organizations: [{ _id: "acme", name: "Acme", slug: "acme", clerkOrgId: "org_acme" }, { _id: "beta", name: "Beta", slug: "beta", clerkOrgId: "org_beta" }],
    users: [
      ADA,
      // Bo's home is Acme; Bo is also an admin of Beta.
      { _id: "bo", orgId: "acme", clerkUserId: "user_bo", email: "bo@acme.test", name: "Bo", role: "manager", isActive: true },
      { _id: "cy", orgId: "acme", clerkUserId: "user_cy", email: "cy@acme.test", name: "Cy", role: "rep", isActive: true },
      ...REPS.map((id) => ({ _id: id, orgId: "acme", clerkUserId: `user_${id}`, email: `${id}@acme.test`, name: id, role: "rep", isActive: true })),
    ],
    orgMemberships: [
      { _id: "m-ada", userId: "ada", orgId: "acme", role: "admin", isActive: true },
      { _id: "m-bo", userId: "bo", orgId: "acme", role: "manager", isActive: true },
      { _id: "m-bo-beta", userId: "bo", orgId: "beta", role: "admin", isActive: true },
      { _id: "m-cy", userId: "cy", orgId: "acme", role: "rep", isActive: true },
      ...REPS.map((id) => ({ _id: `m-${id}`, userId: id, orgId: "acme", role: "rep", isActive: true })),
    ],
    cliTokens: [
      { _id: "tok-bo-acme", orgId: "acme", userId: "bo", tokenHash: "a", createdAt: 0, expiresAt: Date.now() + 86_400_000 },
      { _id: "tok-bo-beta", orgId: "beta", userId: "bo", tokenHash: "b", createdAt: 0, expiresAt: Date.now() + 86_400_000 },
    ],
    agents: [{ _id: "agent-1", orgId: "acme", slug: "scout", label: "Scout", kind: "hosted", ownerUserId: "ada", ledgerKey: "agent:scout" }],
    automationRules: [{ _id: "rule-1", orgId: "acme", name: "Route", object: "deal", status: "active", createdBy: "ada" }],
    deals: [{ _id: "deal-1", orgId: "acme", name: "Kept" }],
  });
}

type Db = ReturnType<typeof workspace>;

/** POST one Clerk event to /clerk-webhook, signed as Clerk (svix) signs it, and run what it schedules. */
async function send(db: Db, type: string, data: Record<string, unknown>, signed = true): Promise<number> {
  const queue: Array<() => Promise<unknown>> = [];
  const mutationCtx = { db, scheduler: { runAfter: async (_ms: number, ref: unknown, args: unknown) => { queue.push(() => handlerOf(ref)(mutationCtx, args)); } } };
  const handlerOf = (ref: unknown) => {
    const [, file, name] = String(ref).split(".");
    return M[`${file}.ts` as "users.ts"]![name!]!.handler;
  };
  const ctx = { runMutation: (ref: unknown, args: unknown) => handlerOf(ref)(mutationCtx, args) };
  const body = JSON.stringify({ type, data });
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const now = new Date();
  const headers: Record<string, string> = { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(now.getTime() / 1000)) };
  headers["svix-signature"] = signed ? new Webhook(SECRET).sign(id, now, body) : "v1,bm90IGEgc2lnbmF0dXJl";
  const [handler] = (M["http.ts"]!.default as unknown as { lookup: (path: string, method: string) => [(c: unknown, r: Request) => Promise<Response>] }).lookup("/clerk-webhook", "POST");
  const response = await handler(ctx, new Request("https://convex.test/clerk-webhook", { method: "POST", headers, body }));
  while (queue.length) await queue.shift()!();
  return response.status;
}

const membership = (userId: string, role = "rep") => ({
  role: `org:${role === "admin" ? "admin" : "member"}`, organization: { id: "org_acme", name: "Acme", slug: "acme" },
  public_user_data: { user_id: `user_${userId}`, identifier: `${userId}@acme.test`, first_name: userId },
});
const active = async (db: Db, id: string) => [(await db.get(id))!.isActive, (await db.get(`m-${id}`))!.isActive];

test("a member turned off in Canon stays off through Clerk's events until a person in Canon turns them on", async () => {
  const db = workspace();
  const team = (isActive: boolean) => M["users.ts"]!.update!.handler({ db }, { userId: "cy", isActive });
  await team(false);
  assert.equal(await send(db, "organizationMembership.updated", membership("cy")), 200);
  assert.deepEqual(await active(db, "cy"), [false, false]);
  await team(true);
  assert.deepEqual(await active(db, "cy"), [true, true]);
});

test("a member Clerk turned off comes back on with Clerk's next membership event", async () => {
  const db = workspace();
  await send(db, "organizationMembership.deleted", membership("cy"));
  assert.deepEqual(await active(db, "cy"), [false, false]);
  await send(db, "organizationMembership.created", membership("cy"));
  assert.deepEqual(await active(db, "cy"), [true, true]);
});

test("Clerk deleting an organization turns its members off, revokes their credentials there, pauses its agents and rules and keeps its data", async () => {
  const db = workspace();
  assert.equal(await send(db, "organization.deleted", { id: "org_acme" }, false), 401);
  assert.equal((await db.get("m-ada"))!.isActive, true);
  assert.equal(await send(db, "organization.deleted", { id: "org_acme", deleted: true }), 200);
  for (const id of ["ada", "cy", ...REPS]) assert.deepEqual(await active(db, id), [false, false], id);
  // Bo keeps Beta, which becomes Bo's home.
  assert.deepEqual([(await db.get("m-bo"))!.isActive, (await db.get("m-bo-beta"))!.isActive, (await db.get("bo"))!.orgId, (await db.get("bo"))!.isActive], [false, true, "beta", true]);
  assert.deepEqual([Boolean((await db.get("tok-bo-acme"))!.revokedAt), Boolean((await db.get("tok-bo-beta"))!.revokedAt)], [true, false]);
  assert.equal(((await db.get("agent-1"))!.pause as { reason?: string } | undefined)?.reason, "owner_not_member");
  assert.equal((await db.get("rule-1"))!.status, "paused");
  assert.equal((await db.get("deal-1"))!.name, "Kept");
  // A late membership event brings nobody back to a deleted workspace, and lets nobody new in.
  await send(db, "organizationMembership.updated", membership("cy"));
  await send(db, "organizationMembership.created", membership("dee"));
  assert.deepEqual(await active(db, "cy"), [false, false]);
  assert.equal(db.rows("users").some((u) => u.clerkUserId === "user_dee"), false);
});
