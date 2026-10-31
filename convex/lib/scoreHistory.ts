/**
 * Fit and heat as of a date, and an account's score history (docs/signal-ledger.md, "Scores are derived,
 * from versioned inputs"). Neither score is stored as history; this rebuilds both from their inputs:
 * the ICP version active then, the account's fields then (current values minus later `field_history`
 * changes) and the signals the observation log shows as live then. Pure and free of Node imports.
 */
import { v, type Infer } from "convex/values";
import { heatScore, type HeatSignal } from "./signals/heat.ts";
import type { HeatModel } from "../../recipes/models.ts";
import type { LoggedObservation } from "./signals/observations";
import { fitUnderWeights } from "./recordClient.ts";
import { gatedFit } from "./icpGates.ts";
import type { IcpGate } from "./recordContract.ts";
import type { FieldChange } from "./timeline";

/** A complete ICP weight set (points out of 100): every term present, never a sparse patch. */
export const icpVersionWeightsValidator = v.object({
  base: v.number(),
  industries: v.record(v.string(), v.number()),
  countries: v.record(v.string(), v.number()),
  employeeBands: v.array(v.object({ min: v.number(), max: v.number(), weight: v.number() })),
});
export type IcpVersionWeights = Infer<typeof icpVersionWeightsValidator>;
/** A saved ICP as the record service scored it (lib/icps.ts specGate; recordContract IcpGate). */
export const icpGateValidator = v.object({
  id: v.string(),
  base: v.number(),
  max: v.number(),
  industries: v.record(v.string(), v.number()),
  countries: v.record(v.string(), v.number()),
  employees: v.array(v.object({ min: v.number(), max: v.number(), weight: v.number() })),
  excludeIndustries: v.array(v.string()),
  excludeCountries: v.array(v.string()),
  custom: v.array(v.object({ key: v.string(), values: v.optional(v.array(v.string())), min: v.optional(v.number()), max: v.optional(v.number()) })),
  buyer: v.optional(v.object({ levels: v.array(v.string()), departments: v.array(v.string()), topics: v.array(v.string()), titles: v.array(v.string()), exclude: v.array(v.string()) })),
});
/** With `gates` (saved ICPs, record service 1.14.0), the gates set fit; the weights are only what older readers saw. */
export type IcpVersion = { version: number; acceptedAt: number; weights: IcpVersionWeights; gates?: IcpGate[] };

export const FIT_FIELDS = ["industry", "country", "employees"] as const;
export type FitField = (typeof FIT_FIELDS)[number];
type FieldValue = string | number | null;

/** A field at a date: known, or unknown because nothing records what it held then. */
export type FieldAt = { known: true; value: FieldValue } | { known: false };
export type FieldsAt = Record<FitField, FieldAt>;
/** Fit 0..100, or unknown with the fields the version weighs whose value then is not on record. */
export type FitAt = { known: true; fit: number } | { known: false; missing: FitField[] };

export type ScoreCause =
  | { kind: "weights"; from: number | null; to: number }
  | { kind: "field"; field: FitField; from: FieldValue; to: FieldValue }
  | { kind: "signal_started"; trigger: string }
  | { kind: "signal_ended"; trigger: string }
  | { kind: "first_contact" };
export type ScorePoint = { at: number; fit: FitAt; heat: number; causes: ScoreCause[] };

/** Earlier points shown; first contact is kept beyond this. */
export const SCORE_POINTS_MAX = 8;
/** Field history rows `records.get` returns (record service getAccount). */
const ACCOUNT_HISTORY_READ = 200;

type Interval = { key: string; trigger: string; start: number; end: number | null; signal: HeatSignal };

/** Each signal's live intervals: open at its start (posting date, else first seen), closed when seen gone. */
function intervals(log: readonly LoggedObservation[]): Interval[] {
  const open = new Map<string, Interval>();
  const out: Interval[] = [];
  for (const entry of [...log].sort((a, b) => a.seq - b.seq)) {
    const body = entry.body;
    if (body.type === "signal_seen" && !open.has(body.key)) {
      const start = entry.occurredAt ?? entry.observedAt;
      const interval = { key: body.key, trigger: body.signal.trigger, start, end: null, signal: { bucket: body.signal.bucket, observedAt: start, reposted: body.signal.bucket === "job" ? body.signal.reposted : undefined } };
      open.set(body.key, interval);
      out.push(interval);
    } else if (body.type === "signal_gone") {
      const interval = open.get(body.key);
      if (interval) interval.end = entry.observedAt;
      open.delete(body.key);
    }
  }
  return out;
}

const liveAt = (all: readonly Interval[], t: number) => all.filter((i) => i.start <= t && (i.end === null || t < i.end));

/** Heat at `t`: the heat formula, on the workspace's signals.heat model, over the signals live at `t`. */
export function heatAsOf(log: readonly LoggedObservation[], t: number, model: HeatModel): { score: number; label: string } {
  return heatScore(liveAt(intervals(log), t).map((i) => i.signal), t, model);
}

const parse = (field: FitField, raw: FieldValue | undefined): FieldValue => {
  if (raw === undefined || raw === null || raw === "") return null;
  return field === "employees" ? Number(raw) : String(raw);
};

/**
 * The fit fields at `t`: current values with every later change undone. The record service writes no
 * history for the values a row is created with, so before the row is on record (its domain's set time,
 * or its oldest change, whichever is earlier) every field is unknown rather than guessed. A history read
 * that hit its bound reaches back only to its oldest row.
 */
export function fieldsAsOf(
  account: { industry?: string; country?: string; employees?: number; fieldUpdatedAt?: Record<string, number> },
  history: readonly FieldChange[],
  t: number,
): FieldsAt {
  const oldest = Math.min(...history.map((h) => h.at));
  const onRecordSince = history.length >= ACCOUNT_HISTORY_READ ? oldest : Math.min(account.fieldUpdatedAt?.domain ?? Infinity, oldest);
  const at = (field: FitField): FieldAt => {
    if (t < onRecordSince) return { known: false };
    let value = parse(field, account[field]);
    for (const change of [...history].sort((a, b) => b.at - a.at)) if (change.field === field && change.at > t) value = parse(field, change.oldValue);
    return { known: true, value };
  };
  return { industry: at("industry"), country: at("country"), employees: at("employees") };
}

/** The fields a version scores on: those it gives any weight, or any of its ICP gates checks. */
function weighed(weights: IcpVersionWeights, gates?: IcpGate[]): FitField[] {
  if (gates) {
    return FIT_FIELDS.filter((f) => gates.some((g) =>
      f === "industry" ? Object.keys(g.industries).length > 0 || g.excludeIndustries.length > 0
        : f === "country" ? Object.keys(g.countries).length > 0 || g.excludeCountries.length > 0 : g.employees.length > 0));
  }
  return FIT_FIELDS.filter((f) =>
    f === "industry" ? Object.keys(weights.industries).length > 0 : f === "country" ? Object.keys(weights.countries).length > 0 : weights.employeeBands.length > 0,
  );
}

/** Fit (0..100) of the fields at a date under the version active then; unknown when a weighed field is. */
export function fitAsOf(fields: FieldsAt, version: IcpVersion | null): FitAt {
  if (!version) return { known: false, missing: [] };
  const missing = weighed(version.weights, version.gates).filter((f) => !fields[f].known);
  if (missing.length) return { known: false, missing };
  const text = (f: FitField) => {
    const at = fields[f];
    return at.known && typeof at.value === "string" ? at.value : undefined;
  };
  const employees = fields.employees.known && typeof fields.employees.value === "number" ? fields.employees.value : undefined;
  const row = { industry: text("industry"), country: text("country"), employees };
  if (version.gates) {
    // AI-field answers have no history here: a fit only they would decide stays unknown. Nor do the people who
    // worked there, so the buyer isn't checked: history shows the company's fit.
    const r = gatedFit(row, version.gates, false);
    return "unknown" in r ? { known: false, missing: [] } : { known: true, fit: Math.round(r.fit * 100) };
  }
  return { known: true, fit: Math.round(fitUnderWeights(row, version.weights) * 100) };
}

/** The version active at `t`: the newest accepted at or before it. */
export const versionAt = (versions: readonly IcpVersion[], t: number): IcpVersion | null =>
  versions.filter((v) => v.acceptedAt <= t).sort((a, b) => b.version - a.version)[0] ?? null;

const sameFit = (a: FitAt, b: FitAt) => (a.known && b.known ? a.fit === b.fit : a.known === b.known);

/**
 * The account's score history, newest first: each point where an ICP version, a fit field or a signal
 * changed fit or heat, named by its cause, plus first contact whatever it changed.
 */
export function scoreHistory(input: {
  account: Parameters<typeof fieldsAsOf>[0];
  history: readonly FieldChange[];
  log: readonly LoggedObservation[];
  versions: readonly IcpVersion[];
  firstContactAt: number | null;
  heat: HeatModel;
}): ScorePoint[] {
  const { account, history, log, versions, firstContactAt } = input;
  const events: Array<{ at: number; cause: ScoreCause }> = [];
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  sorted.forEach((v, i) => events.push({ at: v.acceptedAt, cause: { kind: "weights", from: i ? sorted[i - 1].version : null, to: v.version } }));
  for (const h of history) {
    const field = FIT_FIELDS.find((f) => f === h.field);
    if (field) events.push({ at: h.at, cause: { kind: "field", field, from: parse(field, h.oldValue), to: parse(field, h.newValue) } });
  }
  for (const i of intervals(log)) {
    events.push({ at: i.start, cause: { kind: "signal_started", trigger: i.trigger } });
    if (i.end !== null) events.push({ at: i.end, cause: { kind: "signal_ended", trigger: i.trigger } });
  }
  if (firstContactAt !== null) events.push({ at: firstContactAt, cause: { kind: "first_contact" } });

  const byTime = new Map<number, ScoreCause[]>();
  for (const e of events.sort((a, b) => a.at - b.at)) byTime.set(e.at, [...(byTime.get(e.at) ?? []), e.cause]);
  const points: ScorePoint[] = [];
  for (const [at, causes] of byTime) {
    const point = { at, causes, fit: fitAsOf(fieldsAsOf(account, history, at), versionAt(versions, at)), heat: heatAsOf(log, at, input.heat).score };
    const previous = points.at(-1);
    const contact = causes.some((c) => c.kind === "first_contact");
    if (contact || !previous || !sameFit(previous.fit, point.fit) || previous.heat !== point.heat) points.push(point);
  }
  const newest = points.reverse();
  const shown = newest.slice(0, SCORE_POINTS_MAX);
  const contact = newest.find((p) => p.causes.some((c) => c.kind === "first_contact"));
  return contact && !shown.includes(contact) ? [...shown, contact] : shown;
}
