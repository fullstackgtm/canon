"use node";
/**
 * Account hierarchy manager, the CRM and web side (docs/account-hierarchy-manager.md).
 * - `runScan` reads Canon's companies, parent links and deals as the person who started it (records.principalClient),
 *   or the org's Salesforce with GET requests only (describe and SOQL); keeps the snapshot in file storage and saves
 *   the candidate groups.
 * - `runResearch` researches one group on the requesting user's ChatGPT plan, checks every quote against the page it
 *   names, and saves the research and the proposal.
 * Nothing here writes to Canon or a CRM: there is no record write, PATCH, POST or connector write in this file.
 */
import { ConvexError, v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { credentialsForOrg } from "./salesforceActions";
import { principalClient } from "./records";
import { readCanonSnapshot } from "./lib/hierarchyCanon";
import type { Access } from "./lib/access";
import type { CanonMember } from "../engine/src/accountHierarchy/canonSnapshot.ts";
import { resolveLlm } from "./lib/llmResolver";
import { accountParentId } from "../engine/src/accountFamily.ts";
import { detectCandidateGroups, isShell } from "../engine/src/accountHierarchy/detect.ts";
import { buildHierarchyProposal, proposalToJson } from "../engine/src/accountHierarchy/plan.ts";
import { readSalesforceSnapshot, stripAttributes, type SoqlRow } from "../engine/src/accountHierarchy/salesforceSnapshot.ts";
import { researchGroup } from "../engine/src/accountHierarchy/researchAgent.ts";
import type { CanonicalGtmSnapshot } from "../engine/src/types.ts";
import type { HierarchyPolicy } from "../engine/src/accountHierarchy/policy.ts";

const SF_API = "v59.0";
/** Convex values can't hold `undefined`; a JSON round trip drops those keys. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** Accounts listed per group row; the snapshot keeps the whole group. */
const MAX_ACCOUNTS_PER_GROUP = 300;
const INSERT_BATCH = 100;
/** Convex documents read per page of parent links and of deals. */
const CONVEX_PAGE = 1000;
/** Research stops asking the model for more after this, leaving time to check quotes and save inside 10 minutes. */
const RESEARCH_BUDGET_MS = 6 * 60_000;

/** A GET-only Salesforce client: describe and SOQL. Retries 429 and 503; errors never carry record values. */
async function salesforceReader(ctx: ActionCtx, orgId: Id<"organizations">) {
  const { accessToken, instanceUrl } = await credentialsForOrg(ctx, orgId);
  const base = instanceUrl.replace(/\/$/, "");
  const get = async (path: string): Promise<any> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${path}`, { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } });
      if ((res.status === 429 || res.status === 503) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message = Array.isArray(body) ? body[0]?.message : body?.message;
        throw new ConvexError(`Salesforce ${path.split("?")[0]}: HTTP ${res.status}${message ? ` (${String(message).slice(0, 200)})` : ""}`);
      }
      return res.json();
    }
  };
  const query = async (soql: string): Promise<SoqlRow[]> => {
    if (!/^\s*select\s/i.test(soql)) throw new ConvexError("read-only: only SELECT queries are allowed");
    const rows: SoqlRow[] = [];
    let next: string | null = `/services/data/${SF_API}/query?q=${encodeURIComponent(soql)}`;
    while (next) {
      const page: { records: SoqlRow[]; done: boolean; nextRecordsUrl?: string } = await get(next);
      for (const r of page.records) rows.push(stripAttributes(r));
      next = page.done ? null : (page.nextRecordsUrl ?? null);
    }
    return rows;
  };
  const describe = async (sobject: string) => {
    const d: { fields: Array<{ name: string }> } = await get(`/services/data/${SF_API}/sobjects/${sobject}/describe`);
    return new Set(d.fields.map((f) => f.name));
  };
  return { query, describe };
}

export const runScan = internalAction({
  args: { scanId: v.id("hierarchyScans") },
  handler: async (ctx, args): Promise<null> => {
    const loaded: { scan: Doc<"hierarchyScans">; policy: HierarchyPolicy; accesses: Access[] | null; members: CanonMember[] } | null =
      await ctx.runQuery(internal.accountHierarchy.scanForAction, { scanId: args.scanId });
    if (!loaded) return null;
    const { scan, policy } = loaded;
    try {
      const snapshot = scan.provider === "canon" ? await canonRead(ctx, scan.orgId, loaded.accesses, loaded.members) : await salesforceRead(ctx, scan.orgId, policy);
      const stored = await ctx.storage.store(new Blob([JSON.stringify(snapshot)], { type: "application/json" }));
      const report = detectCandidateGroups(snapshot, policy);
      const byId = new Map(snapshot.accounts.map((a) => [String(a.id), a]));
      const userNames = new Map(snapshot.users.map((u) => [String(u.id), u.name]));
      const rows = report.groups.map((g, rank) => {
        const inGroup = new Set(g.accountIds);
        // The default top account: the one most of the group sits under, else the oldest top-level account.
        const children = new Map<string, number>();
        for (const id of g.accountIds) {
          const p = accountParentId(byId.get(id)!);
          if (p && inGroup.has(p)) children.set(p, (children.get(p) ?? 0) + 1);
        }
        const suggestedRootId = [...children].sort((a, b) => b[1] - a[1])[0]?.[0] ?? g.accountIds.find((id) => !accountParentId(byId.get(id)!) && !g.shellIds.includes(id)) ?? g.accountIds[0];
        const accounts = g.accountIds
          .map((id) => {
            const a = byId.get(id)!;
            const parentId = accountParentId(a);
            return { id, name: a.name.slice(0, 200), ...(parentId ? { parentId } : {}), shell: isShell(a, policy, userNames) };
          })
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, MAX_ACCOUNTS_PER_GROUP);
        return { rank, groupKey: g.id, size: g.accountIds.length, shellCount: g.shellIds.length, accounts, reasons: g.reasons.slice(0, 50).map((r) => r.slice(0, 200)), suggestedRootId };
      });
      for (let i = 0; i < rows.length; i += INSERT_BATCH) {
        await ctx.runMutation(internal.accountHierarchy.insertGroups, { scanId: scan._id, groups: rows.slice(i, i + INSERT_BATCH) });
      }
      await ctx.runMutation(internal.accountHierarchy.finishScan, {
        scanId: scan._id,
        snapshot: stored,
        accounts: snapshot.accounts.length,
        groups: rows.length,
        shellGroups: report.groups.filter((g) => g.shellIds.length).length,
      });
    } catch (error) {
      await ctx.runMutation(internal.accountHierarchy.failScan, { scanId: scan._id, error: error instanceof Error ? error.message : String(error) });
    }
    return null;
  },
});

async function salesforceRead(ctx: ActionCtx, orgId: Id<"organizations">, policy: HierarchyPolicy): Promise<CanonicalGtmSnapshot> {
  const sf = await salesforceReader(ctx, orgId);
  return readSalesforceSnapshot(sf.query, sf.describe, policy);
}

/** Canon's companies as the scan's starter sees them now, with the parent links and deals between them. */
async function canonRead(ctx: ActionCtx, orgId: Id<"organizations">, accesses: Access[] | null, members: CanonMember[]): Promise<CanonicalGtmSnapshot> {
  if (!accesses) throw new ConvexError("The person who started this scan is no longer in the workspace.");
  const page = { numItems: CONVEX_PAGE };
  return readCanonSnapshot({
    client: principalClient(ctx, orgId, accesses),
    orgId,
    parents: (cursor) => ctx.runQuery(internal.associations.parentEdgesPage, { orgId, paginationOpts: { ...page, cursor } }),
    deals: (cursor) => ctx.runQuery(internal.accountHierarchy.canonDealsPage, { orgId, accesses, paginationOpts: { ...page, cursor } }),
    members,
  });
}

export const runResearch = internalAction({
  args: { researchId: v.id("hierarchyResearch") },
  handler: async (ctx, args): Promise<null> => {
    const loaded: {
      research: Doc<"hierarchyResearch">;
      snapshot: Id<"_storage"> | null;
      group: Doc<"hierarchyGroups"> | null;
      policy: HierarchyPolicy;
    } | null = await ctx.runQuery(internal.accountHierarchy.researchForAction, { researchId: args.researchId });
    if (!loaded) return null;
    const { research, snapshot: snapshotId, group, policy } = loaded;
    const fail = async (error: string): Promise<null> => {
      await ctx.runMutation(internal.accountHierarchy.failResearch, { researchId: research._id, error });
      return null;
    };
    try {
      if (!snapshotId || !group) return await fail("The scan's snapshot is gone. Scan again.");
      const llm = await resolveLlm(ctx, research.startedBy);
      if (!llm) return await fail("Research runs on your ChatGPT plan. Sign in with ChatGPT under Integrations → ChatGPT, then start it again.");
      const blob = await ctx.storage.get(snapshotId);
      if (!blob) return await fail("The scan's snapshot is gone. Scan again.");
      const snapshot = JSON.parse(await blob.text()) as CanonicalGtmSnapshot;
      // The accounts to research: the whole detected group, which may be larger than the listed rows.
      const detected = detectCandidateGroups(snapshot, policy).groups.find((g) => g.id === group.groupKey);
      const ids = new Set([research.rootAccountId, ...(detected?.accountIds ?? group.accounts.map((a) => a.id))]);
      const accounts = snapshot.accounts.filter((a) => ids.has(String(a.id)));
      const today = new Date().toISOString().slice(0, 10);
      const run = await researchGroup({
        llm,
        group: research.groupName,
        rootId: research.rootAccountId,
        accounts,
        snapshot,
        policy,
        today,
        budgetMs: RESEARCH_BUDGET_MS,
      });
      const proposal = buildHierarchyProposal({ snapshot, research: run.research, verification: run.verification, policy, today });
      const pages = await ctx.storage.store(new Blob([JSON.stringify(run.pages)], { type: "application/json" }));
      await ctx.runMutation(internal.accountHierarchy.finishResearch, {
        researchId: research._id,
        model: run.model,
        research: plain(run.research),
        // A list, not the url+quote map: Convex field names must be ASCII.
        verification: plain({ checkedAt: run.verification.checkedAt, checks: Object.values(run.verification.checks) }),
        proposal: plain(proposalToJson(proposal)),
        pages,
      });
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error));
    }
    return null;
  },
});
