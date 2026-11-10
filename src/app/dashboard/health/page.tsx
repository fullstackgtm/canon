"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { cn, formatCompactCurrency, getErrorMessage } from "@/lib/utils";
import {
  ViewFrame,
  EmptyState,
  LoadingCards,
  LoadingRows,
  SummaryCard,
  StatusBadge,
  DataTable,
} from "@/components/dashboard";
import {
  Heart,
  Users,
  ShieldCheck,
  AlertTriangle,
  TrendingDown,
  DollarSign,
  Settings2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react";

type HealthFilter = "all" | "healthy" | "at_risk" | "churning";

type SignalBreakdown = {
  wonRevenue?: number;
  crmAnnualRevenue?: number;
  contacts?: number;
  openExpansion?: number;
  openPipeline?: number;
  hasOwner?: boolean;
  hasCustomerSignal?: boolean;
  syncAgeDays?: number;
  components?: Record<string, number>;
};

type HealthConfigSignal = {
  name: string;
  source: string;
  weight: number;
  goodThreshold: number;
  badThreshold: number;
};

const filterTabs: { key: HealthFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "healthy", label: "Healthy" },
  { key: "at_risk", label: "At Risk" },
  { key: "churning", label: "Churning" },
];

const expansionRank = {
  high: 3,
  medium: 2,
  low: 1,
};

function healthLabel(health: string) {
  return health
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function scoreBarColor(score: number, bands: { healthy: number; atRisk: number } | null | undefined) {
  if (!bands) return "bg-muted";
  if (score >= bands.healthy) return "bg-primary";
  if (score >= bands.atRisk) return "bg-warning";
  return "bg-destructive";
}

function normalizeSignalBreakdown(value: unknown): SignalBreakdown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as SignalBreakdown;
}

function formatDate(date: string | undefined) {
  if (!date) return "---";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00`));
}

function formatSyncAge(days: number | undefined) {
  if (days === undefined) return "No sync age";
  if (days <= 1) return "Synced today";
  if (days >= 365) return ">1y since sync";
  return `${days}d since sync`;
}

function formatWeight(weight: number) {
  const normalized = weight <= 1 ? weight * 100 : weight;
  return `${normalized.toFixed(0)}%`;
}

function formatThreshold(signal: HealthConfigSignal, threshold: number) {
  if (signal.source === "deals" && threshold >= 1000) {
    return formatCompactCurrency(threshold);
  }
  return threshold.toLocaleString();
}

export default function HealthPage() {
  const [filter, setFilter] = useState<HealthFilter>("all");
  const [showConfig, setShowConfig] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [runNotice, setRunNotice] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  const workspace = useQuery(api.customerHealth.context);
  const scores = workspace?.scores;
  const stats = useQuery(api.customerHealth.getStats);
  const configs = workspace?.configs;
  const generateScores = useMutation(api.customerHealth.generateFromCrm);

  const activeConfig = configs?.find((config) => config.isActive);

  const filteredScores = useMemo(() => {
    if (!scores) return [];
    if (filter === "all") return scores;
    return scores.filter((score) => score.health === filter);
  }, [filter, scores]);

  async function handleGenerateScores() {
    if (generating) return;
    setGenerating(true);
    setRunNotice(null);

    try {
      const result = await generateScores({});
      setRunNotice({
        kind: "success",
        message:
          result.scored > 0
            ? `Scored ${result.scored} CRM account${result.scored === 1 ? "" : "s"} from inherited revenue, contact, owner, pipeline, and sync data.`
            : "No CRM accounts were available to score.",
      });
    } catch (error) {
      setRunNotice({ kind: "error", message: getErrorMessage(error) });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <ViewFrame
      title="Customer Health"
      actions={[{ id: "health-score", label: generating ? "Scoring..." : "Score CRM", onClick: handleGenerateScores, disabled: generating, primary: true,
        icon: <RefreshCw className={cn("size-3.5", generating && "animate-spin")} /> }]}
    >
      {runNotice && (
        <div
          className={cn(
            "mb-6 rounded-lg border px-4 py-3 text-sm",
            runNotice.kind === "success"
              ? "border-primary/40 bg-primary/15 text-primary"
              : "border-destructive/40 bg-destructive/15 text-destructive",
          )}
        >
          {runNotice.message}
        </div>
      )}

      {stats === undefined ? (
        <LoadingCards count={5} className="lg:grid-cols-5" />
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <SummaryCard label="Total Customers" value={stats.total} icon={Users} />
          <SummaryCard label="Healthy" value={stats.healthy} icon={ShieldCheck} />
          <SummaryCard label="At Risk" value={stats.atRisk} icon={AlertTriangle} />
          <SummaryCard label="Churning" value={stats.churning} icon={TrendingDown} />
          <SummaryCard
            label="ARR at Risk"
            value={formatCompactCurrency(stats.totalArrAtRisk)}
            icon={DollarSign}
          />
        </div>
      )}

      {scores === undefined ? (
        <LoadingRows count={6} height="h-14" />
      ) : scores.length === 0 ? (
        <EmptyState
          icon={Heart}
          title="No health scores yet"
          description="Score inherited CRM accounts to create a starting health model from revenue, contacts, ownership, pipeline, and sync freshness."
          details={[
            {
              label: "Health inputs",
              value: "CRM accounts, customer status, revenue, owner coverage, contact coverage, open pipeline, and sync freshness.",
            },
            {
              label: "Shared outputs",
              value: "Health scores feed renewal risk, expansion focus, headcount gaps, budgets, and executive account reviews.",
            },
          ]}
          suggestions={[
            "Score all synced customer accounts before creating manual health spreadsheets.",
            "Use missing owner or contact coverage as immediate cleanup actions.",
            "Push high-risk account segments into playbooks, budget planning, and executive review workflows.",
          ]}
          action={{
            label: generating ? "Scoring..." : "Score CRM accounts",
            onClick: handleGenerateScores,
          }}
        />
      ) : (
        <DataTable
          className="mb-8 bg-card shadow-sm"
          searchPlaceholder="Search accounts, domains, industries, signals..."
          initialSort={{ key: "score", direction: "asc" }}
          data={filteredScores}
          rowKey={(score) => score._id}
          filters={
            <div className="flex items-center gap-1 border-b border-border/70 pb-1">
              {filterTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setFilter(tab.key)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    filter === tab.key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          }
          columns={[
            {
              key: "account",
              header: "Account",
              searchValue: (score) =>
                `${score.accountName} ${score.accountDomain ?? ""} ${score.accountIndustry ?? ""}`,
              render: (score) => (
                <div>
                  <div className="font-medium">{score.accountName}</div>
                  <div className="text-xs text-muted-foreground">
                    {score.accountDomain ?? score.accountIndustry ?? "CRM account"}
                  </div>
                </div>
              ),
            },
            {
              key: "score",
              header: "Score",
              sortValue: (score) => score.overallScore,
              className: "min-w-[170px]",
              render: (score) => (
                <div className="flex items-center gap-3">
                  <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full transition-transform",
                        scoreBarColor(score.overallScore, workspace?.bands),
                      )}
                      style={{ width: `${Math.min(score.overallScore, 100)}%` }}
                    />
                  </div>
                  <span className="w-8 text-sm font-semibold tabular-nums">
                    {score.overallScore}
                  </span>
                </div>
              ),
            },
            {
              key: "health",
              header: "Health",
              searchValue: (score) => healthLabel(score.health),
              render: (score) => <StatusBadge status={score.health} />,
            },
            {
              key: "arr",
              header: "Won ARR",
              sortValue: (score) => score.arrAmount ?? 0,
              className: "text-right",
              render: (score) => (
                <span className="tabular-nums">
                  {score.arrAmount
                    ? formatCompactCurrency(score.arrAmount)
                    : "---"}
                </span>
              ),
            },
            {
              key: "renewal",
              header: "Renewal / Review",
              sortValue: (score) => score.renewalDate ?? "",
              render: (score) => (
                <span className="text-muted-foreground">
                  {formatDate(score.renewalDate)}
                </span>
              ),
            },
            {
              key: "expansion",
              header: "Expansion",
              sortValue: (score) =>
                score.expansionPotential
                  ? expansionRank[score.expansionPotential]
                  : 0,
              render: (score) =>
                score.expansionPotential ? (
                  <StatusBadge status={score.expansionPotential} />
                ) : (
                  <span className="text-muted-foreground">---</span>
                ),
            },
            {
              key: "signals",
              header: "Signals",
              sortable: false,
              searchValue: (score) => {
                const signal = normalizeSignalBreakdown(score.signalBreakdown);
                return `${signal.contacts ?? 0} contacts ${signal.openPipeline ?? 0} pipeline ${signal.hasOwner ? "owner" : "no owner"}`;
              },
              render: (score) => {
                const signal = normalizeSignalBreakdown(score.signalBreakdown);
                const pipeline =
                  (signal.openExpansion ?? 0) > 0
                    ? `${formatCompactCurrency(signal.openExpansion ?? 0)} expansion`
                    : (signal.openPipeline ?? 0) > 0
                      ? `${formatCompactCurrency(signal.openPipeline ?? 0)} pipeline`
                      : "No open pipeline";

                return (
                  <div className="flex max-w-sm flex-wrap gap-1.5">
                    <SignalChip label={`${signal.contacts ?? 0} contacts`} />
                    <SignalChip label={pipeline} />
                    <SignalChip
                      label={signal.hasOwner ? "Owner mapped" : "No owner"}
                    />
                    <SignalChip label={formatSyncAge(signal.syncAgeDays)} />
                  </div>
                );
              },
            },
          ]}
        />
      )}

      <div className="rounded-xl border border-border bg-card shadow-sm">
        <button
          type="button"
          onClick={() => setShowConfig(!showConfig)}
          className="flex w-full items-center justify-between px-6 py-4 text-left"
        >
          <div className="flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Configure Health Scoring</h3>
          </div>
          {showConfig ? (
            <ChevronDown className="h-5 w-5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          )}
        </button>

        {showConfig && (
          <div className="border-t border-border px-6 py-5">
            {configs === undefined ? (
              <LoadingRows count={2} />
            ) : activeConfig ? (
              <div>
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{activeConfig.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {activeConfig.signals.length} signal
                      {activeConfig.signals.length !== 1 ? "s" : ""} configured
                    </p>
                  </div>
                  <StatusBadge status="active" label="Active" />
                </div>
                <DataTable
                  enableSearch={false}
                  initialSort={{ key: "weight", direction: "desc" }}
                  columns={[
                    {
                      key: "signal",
                      header: "Signal",
                      sortValue: (signal) => signal.name,
                      render: (signal) => (
                        <span className="font-medium">{signal.name}</span>
                      ),
                    },
                    {
                      key: "source",
                      header: "Source",
                      sortValue: (signal) => signal.source,
                      render: (signal) => (
                        <span className="text-muted-foreground">
                          {signal.source}
                        </span>
                      ),
                    },
                    {
                      key: "weight",
                      header: "Weight",
                      sortValue: (signal) => signal.weight,
                      render: (signal) => formatWeight(signal.weight),
                      className: "text-right tabular-nums",
                    },
                    {
                      key: "goodThreshold",
                      header: "Good Threshold",
                      sortValue: (signal) => signal.goodThreshold,
                      render: (signal) => (
                        <span className="text-primary">
                          {formatThreshold(signal, signal.goodThreshold)}
                        </span>
                      ),
                      className: "text-right tabular-nums",
                    },
                    {
                      key: "badThreshold",
                      header: "Bad Threshold",
                      sortValue: (signal) => signal.badThreshold,
                      render: (signal) => (
                        <span className="text-destructive">
                          {formatThreshold(signal, signal.badThreshold)}
                        </span>
                      ),
                      className: "text-right tabular-nums",
                    },
                  ]}
                  data={activeConfig.signals}
                  rowKey={(signal) => `${signal.name}-${signal.source}`}
                />
              </div>
            ) : configs.length > 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  No active configuration. Available configs:
                </p>
                {configs.map((config) => (
                  <div
                    key={config._id}
                    className="flex items-center justify-between border-b border-border/70 py-3"
                  >
                    <div>
                      <p className="font-medium">{config.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {config.signals.length} signals
                      </p>
                    </div>
                    <StatusBadge status="inactive" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center">
                <Settings2 className="mx-auto h-8 w-8 text-muted-foreground opacity-30" />
                <p className="mt-2 text-sm text-muted-foreground">
                  No health scoring configuration yet. Score CRM accounts to
                  create the default model.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </ViewFrame>
  );
}

function SignalChip({ label }: { label: string }) {
  return (
    <span className="rounded-md border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
      {label}
    </span>
  );
}
