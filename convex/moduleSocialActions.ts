"use node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { fakeModel } from "./lib/modules/ai";
import { searchSocial } from "./lib/social/search";
import { socialSearchRequest, SOCIAL_MAX_USD, type SocialRow } from "../modules/kernel/social.ts";
import { MICRO, creditsForCost } from "./lib/creditPacks";
import { paidCallsAllowed, TregTransportError } from "./lib/treg";

export const search = internalAction({
  args: { searches: v.array(v.object({ source: v.string(), query: v.string(), limit: v.number() })), orgId: v.id("organizations"), userId: v.id("users"), module: v.string() },
  handler: async (ctx, a): Promise<SocialRow[][]> => {
    if (!a.searches.length || a.searches.length > 12) throw new Error("A social search step needs 1 to 12 queries.");
    const requests = a.searches.map(socialSearchRequest);
    const fake = fakeModel();
    const amountMicro = fake ? 0 : requests.reduce((sum, r) => sum + (SOCIAL_MAX_USD[r.source] > 0 ? creditsForCost(SOCIAL_MAX_USD[r.source]) * MICRO : 0), 0);
    const holdRef = `pull:${a.orgId}:hold:${crypto.randomUUID()}`;
    if (amountMicro > 0) {
      if (!paidCallsAllowed()) throw new Error("Paid social searches are switched off on this deployment.");
      if (!process.env.TREG_TOKEN) throw new Error("Social search requires the treg token.");
      const held = await ctx.runMutation(internal.credits.hold, { orgId: a.orgId, ref: holdRef, amountMicro, note: "Pull search step" });
      if (!held.ok) throw new Error("The workspace needs more credits for this social search step.");
    }
    const results: SocialRow[][] = [];
    let uncertain = false;
    try {
      for (const request of requests) {
        results.push(await searchSocial(request, { fake, token: fake ? undefined : process.env.TREG_TOKEN, orgId: a.orgId, onPaid: async (res) => {
          if (res.costMicro === null) {
            if (res.status < 200 || res.status >= 300) return;
            throw new Error("The social provider returned no metered cost.");
          }
          if (res.costMicro > 0) {
            uncertain = true;
            if (!res.callId) throw new Error("The social provider returned a charge without a receipt; its credit reservation is retained.");
            const ref = `pull:${a.orgId}:${res.callId}`;
            const charge = { holdRef, ref, amountMicro: creditsForCost(res.costMicro / 1_000_000) * MICRO, note: `Pull ${request.source} search` };
            try { await ctx.runMutation(internal.credits.chargeHeld, charge); }
            catch (error) {
              await ctx.scheduler.runAfter(0, internal.credits.chargeHeld, { ...charge, releaseRemainder: true });
              throw error;
            }
          }
          uncertain = false;
          await ctx.runMutation(internal.records.recordProviderCall, { orgId: a.orgId, endpoint: `social.search:${request.source}`, feature: "pull", ...(res.callId ? { callId: res.callId } : {}), costMicro: res.costMicro, outcome: res.status >= 200 && res.status < 300 ? "hit" : "miss" });
        } }));
      }
      return results;
    } catch (error) {
      if (error instanceof TregTransportError) uncertain = true;
      throw error;
    } finally {
      // Transport ambiguity and failed receipt settlement retain the hold until its scheduled expiry.
      if (amountMicro > 0 && !uncertain) await ctx.runMutation(internal.credits.settle, { ref: holdRef, chargeMicro: 0 });
    }
  },
});
