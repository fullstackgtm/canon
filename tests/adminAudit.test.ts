import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const admin = { _id: "u1", orgId: "o1", name: "Admin", role: "admin", isActive: true };
const modules = loadConvex(["adminAudit.ts"], { "lib.ts": real => ({ ...real, requireUser: async (ctx: { user: unknown }) => ctx.user, getCurrentUser: async (ctx: { user: unknown }) => ctx.user }), "lib/membership.ts": real => ({ ...real, activeRoleIn: async (_ctx: unknown, user: { orgId: string }, org: string) => user.orgId === org ? "admin" : null }) });
const audit = modules["adminAudit.ts"];
const opts = (cursor: string | null = null, numItems = 2) => ({ paginationOpts: { cursor, numItems } });

test("adminAudit merges native pages, scopes tenants, filters and omits sensitive fields", async () => {
  const db = memoryDb({ users: [admin, { _id: "foreign", orgId: "o2", name: "Private name" }],
    operationAuditLog: [
      { _id: "op1", orgId: "o1", userId: "u1", operation: "stop_sync", verb: "do", status: "applied", createdAt: 10, details: { token: "SECRET", body: "PRIVATE MESSAGE" } },
      { _id: "op2", orgId: "o2", operation: "foreign", createdAt: 40 },
    ],
    moduleEvents: [{ _id: "m1", orgId: "o1", at: 20, actor: { kind: "agent", userId: "u1", client: "Helper" }, verb: "approve", moduleId: "mod", collection: "items", key: "1", fields: ["state"], kind: "transition", args: { token: "SECRET" }, reason: "PRIVATE MESSAGE", evidence: { ip: "PRIVATE" } }],
    dataModelChanges: [{ _id: "d1", orgId: "o1", at: 30, userId: "foreign", kind: "field.created", object: "account", summary: "SECRET" }],
  });
  const ctx = { db, user: admin, runQuery: async (_ref: unknown, args: unknown) => audit.sourcePage.handler(ctx, args) };
  const first = await audit.list.handler(ctx, opts());
  assert.deepEqual(Array.from(first.page, (r: { id: string }) => r.id), ["d1", "m1"]);
  assert.equal(first.page[0].actor, "Former member");
  assert.match(first.page[1].actor, /Helper.*Admin/);
  const second = await audit.list.handler(ctx, opts(first.continueCursor));
  assert.deepEqual(Array.from(second.page, (r: { id: string }) => r.id), ["op1"]);
  assert.equal(second.isDone, true);
  const filtered = await audit.list.handler(ctx, { ...opts(null, 50), actorId: "u1", operation: "stop_sync", start: 10, end: 20 });
  assert.deepEqual(Array.from(filtered.page, (r: { id: string }) => r.id), ["op1"]);
  assert.doesNotMatch(JSON.stringify([first, second, filtered]), /SECRET|PRIVATE|Private name|foreign"/);
  for (const fn of [audit.list, audit.sourcePage]) await assert.rejects(() => fn.handler({ ...ctx, user: { ...admin, role: "rep" } }, { ...opts(), source: "operations" }));
  await assert.rejects(() => audit.list.handler(ctx, opts("[]")));
});

test("interleaved source cursors consume partial batches without gaps or duplicates", async () => {
  const db = memoryDb({ users: [admin],
    operationAuditLog: [1, 5, 9].map(at => ({ _id: `o${at}`, orgId: "o1", userId: "u1", createdAt: at, operation: "change", verb: "do", status: "applied" })),
    moduleEvents: [2, 6, 10].map(at => ({ _id: `m${at}`, orgId: "o1", at, actor: { kind: "system" }, verb: "update", moduleId: "mod", collection: "items", key: "1", fields: [], kind: "update" })),
    dataModelChanges: [3, 7, 11].map(at => ({ _id: `d${at}`, orgId: "o1", at, userId: "u1", kind: "field_created", object: "account" })),
  });
  const ctx = { db, user: admin, runQuery: async (_ref: unknown, args: unknown) => audit.sourcePage.handler(ctx, args) };
  let cursor = null;
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const page = await audit.list.handler(ctx, opts(cursor));
    rows.push(...page.page);
    cursor = page.continueCursor;
    assert.equal(page.isDone, i === 4);
  }
  assert.deepEqual(rows.map(r => r.at), [11, 10, 9, 7, 6, 5, 3, 2, 1]);
  assert.equal(new Set(rows.map(r => r.id)).size, 9);
});
