// One register of accounts and contacts (docs/cp0-object-layer.md, "One register
// of accounts and contacts", contract 1.8.0).
//
// The `accounts` and `contacts` tables hold every company and person the
// workspace knows. A row linked to a ledger stream (`stream`) takes its registry
// fields only from the ledger: the projector calls writeBackRegister in the same
// transaction that applies the stream's entries, so the row, its field history
// and the outbox move together. Derived and TAM-only columns (fit, segments,
// revenue estimates, traits, sfId, emailStatus, a contact's status) stay the
// service's own.
import { createHash } from "node:crypto";
import type { DuckDBConnection } from "@duckdb/node-api";
import { project, type FoldState } from "./core/objects/fold.ts";
import type { ResolvedObjectDef } from "./core/objects/registry.ts";
import { REGISTER_COLUMNS } from "./core/objects/listSpec.ts";
import { all, lit } from "./db.ts";
import { accountIdFor, linkContactsByDomain, normDomain, refitAccountsOfContacts, refitSql, parseFua, writeChanges, writeHistory } from "./upsert.ts";

export type RegisterObject = "account" | "contact";
export const REGISTER_OBJECTS: readonly RegisterObject[] = ["account", "contact"];
export const isRegisterObject = (o: string): o is RegisterObject => o === "account" || o === "contact";

type Spec = {
  table: "accounts" | "contacts";
  /** Registry fieldId -> column, for the fields the ledger owns on a linked row. Custom fields go to `custom`. */
  columns: Readonly<Record<string, string>>;
  /** Columns that cannot hold null, and what a value the ledger cleared is stored as. */
  emptyAs: Readonly<Record<string, string>>;
  /** The natural key an unlinked row is found by, from the projected values. */
  key: (values: Record<string, unknown>) => { column: string; value: string } | null;
  /** The id a new row gets: the one a TAM upsert of the same record would compute. */
  idFor: (values: Record<string, unknown>, streamId: string) => string;
};

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 20);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

const SPECS: Record<RegisterObject, Spec> = {
  account: {
    table: "accounts",
    columns: REGISTER_COLUMNS.account,
    emptyAs: { name: "", domain: "", status: "new" },
    key: (v) => {
      const d = text(v.domain);
      return d ? { column: "domain", value: normDomain(d) } : null;
    },
    idFor: (v, streamId) => (text(v.domain) ? accountIdFor(text(v.domain)!) : `acc_s_${h(streamId)}`),
  },
  contact: {
    table: "contacts",
    columns: REGISTER_COLUMNS.contact,
    emptyAs: { fullName: "" },
    key: (v) => {
      const e = text(v.email);
      return e ? { column: "email", value: e.toLowerCase() } : null;
    },
    idFor: (v, streamId) => (text(v.email) ? `con_${h(`e:${text(v.email)!.toLowerCase()}`)}` : `con_s_${h(streamId)}`),
  },
};

/** The record-service id a stream was seeded from: a `record:<object>:<id>` source among its facts. */
const seededFrom = (object: RegisterObject, st: FoldState) => refsWith(`record:${object}:`, st);

/** The Salesforce ids a stream's Salesforce sources name (`salesforce:<object>:<sfId>`, lib/canon/partyLedger.ts partySource). */
const salesforceIds = (object: RegisterObject, st: FoldState) => refsWith(`salesforce:${object}:`, st);

/** What follows `prefix` in every source ref among a stream's facts and snapshot watermarks. */
function refsWith(prefix: string, st: FoldState): string[] {
  const ids = new Set<string>();
  for (const f of Object.values(st.fields)) {
    for (const fact of [...f.candidates, ...f.pending, ...f.observed]) {
      if (fact.sourceRef.startsWith(prefix)) ids.add(fact.sourceRef.slice(prefix.length));
    }
  }
  // A snapshot's watermark outlives facts a later value superseded.
  for (const w of st.watermarks) if (w.sourceRef.startsWith(prefix)) ids.add(w.sourceRef.slice(prefix.length));
  return [...ids];
}

/** What the ledger says a linked row's owned columns hold. A domain is stored normalized, as upserts store it. */
/** Which source a column's value came from, and when that value became true: its outbox origin and its fieldUpdatedAt. */
/** `merged`: the value is one a merge picked (CP15a, a `…:merge:<id>` source), which the outbox marks so no CRM sync pushes it. */
type Winner = { kind: string; at: number | null; actor: string; merged?: true };

/** A source ref a merge or its undo wrote under (lib/canon/partyMerge.ts). */
export const isMergeRef = (ref: string) => ref.includes(":merge:") || ref.includes(":unmerge:");

function ownedValues(object: RegisterObject, def: ResolvedObjectDef, st: FoldState): {
  values: Record<string, unknown>; byColumn: Map<string, unknown>; custom: Record<string, unknown> | null; deletedAt: number | null; winners: Map<string, Winner>;
} {
  const spec = SPECS[object];
  const row = project(def, st);
  const winnerOf = (fieldId: string): Winner => {
    const meta = row.meta[fieldId];
    const fact = meta?.factId ? st.fields[fieldId]?.candidates.find((f) => f.factId === meta.factId) : undefined;
    const kind = meta?.sourceKind ?? "ledger";
    // A person's fact names them in its source (`user:<userId>:…`); any other source acts as itself.
    const actor = fact && kind === "user" ? fact.sourceRef.split(":")[1] || "user" : kind;
    return { kind, at: fact ? fact.validFrom ?? fact.observedAt : null, actor, ...(fact && isMergeRef(fact.sourceRef) ? { merged: true as const } : {}) };
  };
  const values: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(row.values)) {
    const f = def.byFieldId.get(fieldId as never);
    if (f) values[f.apiName] = value;
  }
  const byColumn = new Map<string, unknown>();
  const winners = new Map<string, Winner>();
  // An erased record keeps nothing: every owned column is cleared, not left as the row had it.
  if (st.lifecycle.status === "erased") {
    for (const column of Object.values(spec.columns)) {
      byColumn.set(column, Object.hasOwn(spec.emptyAs, column) ? spec.emptyAs[column] : null);
      winners.set(column, { kind: "ledger", at: st.lifecycle.at, actor: "ledger" });
    }
    winners.set("custom", { kind: "ledger", at: st.lifecycle.at, actor: "ledger" });
    return { values: {}, byColumn, custom: null, deletedAt: st.lifecycle.at, winners };
  }
  for (const [apiName, column] of Object.entries(spec.columns)) {
    const f = def.byApiName.get(apiName);
    // A field the ledger never resolved is left as the row has it (dealRowPatch's rule): a stream that never
    // asserted a country does not clear the one a TAM import found.
    if (!f || !row.meta[f.fieldId]?.factId) continue;
    let v = values[apiName] ?? null;
    if (column === "domain" && typeof v === "string") v = normDomain(v) || null;
    // A cleared value clears the row too; a column that cannot be null takes its empty form (a released domain is "", never matched).
    if (v === null && Object.hasOwn(spec.emptyAs, column)) v = spec.emptyAs[column];
    byColumn.set(column, v);
    winners.set(column, winnerOf(f.fieldId));
  }
  // A person's other emails and phones never repeat their primary, whichever sources the two fields resolved from.
  for (const [primary, others] of [["email", "additionalEmails"], ["phone", "additionalPhones"]] as const) {
    const list = byColumn.get(others);
    const p = String(byColumn.get(primary) ?? values[primary] ?? "").trim().toLowerCase();
    if (object !== "contact" || !Array.isArray(list) || !p) continue;
    const kept = list.filter((x) => String(x).trim().toLowerCase() !== p);
    if (kept.length !== list.length) byColumn.set(others, kept.length ? kept : null);
  }
  const custom: Record<string, unknown> = {};
  let customWinner: Winner | null = null;
  for (const [apiName, v] of Object.entries(values)) {
    if (!apiName.startsWith("custom.") || v === null) continue;
    custom[apiName] = v;
    const w = winnerOf(def.byApiName.get(apiName)!.fieldId);
    if (!customWinner || (w.at ?? 0) > (customWinner.at ?? 0)) customWinner = w;
  }
  winners.set("custom", customWinner ?? { kind: "ledger", at: null, actor: "ledger" });
  const deletedAt = st.lifecycle.status === "active" ? null : st.lifecycle.at;
  return { values, byColumn, custom: Object.keys(custom).length ? custom : null, deletedAt, winners };
}

/** Register columns that hold a list (a person's other emails and phones, 1.28.0): bound as JSON and read back as VARCHAR[]. */
const LIST_COLUMNS: ReadonlySet<string> = new Set(["additionalEmails", "additionalPhones"]);
const listParam = (v: unknown) => (Array.isArray(v) && v.length ? JSON.stringify(v) : null);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const str = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));

/** A value as DuckDB returns it, for comparison: integers come back as bigint or number, JSON as text. */
function cell(column: string, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  if (column === "custom" && typeof v === "string") return JSON.parse(v);
  return v;
}

/**
 * Link each stream to its register row and write the ledger's values back.
 * Each changed field's outbox row and history name the source and actor of its
 * winning value, so the Salesforce sync skips its own changes.
 * Returns the ids written, per stream.
 */
export async function writeBackRegister(
  c: DuckDBConnection,
  object: RegisterObject,
  def: ResolvedObjectDef,
  states: readonly FoldState[],
  now: number,
  /** Streams a merge's undo reverted (a `revert` entry): every column it changes goes out as op `merge`, never pushed to a CRM. */
  reverted: ReadonlySet<string> = new Set(),
): Promise<Map<string, string>> {
  const spec = SPECS[object];
  const written = new Map<string, string>();
  const refit: string[] = [];
  // Domains an account row took here: the contacts waiting for them link once the loop is done.
  const domains: string[] = [];
  for (const st of states) {
    const { values, byColumn, custom, deletedAt, winners } = ownedValues(object, def, st);
    const kindOf = (column: string) => winners.get(column)?.kind ?? "ledger";
    const actorOf = (column: string) => winners.get(column)?.actor ?? "ledger";
    // Changed columns grouped by the source each value came from: each group's history and outbox row name it,
    // so the Salesforce sync skips exactly the fields Salesforce set and pushes everyone else's.
    const bySource = (columns: readonly string[]) => {
      const groups = new Map<string, string[]>();
      for (const col of columns) groups.set(kindOf(col), [...(groups.get(kindOf(col)) ?? []), col]);
      return groups;
    };
    const valueOf = (col: string) => (col === "custom" ? custom : byColumn.get(col));

    let row: Record<string, unknown> | undefined = (await all(c, `SELECT * FROM ${spec.table} WHERE stream = $s LIMIT 1`, { s: st.streamId }))[0];
    if (!row) {
      const seeded = seededFrom(object, st);
      if (seeded.length) {
        row = (await all(c, `SELECT * FROM ${spec.table} WHERE id IN (${seeded.map(lit).join(", ")}) AND (stream IS NULL OR stream = $s) ORDER BY id LIMIT 1`, { s: st.streamId }))[0];
      }
    }
    // A Salesforce-imported row is the record its Salesforce id names, whatever else it lacks (a contact with no email).
    const sfIds = salesforceIds(object, st);
    if (!row && sfIds.length) {
      row = (await all(c, `SELECT * FROM ${spec.table} WHERE sfId IN (${sfIds.map(lit).join(", ")}) AND stream IS NULL ORDER BY id LIMIT 1`))[0];
    }
    const key = spec.key(values);
    if (!row && key) {
      const match = object === "account" ? `domain = $k` : `lower(email) = $k`;
      // A row another Salesforce record holds is not this one, whatever its domain or email says.
      const sameSf = sfIds.length ? ` AND (sfId IS NULL OR sfId IN (${sfIds.map(lit).join(", ")}))` : "";
      row = (await all(c, `SELECT * FROM ${spec.table} WHERE ${match} AND stream IS NULL${sameSf} ORDER BY id LIMIT 1`, { k: key.value }))[0];
    }

    if (!row) {
      if (deletedAt !== null && st.lifecycle.status !== "deleted") continue; // merged or erased before it ever had a row
      let id = spec.idFor(values, st.streamId);
      const taken = (await all(c, `SELECT id FROM ${spec.table} WHERE id = $id LIMIT 1`, { id }))[0];
      if (taken) id = `${spec.table === "accounts" ? "acc" : "con"}_s_${h(st.streamId)}`;
      const latest = [...winners.entries()].filter(([col]) => byColumn.has(col)).sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))[0]?.[1];
      // Keep the Salesforce link on a new row, when exactly one id names it and no other row holds it.
      const sfId = sfIds.length === 1 && !(await all(c, `SELECT id FROM ${spec.table} WHERE sfId = $sf LIMIT 1`, { sf: sfIds[0] }))[0] ? sfIds[0] : null;
      await insertRow(c, object, id, st, byColumn, custom, deletedAt, values, `ledger:${latest?.kind ?? "ledger"}`, now, winners, sfId);
      for (const [kind, cols] of bySource([...byColumn.keys()])) {
        await writeChanges(c, [{ object, id, values: Object.fromEntries(cols.map((col) => [col, valueOf(col)])) }], "upsert", kind, now);
      }
      if (object === "account") refit.push(id);
      if (object === "account" && byColumn.get("domain")) domains.push(byColumn.get("domain") as string);
      written.set(st.streamId, id);
      continue;
    }

    const id = String(row.id);
    // A domain waiting for its holder is dropped once the ledger wants another (or none).
    if (object === "account") {
      await c.run(`DELETE FROM register_pending WHERE stream = $s AND domain IS DISTINCT FROM $d`, { s: st.streamId, d: (byColumn.get("domain") as string | undefined) ?? null });
    }
    const changed: string[] = [];
    for (const [column, v] of byColumn) if (!same(cell(column, row[column]), v)) changed.push(column);
    if (!same(cell("custom", row.custom), custom)) changed.push("custom");

    // A domain the ledger moved to that an unlinked row holds is the same company by identity: fold that row into this one.
    // Only a real domain is an identity: a cleared one ("") matches nothing.
    if (object === "account" && changed.includes("domain") && byColumn.get("domain")) {
      const domain = byColumn.get("domain") as string;
      const holder = (await all(c, `SELECT * FROM accounts WHERE domain = $d AND id <> $id LIMIT 1`, { d: domain, id }))[0];
      // Two Salesforce records cannot be one company here: keep the row's domain rather than lose either link.
      // The stream's own Salesforce ids count, even when the row was linked by its record id and has none yet.
      const ours = row.sfId != null ? [String(row.sfId)] : sfIds;
      const sfClash = holder && holder.sfId != null && ours.length > 0 && !ours.includes(String(holder.sfId));
      if (holder && (holder.stream != null || sfClash)) {
        changed.splice(changed.indexOf("domain"), 1);
        // Another record still holds it (the projector can apply a claim before the release that frees it): retry once free.
        if (holder.stream != null && !sfClash) {
          await c.run(`DELETE FROM register_pending WHERE stream = $s`, { s: st.streamId });
          await c.run(`INSERT INTO register_pending VALUES ($s, $d, $at, $kind, $actor)`, {
            s: st.streamId, d: domain, at: winners.get("domain")?.at ?? now, kind: kindOf("domain"), actor: actorOf("domain"),
          });
        }
      }
      else if (holder) {
        await foldAccount(c, row, holder, now);
        row = (await all(c, `SELECT * FROM accounts WHERE id = $id`, { id }))[0];
        await writeChanges(c, [{ object: "account", id: String(holder.id), values: { mergedInto: id } }], "delete", kindOf("domain"), now);
      }
    }

    const sets = [`stream = $s`, `ledgerVersion = $lv`, `deletedAt = $del`, `mergedInto = $mi`];
    const params: Record<string, unknown> = {
      id, s: st.streamId, lv: st.version, del: deletedAt === null ? null : deletedAt, mi: st.lifecycle.status === "merged" ? st.lifecycle.into : null,
    };
    // A row linked by domain or email takes the stream's Salesforce identity, as a new row does: the sync finds it by it.
    if (row.sfId == null && sfIds.length === 1 && !(await all(c, `SELECT id FROM ${spec.table} WHERE sfId = $sf LIMIT 1`, { sf: sfIds[0] }))[0]) {
      sets.push(`sfId = $sf`);
      params.sf = sfIds[0];
    }
    if (changed.length) {
      const fua = parseFua(row.fieldUpdatedAt);
      changed.forEach((column, i) => {
        sets.push(LIST_COLUMNS.has(column) ? `${column} = from_json($v${i}, '["VARCHAR"]')` : `${column} = $v${i}`);
        params[`v${i}`] = column === "custom" ? (custom === null ? null : JSON.stringify(custom)) : LIST_COLUMNS.has(column) ? listParam(byColumn.get(column)) : byColumn.get(column);
        // When the value became true at its source (a Salesforce commit time), not when it was written back:
        // the Salesforce sync compares these against later events.
        fua[column] = winners.get(column)?.at ?? now;
      });
      for (const col of byColumn.keys()) if (!changed.includes(col) && winners.get(col)?.at != null) fua[col] = winners.get(col)!.at!;
      const latest = changed.map((col) => winners.get(col)).sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0))[0];
      sets.push(`fieldUpdatedAt = $fua::JSON`, `source = $src`, `updatedAt = $now`, `version = version + 1`);
      Object.assign(params, { fua: JSON.stringify(fua), src: `ledger:${latest?.kind ?? "ledger"}`, now });
      for (const [kind, cols] of bySource(changed)) {
        // Each field's history names whoever set its winning value.
        for (const who of new Set(cols.map(actorOf))) {
          await writeHistory(c, cols.filter((col) => actorOf(col) === who).map((column) => ({
            object, id, field: column, oldValue: str(cell(column, row![column])), newValue: str(valueOf(column)),
          })), who, `ledger:${kind}`, now);
        }
        // A value a merge picked goes out as op `merge`, which no CRM sync pushes (a merge never writes to a CRM).
        for (const merged of [false, true]) {
          const part = cols.filter((col) => (reverted.has(st.streamId) || Boolean(winners.get(col)?.merged)) === merged);
          if (part.length) await writeChanges(c, [{ object, id, values: Object.fromEntries(part.map((col) => [col, valueOf(col)])) }], merged ? "merge" : "edit", kind, now);
        }
      }
      if (object === "account" && changed.some((col) => col === "industry" || col === "country" || col === "employees" || col === "custom")) refit.push(id);
    }
    // Every owned column's time is when its winning value became true, changed or not (a newer confirmation
    // of the same value, or a link to a row that already had it): the Salesforce sync compares these.
    if (!changed.length) {
      const fua = parseFua(row.fieldUpdatedAt);
      const synced = { ...fua };
      for (const col of byColumn.keys()) if (winners.get(col)?.at != null) synced[col] = winners.get(col)!.at!;
      if (JSON.stringify(synced) !== JSON.stringify(fua)) {
        sets.push(`fieldUpdatedAt = $fua::JSON`);
        params.fua = JSON.stringify(synced);
      }
    }
    await c.run(`UPDATE ${spec.table} SET ${sets.join(", ")} WHERE id = $id`, params as never);
    if (object === "account" && changed.includes("domain")) await c.run(`DELETE FROM register_pending WHERE stream = $s`, { s: st.streamId });
    if (object === "account" && changed.includes("domain") && byColumn.get("domain")) domains.push(byColumn.get("domain") as string);
    written.set(st.streamId, id);
  }
  if (object === "contact") {
    await linkContactsByDomain(c, now, { contactIds: [...written.values()] });
    await refitAccountsOfContacts(c, [...written.values()]);
  }
  else await linkContactsByDomain(c, now, { domains });
  if (object === "account") await retryPendingDomains(c, now, refit);
  if (refit.length) {
    await c.run(refitSql(`WHERE a.id IN (${refit.map(lit).join(", ")})`));
  }
  return written;
}

async function insertRow(
  c: DuckDBConnection, object: RegisterObject, id: string, st: FoldState, byColumn: Map<string, unknown>,
  custom: Record<string, unknown> | null, deletedAt: number | null, values: Record<string, unknown>, source: string, now: number,
  winners: ReadonlyMap<string, Winner>,
  sfId: string | null,
) {
  const cols: Record<string, unknown> = Object.fromEntries(byColumn);
  if (object === "account") {
    cols.domain ??= "";
    cols.name ??= text(values.name) ?? "";
    cols.status ??= "new";
  } else {
    cols.fullName ??= text(values.fullName) ?? "";
    // Which account a person works at arrives with associations (CP3).
    cols.accountId = "";
    cols.status = "new";
  }
  Object.assign(cols, {
    id, stream: st.streamId, ledgerVersion: st.version, deletedAt, sfId, custom: custom === null ? null : JSON.stringify(custom),
    source, updatedAt: now, version: 1, fieldUpdatedAt: JSON.stringify(Object.fromEntries([...byColumn.keys()].map((k) => [k, winners.get(k)?.at ?? now]))),
  });
  const names = Object.keys(cols);
  const casts: Record<string, string> = { custom: "::JSON", fieldUpdatedAt: "" };
  const placeholder = (n: string, i: number) => (LIST_COLUMNS.has(n) ? `from_json($p${i}, '["VARCHAR"]')` : `$p${i}${casts[n] ?? ""}`);
  await c.run(`INSERT INTO ${SPECS[object].table} (${names.join(", ")}) VALUES (${names.map(placeholder).join(", ")})`,
    Object.fromEntries(names.map((n, i) => [`p${i}`, (LIST_COLUMNS.has(n) ? listParam(cols[n]) : cols[n]) as never])));
}

/**
 * Domains linked rows wait for: each lands once every other row holding it is
 * itself moving to another domain. Resolved as a set, so accounts that swapped
 * domains on the ledger swap them here too, whatever order they were applied in.
 */
async function retryPendingDomains(c: DuckDBConnection, now: number, refit: string[]) {
  const pending = await all(c, `SELECT p.stream, p.domain, p.since, p.kind, p.actor, a.id, a.domain AS current, a.fieldUpdatedAt FROM register_pending p
    JOIN accounts a ON a.stream = p.stream`);
  if (!pending.length) return;
  const holders = await all(c, `SELECT stream, domain FROM accounts WHERE domain IN (${pending.map((p) => lit(String(p.domain))).join(", ")})`);
  // The largest set of moves whose every holder is a row in the set: shrink until nothing blocks.
  const moving = new Set(pending.map((p) => String(p.stream)));
  for (let shrunk = true; shrunk;) {
    shrunk = false;
    for (const p of pending) {
      const stream = String(p.stream);
      if (!moving.has(stream)) continue;
      const blocked = holders.some((h) => h.domain === p.domain && h.stream !== stream && (h.stream == null || !moving.has(String(h.stream))));
      if (blocked) (moving.delete(stream), (shrunk = true));
    }
  }
  for (const r of pending.filter((p) => moving.has(String(p.stream)))) {
    const fua = { ...parseFua(r.fieldUpdatedAt), domain: Number(r.since) };
    await c.run(`UPDATE accounts SET domain = $d, fieldUpdatedAt = $fua::JSON, source = $src, updatedAt = $now, version = version + 1 WHERE id = $id`,
      { d: String(r.domain), fua: JSON.stringify(fua), src: `ledger:${r.kind}`, now, id: String(r.id) });
    await writeHistory(c, [{ object: "account", id: String(r.id), field: "domain", oldValue: str(r.current), newValue: String(r.domain) }], String(r.actor), `ledger:${r.kind}`, now);
    await writeChanges(c, [{ object: "account", id: String(r.id), values: { domain: String(r.domain) } }], "edit", String(r.kind), now);
    await c.run(`DELETE FROM register_pending WHERE stream = $s`, { s: String(r.stream) });
    refit.push(String(r.id));
  }
}

/**
 * Fold an unlinked account row into a linked one that took its domain: its
 * contacts move over, and the service's own columns the linked row lacks (the
 * Salesforce id, revenue) come with it; segments and traits are combined,
 * the linked row's winning where both have a value. Then the duplicate goes.
 */
async function foldAccount(c: DuckDBConnection, into: Record<string, unknown>, from: Record<string, unknown>, now: number) {
  const fua = { ...parseFua(from.fieldUpdatedAt), ...parseFua(into.fieldUpdatedAt) };
  const segments = [...new Set([...((from.segmentIds as string[] | null) ?? []), ...((into.segmentIds as string[] | null) ?? [])])];
  const traits = { ...(from.traits ? JSON.parse(String(from.traits)) : {}), ...(into.traits ? JSON.parse(String(into.traits)) : {}) };
  const revenueFrom = into.revenue == null ? from : into;
  await c.run(`UPDATE contacts SET accountId = $to WHERE accountId = $from`, { to: String(into.id), from: String(from.id) });
  await c.run(`DELETE FROM accounts WHERE id = $from`, { from: String(from.id) });
  await c.run(`UPDATE accounts SET sfId = $sf, segmentIds = from_json($seg, '["VARCHAR"]'), traits = $traits, revenue = $rev, revenueSource = $rs, revenueConfidence = $rc,
      fieldUpdatedAt = $fua::JSON, updatedAt = $now WHERE id = $id`, {
    id: String(into.id), sf: (into.sfId ?? from.sfId ?? null) as string | null, seg: JSON.stringify(segments), traits: JSON.stringify(traits),
    rev: (revenueFrom.revenue ?? null) as number | null, rs: (revenueFrom.revenueSource ?? null) as string | null, rc: (revenueFrom.revenueConfidence ?? null) as number | null,
    fua: JSON.stringify(fua), now,
  });
}

/** Columns a linked row takes only from the ledger: an upsert or edit leaves them alone. */
export const LEDGER_OWNED: Record<RegisterObject, ReadonlySet<string>> = {
  account: new Set([...Object.values(SPECS.account.columns), "custom"]),
  contact: new Set([...Object.values(SPECS.contact.columns), "custom"]),
};
