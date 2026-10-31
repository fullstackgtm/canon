// register/{account,contact}/duplicates (contract 1.24.0): candidate groups over the live register.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startApp } from "./helpers.ts";

describe("duplicate candidates over the register", () => {
  let ctx: Awaited<ReturnType<typeof startApp>>;
  before(async () => {
    ctx = await startApp();
  });
  after(async () => {
    await ctx.app.shutdown();
  });

  it("returns companies and people that share a name, LinkedIn URL or name at one company, with a total", async () => {
    const ws = ctx.client.ws("d1");
    await ws.post("provision");
    await ws.post("accounts/upsert", {
      records: [
        { domain: "northwind-traders.example", name: "Northwind Traders Inc" },
        { domain: "northwindtraders.example", name: "Northwind Traders, LLC" },
        { domain: "other.example", name: "Other" },
      ], source: "pdl", idempotencyKey: "a",
    });
    await ws.post("contacts/upsert", {
      records: [
        { accountDomain: "other.example", fullName: "Dana Whitfield", email: "dana@other.example", linkedinUrl: "https://www.linkedin.com/in/dana" },
        { accountDomain: "northwind-traders.example", fullName: "Dana W", email: "dw@northwind-traders.example", linkedinUrl: "linkedin.com/in/dana/" },
      ], source: "pdl", idempotencyKey: "c",
    });
    const accounts = (await ws.post("register/account/duplicates", { limit: 10 })).json;
    assert.equal(accounts.total, 1);
    assert.deepEqual(accounts.groups[0].matches, [{ reason: "name", value: "northwind traders" }]);
    assert.deepEqual(accounts.groups[0].members.map((m: { name: string }) => m.name), ["Northwind Traders Inc", "Northwind Traders, LLC"].sort());
    const people = (await ws.post("register/contact/duplicates", { limit: 10 })).json;
    assert.deepEqual(people.groups[0].matches, [{ reason: "linkedin", value: "linkedin.com/in/dana" }]);
  });
});
