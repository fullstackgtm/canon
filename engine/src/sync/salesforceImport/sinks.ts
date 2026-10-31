/**
 * ImportSink implementations.
 *
 * - `httpSink`: record service contract 1.2.0 over HTTP
 *   (`Authorization: Bearer`, `X-Workspace-Id`).
 * - `memorySink`: an in-process model of the 1.2.0 upsert/merge semantics
 *   (sfId first, then the natural key; sfId unique per object; idempotency
 *   keys replay the stored result). Used by tests and the local real-org run
 *   until A's record service ships 1.2.0.
 */
import type { AccountInput, ContactInput, CustomRecordInput, ImportSink, MatchKey, ObjectDef, UpsertResult } from "./contracts.ts";

export function httpSink(opts: { baseUrl: string; token: string; ws: string; fetchImpl?: typeof fetch }): ImportSink {
  const f = opts.fetchImpl ?? fetch;
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${opts.baseUrl.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(opts.ws)}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.token}`, "X-Workspace-Id": opts.ws, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return (await res.json()) as T;
      // Retries are safe: every write carries an idempotency key.
      if ((res.status >= 500 || res.status === 429) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new Error(`record service ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
  };
  return {
    upsertAccounts: (body) => post("accounts/upsert", body),
    upsertContacts: (body) => post("contacts/upsert", body),
    defineObjects: (objects) => post("objects/define", { objects }),
    upsertCustom: (object, body) => post(`objects/${encodeURIComponent(object)}/upsert`, body),
  };
}

// ---------- in-memory model ----------

export type MemAccount = AccountInput & { id: string; source: string; version: number };
export type MemContact = ContactInput & { id: string; accountId: string; source: string; version: number };
export type MemCustom = { id: string; object: string; sfId?: string; fields: Record<string, unknown>; version: number };

export type MemorySink = ImportSink & {
  accounts: Map<string, MemAccount>;
  contacts: Map<string, MemContact>;
  custom: Map<string, Map<string, MemCustom>>;
  defs: Map<string, ObjectDef>;
  /** Count of sfId values held by more than one row, per object (acceptance: 0). */
  duplicateSfIds(): number;
  calls: { upserts: number; replays: number };
};

export function memorySink(seed?: { accounts?: AccountInput[]; source?: string }): MemorySink {
  const accounts = new Map<string, MemAccount>();
  const contacts = new Map<string, MemContact>();
  const custom = new Map<string, Map<string, MemCustom>>();
  const defs = new Map<string, ObjectDef>();
  const keys = new Map<string, UpsertResult>();
  const acctBySf = new Map<string, string>();
  const acctByDomain = new Map<string, string>();
  const ctBySf = new Map<string, string>();
  const ctByEmail = new Map<string, string>();
  const ctByLinkedin = new Map<string, string>();
  const ctByName = new Map<string, string>();
  let nextId = 1;
  const calls = { upserts: 0, replays: 0 };
  const newId = (p: string) => `${p}_${(nextId++).toString(36)}`;

  const replay = (key: string, run: () => UpsertResult): UpsertResult => {
    calls.upserts++;
    const seen = keys.get(key);
    if (seen) { calls.replays++; return seen; }
    const r = run();
    keys.set(key, r);
    return r;
  };

  function putAccount(a: AccountInput, source: string, matchBy: MatchKey[]): { id?: string; created?: boolean; reason?: string } {
    const domain = a.domain.toLowerCase();
    let id: string | undefined;
    for (const k of matchBy) {
      if (k === "sfId" && a.sfId) id = acctBySf.get(a.sfId);
      if (k === "domain") id = acctByDomain.get(domain);
      if (id) break;
    }
    if (!id && !matchBy.includes("domain")) id = acctByDomain.get(domain); // domain stays the natural key
    if (id) {
      const cur = accounts.get(id)!;
      if (a.sfId && cur.sfId && cur.sfId !== a.sfId) return { reason: `domain ${domain} is already linked to Salesforce Account ${cur.sfId} (duplicate domain in Salesforce)` };
      if (cur.domain !== domain && acctByDomain.has(domain)) return { reason: `domain ${domain} belongs to another account` };
      const next = { ...cur, ...strip(a), domain, source, version: cur.version + 1 };
      if (cur.domain !== domain) { acctByDomain.delete(cur.domain); acctByDomain.set(domain, id); }
      if (a.sfId) acctBySf.set(a.sfId, id);
      accounts.set(id, next);
      return { id, created: false };
    }
    id = newId("acc");
    accounts.set(id, { ...strip(a), domain, id, source, version: 1 });
    acctByDomain.set(domain, id);
    if (a.sfId) acctBySf.set(a.sfId, id);
    return { id, created: true };
  }

  function putContact(c: ContactInput, source: string, matchBy: MatchKey[]): { id?: string; created?: boolean; reason?: string } {
    const accountId = c.accountId ?? (c.accountDomain ? acctByDomain.get(c.accountDomain.toLowerCase()) : undefined);
    if (!accountId || !accounts.has(accountId)) return { reason: `account ${c.accountId ?? c.accountDomain} does not exist` };
    const email = c.email?.toLowerCase();
    const nameKey = `${accountId}|${c.fullName.toLowerCase()}`;
    let id: string | undefined;
    for (const k of matchBy) {
      if (k === "sfId" && c.sfId) id = ctBySf.get(c.sfId);
      if (k === "email" && email) id = ctByEmail.get(email);
      if (k === "linkedinUrl" && c.linkedinUrl) id = ctByLinkedin.get(c.linkedinUrl);
      if (id) break;
    }
    if (!id && !email && !c.linkedinUrl) id = ctByName.get(nameKey);
    if (id) {
      const cur = contacts.get(id)!;
      if (c.sfId && cur.sfId && cur.sfId !== c.sfId) return { reason: `${email ? `email ${email}` : "person"} is already linked to Salesforce record ${cur.sfId}` };
      if (email && cur.email !== email && ctByEmail.has(email)) return { reason: `email ${email} belongs to another contact` };
      contacts.set(id, { ...cur, ...strip(c), accountId, email: email ?? cur.email, source, version: cur.version + 1 });
      if (c.sfId) ctBySf.set(c.sfId, id);
      if (email) ctByEmail.set(email, id);
      return { id, created: false };
    }
    id = newId("con");
    contacts.set(id, { ...strip(c), email, accountId, id, source, version: 1 });
    if (c.sfId) ctBySf.set(c.sfId, id);
    if (email) ctByEmail.set(email, id);
    if (c.linkedinUrl) ctByLinkedin.set(c.linkedinUrl, id);
    ctByName.set(nameKey, id);
    return { id, created: true };
  }

  function bulk<T extends { sfId?: string }>(records: T[], put: (r: T) => { id?: string; created?: boolean; reason?: string }): UpsertResult {
    const out: UpsertResult = { upserted: 0, ids: [], created: 0, merged: 0, rejected: [] };
    records.forEach((r, index) => {
      const res = put(r);
      if (!res.id) { out.rejected.push({ index, ...(r.sfId ? { sfId: r.sfId } : {}), reason: res.reason ?? "rejected" }); return; }
      out.upserted++;
      out.ids.push(res.id);
      if (res.created) out.created++; else out.merged++;
    });
    return out;
  }

  for (const a of seed?.accounts ?? []) putAccount(a, seed?.source ?? "pdl", ["domain"]);

  return {
    accounts, contacts, custom, defs, calls,
    async upsertAccounts(body) {
      return replay(body.idempotencyKey, () => bulk(body.records, (a) => putAccount(a, body.source, body.merge?.matchBy ?? ["sfId", "domain"])));
    },
    async upsertContacts(body) {
      return replay(body.idempotencyKey, () => bulk(body.records, (c) => putContact(c, body.source, body.merge?.matchBy ?? ["sfId", "email", "linkedinUrl"])));
    },
    async defineObjects(objects) {
      for (const o of objects) defs.set(o.name, o);
      return { defined: objects.length };
    },
    async upsertCustom(object, body) {
      if (!defs.has(object)) throw new Error(`object ${object} is not defined`);
      let rows = custom.get(object);
      if (!rows) custom.set(object, (rows = new Map()));
      const bySf = new Map([...rows.values()].filter((r) => r.sfId).map((r) => [r.sfId!, r.id]));
      return replay(body.idempotencyKey, () =>
        bulk(body.records, (r: CustomRecordInput) => {
          const id = r.sfId ? bySf.get(r.sfId) : undefined;
          if (id) {
            const cur = rows!.get(id)!;
            rows!.set(id, { ...cur, fields: { ...cur.fields, ...r.fields }, version: cur.version + 1 });
            return { id, created: false };
          }
          const nid = newId("rec");
          rows!.set(nid, { id: nid, object, sfId: r.sfId, fields: r.fields, version: 1 });
          if (r.sfId) bySf.set(r.sfId, nid);
          return { id: nid, created: true };
        }),
      );
    },
    duplicateSfIds() {
      let dups = 0;
      const count = (ids: Array<string | undefined>) => {
        const m = new Map<string, number>();
        for (const id of ids) if (id) m.set(id, (m.get(id) ?? 0) + 1);
        for (const n of m.values()) if (n > 1) dups++;
      };
      count([...accounts.values()].map((a) => a.sfId));
      count([...contacts.values()].map((c) => c.sfId));
      for (const rows of custom.values()) count([...rows.values()].map((r) => r.sfId));
      return dups;
    },
  };
}

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
