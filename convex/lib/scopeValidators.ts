/**
 * Which records a TAM job or a research run covers. The account filter mirrors
 * AccountsFilter (recordContract.ts); a contact scope is chosen rows or a
 * saved view's filter as it was when the run started.
 */
import { v, type Infer } from "convex/values";
import { listFilter } from "./objects/validators.ts";

const statusValidator = v.union(v.literal("new"), v.literal("working"), v.literal("qualified"), v.literal("disqualified"));
export const filterValidator = v.object({
  segmentId: v.optional(v.string()),
  status: v.optional(statusValidator),
  ownerId: v.optional(v.string()),
  minFit: v.optional(v.number()),
  q: v.optional(v.string()),
  industry: v.optional(v.array(v.string())),
  country: v.optional(v.array(v.string())),
  employeeMin: v.optional(v.number()),
  employeeMax: v.optional(v.number()),
  sizeBand: v.optional(v.array(v.string())),
  region: v.optional(v.array(v.string())),
  traits: v.optional(v.record(v.string(), v.array(v.string()))),
  // A saved ICP's members (record service 1.14.0).
  icpId: v.optional(v.string()),
  // AI-field slug -> accepted answers (record service 1.21.0).
  custom: v.optional(v.record(v.string(), v.array(v.string()))),
});
export type AccountScope = Infer<typeof filterValidator>;

const contactScope = v.union(v.object({ ids: v.array(v.string()) }), v.object({ filter: v.array(listFilter) }));
export type ContactScope = Infer<typeof contactScope>;

export const runScopeValidator = v.union(
  v.object({ entity: v.literal("account"), filter: filterValidator }),
  v.object({ entity: v.literal("contact"), scope: contactScope }),
);
export type RunScope = Infer<typeof runScopeValidator>;

/**
 * A research run's scope. Runs started before `scope` existed keep it in the
 * untyped `filter`, written by startRun from the agent's entity type, so that
 * type says which shape it holds. Removed once old runs are backfilled.
 */
export function runScopeOf(run: { scope?: RunScope; filter?: unknown }, entityType: "account" | "contact"): RunScope {
  if (run.scope) return run.scope;
  return entityType === "contact"
    ? { entity: "contact", scope: run.filter as ContactScope }
    : { entity: "account", filter: (run.filter ?? {}) as AccountScope };
}
