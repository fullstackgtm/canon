"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "@/lib/toast";
import { api } from "../../../../convex/_generated/api";
import { cn, formatCompactCurrency, getErrorMessage } from "@/lib/utils";
import {
  DataTable,
  ViewFrame,
  EmptyState,
  LoadingCards,
  SummaryCard,
  StatusBadge,
} from "@/components/dashboard";
import {
  Building2,
  Plus,
  ChevronDown,
  ChevronRight,
  Users,
  Target,
  BarChart3,
  RefreshCw,
} from "lucide-react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SelectField } from "@/components/ui/select";

const tierConfig = {
  tier_1: { label: "Tier 1", color: "bg-destructive/15 text-destructive" },
  tier_2: { label: "Tier 2", color: "bg-warning/15 text-warning" },
  tier_3: { label: "Tier 3", color: "bg-muted text-muted-foreground" },
} as const;

const accountStatusConfig = {
  target: { color: "bg-muted text-muted-foreground", label: "Target" },
  engaged: { color: "bg-muted text-muted-foreground", label: "Engaged" },
  opportunity: { color: "bg-muted text-muted-foreground", label: "Opportunity" },
  customer: { color: "bg-primary/15 text-primary", label: "Customer" },
  churned: { color: "bg-destructive/15 text-destructive", label: "Churned" },
} as const;

export default function AbmPage() {
  const workspace = useQuery(api.abm.context);
  const lists = workspace?.lists;
  const stats = useQuery(api.abm.getStats);
  const createList = useMutation(api.abm.createList);
  const addAccount = useMutation(api.abm.addAccount);
  const generateAbm = useMutation(api.abm.generateFromCrm);

  const [expandedListId, setExpandedListId] = useState<Id<"abmLists"> | null>(null);
  const accounts = useQuery(
    api.abm.listAccounts,
    expandedListId ? { listId: expandedListId } : "skip",
  );
  const candidateAccounts = useQuery(
    api.abm.listCandidateAccounts,
    expandedListId ? { listId: expandedListId } : "skip",
  );
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formTier, setFormTier] = useState<"tier_1" | "tier_2" | "tier_3">("tier_1");
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [addingAccount, setAddingAccount] = useState(false);

  async function handleCreateList(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim()) return;
    setSubmitting(true);
    try {
      await createList({
        name: formName.trim(),
        description: formDescription.trim() || undefined,
        tier: formTier,
      });
      setFormName("");
      setFormDescription("");
      setFormTier("tier_1");
      setShowForm(false);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGenerateAbm() {
    if (generating) return;
    setGenerating(true);
    try {
      const result = await generateAbm({});
      setExpandedListId(result.listId);
      toast.success(
        `Generated ${result.accountsAdded + result.accountsUpdated} ABM account update${result.accountsAdded + result.accountsUpdated === 1 ? "" : "s"} from CRM data.`,
      );
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setGenerating(false);
    }
  }

  async function handleAddAccount(listId: Id<"abmLists">) {
    const candidate =
      candidateAccounts?.find((account) => account.accountId === selectedAccountId) ??
      candidateAccounts?.[0];
    if (!candidate) return;

    const payload: {
      listId: Id<"abmLists">;
      accountId: Id<"crmAccounts">;
      ownerId?: Id<"users">;
      engagementScore?: number;
      status?: "target" | "engaged" | "opportunity" | "customer" | "churned";
    } = {
      listId,
      accountId: candidate.accountId,
      engagementScore: candidate.suggestedEngagementScore,
      status: candidate.suggestedStatus,
    };
    if (candidate.ownerId) payload.ownerId = candidate.ownerId;

    setAddingAccount(true);
    try {
      await addAccount(payload);
      setSelectedAccountId("");
      toast.success("Account added to ABM list");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setAddingAccount(false);
    }
  }

  const accountsByList = (listId: Id<"abmLists">) =>
    accounts?.filter((a) => a.listId === listId) ?? [];

  const isLoading = lists === undefined || stats === undefined;

  return (
    <ViewFrame
      title="ABM / Target Accounts"
      actions={[
        { id: "abm-new-list", label: showForm ? "Hide form" : "New list", onClick: () => setShowForm(!showForm), icon: <Plus className="size-3.5" /> },
        { id: "abm-generate", label: generating ? "Generating..." : "Generate from CRM", onClick: handleGenerateAbm, disabled: generating, primary: true,
          icon: <RefreshCw className={cn("size-3.5", generating && "animate-spin")} /> },
      ]}
    >
      {/* New List Form */}
      {showForm && (
        <form
          onSubmit={handleCreateList}
          className="mb-8 rounded-xl border border-border bg-card p-6"
        >
          <h3 className="mb-4 text-lg font-semibold">Create ABM List</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium">Name *</label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Enterprise Target Accounts Q2"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                required
              />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium">Description</label>
              <input
                type="text"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Top enterprise accounts for ABM outreach"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Tier *</label>
              <SelectField
                size="default"
                value={formTier}
                onValueChange={(v) => setFormTier(v as typeof formTier)}
                className="w-full"
                options={[
                  { value: "tier_1", label: "Tier 1 (High Priority)" },
                  { value: "tier_2", label: "Tier 2 (Medium Priority)" },
                  { value: "tier_3", label: "Tier 3 (Low Priority)" },
                ]}
              />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={submitting || !formName.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {submitting ? "Creating..." : "Create List"}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Loading Skeleton */}
      {isLoading ? (
        <div className="space-y-6">
          <LoadingCards count={5} />
          <LoadingCards count={3} />
        </div>
      ) : lists && lists.length === 0 ? (
        /* Empty State */
        <EmptyState
          icon={Building2}
          title="No ABM lists yet"
          description="Generate a target account list from CRM pipeline, account ownership, contact coverage, and bookings."
          details={[
            {
              label: "Account signals",
              value: "CRM accounts, open pipeline, closed bookings, contact count, owner, industry, and employee or revenue fit.",
            },
            {
              label: "Shared primitives",
              value: "Selected target accounts flow into ICP, territories, lead routing, playbooks, and executive account coverage.",
            },
          ]}
          suggestions={[
            "Start with accounts that already show pipeline, contact coverage, or closed-won similarity.",
            "Default tiers from fit and engagement, then let teams refine status as campaigns and sales motions progress.",
            "Add synced CRM accounts from the expanded list view instead of maintaining a separate ABM spreadsheet.",
          ]}
          action={{
            label: generating ? "Generating..." : "Generate From CRM",
            onClick: handleGenerateAbm,
          }}
        />
      ) : (
        <div className="space-y-6">
          {/* Summary Cards */}
          {stats && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <SummaryCard label="Total Lists" value={stats.totalLists} icon={Building2} />
              <SummaryCard label="Target Accounts" value={stats.totalAccounts} icon={Target} />
              <SummaryCard label="Tier 1" value={stats.byTier?.tier_1 ?? 0} />
              <SummaryCard label="Tier 2" value={stats.byTier?.tier_2 ?? 0} />
              <SummaryCard label="Engaged" value={stats.byStatus?.engaged ?? 0} icon={BarChart3} />
            </div>
          )}

          {/* List Cards Grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {lists!.map((list) => {
              const listAccounts = accountsByList(list._id);
              const isExpanded = expandedListId === list._id;
              const accountCount = isExpanded
                ? listAccounts.length
                : list.accountCount;
              const selectedCandidate =
                candidateAccounts?.find(
                  (account) => account.accountId === selectedAccountId,
                ) ?? candidateAccounts?.[0];

              return (
                <div
                  key={list._id}
                  className={cn(
                    "rounded-xl border border-border bg-card transition-colors",
                    isExpanded && "sm:col-span-2 lg:col-span-3"
                  )}
                >
                  {/* Card Header */}
                  <button
                    onClick={() =>
                      setExpandedListId(isExpanded ? null : list._id)
                    }
                    className="flex w-full items-start gap-3 p-5 text-left hover:bg-muted/30 transition-colors"
                  >
                    <div className="mt-0.5">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold truncate">{list.name}</h3>
                        <StatusBadge status={list.tier} label={tierConfig[list.tier].label} />
                        <StatusBadge status={list.status} />
                      </div>
                      {list.description && (
                        <p className="mt-1 text-sm text-muted-foreground truncate">
                          {list.description}
                        </p>
                      )}
                      <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {accountCount} accounts
                        </span>
                        <span>
                          Created{" "}
                          {new Date(list.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </button>

                  {/* Expanded Accounts Table */}
                  {isExpanded && (
                    <div className="border-t border-border">
                      <div className="border-b border-border bg-muted/20 p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                          <div className="min-w-0 flex-1">
                            <label className="mb-1 block text-xs font-medium text-muted-foreground">
                              Add CRM account
                            </label>
                            <SelectField
                              size="default"
                              value={selectedCandidate?.accountId ?? ""}
                              onValueChange={(v) => setSelectedAccountId(v as typeof selectedAccountId)}
                              disabled={
                                candidateAccounts === undefined ||
                                candidateAccounts.length === 0 ||
                                addingAccount
                              }
                              className="w-full"
                              placeholder={
                                candidateAccounts === undefined
                                  ? "Loading synced accounts..."
                                  : "All synced accounts are already listed"
                              }
                              options={(candidateAccounts ?? []).map((account) => ({
                                value: account.accountId,
                                label: `${account.name}${account.ownerName ? ` · ${account.ownerName}` : ""}`,
                              }))}
                            />
                          </div>

                          <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground lg:w-[360px]">
                            <div className="rounded-lg border border-border bg-background p-2">
                              <div>Open pipe</div>
                              <div className="font-semibold text-foreground">
                                {selectedCandidate
                                  ? formatCompactCurrency(
                                      selectedCandidate.openPipeline,
                                    )
                                  : "---"}
                              </div>
                            </div>
                            <div className="rounded-lg border border-border bg-background p-2">
                              <div>Contacts</div>
                              <div className="font-semibold text-foreground">
                                {selectedCandidate?.contactCount ?? "---"}
                              </div>
                            </div>
                            <div className="rounded-lg border border-border bg-background p-2">
                              <div>Score</div>
                              <div className="font-semibold text-foreground">
                                {selectedCandidate?.suggestedEngagementScore ?? "---"}
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleAddAccount(list._id)}
                            disabled={!selectedCandidate || addingAccount}
                            className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                          >
                            <Plus className="h-4 w-4" />
                            {addingAccount ? "Adding..." : "Add"}
                          </button>
                        </div>
                      </div>
                      {listAccounts.length === 0 ? (
                        <div className="p-8 text-center text-sm text-muted-foreground">
                          Select synced CRM accounts above to start tracking
                          engagement and coverage for this list.
                        </div>
                      ) : (
                        <DataTable
                          className="rounded-none border-0 bg-card"
                          searchPlaceholder="Search target accounts..."
                          initialSort={{ key: "engagement", direction: "desc" }}
                          columns={[
                            {
                              key: "account",
                              header: "Account",
                              sortValue: (account) =>
                                account.account?.name ?? "Unknown Account",
                              searchValue: (account) =>
                                [
                                  account.account?.name,
                                  account.account?.domain,
                                  account.account?.industry,
                                  account.ownerName,
                                  account.status,
                                ].join(" "),
                              render: (account) => (
                                <div>
                                  <div className="font-medium">
                                    {account.account?.name ?? "Unknown Account"}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {[account.account?.domain, account.account?.industry]
                                      .filter(Boolean)
                                      .join(" / ") || "---"}
                                  </div>
                                </div>
                              ),
                            },
                            {
                              key: "engagement",
                              header: "Engagement",
                              sortValue: (account) =>
                                account.engagementScore ?? 0,
                              render: (account) => {
                                const score = account.engagementScore ?? 0;
                                return (
                                  <div className="flex items-center gap-2">
                                    <div className="h-2 w-20 overflow-hidden rounded-full bg-muted">
                                      <div
                                        className={cn(
                                          "h-full rounded-full",
                                          score >= 70
                                            ? "bg-primary"
                                            : score >= 40
                                              ? "bg-warning"
                                              : "bg-destructive",
                                        )}
                                        style={{ width: `${score}%` }}
                                      />
                                    </div>
                                    <span className="w-7 text-right text-xs text-muted-foreground">
                                      {score}
                                    </span>
                                  </div>
                                );
                              },
                            },
                            {
                              key: "owner",
                              header: "Owner",
                              sortValue: (account) =>
                                account.ownerName ?? "Unassigned",
                              searchValue: (account) =>
                                account.ownerName ?? "Unassigned",
                              render: (account) => (
                                <span className="text-muted-foreground">
                                  {account.ownerName ??
                                    (account.ownerId ? "Assigned" : "Unassigned")}
                                </span>
                              ),
                            },
                            {
                              key: "status",
                              header: "Status",
                              sortValue: (account) => account.status,
                              searchValue: (account) => account.status,
                              render: (account) => (
                                <StatusBadge
                                  status={account.status}
                                  label={accountStatusConfig[account.status].label}
                                />
                              ),
                            },
                            {
                              key: "notes",
                              header: "Notes",
                              searchValue: (account) => account.notes ?? "",
                              render: (account) => (
                                <span className="line-clamp-2 max-w-[260px] text-muted-foreground">
                                  {account.notes || "---"}
                                </span>
                              ),
                              sortable: false,
                            },
                          ]}
                          data={listAccounts}
                          rowKey={(account) => account._id}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </ViewFrame>
  );
}
