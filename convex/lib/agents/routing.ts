/**
 * Event agents' routing and CRM-event triggers (GT7b). After a turn, an
 * agent with a route checks its qualification rule against the turn's
 * answers and adds the event's contact to an audience. A CRM event (a deal
 * entering a stage) can wake an agent the way a webhook event does.
 *
 * Pure and runtime-neutral: convex/agentTurns.ts, the Node turn action and
 * tests call it.
 */
import type { RecordClient } from "../recordClient.ts";
import type { ContactRow } from "../recordContract.ts";

export type RuleOp = "equals" | "contains";
/** An explicit condition on one AI field's answer. No model judges it. */
export type QualifyRule = { fieldSlug: string; op: RuleOp; value: string };
export type CrmTrigger = { event: "deal.stage_changed"; toStage?: string };

export const RULE_VALUE_MAX = 200;
export const STAGE_MAX = 100;

/** Output statuses whose answer passed the write gate (proposed or accepted, or the same answer proposed before). */
const GATED = new Set(["answered", "unchanged"]);

type Output = { fieldSlug: string; label: string; status: string; value?: string | number | boolean };

const norm = (x: unknown) => String(x).trim().toLowerCase();

/**
 * Whether a finished turn's answers meet the rule. No rule: every finished
 * turn qualifies. Only answers that passed the write gate count; one the gate
 * rejected (a quote not found verbatim, say) never qualifies a contact.
 */
export function qualifies(rule: QualifyRule | undefined, outputs: readonly Output[]): { ok: boolean; message: string } {
  if (!rule) return { ok: true, message: "No rule: every finished turn qualifies." };
  const o = outputs.find((x) => x.fieldSlug === rule.fieldSlug);
  if (!o || o.value === undefined || !GATED.has(o.status)) {
    return { ok: false, message: `${o?.label ?? rule.fieldSlug} has no answer that passed the write gate.` };
  }
  const got = norm(o.value);
  const want = norm(rule.value);
  const ok = rule.op === "equals" ? got === want : got.includes(want);
  return { ok, message: `${o.label} is "${String(o.value)}"; the rule wants it to ${rule.op === "equals" ? "equal" : "contain"} "${rule.value}".` };
}

/**
 * An outcome computed with the rule the turn started under, checked against
 * the rule the agent has now. The turn's stored outputs are what the rule
 * judges, so the current rule can be re-evaluated at commit time. "stale"
 * means the old rule rejected a contact the current rule would accept: the
 * turn is not routed, since this transaction can't look the contact up.
 */
export function settleOutcome<T extends { kind: string; message?: string }>(
  rule: QualifyRule | undefined,
  outputs: readonly Output[],
  outcome: T,
): T | { kind: "not_qualified"; message: string } | { kind: "stale" } {
  const verdict = qualifies(rule, outputs);
  if (outcome.kind === "not_qualified") return verdict.ok ? { kind: "stale" } : { kind: "not_qualified", message: verdict.message };
  return verdict.ok ? outcome : { kind: "not_qualified", message: verdict.message };
}

/** The contact in workspace `ws` with exactly this email: null when none, "ambiguous" when several. */
export async function findContact(client: Pick<RecordClient, "listContacts">, ws: string, email: string): Promise<ContactRow | "ambiguous" | null> {
  const want = norm(email);
  const page = await client.listContacts(ws, { filter: { q: want }, limit: 25 });
  const hits = page.rows.filter((r) => r.email && norm(r.email) === want);
  return hits.length > 1 ? "ambiguous" : hits[0] ?? null;
}

/** Whether a deal moving into `to` wakes an agent with this trigger. No stage named: every stage change does. */
export function stageMatches(trigger: CrmTrigger, to: string): boolean {
  return !trigger.toStage || norm(trigger.toStage) === norm(to);
}

/** A stage change between two projections of a deal, or null when there is none to report. */
export function stageChange(before: unknown, after: unknown): { from: string | null; to: string } | null {
  const to = typeof after === "string" && after.trim() ? after : null;
  const from = typeof before === "string" && before.trim() ? before : null;
  return to && to !== from ? { from, to } : null;
}
