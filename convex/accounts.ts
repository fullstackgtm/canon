import { query } from "./_generated/server";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { unrestrictedUser } from "./permissions";

export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return emptyReadiness();
    const rows = await accountRowsForOrg(ctx, user.orgId);
    return readinessFromRows(rows);
  },
});

export const context = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return { readiness: emptyReadiness(), accounts: [], summary: emptySummary() };
    // Single set of reads shared by readiness AND summary — this query used to
    // run the readiness scans twice plus a take(5000) deals scan.
    const rows = await accountRowsForOrg(ctx, user.orgId);
    return {
      readiness: readinessFromRows(rows),
      accounts: rows.accounts,
      summary: {
        accounts: rows.accountCount,
        assignedAccounts: rows.assignedAccounts,
        openPipeline: rows.openPipeline,
        contacts: rows.contactCount,
      },
    };
  },
});

/**
 * Read budget: accounts 1000 + contacts 1000 + org 1 + 2 integration point
 * reads + viewer lookup ~2 ≈ 2,005 worst case (well under the 4096 cap), and
 * `context` performs these reads exactly ONCE. Deals are never scanned here:
 * openPipeline and total account/contact counts come from org.crmCounts
 * (maintained at sync end). Ownership/coverage signals are computed over the
 * bounded 1000-row samples.
 */
async function accountRowsForOrg(ctx: any, orgId: any) {
  const [org, accounts, contacts, hubspot, salesforce] = await Promise.all([
    ctx.db.get(orgId),
    ctx.db.query("crmAccounts").withIndex("by_orgId", (q: any) => q.eq("orgId", orgId)).take(1000),
    ctx.db.query("crmContacts").withIndex("by_orgId", (q: any) => q.eq("orgId", orgId)).take(1000),
    ctx.db.query("integrations").withIndex("by_orgId_provider", (q: any) => q.eq("orgId", orgId).eq("provider", "hubspot")).first(),
    ctx.db.query("integrations").withIndex("by_orgId_provider", (q: any) => q.eq("orgId", orgId).eq("provider", "salesforce")).first(),
  ]);

  const crmCounts = org?.crmCounts;
  return {
    accounts,
    // Exact totals from the maintained counters when synced; the bounded
    // sample length is the fallback for orgs that have never synced.
    accountCount: crmCounts?.accounts ?? accounts.length,
    contactCount: crmCounts?.contacts ?? contacts.length,
    openPipeline: crmCounts?.openPipeline ?? 0,
    assignedAccounts: accounts.filter((account: any) => account.ownerId).length,
    sampledAccounts: accounts.length,
    accountsWithContacts: new Set(
      contacts.map((contact: any) => contact.accountId).filter(Boolean),
    ).size,
    connected: Boolean(hubspot?.isActive || salesforce?.isActive),
  };
}

function readinessFromRows(rows: Awaited<ReturnType<typeof accountRowsForOrg>>) {
  const { accountCount, assignedAccounts, sampledAccounts, connected } = rows;
  return {
    noun: "account",
    required: true,
    relevant: connected || accountCount > 0,
    configured: accountCount > 0,
    lifecycle: !connected && accountCount === 0 ? "not_connected" : accountCount > 0 ? "synced" : "connected_no_records",
    signals: {
      crmConnected: connected,
      accountCount,
      // Ownership/coverage are computed over a bounded 1000-account sample.
      assignedAccounts,
      ownershipPct: sampledAccounts > 0 ? assignedAccounts / sampledAccounts : 0,
      accountsWithContacts: rows.accountsWithContacts,
      openPipeline: rows.openPipeline,
    },
    nextActions: accountCount > 0
      ? assignedAccounts / Math.max(sampledAccounts, 1) < 0.8
        ? ["set account.owner", "review account coverage", "do account.enrich"]
        : ["do account.enrich", "review ICP/health/ABM views"]
      : ["connect CRM", "do account.bootstrap", "parse account_csv"],
  };
}

function emptySummary() {
  return { accounts: 0, assignedAccounts: 0, openPipeline: 0, contacts: 0 };
}

function emptyReadiness() {
  return {
    noun: "account",
    required: true,
    relevant: false,
    configured: false,
    lifecycle: "not_connected",
    signals: { crmConnected: false, accountCount: 0, assignedAccounts: 0, ownershipPct: 0, accountsWithContacts: 0, openPipeline: 0 },
    nextActions: ["Sign in to inspect account readiness"],
  };
}
