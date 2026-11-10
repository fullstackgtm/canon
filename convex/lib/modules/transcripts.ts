/**
 * Canon's recorded calls and meetings (`callRecordings`) as modules read them (docs/modules.md, "Calls" and
 * "Transcripts"): the one place a module surface reads a call. A page's transcript, a call picker and a read plan's
 * `calls.*` reads all ask `callVisible`, Canon's rule for call records (CP14): a call the caller's role sees by its owner
 * (their own, their team's, or all), or one filed on a deal they see.
 */
import { ConvexError } from "convex/values";
import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { dealVisible } from "../../permissions";
import { canSeeRecord, fieldLevel, permissionOf, type Access } from "../access";
import { MAX_IN_VALUES, type CanonRead, type ModuleManifest } from "../../../modules/kernel/manifest.ts";

/** Lines one transcript shows or reads, at most; a longer call says so rather than give part of it. */
export const TRANSCRIPT_LINES_MAX = 5000;
/** Characters of transcript one read returns, at most (about ten hours of talk). */
export const TRANSCRIPT_CHARS_MAX = 600_000;
/** Insights one transcript read returns, at most. */
const INSIGHTS_MAX = 200;
/** Calls a `calls.between` read looks through before it refuses rather than return part of them. */
const CALLS_SCANNED_MAX = 5000;
/** Calls a call picker offers, and recent calls it searches. */
const PICK_MAX = 20;
const PICK_SCAN = 200;

/** Whether `access` sees a call: by its owner, as the role sees call records, or by the deal it is filed on. */
export function callVisible(access: Access, call: Doc<"callRecordings">, deal: Doc<"deals"> | null): boolean {
  if (canSeeRecord(access, "call", true, call.ownerId ?? null)) return true;
  return Boolean(deal && deal.orgId === call.orgId && deal.archivedAt === undefined && permissionOf(access, "deal").read && dealVisible(access, deal));
}

/**
 * Who reads calls: a workspace and a rule over each call (`scope.callSeen`), and, for a read plan's `calls.*`, the
 * call fields the caller's role hides (by the call record's field names), which read as left out.
 */
export type Reader = { orgId: Id<"organizations">; callSeen: (call: Doc<"callRecordings">) => Promise<boolean>; hidden?: (apiName: string) => boolean };

/** `callVisible` for one caller, each deal read once. */
export function callReader(ctx: QueryCtx, orgId: Id<"organizations">, access: Access): Reader {
  const deals = new Map<string, Promise<Doc<"deals"> | null>>();
  const dealOf = (id: Id<"deals">) => { if (!deals.has(id)) deals.set(id, ctx.db.get(id)); return deals.get(id)!; };
  return {
    orgId, callSeen: async (call) => callVisible(access, call, call.dealId ? await dealOf(call.dealId) : null),
    hidden: (apiName) => fieldLevel(access, "call", apiName) === "hidden",
  };
}

async function readable(ctx: QueryCtx, reader: Reader, callId: string): Promise<Doc<"callRecordings"> | null> {
  const id = ctx.db.normalizeId("callRecordings", callId);
  const call = id ? await ctx.db.get(id) : null;
  return call && call.orgId === reader.orgId && (await reader.callSeen(call)) ? call : null;
}

export type TranscriptLine = { segment: number; speaker: string | null; side: "rep" | "customer" | "unknown"; startSec: number | null; endSec: number | null; text: string };
type Lines = { lines: TranscriptLine[]; timed: boolean } | { over: string };

async function linesOf(ctx: QueryCtx, call: Doc<"callRecordings">): Promise<Lines> {
  const rows = await ctx.db.query("callTranscriptSegments").withIndex("by_callId_segmentIndex", (q) => q.eq("callId", call._id)).take(TRANSCRIPT_LINES_MAX + 1);
  if (rows.length > TRANSCRIPT_LINES_MAX) return { over: `more than ${TRANSCRIPT_LINES_MAX.toLocaleString("en-US")} lines` };
  if (rows.reduce((n, r) => n + r.text.length, 0) > TRANSCRIPT_CHARS_MAX) return { over: `more than ${TRANSCRIPT_CHARS_MAX.toLocaleString("en-US")} characters` };
  const lines = rows.map((r): TranscriptLine => ({
    segment: r.segmentIndex, speaker: r.speaker ?? null, side: r.speakerRole, startSec: r.startSeconds ?? null, endSec: r.endSeconds ?? null, text: r.text,
  }));
  return { lines, timed: lines.length > 0 && lines.every((l) => l.startSec !== null && l.endSec !== null) };
}

export type Transcript =
  | { state: "ok"; call: { id: string; title: string; at: string | null; durationSeconds: number | null; timed: boolean }; lines: TranscriptLine[] }
  | { state: "none" }
  | { state: "tooLong"; title: string };

/** A call's transcript as the caller reads it: none when there is no such call, it isn't theirs to read, or it has no lines. */
export async function transcriptOf(ctx: QueryCtx, reader: Reader, callId: string): Promise<Transcript> {
  const call = await readable(ctx, reader, callId);
  if (!call) return { state: "none" };
  const got = await linesOf(ctx, call);
  if ("over" in got) return { state: "tooLong", title: call.title };
  if (!got.lines.length) return { state: "none" };
  return { state: "ok", call: { id: call._id, title: call.title, at: call.callDate ?? null, durationSeconds: call.durationSeconds ?? null, timed: got.timed }, lines: got.lines };
}

const labelOf = (c: Doc<"callRecordings">) => (c.callDate ? `${c.title} · ${c.callDate.slice(0, 10)}` : c.title);

/** A call picker's options: the caller's readable calls, newest first, whose title holds `search`; `current` first when given. */
export async function pickCalls(ctx: QueryCtx, reader: Reader, search: string, current?: string): Promise<Array<{ id: string; label: string }>> {
  const q = search.trim().toLowerCase();
  const out: Array<{ id: string; label: string }> = [];
  for (const c of await ctx.db.query("callRecordings").withIndex("by_orgId_callDate", (x) => x.eq("orgId", reader.orgId)).order("desc").take(PICK_SCAN)) {
    if (out.length === PICK_MAX) break;
    if ((!q || c.title.toLowerCase().includes(q)) && (await reader.callSeen(c))) out.push({ id: c._id, label: labelOf(c) });
  }
  const own = current ? await readable(ctx, reader, current) : null;
  return own && !out.some((o) => o.id === own._id) ? [{ id: own._id, label: labelOf(own) }, ...out] : out;
}

/** A call's granted fields, by the names a module reads them with. */
const CALL_FIELDS: Record<string, (c: Doc<"callRecordings">) => unknown> = {
  title: (c) => c.title, at: (c) => (c.callDate && Number.isFinite(Date.parse(c.callDate)) ? Date.parse(c.callDate) : c.createdAt),
  durationSeconds: (c) => c.durationSeconds ?? null, ownerId: (c) => c.ownerId ?? null, dealId: (c) => c.dealId ?? null,
  provider: (c) => c.provider, analyzedAt: (c) => c.analyzedAt ?? null,
};
/** The call record's field a module field reads, where the names differ (the registry's `call`: `subject`, `callAt`). */
const CALL_API_NAME: Record<string, string> = { title: "subject", at: "callAt" };
const refuse = (message: string): never => { throw new ConvexError(message); };

/** One `calls.*` read of a read plan, as `reader` sees the calls: at most `limit`, or a refusal when there are more. */
export async function callsRead(ctx: QueryCtx, reader: Reader, manifest: ModuleManifest, read: CanonRead, args: Record<string, unknown>, limit: number): Promise<Array<Record<string, unknown>>> {
  const granted = manifest.reads?.calls ?? [];
  // A field the caller's role hides on call records is left out, as on every other surface.
  const fields = granted.filter((f) => Object.hasOwn(CALL_FIELDS, f) && !reader.hidden?.(CALL_API_NAME[f] ?? f));
  const record = (c: Doc<"callRecordings">) => ({ id: c._id as string, createdAt: c.createdAt, ...Object.fromEntries(fields.map((f) => [f, CALL_FIELDS[f](c)])) });
  if (read === "calls.transcript") {
    if (typeof args.call !== "string") return refuse("calls.transcript needs call, a call's id.");
    const call = await readable(ctx, reader, args.call);
    if (!call) return [];
    const got = await linesOf(ctx, call);
    if ("over" in got) return refuse(`calls.transcript: ${call.title} has ${got.over}, more than one read takes.`);
    const insights = granted.includes("insights")
      ? (await ctx.db.query("callInsights").withIndex("by_callId", (q) => q.eq("callId", call._id)).take(INSIGHTS_MAX)).map((i) => ({ type: i.type, text: i.text, evidence: i.evidence }))
      : undefined;
    return [{ ...record(call), timed: got.timed, segments: got.lines, ...(insights ? { insights } : {}) }];
  }
  const out: Array<Record<string, unknown>> = [];
  const add = async (c: Doc<"callRecordings">) => {
    if (c.orgId !== reader.orgId || !(await reader.callSeen(c))) return;
    if (out.length >= limit) refuse(`${read} has more than ${limit} calls you can see; narrow it or raise the read's limit.`);
    out.push(record(c));
  };
  if (read === "calls.byIds") {
    const raw = typeof args.ids === "string" ? [args.ids] : args.ids ?? [];
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) return refuse("calls.byIds needs ids, a list of call ids.");
    const ids = [...new Set(raw as string[])];
    if (ids.length > MAX_IN_VALUES) refuse(`calls.byIds names ${ids.length} calls; one read takes at most ${MAX_IN_VALUES}.`);
    for (const raw1 of ids) { const id = ctx.db.normalizeId("callRecordings", raw1); const c = id ? await ctx.db.get(id) : null; if (c) await add(c); }
    return out;
  }
  const { from, to } = args;
  if (typeof from !== "string" || typeof to !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return refuse("calls.between needs from and to as dates, YYYY-MM-DD.");
  let scanned = 0;
  // A call's date is an ISO time: every time on `to` sorts before `to` followed by a character past "T".
  for await (const c of ctx.db.query("callRecordings").withIndex("by_orgId_callDate", (q) => q.eq("orgId", reader.orgId).gte("callDate", from).lt("callDate", `${to}~`))) {
    if (++scanned > CALLS_SCANNED_MAX) refuse(`calls.between ${from} to ${to} reads more than ${CALLS_SCANNED_MAX} calls; narrow it.`);
    await add(c);
  }
  return out;
}
