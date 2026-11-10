/**
 * Workspace import for a claimed research session: provision the workspace in
 * the record service, commit the prepared TAM, then start the session's single
 * population job: the ICP's whole market from free QuickEnrich searches
 * (convex/populateActions.ts). Emails are found later, on demand.
 */
import { v } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { researchPreparation } from "./lib/researchAccess";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Icp } from "../engine/src/icp.ts";
import { clientFor } from "./records";
import { atLeastVersion } from "./lib/recordClient";
import { startPopulation } from "./populateActions";
import { rescoreOrg } from "./icps";
import { icpToQuickEnrich } from "./lib/quickenrich";
import type { AccountInput } from "./lib/recordContract";

async function prepare(ctx: ActionCtx, session: Doc<"researchSessions">) {
  const client = clientFor(ctx);
  const result = await client.prepareResearch({
    ...researchPreparation(session),
    records: (session.tam ?? []) as AccountInput[],
    source: (session.filter as { source?: string } | undefined)?.source ?? "pdl",
  });
  await ctx.runMutation(internal.researchSessions.patchPreparation, { sessionId: session._id, status: "ready", total: result.total });
}

export const prepareSession = internalAction({
  args: { sessionId: v.id("researchSessions"), attempt: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.researchSessions.getInternal, { sessionId: args.sessionId });
    if (!session?.tam || session.preparationStatus === "ready" || researchPreparation(session).expiresAt <= Date.now()) return null;
    const client = clientFor(ctx);
    if (client.mode === "fake") return null;
    try {
      if (!atLeastVersion(await client.contractVersion(), "1.45.0")) {
        await ctx.scheduler.runAfter(120_000, internal.recordActions.prepareSession, args);
        return null;
      }
      await prepare(ctx, session);
    } catch (error) {
      await ctx.runMutation(internal.researchSessions.patchPreparation, { sessionId: args.sessionId, status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "Preparation failed" });
      if ((args.attempt ?? 0) < 3) await ctx.scheduler.runAfter(10_000, internal.recordActions.prepareSession, { sessionId: args.sessionId, attempt: (args.attempt ?? 0) + 1 });
    }
    return null;
  },
});

export const importSession = internalAction({
  args: { sessionId: v.id("researchSessions"), attempt: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.researchSessions.getInternal, { sessionId: args.sessionId });
    if (!session || !session.claimedByOrgId || session.status !== "ready") return null;
    if (session.importStatus === "done") return null;
    const ws = session.claimedByOrgId as string;
    const client = clientFor(ctx);
    // Wait for the staging contract during staggered app/service deploys. Commit remains fill-only.
    if (client.mode === "http" && !atLeastVersion(await client.contractVersion(), "1.45.0")) {
      await ctx.scheduler.runAfter(2 * 60 * 1000, internal.recordActions.importSession, args);
      return null;
    }
    await ctx.runMutation(internal.researchSessions.patchImport, { sessionId: args.sessionId, importStatus: "running" });
    try {
      await client.provision(ws);
      // Store the session's ICP first: the service scores accounts on upsert
      // with the stored ICP, so the TAM (and later contact accounts) land with
      // the same fit the visitor saw before signup.
      // It is also saved as one of the workspace's ICPs (active when none is), and the active ones score as gates.
      // With no active ICP after that (the workspace is at its ICP cap), the session's weights score as before.
      if (session.icp && !session.importedAccounts) {
        await ctx.runMutation(internal.icps.adoptResearch, { orgId: session.claimedByOrgId, sessionId: args.sessionId });
        await rescoreOrg(ctx, session.claimedByOrgId);
      }
      let importedAccounts: number;
      if (client.mode === "http") {
        if (session.preparationStatus !== "ready") await prepare(ctx, session);
        const result = await client.commitResearch(ws, researchPreparation(session).sessionId);
        importedAccounts = result.importedAccounts;
        await ctx.runMutation(internal.researchSessions.patchImport, {
          sessionId: args.sessionId, importStatus: result.done ? "done" : "running", importedAccounts,
        });
        if (!result.done) {
          await ctx.scheduler.runAfter(0, internal.recordActions.importSession, { sessionId: args.sessionId });
          return null;
        }
      } else {
        const tam = (session.tam ?? []) as AccountInput[];
        const result = tam.length ? await client.upsertAccounts(ws, {
          records: tam, source: (session.filter as { source?: string } | undefined)?.source ?? "pdl",
          idempotencyKey: `research:${session.token}:accounts`, fill: "missing",
        }) : { upserted: 0 };
        importedAccounts = result.upserted;
        await ctx.runMutation(internal.researchSessions.patchImport, { sessionId: args.sessionId, importStatus: "done", importedAccounts });
      }
      await ctx.runMutation(internal.onboarding.markStep, { orgId: ws, stepId: "review_icp" });
    } catch (error) {
      await ctx.runMutation(internal.researchSessions.patchImport, {
        sessionId: args.sessionId,
        importStatus: "failed",
        importError: error instanceof Error ? error.message.slice(0, 500) : "Import failed",
      });
      if ((args.attempt ?? 0) < 3) await ctx.scheduler.runAfter(10_000, internal.recordActions.importSession, { sessionId: args.sessionId, attempt: (args.attempt ?? 0) + 1 });
      return null;
    }

    // Population: one job per session, after claim only.
    const reserved = await ctx.runMutation(internal.researchSessions.reserveContactSample, { sessionId: args.sessionId });
    if (!reserved) return null;
    if (!process.env.TREG_TOKEN || !session.icp) {
      await ctx.runMutation(internal.researchSessions.recordContactSample, {
        sessionId: args.sessionId,
        contactsSampled: 0,
        contactsNote: session.icp
          ? "CRM population skipped: TREG_TOKEN is not configured on this deployment."
          : "CRM population skipped: the session has no ICP.",
      });
      return null;
    }
    const icp = session.icp as Icp;
    await ctx.runMutation(internal.researchSessions.recordContactSample, {
      sessionId: args.sessionId, contactsSampled: 0, contactsNote: "Populating your CRM from your market…",
    });
    // The free fill is QuickEnrich only: Leadsforge's free allowance is treg's, shared and
    // paused for every workspace at once, so it is a paid source now.
    await startPopulation(ctx, args.sessionId, session.claimedByOrgId, [
      { kind: "people", source: "quickenrich", query: icpToQuickEnrich(icp) },
    ]);
    return null;
  },
});
