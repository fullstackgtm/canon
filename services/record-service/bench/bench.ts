// Record service benchmark client (ported from scale-spike/bench.ts).
//
//   RECORD_SERVICE_URL=... RECORD_SERVICE_TOKEN=... npm run bench -- <cmd> [args]
//
//   seed <ws> <accounts>        provision + upsert synthetic accounts (contacts on 1 in 5)
//   run <ws> [samples=200]      list / 360 / search / count / facets p50/p95, annotate, signal writes/s, rescore
//   count <ws>                  total accounts (redeploy persistence check)
//   crash <ws>                  remote SIGKILL durability test (needs ALLOW_CRASH_ENDPOINT=1)
//
// Every latency is reported twice: as the client saw it (includes network) and
// as the server measured it (Server-Timing header), so network RTT is visible.
import { readFileSync } from "node:fs";
import { accountIdFor } from "../src/ops.ts";

const URL_ = (process.env.RECORD_SERVICE_URL ?? "").replace(/\/$/, "");
// RECORD_SERVICE_ENV_FILE (a private env file) lets the token stay off the command line.
const envFile = process.env.RECORD_SERVICE_ENV_FILE;
const TOKEN = process.env.RECORD_SERVICE_TOKEN ?? (envFile ? /RECORD_SERVICE_TOKEN=(\S+)/.exec(readFileSync(envFile, "utf8"))?.[1] : undefined) ?? "";
if (!URL_ || !TOKEN) {
  console.error("set RECORD_SERVICE_URL and RECORD_SERVICE_TOKEN");
  process.exit(2);
}

type Res = { status: number; json: any; clientMs: number; serverMs: number };
async function call(method: string, path: string, ws: string | null, body?: unknown): Promise<Res> {
  const t0 = performance.now();
  const r = await fetch(URL_ + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(ws ? { "x-workspace-id": ws } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const clientMs = performance.now() - t0;
  const serverMs = Number(/dur=([\d.]+)/.exec(r.headers.get("server-timing") ?? "")?.[1] ?? NaN);
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, clientMs, serverMs };
}
const post = (ws: string, p: string, b: unknown = {}) => call("POST", `/v1/workspaces/${ws}/${p}`, ws, b);
const must = (r: Res, what: string) => {
  if (r.status !== 200) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r;
};

const INDUSTRIES = ["Software", "Fintech", "Healthcare", "Manufacturing", "Retail", "Logistics", "Media", "Education", "Energy", "Insurance"];
const COUNTRIES = ["US", "US", "US", "GB", "DE", "CA", "FR", "AU", "NL", "SE"];
const WORDS = ["acme", "globex", "initech", "umbrella", "hooli", "stark", "wayne", "wonka", "tyrell", "cyber", "nova", "apex", "blue", "north", "quant"];
function account(i: number) {
  const w = `${WORDS[i % 15]}${WORDS[Math.floor(i / 15) % 15]}`;
  return {
    domain: `${w}-${i}.example.com`,
    name: `${w[0].toUpperCase()}${w.slice(1)} ${i}`,
    industry: INDUSTRIES[(i * 7) % 10],
    employees: 5 + ((i * 7919) % 20000),
    country: COUNTRIES[(i * 3) % 10],
    ownerId: `owner-${i % 25}`,
    segmentIds: [`seg-${i % 20}`],
  };
}
const ICP = { base: 10, industries: { software: 40, fintech: 30, healthcare: 10 }, countries: { us: 20, gb: 10 }, employeeBands: [{ min: 50, max: 2000, weight: 20 }] };

const pct = (xs: number[], q: number) => {
  const s = [...xs].filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10 : null;
};
function summarize(label: string, rs: Res[]) {
  const c = rs.map((r) => r.clientMs);
  const s = rs.map((r) => r.serverMs);
  return { op: label, n: rs.length, clientP50: pct(c, 0.5), clientP95: pct(c, 0.95), serverP50: pct(s, 0.5), serverP95: pct(s, 0.95) };
}

async function pool<T>(n: number, conc: number, fn: (i: number) => Promise<T>) {
  const out: T[] = new Array(n);
  let next = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (next < n) {
      const i = next++;
      out[i] = await fn(i);
    }
  }));
  return out;
}

async function seed(ws: string, n: number) {
  must(await post(ws, "provision"), "provision");
  must(await post(ws, "rescore", { icp: ICP }), "rescore");
  const B = 2500;
  const t0 = performance.now();
  await pool(Math.ceil(n / B), 4, async (b) => {
    const recs = Array.from({ length: Math.min(B, n - b * B) }, (_, j) => account(b * B + j));
    for (let attempt = 0; ; attempt++) {
      try {
        must(await post(ws, "accounts/upsert", { records: recs, source: "bench", idempotencyKey: `seed-a-${b}` }), "upsert");
        const contacts = recs.filter((_, j) => (b * B + j) % 5 === 0).flatMap((a, k) =>
          [0, 1, 2].map((m) => ({ accountDomain: a.domain, fullName: `Person ${b}-${k}-${m}`, title: ["VP Sales", "CRO", "SDR"][m], email: `p${m}@${a.domain}` })));
        if (contacts.length) must(await post(ws, "contacts/upsert", { records: contacts, source: "bench", idempotencyKey: `seed-c-${b}` }), "contacts");
        break;
      } catch (e) {
        if (attempt > 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    if (b % 20 === 0) console.error(`seeded ${Math.min(n, (b + 1) * B)} / ${n} (${Math.round((performance.now() - t0) / 1000)}s)`);
  });
  const total = must(await post(ws, "segments/count", { filter: {} }), "count").json.total;
  console.log(JSON.stringify({ seeded: total, secs: Math.round((performance.now() - t0) / 1000) }));
}

async function run(ws: string, samples: number) {
  const total = must(await post(ws, "segments/count", { filter: {} }), "count").json.total;
  const rnd = (k: number) => Math.floor(Math.random() * k);
  // warm up the workspace (first open loads the file)
  await post(ws, "accounts/list", { limit: 50 });
  const results: ReturnType<typeof summarize>[] = [];

  const listFilters = () => [
    { filter: { segmentId: `seg-${rnd(20)}` } },
    { filter: { industry: [INDUSTRIES[rnd(10)]], country: ["US"] }, sort: { field: "employees", dir: "desc" } },
    { filter: { ownerId: `owner-${rnd(25)}`, minFit: 50 } },
    { filter: { employeeMin: 100, employeeMax: 1000 }, sort: { field: "name", dir: "asc" } },
    {},
  ][rnd(5)];
  results.push(summarize("list (50 rows, filtered+sorted, with total)", await pool(samples, 4, () => post(ws, "accounts/list", { ...listFilters(), limit: 50 }).then((r) => must(r, "list")))));

  // ids are deterministic from the domain; every 5th account has contacts
  const idList = Array.from({ length: 500 }, () => accountIdFor(account(rnd(Math.floor(total / 5)) * 5).domain));
  results.push(summarize("account 360 (account + contacts + history)", await pool(samples, 4, (i) => post(ws, "accounts/get", { id: idList[i % idList.length] }).then((r) => must(r, "get")))));
  results.push(summarize("search (q substring, 25 rows)", await pool(samples, 4, () => post(ws, "accounts/list", { filter: { q: WORDS[rnd(15)] + WORDS[rnd(15)] }, limit: 25 }).then((r) => must(r, "search")))));
  results.push(summarize("segment count", await pool(samples, 4, () => post(ws, "segments/count", { filter: { segmentId: `seg-${rnd(20)}`, minFit: rnd(80) } }).then((r) => must(r, "count")))));

  // TAM explorer (1.4.0): annotate a slice with revenue + a trait, then group by each dimension.
  const annIds = Array.from({ length: 5000 }, (_, i) => accountIdFor(account(i * Math.max(1, Math.floor(total / 5000))).domain));
  results.push(summarize("annotate (500 accounts: revenue + trait)", await pool(10, 1, (b) => post(ws, "accounts/annotate", {
    records: annIds.slice(b * 500, b * 500 + 500).map((id, j) => ({ id, revenue: 1e6 * (1 + (j % 50)), revenueSource: "estimate", traits: { bench: j % 3 ? "yes" : "no" } })),
  }).then((r) => must(r, "annotate")))));
  const facetBodies = () => [
    { groupBy: "industry" },
    { groupBy: "sizeBand", filter: { industry: [INDUSTRIES[rnd(10)]] } },
    { groupBy: "region", filter: { industry: [INDUSTRIES[rnd(10)]], sizeBand: ["51-200", "201-500"] } },
    { groupBy: "trait:bench", filter: { region: ["north-america"] } },
    { groupBy: "segment" },
  ][rnd(5)];
  results.push(summarize("facets (treemap level: group by dimension, with filters)", await pool(samples, 4, () => post(ws, "accounts/facets", facetBodies()).then((r) => must(r, "facets")))));

  // Signal writes: concurrent single-record edits for 10s (group-committed by the single writer).
  const t0 = performance.now();
  let writes = 0;
  const edits: Res[] = [];
  await Promise.all(Array.from({ length: 32 }, async (_, w) => {
    while (performance.now() - t0 < 10_000) {
      const r = must(await post(ws, "records/edit", { object: "account", id: idList[rnd(idList.length)], patch: { ownerId: `sig-${w}-${writes}` }, actorId: "bench", idempotencyKey: `sig-${Date.now()}-${w}-${writes}` }), "edit");
      edits.push(r);
      writes++;
    }
  }));
  const writesPerSec = Math.round(writes / ((performance.now() - t0) / 1000));
  results.push(summarize("signal write (edit, 32 concurrent)", edits));

  const rs = must(await post(ws, "rescore", { icp: { ...ICP, base: 5 + rnd(10) } }), "rescore");
  console.log(JSON.stringify({ url: URL_, ws, accounts: total, results, writesPerSec, rescore: { rescored: rs.json.rescored, serverMs: rs.json.ms, clientMs: Math.round(rs.clientMs) } }, null, 2));
}

async function crash(ws: string) {
  must(await post(ws, "provision"), "provision");
  const up = must(await post(ws, "accounts/upsert", { records: Array.from({ length: 200 }, (_, i) => account(9_000_000 + i)), source: "crash", idempotencyKey: `crash-seed` }), "seed");
  const ids: string[] = up.json.ids;
  const acked = new Map<string, { version: number; owner: string }>();
  let stop = false;
  let n = 0;
  const writers = Array.from({ length: 16 }, async (_, w) => {
    while (!stop) {
      const i = n++;
      const id = ids[i % ids.length];
      const owner = `c${Date.now()}-${w}-${i}`;
      try {
        const r = await post(ws, "records/edit", { object: "account", id, patch: { ownerId: owner }, actorId: "crash", idempotencyKey: `crash-${owner}` });
        if (r.status === 200) acked.set(id, { version: r.json.version, owner });
      } catch {}
    }
  });
  await new Promise((r) => setTimeout(r, 3000));
  const c = await call("POST", "/admin/crash", null, {});
  if (c.status !== 202) throw new Error(`crash endpoint not enabled (${c.status}); set ALLOW_CRASH_ENDPOINT=1`);
  await new Promise((r) => setTimeout(r, 1500));
  stop = true;
  await Promise.allSettled(writers);
  const tKill = performance.now();
  for (;;) {
    try {
      const h = await call("GET", "/healthz", null);
      if (h.status === 200) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  let lost = 0;
  for (const [id, a] of acked) {
    const g = must(await post(ws, "accounts/get", { id }), "get").json.account;
    if (g.version < a.version || (g.version === a.version && g.ownerId !== a.owner)) lost++;
  }
  console.log(JSON.stringify({ ackedWrites: acked.size, lost, recoverySecs: Math.round((performance.now() - tKill) / 1000) }));
  if (lost) process.exit(1);
}

const [cmd, ws = "bench", arg] = process.argv.slice(2);
if (cmd === "seed") await seed(ws, Number(arg ?? 100_000));
else if (cmd === "run") await run(ws, Number(arg ?? 200));
else if (cmd === "count") console.log(JSON.stringify(must(await post(ws, "segments/count", { filter: {} }), "count").json));
else if (cmd === "crash") await crash(ws);
else {
  console.error("usage: bench <seed|run|count|crash> <ws> [arg]");
  process.exit(2);
}
