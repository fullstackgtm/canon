import assert from "node:assert/strict";
import test from "node:test";
import { accountDims, cellFromKey, cellKey, contactDims, departmentOf, facetOf, keywordsPass, NONE, seniorityOf, totalsOf, type Cell } from "../convex/lib/staging.ts";

test("titles map to a level and a department", () => {
  assert.deepEqual(["VP Sales", "Vice President of Sales", "Director of RevOps", "Founder & CEO", "Account Executive"].map((t) => [seniorityOf(t), departmentOf(t)]), [
    ["vp", "Sales"], ["vp", "Sales"], ["director", "Revenue operations"], ["founder", NONE], [NONE, "Sales"],
  ]);
});

test("a selection's totals and breakdowns come from the run's cells", () => {
  const us = accountDims({ industry: "Software", employees: 300, country: "United States" }, false);
  const de = accountDims({ industry: "Fintech", employees: 40, country: "Germany" }, true);
  const cell = (kind: Cell["kind"], dims: Cell["dims"], count: number) => cellFromKey(cellKey(kind, dims), count);
  const cells = [
    cell("account", us, 3), cell("account", de, 2),
    cell("contact", contactDims(us, { title: "VP Sales" }, false), 5),
    cell("contact", contactDims(de, { title: "VP Sales" }, true), 4),
    cell("contact", contactDims(de, { title: "Head of Marketing" }, false), 1),
  ];
  assert.deepEqual(totalsOf(cells), { accounts: 5, contacts: 10, existingAccounts: 2, existingContacts: 4 });
  // A contact is kept when it and its company pass; a company filter keeps accounts by their own dimensions.
  assert.deepEqual(totalsOf(cells, { region: ["europe"], seniority: ["vp"] }), { accounts: 2, contacts: 4, existingAccounts: 2, existingContacts: 4 });
  assert.deepEqual(totalsOf(cells, { existing: "new" }), { accounts: 3, contacts: 6, existingAccounts: 0, existingContacts: 0 });
  // A breakdown ignores its own filter, so unticked keys still show what they would add.
  assert.deepEqual(facetOf(cells, "seniority", { seniority: ["head"] }), [{ key: "vp", count: 9 }, { key: "head", count: 1 }]);
});

test("keyword filters match whole words, and a contact passes company keywords through its company", () => {
  const k = { title: { include: ["VP", "vice president"], exclude: ["assistant"] }, company: { exclude: ["staffing"] } };
  const acme = { name: "Acme Inc", domain: "acme.com" };
  assert.equal(keywordsPass("contact", { title: "VP of Sales" }, acme, k), true);
  assert.equal(keywordsPass("contact", { title: "MVP Program Lead" }, acme, k), false, "not inside a word");
  assert.equal(keywordsPass("contact", { title: "Assistant to the Vice President" }, acme, k), false);
  assert.equal(keywordsPass("contact", { title: "VP Sales" }, { name: "Prime Staffing", domain: "prime.io" }, k), false);
  assert.equal(keywordsPass("account", {}, acme, { company: { include: ["acme"] } }), true, "a domain's words count");
  assert.equal(keywordsPass("account", {}, { domain: "acme.io" }, { company: { include: [".io"] } }), true, "a suffix term");
  assert.equal(keywordsPass("contact", { title: "VP Sales" }, undefined, { company: { include: ["acme"] } }), false, "unknown company fails an include");
});
