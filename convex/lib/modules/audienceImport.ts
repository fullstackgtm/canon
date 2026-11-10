import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { workspaceMembers } from "../../permissions";
import { runsOf } from "../outbound/audience.ts";
import type { ImportDoc, ModuleImport } from "./imports.ts";
import { importSetKey } from "./importKeys.ts";
import type { ModuleScope } from "./scope.ts";

export const AUDIENCES_MODULE = "@canon/audiences";
export const AUDIENCES_IMPORT = "audiences.legacy";
const PAGE = 100;
const HISTORY_READ = 2000;
const HISTORY_RUNS = 20;
const COPIED = ["name", "filter", "shared", "owner", "lastSentAt"];
const RUN_FIELDS = ["target", "at", "sent", "exported", "skipped"];

export function audienceDoc(a: Doc<"audiences">): Record<string, unknown> {
  return { name: a.name, filter: a.filter, shared: a.shared !== false, owner: a.createdBy, ...(a.lastSentAt !== undefined ? { lastSentAt: a.lastSentAt } : {}) };
}

function fingerprint(value: unknown): string {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(value ?? null)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36);
}
export const fingerprints = (data: Record<string, unknown>, fields = COPIED): string => JSON.stringify(Object.fromEntries(fields.map((f) => [f, fingerprint(data[f])])));
function previousFingerprints(value: unknown): Record<string, string> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  } catch { return {}; }
}
export function followUntouchedImports(core: Record<string, unknown>, copy: Record<string, unknown>, fields = COPIED): Record<string, unknown> | null {
  const last = previousFingerprints(copy.imported);
  const now = fingerprints(core, fields);
  if (now === copy.imported) return null;
  const changed = Object.fromEntries(fields.filter((f) => fingerprint(core[f]) !== last[f] && fingerprint(copy[f]) === (last[f] ?? fingerprint(copy[f]))).filter((f) => core[f] !== undefined).map((f) => [f, core[f]]));
  if (fields.includes("lastSentAt")) {
    delete changed.lastSentAt;
    if (typeof core.lastSentAt === "number" && (typeof copy.lastSentAt !== "number" || core.lastSentAt > copy.lastSentAt)) changed.lastSentAt = core.lastSentAt;
  }
  return { ...changed, imported: now };
}

export type LegacyRun = { target: string; at: number; sent: number; exported: number; skipped: number };
export const runDoc = (r: LegacyRun): LegacyRun => ({ target: r.target, at: r.at, sent: r.sent, exported: r.exported, skipped: r.skipped });
export const runKey = (audience: string, r: LegacyRun): string => `legacy:${JSON.stringify([audience, r.target, r.at])}`;
const importedRun = (audience: string, r: LegacyRun): ImportDoc => {
  const data = runDoc(r);
  return { collection: "runs", key: runKey(audience, r), parentKey: audience, data: { ...data, imported: fingerprints(data, RUN_FIELDS) } };
};
export const followUntouchedRun = (core: Record<string, unknown>, copy: Record<string, unknown>): Record<string, unknown> | null => typeof copy.imported === "string" ? followUntouchedImports(core, copy, RUN_FIELDS) : null;

export async function recentHistory(ctx: QueryCtx, orgId: Id<"organizations">, audienceId: Id<"audiences">): Promise<LegacyRun[]> {
  const native = (await ctx.db.query("audienceRuns").withIndex("by_audienceId_at_target", (q) => q.eq("audienceId", audienceId)).order("desc").take(HISTORY_RUNS)).filter((r) => r.orgId === orgId);
  const older = await olderHistory(ctx, orgId, audienceId);
  const kept = new Set(native.map((r) => `${r.target}@${r.at}`));
  return [...native.map(runDoc), ...older.filter((r) => !kept.has(`${r.target}@${r.at}`))].sort((a, b) => b.at - a.at).slice(0, HISTORY_RUNS);
}

async function olderHistory(ctx: QueryCtx, orgId: Id<"organizations">, audienceId: Id<"audiences">): Promise<LegacyRun[]> {
  const rows = await ctx.db.query("audienceMembers").withIndex("by_audienceId_at", (q) => q.eq("audienceId", audienceId)).order("desc").take(HISTORY_READ + 1);
  return runsOf(rows.filter((r) => r.orgId === orgId), rows.length > HISTORY_READ).slice(0, HISTORY_RUNS);
}

export async function parentCopied(scope: Pick<ModuleScope, "view">, audience: string): Promise<boolean> {
  return !!await scope.view("audiences.one", { key: audience });
}

type Cursor = { phase: "PARENTS" | "ADDITIONS" | "HISTORY"; cursor: string | null; audience?: string; next?: string; end?: boolean; child?: string | null; older?: boolean };
const nextPhase = (phase: Cursor["phase"]): string | null => phase === "HISTORY" ? null : JSON.stringify({ phase: phase === "PARENTS" ? "ADDITIONS" : "HISTORY", cursor: null });
const advance = (state: Cursor): string | null => state.end ? nextPhase(state.phase) : JSON.stringify({ phase: state.phase, cursor: state.next ?? null });

export const audiencesImport: ModuleImport = {
  module: AUDIENCES_MODULE, label: "Audiences, added people and history",
  async batch(ctx, orgId, cursor, scope) {
    const state: Cursor = cursor ? JSON.parse(cursor) : { phase: "PARENTS", cursor: null };
    if (!["PARENTS", "ADDITIONS", "HISTORY"].includes(state.phase)) throw new ConvexError("Invalid audiences import phase.");
    if (state.phase === "PARENTS") {
      const page = await ctx.db.query("audiences").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).paginate({ numItems: PAGE, cursor: state.cursor });
      const members = new Set((await workspaceMembers(ctx, orgId)).map((m) => m.id as string));
      const docs = page.page.filter((a) => members.has(a.createdBy)).map((a) => { const data = audienceDoc(a); return { collection: "audiences", key: a._id as string, data: { ...data, imported: fingerprints(data) } }; });
      return { docs, cursor: page.isDone ? nextPhase(state.phase) : JSON.stringify({ ...state, cursor: page.continueCursor }) };
    }
    if (!state.audience) {
      const page = await ctx.db.query("audiences").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).paginate({ numItems: 1, cursor: state.cursor });
      if (!page.page.length) return { docs: [], cursor: nextPhase(state.phase) };
      state.audience = page.page[0]._id; state.next = page.continueCursor; state.end = page.isDone;
      return { docs: [], cursor: JSON.stringify(state) };
    }
    const audienceId = state.audience as Id<"audiences">;
    if (!await parentCopied(scope, audienceId)) return { docs: [], cursor: advance(state) };
    if (state.phase === "ADDITIONS") {
      const page = await ctx.db.query("audienceAdditions").withIndex("by_audienceId_and_contactId", (q) => q.eq("audienceId", audienceId)).paginate({ numItems: PAGE, cursor: state.child ?? null });
      return { docs: page.page.filter((r) => r.orgId === orgId).map((r) => ({ collection: "additions", key: importSetKey(audienceId, r.contactId), parentKey: audienceId, data: { person: r.contactId } })), cursor: page.isDone ? advance(state) : JSON.stringify({ ...state, child: page.continueCursor }) };
    }
    if (!state.older) {
      const page = await ctx.db.query("audienceRuns").withIndex("by_audienceId_at_target", (q) => q.eq("audienceId", audienceId)).order("desc").paginate({ numItems: PAGE, cursor: state.child ?? null });
      return { docs: page.page.filter((r) => r.orgId === orgId).map((r) => importedRun(audienceId, r)), cursor: JSON.stringify({ ...state, ...(page.isDone ? { older: true, child: null } : { child: page.continueCursor }) }) };
    }
    const older = await olderHistory(ctx, orgId, audienceId);
    const docs: ImportDoc[] = [];
    for (const r of older) {
      const native = await ctx.db.query("audienceRuns").withIndex("by_audienceId_at_target", (q) => q.eq("audienceId", audienceId).eq("at", r.at).eq("target", r.target)).unique();
      if (!native) docs.push(importedRun(audienceId, r));
    }
    return { docs, cursor: advance(state) };
  },
};

export const recentRunDocs = async (ctx: QueryCtx, orgId: Id<"organizations">, audience: Id<"audiences">): Promise<ImportDoc[]> => (await recentHistory(ctx, orgId, audience)).map((r) => importedRun(audience, r));
