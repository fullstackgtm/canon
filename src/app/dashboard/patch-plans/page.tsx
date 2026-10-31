"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  CheckCircle2,
  Clock,
  FileCheck2,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import {
  EmptyState,
  LoadingCards,
  LoadingRows,
  ViewFrame,
  StatusBadge,
  SummaryCard,
} from "@/components/dashboard";
import { getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";

type PlanStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "applied"
  | "rejected"
  | "cancelled"
  | "failed";

const SELECTED_PLAN_STORAGE_KEY = "fullstackgtm:selected-patch-plan";

function formatDate(timestamp?: number) {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function label(value: string) {
  return value.replace(/_/g, " ");
}

type CreatePayload = {
  properties?: Record<string, string>;
  matchKey?: string;
  matchValue?: string;
  associateCompanyName?: string;
  associateCompanyDomain?: string;
  dealStage?: string;
  dealPipeline?: string;
  assignedBy?: string;
  estCostUsd?: number;
  ownerId?: string;
  source?: string;
};

type HostedExecutionReadiness = {
  canApply: boolean;
  known: boolean;
  blockers: string[];
  provider?: string;
  syncState?: string;
};

/**
 * The execution contract is intentionally read defensively while older CLI
 * replicas and newer hosted deployments overlap. Once a replica publishes
 * capabilities, capability state wins over the legacy origin/authority flag.
 */
function hostedExecutionReadiness(selected: unknown): HostedExecutionReadiness {
  if (!selected || typeof selected !== "object") return { canApply: false, known: false, blockers: [] };
  const root = selected as Record<string, unknown>;
  const plan = root.plan && typeof root.plan === "object" ? root.plan as Record<string, unknown> : {};
  const candidate = root.execution ?? root.executionCapability ?? plan.execution ?? plan.executionCapability;
  const execution = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  const hostedCandidate = execution.hosted;
  const hosted = hostedCandidate && typeof hostedCandidate === "object"
    ? hostedCandidate as Record<string, unknown>
    : execution;
  const eligibility = hosted.canApplyHosted ?? hosted.canApply ?? hosted.canExecute ?? hosted.eligible ?? hosted.available;
  const blockerCandidate = hosted.blockers ?? hosted.blockReasons ?? hosted.reasons;
  const blockers = Array.isArray(blockerCandidate)
    ? blockerCandidate.filter((value): value is string => typeof value === "string" && value.length > 0)
    : typeof blockerCandidate === "string" && blockerCandidate.length > 0 ? [blockerCandidate] : [];
  const provider = typeof hosted.provider === "string"
    ? hosted.provider
    : typeof execution.provider === "string" ? execution.provider : undefined;
  const syncState = typeof hosted.syncState === "string"
    ? hosted.syncState
    : typeof execution.syncState === "string" ? execution.syncState : undefined;

  if (typeof eligibility === "boolean") {
    return { canApply: eligibility && blockers.length === 0, known: true, blockers, provider, syncState };
  }

  // Plans created by hosted predate the capability contract but are already
  // known to use the hosted connector. CLI-origin plans wait for a capability
  // check rather than being permanently assigned to their origin replica.
  if (plan.executionAuthority !== "cli") return { canApply: true, known: true, blockers, provider, syncState };
  return { canApply: false, known: false, blockers, provider, syncState };
}

/** Created CRM record id from a per-op connector result, when present. */
function createdRecordId(providerData: unknown): string | null {
  if (!providerData || typeof providerData !== "object" || Array.isArray(providerData)) return null;
  const id = (providerData as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

// create_record payload amounts are CRM property values — major units.
function formatAmount(value: string | undefined) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value ?? "—";
  return `$${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function operationHeadline(objectType: string, fieldOrAction: string, afterValue: unknown): string {
  if (fieldOrAction !== "create_record" || !afterValue || typeof afterValue !== "object") {
    return `${label(objectType)} · ${label(fieldOrAction)}`;
  }
  const payload = afterValue as CreatePayload;
  const properties = payload.properties ?? {};
  if (objectType === "contact") {
    const name = [properties.firstname, properties.lastname].filter(Boolean).join(" ");
    return name || properties.email || payload.matchValue || "New contact";
  }
  if (objectType === "account") return properties.name || properties.domain || payload.matchValue || "New account";
  if (objectType === "deal") return properties.dealname || "New deal";
  return `New ${objectType}`;
}

function operationContext(objectType: string, fieldOrAction: string, afterValue: unknown): string | null {
  if (fieldOrAction !== "create_record" || !afterValue || typeof afterValue !== "object") return null;
  const payload = afterValue as CreatePayload;
  const properties = payload.properties ?? {};
  if (objectType === "contact") {
    return [properties.jobtitle, payload.associateCompanyName ?? properties.company].filter(Boolean).join(" · ") || null;
  }
  if (objectType === "account") return properties.domain ?? null;
  if (objectType === "deal") {
    return [payload.associateCompanyName, formatAmount(properties.amount)].filter((value) => value && value !== "—").join(" · ") || null;
  }
  return null;
}

function PayloadValue({ value }: { value: string }) {
  if (/^https?:\/\//.test(value)) {
    return <a href={value} target="_blank" rel="noreferrer" className="break-all text-primary hover:underline">{value}</a>;
  }
  return <span className="break-words">{value}</span>;
}

/** Scan-friendly view of every create payload field; the operation row is already the disclosure. */
function CreateRecordDetails({
  payload,
  reason,
  rollback,
  createdId,
}: {
  payload: CreatePayload;
  reason?: string;
  rollback?: string;
  createdId?: string | null;
}) {
  const fields: Array<[string, string]> = Object.entries(payload.properties ?? {}).map(([key, value]) => [label(key), value]);
  if (payload.matchKey && payload.matchValue) fields.push([`Match · ${label(payload.matchKey)}`, payload.matchValue]);
  if (payload.associateCompanyName) {
    fields.push(["Account", `${payload.associateCompanyName}${payload.associateCompanyDomain ? ` · ${payload.associateCompanyDomain}` : ""}`]);
  }
  if (payload.ownerId) fields.push(["Owner ID", payload.ownerId]);
  if (payload.assignedBy) fields.push(["Assigned by", label(payload.assignedBy)]);
  if (payload.source) fields.push(["Source", label(payload.source)]);
  if (payload.dealPipeline) fields.push(["Deal pipeline", label(payload.dealPipeline)]);
  if (payload.dealStage) fields.push(["Deal stage", label(payload.dealStage)]);
  if (payload.estCostUsd !== undefined) fields.push(["Estimated cost", `$${payload.estCostUsd.toFixed(2)}`]);
  if (createdId) fields.push(["Created record", createdId]);
  if (reason) fields.push(["Why", reason]);
  if (rollback) fields.push(["Rollback", rollback]);

  return (
    <ul className="divide-y divide-border/60 text-sm">
      {fields.map(([fieldLabel, value], index) => (
        <li key={`${fieldLabel}-${index}`} className="grid grid-cols-1 gap-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <span className="text-xs font-medium text-muted-foreground">{fieldLabel}</span>
          <span className="min-w-0 text-xs leading-5 text-foreground"><PayloadValue value={value} /></span>
        </li>
      ))}
    </ul>
  );
}

export default function PatchPlansPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusedPlanId = searchParams.get("plan") as Id<"patchPlans"> | null;
  const detailRef = useRef<HTMLElement | null>(null);
  const handledFocusedPlanRef = useRef<string | null>(null);
  const [status, setStatus] = useState<PlanStatus | "all">("all");
  const [selectedPlanId, setSelectedPlanId] = useState<Id<"patchPlans"> | null>(null);
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [valueOverrides, setValueOverrides] = useState<Record<string, string>>({});
  const [selectedOperationIds, setSelectedOperationIds] = useState<Set<string>>(new Set());
  const selectionPlanRef = useRef<string | null>(null);
  const [selectionReadyPlanId, setSelectionReadyPlanId] = useState<string | null>(null);

  const plans = useQuery(
    api.patchPlans.list,
    status === "all" ? { limit: 100 } : { limit: 100, status },
  );
  const selected = useQuery(
    api.patchPlans.get,
    selectedPlanId ? { patchPlanId: selectedPlanId } : "skip",
  );
  const approve = useMutation(api.patchPlans.approve);
  const revoke = useMutation(api.patchPlans.revokeApproval);
  const apply = useAction(api.patchPlanActions.apply);

  useEffect(() => {
    setValueOverrides({});
    setSelectionReadyPlanId(null);
  }, [selectedPlanId]);

  useEffect(() => {
    if (!selected || selectionPlanRef.current === selected.plan._id) return;
    const available = selected.operations
      .map((operation) => operation.packageOpId)
      .filter((id): id is string => typeof id === "string");
    const approved = selected.plan.status === "approved" ? selected.plan.approvedOperationIds ?? [] : available;
    setSelectedOperationIds(new Set(approved));
    selectionPlanRef.current = selected.plan._id;
    setSelectionReadyPlanId(selected.plan._id);
  }, [selected]);

  useEffect(() => {
    if (plans === undefined) return;
    const storedPlanId = window.localStorage.getItem(SELECTED_PLAN_STORAGE_KEY);
    const candidate = focusedPlanId ?? storedPlanId;
    if (!candidate) return;
    const matchingPlan = plans.find((plan) => plan._id === candidate);
    if (!matchingPlan) {
      if (focusedPlanId) setStatus("all");
      else window.localStorage.removeItem(SELECTED_PLAN_STORAGE_KEY);
      return;
    }
    setSelectedPlanId(matchingPlan._id);
    window.localStorage.setItem(SELECTED_PLAN_STORAGE_KEY, matchingPlan._id);
    if (focusedPlanId && handledFocusedPlanRef.current !== focusedPlanId) {
      handledFocusedPlanRef.current = focusedPlanId;
      window.requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }, [focusedPlanId, plans]);

  function selectPlan(planId: Id<"patchPlans">) {
    setSelectedPlanId(planId);
    window.localStorage.setItem(SELECTED_PLAN_STORAGE_KEY, planId);
    handledFocusedPlanRef.current = planId;
    const params = new URLSearchParams(searchParams.toString());
    params.set("plan", planId);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  const counts = useMemo(() => {
    const rows = plans ?? [];
    return {
      total: rows.length,
      pending: rows.filter((plan) => plan.status === "pending_approval").length,
      approved: rows.filter((plan) => plan.status === "approved").length,
      applied: rows.filter((plan) => plan.status === "applied").length,
    };
  }, [plans]);

  // Live apply ticker, pure client compute over the selected plan's op rows:
  // the apply action writes per-op results back every ~10 ops, so during an
  // apply the rows flip pending → applied/skipped/failed reactively and this
  // counter reads "Applying · 14/33". Shown while ops are mid-flight (mixed
  // settled/pending) and the plan hasn't reached a terminal state.
  const applying = useMemo(() => {
    if (!selected) return null;
    const total = selected.operations.length;
    const done = selected.operations.filter((op) => op.status !== "pending").length;
    const midFlight = done > 0 && done < total;
    const planBusy = busyPlanId === selected.plan._id;
    const planLive =
      selected.plan.status === "approved" || selected.plan.status === "draft";
    if (total > 0 && ((midFlight && planLive) || (planBusy && done < total))) {
      return { done, total };
    }
    return null;
  }, [selected, busyPlanId]);

  const selectionDirty = useMemo(() => {
    if (!selected || selected.plan.status !== "approved" || selectionReadyPlanId !== selected.plan._id) return false;
    const persisted = new Set(selected.plan.approvedOperationIds ?? []);
    return persisted.size !== selectedOperationIds.size || Array.from(selectedOperationIds).some((id) => !persisted.has(id));
  }, [selected, selectedOperationIds, selectionReadyPlanId]);

  const hostedExecution = useMemo(() => hostedExecutionReadiness(selected), [selected]);

  async function decide(patchPlanId: Id<"patchPlans">, decision: "approved" | "rejected") {
    setBusyPlanId(patchPlanId);
    try {
      await approve({
        patchPlanId,
        decision,
        approvedOperationIds: decision === "approved" ? Array.from(selectedOperationIds) : undefined,
        valueOverrides: decision === "approved" ? valueOverrides : undefined,
      });
      const { toast } = await import("sonner");
      toast.success(decision === "approved" ? "Patch plan approved." : "Patch plan rejected.");
    } catch (error) {
      const { toast } = await import("sonner");
      toast.error(getErrorMessage(error));
    } finally {
      setBusyPlanId(null);
    }
  }

  async function revokePlan(patchPlanId: Id<"patchPlans">) {
    setBusyPlanId(patchPlanId);
    try {
      await revoke({ patchPlanId });
      const { toast } = await import("sonner");
      toast.success("Approval revoked — the plan is back in the review queue.");
    } catch (error) {
      const { toast } = await import("sonner");
      toast.error(getErrorMessage(error));
    } finally {
      setBusyPlanId(null);
    }
  }

  async function applyPlan(patchPlanId: Id<"patchPlans">) {
    setBusyPlanId(patchPlanId);
    try {
      const result = await apply({ patchPlanId });
      const { toast } = await import("sonner");
      // A do-plan apply can resolve with per-operation failures — the plan is
      // then marked failed with the detail on its operation rows.
      const outcome =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as { status?: string; error?: string })
          : null;
      if (outcome?.status === "failed") {
        toast.error(outcome.error ?? "Patch plan failed — see operation rows.");
      } else {
        toast.success("Patch plan applied.");
      }
    } catch (error) {
      const { toast } = await import("sonner");
      toast.error(getErrorMessage(error));
    } finally {
      setBusyPlanId(null);
    }
  }

  return (
    <ViewFrame title="Patch Plans">
      {plans === undefined ? (
        <LoadingCards count={4} />
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label="Plans" value={counts.total} icon={FileCheck2} />
          <SummaryCard label="Pending Approval" value={counts.pending} icon={Clock} />
          <SummaryCard label="Approved" value={counts.approved} icon={ShieldCheck} />
          <SummaryCard label="Applied" value={counts.applied} icon={CheckCircle2} />
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <section className="rounded-xl border border-border bg-card p-4 xl:sticky xl:top-28">
          <div className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">Change Queue</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Select a plan to review its proposed changes.
              </p>
            </div>
            <SelectField
              size="default"
              aria-label="Filter by status"
              value={status}
              onValueChange={(v) => setStatus(v as PlanStatus | "all")}
              className="w-full"
              options={[
                { value: "all", label: "All statuses" },
                { value: "pending_approval", label: "Pending approval" },
                { value: "approved", label: "Approved" },
                { value: "draft", label: "Draft" },
                { value: "applied", label: "Applied" },
                { value: "rejected", label: "Rejected" },
                { value: "failed", label: "Failed" },
              ]}
            />
          </div>

          <div className="mt-4">
            {plans === undefined ? (
              <LoadingRows count={6} />
            ) : plans.length > 0 ? (
              <div className={`${selectedPlanId ? "max-h-72 xl:max-h-[calc(100vh-18rem)]" : "max-h-[calc(100vh-18rem)]"} space-y-1 overflow-y-auto pr-1`}>
                {plans.map((plan) => (
                  <button
                    key={plan._id}
                    type="button"
                    onClick={() => selectPlan(plan._id)}
                    aria-current={selectedPlanId === plan._id ? "true" : undefined}
                    className={`relative w-full overflow-hidden rounded-lg border px-3 py-3 text-left transition-all duration-150 ${
                      selectedPlanId === plan._id
                        ? "border-primary/50 bg-primary/10 shadow-sm ring-1 ring-inset ring-primary/25 before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-r before:bg-primary"
                        : "border-transparent hover:-translate-y-px hover:border-border hover:bg-muted/60 hover:shadow-sm"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {plan.source === "cli" ? String(plan.args?.title ?? plan.externalPlanId) : `${plan.verb}.${plan.operation}`}
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">
                          {plan.reason ?? "No reason provided"}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <StatusBadge status={plan.status} label={label(plan.status)} />
                      <span className="text-[11px] text-muted-foreground">{formatDate(plan.createdAt)}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={ShieldCheck}
                title="No patch plans yet"
                description="Run a dry-run GTM set operation to create a durable patch plan for review."
              />
            )}
          </div>
        </section>

        <section ref={detailRef} className={`min-w-0 rounded-xl border bg-card p-6 transition ${focusedPlanId && selectedPlanId === focusedPlanId ? "border-primary shadow-sm shadow-primary/20" : "border-border"}`}>
          <h2 className="text-lg font-semibold">Selected Plan</h2>
          <div className="mt-5">
            {!selectedPlanId ? (
              <EmptyState
                icon={ShieldAlert}
                title="Select a plan"
                description="Choose a patch plan to inspect operations, approval requests, and audit history."
              />
            ) : selected === undefined ? (
              <LoadingRows count={5} />
            ) : selected === null ? (
              <EmptyState icon={XCircle} title="Plan not found" description="This patch plan is unavailable." />
            ) : (
              <div className="space-y-5">
                <div className={selected.plan._id === focusedPlanId ? "rounded-lg border border-primary/50 bg-primary/5 p-4" : "rounded-lg bg-muted/30 p-4"}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-base font-semibold">
                        {(() => {
                          const selectedRows = selected.operations.filter((operation) => !operation.packageOpId || selectedOperationIds.has(operation.packageOpId));
                          const contacts = selectedRows.filter((operation) => operation.objectType === "contact" && operation.fieldOrAction === "create_record");
                          return contacts.length === selectedRows.length && contacts.length > 0
                            ? `Authorize ${contacts.length} new CRM contact${contacts.length === 1 ? "" : "s"}`
                            : `Authorize ${selectedRows.length} CRM change${selectedRows.length === 1 ? "" : "s"}`;
                        })()}
                      </div>
                      <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                        {(() => {
                          const selectedRows = selected.operations.filter((operation) => !operation.packageOpId || selectedOperationIds.has(operation.packageOpId));
                          const sources = Array.from(new Set(selectedRows.map((operation) => operationContext(operation.objectType, operation.fieldOrAction, operation.afterValue) && (operation.afterValue as CreatePayload)?.source).filter(Boolean)));
                          const source = sources.length === 1 ? ` sourced from ${label(String(sources[0]))}` : "";
                          return `Approval authorizes any synced executor with the required CRM connection to process ${selectedRows.length} selected operation${selectedRows.length === 1 ? "" : "s"}${source}, resolve existing CRM records first, and create or link only the unmatched records. Nothing is written to the CRM until apply runs.`;
                        })()}
                      </p>
                      {selected.plan.source === "cli" && (
                        <p className="mt-2 font-mono text-xs text-primary">
                          Created from CLI · {selected.plan.externalPlanId}
                        </p>
                      )}
                    </div>
                    <StatusBadge status={selected.plan.status} label={label(selected.plan.status)} />
                  </div>
                  {selected.plan.error && (
                    <p className="mt-3 rounded-md bg-destructive/15 p-2 text-xs text-destructive">{selected.plan.error}</p>
                  )}
                  <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border/70 pt-4 sm:grid-cols-3">
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">Operations</div>
                      <div className="mt-1 text-sm font-semibold">{selected.operations.length}</div>
                    </div>
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">Created</div>
                      <div className="mt-1 text-sm font-medium">{formatDate(selected.plan.createdAt)}</div>
                    </div>
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">Execution</div>
                      <div className="mt-1 text-sm font-medium">
                        {hostedExecution.canApply
                          ? `Hosted${hostedExecution.provider ? ` · ${label(hostedExecution.provider)}` : ""}`
                          : hostedExecution.known ? "Waiting on requirements" : "Checking capabilities"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="min-h-16 rounded-lg border border-border/70 bg-muted/20 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                  {selected.plan.status === "pending_approval" && (
                    <>
                      <button
                        type="button"
                        onClick={() => decide(selected.plan._id, "approved")}
                        disabled={busyPlanId === selected.plan._id || selectedOperationIds.size === 0}
                        className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {busyPlanId === selected.plan._id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                        Approve selected ({selectedOperationIds.size})
                      </button>
                      <button
                        type="button"
                        onClick={() => decide(selected.plan._id, "rejected")}
                        disabled={busyPlanId === selected.plan._id}
                        className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {(selected.plan.status === "approved" || (selected.plan.status === "draft" && selected.plan.approvalRequirement === "not_required")) && hostedExecution.canApply && (
                    <button
                      type="button"
                      onClick={() => applyPlan(selected.plan._id)}
                      disabled={busyPlanId === selected.plan._id || selectionDirty}
                      className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    >
                      {busyPlanId === selected.plan._id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                      Apply from hosted
                    </button>
                  )}
                  {selected.plan.status === "approved" && (
                    <button
                      type="button"
                      onClick={() => decide(selected.plan._id, "approved")}
                      disabled={!selectionDirty || busyPlanId === selected.plan._id || selectedOperationIds.size === 0}
                      className="inline-flex min-w-48 items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                    >
                      {busyPlanId === selected.plan._id ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                      Update approval ({selectedOperationIds.size})
                    </button>
                  )}
                  {selected.plan.status === "approved" && (
                    <button
                      type="button"
                      onClick={() => revokePlan(selected.plan._id)}
                      disabled={busyPlanId === selected.plan._id}
                      className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                    >
                      Revoke approval
                    </button>
                  )}
                  </div>
                  {selected.plan.status === "approved" && !hostedExecution.canApply && (
                    <div className="mt-2 text-xs leading-5 text-muted-foreground" role="status">
                      {!hostedExecution.known ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Checking the shared plan, CRM connection, and hosted connector capabilities…
                        </span>
                      ) : hostedExecution.blockers.length > 0 ? (
                        <div>
                          <span className="font-medium text-foreground">Hosted apply is not ready:</span>
                          <div className="mt-1 space-y-0.5">
                            {hostedExecution.blockers.map((blocker) => <div key={blocker}>{blocker}</div>)}
                          </div>
                        </div>
                      ) : (
                        <span>Hosted apply is waiting for the latest shared plan state.</span>
                      )}
                    </div>
                  )}
                  {selected.plan.status === "approved" && hostedExecution.canApply && hostedExecution.syncState && hostedExecution.syncState !== "current" && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Sync state: {label(hostedExecution.syncState)}. Apply will revalidate the approval and provider state before writing.
                    </p>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">Operations ({selected.operations.length})</h3>
                      {(selected.plan.status === "pending_approval" || selected.plan.status === "approved") && (
                        <p className="mt-0.5 text-xs text-muted-foreground">Checked rows are approved; unchecked rows are excluded.</p>
                      )}
                    </div>
                    {selected.plan.status === "pending_approval" || selected.plan.status === "approved" ? (
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={selected.operations.every((operation) => !operation.packageOpId || selectedOperationIds.has(operation.packageOpId))}
                          onChange={(event) => {
                            const ids = selected.operations
                              .map((operation) => operation.packageOpId)
                              .filter((id): id is string => typeof id === "string");
                            setSelectedOperationIds(event.target.checked ? new Set(ids) : new Set());
                          }}
                          className="h-4 w-4 rounded border-input accent-primary"
                        />
                        Select all
                      </label>
                    ) : applying && (
                      <span className="inline-flex items-center gap-1.5 rounded-sm bg-primary/15 px-2 py-0.5 font-mono text-[11px] tracking-wide text-primary">
                        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
                        Applying · {applying.done}/{applying.total}
                      </span>
                    )}
                  </div>
                  {selectionReadyPlanId !== selected.plan._id ? (
                    <div className="mt-3"><LoadingRows count={Math.min(selected.operations.length, 5)} /></div>
                  ) : (
                  <div className="mt-3 space-y-2">
                    {selected.operations.map((operation) => {
                      const isCreate = operation.fieldOrAction === "create_record";
                      const createdId =
                        operation.status === "applied" ? createdRecordId(operation.providerData) : null;
                      const packageOperationId = typeof operation.packageOpId === "string" ? operation.packageOpId : undefined;
                      const requiresHuman = typeof operation.afterValue === "string" && operation.afterValue.startsWith("requires_human_");
                      const suggestion = operation.suggestion as { suggestedValue?: string | null; confidence?: string; reason?: string } | undefined;
                      const headline = operationHeadline(operation.objectType, operation.fieldOrAction, operation.afterValue);
                      const context = operationContext(operation.objectType, operation.fieldOrAction, operation.afterValue);
                      return (
                        <details key={operation._id} className={`group rounded-lg border border-border bg-background transition-all duration-150 hover:-translate-y-px hover:border-primary/25 hover:bg-muted/20 hover:shadow-sm open:translate-y-0 open:border-primary/30 open:bg-background open:shadow-sm ${(selected.plan.status === "pending_approval" || selected.plan.status === "approved") && packageOperationId && !selectedOperationIds.has(packageOperationId) ? "opacity-55" : ""}`}>
                          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 marker:hidden">
                            {packageOperationId && (
                              <input
                                type="checkbox"
                                checked={selectedOperationIds.has(packageOperationId)}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => {
                                  if (selected.plan.status !== "pending_approval" && selected.plan.status !== "approved") return;
                                  setSelectedOperationIds((current) => {
                                    const next = new Set(current);
                                    if (event.target.checked) next.add(packageOperationId);
                                    else next.delete(packageOperationId);
                                    return next;
                                  });
                                }}
                                aria-readonly={selected.plan.status !== "pending_approval" && selected.plan.status !== "approved"}
                                aria-label={`${selectedOperationIds.has(packageOperationId) ? "Exclude" : "Include"} ${headline}`}
                                className={`h-4 w-4 shrink-0 rounded border-input accent-primary ${selected.plan.status === "pending_approval" || selected.plan.status === "approved" ? "cursor-pointer" : "cursor-default"}`}
                              />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-semibold">{headline}</span>
                                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                                  {label(operation.objectType)}
                                </span>
                              </div>
                              {context && <p className="mt-0.5 truncate text-xs text-muted-foreground">{context}</p>}
                            </div>
                            <div className="flex shrink-0 items-center gap-3">
                              <StatusBadge status={operation.status} label={label(operation.status)} />
                              <span className="text-lg leading-none text-muted-foreground transition-transform group-open:rotate-90" aria-hidden>›</span>
                            </div>
                          </summary>
                          <div className="border-t border-border/70 px-4 pb-4 pt-3">
                            {(operation.status === "failed" || operation.status === "conflict") && operation.error && (
                            <p className="mt-2 rounded-md bg-destructive/15 p-2 text-xs text-destructive">
                              {operation.error}
                            </p>
                          )}
                          {createdId && !isCreate && (
                            <p className="mt-2 text-xs text-muted-foreground">
                              Created: <span className="font-medium text-foreground">{createdId}</span>
                            </p>
                          )}
                          {isCreate ? (
                            <CreateRecordDetails
                              payload={(operation.afterValue ?? {}) as CreatePayload}
                              reason={operation.reason}
                              rollback={operation.rollback}
                              createdId={createdId}
                            />
                          ) : (
                            <>
                              {operation.sourceRuleOrPolicy && (
                                <div className="mt-2 text-xs text-muted-foreground">
                                  Source rule:{" "}
                                  <span className="font-medium text-foreground">
                                    {operation.sourceRuleOrPolicy}
                                  </span>
                                </div>
                              )}
                              <p className="mt-2 text-xs text-muted-foreground">
                                {operation.reason ?? "No operation reason"}
                              </p>
                              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div className="rounded-md bg-muted/50 p-2">
                                  <div className="text-xs font-medium text-muted-foreground">Before</div>
                                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-xs">
                                    {JSON.stringify(operation.beforeValue ?? null, null, 2)}
                                  </pre>
                                </div>
                                <div className="rounded-md bg-muted/50 p-2">
                                  <div className="text-xs font-medium text-muted-foreground">After</div>
                                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-xs">
                                    {JSON.stringify(operation.afterValue ?? null, null, 2)}
                                  </pre>
                                </div>
                              </div>
                            </>
                          )}
                          {requiresHuman && packageOperationId && (
                            <div className="mt-3 rounded-md border border-warning/30 bg-warning/5 p-2 text-xs">
                              <div className="font-medium text-foreground">Human-approved value required</div>
                              {suggestion && (
                                <p className="mt-1 text-muted-foreground">
                                  Suggestion: <span className="font-medium text-foreground">{suggestion.suggestedValue ?? "none"}</span>
                                  {suggestion.confidence ? ` (${suggestion.confidence})` : ""} — {suggestion.reason}
                                </p>
                              )}
                              <input
                                value={valueOverrides[packageOperationId] ?? ""}
                                onChange={(event) => setValueOverrides((current) => {
                                  const next = { ...current };
                                  const value = event.target.value;
                                  if (value.trim().length === 0) delete next[packageOperationId];
                                  else next[packageOperationId] = value;
                                  return next;
                                })}
                                placeholder="Enter approved value"
                                className="mt-2 w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none focus:border-primary"
                              />
                              {suggestion?.suggestedValue && suggestion.confidence === "high" && (
                                <button
                                  type="button"
                                  onClick={() => setValueOverrides((current) => ({ ...current, [packageOperationId]: suggestion.suggestedValue! }))}
                                  className="mt-2 rounded-md border border-border px-2 py-1 font-medium hover:bg-muted"
                                >
                                  Use high-confidence suggestion
                                </button>
                              )}
                            </div>
                          )}
                            {!isCreate && operation.rollback && (
                              <p className="mt-2 text-xs text-muted-foreground">Rollback: {operation.rollback}</p>
                            )}
                          </div>
                        </details>
                      );
                    })}
                  </div>
                  )}
                </div>

                {selected.audit.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold">Audit</h3>
                    <div className="mt-3 space-y-2">
                      {selected.audit.map((entry) => (
                        <div key={entry._id} className="flex items-center justify-between gap-3 text-sm">
                          <span>{label(entry.status)}</span>
                          <span className="text-xs text-muted-foreground">{formatDate(entry.createdAt)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </ViewFrame>
  );
}
