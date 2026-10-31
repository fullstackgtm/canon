// Minimal Salesforce REST + CDC fake for the sync engine's tests and latency
// harness. It is a stand-in until workstream A's @fsgtm/sf-sim lands; it
// serves only what the sync engine calls:
//   GET  /services/data/vXX/query?q=   (Id IN (...) and SystemModstamp polling)
//   PATCH /services/data/vXX/sobjects/{Object}/{Id}
//   GET  /sim/cdc?replayId=            (Pub/Sub-shaped ChangeEventHeader events)
// Test-only (imports node:http); not exported from the package index.
import { createServer, type Server } from "node:http";

export type MiniSfOptions = {
  now?: () => number;
  token?: string;
  /** Seed: object -> records (must include Id). */
  records?: Record<string, Array<Record<string, unknown>>>;
  cdc?: boolean;
};

type Rec = Record<string, unknown> & { Id: string; SystemModstamp: number };

export async function startMiniSf(opts: MiniSfOptions = {}) {
  const now = opts.now ?? Date.now;
  let token = opts.token ?? "sim-token-1";
  const db = new Map<string, Map<string, Rec>>();
  const events: Array<{ replayId: number; payload: Record<string, unknown> }> = [];
  let writes = 0;
  const calls: string[] = [];
  for (const [obj, rows] of Object.entries(opts.records ?? {})) {
    const m = new Map<string, Rec>();
    for (const r of rows) m.set(String(r.Id), { SystemModstamp: now(), ...r, Id: String(r.Id) } as Rec);
    db.set(obj, m);
  }
  const table = (o: string) => {
    let m = db.get(o);
    if (!m) { m = new Map(); db.set(o, m); }
    return m;
  };
  const write = (obj: string, id: string, fields: Record<string, unknown>, origin: string) => {
    const rec = table(obj).get(id);
    if (!rec) return false;
    const ts = now();
    Object.assign(rec, fields, { SystemModstamp: Math.max(ts, rec.SystemModstamp + 1) });
    if (opts.cdc !== false) {
      events.push({
        replayId: events.length + 1,
        payload: {
          ChangeEventHeader: { entityName: obj, recordIds: [id], changeType: "UPDATE", changedFields: Object.keys(fields), commitTimestamp: rec.SystemModstamp, changeOrigin: origin },
          ...fields,
        },
      });
    }
    return true;
  };

  const runSoql = (q: string) => {
    const m = /^SELECT (.+?) FROM (\w+) WHERE (.+?)(?: ORDER BY SystemModstamp ASC, Id ASC)?(?: LIMIT (\d+))?$/i.exec(q.trim());
    if (!m) throw new Error(`unsupported soql: ${q}`);
    const cols = m[1].split(",").map((s) => s.trim());
    const rows = [...table(m[2]).values()];
    let hits: Rec[];
    const idIn = /^Id IN \((.*)\)$/i.exec(m[3]);
    const since = /^\(?SystemModstamp > (\S+?)(?: OR \(SystemModstamp = \S+ AND Id > '(\w+)'\)\))?$/i.exec(m[3]);
    if (idIn) {
      const ids = new Set(idIn[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")));
      hits = rows.filter((r) => ids.has(r.Id));
    } else if (since) {
      const t = Date.parse(since[1]);
      const after = since[2];
      hits = rows
        .filter((r) => r.SystemModstamp > t || (after !== undefined && r.SystemModstamp === t && r.Id > after))
        .sort((a, b) => a.SystemModstamp - b.SystemModstamp || (a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0));
      if (m[4]) hits = hits.slice(0, Number(m[4]));
    } else throw new Error(`unsupported where: ${m[3]}`);
    return hits.map((r) => {
      const o: Record<string, unknown> = { attributes: { type: m[2] } };
      for (const c of cols) o[c] = c === "SystemModstamp" ? new Date(r.SystemModstamp).toISOString() : (r[c] ?? null);
      return o;
    });
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    calls.push(`${req.method} ${url.pathname}`);
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, [{ errorCode: "INVALID_SESSION_ID" }]);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        if (req.method === "GET" && url.pathname === "/sim/cdc") {
          const after = Number(url.searchParams.get("replayId") ?? 0);
          const batch = events.filter((e) => e.replayId > after).slice(0, 500);
          return send(200, { events: batch, latestReplayId: events.length });
        }
        if (req.method === "GET" && /\/services\/data\/v[\d.]+\/query$/.test(url.pathname)) {
          const records = runSoql(url.searchParams.get("q") ?? "");
          return send(200, { totalSize: records.length, done: true, records });
        }
        const p = /\/services\/data\/v[\d.]+\/sobjects\/(\w+)\/(\w+)$/.exec(url.pathname);
        if (req.method === "PATCH" && p) {
          const ok = write(p[1], p[2], JSON.parse(raw || "{}"), "com/salesforce/api/rest/62.0");
          if (!ok) return send(404, [{ errorCode: "NOT_FOUND" }]);
          writes++;
          return send(204);
        }
        send(404, [{ errorCode: "NOT_FOUND" }]);
      } catch (e) {
        send(400, [{ errorCode: "MALFORMED_QUERY", message: String(e) }]);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    token: () => token,
    rotateToken() { token = `sim-token-${Math.random().toString(36).slice(2)}`; return token; },
    /** A Salesforce user's edit (UI): changeOrigin is empty. */
    edit: (obj: string, id: string, fields: Record<string, unknown>) => write(obj, id, fields, ""),
    get: (obj: string, id: string) => table(obj).get(id),
    writeCount: () => writes,
    calls: () => calls.slice(),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
