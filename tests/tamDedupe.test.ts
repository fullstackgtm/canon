import assert from "node:assert/strict";
import test from "node:test";
import { candidateKeys, dedupeCandidates, type CompanyCandidate } from "../convex/lib/tam/dedupe.ts";

const row = (name: string, extra: Partial<CompanyCandidate> = {}): CompanyCandidate => ({ name, sources: [{ kind: "directory", url: "https://builders.org/list", quote: `${name} is a member.` }], ...extra });
test("normalizes company suffixes, addresses, root domains and LinkedIn company URLs", () => {
  assert.deepEqual(candidateKeys(row("SMITH, Paving Inc. LLC", { address: "12 North Main Street, Suite 3", domain: "https://www.sales.smith.co.uk/about", linkedinUrl: "http://uk.linkedin.com/company/Smith-Paving/about/?x=1", keys: { placeId: " ChIJ123 ", registryId: " SAM:ABC " } })), {
    nameAddress: "smith paving|12 n main st ste 3", domain: "smith.co.uk", linkedin: "https://www.linkedin.com/company/smith-paving", placeId: "ChIJ123", registryId: "sam:abc",
  });
});
test("merges on each shared key and unions literal source evidence", () => {
  const pairs = [
    [row("Smith Paving Inc.", { address: "12 Main Street" }), row("Smith Paving Co Ltd", { address: "12 Main St." })],
    [row("First", { domain: "www.example.com" }), row("Second", { domain: "https://sales.example.com/about" })],
    [row("First", { linkedinUrl: "https://linkedin.com/company/smith/" }), row("Second", { linkedinUrl: "https://www.linkedin.com/company/SMITH/about" })],
    [row("First", { keys: { placeId: "ChIJ42" } }), row("Second", { keys: { placeId: "ChIJ42" } })],
    [row("First", { keys: { registryId: "sam:42" } }), row("Second", { keys: { registryId: "SAM:42" } })],
  ];
  for (const pair of pairs) {
    const groups = dedupeCandidates(pair);
    assert.deepEqual(groups.map((g) => g.indices), [[0, 1]]);
    assert.deepEqual(groups[0].company.sources.map((s) => s.quote), pair.map((r) => r.sources[0].quote));
  }
  assert.deepEqual(dedupeCandidates([row("Smith"), row("Smith")]).map((g) => g.indices), [[0], [1]]);
});
test("a bridge merges both groups and checks all aliases against the workspace", () => {
  const groups = dedupeCandidates([
    row("A", { domain: "first.com" }), row("B", { linkedinUrl: "linkedin.com/company/second" }),
    row("Bridge", { domain: "first.com", linkedinUrl: "linkedin.com/company/second" }),
    row("New", { domain: "new.com" }),
  ], [{ linkedinUrl: "https://www.linkedin.com/company/SECOND/" }]);
  assert.deepEqual(groups.map((g) => ({ indices: g.indices, duplicate: g.workspaceDuplicate })), [{ indices: [0, 1, 2], duplicate: true }, { indices: [3], duplicate: false }]);
  assert.equal(dedupeCandidates([row("First", { domain: "www.first.com" })], [{ domain: "https://first.com" }])[0].workspaceDuplicate, true);
});
