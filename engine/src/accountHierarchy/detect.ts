/**
 * Stage 1, detect: org-wide candidate groups of accounts that may be duplicates or sit in the wrong place in a
 * corporate family. Read-only and deterministic. Signals:
 *   - a shared website domain;
 *   - the same name once legal suffixes are dropped (country words are kept);
 *   - an enrichment vendor's ultimate parent that names a top-level account the record isn't under (a lead only:
 *     vendors lag divestitures);
 *   - membership in a bulk-created shell batch (sorts the group first).
 * A group is a question for research, not a finding: sharing a parent or a domain never proves a duplicate.
 */
import type { CanonicalAccount, CanonicalGtmSnapshot } from "../types.ts";
import { accountParentId } from "../accountFamily.ts";
import { createdDate, domainOf, normName, rawString } from "./normalize.ts";
import type { HierarchyPolicy } from "./policy.ts";

export type CandidateGroup = {
  /** Stable id: the lowest account id in the group. */
  id: string;
  accountIds: string[];
  names: string[];
  reasons: string[];
  shellIds: string[];
};

export type DetectReport = {
  generatedAt: string;
  provider: string;
  accounts: number;
  groups: CandidateGroup[];
};

export function isShell(account: CanonicalAccount, policy: HierarchyPolicy, userNames: Map<string, string>): boolean {
  const day = createdDate(account)?.slice(0, 10);
  if (!day) return false;
  const creator =
    rawString(account, "CreatedBy.Name") ?? userNames.get(rawString(account, "CreatedById") ?? "") ?? undefined;
  return policy.shellBatches.some((b) => b.createdDate === day && b.createdByName === creator);
}

export function accountDomain(account: CanonicalAccount, policy: HierarchyPolicy): string | null {
  return domainOf(account.domain, new Set(policy.ignoredDomains));
}

/** The top of an account's parent chain, guarding against cycles and missing parents. */
export function topOf(id: string, parentOf: (id: string) => string | undefined): string {
  const seen = new Set<string>();
  let cursor = id;
  for (;;) {
    const p = parentOf(cursor);
    if (!p || seen.has(p)) return cursor;
    seen.add(cursor);
    cursor = p;
  }
}

export function detectCandidateGroups(snapshot: CanonicalGtmSnapshot, policy: HierarchyPolicy): DetectReport {
  const byId = new Map(snapshot.accounts.map((a) => [String(a.id), a]));
  const userNames = new Map(snapshot.users.map((u) => [String(u.id), u.name]));
  const uf = new Map<string, string>([...byId.keys()].map((id) => [id, id]));
  const reasons = new Map<string, Set<string>>();
  const find = (i: string): string => {
    let r = i;
    while (uf.get(r) !== r) r = uf.get(r)!;
    while (uf.get(i) !== r) {
      const next = uf.get(i)!;
      uf.set(i, r);
      i = next;
    }
    return r;
  };
  const join = (ids: string[], why: string) => {
    for (const i of ids.slice(1)) uf.set(find(i), find(ids[0]));
    for (const i of ids) {
      if (!reasons.has(i)) reasons.set(i, new Set());
      reasons.get(i)!.add(why);
    }
  };

  const byDomain = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const a of byId.values()) {
    const d = accountDomain(a, policy);
    if (d) byDomain.set(d, [...(byDomain.get(d) ?? []), String(a.id)]);
    const n = normName(a.name);
    if (n.length >= 3) byName.set(n, [...(byName.get(n) ?? []), String(a.id)]);
  }
  for (const [d, ids] of byDomain) if (ids.length > 1) join(ids, `same domain ${d}`);
  for (const [n, ids] of byName) if (ids.length > 1) join(ids, `same name "${n}"`);

  if (policy.ultimateParentField) {
    const parentOf = (id: string) => {
      const p = byId.get(id) ? accountParentId(byId.get(id)!) : undefined;
      return p && byId.has(p) ? p : undefined;
    };
    // Top-level accounts by normalized name. A vendor name matches a top account exactly, or as the leading words of
    // a longer name ("lvmh" -> "lvmh moet hennessy louis vuitton").
    const tops = [...byId.values()].filter((a) => !parentOf(String(a.id)));
    const topByName = new Map(tops.map((a) => [normName(a.name), String(a.id)]));
    const sortedTopNames = [...topByName.keys()].sort();
    for (const a of byId.values()) {
      const vendorName = rawString(a, policy.ultimateParentField);
      const vendor = normName(vendorName);
      if (!vendor) continue;
      const target = topByName.get(vendor) ?? (vendor.length >= 4 ? lookupPrefix(sortedTopNames, vendor, topByName) : undefined);
      const id = String(a.id);
      if (target && target !== id && target !== topOf(id, parentOf)) join([target, id], `enrichment ultimate parent "${vendorName}"`);
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of byId.keys()) {
    if (!reasons.has(id)) continue;
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  const out: CandidateGroup[] = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const sorted = ids.sort();
    out.push({
      id: sorted[0],
      accountIds: sorted,
      names: sorted.map((i) => byId.get(i)!.name).sort(),
      reasons: [...new Set(sorted.flatMap((i) => [...(reasons.get(i) ?? [])]))].sort(),
      shellIds: sorted.filter((i) => isShell(byId.get(i)!, policy, userNames)),
    });
  }
  out.sort((a, b) => b.shellIds.length - a.shellIds.length || b.accountIds.length - a.accountIds.length || a.id.localeCompare(b.id));
  return { generatedAt: snapshot.generatedAt, provider: snapshot.provider, accounts: byId.size, groups: out };
}

function lookupPrefix(sortedNames: string[], vendor: string, byName: Map<string, string>): string | undefined {
  const hit = sortedNames.find((n) => n.startsWith(`${vendor} `));
  return hit ? byName.get(hit) : undefined;
}

export function detectToText(report: DetectReport, limit = 80): string {
  const shells = report.groups.filter((g) => g.shellIds.length).length;
  const lines = [`${report.groups.length} candidate groups across ${report.accounts} accounts, ${shells} with a bulk-created shell`];
  for (const g of report.groups.slice(0, limit)) {
    lines.push(
      `  ${String(g.accountIds.length).padStart(3)} ${g.shellIds.length ? "SHELL " : "      "}${g.names.join(" | ").slice(0, 110)}  [${g.reasons.join("; ").slice(0, 80)}]`,
    );
  }
  return lines.join("\n");
}
