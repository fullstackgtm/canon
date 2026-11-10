/**
 * An account against saved ICP gates (lib/icps.ts specGate), as the record
 * service scores it in SQL (services/record-service upsert.ts refitSql): in a
 * gate only when it passes every criterion, fit = its best rank inside the
 * gates it passes, 0 outside them. The fake client and score history use this.
 * Dependency-free.
 */
import type { IcpGate, IcpTreeAccount, IcpTreeCounts, IcpTreeNode, IcpTreePerson } from "./recordContract.ts";
import { industryWeight, sameIndustry } from "../../services/record-service/src/industries.ts";
import { DEPARTMENT, SENIORITY, classifyTitle } from "../../services/record-service/src/titles.ts";
import { passes } from "../../services/record-service/src/territoryTree.ts";

/** `titles` are the job titles of the account's live contacts; without them the buyer isn't checked (score history). */
export type GateRow = { industry?: string; country?: string; employees?: number; custom?: Record<string, unknown>; titles?: readonly string[] };

/** A contact with this title is the gate's buyer (record service upsert.ts gateBuyers). */
export function isBuyer(title: string, buyer: NonNullable<IcpGate["buyer"]>): boolean {
  const t = title.toLowerCase();
  if (!t || buyer.exclude.some((x) => t.includes(x))) return false;
  if (buyer.titles.some((x) => t.includes(x))) return true;
  if (!buyer.levels.includes(classifyTitle(SENIORITY, t) ?? "")) return false;
  if (!buyer.departments.length && !buyer.topics.length) return true;
  return buyer.departments.includes(classifyTitle(DEPARTMENT, t)?.toLowerCase() ?? "") || buyer.topics.some((x) => t.includes(x));
}
/** pass, fail, or unknown: only when `customKnown` is false and the custom criteria are all that's left. */
type GateResult = { kind: "pass"; fit: number } | { kind: "fail" } | { kind: "unknown" };

function gateResult(row: GateRow, g: IcpGate, customKnown: boolean): GateResult {
  const weight = (set: Record<string, number>, value: string | undefined) => {
    const keys = Object.keys(set);
    if (!keys.length) return 0;
    const hit = value ? keys.find((k) => k.toLowerCase() === value.toLowerCase()) : undefined;
    return hit === undefined ? null : set[hit];
  };
  const industry = Object.keys(g.industries).length ? industryWeight(g.industries, row.industry) ?? null : 0;
  const country = weight(g.countries, row.country);
  const bands = g.employees.filter((b) => row.employees !== undefined && row.employees >= b.min && row.employees <= b.max);
  if (industry === null || country === null || (g.employees.length && !bands.length)) return { kind: "fail" };
  const lower = (v: string | undefined) => (v ?? "").toLowerCase();
  if (g.excludeIndustries.some((x) => sameIndustry(x, row.industry))) return { kind: "fail" };
  if (g.excludeCountries.some((x) => x.toLowerCase() === lower(row.country) && row.country)) return { kind: "fail" };
  if (g.custom.length && !customKnown) return { kind: "unknown" };
  for (const c of g.custom) {
    const raw = row.custom?.[c.key];
    if (raw === undefined || raw === null) return { kind: "fail" };
    const text = String(raw).toLowerCase();
    const ok = c.values ? c.values.includes(text) : Number.isFinite(Number(raw)) && Number(raw) >= (c.min ?? -Infinity) && Number(raw) <= (c.max ?? Infinity);
    if (!ok) return { kind: "fail" };
  }
  if (g.buyer && row.titles && !row.titles.some((t) => isBuyer(t, g.buyer!))) return { kind: "fail" };
  const points = g.base + industry + country + (bands.length ? Math.max(...bands.map((b) => b.weight)) : 0);
  return { kind: "pass", fit: Math.round((100 * points) / g.max) };
}

/**
 * Fit (0..1) and the ICPs an account passes, as the record service computes them.
 * With `customKnown` false (score history, which has no AI-field answers as of a
 * date), a gate decided only by its AI-field criteria leaves the fit unknown.
 */
export function gatedFit(row: GateRow, gates: readonly IcpGate[], customKnown = true): { fit: number; icpIds: string[] } | { unknown: true } {
  let best = 0;
  const icpIds: string[] = [];
  let unknown = false;
  for (const g of gates) {
    const r = gateResult(row, g, customKnown);
    if (r.kind === "pass") {
      best = Math.max(best, r.fit);
      icpIds.push(g.id);
    } else if (r.kind === "unknown") unknown = true;
  }
  if (unknown && !icpIds.length) return { unknown: true };
  return { fit: Math.min(100, best) / 100, icpIds: icpIds.sort() };
}

type TreeAccountRow = { id: string; industry?: string; country?: string; employees?: number; city?: string; ownerId?: string; annualRevenue?: number; custom?: Record<string, unknown> };
type TreeContactRow = { accountId?: string; title?: string };

/** A contact matches an ICP tree person criterion (record service icpTree.ts personSql). */
export function matchesPerson(title: string, p: IcpTreePerson): boolean {
  const t = title.toLowerCase();
  if (!t || p.exclude.some((x) => t.includes(x))) return false;
  if (p.titles.some((x) => t.includes(x))) return true;
  const topics = p.topics ?? [];
  if (!p.levels.length && !p.departments.length && !topics.length) return !p.titles.length;
  const level = !p.levels.length || p.levels.includes(classifyTitle(SENIORITY, t) ?? "");
  const department = (!p.departments.length && !topics.length)
    || p.departments.includes(classifyTitle(DEPARTMENT, t)?.toLowerCase() ?? "") || topics.some((x) => t.includes(x));
  return level && department;
}

function passesAccount(row: TreeAccountRow, x: IcpTreeAccount): boolean {
  const { custom: _custom, ...company } = x;
  if (!passes(row, company)) return false;
  for (const c of x.custom ?? []) {
    const raw = row.custom?.[c.key];
    if (raw === undefined || raw === null) return false;
    const ok = c.values ? c.values.map((v) => v.toLowerCase()).includes(String(raw).toLowerCase()) : Number.isFinite(Number(raw)) && Number(raw) >= (c.min ?? -Infinity) && Number(raw) <= (c.max ?? Infinity);
    if (!ok) return false;
  }
  return true;
}

/** An ICP tree's counts over rows in memory, as the record service counts them (contract 1.31.0): the fake client and tests. */
export function countIcpTree(accounts: readonly TreeAccountRow[], contacts: readonly TreeContactRow[], nodes: readonly IcpTreeNode[]): IcpTreeCounts {
  const titles = new Map<string, string[]>();
  for (const c of contacts) if (c.accountId && c.title) titles.set(c.accountId, [...(titles.get(c.accountId) ?? []), c.title]);
  const sets = new Map<string, Set<string>>();
  const out: IcpTreeCounts = { nodes: [], overlaps: [] };
  for (const n of nodes) {
    const base = n.parent !== undefined ? accounts.filter((a) => sets.get(n.parent!)?.has(a.id)) : accounts;
    if (n.person) {
      const person = n.person;
      const hits = base.map((a) => [a.id, (titles.get(a.id) ?? []).filter((t) => matchesPerson(t, person)).length] as const).filter(([, k]) => k > 0);
      sets.set(n.id, new Set(hits.map(([id]) => id)));
      out.nodes.push({ id: n.id, accounts: hits.length, people: hits.reduce((s, [, k]) => s + k, 0) });
      continue;
    }
    const ids = base.filter((a) => passesAccount(a, n.account ?? {})
      && (n.has ?? []).every((h) => (titles.get(a.id) ?? []).some((t) => matchesPerson(t, h.person)) !== Boolean(h.neg))).map((a) => a.id);
    sets.set(n.id, new Set(ids));
    out.nodes.push({ id: n.id, accounts: ids.length, people: 0 });
  }
  nodes.forEach((a, i) => nodes.forEach((b, j) => {
    if (j > i && a.parent === b.parent) out.overlaps.push({ a: a.id, b: b.id, accounts: [...sets.get(a.id)!].filter((id) => sets.get(b.id)!.has(id)).length });
  }));
  return out;
}
