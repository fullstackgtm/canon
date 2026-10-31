// Homepage fetch pass over every domain whose DNS resolves, resumable.
//
//   node --experimental-strip-types scripts/fetch-pass.ts [--limit N] [--concurrency 600] [--max-age-days 90] [--sample N]
//
// Sends batches to the fsgtm-homepage-fetch Cloudflare Worker (infra/fetch-worker).
// Per domain:
//   - domain_status.http_* gets the status, final URL, text length, method and time
//   - ~/.fullstackgtm/data/homepages/part-<n>.parquet gets title, meta
//     description and the first 1,500 characters of visible text (zstd)
// Skips domains fetched within --max-age-days. --sample N fetches a random N
// domains instead (for pilots) and writes the shard under homepages/sample/.
// Token: FETCH_TOKEN or ~/.fullstackgtm/fetch.key.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { ensureStatusSchema } from "../src/domainStatus.ts";

const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const LIMIT = Number(arg("limit", "0"));
const SAMPLE = Number(arg("sample", "0"));
const CONC = Number(arg("concurrency", "600"));
const MAX_AGE_DAYS = Number(arg("max-age-days", "90"));
const BATCH = 30;
const PAGE = 60_000;
const DATA = `${process.env.HOME}/.fullstackgtm/data`;
const INDEX = process.env.PDL_INDEX ?? `${DATA}/pdl_companies.duckdb`;
const OUT = SAMPLE ? `${DATA}/homepages/sample` : `${DATA}/homepages`;
const URL_ = process.env.FETCH_URL ?? "https://fsgtm-homepage-fetch.ryan-ad7.workers.dev";
const TOKEN = process.env.FETCH_TOKEN ?? readFileSync(`${process.env.HOME}/.fullstackgtm/fetch.key`, "utf8").trim();

type Fetched = {
  domain: string; status: number | null; finalUrl: string | null; title: string; description: string;
  text: string; textChars: number; error: string | null; blocked: boolean;
};

const failed = (domain: string, error: string): Fetched =>
  ({ domain, status: null, finalUrl: null, title: "", description: "", text: "", textChars: 0, error: `worker_failed: ${error}`.slice(0, 200), blocked: false });

// A batch that keeps failing usually holds one page that makes the Worker hit
// a resource limit. Split it and retry each domain alone; a domain that still
// fails is recorded as worker_failed rather than stopping the pass.
async function fetchBatch(domains: string[]): Promise<Fetched[]> {
  try {
    return await fetchOnce(domains, domains.length > 1 ? 2 : 3);
  } catch (e) {
    if (domains.length === 1) return [failed(domains[0], (e as Error).message)];
    const out: Fetched[] = [];
    for (const d of domains) out.push(...(await fetchBatch([d])));
    return out;
  }
}

async function fetchOnce(domains: string[], maxAttempts: number): Promise<Fetched[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(URL_, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ domains }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!r.ok) throw new Error(`worker ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return ((await r.json()) as { results: Fetched[] }).results;
    } catch (e) {
      if (attempt >= maxAttempts) throw e;
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  }
}

mkdirSync(OUT, { recursive: true });
const db = await DuckDBInstance.create(INDEX);
const c = await db.connect();
await ensureStatusSchema(c);
await c.run(`ALTER TABLE domain_status ADD COLUMN IF NOT EXISTS http_error VARCHAR`);
await c.run(`ALTER TABLE domain_status ADD COLUMN IF NOT EXISTS http_blocked BOOLEAN`);

await c.run(SAMPLE
  ? `CREATE OR REPLACE TEMP TABLE fetch_todo AS
       SELECT row_number() OVER () AS n, domain FROM (SELECT * FROM (SELECT domain FROM domain_status WHERE dns_status = 'ok') USING SAMPLE ${SAMPLE} ROWS)`
  // Shuffled: in storage order, thousands of domains on one host (a Belgian
  // registrar, Google-parked .site names) arrive back to back and get us rate-limited.
  : `CREATE OR REPLACE TEMP TABLE fetch_todo AS
       SELECT row_number() OVER (ORDER BY hash(domain)) AS n, domain FROM domain_status
       WHERE dns_status = 'ok' AND (http_checked_at IS NULL OR http_checked_at < now() - INTERVAL ${MAX_AGE_DAYS} DAY)`);
const total = Number(((await c.runAndReadAll(`SELECT count(*) AS n FROM fetch_todo`)).getRowObjects()[0] as { n: bigint }).n);
console.log(JSON.stringify({ label: "to fetch", total }));

// Shard numbers continue from what is already on disk.
let part = readdirSync(OUT).filter((f) => /^part-\d+\.parquet$/.test(f)).length;
await c.run(`CREATE TEMP TABLE IF NOT EXISTS fetch_stage (
  domain VARCHAR, status INTEGER, final_url VARCHAR, title VARCHAR, description VARCHAR, text VARCHAR,
  text_chars INTEGER, error VARCHAR, blocked BOOLEAN, fetched_at TIMESTAMP)`);

let after = 0, done = 0;
const counts: Record<string, number> = {};
const bucket = (r: Fetched) => r.status == null ? (r.error?.startsWith("TimeoutError") ? "timeout" : r.error?.startsWith("worker_failed") ? "worker_failed" : "error") : r.status === 525 || r.status === 526 ? "tls" : r.blocked ? "blocked" : r.status >= 400 ? `http_${Math.floor(r.status / 100)}xx` : r.textChars >= 200 ? "usable" : "thin";
const t0 = performance.now();
for (;;) {
  const page = (await c.runAndReadAll(`SELECT domain FROM fetch_todo WHERE n > ${after} AND n <= ${after + PAGE}`)).getRowObjects() as Array<{ domain: string }>;
  if (!page.length) break;
  after += PAGE;
  const todo = (LIMIT ? page.slice(0, Math.max(0, LIMIT - done)) : page).map((p) => p.domain);
  const batches = Array.from({ length: Math.ceil(todo.length / BATCH) }, (_, i) => todo.slice(i * BATCH, (i + 1) * BATCH));
  const out: Fetched[][] = new Array(batches.length);
  let j = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, batches.length) }, async () => {
    while (j < batches.length) { const k = j++; out[k] = await fetchBatch(batches[k]); }
  }));
  const results = out.flat();
  const at = new Date().toISOString().replace("T", " ").replace("Z", "");

  await c.run(`DELETE FROM fetch_stage`);
  const a = await c.createAppender("fetch_stage");
  for (const r of results) {
    a.appendVarchar(r.domain);
    r.status == null ? a.appendNull() : a.appendInteger(r.status);
    r.finalUrl == null ? a.appendNull() : a.appendVarchar(r.finalUrl);
    a.appendVarchar(r.title); a.appendVarchar(r.description); a.appendVarchar(r.text);
    a.appendInteger(r.textChars);
    r.error == null ? a.appendNull() : a.appendVarchar(r.error);
    a.appendBoolean(r.blocked);
    a.appendVarchar(at);
    a.endRow();
  }
  a.flushSync();
  a.closeSync();
  const file = `${OUT}/part-${String(part++).padStart(5, "0")}.parquet`;
  // Text first, then status: a crash in between re-fetches the page rather than losing its text.
  await c.run(`COPY (SELECT domain, status, final_url, title, description, text, fetched_at FROM fetch_stage WHERE text_chars > 0 OR title <> '' OR description <> '')
    TO '${file}' (FORMAT parquet, COMPRESSION zstd)`);
  await c.run(`UPDATE domain_status s SET http_status = f.status, http_final_url = f.final_url, http_text_chars = f.text_chars,
      http_method = 'cf-worker', http_checked_at = f.fetched_at, http_error = f.error, http_blocked = f.blocked
    FROM fetch_stage f WHERE s.domain = f.domain`);

  for (const r of results) { const b = bucket(r); counts[b] = (counts[b] ?? 0) + 1; }
  done += todo.length;
  const secs = (performance.now() - t0) / 1000;
  console.log(JSON.stringify({ fetched: done, of: total, perSec: Math.round(done / secs), elapsedMin: Math.round(secs / 6) / 10, etaMin: Math.round((total - done) / Math.max(1, done / secs) / 60), counts }));
  if (LIMIT && done >= LIMIT) break;
}
const secs = (performance.now() - t0) / 1000;
console.log(JSON.stringify({ label: "fetch pass done", fetched: done, secs: Math.round(secs), counts }));
c.closeSync();
