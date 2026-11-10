import assert from "node:assert/strict";
import { test } from "node:test";
import { HEAT_DOMAINS_MAX, heatChunks, heatScore } from "../convex/lib/signals/heat.ts";
import { boardBelongsTo, boardTokens, discoverBoard } from "../convex/lib/signals/boards.ts";
import { buildSignalsFromAts, DEFAULT_SIGNALS_CONFIG } from "../engine/src/signals.ts";
import { fetchAtsJobs } from "../engine/src/connectors/atsBoards.ts";
import { defaultModel } from "../recipes/index.ts";

const HEAT = defaultModel("signals.heat");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 7);
const role = (ageDays: number, reposted = false) => ({ bucket: "job" as const, observedAt: NOW - ageDays * DAY, reposted });

test("heat rises with fresh signals, fades over 30 days and saturates", () => {
  assert.deepEqual(heatScore([], NOW, HEAT), { score: 0, label: "none" });
  assert.equal(heatScore([role(0)], NOW, HEAT).score, 22);
  assert.equal(heatScore([role(0), role(0), role(0)], NOW, HEAT).score, 53);
  assert.ok(heatScore([role(15)], NOW, HEAT).score < heatScore([role(1)], NOW, HEAT).score);
  assert.equal(heatScore([role(30), role(90)], NOW, HEAT).label, "none");
  assert.ok(heatScore([role(1, true)], NOW, HEAT).score > heatScore([role(1)], NOW, HEAT).score);
  const many = heatScore(Array.from({ length: 50 }, () => role(0)), NOW, HEAT);
  assert.equal(many.label, "burning");
  assert.ok(many.score <= 100);
});

test("board discovery finds a board from the domain and does not call an outage a miss", async () => {
  assert.deepEqual(boardTokens("https://www.get-acme.co.uk/about"), ["get-acme", "getacme"]);
  const board = (status: number) => async (input: RequestInfo | URL) => {
    const url = String(input);
    if (status === 200 && url.includes("/v0/postings/acme")) {
      return Response.json([{ id: "r1", text: "Head of Growth", hostedUrl: "https://jobs.lever.co/acme/r1", descriptionPlain: "Own pipeline at Acme. Apply at acme.com/careers.", createdAt: NOW - 3 * DAY }]);
    }
    return new Response("{}", { status: status === 200 ? 404 : status });
  };
  const found = await discoverBoard("acme.com", "Acme", board(200) as typeof fetch);
  assert.equal(found.hit?.source, "lever");
  assert.equal(found.transient, false);
  // The posting date the board states travels into the signal, with its link and verbatim role text.
  const [signal] = buildSignalsFromAts(found.hit!.jobs.map((j) => ({ ...j, source: "lever" as const })), { domain: "acme.com" }, DEFAULT_SIGNALS_CONFIG, { now: new Date(NOW) });
  assert.equal(signal.sourceUrl, "https://jobs.lever.co/acme/r1");
  assert.equal(signal.publishedAt, new Date(NOW - 3 * DAY).toISOString());
  assert.match(signal.quote, /^Head of Growth/);

  // Another company's board under the same token is a miss: nothing on it names this account.
  const other = (async () => Response.json([{ id: "r9", text: "Underwriter", hostedUrl: "https://jobs.lever.co/acme/r9", descriptionPlain: "Join Acme Insurance." }])) as typeof fetch;
  assert.equal((await discoverBoard("acme.com", "Acme Corp", other)).hit, null);
  assert.equal(boardBelongsTo([{ title: "Underwriter", url: "", firstSeenKey: "9", jdSnippet: "Apply at acme.com.au or acme.com-jobs.io" }], { domain: "acme.com" }), false);
  assert.equal(boardBelongsTo(found.hit!.jobs, { domain: "other.io", name: "Other" }), false);

  assert.deepEqual(await discoverBoard("nobody.com", undefined, (async () => new Response("{}", { status: 404 })) as typeof fetch), { hit: null, transient: false });
  assert.equal((await discoverBoard("nobody.com", undefined, board(503) as typeof fetch)).transient, true);
  assert.deepEqual(await fetchAtsJobs({ source: "lever", boardToken: "x", accountDomain: "x.com", fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch }), []);
});

test("heat is asked for every loaded row: normalized, deduplicated, in chunks the query accepts that don't shift as rows load", () => {
  const domains = Array.from({ length: HEAT_DOMAINS_MAX + 50 }, (_, i) => `Co${i}.example`);
  const chunks = heatChunks([...domains, "https://www.co0.example/about", ""]);
  assert.deepEqual(chunks.map((c) => c.length), [HEAT_DOMAINS_MAX, 50]);
  assert.equal(chunks[0][0], "co0.example");
  // Loading more rows leaves the first chunk exactly as it was.
  assert.deepEqual(heatChunks(domains.slice(0, HEAT_DOMAINS_MAX))[0], chunks[0]);
});
