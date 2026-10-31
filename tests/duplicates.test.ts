import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicates, pairKeys } from "../convex/lib/objects/duplicates.ts";
import { createMemoryRecordStore, recordClient } from "../convex/lib/recordClient.ts";

test("companies group by name without its legal suffix, LinkedIn URL and domain family, strongest first", () => {
  const groups = findDuplicates("account", [
    { id: "a1", name: "Northwind Traders Inc", domain: "northwind-traders.com" },
    { id: "a2", name: "Northwind Traders, LLC", domain: "northwindtraders.com" },
    { id: "a3", name: "Contoso", domain: "contoso.com" },
    { id: "a4", name: "Contoso UK", domain: "contoso.co.uk" },
    { id: "a5", name: "Globex", domain: "globex.com", linkedinUrl: "https://www.linkedin.com/company/globex" },
    { id: "a6", name: "Globex Holdings", domain: "globex.io", linkedinUrl: "linkedin.com/company/globex/" },
    { id: "a7", name: "Unrelated Co", domain: "unrelated.com" },
  ]);
  assert.deepEqual(groups.map((g) => [g.members.map((m) => m.id), g.matches.map((m) => m.reason), g.score]), [
    [["a5", "a6"], ["linkedin", "domain_family"], 95],
    [["a1", "a2"], ["name"], 50],
    [["a3", "a4"], ["domain_family"], 40],
  ]);
  assert.equal(groups[0].matches[0].value, "linkedin.com/company/globex");
});

test("people group by email, LinkedIn URL and the same name at the same company, not the same name elsewhere", () => {
  const groups = findDuplicates("contact", [
    { id: "p1", name: "Dana Whitfield", email: "Dana@contoso.com", accountId: "a1" },
    { id: "p2", name: "D. Whitfield", email: "dana@contoso.com", accountId: "a1" },
    { id: "p3", name: "Marcus Oyelaran", linkedinUrl: "https://www.linkedin.com/in/marcus/", accountId: "a2" },
    { id: "p4", name: "Marc Oyelaran", linkedinUrl: "linkedin.com/in/marcus", accountId: "a3" },
    { id: "p5", name: "Sam Lee", accountId: "a4" },
    { id: "p6", name: "sam lee", accountId: "a4" },
    { id: "p7", name: "Sam Lee", accountId: "a5" },
  ]);
  assert.deepEqual(groups.map((g) => [g.members.map((m) => m.id), g.matches.map((m) => m.reason)]), [
    [["p1", "p2"], ["email"]],
    [["p3", "p4"], ["linkedin"]],
    [["p5", "p6"], ["name_at_company"]],
  ]);
});

test("a group of more than nine keeps its size, and a pair is named the same whichever order it is seen in", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, name: "Acme", domain: `acme${i}.com` }));
  const [group] = findDuplicates("account", rows);
  assert.equal(group.members.length, 9);
  assert.equal(group.size, 12);
  assert.deepEqual(pairKeys(["b", "a", "c"]), ["a|b", "a|c", "b|c"]);
});

test("the in-memory record client lists the same groups with a total beyond the limit", async () => {
  const client = recordClient({ env: {}, store: createMemoryRecordStore() });
  await client.upsertAccounts("w", { records: [
    { domain: "a.com", name: "Acme" }, { domain: "b.com", name: "ACME Inc" }, { domain: "c.com", name: "Zed" }, { domain: "d.com", name: "Zed LLC" },
  ], source: "test", idempotencyKey: "k" });
  const { groups, total } = await client.listDuplicates("w", "account", 1);
  assert.equal(total, 2);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].matches.map((m) => m.value), ["acme"]);
});
