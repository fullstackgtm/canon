import assert from "node:assert/strict";
import test from "node:test";
import { FREE_EMAIL_DOMAINS } from "../engine/src/freeEmailDomains.ts";

// Treat the reserved fixture domain as personal mail for the research branches.
test.before(() => FREE_EMAIL_DOMAINS.add("example.com"));
test.after(() => FREE_EMAIL_DOMAINS.delete("example.com"));
import { domainConfirmed, groundedIdentity, searchName, transcriptSource } from "../convex/lib/calls/whoIs.ts";
import { planSuggestions } from "../convex/lib/calls/suggestions.ts";

const linkedin = { url: "https://www.linkedin.com/in/jordanmmercer", text: "Jordan M. Mercer - Example Works Ai | LinkedIn", snippet: true };
const blog = { url: "https://example.com/post", text: "A post that mentions Jordan Mercer in passing." };
const answer = (over: Record<string, unknown> = {}) => ({
  found: true, fullName: "Jordan M. Mercer", title: "Founder", companyName: "Example Works", companyDomain: "example.org",
  linkedinUrl: "https://www.linkedin.com/in/jordanmmercer", quote: "Jordan M. Mercer - Example Works Ai | LinkedIn", sourceUrl: linkedin.url, ...over,
});
const jordan = { email: "jmercer@example.com", name: "Jordan Mercer" };

test("who someone is counts only when a quote from a searched source names them and their employer", () => {
  assert.deepEqual([searchName({ email: "alex.rivera@example.com", name: "Alex" }), searchName({ email: "alexr92@example.com", name: "Alex" })],
    [{ name: "Alex Rivera", full: true }, { name: "Alex", full: false }]);
  const found = groundedIdentity(answer(), jordan, [linkedin, blog]);
  assert.deepEqual([found?.companyDomain, found?.linkedinUrl], ["example.org", linkedin.url]); // a middle initial is fine
  const refused = [
    answer({ found: false }),
    answer({ quote: "Jordan Mercer" }), // names him, not his employer
    answer({ quote: "A post that mentions Jordan Mercer in passing.", sourceUrl: blog.url }), // no employer
    answer({ quote: "Jordan M. Mercer - Example Works Ai", sourceUrl: "https://elsewhere.example" }), // not a searched source
    answer({ companyDomain: "example.com" }),
  ].map((a) => groundedIdentity(a, jordan, [linkedin, blog]));
  assert.deepEqual(refused, [null, null, null, null, null]);
  // Only a first name known: their exact address must be in the quote.
  assert.equal(groundedIdentity(answer(), { email: "jmercer@example.com", name: "Jordan" }, [linkedin]), null);
  // A LinkedIn URL the searches never turned up is dropped, the rest kept.
  assert.equal(groundedIdentity(answer({ linkedinUrl: "https://www.linkedin.com/in/someone-else" }), jordan, [linkedin])?.linkedinUrl, undefined);
});

test("the employer's site is confirmed by a searched page on it or its homepage naming the company; a researched person joins it", () => {
  const id = { companyName: "Example Works", companyDomain: "example.org" };
  assert.equal(domainConfirmed(id, [linkedin], null), false);
  assert.equal(domainConfirmed(id, [linkedin], "Welcome to Example Works, the largest community for B2B founders"), true);
  assert.equal(domainConfirmed(id, [{ url: "https://www.example.org/about", text: "About" }], null), true);

  const identity = { fullName: "Jordan M. Mercer", title: "Founder", companyName: "Example Works", companyDomain: "example.org", quote: "Jordan M. Mercer - Example Works Ai | LinkedIn", sourceUrl: linkedin.url };
  const planned = planSuggestions({
    callKey: "c", attendees: [{ email: "jmercer@example.com", name: "Jordan" }, { email: "kim@example.com", name: "Kim Lee" }],
    knownEmails: new Set(), knownDomains: new Set(), hasDeal: true, recent: true, read: { companyNames: {}, titles: {}, opportunity: null },
    identities: { "jmercer@example.com": identity }, researched: new Set(["jmercer@example.com", "kim@example.com"]), now: 1,
  });
  assert.deepEqual(planned.map((s) => [s.key, s.values.name, s.values.domain ?? null, s.research?.status]), [
    ["jmercer@example.com", "Jordan M. Mercer", "example.org", "found"],
    ["kim@example.com", "Kim Lee", null, "not_found"], // still suggested: the panel can research again
  ]);
});

test("a first name run together with the address is split, and what the person said in a one-on-one is a source", () => {
  assert.deepEqual([
    searchName({ email: "alexrivera21@example.com", name: "Alex" }),
    searchName({ email: "riveraalex@example.com", name: "Alex" }),
  ], [{ name: "Alex Rivera", full: true }, { name: "Alex Rivera", full: true }]);

  const alex = { email: "alexrivera21@example.com", name: "Alex" };
  const meeting = { title: "Morgan Avery and Alex", summary: null, ownerLabel: "Morgan", oneOnOne: true, webUrl: "https://meetings.example.com/synthetic-call",
    transcript: "Morgan: At Example Studio we build CRMs.\nThem: I lead revenue operations at Northwind these days." };
  const source = transcriptSource(alex, meeting)!;
  assert.equal(source.text, "Them: I lead revenue operations at Northwind these days."); // the other side's lines only
  const said = (quote: string, pages = [source]) => groundedIdentity({
    found: true, fullName: "Alex Rivera", title: "RevOps lead", companyName: "Northwind", companyDomain: "northwind.example",
    linkedinUrl: null, quote, sourceUrl: meeting.webUrl,
  }, alex, pages);
  assert.equal(said("I lead revenue operations at Northwind")?.companyName, "Northwind");
  // Morgan's own line is not Alex's, and outside a one-on-one an unlabelled line is no one's.
  const withOwner = { ...source, text: meeting.transcript };
  assert.equal(said("At Example Studio we build CRMs", [withOwner]), null);
  assert.equal(said("I lead revenue operations at Northwind", [{ ...source, transcript: { ownerLabel: "Morgan", oneOnOne: false } }]), null);
  // A continuation line with no speaker (an owner's multiline segment, as older imports stored it) is no one's.
  assert.equal(transcriptSource(alex, { ...meeting, transcript: "Morgan: Hi, I'm Morgan.\nI lead revenue operations at Northwind." }), null);
});

test("a meeting with no attendee addresses still suggests the company and people it names, each quoted", async () => {
  const { groundedSuggestionRead } = await import("../convex/lib/conversations/facts.ts");
  const { groundedCompany, groundedAtCompany } = await import("../convex/lib/calls/whoIs.ts");
  const context = {
    source: { kind: "call" as const, id: "call" }, title: "Example Seller <> Example Buyer - Demo", day: "2026-09-14", deal: null, people: [], askMentions: true, askOpportunity: true,
    summary: "Example Buyer uses both Salesforce and NetSuite. A synthetic trial discussed with Sam. Tay and Alex are likely partial admins.",
    text: "Morgan: Thanks for the time.\nThem: We run Salesforce and NetSuite here at Example Buyer.",
  };
  const read = groundedSuggestionRead({
    otherCompany: { name: "Example Buyer", searchHint: "uses Salesforce and NetSuite", evidence: "Example Seller <> Example Buyer - Demo" },
    mentionedPeople: [{ name: "Sam", evidence: "A synthetic trial discussed with Sam" }, { name: "Dana", evidence: "Dana runs finance" }],
  }, context);
  assert.deepEqual([read.mentioned?.company?.name, read.mentioned?.people.map((p) => p.name)], ["Example Buyer", ["Sam"]]); // Dana's quote isn't in the meeting

  const linkedin = { url: "https://www.linkedin.com/in/taylor-example", text: "Taylor Reed - Revenue Operations - Example Buyer Software | LinkedIn", snippet: true };
  const company = groundedCompany({ found: true, companyName: "Example Buyer Software", companyDomain: "buyer.example.org", quote: "Taylor Reed - Revenue Operations - Example Buyer Software", sourceUrl: linkedin.url }, "Example Buyer", [linkedin]);
  assert.equal(company?.companyDomain, "buyer.example.org");
  const tay = groundedAtCompany({ found: true, fullName: "Taylor Reed", title: "Revenue Operations", linkedinUrl: linkedin.url, quote: "Taylor Reed - Revenue Operations - Example Buyer Software", sourceUrl: linkedin.url }, "Tay", company!, [linkedin]);
  assert.deepEqual([tay?.fullName, tay?.linkedinUrl], ["Taylor Reed", linkedin.url]); // Tay → Taylor
  assert.equal(groundedAtCompany({ found: true, fullName: "Bob Jones", quote: "Taylor Reed - Revenue Operations - Example Buyer Software", sourceUrl: linkedin.url }, "Tay", company!, [linkedin]), null);

  const plan = (identified: ReturnType<typeof groundedCompany>) => planSuggestions({
    callKey: "c", attendees: [], knownEmails: new Set(), knownDomains: new Set(), hasDeal: false, recent: false,
    read: { companyNames: {}, titles: {}, opportunity: null },
    mentions: { name: "Example Buyer", company: identified, evidence: "Example Seller <> Example Buyer - Demo", people: [{ name: "Sam", evidence: "trial discussed with Sam", found: null }] }, now: 1,
  }).map((s) => [s.kind, s.key, s.values.name, s.values.domain ?? null]);
  assert.deepEqual(plan(company), [["account", "buyer.example.org", "Example Buyer Software", "buyer.example.org"], ["contact", "named:buyer.example.org:sam", "Sam", "buyer.example.org"]]);
  // Unidentified: suggested by the meeting's name, without a website (the panel asks for it).
  assert.deepEqual(plan(null), [["account", "named:example buyer", "Example Buyer", null], ["contact", "named:example buyer:sam", "Sam", null]]);
});
