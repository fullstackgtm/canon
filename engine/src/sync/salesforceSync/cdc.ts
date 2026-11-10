// Inbound change sources.
//
//   simCdcSource     GET {base}/sim/cdc?replayId=  (the sf-sim simulator; Pub/Sub-shaped payloads)
//   pubSubCdcSource  Salesforce Pub/Sub API (gRPC). Not usable from the Convex runtime; throws.
//   pollingSource    SOQL on SystemModstamp, one query per object per call.
import { PARENT_FIELD } from "./policy.ts";
import type { CdcEvent, CdcSource, InboundCursor, SyncPolicy } from "./types.ts";

type Fetch = typeof fetch;

/** Parses one Pub/Sub-shaped change event: { replayId, payload: { ChangeEventHeader, ...fields } }. */
export function parseChangeEvent(raw: any): CdcEvent | null {
  const payload = raw?.payload ?? raw;
  const h = payload?.ChangeEventHeader;
  if (!h || typeof h.entityName !== "string") return null;
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) if (k !== "ChangeEventHeader") values[k] = v;
  const changed: string[] = Array.isArray(h.changedFields) ? h.changedFields : [];
  return {
    sfObject: h.entityName,
    sfIds: Array.isArray(h.recordIds) ? h.recordIds : [],
    changeType: String(h.changeType ?? "UPDATE"),
    // CDC omits unchanged fields; on CREATE every populated field counts as changed.
    changedFields: h.changeType === "CREATE" ? Object.keys(values) : changed,
    commitTimestamp: Number(h.commitTimestamp ?? 0),
    values,
    changeOrigin: typeof h.changeOrigin === "string" ? h.changeOrigin : undefined,
  };
}

export function simCdcSource(opts: { baseUrl: string; getToken: () => Promise<string>; fetchImpl?: Fetch }): CdcSource {
  const f = opts.fetchImpl ?? fetch;
  return {
    kind: "cdc",
    async next(cursor) {
      const q = cursor.replayId ? `?replayId=${encodeURIComponent(cursor.replayId)}` : "";
      const res = await f(`${opts.baseUrl}/sim/cdc${q}`, { headers: { authorization: `Bearer ${await opts.getToken()}` } });
      if (!res.ok) throw new Error(`sim cdc ${res.status}`);
      const body = (await res.json()) as { events?: any[]; latestReplayId?: string | number; replayId?: string | number };
      const events = (body.events ?? []).map(parseChangeEvent).filter((e): e is CdcEvent => e !== null);
      const last = body.events?.length ? body.events[body.events.length - 1].replayId : undefined;
      const replayId = last ?? body.latestReplayId ?? body.replayId ?? cursor.replayId;
      return { events, cursor: { ...cursor, replayId: replayId === undefined ? undefined : String(replayId) } };
    },
  };
}

export function pubSubCdcSource(): CdcSource {
  return {
    kind: "cdc",
    async next() {
      throw new Error(
        "Salesforce Pub/Sub API needs a long-lived gRPC/HTTP2 stream, which Convex actions cannot hold. Use mode \"poll\", or run a Pub/Sub relay outside Convex.",
      );
    },
  };
}

export type Soql = (query: string) => Promise<Array<Record<string, unknown>>>;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Polls each policy object on SystemModstamp with keyset pagination on
 * (SystemModstamp, Id), so many rows sharing one stamp (a bulk update in one
 * transaction) are paged through rather than skipped. The first call for an
 * object starts the cursor at `now` (history is the import's job).
 */
export function pollingSource(opts: { soql: Soql; policy: SyncPolicy; pageSize?: number; now?: () => number }): CdcSource {
  const pageSize = opts.pageSize ?? 200;
  const now = opts.now ?? Date.now;
  return {
    kind: "poll",
    async next(cursor) {
      const next: InboundCursor = {
        ...cursor,
        modstampByObject: { ...cursor.modstampByObject },
        lastIdByObject: { ...(cursor.lastIdByObject ?? {}) },
      };
      const events: CdcEvent[] = [];
      for (const o of opts.policy.objects) {
        const since = next.modstampByObject[o.sf];
        if (since === undefined) {
          next.modstampByObject[o.sf] = now();
          continue;
        }
        const lastId = next.lastIdByObject![o.sf];
        const fields = [...new Set([...o.fields.map((f) => f.sf), ...(PARENT_FIELD[o.sf] ? [PARENT_FIELD[o.sf]] : [])])].filter((f) => f !== "Id" && f !== "SystemModstamp");
        const where = lastId
          ? `(SystemModstamp > ${iso(since)} OR (SystemModstamp = ${iso(since)} AND Id > '${lastId}'))`
          : `SystemModstamp > ${iso(since)}`;
        const q = `SELECT Id, SystemModstamp${fields.length ? ", " + fields.join(", ") : ""} FROM ${o.sf} WHERE ${where} ORDER BY SystemModstamp ASC, Id ASC LIMIT ${pageSize}`;
        const rows = await opts.soql(q);
        for (const r of rows) {
          const ts = Date.parse(String(r.SystemModstamp));
          const values: Record<string, unknown> = {};
          for (const f of fields) values[f] = r[f] ?? null;
          events.push({ sfObject: o.sf, sfIds: [String(r.Id)], changeType: "UPDATE", changedFields: [], commitTimestamp: ts, values });
          next.modstampByObject[o.sf] = ts;
          next.lastIdByObject![o.sf] = String(r.Id);
        }
      }
      return { events, cursor: next };
    },
  };
}
