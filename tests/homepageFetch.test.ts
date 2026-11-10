import assert from "node:assert/strict";
import test from "node:test";
import { fetchHomepage } from "../convex/lib/homepageFetch.ts";

const html = (words: number) => `<html><body><p>${"word ".repeat(words)}</p></body></html>`;
const ok = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

test("a readable direct fetch never touches the fallbacks", async () => {
  let calls = 0;
  const p = await fetchHomepage("acme.com", {
    direct: async (url) => ({ text: html(100), finalUrl: url }),
    fetch: (async () => { calls++; return ok("{}"); }) as unknown as typeof fetch,
    workerToken: "t", scrapingBeeKey: "k",
  });
  assert.equal(p?.via, "direct");
  assert.equal(calls, 0);
});

test("an unreadable page falls back to the Worker, then ScrapingBee", async () => {
  const seen: string[] = [];
  const fakeFetch = (async (input: string | URL) => {
    const u = String(input);
    seen.push(u.includes("scrapingbee") ? "bee" : "worker");
    if (u.includes("scrapingbee")) return ok(html(100), { "spb-resolved-url": "https://acme.com/home" });
    return ok(JSON.stringify({ results: [{ title: "Acme", description: "", text: "short", finalUrl: null, blocked: false }] }));
  }) as unknown as typeof fetch;
  const p = await fetchHomepage("acme.com", { direct: async () => ({ text: "<div id=root></div>", finalUrl: "https://acme.com/" }), fetch: fakeFetch, workerToken: "t", scrapingBeeKey: "k" });
  assert.deepEqual(seen, ["worker", "bee"]);
  assert.equal(p?.via, "scrapingbee");
  assert.equal(p?.finalUrl, "https://acme.com/home");
});

test("the Worker result is used when readable, and missing credentials skip steps", async () => {
  const worker = (async () => ok(JSON.stringify({ results: [{ title: "Acme dental software", description: "For dental practices", text: "word ".repeat(80), finalUrl: "https://acme.com/", blocked: false }] }))) as unknown as typeof fetch;
  const viaWorker = await fetchHomepage("acme.com", { direct: async () => null, fetch: worker, workerToken: "t" });
  assert.equal(viaWorker?.via, "worker");
  assert.match(viaWorker?.text ?? "", /dental practices/);
  const none = await fetchHomepage("acme.com", { direct: async () => ({ text: "tiny", finalUrl: "https://acme.com/" }) });
  assert.equal(none?.via, "direct", "no credentials: the direct result is returned as is");
});

test("every billed ScrapingBee response is reported at its Spb-Cost, readable or not", async () => {
  const calls: Array<{ costMicro: number; hit: boolean }> = [];
  const bee = (body: string) => (async () => ok(body, { "spb-cost": "10" })) as unknown as typeof fetch;
  const deps = { direct: async () => null, scrapingBeeKey: "k", onScrapingBee: async (c: { costMicro: number; hit: boolean }) => { calls.push(c); } };
  await fetchHomepage("acme.com", { ...deps, fetch: bee(html(100)) });
  await fetchHomepage("acme.com", { ...deps, fetch: bee("<div id=root></div>") });
  assert.deepEqual(calls, [{ costMicro: 2530, hit: true }, { costMicro: 2530, hit: false }]);
});
