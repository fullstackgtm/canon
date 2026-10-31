// DNS pass over every tracked domain (PDL + extra), resumable.
// Skips domains checked within --max-age-days; re-run any time to refresh.
//
//   node --experimental-strip-types scripts/dns-pass.ts [--limit N] [--concurrency 400] [--max-age-days 30] [--recheck timeout,servfail] [--via local|worker]
//
// --via local (default) queries public resolvers directly (round-robin), A first
// then AAAA. SERVFAIL and timeouts are retried once on a different resolver.
// --via worker sends batches to the fsgtm-dns-check Cloudflare Worker
// (infra/dns-worker), which runs the lookups inside Cloudflare: ~14x faster than
// local and far fewer timeouts. --concurrency is then batches in flight
// (default 300). Token: DNS_CHECK_TOKEN or ~/.fullstackgtm/dns-check.key.
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { ensureStatusSchema, writeDnsResults, type DnsResult, type DnsStatus } from "../src/domainStatus.ts";

const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const LIMIT = Number(arg("limit", "0"));
const VIA = arg("via", "local");
if (VIA !== "local" && VIA !== "worker") throw new Error("--via must be local or worker");
const CONC = Number(arg("concurrency", VIA === "worker" ? "300" : "400"));
const WORKER_URL = process.env.DNS_CHECK_URL ?? "https://fsgtm-dns-check.ryan-ad7.workers.dev";
const WORKER_BATCH = 300;
// Statuses to re-check regardless of age (e.g. results caused by resolver throttling).
const RECHECK = arg("recheck", "").split(",").filter(Boolean);
const MAX_AGE_DAYS = Number(arg("max-age-days", "30"));
const INDEX = process.env.PDL_INDEX ?? `${process.env.HOME}/.fullstackgtm/data/pdl_companies.duckdb`;
const SERVERS = (process.env.DNS_SERVERS ?? "1.1.1.1,8.8.8.8,9.9.9.9,1.0.0.1,8.8.4.4,149.112.112.112").split(",");

const resolvers = SERVERS.map((s) => { const r = new Resolver({ timeout: 2500, tries: 1 }); r.setServers([s]); return { s, r }; });
let rr = 0;
const pick = (exclude?: string) => { for (;;) { const x = resolvers[rr++ % resolvers.length]; if (x.s !== exclude || resolvers.length === 1) return x; } };

const codeToStatus = (code: string | undefined): DnsStatus | "retry" =>
  code === "ENOTFOUND" ? "nxdomain" : code === "ENODATA" ? "no_address" : code === "ESERVFAIL" || code === "ETIMEOUT" || code === "ECONNREFUSED" ? "retry" : "error";

async function check(domain: string): Promise<DnsResult> {
  let used = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const { s, r } = pick(used);
    used = s;
    try {
      const ips = await r.resolve4(domain);
      return { domain, status: "ok", ips: ips.length, resolver: s, checkedAt: new Date() };
    } catch (e) {
      const st = codeToStatus((e as { code?: string }).code);
      if (st === "no_address") {
        try { const v6 = await r.resolve6(domain); if (v6.length) return { domain, status: "ok", ips: v6.length, resolver: s, checkedAt: new Date() }; } catch {}
        return { domain, status: "no_address", ips: 0, resolver: s, checkedAt: new Date() };
      }
      if (st !== "retry") return { domain, status: st, ips: 0, resolver: s, checkedAt: new Date() };
      if (attempt === 1) return { domain, status: (e as { code?: string }).code === "ESERVFAIL" ? "servfail" : "timeout", ips: 0, resolver: s, checkedAt: new Date() };
    }
  }
  throw new Error("unreachable");
}

const workerToken = VIA === "worker" ? (process.env.DNS_CHECK_TOKEN ?? readFileSync(`${process.env.HOME}/.fullstackgtm/dns-check.key`, "utf8").trim()) : "";

async function checkBatchViaWorker(domains: string[]): Promise<DnsResult[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(WORKER_URL, { method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" }, body: JSON.stringify({ domains }) });
      if (!r.ok) throw new Error(`worker ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const { results } = (await r.json()) as { results: Array<{ domain: string; status: DnsStatus; ips: number }> };
      const at = new Date();
      return results.map((x) => ({ ...x, resolver: "cf-worker", checkedAt: at }));
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
}

async function checkAll(domains: string[]): Promise<DnsResult[]> {
  if (VIA === "worker") {
    const batches = Array.from({ length: Math.ceil(domains.length / WORKER_BATCH) }, (_, i) => domains.slice(i * WORKER_BATCH, (i + 1) * WORKER_BATCH));
    const out: DnsResult[][] = new Array(batches.length);
    let j = 0;
    await Promise.all(Array.from({ length: Math.min(CONC, batches.length) }, async () => { while (j < batches.length) { const k = j++; out[k] = await checkBatchViaWorker(batches[k]); } }));
    return out.flat();
  }
  const results: DnsResult[] = new Array(domains.length);
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => { while (i < domains.length) { const k = i++; results[k] = await check(domains[k]); } }));
  return results;
}

const db = await DuckDBInstance.create(INDEX);
const c = await db.connect();
await ensureStatusSchema(c);

// Build the to-do list once, numbered, then page by number. (Paging the view
// with ORDER BY re-sorted all 24M domains for every page.)
const recheck = RECHECK.length ? ` OR s.dns_status IN (${RECHECK.map((x) => `'${x.replace(/'/g, "")}'`).join(",")})` : "";
await c.run(`CREATE OR REPLACE TEMP TABLE dns_todo AS
  SELECT row_number() OVER () AS n, a.domain FROM all_domains a LEFT JOIN domain_status s USING (domain)
  WHERE s.dns_checked_at IS NULL OR s.dns_checked_at < now() - INTERVAL ${MAX_AGE_DAYS} DAY${recheck}`);
const total = Number(((await c.runAndReadAll(`SELECT count(*) AS n FROM dns_todo`)).getRowObjects()[0] as { n: bigint }).n);
console.log(JSON.stringify({ label: "to check", total }));
const PAGE = VIA === "worker" ? 100_000 : 20_000;
let after = 0;
let done = 0;
const counts: Record<string, number> = {};
const t0 = performance.now();
for (;;) {
  const page = (await c.runAndReadAll(`SELECT domain FROM dns_todo WHERE n > ${after} AND n <= ${after + PAGE}`)).getRowObjects() as Array<{ domain: string }>;
  if (!page.length) break;
  after += PAGE;
  const todo = LIMIT ? page.slice(0, Math.max(0, LIMIT - done)) : page;
  const results = await checkAll(todo.map((t) => t.domain));
  await writeDnsResults(c, results);
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  done += todo.length;
  const secs = (performance.now() - t0) / 1000;
  console.log(JSON.stringify({ checked: done, of: total, perSec: Math.round(done / secs), elapsedMin: Math.round(secs / 6) / 10, etaMin: Math.round((total - done) / Math.max(1, done / secs) / 60), counts }));
  if (LIMIT && done >= LIMIT) break;
}
const secs = (performance.now() - t0) / 1000;
console.log(JSON.stringify({ label: "dns pass done", checked: done, secs: Math.round(secs), perSec: Math.round(done / Math.max(1, secs)), counts }));
c.closeSync();
