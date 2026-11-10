import assert from "node:assert/strict";
import test from "node:test";
import { awardRows, buildSourcePlan, directoryRows, employerRows, mapsWebsites, nextDirectoryPage } from "../convex/lib/tam/investigationSources.ts";
test("directory rows need a verbatim name, address and linked website; pagination stays on the source", () => {
  const html = '<img\n alt="Smith Paving Inc." />\n<p>Smith Paving Inc. · 12 Main Street</p><a href="https://smithpaving.com">Website</a><a rel="next" href="?page=2">Next</a>';
  assert.deepEqual(directoryRows(html, "https://builders.org/members", { companies: [{ name: "Smith Paving Inc.", website: "https://smithpaving.com", address: "12 Main Street" }, { name: "Invented", website: "invented.com" }] }), [{ name: "Smith Paving Inc.", domain: "smithpaving.com", address: "12 Main Street", keys: { nameAddress: "smith paving|12 main st", domain: "smithpaving.com" }, sources: [{ kind: "directory", url: "https://builders.org/members", quote: "Smith Paving Inc. · 12 Main Street" }] }]);
  assert.equal(nextDirectoryPage(html, "https://builders.org/members"), "https://builders.org/members?page=2");
  assert.equal(nextDirectoryPage('<a rel="next" href="https://evil.org/page">Next</a>', "https://builders.org/members"), undefined);
});
test("people identify employers with title evidence without retaining people", () => {
  const rows = employerRows([{ title: "Spray booth operator", company: { name: "Paint Works", domain: "www.paintworks.com" } }]);
  assert.deepEqual(rows, [{ name: "Paint Works", domain: "paintworks.com", keys: { domain: "paintworks.com" }, sources: [{ kind: "people_phrase", url: "https://treg.to/call/quickenrich.people.search", quote: "Spray booth operator" }] }]);
});
test("award records retain the recipient identity and URL; prohibited directories stay out of plans", () => {
  assert.deepEqual(mapsWebsites({ output: { places: [{ name: "Smith", website: "https://www.smithpaving.com/" }, { website: null }] } }), ["smithpaving.com"]);
  assert.deepEqual(awardRows({ results: [{ "Recipient Name": "Smith Paving Inc.", "Recipient UEI": "ABC42", "Recipient Location": { address_line1: "12 Main St", city_name: "Columbus" }, generated_internal_id: "CONT_AWD_42" }], page_metadata: { hasNext: true } }), { rows: [{ name: "Smith Paving Inc.", address: "12 Main St, Columbus", keys: { nameAddress: "smith paving|12 main st columbus", registryId: "uei:abc42" }, sources: [{ kind: "catalog", url: "https://www.usaspending.gov/award/CONT_AWD_42", quote: "Smith Paving Inc." }] }], more: true });
  const plan = buildSourcePlan([{ title: "Restricted", url: "https://www.thomasnet.com/list" }, { title: "Builders", url: "https://builders.org/members", listedCount: 20 }], ["Paving estimator"], true, "paving");
  assert.deepEqual(plan.map((p) => [p.kind, p.ref, p.estimatedCompanies]), [["directory", "https://builders.org/members", 20], ["people_phrase", "Paving estimator", 100], ["catalog", "paving", 100]]);
});
