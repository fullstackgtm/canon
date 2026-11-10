"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { cn, formatCompactCurrency, getErrorMessage } from "@/lib/utils";
import {
  ViewFrame,
  EmptyState,
  FormulaInput,
  LoadingCards,
  LoadingRows,
  StatusBadge,
  SummaryCard,
  DataTable,
} from "@/components/dashboard";
import {
  Star,
  Plus,
  Trash2,
  Zap,
  Route,
  Users,
  Flame,
  Sun,
  Snowflake,
  RefreshCw,
  UserCheck,
} from "lucide-react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { SelectField } from "@/components/ui/select";

type Tab = "models" | "routing" | "leadboard";

const FIELD_OPTIONS = [
  { value: "industry", label: "Industry" },
  { value: "revenue", label: "Revenue" },
  { value: "employee_count", label: "Employee Count" },
  { value: "title", label: "Title" },
  { value: "engagement", label: "Engagement" },
] as const;

const OPERATOR_OPTIONS = [
  { value: "equals", label: "Equals" },
  { value: "contains", label: "Contains" },
  { value: "greater_than", label: "Greater Than" },
  { value: "less_than", label: "Less Than" },
] as const;

const METHOD_COLORS: Record<string, string> = {
  round_robin: "bg-muted text-muted-foreground",
  weighted: "bg-muted text-muted-foreground",
  territory_based: "bg-primary/15 text-primary",
  skill_based: "bg-warning/15 text-warning",
};

type LeadBreakdown = {
  matchedRules?: Array<{
    field: string;
    operator: string;
    value: unknown;
    points: number;
  }>;
  annualRevenue?: number;
  employeeCount?: number;
  buyingCommitteeContacts?: number;
  ownerMapped?: boolean;
};

interface RuleInput {
  field: string;
  operator: string;
  value: string;
  points: number;
}

interface AssigneeInput {
  userId: string;
  weight: number;
}

function emptyRule(): RuleInput {
  return { field: "industry", operator: "equals", value: "", points: 10 };
}

function emptyAssignee(): AssigneeInput {
  return { userId: "", weight: 1 };
}

function integerValue(value: string, fallback = 0) {
  const parsed = Number.parseInt(value.replace(/[%\s]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBreakdown(value: unknown): LeadBreakdown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as LeadBreakdown;
}

export default function LeadsPage() {
  const [tab, setTab] = useState<Tab>("models");

  // Workspace queries for routing/lead-scoring noun context.
  const routingWorkspace = useQuery(api.leadScoring.context);
  const userWorkspace = useQuery(api.users.context);
  const models = routingWorkspace?.models;
  const routingRules = routingWorkspace?.rules;
  const leadScores = routingWorkspace?.scores;
  const users = userWorkspace?.users;

  // Mutations
  const createModel = useMutation(api.leadScoring.createModel);
  const createRoutingRule = useMutation(
    api.leadScoring.createRoutingRule,
  );
  // generateFromCrm is a batched Convex action (it pages the whole CRM), not
  // a mutation — same call shape and result fields for the notice below.
  const generateScores = useAction(api.leadScoring.generateFromCrm);

  // Model form state
  const [showModelForm, setShowModelForm] = useState(false);
  const [modelName, setModelName] = useState("");
  const [modelDescription, setModelDescription] = useState("");
  const [rules, setRules] = useState<RuleInput[]>([emptyRule()]);
  // Seeded from the workspace's scoring.lead grades each time the form opens.
  const [hotThreshold, setHotThreshold] = useState(0);
  const [warmThreshold, setWarmThreshold] = useState(0);
  const [coldThreshold, setColdThreshold] = useState(0);
  const [modelSubmitting, setModelSubmitting] = useState(false);

  // Routing form state
  const [showRoutingForm, setShowRoutingForm] = useState(false);
  const [routingName, setRoutingName] = useState("");
  const [routingMethod, setRoutingMethod] = useState("round_robin");
  const [slaMinutes, setSlaMinutes] = useState(60);
  const [assignees, setAssignees] = useState<AssigneeInput[]>([
    emptyAssignee(),
  ]);
  const [routingSubmitting, setRoutingSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [runNotice, setRunNotice] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const scoringFormulaContext = {
    hotThreshold,
    warmThreshold,
    coldThreshold,
    slaMinutes,
    rules: rules.length,
    assignees: assignees.length,
  };

  const userById = useMemo(() => {
    return new Map((users ?? []).map((user) => [user._id, user]));
  }, [users]);

  const assignableUsers = useMemo(() => {
    return (users ?? []).filter(
      (user) => user.isActive && !user.isHidden && user.role !== "other",
    );
  }, [users]);

  const leadSummary = useMemo(() => {
    const rows = leadScores ?? [];
    return {
      total: rows.length,
      hot: rows.filter((score) => score.grade === "hot").length,
      warm: rows.filter((score) => score.grade === "warm").length,
      cold: rows.filter((score) => score.grade === "cold").length,
      avgScore:
        rows.length > 0
          ? Math.round(
              rows.reduce((sum, score) => sum + score.score, 0) / rows.length,
            )
          : 0,
    };
  }, [leadScores]);

  // Rule helpers
  function addRule() {
    setRules((prev) => [...prev, emptyRule()]);
  }
  function removeRule(index: number) {
    setRules((prev) => prev.filter((_, i) => i !== index));
  }
  function updateRule(index: number, updates: Partial<RuleInput>) {
    setRules((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...updates } : r)),
    );
  }

  // Assignee helpers
  function addAssignee() {
    setAssignees((prev) => [...prev, emptyAssignee()]);
  }
  function removeAssignee(index: number) {
    setAssignees((prev) => prev.filter((_, i) => i !== index));
  }
  function updateAssignee(
    index: number,
    updates: Partial<AssigneeInput>,
  ) {
    setAssignees((prev) =>
      prev.map((a, i) => (i === index ? { ...a, ...updates } : a)),
    );
  }

  function openModelForm() {
    const thresholds = routingWorkspace?.template?.thresholds;
    if (thresholds) {
      setHotThreshold(thresholds.hot);
      setWarmThreshold(thresholds.warm);
      setColdThreshold(thresholds.cold);
    }
    setShowModelForm(true);
  }

  function resetModelForm() {
    setModelName("");
    setModelDescription("");
    setRules([emptyRule()]);
    setShowModelForm(false);
  }

  function resetRoutingForm() {
    setRoutingName("");
    setRoutingMethod("round_robin");
    setSlaMinutes(60);
    setAssignees([emptyAssignee()]);
    setShowRoutingForm(false);
  }

  async function handleCreateModel(e: React.FormEvent) {
    e.preventDefault();
    if (!modelName.trim() || rules.length === 0) return;
    setModelSubmitting(true);
    try {
      await createModel({
        name: modelName.trim(),
        description: modelDescription.trim() || undefined,
        rules: rules.map((r) => ({
          field: r.field,
          operator: r.operator,
          value: r.value,
          points: r.points,
        })),
        thresholds: {
          hot: hotThreshold,
          warm: warmThreshold,
          cold: coldThreshold,
        },
      });
      resetModelForm();
    } catch (err) {
      console.error("Failed to create model:", err);
    } finally {
      setModelSubmitting(false);
    }
  }

  async function handleCreateRoutingRule(e: React.FormEvent) {
    e.preventDefault();
    const validAssignees = assignees.filter((assignee) =>
      assignee.userId.trim(),
    );
    if (!routingName.trim() || validAssignees.length === 0) return;
    setRoutingSubmitting(true);
    try {
      await createRoutingRule({
        name: routingName.trim(),
        method: routingMethod as
          | "round_robin"
          | "weighted"
          | "territory_based"
          | "skill_based",
        slaMinutes: slaMinutes > 0 ? slaMinutes : undefined,
        assignees: validAssignees.map((a) => ({
          userId: a.userId.trim() as Id<"users">,
          weight: routingMethod === "weighted" ? a.weight : undefined,
        })),
      });
      resetRoutingForm();
    } catch (err) {
      console.error("Failed to create routing rule:", err);
    } finally {
      setRoutingSubmitting(false);
    }
  }

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
            ? `Scored ${result.scored} CRM contact${result.scored === 1 ? "" : "s"} from title, account fit, buying committee coverage, and owner mapping.`
            : "No CRM contacts were available to score.",
      });
      setTab("leadboard");
    } catch (error) {
      setRunNotice({ kind: "error", message: getErrorMessage(error) });
    } finally {
      setGenerating(false);
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "models", label: "Scoring Models" },
    { key: "routing", label: "Routing Rules" },
    { key: "leadboard", label: "Lead Board" },
  ];

  return (
    <ViewFrame
      title="Lead Scoring & Routing"
      actions={[{ id: "leads-score", label: generating ? "Scoring..." : "Score CRM", onClick: handleGenerateScores, disabled: generating, primary: true,
        icon: <RefreshCw className={cn("size-3.5", generating && "animate-spin")} /> }]}
      controls={
        <div className="flex w-fit items-center gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-md px-4 py-2 text-sm font-medium transition-colors",
                tab === t.key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
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

      {/* ── Scoring Models Tab ──────────────────────── */}
      {tab === "models" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Scoring Models</h2>
            <button
              onClick={() => (showModelForm ? setShowModelForm(false) : openModelForm())}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Model
            </button>
          </div>

          {/* Create Model Form */}
          {showModelForm && (
            <form
              onSubmit={handleCreateModel}
              className="mb-6 rounded-xl border border-border bg-card p-6 shadow-sm"
            >
              <h3 className="text-lg font-semibold mb-4">
                Create Scoring Model
              </h3>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 mb-4">
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                    Model Name *
                  </label>
                  <input
                    type="text"
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    placeholder="e.g. Enterprise Lead Scoring"
                    required
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                    Description
                  </label>
                  <input
                    type="text"
                    value={modelDescription}
                    onChange={(e) =>
                      setModelDescription(e.target.value)
                    }
                    placeholder="What does this model score?"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>

              {/* Rules Builder */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-muted-foreground">
                    Scoring Rules
                  </h4>
                  <button
                    type="button"
                    onClick={addRule}
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Rule
                  </button>
                </div>

                <div className="space-y-3">
                  {rules.map((rule, index) => (
                    <div
                      key={index}
                      className="grid grid-cols-[1fr_1fr_1fr_80px_auto] gap-3 items-end rounded-lg border border-border bg-muted/30 p-3"
                    >
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Field
                        </label>
                        <SelectField
                          size="default"
                          value={rule.field}
                          onValueChange={(v) => updateRule(index, { field: v })}
                          className="w-full"
                          options={FIELD_OPTIONS}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Operator
                        </label>
                        <SelectField
                          size="default"
                          value={rule.operator}
                          onValueChange={(v) => updateRule(index, { operator: v })}
                          className="w-full"
                          options={OPERATOR_OPTIONS}
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Value
                        </label>
                        <input
                          type="text"
                          value={rule.value}
                          onChange={(e) =>
                            updateRule(index, {
                              value: e.target.value,
                            })
                          }
                          placeholder="e.g. SaaS, 500"
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Points
                        </label>
                        <FormulaInput
                          value={rule.points}
                          onValueChange={(value) =>
                            updateRule(index, {
                              points: integerValue(value),
                            })
                          }
                          formulaContext={scoringFormulaContext}
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                        />
                      </div>

                      <div>
                        <button
                          type="button"
                          onClick={() => removeRule(index)}
                          disabled={rules.length <= 1}
                          className="rounded-md p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/15 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Thresholds */}
              <div className="mb-4">
                <h4 className="text-sm font-semibold text-muted-foreground mb-3">
                  Grade Thresholds
                </h4>
                <div className="grid grid-cols-3 gap-4">
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-destructive mb-1">
                      <Flame className="h-3.5 w-3.5" />
                      Hot (score above)
                    </label>
                    <FormulaInput
                      value={hotThreshold}
                      onValueChange={(value) => setHotThreshold(integerValue(value))}
                      formulaContext={scoringFormulaContext}
                      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-warning mb-1">
                      <Sun className="h-3.5 w-3.5" />
                      Warm (score above)
                    </label>
                    <FormulaInput
                      value={warmThreshold}
                      onValueChange={(value) => setWarmThreshold(integerValue(value))}
                      formulaContext={scoringFormulaContext}
                      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
                      <Snowflake className="h-3.5 w-3.5" />
                      Cold (score below)
                    </label>
                    <FormulaInput
                      value={coldThreshold}
                      onValueChange={(value) => setColdThreshold(integerValue(value))}
                      formulaContext={scoringFormulaContext}
                      className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={resetModelForm}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    modelSubmitting ||
                    !modelName.trim() ||
                    rules.length === 0
                  }
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {modelSubmitting
                    ? "Creating..."
                    : "Create Model"}
                </button>
              </div>
            </form>
          )}

          {/* Model Cards */}
          {models === undefined ? (
            <LoadingCards count={3} />
          ) : models.length === 0 ? (
            <EmptyState
              icon={Zap}
              title="No scoring models yet"
              description="Create a scoring model to automatically grade incoming leads."
              details={[
                {
                  label: "Scoring inputs",
                  value: "CRM contacts, account fit, title or persona, buying committee coverage, activity, and owner context.",
                },
                {
                  label: "Shared outputs",
                  value: "Lead model thresholds feed lead boards, routing, scorecards, campaigns, and account coverage workflows.",
                },
              ]}
              suggestions={[
                "Generate or create one default scoring model before routing leads.",
                "Use account fit and buying committee coverage as stronger defaults than title alone.",
                "Tune hot, warm, and cold thresholds after scoring the first synced contact set.",
              ]}
              action={{ label: "Create your first model", onClick: openModelForm }}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {models.map((model) => (
                <div
                  key={model._id}
                  className="border-b border-border/70 py-5 shadow-sm hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-semibold text-base">
                      {model.name}
                    </h3>
                    <StatusBadge status={model.isActive ? "active" : "inactive"} />
                  </div>

                  {model.description && (
                    <p className="text-sm text-muted-foreground mb-3">
                      {model.description}
                    </p>
                  )}

                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-md">
                      {model.rules.length}{" "}
                      {model.rules.length === 1 ? "rule" : "rules"}
                    </span>
                  </div>

                  {/* Thresholds */}
                  <div className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-muted/30 p-3">
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-1 text-destructive mb-0.5">
                        <Flame className="h-3 w-3" />
                        <span className="text-xs font-medium">
                          Hot
                        </span>
                      </div>
                      <p className="text-sm font-bold tabular-nums">
                        &gt;{model.thresholds.hot}
                      </p>
                    </div>
                    <div className="text-center border-x border-border">
                      <div className="flex items-center justify-center gap-1 text-warning mb-0.5">
                        <Sun className="h-3 w-3" />
                        <span className="text-xs font-medium">
                          Warm
                        </span>
                      </div>
                      <p className="text-sm font-bold tabular-nums">
                        &gt;{model.thresholds.warm}
                      </p>
                    </div>
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-1 text-muted-foreground mb-0.5">
                        <Snowflake className="h-3 w-3" />
                        <span className="text-xs font-medium">
                          Cold
                        </span>
                      </div>
                      <p className="text-sm font-bold tabular-nums">
                        &lt;{model.thresholds.cold}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Routing Rules Tab ───────────────────────── */}
      {tab === "routing" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Routing Rules</h2>
            <button
              onClick={() => setShowRoutingForm(!showRoutingForm)}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Rule
            </button>
          </div>

          {/* Create Routing Rule Form */}
          {showRoutingForm && (
            <form
              onSubmit={handleCreateRoutingRule}
              className="mb-6 rounded-xl border border-border bg-card p-6 shadow-sm"
            >
              <h3 className="text-lg font-semibold mb-4">
                Create Routing Rule
              </h3>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-4">
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                    Rule Name *
                  </label>
                  <input
                    type="text"
                    value={routingName}
                    onChange={(e) => setRoutingName(e.target.value)}
                    placeholder="e.g. Enterprise Round Robin"
                    required
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                    Method
                  </label>
                  <SelectField
                    size="default"
                    value={routingMethod}
                    onValueChange={setRoutingMethod}
                    className="w-full"
                    options={[
                      { value: "round_robin", label: "Round Robin" },
                      { value: "weighted", label: "Weighted" },
                      { value: "territory_based", label: "Territory Based" },
                      { value: "skill_based", label: "Skill Based" },
                    ]}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-muted-foreground mb-1">
                    SLA (minutes)
                  </label>
                  <FormulaInput
                    value={slaMinutes}
                    onValueChange={(value) => setSlaMinutes(integerValue(value))}
                    formulaContext={scoringFormulaContext}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>

              {/* Assignees Builder */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-muted-foreground">
                    Assignees
                  </h4>
                  <button
                    type="button"
                    onClick={addAssignee}
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Assignee
                  </button>
                </div>

                <div className="space-y-3">
                  {assignees.map((assignee, index) => (
                    <div
                      key={index}
                      className={cn(
                        "grid gap-3 items-end rounded-lg border border-border bg-muted/30 p-3",
                        routingMethod === "weighted"
                          ? "grid-cols-[1fr_100px_auto]"
                          : "grid-cols-[1fr_auto]",
                      )}
                    >
                      <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">
                          Assignee
                        </label>
                        <SelectField
                          size="default"
                          value={assignee.userId}
                          onValueChange={(v) => updateAssignee(index, { userId: v })}
                          className="w-full"
                          options={[
                            { value: "", label: "Select team member..." },
                            ...assignableUsers.map((user) => ({
                              value: user._id,
                              label: `${user.name}${user.title ? ` - ${user.title}` : ""}`,
                            })),
                          ]}
                        />
                      </div>

                      {routingMethod === "weighted" && (
                        <div>
                          <label className="block text-xs font-medium text-muted-foreground mb-1">
                            Weight
                          </label>
                          <FormulaInput
                            value={assignee.weight}
                            onValueChange={(value) =>
                              updateAssignee(index, {
                                weight: integerValue(value, 1),
                              })
                            }
                            formulaContext={scoringFormulaContext}
                            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                          />
                        </div>
                      )}

                      <div>
                        <button
                          type="button"
                          onClick={() => removeAssignee(index)}
                          disabled={assignees.length <= 1}
                          className="rounded-md p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/15 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={resetRoutingForm}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    routingSubmitting ||
                    !routingName.trim() ||
                    assignees.every((assignee) => !assignee.userId.trim())
                  }
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {routingSubmitting
                    ? "Creating..."
                    : "Create Rule"}
                </button>
              </div>
            </form>
          )}

          {/* Routing Rule Cards */}
          {routingRules === undefined ? (
            <LoadingCards count={3} />
          ) : routingRules.length === 0 ? (
            <EmptyState
              icon={Route}
              title="No routing rules yet"
              description="Create routing rules to automatically assign leads to your team."
              details={[
                {
                  label: "Routing inputs",
                  value: "Lead score, account ownership, team members, territories, role coverage, and priority thresholds.",
                },
                {
                  label: "Shared outputs",
                  value: "Routing decisions connect scored contacts to reps, accounts, activity focus, and team coverage.",
                },
              ]}
              suggestions={[
                "Create score-based routing after the first scoring model exists.",
                "Prefer account-owner routing for known accounts, then use round-robin for unowned qualified contacts.",
                "Keep rule priority explicit so routing behavior is explainable when multiple rules match.",
              ]}
              action={{ label: "Create your first rule", onClick: () => setShowRoutingForm(true) }}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {routingRules.map((rule) => (
                <div
                  key={rule._id}
                  className="border-b border-border/70 py-5 shadow-sm hover:shadow-md transition-shadow"
                >
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-semibold text-base">
                      {rule.name}
                    </h3>
                    <StatusBadge status={rule.isActive ? "active" : "inactive"} />
                  </div>

                  <div className="flex items-center gap-2 mb-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize",
                        METHOD_COLORS[rule.method] ??
                          METHOD_COLORS.round_robin,
                      )}
                    >
                      {rule.method.replace(/_/g, " ")}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" />
                      {rule.assignees.length}{" "}
                      {rule.assignees.length === 1
                        ? "assignee"
                        : "assignees"}
                    </span>
                    {rule.slaMinutes != null && (
                      <span className="text-xs bg-muted px-2 py-1 rounded-md">
                        SLA: {rule.slaMinutes}min
                      </span>
                    )}
                  </div>
                  {rule.assignees.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {rule.assignees.slice(0, 4).map((assignee) => (
                        <span
                          key={assignee.userId}
                          className="rounded-md border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground"
                        >
                          {userById.get(assignee.userId)?.name ?? "Unknown"}
                        </span>
                      ))}
                      {rule.assignees.length > 4 && (
                        <span className="rounded-md border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                          +{rule.assignees.length - 4}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Lead Board Tab ──────────────────────────── */}
      {tab === "leadboard" && (
        <div>
          <h2 className="text-lg font-semibold mb-4">Lead Board</h2>
          {leadScores === undefined ? (
            <LoadingRows count={6} height="h-14" />
          ) : leadScores.length === 0 ? (
            <EmptyState
              icon={Star}
              title="No scored leads yet"
              description="Score inherited CRM contacts to build the first lead board from title, account fit, coverage, and ownership data."
              details={[
                {
                  label: "Contact inputs",
                  value: "CRM contacts, titles, emails, account fit, buying committee coverage, owner mapping, and routing rules.",
                },
                {
                  label: "Shared outputs",
                  value: "Lead scores inform routing, ABM coverage, scorecards, activity focus, and campaign follow-up.",
                },
              ]}
              suggestions={[
                "Score synced contacts before creating manual routing spreadsheets.",
                "Default hot, warm, and cold bands from the scoring model, then adjust thresholds once the distribution is visible.",
                "Route high-fit contacts to mapped owners first and only fall back to round-robin when account ownership is unknown.",
              ]}
              action={{
                label: generating ? "Scoring..." : "Score CRM contacts",
                onClick: handleGenerateScores,
              }}
            />
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
                <SummaryCard label="Scored Leads" value={leadSummary.total} icon={Star} />
                <SummaryCard label="Hot" value={leadSummary.hot} icon={Flame} />
                <SummaryCard label="Warm" value={leadSummary.warm} icon={Sun} />
                <SummaryCard label="Cold" value={leadSummary.cold} icon={Snowflake} />
                <SummaryCard
                  label="Avg Score"
                  value={leadSummary.avgScore}
                  icon={UserCheck}
                />
              </div>

              <DataTable
                className="bg-card shadow-sm"
                searchPlaceholder="Search contacts, accounts, titles, owners..."
                initialSort={{ key: "score", direction: "desc" }}
                data={leadScores}
                rowKey={(score) => score._id}
                columns={[
                  {
                    key: "contact",
                    header: "Contact",
                    searchValue: (score) =>
                      `${score.contactName} ${score.contactEmail ?? ""} ${score.contactTitle ?? ""}`,
                    render: (score) => (
                      <div>
                        <div className="font-medium">{score.contactName}</div>
                        <div className="text-xs text-muted-foreground">
                          {score.contactTitle ?? score.contactEmail ?? "CRM contact"}
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: "score",
                    header: "Score",
                    sortValue: (score) => score.score,
                    className: "text-right",
                    render: (score) => (
                      <span className="font-semibold tabular-nums">
                        {score.score}
                      </span>
                    ),
                  },
                  {
                    key: "grade",
                    header: "Grade",
                    searchValue: (score) => score.grade,
                    render: (score) => <StatusBadge status={score.grade} />,
                  },
                  {
                    key: "account",
                    header: "Account",
                    searchValue: (score) =>
                      `${score.accountName ?? ""} ${score.accountDomain ?? ""} ${score.accountIndustry ?? ""}`,
                    render: (score) => (
                      <div>
                        <div>{score.accountName ?? "No account"}</div>
                        <div className="text-xs text-muted-foreground">
                          {score.accountIndustry ?? score.accountDomain ?? "---"}
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: "fit",
                    header: "Fit",
                    sortValue: (score) => score.accountAnnualRevenue ?? 0,
                    render: (score) => (
                      <div className="text-sm">
                        <div className="tabular-nums">
                          {score.accountAnnualRevenue
                            ? formatCompactCurrency(score.accountAnnualRevenue)
                            : "---"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {score.accountEmployeeCount
                            ? `${score.accountEmployeeCount.toLocaleString()} employees`
                            : "No size data"}
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: "owner",
                    header: "Owner",
                    searchValue: (score) => score.ownerName ?? "",
                    render: (score) => (
                      <span className="text-muted-foreground">
                        {score.ownerName ?? "Unassigned"}
                      </span>
                    ),
                  },
                  {
                    key: "signals",
                    header: "Signals",
                    sortable: false,
                    searchValue: (score) => {
                      const breakdown = normalizeBreakdown(score.breakdown);
                      return `${breakdown.matchedRules?.map((rule) => rule.field).join(" ") ?? ""} ${breakdown.buyingCommitteeContacts ?? 0}`;
                    },
                    render: (score) => {
                      const breakdown = normalizeBreakdown(score.breakdown);
                      return (
                        <div className="flex max-w-sm flex-wrap gap-1.5">
                          {(breakdown.matchedRules ?? [])
                            .slice(0, 3)
                            .map((rule) => (
                              <SignalChip
                                key={`${rule.field}-${rule.points}`}
                                label={`${rule.field} +${rule.points}`}
                              />
                            ))}
                          <SignalChip
                            label={`${breakdown.buyingCommitteeContacts ?? 0} contacts`}
                          />
                          <SignalChip
                            label={
                              breakdown.ownerMapped
                                ? "Owner mapped"
                                : "No owner"
                            }
                          />
                        </div>
                      );
                    },
                  },
                ]}
              />
            </div>
          )}
        </div>
      )}
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
