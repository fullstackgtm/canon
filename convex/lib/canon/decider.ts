/**
 * Who accepted or rejected a proposed fact: a person reviewing it, an
 * auto-accept rule after verification, or an agent's standing grant.
 *
 * `facts.decider` stores it. Rows written before that field existed carry only
 * the prefixed `decidedBy` string, and `deciderOf` is the one place that reads
 * it. Ids are plain strings because this ledger code also runs in unit tests.
 */
import { v, type Infer } from "convex/values";
import type { EntryActor, EntrySource } from "../objects/fold.ts";

export const deciderValidator = v.union(
  v.object({ kind: v.literal("user"), userId: v.string() }),
  v.object({ kind: v.literal("rule"), rule: v.literal("auto_accept+jev") }),
  v.object({ kind: v.literal("grant"), grantId: v.string() }),
);
export type Decider = Infer<typeof deciderValidator>;

/** A decided fact's decider, or a legacy row that never recorded one (or recorded a string no writer produces). */
export type FactDecider = Decider | { kind: "unrecorded"; legacy: string | null };

/** The `decidedBy` string written next to `decider` until the narrow step drops it. */
export function decidedByOf(d: Decider): string {
  switch (d.kind) {
    case "user": return `user:${d.userId}`;
    case "rule": return `rule:${d.rule}`;
    case "grant": return `grant:${d.grantId}`;
  }
}

export function deciderOf(f: { decider?: Decider; decidedBy?: string }): FactDecider {
  if (f.decider) return f.decider;
  const raw = f.decidedBy;
  if (raw?.startsWith("user:")) return { kind: "user", userId: raw.slice("user:".length) };
  if (raw?.startsWith("grant:")) return { kind: "grant", grantId: raw.slice("grant:".length) };
  if (raw === "rule:auto_accept+jev") return { kind: "rule", rule: "auto_accept+jev" };
  return { kind: "unrecorded", legacy: raw ?? null };
}

/** A decide entry's source and actor. The source ref keeps the legacy string, so no decision loses what it recorded. */
export function decisionMeta(d: FactDecider): { source: EntrySource; actor: EntryActor } {
  if (d.kind === "unrecorded") return { source: { kind: "user", ref: d.legacy ?? "" }, actor: { kind: "unrecorded" } };
  const ref = decidedByOf(d);
  switch (d.kind) {
    case "user": return { source: { kind: "user", ref }, actor: { kind: "user", id: d.userId } };
    case "rule": return { source: { kind: "user", ref }, actor: { kind: "rule", id: d.rule } };
    case "grant": return { source: { kind: "user", ref }, actor: { kind: "agent", id: ref } };
  }
}
