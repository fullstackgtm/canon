/**
 * A paid source run on the whole market (Add records -> Paid sources): the
 * population pipeline pages through one paid provider, holding credits before
 * each call and settling to treg's metered cost x1.1 after it (populateActions
 * + credits.ts). It stops at the cap the admin set, waits when the workspace
 * runs out of credits, and holds what it finds for review like any Market fill.
 */
import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { startPopulation } from "./populateActions";
import { marketIsNarrow } from "./lib/addRecords";
import { paidProvider } from "./lib/paidProviders";
import { MICRO, minCapCredits } from "./lib/creditPacks";
import { paidCallsAllowed } from "./lib/treg";

const personaValidator = v.object({ levels: v.array(v.string()), departments: v.array(v.string()), titles: v.array(v.string()), countries: v.optional(v.array(v.string())) });
const marketValidator = v.object({ industries: v.array(v.string()), employeeBands: v.array(v.string()), countries: v.array(v.string()) });


export const start = action({
  args: { provider: v.string(), market: marketValidator, persona: personaValidator, capCredits: v.number() },
  handler: async (ctx, args): Promise<{ jobId: Id<"backgroundJobs"> }> => {
    // Who may run a fill, and how many are running: the same rule as every Add records fill.
    const { orgId, running } = await ctx.runQuery(internal.addRecords.scope, {});
    if (!process.env.TREG_TOKEN) throw new ConvexError("Data sources aren't configured on this deployment.");
    if (!paidCallsAllowed()) throw new ConvexError("Paid sources are switched off on this deployment.");
    if (running >= 3) throw new ConvexError(`${running} fills are already running. Wait for one to finish, then try again.`);
    const provider = paidProvider(args.provider);
    if (!provider) throw new ConvexError(`Unknown source "${args.provider}".`);
    if (!marketIsNarrow(args.market)) throw new ConvexError("Pick at least one industry, company size or country.");
    // The cap has to cover at least one page's hold, or the run could never fetch anything.
    const minCap = minCapCredits(provider);
    if (!Number.isFinite(args.capCredits) || args.capCredits < minCap) throw new ConvexError(`Set a cap of at least ${minCap} credits for ${provider.label}.`);
    const capMicro = Math.round(args.capCredits * MICRO);
    const { spendableMicro } = await ctx.runQuery(internal.credits.balanceOf, { orgId });
    if (spendableMicro < minCap * MICRO) throw new ConvexError("Not enough credits for one page. Buy credits in Settings → Billing & usage.");
    if (capMicro > spendableMicro) throw new ConvexError(`The cap is more than your ${Math.floor(spendableMicro / MICRO).toLocaleString("en-US")} credits.`);
    const jobId = await startPopulation(
      ctx, undefined, orgId,
      [{ kind: "people", source: "paid", provider: provider.id, market: args.market, persona: args.persona, page: 1 }],
      { title: `${provider.label}: market run`, detail: `Searching with up to ${args.capCredits.toLocaleString("en-US")} credits…` },
      { stage: true, capMicro },
    );
    return { jobId };
  },
});
