/**
 * Deal pipelines (CP4). The org's deal `stage` picklist options in the
 * registry are the one list of stages and their labels. A pipeline is an
 * ordered claim on some of those options, with each stage's probability and
 * forecast category. A stage belongs to exactly one pipeline, so a deal's
 * pipeline is the one that holds its stage: a deal whose stage is outside its
 * pipeline cannot be stored. The first pipeline is the default; it also holds
 * every stage no pipeline claims, such as one a CRM sync registers later. An
 * org with no stored pipeline has one virtual default holding every stage.
 */
import type { PicklistOption } from "./objects/registry";

export const FORECAST_CATEGORIES = ["omit", "pipeline", "best_case", "commit", "closed_won", "closed_lost"] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];
export type StageConfig = { value: string; probability: number; forecastCategory: ForecastCategory };
export type StoredPipeline = { id: string; name: string; stages: readonly StageConfig[]; createdAt: number };
export type PipelineStage = StageConfig & { label: string; active: boolean };
/** `id` is null for the virtual default of an org that has stored none. */
export type Pipeline = { id: string | null; name: string; isDefault: boolean; stages: PipelineStage[] };

export const DEFAULT_PIPELINE_NAME = "Sales pipeline";
const MAX_STAGES = 50;
const MAX_LABEL = 80;

/** What an unconfigured stage starts with: won and lost by name, open stages spread 10 to 90 by position. */
function defaultConfig(option: PicklistOption, openIndex: number, openCount: number): StageConfig {
  const name = `${option.value} ${option.label}`.toLowerCase();
  if (name.includes("won")) return { value: option.value, probability: 100, forecastCategory: "closed_won" };
  if (name.includes("lost")) return { value: option.value, probability: 0, forecastCategory: "closed_lost" };
  return { value: option.value, probability: Math.round(((openIndex + 1) / (openCount + 1)) * 10) * 10, forecastCategory: "pipeline" };
}

function defaultConfigs(options: readonly PicklistOption[]): StageConfig[] {
  const isOpen = (o: PicklistOption) => !/won|lost/.test(`${o.value} ${o.label}`.toLowerCase());
  const openCount = options.filter(isOpen).length;
  let openIndex = 0;
  return options.map((o) => defaultConfig(o, isOpen(o) ? openIndex++ : 0, openCount));
}

/** The org's pipelines, default first. A stage claimed twice stays with the older pipeline. */
export function resolvePipelines(options: readonly PicklistOption[], stored: readonly StoredPipeline[]): Pipeline[] {
  const byValue = new Map(options.map((o) => [o.value, o]));
  const withLabel = (c: StageConfig): PipelineStage => ({ ...c, label: byValue.get(c.value)!.label, active: byValue.get(c.value)!.active });
  const claimed = new Set<string>();
  const pipelines: Pipeline[] = [...stored].sort((a, b) => a.createdAt - b.createdAt).map((p, i) => ({
    id: p.id,
    name: p.name,
    isDefault: i === 0,
    stages: p.stages.filter((s) => byValue.has(s.value) && !claimed.has(s.value) && claimed.add(s.value)).map(withLabel),
  }));
  const unclaimed = defaultConfigs(options.filter((o) => !claimed.has(o.value))).map(withLabel);
  if (pipelines.length === 0) return [{ id: null, name: DEFAULT_PIPELINE_NAME, isDefault: true, stages: unclaimed }];
  pipelines[0].stages.push(...unclaimed);
  return pipelines;
}

/** The pipeline holding `stage`, and that stage's settings. */
export function stageOf(pipelines: readonly Pipeline[], stage: string): { pipeline: Pipeline; stage: PipelineStage } | null {
  for (const pipeline of pipelines) {
    const found = pipeline.stages.find((s) => s.value === stage);
    if (found) return { pipeline, stage: found };
  }
  return null;
}

/**
 * A person's deal edit with what a stage implies: moving to a stage sets its
 * probability and forecast category unless the edit sets them, and the
 * forecast category decides closed and won. Closed and won are never set any
 * other way, so they cannot disagree with the category.
 */
export function withStageOutcome<V>(pipelines: readonly Pipeline[], values: Record<string, V>): Record<string, V | string | number | boolean> {
  const out: Record<string, V | string | number | boolean> = { ...values };
  const found = typeof out.stage === "string" ? stageOf(pipelines, out.stage) : null;
  if (found) {
    if (!("forecastCategory" in out)) out.forecastCategory = found.stage.forecastCategory;
    if (!("probability" in out)) out.probability = stageOutcome(found.stage).probability;
  }
  if ("forecastCategory" in out) {
    out.isWon = out.forecastCategory === "closed_won";
    out.isClosed = out.isWon || out.forecastCategory === "closed_lost";
  }
  return out;
}

/** What a deal in `stage` holds. A stage's probability is a percent; a deal's is a fraction (forecasting.ts). */
export function stageOutcome(stage: StageConfig): { forecastCategory: ForecastCategory; probability: number; isClosed: boolean; isWon: boolean } {
  const isWon = stage.forecastCategory === "closed_won";
  return { forecastCategory: stage.forecastCategory, probability: stage.probability / 100, isClosed: isWon || stage.forecastCategory === "closed_lost", isWon };
}

export const DEAL_TYPES = ["new_business", "expansion", "renewal", "one_time"] as const;
export const REVENUE_TYPES = ["one_time", "recurring"] as const;
type DealType = (typeof DEAL_TYPES)[number];
type RevenueType = (typeof REVENUE_TYPES)[number];

/** A new deal as a person or the MCP sends it. `pipelineId` omitted means the stage's own pipeline; null is the default of an org with none stored. */
export type DealCreateInput = {
  name: string; amount?: number; currency?: string; closeDate: string; stage: string;
  pipelineId?: string | null; dealType?: string; revenueType?: string;
};
/** A complete new deal's ledger values, with its stage's outcome. Revenue type is a deals column the ledger does not hold. */
export type DealCreate = {
  name: string; amount?: number; currency: string; closeDate: string; stage: string; dealType: DealType;
  forecastCategory: ForecastCategory; probability: number; isClosed: boolean; isWon: boolean;
};

const isOneOf = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

/** Parse a new deal against the org's pipelines. The stage must be an active stage of the chosen pipeline. */
export function planDealCreate(pipelines: readonly Pipeline[], input: DealCreateInput): { ok: true; deal: DealCreate; revenueType: RevenueType } | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name || name.length > 200) return { ok: false, error: "A deal needs a name of up to 200 characters" };
  const currency = (input.currency ?? "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "Currency is a three-letter code, such as USD" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.closeDate) || Number.isNaN(Date.parse(input.closeDate))) return { ok: false, error: "Close date is a date (YYYY-MM-DD)" };
  if (input.amount !== undefined && !(Number.isInteger(input.amount) && input.amount >= 0)) return { ok: false, error: "Amount is a whole number of cents, 0 or more" };
  const dealType = input.dealType ?? "new_business";
  if (!isOneOf(DEAL_TYPES, dealType)) return { ok: false, error: `Deal type is one of ${DEAL_TYPES.join(", ")}` };
  const revenueType = input.revenueType ?? (dealType === "one_time" ? "one_time" : "recurring");
  if (!isOneOf(REVENUE_TYPES, revenueType)) return { ok: false, error: `Revenue type is one of ${REVENUE_TYPES.join(", ")}` };
  const found = stageOf(pipelines, input.stage);
  if (!found || !found.stage.active) return { ok: false, error: "Pick a stage" };
  if (input.pipelineId !== undefined) {
    const chosen = pipelines.find((p) => p.id === input.pipelineId);
    if (!chosen) return { ok: false, error: "That pipeline no longer exists" };
    if (chosen !== found.pipeline) return { ok: false, error: `${found.stage.label} is a stage of ${found.pipeline.name}, not ${chosen.name}` };
  }
  return {
    ok: true,
    deal: { name, ...(input.amount !== undefined ? { amount: input.amount } : {}), currency, closeDate: input.closeDate, stage: found.stage.value, dealType, ...stageOutcome(found.stage) },
    revenueType,
  };
}

/** A CRM's sales process to bring in as a pipeline (CP11): its stages in order, each with its own settings. */
export type ImportedProcess = { name: string; recordTypeIds: readonly string[]; stages: ReadonlyArray<{ name: string; probability: number; forecastCategory: ForecastCategory }> };
/** Where one (record type, CRM stage name) lands: a stage value of the process's pipeline. */
export type StagePlacement = { recordTypeId: string; stageName: string; value: string };

/**
 * Pipelines for a CRM's sales processes, one per process, matched to a stored
 * pipeline by name so a re-import changes nothing. A stage takes the CRM's
 * stage name as its value when no other pipeline holds that value, else
 * `<name> (<process>)`: two processes that share "Negotiation" get one stage
 * each, both labelled Negotiation. A matched pipeline keeps stages it had
 * that the CRM no longer lists, after the CRM's. An org with no stored
 * pipeline first stores its default, holding what the imported ones leave.
 */
export function planImportedPipelines(
  options: readonly PicklistOption[], stored: readonly StoredPipeline[], processes: readonly ImportedProcess[],
): { options: PicklistOption[]; writes: PipelineWrite[]; placements: StagePlacement[] } {
  const ordered = [...stored].sort((a, b) => a.createdAt - b.createdAt);
  const holder = new Map<string, string>();
  for (const p of ordered) for (const s of p.stages) if (!holder.has(s.value)) holder.set(s.value, p.id);
  const nextOptions = [...options];
  const placements: StagePlacement[] = [];
  const writes: PipelineWrite[] = [];
  processes.forEach((process, n) => {
    const target = ordered.find((p) => p.name === process.name);
    const key = target?.id ?? `new:${n}`;
    const stages: StageConfig[] = [];
    for (const s of process.stages) {
      const mine = (v: string) => holder.get(v) === key;
      const free = (v: string) => !holder.has(v);
      const candidates = [s.name, `${s.name} (${process.name})`];
      for (let k = 2; k < 50; k++) candidates.push(`${s.name} (${process.name}) ${k}`);
      const value = candidates.find(mine) ?? candidates.find(free)!;
      holder.set(value, key);
      if (!nextOptions.some((o) => o.value === value)) nextOptions.push({ value, label: s.name, active: true });
      if (!stages.some((x) => x.value === value)) stages.push({ value, probability: s.probability, forecastCategory: s.forecastCategory });
      for (const recordTypeId of process.recordTypeIds) placements.push({ recordTypeId, stageName: s.name, value });
    }
    const kept = (target?.stages ?? []).filter((s) => !stages.some((x) => x.value === s.value));
    const all = [...stages, ...kept];
    if (!target) writes.push({ kind: "insert", name: process.name, stages: all });
    else if (JSON.stringify(all) !== JSON.stringify(target.stages)) writes.push({ kind: "replace", id: target.id, name: target.name, stages: all });
  });
  if (!ordered.length && writes.length) {
    const rest = nextOptions.filter((o) => !holder.has(o.value));
    const fallback = resolvePipelines(rest, [])[0];
    if (fallback.stages.length) writes.unshift({ kind: "insert", name: fallback.name, stages: fallback.stages.map(({ value, probability, forecastCategory }) => ({ value, probability, forecastCategory })) });
  }
  return { options: nextOptions, writes, placements };
}

/** A pipeline as the settings form sends it, complete. A stage with no `value` is new. */
export type PipelineInput = {
  target: { kind: "new" } | { kind: "existing"; id: string | null };
  name: string;
  stages: ReadonlyArray<{ value: string | null; label: string; probability: number; forecastCategory: ForecastCategory }>;
};
export type PipelineWrite = { kind: "insert"; name: string; stages: StageConfig[] } | { kind: "replace"; id: string; name: string; stages: StageConfig[] };
export type PipelinePlan = { ok: true; options: PicklistOption[]; writes: PipelineWrite[] } | { ok: false; error: string };

function slug(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "stage";
  let value = base;
  for (let n = 2; taken.has(value); n++) value = `${base}_${n}`;
  return value;
}

/**
 * Check a pipeline save against the org's stages and pipelines, and return
 * the stage options and pipeline rows to write. A pipeline keeps every stage
 * it holds (removing one would move its deals) and cannot take another's.
 * The first save stores the virtual default, so it stays the default.
 */
export function planPipelineSave(options: readonly PicklistOption[], stored: readonly StoredPipeline[], input: PipelineInput): PipelinePlan {
  const name = input.name.trim();
  if (!name || name.length > MAX_LABEL) return { ok: false, error: "A pipeline needs a name of up to 80 characters" };
  if (input.stages.length === 0 || input.stages.length > MAX_STAGES) return { ok: false, error: `A pipeline has 1 to ${MAX_STAGES} stages` };
  const pipelines = resolvePipelines(options, stored);
  const target = input.target.kind === "new" ? null : pipelines.find((p) => p.id === (input.target as { id: string | null }).id);
  if (input.target.kind === "existing" && !target) return { ok: false, error: "That pipeline no longer exists" };

  const nextOptions = [...options];
  const taken = new Set(options.map((o) => o.value));
  const seen = new Set<string>();
  const stages: StageConfig[] = [];
  for (const s of input.stages) {
    const label = s.label.trim();
    if (!label || label.length > MAX_LABEL) return { ok: false, error: "Every stage needs a name of up to 80 characters" };
    if (!Number.isInteger(s.probability) || s.probability < 0 || s.probability > 100) return { ok: false, error: `${label}: probability is a whole number from 0 to 100` };
    let value = s.value;
    if (value === null) {
      value = slug(label, taken);
      taken.add(value);
      nextOptions.push({ value, label, active: true });
    } else {
      const owner = stageOf(pipelines, value)?.pipeline;
      if (!owner) return { ok: false, error: `${label} is not a stage` };
      if (owner !== target) return { ok: false, error: `${label} belongs to ${owner.name}` };
      if (seen.has(value)) return { ok: false, error: `${label} is listed twice` };
      const i = nextOptions.findIndex((o) => o.value === value);
      nextOptions[i] = { ...nextOptions[i], label };
    }
    seen.add(value);
    stages.push({ value, probability: s.probability, forecastCategory: s.forecastCategory });
  }
  const dropped = target?.stages.find((s) => !seen.has(s.value));
  if (dropped) return { ok: false, error: `${dropped.label} cannot be removed` };

  const writes: PipelineWrite[] = [];
  const virtualDefault = pipelines[0].id === null ? pipelines[0] : null;
  if (virtualDefault && target !== virtualDefault) {
    writes.push({ kind: "insert", name: virtualDefault.name, stages: virtualDefault.stages.map(({ value, probability, forecastCategory }) => ({ value, probability, forecastCategory })) });
  }
  writes.push(target?.id ? { kind: "replace", id: target.id, name, stages } : { kind: "insert", name, stages });
  return { ok: true, options: nextOptions, writes };
}
