import { query } from "./_generated/server";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { unrestrictedUser } from "./permissions";
import { createTracer } from "./lib/profiler";

/**
 * Read budget (Convex caps one query at 4096 document reads):
 *   deals 3500 + users 400 + integrations 20 + org 1 + viewer lookup ~2
 *   ≈ 3,923 worst case; realistic org (3k deals, 100 users) ≈ 3,103.
 * Account/contact counts come from organizations.crmCounts (maintained at
 * sync end) — scanning 10k contacts + 5k accounts here used to put this
 * query at ~18k reads, past the cap. Deals are still scanned (bounded)
 * because mtdRevenue/winRate need per-deal close dates the counters don't
 * carry; orgs beyond 3,500 deals get date-filtered metrics computed over the
 * 3,500 most recently created deals (see `capped` in the trace).
 */
const DASHBOARD_LIMITS = {
  deals: 3500,
  integrations: 20,
  users: 400,
};

function ymd(date: Date): string {
  return date.toISOString().split("T")[0];
}

function monthRange(offsetMonths = 0) {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1),
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths + 1, 0),
  );
  return { start: ymd(start), end: ymd(end) };
}

function quarterRange(offsetQuarters = 0) {
  const now = new Date();
  const quarterStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      quarterStartMonth + offsetQuarters * 3,
      1,
    ),
  );
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      quarterStartMonth + offsetQuarters * 3 + 3,
      0,
    ),
  );
  return { start: ymd(start), end: ymd(end) };
}

function inRange(value: string, range: { start: string; end: string }) {
  return value >= range.start && value <= range.end;
}

function percentChange(current: number, previous: number): number | undefined {
  if (previous === 0) return undefined;
  return Math.round(((current - previous) / previous) * 100);
}

export const summary = query({
  args: {},
  handler: async (ctx) => {
    const user = await unrestrictedUser(ctx);
    if (!user) return null;

    const trace = createTracer("dashboard.summary");
    const org = await ctx.db.get(user.orgId);
    // Maintained aggregates (refreshed at sync end). Zero when never synced.
    const crmCounts = org?.crmCounts;
    const deals = await trace.track("deals", () =>
      ctx.db
        .query("deals")
        .withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", user.orgId).eq("archivedAt", undefined))
        .take(DASHBOARD_LIMITS.deals),
    );
    const users = await trace.track("users", () =>
      ctx.db
        .query("users")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(DASHBOARD_LIMITS.users),
    );
    const integrations = await trace.track("integrations", () =>
      ctx.db
        .query("integrations")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(DASHBOARD_LIMITS.integrations),
    );

    const currentMonth = monthRange(0);
    const previousMonth = monthRange(-1);
    const currentQuarter = quarterRange(0);
    const previousQuarter = quarterRange(-1);

    const openDeals = deals.filter((deal) => !deal.isClosed);
    const wonDeals = deals.filter(
      (deal) => deal.isClosed && deal.isWon && deal.forecastCategory === "closed_won",
    );
    const closedDeals = deals.filter((deal) => deal.isClosed);
    const currentQuarterClosed = closedDeals.filter((deal) =>
      inRange(deal.closeDate, currentQuarter),
    );

    const openPipeline = openDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
    const currentQuarterPipeline = openDeals
      .filter((deal) => inRange(deal.closeDate, currentQuarter))
      .reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
    const previousQuarterPipeline = openDeals
      .filter((deal) => inRange(deal.closeDate, previousQuarter))
      .reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
    const mtdRevenue = wonDeals
      .filter((deal) => inRange(deal.closeDate, currentMonth))
      .reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
    const previousMonthRevenue = wonDeals
      .filter((deal) => inRange(deal.closeDate, previousMonth))
      .reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
    const winRate =
      currentQuarterClosed.length > 0
        ? currentQuarterClosed.filter((deal) => deal.isWon).length /
          currentQuarterClosed.length
        : 0;

    const activeUsers = users
      .filter((member) => member.isActive && !member.isHidden)
      .sort((a, b) => a.name.localeCompare(b.name));
    const connectedIntegrations = integrations.filter(
      (integration) => integration.isActive,
    );

    // A span whose docs == its cap means the result is TRUNCATED: the
    // date-filtered metrics (mtdRevenue/winRate/changes) are computed over a
    // partial deal list. Counter-backed metrics (accounts/contacts, and
    // pipeline/deal counts when crmCounts is set) are exact regardless.
    trace.end({
      orgId: user.orgId,
      crmCountsAgeMs: crmCounts ? Date.now() - crmCounts.updatedAt : null,
      capped: {
        deals: deals.length === DASHBOARD_LIMITS.deals,
        users: users.length === DASHBOARD_LIMITS.users,
      },
    });

    return {
      orgName: org?.name ?? "Workspace",
      metrics: {
        // Prefer the maintained counters (exact at any scale); the bounded
        // deal scan is the fallback for orgs that have never synced.
        openPipeline: crmCounts?.openPipeline ?? openPipeline,
        mtdRevenue,
        winRate,
        activeTeam: activeUsers.length,
        openDeals: crmCounts?.openDeals ?? openDeals.length,
        totalDeals: crmCounts?.deals ?? deals.length,
        accounts: crmCounts?.accounts ?? 0,
        contacts: crmCounts?.contacts ?? 0,
        unownedDeals:
          crmCounts?.unownedDeals ?? deals.filter((deal) => !deal.primaryRepId).length,
        connectedCrmCount: connectedIntegrations.length,
      },
      changes: {
        openPipeline: percentChange(
          currentQuarterPipeline,
          previousQuarterPipeline,
        ),
        mtdRevenue: percentChange(mtdRevenue, previousMonthRevenue),
      },
      teamMembers: activeUsers.slice(0, 6).map((member) => ({
        _id: member._id,
        name: member.name,
        email: member.email,
        role: member.role,
        title: member.title,
      })),
      integrations: connectedIntegrations.map((integration) => ({
        _id: integration._id,
        provider: integration.provider,
        lastSyncAt: integration.lastSyncAt,
        lastSyncStatus: integration.lastSyncStatus,
        lastSyncDealCount: integration.lastSyncDealCount,
      })),
    };
  },
});
