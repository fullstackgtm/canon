/**
 * Customer success (docs/module-plans/customer-success.md): each customer's ARR from its closed-won recurring deals,
 * and NRR and GRR over a period. The arithmetic is engine/, golden-tested; this file reads, shapes and writes.
 */
import type { CallFunctions, Intent, ReadDoc, RecordChange } from "../../kernel/calls.ts";
import { accountOf, addDays, ledger, type Assumption, type Deal, type Line, type SkipWhy } from "./engine/contracts.ts";
import { growCalls } from "./grow.ts";
import { companiesOver, monthly, retention } from "./engine/retention.ts";

const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const ASSUMED: Record<Assumption, string> = {
  arr_from_amount: "No ARR on the deal: its amount is used",
  length_assumed: "No contract length: 12 months assumed",
  renews_nothing: "A renewal of no contract Canon has",
};
const SKIPPED: Record<SkipWhy, string> = {
  no_company: "No company on the deal: not counted",
  no_arr: "No ARR or amount: not counted",
  no_close_date: "No close date: not counted",
};
const SEGMENT: Record<string, string> = { enterprise: "Enterprise", mid: "Mid-market", smb: "SMB" };

export const calls: CallFunctions = {
  ...growCalls,
  /** The deal feed: a deal's old and new company have their contracts rebuilt. */
  onDeals(ctx) {
    const keys = new Set<string>();
    for (const c of ctx.args.changes as RecordChange[]) {
      for (const side of [c.before, c.after]) if (typeof side?.companyId === "string" && side.companyId) keys.add(side.companyId);
    }
    return { intents: [...keys].map((key): Intent => ({ op: "dirty", job: "contracts", key })) };
  },

  /**
   * Every customer's contracts rebuilt, daily and on install (the feed sees only later changes): ARR moves when a
   * contract ends with no deal changing, and a deal's ARR and length aren't on the feed.
   */
  sweep(_ctx, reads) {
    const keys = new Set<string>();
    for (const d of reads.deals as Deal[]) if (d.isWon && d.companyId) keys.add(d.companyId);
    for (const a of reads.accounts as ReadDoc[]) keys.add(a.key);
    return { intents: [...keys].map((key): Intent => ({ op: "dirty", job: "contracts", key })) };
  },

  /**
   * The contracts job: each company's contract lines from its won recurring deals (engine ledger), and its account's
   * ARR, next renewal and newest deal. A new account starts with the newest deal's owner as its CSM; after that the
   * CSM and segment are a person's, and the contracts follow the account's CSM.
   */
  rebuild(ctx, reads) {
    const keys = ctx.args.keys as string[];
    const wanted = new Set(keys);
    const deals = (reads.deals as Deal[]).filter((d) => d.companyId && wanted.has(d.companyId));
    const { lines } = ledger(deals);
    const accounts = new Map((reads.accounts as ReadDoc[]).map((a) => [a.key, a]));
    const contracts = reads.contracts as ReadDoc[];
    const names = new Map((reads.companies as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
    const day = today(ctx.now);
    const byKey: Record<string, Intent[]> = {};
    for (const company of keys) {
      const out: Intent[] = (byKey[company] = []);
      const mine = lines.filter((l) => l.company === company);
      const existing = accounts.get(company);
      if (!mine.length && !existing) continue;
      const a = accountOf(mine, day);
      const name = names.get(company) ?? (existing?.data.companyName as string | undefined) ?? null;
      const facts: Record<string, unknown> = { arr: a.arr, contracts: mine.length, ...(name ? { companyName: name } : {}), ...(a.renewalOn ? { renewalOn: a.renewalOn } : {}), ...(a.since ? { since: a.since } : {}), ...(a.lastDeal ? { lastDeal: a.lastDeal } : {}) };
      const csm = existing ? ((existing.data.csm as string | undefined) ?? null) : a.lastOwner;
      if (!existing) {
        out.push({ op: "put", collection: "accounts", key: company, data: { company, ...facts, ...(csm ? { csm } : {}) }, expect: [{ collection: "accounts", key: company, version: null }] });
      } else {
        const changed = Object.entries(facts).some(([k, v]) => existing.data[k] !== v);
        const unset = (["renewalOn", "since", "lastDeal"] as const).filter((k) => !(k in facts) && existing.data[k] !== undefined);
        if (changed || unset.length) out.push({ op: "patch", collection: "accounts", key: company, data: facts, ...(unset.length ? { unset } : {}), expect: [{ collection: "accounts", key: company, version: existing.version }] });
      }
      const had = new Map(contracts.filter((c) => c.data.account === company).map((c) => [c.key, c]));
      for (const l of mine) {
        const data = contractData(l, csm);
        const doc = had.get(l.deal);
        had.delete(l.deal);
        if (doc && same(doc.data, data)) continue;
        out.push({ op: "put", collection: "contracts", key: l.deal, parentKey: company, data, expect: [{ collection: "contracts", key: l.deal, version: doc?.version ?? null }] });
      }
      for (const doc of had.values()) out.push({ op: "delete", collection: "contracts", key: doc.key, expect: [{ collection: "contracts", key: doc.key, version: doc.version }] });
    }
    return { byKey };
  },

  /**
   * Retention for a period (engine retention) over the contracts the caller reads, the ledger the contracts job keeps,
   * so a CSM's Retention covers the same accounts as their Portfolio whoever owns the deals: the cohort's start and end
   * ARR, NRR, GRR, churn, contraction and expansion, by segment and by CSM, NRR and GRR month by month, the new logos
   * apart, the steps from starting to ending ARR, and the deals guessed at or left out. An end after today reads the
   * contracts booked to run then.
   */
  retention(ctx, reads) {
    const from = String(ctx.args.from), to = String(ctx.args.to);
    if (from > to) throw new Error(`The period starts after it ends (${from} to ${to}).`);
    const lines = (reads.contracts as ReadDoc[]).map(lineOf);
    // The deals only say what the ledger left out: a won deal with no company, ARR or close date has no contract.
    const { skipped } = ledger(reads.deals as Deal[]);
    const accounts = new Map((reads.accounts as ReadDoc[]).map((a) => [a.key, a]));
    const users = new Map((reads.users as Array<{ id: string; name?: string }>).map((u) => [u.id, u.name ?? u.id]));
    const companyName = (c: string) => (accounts.get(c)?.data.companyName as string | undefined) ?? c;
    const segmentOf = (c: string) => SEGMENT[String(accounts.get(c)?.data.segment)] ?? "No segment";
    const csmOf = (c: string) => (accounts.get(c)?.data.csm as string | undefined) ?? null;
    const r = retention(lines, from, to);
    const bySegment = retention(lines, from, to, segmentOf).groups;
    const byCsm = retention(lines, from, to, (c) => csmOf(c) ?? "").groups;
    const groups = [
      ...[...bySegment].map(([g, t]) => ({ by: "Segment", label: g, ...t })),
      ...[...byCsm].map(([g, t]) => ({ by: "CSM", label: g ? users.get(g) ?? g : "No CSM", ...t })),
    ];
    const OUTCOME: Record<string, string> = { churned: "Churned", contracted: "Contracted", expanded: "Expanded", flat: "Renewed flat", new: "New logo" };
    const rows = companiesOver(lines, from, to).map((c) => ({
      company: c.company, name: companyName(c.company), segment: segmentOf(c.company), csm: csmOf(c.company),
      startArr: c.start, endArr: c.end, change: c.end - c.start, outcome: OUTCOME[c.outcome], inCohort: c.outcome !== "new",
    }));
    // Only what moves this period's numbers: a line counted at its start or its end, or a deal left out that would be.
    const edges = [addDays(from, -1), to];
    const counted = (l: Pick<Line, "start" | "until">) => edges.some((d) => l.start <= d && d < l.until);
    const notes = [
      ...(reads.contracts as ReadDoc[]).filter((c) => c.data.note && counted(lineOf(c))).map((c) => ({ deal: String(c.data.deal), name: String(c.data.dealName), company: companyName(String(c.data.account)), note: String(c.data.note), kind: "Guessed" })),
      ...skipped.filter((s) => s.closeDate && s.closeDate <= to && s.closeDate > addDays(from, -366)).map((s) => ({ deal: s.deal, name: s.dealName, company: s.company ? companyName(s.company) : "No company", note: SKIPPED[s.why], kind: "Left out" })),
    ];
    return { value: {
      from, to, ...r.total, newLogoArr: r.newLogoArr,
      newLogos: r.newLogos.map((n) => ({ company: n.company, name: companyName(n.company), arr: n.arr, csm: csmOf(n.company) })),
      groups, rows,
      // The cohort's walk from starting to ending ARR, for the page's waterfall: start − churn − contraction + expansion = end.
      bridge: [{ step: "Churn", amount: -r.total.churn }, { step: "Contraction", amount: -r.total.contraction }, { step: "Expansion", amount: r.total.expansion }],
      monthly: monthly(lines, from, to).flatMap((m) => [{ month: m.month, metric: "NRR", value: m.nrr ?? 0 }, { month: m.month, metric: "GRR", value: m.grr ?? 0 }]),
      notes, noteCount: notes.length,
    } };
  },
};

/** A stored contract as the engine's line. */
const lineOf = (c: ReadDoc): Line => ({
  deal: String(c.data.deal), dealName: String(c.data.dealName), company: String(c.data.account), kind: c.data.kind as Line["kind"],
  start: String(c.data.start), end: String(c.data.end), until: String(c.data.until), arr: Number(c.data.arr), owner: (c.data.csm as string | undefined) ?? null,
  renews: [], renewedArr: (c.data.renewedArr as number | undefined) ?? null, assumed: [],
});

function contractData(l: Line, csm: string | null) {
  return {
    deal: l.deal, dealName: l.dealName, account: l.company, kind: l.kind, start: l.start, end: l.end, until: l.until, arr: l.arr,
    ...(l.renewedArr !== null ? { renewedArr: l.renewedArr } : {}),
    ...(l.assumed.length ? { note: l.assumed.map((x) => ASSUMED[x]).join(" · ") } : {}),
    ...(csm ? { csm } : {}),
  };
}
const same = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => k !== "status"));
  return [...keys].every((k) => a[k] === b[k]);
};
