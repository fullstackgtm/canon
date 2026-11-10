/**
 * TEST FIXTURE. Minimal Salesforce REST + Bulk API 2.0 query simulator for
 * the import engine. Workstream A owns the full simulator
 * (packages/sf-sim, `startSfSim`); this stand-in serves only what the import
 * reads, so B's tests run before A merges. Data is deterministic per seed.
 */
import { createServer, type Server } from "node:http";
import { toCsv } from "../sfClient.ts";

export type FakeRow = Record<string, string>;
export type FakeObject = { name: string; label: string; custom: boolean; fields: Array<{ name: string; type: string; referenceTo?: string[] }>; rows: FakeRow[] };

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 15-char fake ids with a real key prefix (001 Account, 003 Contact, 00Q Lead, a0X custom). */
export function fakeId(prefix: string, n: number): string {
  let s = "";
  let x = n;
  for (let i = 0; i < 9; i++) { s = B62[x % 62] + s; x = Math.floor(x / 62); }
  return `${prefix}000${s}`;
}

export type FakeDataset = {
  objects: Map<string, FakeObject>;
  /** Domains of accounts that also exist in the seeded TAM. */
  tamDomains: string[];
  expect: { accountsNoWebsite: number; accountDupDomains: number };
};

/**
 * `accounts` Accounts (3% no Website, 1% duplicate another account's domain),
 * `contacts` Contacts (2% Account-less with company email, 0.5% Account-less
 * free-mail -> rejected), `leads` Leads (10% converted), plus `custom`
 * Project__c rows referencing accounts. `tamOverlap` of the accounts share a
 * domain with the returned TAM list.
 */
export function generateDataset(opts: { seed?: number; accounts: number; contacts: number; leads?: number; custom?: number; tamOverlap?: number }): FakeDataset {
  const r = rng(opts.seed ?? 42);
  const objects = new Map<string, FakeObject>();
  const accRows: FakeRow[] = [];
  let noWebsite = 0;
  let dup = 0;
  for (let i = 0; i < opts.accounts; i++) {
    const x = r();
    let website = `https://www.company${i}.example/about`;
    if (x < 0.03) { website = ""; noWebsite++; }
    else if (x < 0.04 && i > 0) { website = `company${Math.floor(r() * i)}.example`; dup++; }
    accRows.push({
      Id: fakeId("001", i + 1),
      Name: `Company ${i}`,
      Website: website,
      Industry: ["Software", "Retail", "Banking", ""][i % 4],
      NumberOfEmployees: i % 5 === 0 ? "" : String(10 + (i % 1000)),
      BillingCountry: ["United States", "Canada", ""][i % 3],
    });
  }
  objects.set("Account", {
    name: "Account", label: "Account", custom: false,
    fields: ["Id", "Name", "Website", "Industry", "NumberOfEmployees", "BillingCountry"].map((n) => ({ name: n, type: n === "NumberOfEmployees" ? "int" : n === "Id" ? "id" : "string" })),
    rows: accRows,
  });

  const ctRows: FakeRow[] = [];
  for (let i = 0; i < opts.contacts; i++) {
    const x = r();
    const acct = Math.floor(r() * opts.accounts);
    let accountId = accRows[acct]?.Id ?? "";
    let email = `person${i}@company${acct}.example`;
    if (x < 0.02) { accountId = ""; email = `solo${i}@orphan${i % 50}.example`; }
    else if (x < 0.025) { accountId = ""; email = `person${i}@gmail.com`; }
    ctRows.push({ Id: fakeId("003", i + 1), AccountId: accountId, FirstName: `First${i}`, LastName: `Last${i}`, Name: `First${i} Last${i}`, Title: i % 3 ? "VP Sales" : "", Email: email });
  }
  objects.set("Contact", {
    name: "Contact", label: "Contact", custom: false,
    fields: ["Id", "AccountId", "FirstName", "LastName", "Name", "Title", "Email"].map((n) => ({ name: n, type: n === "AccountId" ? "reference" : "string" })),
    rows: ctRows,
  });

  const leadRows: FakeRow[] = [];
  for (let i = 0; i < (opts.leads ?? 0); i++) {
    leadRows.push({
      Id: fakeId("00Q", i + 1), FirstName: `Lead${i}`, LastName: "Person", Name: `Lead${i} Person`, Company: `LeadCo ${i % 300}`,
      Website: i % 4 === 0 ? "" : `leadco${i % 300}.example`, Email: `lead${i}@leadco${i % 300}.example`, Title: "", IsConverted: i % 10 === 0 ? "true" : "false",
    });
  }
  objects.set("Lead", {
    name: "Lead", label: "Lead", custom: false,
    fields: ["Id", "FirstName", "LastName", "Name", "Company", "Website", "Email", "Title", "IsConverted"].map((n) => ({ name: n, type: n === "IsConverted" ? "boolean" : "string" })),
    rows: leadRows,
  });

  if (opts.custom) {
    const rows: FakeRow[] = [];
    for (let i = 0; i < opts.custom; i++) {
      rows.push({ Id: fakeId("a0X", i + 1), Name: `Project ${i}`, Account__c: accRows[i % opts.accounts].Id, Budget__c: String(i * 100), Active__c: i % 2 ? "true" : "false", BillingAddress__c: "" });
    }
    objects.set("Project__c", {
      name: "Project__c", label: "Project", custom: true,
      fields: [
        { name: "Id", type: "id" }, { name: "Name", type: "string" }, { name: "Account__c", type: "reference", referenceTo: ["Account"] },
        { name: "Budget__c", type: "currency" }, { name: "Active__c", type: "boolean" }, { name: "BillingAddress__c", type: "address" },
      ],
      rows,
    });
  }

  const tamDomains: string[] = [];
  for (let i = 0; i < (opts.tamOverlap ?? 0); i++) {
    const w = accRows[i * 7]?.Website;
    if (w) tamDomains.push(w.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]);
  }
  return { objects, tamDomains: [...new Set(tamDomains)], expect: { accountsNoWebsite: noWebsite, accountDupDomains: dup } };
}

export type FakeSalesforce = {
  baseUrl: string;
  token: string;
  stop(): Promise<void>;
  calls: { rest: number; bulkJobs: number; resultPages: number; unauthorized: number };
  /** Make the next N authorized requests answer 401 (token expiry). */
  expireToken(): void;
};

export async function startFakeSalesforce(ds: FakeDataset, opts: { apiVersion?: string } = {}): Promise<FakeSalesforce> {
  const apiVersion = opts.apiVersion ?? "60.0";
  let token = "fake-token-1";
  const calls = { rest: 0, bulkJobs: 0, resultPages: 0, unauthorized: 0 };
  const jobs = new Map<string, { object: string; fields: string[]; polls: number }>();
  const prefix = `/services/data/v${apiVersion}`;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/csv" : "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${token}`) { calls.unauthorized++; return send(401, [{ errorCode: "INVALID_SESSION_ID" }]); }
    calls.rest++;
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const p = url.pathname;
      if (p === `${prefix}/sobjects`) {
        return send(200, { sobjects: [...ds.objects.values()].map((o) => ({ name: o.name, label: o.label, custom: o.custom, queryable: true })).concat([{ name: "Opportunity", label: "Opportunity", custom: false, queryable: false }]) });
      }
      const dm = p.match(/\/sobjects\/([^/]+)\/describe$/);
      if (dm) {
        const o = ds.objects.get(decodeURIComponent(dm[1]));
        return o ? send(200, { name: o.name, label: o.label, custom: o.custom, fields: o.fields.map((f) => ({ ...f, label: f.name })) }) : send(404, {});
      }
      if (p === `${prefix}/query`) {
        const q = url.searchParams.get("q") ?? "";
        const cm = q.match(/^SELECT COUNT\(\) FROM (\w+)$/i);
        if (cm) return send(200, { totalSize: ds.objects.get(cm[1])?.rows.length ?? 0, done: true, records: [] });
        const im = q.match(/^SELECT ([\w, ]+) FROM (\w+)(?: WHERE (Id|ParentId) IN \(([^)]*)\))?$/i);
        if (im) {
          const fields = im[1].split(",").map((s) => s.trim());
          const ids = im[3] ? new Set(im[4].split(",").map((s) => s.trim().replace(/'/g, "").slice(0, 15))) : null;
          const rows = (ds.objects.get(im[2])?.rows ?? []).filter((r) => !ids || ids.has((r[im[3]] ?? "").slice(0, 15)));
          return send(200, { totalSize: rows.length, done: true, records: rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f] ?? null]))) });
        }
        return send(400, [{ errorCode: "MALFORMED_QUERY", message: q }]);
      }
      if (p === `${prefix}/jobs/query` && req.method === "POST") {
        const { query } = JSON.parse(body) as { query: string };
        const m = query.match(/^SELECT (.+) FROM (\w+)$/i);
        if (!m || !ds.objects.has(m[2])) return send(400, [{ errorCode: "INVALIDJOB" }]);
        const id = `750${String(++calls.bulkJobs).padStart(12, "0")}`;
        jobs.set(id, { object: m[2], fields: m[1].split(",").map((s) => s.trim()), polls: 0 });
        return send(200, { id, state: "UploadComplete" });
      }
      const jm = p.match(/\/jobs\/query\/(\w+)(\/results)?$/);
      if (jm) {
        const job = jobs.get(jm[1]);
        if (!job) return send(404, {});
        const rows = ds.objects.get(job.object)!.rows;
        if (!jm[2]) {
          job.polls++;
          return send(200, { id: jm[1], state: job.polls < 2 ? "InProgress" : "JobComplete", numberRecordsProcessed: rows.length });
        }
        calls.resultPages++;
        const max = Number(url.searchParams.get("maxRecords") ?? 50000);
        const start = Number(url.searchParams.get("locator") ?? 0);
        const page = rows.slice(start, start + max);
        const next = start + max < rows.length ? String(start + max) : "null";
        return send(200, toCsv(job.fields, page), { "Sforce-Locator": next, "Sforce-NumberOfRecords": String(page.length) });
      }
      send(404, { error: p });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    get token() { return token; },
    calls,
    expireToken() { token = `fake-token-${Date.now()}`; },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
