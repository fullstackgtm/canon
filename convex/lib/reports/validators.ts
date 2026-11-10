/** Validators for targets (lib/reports/targets.ts), shared by the schema and convex/targets.ts. */
import { v } from "convex/values";

export const monthsSplit = v.object({
  method: v.union(v.literal("even"), v.literal("history"), v.literal("custom")),
  custom: v.optional(v.array(v.number())),
});

export const teamsSplit = v.object({
  method: v.union(v.literal("even"), v.literal("history"), v.literal("custom")),
  custom: v.optional(v.record(v.string(), v.number())),
  locks: v.optional(v.record(v.string(), v.number())),
});

export const repsSplit = v.object({
  method: v.union(v.literal("even"), v.literal("history"), v.literal("capacity")),
  locks: v.optional(v.record(v.string(), v.number())),
  /** A rep's four quarters, set outright (a pasted plan); their year is the sum. */
  quarters: v.optional(v.record(v.string(), v.array(v.number()))),
  /** When a rep started (YYYY-MM-DD) and their ramp in months, for capacity and new reps. */
  profiles: v.optional(v.record(v.string(), v.object({ start: v.optional(v.string()), rampMonths: v.optional(v.number()) }))),
});

/** What a planner chooses for a year: amounts in cents; keys are users and teamGroups ids. */
export const targetPlanChoices = {
  year: v.number(),
  total: v.number(),
  /** The pipeline-created target is the bookings target times this. */
  coverage: v.number(),
  months: monthsSplit,
  teams: teamsSplit,
  reps: repsSplit,
};

/** A saved plan's fields beside its org and who saved it: the choices and the plan they produced. */
export const targetPlanFields = {
  ...targetPlanChoices,
  /** The team each rep's target counts toward ("none" for a rep on no team). */
  repTeam: v.record(v.string(), v.string()),
  /** The plan the choices produced when saved, by month (12), so pacing reads stable targets. */
  repMonths: v.record(v.string(), v.array(v.number())),
  teamMonths: v.record(v.string(), v.array(v.number())),
  /** The month (1-12) the plan's fiscal year starts in; absent on plans saved before fiscal years, which are calendar years. */
  fyStart: v.optional(v.number()),
};
