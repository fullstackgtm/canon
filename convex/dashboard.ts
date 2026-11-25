import { query } from "./_generated/server";
// CP14: these pages read the CRM mirror and deal tables whole, so a role whose rules narrow its reads sees them empty.
import { unrestrictedUser } from "./permissions";
import { createTracer } from "./lib/profiler";

// At most 2,724 data reads, leaving headroom for authorization and index boundaries.
const DASHBOARD_LIMITS = { deals: 1000, window: 1500, integrations: 20, users: 200 };

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
    const currentMonth = monthRange(0);
    const previousMonth = monthRange(-1);
    const currentQuarter = quarterRange(0);
    const previousQuarter = quarterRange(-1);
    const windowRows = await trace.track("windowDeals", () =>
      ctx.db.query("deals")
        .withIndex("by_orgId_closeDate", (q) => q.eq("orgId", user.orgId)
          .gte("closeDate", previousQuarter.start).lte("closeDate", currentQuarter.end))
        .take(DASHBOARD_LIMITS.window + 1),
    );
    const windowDeals = windowRows.slice(0, DASHBOARD_LIMITS.window).filter((deal) => deal.archivedAt === undefined);
    const deals = await trace.track("deals", () =>
      ctx.db
        .query("deals")
        .withIndex("by_orgId_archivedAt", (q) => q.eq("orgId", user.orgId).eq("archivedAt", undefined))
        .take(DASHBOARD_LIMITS.deals + 1),
    );
    const users = await trace.track("users", () =>
      ctx.db
        .query("users")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(DASHBOARD_LIMITS.users + 1),
    );
    const integrations = await trace.track("integrations", () =>
      ctx.db
        .query("integrations")
        .withIndex("by_orgId", (q) => q.eq("orgId", user.orgId))
        .take(DASHBOARD_LIMITS.integrations + 1),
    );

    const truncated = {
      deals: deals.length > DASHBOARD_LIMITS.deals,
      window: windowRows.length > DASHBOARD_LIMITS.window,
      users: users.length > DASHBOARD_LIMITS.users,
      integrations: integrations.length > DASHBOARD_LIMITS.integrations,
    };

    const openDeals = deals.filter((deal) => !deal.isClosed);
    const wonDeals = windowDeals.filter(
      (deal) => deal.isClosed && deal.isWon && deal.forecastCategory === "closed_won",
    );
    const closedDeals = windowDeals.filter((deal) => deal.isClosed);
    const currentQuarterClosed = closedDeals.filter((deal) =>
      inRange(deal.closeDate, currentQuarter),
    );

    const openPipeline = openDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
    const currentQuarterPipeline = windowDeals.filter((deal) => !deal.isClosed)
      .filter((deal) => inRange(deal.closeDate, currentQuarter))
      .reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
    const previousQuarterPipeline = windowDeals.filter((deal) => !deal.isClosed)
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

    trace.end({ orgId: user.orgId, truncated });

    return {
      truncated,
      orgName: org?.name ?? "Workspace",
      metrics: {
        // Prefer the maintained counters (exact at any scale); the bounded
        // deal scan is the fallback for orgs that have never synced.
        openPipeline: crmCounts?.openPipeline ?? (truncated.deals ? null : openPipeline),
        mtdRevenue: truncated.window ? null : mtdRevenue,
        winRate: truncated.window ? null : winRate,
        activeTeam: truncated.users ? null : activeUsers.length,
        openDeals: crmCounts?.openDeals ?? (truncated.deals ? null : openDeals.length),
        totalDeals: crmCounts?.deals ?? (truncated.deals ? null : deals.length),
        accounts: crmCounts?.accounts ?? 0,
        contacts: crmCounts?.contacts ?? 0,
        unownedDeals:
          crmCounts?.unownedDeals ?? (truncated.deals ? null : deals.filter((deal) => !deal.primaryRepId).length),
        connectedCrmCount: truncated.integrations ? null : connectedIntegrations.length,
      },
      changes: {
        openPipeline: truncated.window ? undefined : percentChange(
          currentQuarterPipeline,
          previousQuarterPipeline,
        ),
        mtdRevenue: truncated.window ? undefined : percentChange(mtdRevenue, previousMonthRevenue),
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
