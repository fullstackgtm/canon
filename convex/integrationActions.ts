import { internalAction } from "./_generated/server";
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { internal } from "./_generated/api";

// Page size for the cross-tenant due-scan. Each page is its own query call,
// so reads per query ≈ SYNC_SCAN_PAGE « the 4096-read cap, no matter how many
// tenants exist.
const SYNC_SCAN_PAGE = 200;

export const runScheduledSyncs = internalAction({
  args: {},
  handler: async (ctx): Promise<{ synced: number }> => {
    type DuePage = {
      due: Array<{
        orgId: any;
        provider: "hubspot" | "salesforce" | "gong" | "chorus" | "fathom" | "avoma" | "granola";
      }>;
      continueCursor: string;
      isDone: boolean;
    };

    let synced = 0;
    let cursor: string | null = null;
    // Cursor-paginate the integrations table; each iteration is an
    // independent query transaction with its own read budget.
    for (;;) {
      const page: DuePage = await ctx.runQuery(
        internal.integrations.listDueForScheduledSync,
        { now: Date.now(), cursor, numItems: SYNC_SCAN_PAGE },
      );

      // Each sync is its own scheduled action: one org's slow or failing sync
      // neither eats this cron's time limit nor stops the orgs after it.
      for (const integration of page.due) {
        if (integration.provider === "salesforce" && !integrationEnabled("salesforce")) continue;
        if (integration.provider === "hubspot") {
          await ctx.scheduler.runAfter(0, internal.hubspotActions.syncAllInternal, {
            orgId: integration.orgId,
            trigger: "scheduled",
          });
        } else if (integration.provider === "salesforce") {
          await ctx.scheduler.runAfter(0, internal.salesforceActions.syncAllInternal, {
            orgId: integration.orgId,
            trigger: "scheduled",
          });
        } else {
          await ctx.scheduler.runAfter(0, internal.callProviderActions.syncProviderInternal, {
            orgId: integration.orgId,
            provider: integration.provider,
            trigger: "scheduled",
          });
        }
        synced += 1;
      }

      if (page.isDone) break;
      cursor = page.continueCursor;
    }

    return { synced };
  },
});
