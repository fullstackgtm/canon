/**
 * Stale facts: reads the fact ledger with facts.forRecords, proposes a correction with facts.propose and reads each
 * proposal's outcome with proposals.byIds (docs/modules.md, "Facts" and "Proposing facts").
 */
import type { CallContext, CallFunctions, Intent, ReadDoc } from "../../../modules/kernel/calls.ts";
import type { FactObject, FactsForRecordsRow, FactValue, FieldState } from "../../../modules/kernel/facts.ts";
import type { ProposalOutcome } from "../../../modules/kernel/proposals.ts";

/** The attributes this module may propose, as module.json's facts.<object>.propose declares them. */
const PROPOSABLE: Record<FactObject, readonly string[]> = {
  companies: ["industry", "employees", "annualRevenue", "country"],
  deals: ["closeDate", "nextStep"],
  people: [],
};
/** Ledger money is in minor units; a person reads and types it in whole units. */
const MONEY = new Set(["amount", "annualRevenue"]);
const NUMBER = new Set(["employees"]);
const DAY = 86_400_000;
const STATE_ORDER = { contested: 0, resolved: 1, empty: 2, unknown: 3 } as const;

type Deal = { id: string; name?: string | null; companyId?: string | null; companyName?: string | null };
type Company = { id: string; name?: string | null };
export type StaleRow = {
  object: FactObject; id: string; name: string; type: string; attribute: string;
  valueText: string; state: FieldState; stateText: string;
  confirmedAt: number | null; ageDays: number | null; proposable: boolean;
};

const STATE_TEXT: Record<Exclude<FieldState, "contested">, string> = { resolved: "Resolved", empty: "No value", unknown: "Not a field in this workspace" };

const valueText = (attribute: string, v: FactValue | undefined) =>
  v === null || v === undefined ? "" : MONEY.has(attribute) && typeof v === "number" ? String(v / 100) : String(v);

/**
 * Every declared field of the records read, contested first, then the ones confirmed longest ago, then empty ones. A
 * record the caller can't see has no row, so it isn't listed.
 */
export function staleRows(now: number, names: Map<string, string>, groups: Array<{ object: FactObject; rows: FactsForRecordsRow[] }>): StaleRow[] {
  const seen = new Set<string>();
  const row = (object: FactObject, id: string) => ({ object, id, name: names.get(id) ?? id, type: object === "deals" ? "Deal" : "Company" });
  const rows = groups.flatMap(({ object, rows }) => rows.flatMap((r) => {
    if (seen.has(`${object}:${r.id}`)) return [];
    seen.add(`${object}:${r.id}`);
    return r.fields.map((f): StaleRow => ({
      ...row(object, r.id), attribute: f.attribute, valueText: valueText(f.attribute, f.value), state: f.state,
      stateText: f.state === "contested" ? `Contested by ${f.contestedBy?.length ?? 0}` : STATE_TEXT[f.state],
      confirmedAt: f.confirmedAt ?? null, ageDays: f.confirmedAt === undefined ? null : Math.floor((now - f.confirmedAt) / DAY),
      proposable: f.state !== "unknown" && PROPOSABLE[object].includes(f.attribute),
    }));
  }));
  return rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.confirmedAt ?? Infinity) - (b.confirmedAt ?? Infinity) || a.name.localeCompare(b.name));
}

type ProposeArgs = { object: FactObject; record: string; recordName?: string; attribute: string; was?: string; value: string; evidence: string };

/** A correction doc and its facts.propose, stamped on the doc. The put comes first: the stamp writes a doc that exists. */
export function proposeIntents(ctx: Pick<CallContext, "now" | "caller">, a: ProposeArgs): Intent[] {
  if (!PROPOSABLE[a.object].includes(a.attribute)) throw new Error(`Stale facts doesn't propose ${a.attribute}.`);
  const raw = a.value.trim();
  const number = Number(raw.replace(/[,\s]/g, ""));
  if ((MONEY.has(a.attribute) || NUMBER.has(a.attribute)) && !Number.isFinite(number)) throw new Error(`${a.attribute} is a number, and ${raw} isn't one.`);
  const value: FactValue = MONEY.has(a.attribute) ? Math.round(number * 100) : NUMBER.has(a.attribute) ? number : raw;
  const key = `t${ctx.now}~${a.object}~${a.record}~${a.attribute}`.replace(/[^A-Za-z0-9_.:|@~-]/g, "_").slice(0, 200);
  const data = { object: a.object, record: a.record, recordName: a.recordName ?? a.record, attribute: a.attribute, ...(a.was ? { was: a.was } : {}), value: raw, evidence: a.evidence, by: ctx.caller.userId };
  return [
    { op: "put", collection: "corrections", key, data, expect: [{ collection: "corrections", key, version: null }] },
    { op: "propose", operation: "facts.propose", reason: `Stale facts: ${data.recordName}'s ${a.attribute}`, stamp: { collection: "corrections", key, field: "proposal" },
      args: { object: a.object, facts: [{ id: a.record, attribute: a.attribute, value, evidence: a.evidence }] } },
  ];
}

const REJECTED: Record<string, string> = {
  unknown_record: "not a record you can see",
  unknown_attribute: "not a field in this workspace",
  field_locked: "your role can't edit that field",
  not_owned: "the workspace doesn't let modules change that field",
  invalid_value: "not a valid value for that field",
};

/** What became of a proposal, in words. */
export function outcomeText(p: ProposalOutcome | undefined): string {
  if (!p) return "Not proposed";
  if (p.rejected.length) return `Not stored: ${REJECTED[p.rejected[0]!.reason] ?? p.rejected[0]!.reason}`;
  if (p.unchanged) return "Already proposed with this value";
  if (p.pending) return "Waiting for review";
  if (p.applied) return "Accepted";
  if (p.skipped) return "Rejected by a reviewer";
  return p.status;
}

export const calls: CallFunctions = {
  stale(ctx, reads) {
    const deals = reads.deals as Deal[];
    const names = new Map<string, string>([
      ...deals.map((d): [string, string] => [d.id, d.name ?? d.id]),
      ...deals.flatMap((d): Array<[string, string]> => (d.companyId ? [[d.companyId, d.companyName ?? d.companyId]] : [])),
      ...(reads.companies as Company[]).map((c): [string, string] => [c.id, c.name ?? c.id]),
    ]);
    const rows = staleRows(ctx.now, names, [
      { object: "deals", rows: reads.dealFacts as FactsForRecordsRow[] },
      { object: "companies", rows: reads.dealCompanyFacts as FactsForRecordsRow[] },
      { object: "companies", rows: reads.watchedFacts as FactsForRecordsRow[] },
    ]);
    const message = "No deals close between 30 days ago and 90 days from now, and you watch no companies.";
    return { value: { rows, message } };
  },
  propose(ctx) {
    return { intents: proposeIntents(ctx, ctx.args as ProposeArgs), value: "Sent for review. Its outcome shows under Corrections: a member who reviews facts accepts or rejects it." };
  },
  outcomes(_ctx, reads) {
    const byId = new Map((reads.proposals as ProposalOutcome[]).map((p) => [p.id, p]));
    const rows = (reads.corrections as ReadDoc[]).map((d) => {
      const p = byId.get(String(d.data.proposal));
      const counts = p ? { status: p.status, pending: p.pending, applied: p.applied, skipped: p.skipped, unchanged: p.unchanged, rejected: p.rejected } : {};
      return { ...d.data, ...counts, outcome: outcomeText(p) };
    });
    return { value: { rows } };
  },
};
