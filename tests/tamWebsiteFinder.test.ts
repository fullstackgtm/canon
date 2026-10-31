import assert from "node:assert/strict";
import test from "node:test";
import { dnsGuesses, findWebsite, type WebsiteFinderDeps } from "../convex/lib/tam/websiteFinder.ts";
const company = { name: "Smith Paving Inc.", address: "12 Main St", domain: "source.com", sources: [{ kind: "directory", url: "https://builders.org", quote: "Smith Paving Inc." }] };
function fixture(extra: Partial<WebsiteFinderDeps> = {}) {
  const calls: string[] = [];
  const deps: WebsiteFinderDeps = {
    paid: false, resolveName: async () => { calls.push("resolver"); return "resolved.com"; },
    resolves: async (domain) => { calls.push(`dns:${domain}`); return true; },
    fetchPage: async (url) => { calls.push(url); return { text: "Smith Paving builds roads. ".repeat(20), finalUrl: url }; },
    sameCompany: async () => "yes", maps: async (q) => { calls.push(`maps:${q}`); return ["maps.com"]; }, ...extra,
  };
  return { calls, deps };
}
test("uses the source, then the free resolver, then DNS, then paid Maps", async () => {
  const first = fixture();
  assert.deepEqual(await findWebsite(company, first.deps), { domain: "source.com", method: "source" });
  assert.deepEqual(first.calls, ["https://source.com"]);
  const free = fixture();
  assert.deepEqual(await findWebsite({ ...company, domain: undefined }, free.deps), { domain: "resolved.com", method: "resolver" });
  const dns = fixture({ resolveName: async () => null });
  assert.deepEqual(await findWebsite({ ...company, domain: undefined }, dns.deps), { domain: "smithpaving.com", method: "dns" });
  const maps = fixture({ paid: true, sameCompany: async (_c, _text, domain) => domain === "maps.com" ? "yes" : "no" });
  assert.deepEqual(await findWebsite(company, maps.deps), { domain: "maps.com", method: "maps" });
  assert.equal(maps.calls.at(-2), "maps:Smith Paving Inc. 12 Main St");
  assert.deepEqual(dnsGuesses(company.name), ["smithpaving.com", "smithpavinginc.com", "smith-paving.com", "smithpaving.net", "smithpavinginc.net", "smith-paving.net", "smithpaving.us", "smithpavinginc.us", "smith-paving.us"]);
});
test("keeps only yes verdicts, rejects parked pages and skips Maps when paid calls are off", async () => {
  for (const verdict of ["no", "unsure"] as const) {
    const f = fixture({ sameCompany: async () => verdict });
    assert.deepEqual(await findWebsite(company, f.deps), { reason: verdict === "no" ? "The websites found belong to a different company." : "The website could not be confirmed as the same company." });
    assert.equal(f.calls.some((c) => c.startsWith("maps:")), false);
  }
  const parked = fixture({ fetchPage: async (url) => ({ text: "This domain is for sale. ".repeat(20), finalUrl: url }) });
  assert.deepEqual(await findWebsite(company, parked.deps), { reason: "No company website was found." });
});
