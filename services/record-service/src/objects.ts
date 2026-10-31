// Metadata-driven objects (design doc §1.2): object definitions plus generic
// records for custom objects and standard objects with no typed table.
import { createHash, randomUUID } from "node:crypto";
import type {
  CustomRecordRow, DefineObjectsBody, EditObjectBody, EditResult, FieldType, ListObjectsBody, ListObjectsResult, ObjectDef,
  UpsertObjectsBody, UpsertResult,
} from "./contract.ts";
import { all, lit, one, type Params } from "./db.ts";
import { HttpError } from "./errors.ts";
import { parseFua, priorResult, saveResult, writeChanges, writeHistory } from "./upsert.ts";
import type { Workspace } from "./workspace.ts";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const recordIdFor = (object: string, key: string) => `cr_${h(`${object}:${key}`)}`;
type Def = { name: string; label: string; fields: Map<string, FieldType> };

export async function defineObjects(ws: Workspace, body: DefineObjectsBody): Promise<{ defined: number }> {
  const byName = new Map<string, ObjectDef>();
  for (const o of body.objects) byName.set(o.name, o); // last wins
  return ws.write(async (c) => {
    const now = Date.now();
    const names = [...byName.keys()];
    await c.run(`DELETE FROM object_definitions WHERE name IN (${names.map(lit).join(",")})`);
    const shape = JSON.stringify({ name: "VARCHAR", label: "VARCHAR", fields: "VARCHAR" });
    await c.run(`INSERT INTO object_definitions (name, label, fields, updatedAt)
      SELECT name, label, fields::JSON, $now FROM (SELECT unnest(from_json($j, '[${shape}]'), recursive := true))`, {
      j: JSON.stringify([...byName.values()].map((o) => ({ name: o.name, label: o.label, fields: JSON.stringify(o.fields) }))), now,
    });
    return { defined: names.length };
  });
}

async function loadDef(c: Parameters<Parameters<Workspace["read"]>[0]>[0], object: string): Promise<Def> {
  const r = await one(c, `SELECT name, label, fields FROM object_definitions WHERE name = $n LIMIT 1`, { n: object });
  if (!r) throw new HttpError(404, `object ${object} is not defined; POST objects/define first`);
  const fields = JSON.parse(String(r.fields)) as ObjectDef["fields"];
  return { name: String(r.name), label: String(r.label), fields: new Map(fields.map((f) => [f.name, f.type])) };
}

/** Coerce a value (JSON or CSV string) to a field type. Returns an error string on failure. */
export function coerce(type: FieldType, v: unknown): { value: unknown } | { error: string } {
  if (v === null || v === undefined || v === "") return { value: null };
  switch (type) {
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      return Number.isFinite(n) ? { value: n } : { error: `not a number: ${String(v).slice(0, 40)}` };
    }
    case "boolean": {
      if (typeof v === "boolean") return { value: v };
      const s = String(v).toLowerCase();
      return s === "true" || s === "1" ? { value: true } : s === "false" || s === "0" ? { value: false } : { error: `not a boolean: ${String(v).slice(0, 40)}` };
    }
    case "date":
    case "datetime": {
      const s = String(v);
      return Number.isNaN(Date.parse(s)) ? { error: `not a ${type}: ${s.slice(0, 40)}` } : { value: s };
    }
    case "json":
      return { value: v };
    default:
      return { value: typeof v === "string" ? v : JSON.stringify(v) };
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const str = (v: unknown) => (v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v));

type Rec = { id: string; sfId: string | null; externalKey: string | null; fields: Record<string, unknown>; fieldUpdatedAt: Record<string, number>; version: number };
const REC_SHAPE = JSON.stringify({ id: "VARCHAR", sfId: "VARCHAR", externalKey: "VARCHAR", fields: "VARCHAR", fieldUpdatedAt: "VARCHAR" });

export async function upsertObjects(ws: Workspace, object: string, body: UpsertObjectsBody): Promise<UpsertResult> {
  const key = `objects.upsert:${object}:${body.idempotencyKey}`;
  return ws.write(async (c) => {
    const prior = await priorResult<UpsertResult>(c, key);
    if (prior) return prior;
    const def = await loadDef(c, object);
    const now = Date.now();
    const sfIds = body.records.flatMap((r) => (r.sfId ? [r.sfId] : []));
    const extKeys = body.records.flatMap((r) => (r.externalKey ? [r.externalKey] : []));
    const existing = await all(c, `SELECT id, sfId, externalKey, fields, fieldUpdatedAt, version FROM custom_records
      WHERE object = $o AND (sfId IN (${sfIds.length ? sfIds.map(lit).join(",") : "NULL"}) OR externalKey IN (${extKeys.length ? extKeys.map(lit).join(",") : "NULL"}))`,
    { o: object });
    const rows = new Map<string, Rec>();
    const bySf = new Map<string, string>();
    const byKey = new Map<string, string>();
    const add = (r: Rec) => {
      rows.set(r.id, r);
      if (r.sfId) bySf.set(r.sfId, r.id);
      if (r.externalKey) byKey.set(r.externalKey, r.id);
    };
    for (const r of existing) {
      add({ id: String(r.id), sfId: (r.sfId as string) ?? null, externalKey: (r.externalKey as string) ?? null,
        fields: JSON.parse(String(r.fields)), fieldUpdatedAt: parseFua(r.fieldUpdatedAt), version: Number(r.version) });
    }
    const preexisting = new Set(rows.keys());
    const touched = new Map<string, Set<string>>();
    const history: Array<{ object: string; id: string; field: string; oldValue: string | null; newValue: string | null }> = [];
    const rejected: UpsertResult["rejected"] = [];
    const landed: string[] = [];
    let created = 0;
    let merged = 0;
    body.records.forEach((rec, index) => {
      const reject = (reason: string) => rejected.push({ index, ...(rec.sfId ? { sfId: rec.sfId } : {}), reason });
      const vals: Record<string, unknown> = {};
      for (const [f, v] of Object.entries(rec.fields)) {
        const t = def.fields.get(f);
        if (!t) return reject(`field ${f} is not defined on ${object}`);
        const r = coerce(t, v);
        if ("error" in r) return reject(`${f}: ${r.error}`);
        vals[f] = r.value;
      }
      let target = (rec.sfId && rows.get(bySf.get(rec.sfId) ?? "")) || (rec.externalKey && rows.get(byKey.get(rec.externalKey) ?? "")) || undefined;
      const changed = new Set<string>();
      if (target) {
        if (rec.sfId && target.sfId && target.sfId !== rec.sfId) return reject(`externalKey ${rec.externalKey} is linked to Salesforce id ${target.sfId}`);
        if (rec.sfId && !target.sfId) {
          target.sfId = rec.sfId;
          bySf.set(rec.sfId, target.id);
          target.fieldUpdatedAt.sfId = now;
          changed.add("sfId");
          if (preexisting.has(target.id)) merged++;
        }
      } else {
        const id = rec.sfId ? recordIdFor(object, `sf:${rec.sfId}`) : rec.externalKey ? recordIdFor(object, `k:${rec.externalKey}`) : `cr_${randomUUID().replaceAll("-", "")}`;
        target = { id, sfId: rec.sfId ?? null, externalKey: rec.externalKey ?? null, fields: {}, fieldUpdatedAt: {}, version: 0 };
        if (rec.sfId) (target.fieldUpdatedAt.sfId = now), changed.add("sfId");
        add(target);
        created++;
      }
      for (const [f, v] of Object.entries(vals)) {
        if (same(target.fields[f], v)) continue;
        if (preexisting.has(target.id)) history.push({ object, id: target.id, field: f, oldValue: str(target.fields[f]), newValue: str(v) });
        target.fields[f] = v;
        target.fieldUpdatedAt[f] = now;
        changed.add(f);
      }
      if (rec.externalKey && !target.externalKey) (target.externalKey = rec.externalKey), byKey.set(rec.externalKey, target.id);
      landed.push(target.id);
      // A brand-new row is always written, even with no fields.
      if (changed.size || !preexisting.has(target.id)) {
        const t = touched.get(target.id) ?? new Set<string>();
        for (const f of changed) t.add(f);
        touched.set(target.id, t);
      }
    });
    const stage = (rs: Rec[]) => JSON.stringify(rs.map((r) => ({ ...r, fields: JSON.stringify(r.fields), fieldUpdatedAt: JSON.stringify(r.fieldUpdatedAt) })));
    const upd = [...touched.keys()].filter((id) => preexisting.has(id)).map((id) => rows.get(id)!);
    const ins = [...touched.keys()].filter((id) => !preexisting.has(id)).map((id) => rows.get(id)!);
    if (upd.length) {
      await c.run(`CREATE OR REPLACE TEMP TABLE stage_custom AS SELECT * FROM (SELECT unnest(from_json($j, '[${REC_SHAPE}]'), recursive := true))`, { j: stage(upd) });
      await c.run(`UPDATE custom_records SET sfId = s.sfId, externalKey = s.externalKey, fields = s.fields::JSON, fieldUpdatedAt = s.fieldUpdatedAt::JSON,
          source = $src, updatedAt = $now, version = custom_records.version + 1
        FROM stage_custom s WHERE custom_records.id = s.id`, { src: body.source, now });
      await c.run(`DROP TABLE stage_custom`);
    }
    if (ins.length) {
      await c.run(`INSERT INTO custom_records (id, object, sfId, externalKey, fields, fieldUpdatedAt, source, updatedAt, version)
        SELECT id, $o, sfId, externalKey, fields::JSON, fieldUpdatedAt::JSON, $src, $now, 1
        FROM (SELECT unnest(from_json($j, '[${REC_SHAPE}]'), recursive := true))`, { j: stage(ins), o: object, src: body.source, now });
    }
    await writeHistory(c, history, body.source, body.source, now);
    await writeChanges(c, [...touched.keys()].sort().map((id) => {
      const r = rows.get(id)!;
      return { object, id, values: Object.fromEntries([...touched.get(id)!].map((f) => [f, f === "sfId" ? r.sfId : r.fields[f] ?? null])) };
    }), "upsert", body.source, now);
    const ids = [...new Set(landed)];
    const result: UpsertResult = { upserted: ids.length, ids, created, merged, rejected };
    await saveResult(c, key, result);
    return result;
  });
}

function toRow(object: string, r: Record<string, unknown>): CustomRecordRow {
  return {
    id: String(r.id), object, ...(r.sfId ? { sfId: String(r.sfId) } : {}), ...(r.externalKey ? { externalKey: String(r.externalKey) } : {}),
    fields: JSON.parse(String(r.fields)), fieldUpdatedAt: parseFua(r.fieldUpdatedAt), source: String(r.source),
    updatedAt: Number(r.updatedAt), version: Number(r.version),
  };
}
const COLS = `id, sfId, externalKey, fields, fieldUpdatedAt, source, updatedAt, version`;

/** Keyset pagination on (updatedAt, id), so a sync consumer can page while writes continue. */
export async function listObjects(ws: Workspace, object: string, body: ListObjectsBody): Promise<ListObjectsResult> {
  const limit = body.limit ?? 50;
  const parts = [`object = $o`];
  const params: Params = { o: object };
  if (body.filter?.q) (parts.push(`contains(lower(fields::VARCHAR), $q)`), (params.q = body.filter.q.toLowerCase()));
  if (body.filter?.sfId) (parts.push(`sfId = $sfId`), (params.sfId = body.filter.sfId));
  if (body.filter?.updatedAfter !== undefined) (parts.push(`updatedAt > $ua`), (params.ua = body.filter.updatedAfter));
  const where = parts.join(" AND ");
  let page = where;
  if (body.cursor) {
    let cur: { u: number; i: string };
    try {
      cur = JSON.parse(Buffer.from(body.cursor, "base64url").toString());
      if (!Number.isInteger(cur.u) || typeof cur.i !== "string") throw new Error();
    } catch {
      throw new HttpError(400, "invalid cursor");
    }
    page += ` AND (updatedAt > $cu OR (updatedAt = $cu AND id > $ci))`;
    params.cu = cur.u;
    params.ci = cur.i;
  }
  return ws.read(async (c) => {
    await loadDef(c, object);
    const rows = await all(c, `SELECT ${COLS} FROM custom_records WHERE ${page} ORDER BY updatedAt, id LIMIT ${limit + 1}`, params);
    const { cu: _a, ci: _b, ...countParams } = params;
    const total = Number((await one(c, `SELECT count(*) AS n FROM custom_records WHERE ${where}`, countParams))!.n);
    const more = rows.length > limit;
    const out = rows.slice(0, limit).map((r) => toRow(object, r));
    const last = out.at(-1);
    return { rows: out, total, ...(more && last ? { nextCursor: Buffer.from(JSON.stringify({ u: last.updatedAt, i: last.id })).toString("base64url") } : {}) };
  });
}

export async function getObject(ws: Workspace, object: string, id: string): Promise<{ record: CustomRecordRow }> {
  return ws.read(async (c) => {
    const r = await one(c, `SELECT ${COLS} FROM custom_records WHERE object = $o AND id = $id LIMIT 1`, { o: object, id });
    if (!r) throw new HttpError(404, `${object} record not found`);
    return { record: toRow(object, r) };
  });
}

export async function editObject(ws: Workspace, object: string, body: EditObjectBody): Promise<Pick<EditResult, "version">> {
  const key = body.idempotencyKey ? `objects.edit:${object}:${body.idempotencyKey}` : null;
  return ws.write(async (c) => {
    if (key) {
      const prior = await priorResult<Pick<EditResult, "version">>(c, key);
      if (prior) return prior;
    }
    const def = await loadDef(c, object);
    const cur = await one(c, `SELECT ${COLS} FROM custom_records WHERE object = $o AND id = $id LIMIT 1`, { o: object, id: body.id });
    if (!cur) throw new HttpError(404, `${object} record not found`);
    if (body.expectedVersion !== undefined && Number(cur.version) !== body.expectedVersion)
      throw new HttpError(409, `version mismatch: expected ${body.expectedVersion}, found ${cur.version}`);
    const fields = JSON.parse(String(cur.fields)) as Record<string, unknown>;
    const fua = parseFua(cur.fieldUpdatedAt);
    const now = Date.now();
    const stamp = body.sourceTimestamp ?? now;
    const changed: string[] = [];
    const history: Array<{ object: string; id: string; field: string; oldValue: string | null; newValue: string | null }> = [];
    for (const [f, v] of Object.entries(body.fields)) {
      const t = def.fields.get(f);
      if (!t) throw new HttpError(400, `field ${f} is not defined on ${object}`);
      const r = coerce(t, v);
      if ("error" in r) throw new HttpError(400, `${f}: ${r.error}`);
      if (same(fields[f], r.value)) continue;
      history.push({ object, id: body.id, field: f, oldValue: str(fields[f]), newValue: str(r.value) });
      fields[f] = r.value;
      fua[f] = stamp;
      changed.push(f);
    }
    let version = Number(cur.version);
    if (changed.length) {
      const row = await one(c, `UPDATE custom_records SET fields = $f::JSON, fieldUpdatedAt = $fua::JSON, source = $src, updatedAt = $now, version = version + 1
        WHERE object = $o AND id = $id RETURNING version`, { f: JSON.stringify(fields), fua: JSON.stringify(fua), src: body.source, now, o: object, id: body.id });
      version = Number(row!.version);
      await writeHistory(c, history, body.actor, body.source, now);
      await writeChanges(c, [{ object, id: body.id, values: Object.fromEntries(changed.map((f) => [f, fields[f]])) }], "edit", body.source, now);
    }
    const result = { version };
    if (key) await saveResult(c, key, result);
    return result;
  });
}
