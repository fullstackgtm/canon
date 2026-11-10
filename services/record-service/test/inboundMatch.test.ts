import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startApp, client } from "./helpers.ts";

describe("workspace inbound matching", () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;
  before(async () => { ctx = await startApp(); });
  after(async () => { await ctx.app.shutdown(); });

  it("matches live register records conservatively and keeps workspaces isolated", async () => {
    const ws = ctx.client.ws("northwind");
    await ws.post("provision");
    await ws.post("accounts/upsert", { records: [
      { domain: "acme.com", name: "Acme", ownerId: "ana" },
      { domain: "initech.com", name: "Initech", ownerId: "ana" },
      { domain: "initech.io", name: "Initech EU", ownerId: "chen" },
      { domain: "globex.co.uk", name: "Globex", ownerId: "ben" },
    ], source: "test", idempotencyKey: "accounts" });
    await ws.post("contacts/upsert", { records: [{ email: "jo@acme.com", fullName: "Jo", accountDomain: "acme.com" }], source: "test", idempotencyKey: "contacts" });
    const acme = (await ws.post("accounts/list", {})).json.rows.find((a: { domain: string }) => a.domain === "acme.com");
    for (const [email, by] of [["JO@ACME.COM", "email"], ["sam@acme.com", "domain"], ["lee@eu.acme.com", "domain_family"], ["max@initech.de", "ambiguous"]]) {
      const result = await ws.post("match/inbound", { email });
      assert.equal(result.status, 200);
      assert.equal(result.json.by, by);
      if (by !== "ambiguous") {
        assert.equal(result.json.companyId, acme.id);
        assert.equal(result.json.accountOwner, "ana");
      }
      assert.ok(!JSON.stringify(result.json).includes("acme.com"), "No record fields leave the matcher");
    }
    const personal = (await ws.post("match/inbound", { email: "pat@gmail.com", companyName: "Globex" })).json;
    assert.equal(personal.by, "none");
    assert.equal(personal.candidates[0].reason, "name");
    const other = ctx.client.ws("other");
    await other.post("provision");
    assert.deepEqual((await other.post("match/inbound", { email: "jo@acme.com" })).json, { by: "none", candidates: [] });
    assert.equal((await ws.post("match/inbound", { email: "invalid" })).status, 400);
    assert.equal((await client(ctx.base, "wrong").ws("northwind").post("match/inbound", { email: "jo@acme.com" })).status, 401);
    await ctx.app.registry.with("northwind", (w) => w.write(async (c) => {
      await c.run("UPDATE accounts SET deletedAt = 1 WHERE domain = 'acme.com'");
      await c.run("UPDATE contacts SET deletedAt = 1 WHERE email = 'jo@acme.com'");
    }, "exclusive"));
    assert.deepEqual((await ws.post("match/inbound", { email: "jo@acme.com" })).json, { by: "none", candidates: [] });
  });
});
