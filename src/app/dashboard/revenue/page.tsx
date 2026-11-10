"use client";

import { useObjectLabels } from "@/components/records/object-labels";
import { defaultModel } from "../../../../recipes";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cn, formatCompactCurrency } from "@/lib/utils";
import {
  ViewFrame,
  EmptyState,
  LoadingRows,
  DataTable,
  StatusBadge,
  SummaryCard,
} from "@/components/dashboard";
import {
  BarChart3,
  CalendarClock,
  CircleDollarSign,
  Target,
  TrendingUp,
  Trophy,
} from "lucide-react";
import { forecastRows, openPipelineOf } from "@/lib/revenue";
import { SelectField } from "@/components/ui/select";

type ForecastCategory =
  | "omit"
  | "pipeline"
  | "best_case"
  | "commit"
  | "closed_won"
  | "closed_lost";

type Tab = "pipeline" | "bookings";

const editableForecastOptions: Array<{ value: ForecastCategory; label: string }> = [
  { value: "pipeline", label: "Pipeline" },
  { value: "best_case", label: "Best Case" },
  { value: "commit", label: "Commit" },
  { value: "closed_won", label: "Closed Won" },
  { value: "closed_lost", label: "Closed Lost" },
  { value: "omit", label: "Omit" },
];

function daysUntil(date: string) {
  const target = new Date(`${date}T00:00:00Z`).getTime();
  const today = new Date();
  const current = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  return Math.ceil((target - current) / 86_400_000);
}

export default function RevenuePage() {
  const names = useObjectLabels();
  const workspace = useQuery(api.deals.context);
  const deals = workspace?.deals;
  const updateForecast = useMutation(api.deals.updateForecast);

  const [tab, setTab] = useState<Tab>("pipeline");
  const [savingId, setSavingId] = useState<string | null>(null);


  const openDeals = useMemo(
    () => (deals ?? []).filter((deal) => !deal.isClosed),
    [deals],
  );
  const wonDeals = useMemo(
    () => (deals ?? []).filter((deal) => deal.isWon),
    [deals],
  );
  const closedDeals = useMemo(
    () => (deals ?? []).filter((deal) => deal.isClosed),
    [deals],
  );

  const weights = workspace?.forecast?.weights;
  const closingDays = workspace?.forecast?.closingDays ?? defaultModel("forecast.model").closingDays;
  const categoryRows = useMemo(() => (weights ? forecastRows(openDeals, weights) : []), [openDeals, weights]);

  const pipelineSummary = useMemo(() => {
    const totalPipeline = openPipelineOf(openDeals).amount;
    const weighted = categoryRows.reduce((sum, row) => sum + row.weighted, 0);
    const commit =
      categoryRows.find((row) => row.key === "commit")?.amount ?? 0;
    const pastDue = openDeals.filter((deal) => daysUntil(deal.closeDate) < 0);
    const next30 = openDeals.filter((deal) => {
      const days = daysUntil(deal.closeDate);
      return days >= 0 && days <= closingDays;
    });
    return {
      totalPipeline,
      weighted,
      commit,
      pastDueAmount: pastDue.reduce((sum, deal) => sum + (deal.amount ?? 0), 0),
      pastDueCount: pastDue.length,
      next30Amount: next30.reduce((sum, deal) => sum + (deal.amount ?? 0), 0),
      next30Count: next30.length,
    };
  }, [categoryRows, openDeals, closingDays]);

  const bookingsSummary = useMemo(() => {
    const total = wonDeals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
    const quarter = workspace?.quarter;
    const quarterWon = quarter ? wonDeals.filter((deal) => deal.closeDate >= quarter.start && deal.closeDate <= quarter.end) : [];
    const winRate =
      closedDeals.length > 0 ? wonDeals.length / closedDeals.length : 0;
    return {
      total,
      count: wonDeals.length,
      quarterAmount: quarterWon.reduce((sum, deal) => sum + (deal.amount ?? 0), 0),
      quarterCount: quarterWon.length,
      winRate,
      avgDealSize: wonDeals.length > 0 ? total / wonDeals.length : 0,
    };
  }, [closedDeals.length, workspace?.quarter, wonDeals]);

  const maxCategoryAmount = Math.max(...categoryRows.map((row) => row.amount), 1);

  async function handleForecastChange(
    dealId: Id<"deals">,
    forecastCategory: ForecastCategory,
  ) {
    setSavingId(dealId);
    try {
      await updateForecast({ dealId, forecastCategory });
    } finally {
      setSavingId(null);
    }
  }

  const dealNameColumn = {
    key: "name",
    header: names("deal")!.label,
    searchValue: (deal: NonNullable<typeof deals>[number]) =>
      `${deal.name} ${deal.accountName ?? ""} ${deal.accountDomain ?? ""}`,
    render: (deal: NonNullable<typeof deals>[number]) => (
      <div>
        <div className="font-medium">{deal.name}</div>
        <div className="text-xs text-muted-foreground">
          {deal.accountName ?? "No account linked"}
        </div>
      </div>
    ),
  };

  return (
    <ViewFrame
      title="Revenue"
      actions={[{ id: "revenue-sync", label: "Sync CRM", href: "/dashboard/integrations", primary: true }]}
      controls={deals?.length ? (
        <div role="tablist" className="flex gap-1">
          {(
            [
              { key: "pipeline", label: "Pipeline" },
              { key: "bookings", label: "Bookings" },
            ] as Array<{ key: Tab; label: string }>
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                "border-b-2 px-4 py-2 text-sm font-medium",
                tab === item.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : undefined}
    >
      <p className="mb-6 text-xs text-muted-foreground">
        The same numbers, as reports you can change and pin: <Link href="/dashboard/dashboards" className="underline hover:text-foreground">the Revenue dashboard</Link>.
      </p>

      {deals === undefined ? (
        <LoadingRows count={4} />
      ) : deals.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No deals yet"
          description="Connect your CRM to sync deals automatically."
          action={{ label: "Connect CRM", href: "/dashboard/integrations" }}
        />
      ) : (
        <div className="space-y-6">
          {tab === "pipeline" && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <SummaryCard
                  label="Open Pipeline"
                  value={formatCompactCurrency(pipelineSummary.totalPipeline)}
                  icon={BarChart3}
                />
                <SummaryCard
                  label="Weighted Forecast"
                  value={formatCompactCurrency(pipelineSummary.weighted)}
                  icon={TrendingUp}
                />
                <SummaryCard
                  label="Commit"
                  value={formatCompactCurrency(pipelineSummary.commit)}
                  icon={Target}
                />
                <SummaryCard
                  label={`Closing ${closingDays} Days`}
                  value={formatCompactCurrency(pipelineSummary.next30Amount)}
                  icon={CalendarClock}
                />
              </div>

              <section className="rounded-xl border border-border bg-card p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold">Forecast Mix</h2>
                  </div>
                  {pipelineSummary.pastDueCount > 0 && (
                    <div className="text-right text-sm">
                      <div className="font-semibold text-destructive">
                        {formatCompactCurrency(pipelineSummary.pastDueAmount)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {pipelineSummary.pastDueCount} past-due deals
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-5 grid grid-cols-1 gap-3 xl:grid-cols-4">
                  {categoryRows.map((row) => (
                    <div key={row.key} className="border-t border-border/70 pt-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium">{row.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {row.count} deals / {Math.round(row.weight * 100)}%
                            weight
                          </div>
                        </div>
                      </div>
                      <div className="mt-4">
                        <div className="flex items-end justify-between gap-3">
                          <div className="text-xl font-semibold">
                            {formatCompactCurrency(row.amount)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            weighted {formatCompactCurrency(row.weighted)}
                          </div>
                        </div>
                        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{
                              width: `${Math.max((row.amount / maxCategoryAmount) * 100, row.amount > 0 ? 8 : 0)}%`,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <DataTable
                searchPlaceholder="Search open deals by name, account, rep, stage..."
                initialSort={{ key: "amount", direction: "desc" }}
                columns={[
                  dealNameColumn,
                  {
                    key: "amount",
                    header: "Amount",
                    sortValue: (deal) => deal.amount ?? 0,
                    render: (deal) => (
                      <span className="font-medium">
                        {deal.amount === undefined ? "\u2014" : formatCompactCurrency(deal.amount)}
                      </span>
                    ),
                  },
                  {
                    key: "forecast",
                    header: "Forecast",
                    sortValue: (deal) => deal.forecastCategory ?? "pipeline",
                    render: (deal) => {
                      const forecastCategory = (deal.forecastCategory ??
                        "pipeline") as ForecastCategory;
                      return (
                        <SelectField
                          aria-label="Forecast category"
                          value={forecastCategory}
                          disabled={savingId === deal._id}
                          onValueChange={(v) =>
                            handleForecastChange(deal._id, v as ForecastCategory)
                          }
                          options={editableForecastOptions}
                        />
                      );
                    },
                  },
                  {
                    key: "closeDate",
                    header: "Close",
                    sortValue: (deal) => deal.closeDate,
                    render: (deal) => {
                      const days = daysUntil(deal.closeDate);
                      return (
                        <div>
                          <div>{deal.closeDate}</div>
                          <div
                            className={cn(
                              "text-xs",
                              days < 0
                                ? "text-destructive"
                                : "text-muted-foreground",
                            )}
                          >
                            {days < 0
                              ? `${Math.abs(days)} days overdue`
                              : `${days} days left`}
                          </div>
                        </div>
                      );
                    },
                  },
                  {
                    key: "rep",
                    header: "Owner",
                    sortValue: (deal) => deal.primaryRepName,
                    searchValue: (deal) => deal.primaryRepName,
                    render: (deal) => (
                      <div>
                        <div>{deal.primaryRepName}</div>
                        <div className="text-xs text-muted-foreground">
                          {deal.stage || "Unstaged"}
                        </div>
                      </div>
                    ),
                  },
                ]}
                data={openDeals}
                rowKey={(deal) => deal._id}
              />
            </div>
          )}

          {tab === "bookings" && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <SummaryCard
                  label="Closed Won (All Time)"
                  value={formatCompactCurrency(bookingsSummary.total)}
                  icon={CircleDollarSign}
                />
                <SummaryCard
                  label={`Closed Won (${workspace?.quarter?.label ?? "Quarter"})`}
                  value={formatCompactCurrency(bookingsSummary.quarterAmount)}
                  icon={CalendarClock}
                />
                <SummaryCard
                  label="Win Rate"
                  value={
                    closedDeals.length > 0
                      ? `${Math.round(bookingsSummary.winRate * 100)}%`
                      : "—"
                  }
                  icon={Trophy}
                />
                <SummaryCard
                  label="Avg Deal Size"
                  value={formatCompactCurrency(
                    Math.round(bookingsSummary.avgDealSize),
                  )}
                  icon={Target}
                />
              </div>

              {wonDeals.length === 0 ? (
                <EmptyState
                  icon={Trophy}
                  title="No closed-won deals yet"
                  description="Won deals from the CRM (and Stripe-backfilled invoices) appear here."
                />
              ) : (
                <DataTable
                  searchPlaceholder="Search won deals by name, account, rep..."
                  initialSort={{ key: "closeDate", direction: "desc" }}
                  columns={[
                    dealNameColumn,
                    {
                      key: "amount",
                      header: "Amount",
                      sortValue: (deal) => deal.amount ?? 0,
                      render: (deal) => (
                        <span className="font-medium">
                          {deal.amount === undefined ? "\u2014" : formatCompactCurrency(deal.amount)}
                        </span>
                      ),
                    },
                    {
                      key: "closeDate",
                      header: "Closed",
                      sortValue: (deal) => deal.closeDate,
                      render: (deal) => (
                        <span className="text-muted-foreground">
                          {deal.closeDate}
                        </span>
                      ),
                    },
                    {
                      key: "rep",
                      header: "Owner",
                      sortValue: (deal) => deal.primaryRepName,
                      searchValue: (deal) => deal.primaryRepName,
                      render: (deal) => <span>{deal.primaryRepName}</span>,
                    },
                    {
                      key: "dealType",
                      header: "Type",
                      sortValue: (deal) => deal.dealType,
                      render: (deal) => <StatusBadge status={deal.dealType} />,
                    },
                  ]}
                  data={wonDeals}
                  rowKey={(deal) => deal._id}
                />
              )}
            </div>
          )}
        </div>
      )}
    </ViewFrame>
  );
}
