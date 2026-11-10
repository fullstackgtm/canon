import assert from "node:assert/strict";
import test from "node:test";
import { coreName, namesMatch, planGaps, sourceMatches, type GapSource } from "../convex/lib/deals/gaps.ts";

test("a deal with no company and no people is matched to its conversations by name and proposes their company and people", () => {
  const deal = { name: "AC Pools Services – weekly maintenance", contactIds: [], companyDomain: null };
  assert.equal(coreName(deal.name), "AC Pools Services");
  assert.ok(namesMatch(deal.name, "acpools.com"));
  assert.ok(!namesMatch(deal.name, "pools.com"));

  const thread: GapSource = {
    kind: "email", id: "c1", title: "Quote for the pool", at: 2, contactIds: [],
    people: [{ email: "dana@acpools.com", name: "Dana Ruiz" }, { email: "me@seller.example.org", name: "Ryan" }, { email: "lee@acpools.com", name: "Lee Park" }],
  };
  const unrelated: GapSource = { kind: "call", id: "m1", title: "Weekly sync", at: 1, contactIds: [], people: [{ email: "x@other.example", name: "X" }] };
  assert.ok(sourceMatches(deal, thread));
  assert.ok(!sourceMatches(deal, unrelated));

  const proposals = planGaps({
    deal: { name: deal.name, companyId: null, companyName: null },
    people: [], companies: new Map(), namedLike: [], knownDomains: new Map(),
    knownEmails: new Map([["lee@acpools.com", { id: "con_lee", name: "Lee Park" }]]),
    companyPeople: [], sources: [thread], ourSide: (e) => e.endsWith("@seller.example.org"),
  });
  assert.deepEqual(proposals.map((p) => [p.kind, p.key, p.matchId ?? null, p.via]), [
    ["account", "domain:acpools.com", null, "email"],
    ["contact", "email:dana@acpools.com", null, "email"],
    ["contact", "match:con_lee", "con_lee", "email"],
  ]);
});

test("a deal whose people already have a company proposes linking that company first, and its company's people when it has none", () => {
  const proposals = planGaps({
    deal: { name: "Expansion", companyId: null, companyName: null },
    people: [{ id: "con_a", name: "Ann", accountId: "acc_1" }],
    companies: new Map([["acc_1", { name: "Acme", domain: "acme.com" }]]), namedLike: [],
    knownDomains: new Map(), knownEmails: new Map(), companyPeople: [], sources: [], ourSide: () => false,
  });
  assert.deepEqual(proposals.map((p) => [p.kind, p.matchId, p.via]), [["account", "acc_1", "crm"]]);

  const people = planGaps({
    deal: { name: "Expansion", companyId: "acc_1", companyName: "Acme" },
    people: [], companies: new Map(), namedLike: [], knownDomains: new Map(), knownEmails: new Map(),
    companyPeople: [{ id: "con_b", name: "Bo", title: "CFO" }], sources: [], ourSide: () => false,
  });
  assert.deepEqual(people.map((p) => [p.kind, p.matchId, p.evidence]), [["contact", "con_b", "Works at Acme"]]);
});
