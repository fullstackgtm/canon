import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startApp } from "./helpers.ts";

describe("contact company predicate", () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;
  let ids: string[];
  const company = { scope: { field: "ownerId", owners: ["u"], unowned: false }, fields: ["fit", "icpIds"] };
  before(async () => {
    ctx = await startApp();
    const ws = ctx.client.ws("company");
    assert.equal((await ws.post("provision")).status, 200);
    const up = await ws.post("accounts/upsert", { records: ["mine", "peer", "empty", "deleted"].map((name) => ({ domain: `${name}.example`, name })), source: "test", idempotencyKey: "accounts" });
    assert.equal(up.status, 200);
    ids = up.json.ids;
    assert.equal((await ws.post("contacts/upsert", { records: ids.flatMap((accountId, i) => [0, 1].map((j) => ({ accountId, fullName: `Person ${i}-${j}`, email: `p${i}-${j}@example.com` }))), source: "test", idempotencyKey: "contacts" })).status, 200);
    await ctx.app.registry.with("company", (w) => w.write(async (c) => {
      await c.run("UPDATE accounts SET ownerId = CASE name WHEN 'mine' THEN 'u' WHEN 'peer' THEN 'other' ELSE NULL END, fit = CASE name WHEN 'mine' THEN 80 ELSE 99 END, icpIds = ['secret']");
      await c.run("UPDATE accounts SET deletedAt = 1 WHERE name = 'deleted'");
    }));
  });
  after(async () => { await ctx.app.shutdown(); });
  const post = async (body: unknown, route = "register/contact/list") => {
    const r = await ctx.client.ws("company").post(route, body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  };
  it("preserves legacy requests and masks inaccessible company cells", async () => {
    const request = { sort: { field: "accountFit", dir: "desc" }, limit: 2 };
    const old = await post(request);
    assert.equal(old.total, 8);
    assert.equal(old.rows[0].values.accountFit, 99);
    assert.equal(JSON.stringify(await post(request)), JSON.stringify(old));
    const masked = await post({ company });
    assert.equal(masked.total, 8);
    for (const row of masked.rows) assert.deepEqual([row.values.accountFit, row.values.accountIcpIds], row.accountId === ids[0] ? [80, ["secret"]] : [null, null]);
    assert.equal((await post({ company: { ...company, filter: [] } })).total, 2);
    const hidden = await post({ company: { ...company, fields: [] } });
    assert.ok(hidden.rows.every((r: any) => r.values.accountFit === null && r.values.accountIcpIds === null));
  });
  it("applies company scope before filters, sort, totals and paging", async () => {
    for (const filter of [
      [{ field: "accountFit", op: "gte", value: 80 }],
      [{ field: "accountFit", op: "neq", value: 99 }],
      [{ field: "accountIcpIds", op: "hasAny", value: ["secret"] }],
    ]) {
      const page = await post({ company, filter, limit: 1 });
      assert.equal(page.total, 2);
      assert.equal(page.rows[0].accountId, ids[0]);
      const next = await post({ company, filter, limit: 1, cursor: page.nextCursor });
      assert.equal(next.total, 2);
      assert.equal(next.rows[0].accountId, ids[0]);
      assert.notEqual(page.rows[0].id, next.rows[0].id);
      assert.equal(next.nextCursor, null);
      for (const changed of [undefined, { ...company, scope: { ...company.scope, owners: ["other"] } }, { ...company, fields: ["fit"] }]) {
        assert.equal((await ctx.client.ws("company").post("register/contact/list", { company: changed, filter, cursor: page.nextCursor })).status, 400);
      }
    }
    assert.equal((await post({ company, sort: { field: "accountFit", dir: "desc" } })).total, 2);
    assert.equal((await post({ company: { ...company, scope: { ...company.scope, unowned: true } }, filter: [{ field: "accountFit", op: "gte", value: 80 }] })).total, 4);
    assert.equal((await post({ company: { ...company, scope: { ...company.scope, owners: [] } }, sort: { field: "accountFit", dir: "asc" } })).total, 0);
  });
  it("validates company fields and scopes and scopes aggregate groups", async () => {
    assert.equal((await post({ company: { ...company, filter: [{ field: "name", op: "eq", value: "peer" }] } })).total, 0);
    for (const request of [
      { company: { fields: [] }, filter: [{ field: "accountFit", op: "empty" }] },
      { company: { fields: [] }, sort: { field: "accountFit", dir: "asc" } },
      { company: { ...company, filter: [{ field: "missing", op: "eq", value: 1 }] } },
      { company: { ...company, scope: { field: "fit", owners: ["u"], unowned: false } } },
    ]) assert.equal((await ctx.client.ws("company").post("register/contact/list", request)).status, 400);
    const report = await post({ company, groupBy: [{ field: "ownerId" }], measures: [{ fn: "count" }, { fn: "sum", field: "accountFit" }] }, "register/contact/aggregate");
    assert.equal(report.rows, 2);
    assert.deepEqual(report.groups.map((g: any) => [g.keys, g.values]), [[[null], [2, 160]]]);
    assert.equal((await ctx.client.ws("company").post("register/contact/aggregate", { company: { fields: [] }, measures: [{ fn: "sum", field: "accountFit" }] })).status, 400);
    assert.equal((await post({ company, measures: [{ fn: "count" }] }, "register/contact/aggregate")).rows, 8);
    assert.equal((await post({ company: { ...company, filter: [] }, measures: [{ fn: "count" }] }, "p/contact/aggregate")).rows, 2);
    for (const body of [
      { company, groupBy: [{ via: "accountId", field: "industry" }], measures: [{ fn: "count" }] },
      { company: { fields: [] }, measures: [{ fn: "sum", field: "accountFit", weight: "accountFit" }] },
    ]) assert.equal((await ctx.client.ws("company").post("register/contact/aggregate", body)).status, 400);
    assert.equal((await post({ company: { ...company, scope: { field: "id", owners: [ids[0], ...Array.from({ length: 51 }, (_, i) => `missing${i}`)], unowned: false }, filter: [] } })).total, 2);
    assert.equal((await ctx.client.ws("company").post("register/account/list", { company })).status, 400);
    assert.equal((await ctx.client.ws("company").post("p/deal/list", { company })).status, 400);
  });
});
