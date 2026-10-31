import { test } from "node:test";
import assert from "node:assert/strict";
import { domainFromEmail, domainFromWebsite, mapAccount, mapContact, mapCustom, mapLead, normalizeSfId, objectDefFromDescribe, stubAccountsFor } from "../mapping.ts";
import { csvToObjects, toCsv } from "../sfClient.ts";

test("normalizeSfId: 15 -> 18 matches Salesforce's checksum", () => {
  // Known pair from Salesforce docs/examples.
  assert.equal(normalizeSfId("001A0000006Vm9r"), "001A0000006Vm9rIAC");
  assert.equal(normalizeSfId("001A0000006Vm9rIAC"), "001A0000006Vm9rIAC");
  assert.equal(normalizeSfId("bad"), undefined);
  assert.equal(normalizeSfId(""), undefined);
});

test("domainFromWebsite normalizes urls and rejects junk", () => {
  assert.equal(domainFromWebsite("https://www.Acme.com/about?x=1"), "acme.com");
  assert.equal(domainFromWebsite("acme.co.uk"), "acme.co.uk");
  assert.equal(domainFromWebsite("http://acme.com:8080"), "acme.com");
  assert.equal(domainFromWebsite("n/a"), undefined);
  assert.equal(domainFromWebsite(""), undefined);
  assert.equal(domainFromEmail("a@gmail.com"), undefined);
  assert.equal(domainFromEmail("a@Acme.com"), "acme.com");
});

test("mapAccount: no Website is a rejection with a reason", () => {
  const ok = mapAccount({ Id: "001A0000006Vm9r", Name: "Acme", Website: "acme.com", NumberOfEmployees: "12", Industry: "", BillingCountry: "US" });
  assert.deepEqual(ok.ok, { sfId: "001A0000006Vm9rIAC", domain: "acme.com", name: "Acme", industry: undefined, employees: 12, country: "US" });
  const bad = mapAccount({ Id: "001A0000006Vm9r", Name: "Acme", Website: "" });
  assert.match(bad.reject!, /no Website/);
  assert.match(mapAccount({ Id: "001A0000006Vm9r", Name: "Acme", Website: "none" }).reject!, /not a valid domain/);
  assert.match(mapAccount({ Id: "001A0000006Vm9r", Name: "", Website: "a.com" }).reject!, /no Name/);
});

test("mapContact: parent resolution and orphan fallback", () => {
  const row = { Id: "003A0000006Vm9r", AccountId: "001A0000006Vm9r", FirstName: "Ada", LastName: "L", Name: "Ada L", Title: "", Email: "ADA@acme.com" };
  assert.equal(mapContact(row, { domain: "acme.com" }).ok!.accountDomain, "acme.com");
  assert.equal(mapContact(row, { domain: "acme.com" }).ok!.email, "ada@acme.com");
  assert.match(mapContact(row, { missing: "Account has no Website" }).reject!, /not imported: Account has no Website/);
  assert.match(mapContact(row, undefined).reject!, /not found/);
  assert.equal(mapContact({ ...row, AccountId: "" }, undefined).ok!.accountDomain, "acme.com");
  assert.match(mapContact({ ...row, AccountId: "", Email: "x@gmail.com" }, undefined).reject!, /no Account and no company email/);
});

test("mapLead: converted leads and domainless leads are rejected", () => {
  const row = { Id: "00QA0000006Vm9r", Name: "L P", Company: "Co", Website: "", Email: "l@co.io", IsConverted: "false" };
  assert.equal(mapLead(row).ok!.accountDomain, "co.io");
  assert.match(mapLead({ ...row, IsConverted: "true" }).reject!, /converted/);
  assert.match(mapLead({ ...row, Email: "l@yahoo.com" }).reject!, /no Website/);
  assert.deepEqual(stubAccountsFor([{ domain: "co.io", company: "Co" }, { domain: "co.io" }, { domain: "x.io" }], (d) => d === "x.io"), [{ domain: "co.io", name: "Co" }]);
});

test("custom objects: describe -> ObjectDef and typed fields", () => {
  const def = objectDefFromDescribe({
    name: "Project__c", label: "Project",
    fields: [{ name: "Id", type: "id" }, { name: "Budget__c", type: "currency" }, { name: "Acct__c", type: "reference", referenceTo: ["Account"] }, { name: "Addr__c", type: "address" }, { name: "On__c", type: "boolean" }],
  });
  assert.deepEqual(def.fields.map((f) => [f.name, f.type]), [["Budget__c", "number"], ["Acct__c", "reference"], ["On__c", "boolean"]]);
  const rec = mapCustom({ Id: "a0XA0000006Vm9r", Budget__c: "12.5", Acct__c: "001A0000006Vm9r", On__c: "true", Empty__c: "" }, def);
  assert.deepEqual(rec.ok, { sfId: "a0XA0000006Vm9rMAC", fields: { Budget__c: 12.5, Acct__c: "001A0000006Vm9rIAC", On__c: true, Empty__c: null } });
});

test("csv round trip with quotes, commas and newlines", () => {
  const rows = [{ A: 'he said "hi"', B: "x,y", C: "line1\nline2" }, { A: "", B: "plain", C: "" }];
  assert.deepEqual(csvToObjects(toCsv(["A", "B", "C"], rows)), rows);
});
