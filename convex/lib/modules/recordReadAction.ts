/**
 * A call's companies, people and activities reads (recordReads.ts), read in its action after the plan's query: as the
 * caller through their scoped record client, or as Canon for a system call (a job, a watch, a schedule).
 */
import type { SuppressionIdentifiers, SuppressionPurpose } from "../suppressions/domain";
import { marketView } from "../../marketSize";
import { memoizedMarketReader } from "../marketSize.ts";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { callerClient, clientFor, requireCaller } from "../../records";
import { ConvexError } from "convex/values";
import { ProjectionBehind, readRecord, type AddedSource, type SnapshotSource, type RecordReadSpec } from "./recordReads";
import { SNAPSHOT_PAGE } from "../../../modules/kernel/manifest.ts";
import type { ReadValue } from "../../../modules/kernel/calls.ts";
import { admitThenRead } from "../scopedRecordClient";
import type { PendingSight } from "../../permissions";
import type { Snapshot } from "./scope";
import { treeValue } from "./territories";
import { icpTreeValue } from "./icpTrees";
import { readModuleActivities, type ModuleActivityPrincipal } from "./activities";

/**
 * A call's territory trees (docs/modules.md, "Territories"), counted in the record service after the plan's query: as
 * the signed-in caller, or as Canon for a system call (a job, a watch, a schedule). A background AI step's member has no
 * session, so a tree read refuses it.
 */
export async function readTreesOf(ctx: ActionCtx, snap: Pick<Snapshot, "trees" | "icpTrees" | "label">, reads: Record<string, ReadValue>, system?: Id<"organizations">, person?: unknown): Promise<void> {
  const trees = Object.entries(snap.trees ?? {});
  const icpTrees = Object.entries(snap.icpTrees ?? {});
  if (!trees.length && !icpTrees.length) return;
  if (person) throw new ConvexError(`${snap.label} reads a tree, which runs for a signed-in person or as Canon.`);
  const caller = system ? null : await requireCaller(ctx, { read: true });
  const client = caller ? callerClient(ctx, caller) : clientFor(ctx);
  const market = memoizedMarketReader((filter, groupBy) => marketView(ctx, filter, groupBy));
  for (const [name, spec] of icpTrees) {
    if (!spec.granted || spec.orgId !== (system ?? caller?.orgId) || spec.userId !== (system ? "system" : caller?.access.userId)) throw new ConvexError(`${snap.label} cannot count this ICP tree with another principal or without company and people read grants.`);
    const result = spec.request.nodes.length ? await client.icpTreeCounts(spec.orgId, spec.request) : { nodes: [], overlaps: [] };
    reads[name] = await icpTreeValue(result, spec, market);
  }
  for (const [name, spec] of trees) reads[name] = await treeValue(client, caller ? caller.orgId : (system as string), spec, market);
}

export async function readRecordsOf(ctx: ActionCtx, snap: Pick<Snapshot, "records" | "markets" | "researchAnswers">, reads: Record<string, ReadValue>, system?: Id<"organizations">, person?: { orgId: Id<"organizations">; userId: Id<"users"> }): Promise<void> {
  const answerSpecs = Object.entries(snap.researchAnswers ?? {});
  if (answerSpecs.length) {
    if (system || person) throw new ConvexError("research.answers reads only for a signed-in person.");
    const caller = await requireCaller(ctx, { read: true });
    for (const [name, spec] of answerSpecs) {
      const rows = await admitThenRead(callerClient(ctx, caller), caller.orgId, async (admitted) => {
        const result: { rows: Array<Record<string, unknown>>; pending: PendingSight[] } = await ctx.runQuery(internal.researchAgents.answersFor, {
          orgId: caller.orgId as Id<"organizations">, accesses: [caller.access], slug: spec.slug, limit: spec.limit, admitted,
        });
        return { pending: result.pending, value: result.rows };
      });
      reads[name] = rows.map((row) => ({ id: row.factId, createdAt: row.observedAt, ...Object.fromEntries(spec.fields.map((f) => [f, row[f] ?? null])) }));
    }
  }
  const market = memoizedMarketReader((filter, groupBy) => marketView(ctx, filter, groupBy));
  for (const [name, spec] of Object.entries(snap.markets ?? {})) reads[name] = await market(spec.filter, spec.groupBy);
  const specs = Object.entries(snap.records ?? {});
  if (!specs.length) return;
  if (!system && specs.some(([, spec]) => spec.read === "match.inbound")) throw new ConvexError("match.inbound runs only as Canon.");
  // A background AI step reads as its member, with no session: their access, as an agent run reads (records.principalClient).
  const caller = system ? null : person ? { orgId: person.orgId as string, access: await ctx.runQuery(internal.moduleAi.accessOf, { orgId: person.orgId, userId: person.userId }) } : await requireCaller(ctx, { read: true });
  const orgId = (system ?? caller!.orgId) as Id<"organizations">;
  if (!caller && specs.some(([, spec]) => spec.withSuppression || spec.read === "suppression.check")) throw new ConvexError("Suppression status is read as a caller.");
  const client = caller ? callerClient(ctx, caller) : clientFor(ctx);
  const principal: ModuleActivityPrincipal | undefined = system ? { orgId: system, system: true } : person;
  const ports = {
    conversationsOf: (dealIds: string[], domains: Record<string, string>, fields: string[], limit: number) => {
      if (!caller || caller.access.userId === "system") throw new ConvexError("deals.conversations requires a member.");
      return ctx.runQuery(internal.moduleActivityContent.dealConversations, { orgId, userId: caller.access.userId as Id<"users">, dealIds, domains, fields, limit });
    },
    suppressionCheck: (identifiers: SuppressionIdentifiers[], purpose: SuppressionPurpose) => ctx.runQuery(internal.suppressions.checkIdentifiers, { orgId, identifiers, purpose }),
    edgesTo: (toIds: string[], limit: number) => ctx.runQuery(internal.activityTargets.edgesTo, { orgId, toIds, limit }),
    dealsOf: (streamIds: string[]) => (streamIds.length ? ctx.runQuery(internal.activityTargets.dealsOfStreams, { orgId, streamIds }) : Promise.resolve({})),
    moduleActivities: (spec: RecordReadSpec) => readModuleActivities(ctx, client, orgId, {
      targets: spec.ids.map((id) => ({ object: spec.read === "activities.forDeals" ? "deal" as const : "account" as const, id })), since: spec.since, limit: spec.limit,
    }, principal),
    // What was said (P11): only for the deals the plan's query found the caller sees.
    recordingsOf: (dealIds: string[], since: number | null) => ctx.runQuery(internal.moduleActivityContent.recordingsOf, { orgId, dealIds, since }),
    recordingContent: (id: string) => ctx.runQuery(internal.moduleActivityContent.recordingContent, { orgId, id }),
    observationsOf: (contactIds: string[], since: number | null, until: number | null) => ctx.runQuery(internal.observations.forPeople, { orgId, contactIds, since, until }),
    addedTo: (source: string | AddedSource) => addedTo(ctx, orgId, source),
    snapshot: (moduleId: string, source: SnapshotSource, ids: string[]) => storeSnapshot(ctx, orgId, moduleId, source, ids),
  };
  for (const [name, spec] of specs) {
    let got;
    try { got = await readRecord(client, orgId, ports, spec); }
    catch (e) {
      if (!(e instanceof ProjectionBehind)) throw e;
      // The record service is a moment behind the ledger: ask it to catch up to the plan's heads, then read once more.
      await client.nudgeProjector(orgId, spec.through ?? {}, process.env.CONVEX_SITE_URL, { wait: true });
      try { got = await readRecord(client, orgId, ports, spec); }
      catch (again) { throw again instanceof ProjectionBehind ? new ConvexError("Canon is still indexing the latest activities. Try again in a moment.") : again; }
    }
    reads[name] = got as ReadValue;
  }
}

/** Pages per mutation when storing a snapshot: 20 × 500 ids stays far below a mutation's write limits. */
const PAGES_PER_WRITE = 20;

async function storeSnapshot(ctx: ActionCtx, orgId: Id<"organizations">, moduleId: string, source: SnapshotSource, ids: string[]) {
  const snapshot = crypto.randomUUID();
  const pages = Array.from({ length: Math.max(1, Math.ceil(ids.length / SNAPSHOT_PAGE)) }, (_, i) => ids.slice(i * SNAPSHOT_PAGE, (i + 1) * SNAPSHOT_PAGE));
  // Page 0 last: audiences.members refuses a snapshot without it, so no reader sees one half stored.
  const order = [...pages.keys()].reverse();
  let createdAt = Date.now();
  for (let i = 0; i < order.length; i += PAGES_PER_WRITE) {
    const batch = order.slice(i, i + PAGES_PER_WRITE).map((page) => ({ page, ids: pages[page] }));
    createdAt = await ctx.runMutation(internal.moduleSnapshots.store, { orgId, moduleId, snapshot, ...source, count: ids.length, pages: batch });
  }
  return { snapshot, createdAt };
}

export async function addedTo(ctx: ActionCtx, orgId: Id<"organizations">, source: string | AddedSource): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const page: { ids: string[]; next: string | null } = typeof source === "string"
      ? await ctx.runQuery(internal.moduleSnapshots.addedPage, { audienceId: source as Id<"audiences">, cursor })
      : await ctx.runQuery(internal.moduleSnapshots.addedOf, { orgId, ...source, cursor });
    out.push(...page.ids);
    cursor = page.next;
  } while (cursor);
  return out;
}
