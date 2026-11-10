/**
 * Stage 3, plan: turn one group's verified research and the CRM snapshot into proposed changes. Nothing here
 * writes. `toPatchPlan` hands the result to the engine's ordinary approval and apply path (HMAC-signed approval,
 * compare-and-set on every written field, all-or-nothing groups), the same path `dedupe` and `bulk-update` use.
 *
 * Proposals, in apply order:
 *   1. merges: duplicates inside the family by domain or normalized name, with a ranked survivor. The survivor
 *      keeps its values; only its blank fillable fields are filled from the duplicate, and never the owner.
 *   2. parent moves: from research, evaluated after the merges (a merged account's children follow its survivor).
 *   3. field fixes: researched facts, then region from country.
 * Plus flags (for a person, never applied) and suggestions (listed, never proposed).
 *
 * Hard rules from the workspace policy: owners never change (account or deal), active contracts are flagged on
 * every item that touches them, and a claim produces an operation only when a citation passed the verbatim gate.
 */
import { stableHash } from "../rules.ts";
import { accountParentId } from "../accountFamily.ts";
import type { CanonicalAccount, CanonicalDeal, CanonicalGtmSnapshot, GtmEvidence, PatchOperation, PatchPlan } from "../types.ts";
import { accountDomain, isShell, topOf } from "./detect.ts";
import { accountValue, createdDate, isJunkName, normName, rawString } from "./normalize.ts";
import type { HierarchyPolicy } from "./policy.ts";
import { citationKey, passing, type Citation, type GroupResearch, type ResearchVerification } from "./research.ts";

export type DomainRoute = { domain: string; accountId: string; routesTo: string | null };

export type MergeItem = {
  op: "merge";
  survivorId: string;
  loserId: string;
  fill: Record<string, string>;
  why: string;
  moves: string;
  warn: string[];
  key: string;
};
export type ParentItem = {
  op: "set_parent";
  accountId: string;
  from: string | null;
  to: string | null;
  why: string;
  citations: Citation[];
  warn: string[];
  key: string;
};
export type FieldItem = {
  op: "set_fields";
  accountId: string;
  fields: Record<string, string>;
  expect: Record<string, string | null>;
  why: string;
  citations: Citation[];
  warn: string[];
  key: string;
};
export type HierarchyItem = MergeItem | ParentItem | FieldItem;

export type HierarchyProposal = {
  group: string;
  rootId: string;
  today: string;
  accounts: Map<string, CanonicalAccount>;
  items: HierarchyItem[];
  flags: string[];
  hints: string[];
  research: GroupResearch;
  verification: ResearchVerification;
  policy: HierarchyPolicy;
};

const US_NAME = /\b(usa|u\.s\.|us|north america|americas)\b/i;

export function buildHierarchyProposal(input: {
  snapshot: CanonicalGtmSnapshot;
  research: GroupResearch;
  verification: ResearchVerification;
  policy: HierarchyPolicy;
  routes?: DomainRoute[];
  today?: string;
  /** Vendor ultimate-parent names that put an account in this family (default: the group name). */
  vendorParentNames?: string[];
}): HierarchyProposal {
  const { snapshot, research, verification, policy } = input;
  const today = input.today ?? snapshot.generatedAt.slice(0, 10);
  const all = new Map(snapshot.accounts.map((a) => [String(a.id), a]));
  const users = new Map(snapshot.users.map((u) => [String(u.id), u]));
  const userNames = new Map(snapshot.users.map((u) => [String(u.id), u.name]));
  const root = research.ultimateParent.accountId;
  if (!all.has(root)) throw new Error(`ultimate parent account ${root} is not in the snapshot`);

  // ---- the family: root and its descendants, researched accounts, vendor-named members, and look-alikes
  const childrenOf = new Map<string, string[]>();
  for (const a of all.values()) {
    const p = accountParentId(a);
    if (p) childrenOf.set(p, [...(childrenOf.get(p) ?? []), String(a.id)]);
  }
  const ids = new Set<string>([root, ...research.entities.flatMap((e) => e.accountIds).filter((i) => all.has(i))]);
  if (policy.ultimateParentField) {
    const vendor = new Set((input.vendorParentNames ?? [research.group]).map(normName));
    for (const a of all.values()) if (vendor.has(normName(rawString(a, policy.ultimateParentField)))) ids.add(String(a.id));
  }
  const addDescendants = () => {
    const stack = [...ids];
    while (stack.length) {
      for (const c of childrenOf.get(stack.pop()!) ?? []) {
        if (ids.has(c)) continue;
        ids.add(c);
        stack.push(c);
      }
    }
  };
  addDescendants();
  const domains = new Set([...ids].map((i) => accountDomain(all.get(i)!, policy)).filter(Boolean));
  const names = new Set([...ids].map((i) => normName(all.get(i)!.name)).filter(Boolean));
  for (const a of all.values()) {
    const d = accountDomain(a, policy);
    if ((d && domains.has(d)) || names.has(normName(a.name))) ids.add(String(a.id));
  }
  addDescendants();
  const accts = new Map([...ids].map((i) => [i, all.get(i)!]));

  // ---- related records
  const contacts = new Map<string, number>();
  for (const c of snapshot.contacts) if (c.accountId && ids.has(c.accountId)) contacts.set(c.accountId, (contacts.get(c.accountId) ?? 0) + 1);
  const deals = new Map<string, CanonicalDeal[]>();
  for (const d of snapshot.deals) if (d.accountId && ids.has(d.accountId)) deals.set(d.accountId, [...(deals.get(d.accountId) ?? []), d]);
  const endField = policy.activeContract?.endDateField;
  const active = new Map<string, CanonicalDeal[]>();
  if (endField) {
    for (const [i, list] of deals) {
      const live = list.filter((d) => d.isWon && (rawString(d, endField) ?? "") > today);
      if (live.length) active.set(i, live);
    }
  }
  const contractEnd = (i: string) => (active.get(i) ?? []).map((d) => rawString(d, endField!) ?? "").sort().at(-1);
  const owner = (a: CanonicalAccount) => (a.ownerId ? users.get(a.ownerId) : undefined);
  const ownerName = (a: CanonicalAccount) => owner(a)?.name ?? "no owner";
  const shell = (a: CanonicalAccount) => isShell(a, policy, userNames);
  const statusRank = (a: CanonicalAccount) => {
    if (!policy.customerStatus) return 0;
    const v = accountValue(a, policy.customerStatus.field);
    const i = v ? policy.customerStatus.rank.indexOf(v) : -1;
    return i < 0 ? 0 : policy.customerStatus.rank.length - i;
  };
  const survivorKey = (i: string): Array<number> => {
    const a = accts.get(i)!;
    const ds = deals.get(i) ?? [];
    return [
      active.has(i) ? 1 : 0,
      statusRank(a),
      isJunkName(a.name) ? 0 : 1,
      shell(a) ? 0 : 1,
      ds.filter((d) => d.isWon).length,
      (contacts.get(i) ?? 0) + ds.length,
      -Number((createdDate(a) ?? "9999-12-31").slice(0, 10).replace(/-/g, "")),
    ];
  };
  const byKey = (a: string, b: string) => {
    const ka = survivorKey(a);
    const kb = survivorKey(b);
    for (let n = 0; n < ka.length; n++) if (ka[n] !== kb[n]) return kb[n] - ka[n];
    return a.localeCompare(b);
  };

  const flags: string[] = [];
  const items: HierarchyItem[] = [];
  const nm = (i: string | null | undefined) => (i ? accts.get(i)?.name ?? all.get(i)?.name ?? i : "none");

  // ---- 1. merges. Two accounts the research names as different entities are never duplicates, even when they
  // share a domain (Dior and Parfums Christian Dior on dior.com).
  const entityOf = new Map<string, string>();
  for (const e of research.entities) for (const i of e.accountIds) entityOf.set(i, e.name);
  const distinct = (a: string, b: string) => entityOf.has(a) && entityOf.has(b) && entityOf.get(a) !== entityOf.get(b);
  const clusters = mergeClusters([...accts.keys()], (i) => [accountDomain(accts.get(i)!, policy), normName(accts.get(i)!.name) || null], distinct);
  const survivorOf = new Map<string, string>();
  for (const cluster of clusters) {
    const ranked = [...cluster].sort(byKey);
    if (policy.rules.holdMergeOfTwoActiveContracts && ranked.filter((i) => active.has(i)).length > 1) {
      flags.push(`${ranked.map(nm).join(", ")}: more than one duplicate has an active contract; merge held for a person to decide.`);
      continue;
    }
    for (const loser of ranked.slice(1)) survivorOf.set(loser, ranked[0]);
  }
  const live = (i: string) => survivorOf.get(i) ?? i;
  const parentNow = (i: string) => {
    const p = accountParentId(accts.get(i) ?? all.get(i)!);
    return p && (accts.has(p) || all.has(p)) ? p : undefined;
  };
  const parentAfter = (i: string) => {
    const p = parentNow(i);
    return p ? live(p) : undefined;
  };
  const topAfter = (i: string) => topOf(i, parentAfter);

  for (const [loser, s] of survivorOf) {
    const a = accts.get(loser)!;
    const b = accts.get(s)!;
    const fill: Record<string, string> = {};
    for (const f of policy.fillableFields) {
      const av = accountValue(a, f);
      if (av && !accountValue(b, f)) fill[f] = av;
    }
    const warn: string[] = [];
    if (policy.rules.flagActiveContracts && active.has(loser)) warn.push(`ACTIVE CONTRACT on the account being merged away (ends ${contractEnd(loser)})`);
    if (policy.rules.flagActiveContracts && active.has(s)) warn.push(`ACTIVE CONTRACT on the survivor (ends ${contractEnd(s)})`);
    const so = owner(b);
    if (!so || so.active === false || policy.poolOwnerNames.includes(so.name)) {
      warn.push(`survivor owner ${ownerName(b)} is ${so && so.active !== false ? "a pool user" : "inactive or missing"}: routing should assign an owner before this merge`);
    }
    const moving = deals.get(loser) ?? [];
    const pa = parentAfter(loser) ?? null;
    const pb = parentAfter(s) ?? null;
    const why = [mergeWhy(a, b, policy, shell)];
    if (pa !== pb) why.push(`${a.name}'s parent (${nm(pa)}) is dropped, the survivor keeps ${pb ? nm(pb) : "no parent"}`);
    items.push({
      op: "merge",
      survivorId: s,
      loserId: loser,
      fill,
      warn,
      why: why.join("; "),
      moves:
        `${contacts.get(loser) ?? 0} contact(s), ${moving.length} deal(s)` +
        (moving.length ? ` (${moving.map((d) => `${d.name} [${d.ownerId ? users.get(d.ownerId)?.name ?? d.ownerId : "no owner"}]`).join("; ")}, owners unchanged)` : ""),
      key: `ah:merge:${loser}`,
    });
  }

  // ---- 2. parent moves from verified research
  const byName = new Map(research.entities.map((e) => [e.name, e]));
  const researched = new Set<string>();
  // Parents as they will be once the merges and the moves proposed so far apply: two research claims that put A
  // under B and B under A must not both become moves.
  const proposedParent = new Map<string, string | null>();
  const parentPlanned = (i: string) => (proposedParent.has(i) ? (proposedParent.get(i) ?? undefined) : parentAfter(i));
  const wouldCycle = (child: string, to: string | null) => {
    for (let cur: string | undefined = to ?? undefined, n = 0; cur && n < 50; cur = parentPlanned(cur), n++) if (cur === child) return true;
    return false;
  };
  for (const e of research.entities) {
    if (!e.accountIds.length) flags.push(`${e.name}: no account in the CRM; none created (create it by hand if needed).`);
    let want: string | null | undefined = root;
    if (e.parent) {
      const pe = byName.get(e.parent);
      const pids = [...new Set((pe?.accountIds ?? []).filter((i) => accts.has(i)).map(live))];
      if (pids.length === 1) want = pids[0];
      else if (pids.length > 1) {
        want = undefined;
        flags.push(`${e.name}: research says its parent is ${e.parent}, which has ${pids.length} accounts (${pids.map(nm).join(", ")}); choose one by hand.`);
      } else flags.push(`${e.name}: research says its parent is ${e.parent}, which has no account; left under ${research.group}.`);
    }
    const cites = passing(e.citations, verification);
    for (const i of e.accountIds) {
      researched.add(i);
      if (survivorOf.has(i) || !accts.has(i) || i === root || want === undefined) continue;
      const a = accts.get(i)!;
      const current = parentAfter(i) ?? null;
      let move: { to: string | null; why: string } | undefined;
      if (e.status === "owned" && want !== root && current !== want) move = { to: want, why: `${e.name} sits under ${e.parent}` };
      else if (e.status === "owned" && want === root && topAfter(i) !== root) move = { to: root, why: `${e.name} is owned by ${research.group}` };
      else if ((e.status === "divested" || e.status === "not_owned") && topAfter(i) === root) move = { to: null, why: `${e.name} is no longer ${research.group}: ${e.ownerNow}` };
      else if (e.status === "sale_pending") flags.push(`${e.name}: sale reported but not completed; no change. Re-check next run (${e.citations[0]?.url}).`);
      if (!move) continue;
      const { to, why } = move;
      if (!cites.length) {
        flags.push(`${a.name}: research says "${why}", but no citation passed the verbatim check (${citationProblems(e.citations, verification)}); not proposed. Check it by hand.`);
        continue;
      }
      if (to && wouldCycle(i, to)) {
        flags.push(`${a.name}: moving under ${nm(to)} would create a parent cycle; not proposed.`);
        continue;
      }
      const warn = policy.rules.flagActiveContracts && active.has(i) ? [`ACTIVE CONTRACT on ${a.name} (ends ${contractEnd(i)})`] : [];
      proposedParent.set(i, to);
      items.push({ op: "set_parent", accountId: i, from: current, to, why, citations: cites, warn, key: `ah:parent:${i}:${to ?? "none"}` });
    }
  }
  for (const [i, a] of accts) {
    if (researched.has(i) || i === root || survivorOf.has(i)) continue;
    if (topAfter(i) === root) flags.push(`${a.name} sits under ${research.group} but isn't in the research: research it next run.`);
    else if (policy.ultimateParentField && rawString(a, policy.ultimateParentField)) {
      flags.push(`${a.name}: the enrichment vendor says its ultimate parent is ${rawString(a, policy.ultimateParentField)}, but it isn't under ${research.group} and isn't in the research: research it next run.`);
    }
  }

  // ---- 3. field fixes: researched facts first, then region from country
  const fillAfterMerge = (i: string) => Object.assign({}, ...items.filter((x): x is MergeItem => x.op === "merge" && x.survivorId === i).map((x) => x.fill));
  const fixed = new Set<string>();
  for (const e of research.entities) {
    if (e.status === "divested" || e.status === "not_owned") continue;
    for (const raw of e.accountIds) {
      const i = live(raw);
      if (!accts.has(i) || fixed.has(i)) continue;
      fixed.add(i);
      const a = accts.get(i)!;
      const merged = fillAfterMerge(i);
      const now = (f: string) => merged[f] ?? accountValue(a, f) ?? null;
      const want: Record<string, string> = {};
      const cites: Citation[] = [];
      for (const fact of e.facts ?? []) {
        if (now(fact.field) === fact.value) continue;
        const ok = passing(fact.citations, verification);
        if (!ok.length) {
          flags.push(`${a.name}: research says ${fact.field} = ${fact.value}, but no citation passed the verbatim check (${citationProblems(fact.citations, verification)}); not proposed.`);
          continue;
        }
        want[fact.field] = fact.value;
        cites.push(...ok);
      }
      if (policy.region) {
        const { countryField, regionField, byCountry } = policy.region;
        const country = want[countryField] ?? now(countryField);
        const region = country ? byCountry[country] : undefined;
        if (country && region && now(regionField) !== region && !want[regionField]) {
          if (US_NAME.test(a.name) && region !== "NA" && !want[countryField]) flags.push(`${a.name}: name says US/North America but the country is ${country}; region left alone.`);
          else want[regionField] = region;
        } else if (!country && !now(regionField)) flags.push(`${a.name}: no country or region.`);
      }
      if (!Object.keys(want).length) continue;
      const expect = Object.fromEntries(Object.keys(want).map((f) => [f, now(f)]));
      items.push({
        op: "set_fields",
        accountId: i,
        fields: want,
        expect,
        citations: cites,
        why: Object.entries(want).map(([f, v]) => `${f} ${expect[f] ?? "blank"} -> ${v}`).join(", "),
        warn: [],
        key: `ah:fields:${i}:${Object.entries(want).sort().map(([f, v]) => `${f}=${v}`).join(",")}`,
      });
    }
  }

  // ---- routing impact of each merge
  const routes = input.routes ?? [];
  for (const item of items) {
    if (item.op !== "merge") continue;
    const s = accts.get(item.survivorId)!;
    const top = accts.get(topAfter(item.survivorId)) ?? s;
    const loserRoutes = routes.filter((r) => r.accountId === item.loserId);
    const loserDomain = accountDomain(accts.get(item.loserId)!, policy);
    if (!routes.length && loserDomain && loserDomain !== accountDomain(s, policy)) {
      item.warn.push(`lead routing: ${loserDomain} identifies ${nm(item.loserId)} today; after the merge only the survivor's domain (${accountDomain(s, policy) ?? "none"}) is on the account`);
    }
    for (const r of loserRoutes) {
      const owners = [...accts.entries()]
        .filter(([i, a]) => !survivorOf.has(i) && accountDomain(a, policy) === r.domain)
        .map(([, a]) => a)
        .concat([top, s])
        .filter((a) => {
          const o = owner(a);
          return o && o.active !== false && !policy.poolOwnerNames.includes(o.name);
        });
      const after = owners.length
        ? `likely ${ownerName(owners[0])} (${owners[0].name} owner)`
        : "nobody: the survivor and its parent have no active seller owner, so the domain would drop to the round robin";
      item.warn.push(`lead routing: ${r.domain} routes to ${r.routesTo ?? "nobody"} via ${nm(r.accountId)} today; after: ${after}`);
    }
  }

  // ---- suggestions: deals on the root that name a brand with its own account (never proposed)
  const hints: string[] = [];
  const brands = research.entities.filter((e) => e.status === "owned" || e.status === "sale_pending");
  for (const d of deals.get(root) ?? []) {
    for (const e of brands) {
      const word = e.name.split(/\s+/)[0];
      const target = e.accountIds.find((i) => accts.has(i) && live(i) === i && i !== root);
      if (target && word.length >= 4 && d.name.toLowerCase().includes(word.toLowerCase())) {
        hints.push(`${d.name} (${d.stage ?? "?"}, ${d.closeDate ?? "?"}, ${d.ownerId ? users.get(d.ownerId)?.name ?? d.ownerId : "no owner"}) is on ${nm(root)}; it could move to ${nm(target)}. Not proposed: moving deals changes account reporting.`);
        break;
      }
    }
  }

  return { group: research.group, rootId: root, today, accounts: accts, items, flags, hints, research, verification, policy };
}

function mergeWhy(a: CanonicalAccount, b: CanonicalAccount, policy: HierarchyPolicy, shell: (a: CanonicalAccount) => boolean): string {
  const why: string[] = [];
  const da = accountDomain(a, policy);
  if (da && da === accountDomain(b, policy)) why.push(`same website domain ${da}`);
  if (normName(a.name) === normName(b.name)) why.push("same name");
  if (shell(a)) why.push(`${a.name} is a bulk-created shell`);
  if (isJunkName(a.name)) why.push(`${a.name} is a junk record (an email address as the name)`);
  return why.join("; ");
}

/** Union-find on shared keys, refusing to join two accounts `apart` says are distinct. */
function mergeClusters(ids: string[], keys: (i: string) => Array<string | null>, apart: (a: string, b: string) => boolean): string[][] {
  const parent = new Map(ids.map((i) => [i, i]));
  const members = new Map(ids.map((i) => [i, [i]]));
  const find = (i: string): string => (parent.get(i) === i ? i : find(parent.get(i)!));
  const sorted = [...ids].sort();
  const width = Math.max(0, ...sorted.map((i) => keys(i).length));
  for (let k = 0; k < width; k++) {
    const seen = new Map<string, string>();
    for (const i of sorted) {
      const key = keys(i)[k];
      if (!key) continue;
      const other = seen.get(key);
      if (!other) {
        seen.set(key, i);
        continue;
      }
      const ra = find(i);
      const rb = find(other);
      if (ra === rb) continue;
      const blocked = members.get(ra)!.some((x) => members.get(rb)!.some((y) => apart(x, y)));
      if (blocked) continue;
      parent.set(ra, rb);
      members.set(rb, [...members.get(rb)!, ...members.get(ra)!]);
    }
  }
  return [...new Set(ids.map(find))].map((r) => members.get(r)!).filter((m) => m.length > 1);
}

function citationProblems(citations: Citation[], v: ResearchVerification): string {
  return citations.map((c) => `${c.url}: ${v.checks[citationKey(c)]?.result ?? "not checked"}${v.checks[citationKey(c)]?.detail ? ` (${v.checks[citationKey(c)]!.detail})` : ""}`).join("; ");
}

// ------------------------------------------------------------------ patch plan

/**
 * The proposal as an engine PatchPlan: one approval unit per group, applied by `fullstackgtm apply` (or the hosted
 * `hygiene.apply_operations` path) with compare-and-set. Each item is its own `groupId`, so one conflicted item skips
 * only itself. Merges carry a recovery snapshot of the record they destroy.
 */
export function toPatchPlan(p: HierarchyProposal, createdAt = new Date().toISOString()): PatchPlan {
  const evidence: GtmEvidence[] = [];
  const evidenceId = (c: Citation) => {
    const id = `ev_${stableHash(`hierarchy:${citationKey(c)}`)}`;
    if (!evidence.some((e) => e.id === id)) {
      const check = p.verification.checks[citationKey(c)];
      evidence.push({
        id,
        sourceSystem: c.url.startsWith("internal:") ? "manual" : "web",
        sourceObjectType: c.url.startsWith("internal:") ? "attestation" : "web_page",
        sourceObjectId: c.url,
        text: c.quote,
        capturedAt: p.verification.checkedAt,
        metadata: { verification: check?.result, detail: check?.detail, note: c.note, attestedBy: c.attestedBy },
      });
    }
    return id;
  };
  const ops: PatchOperation[] = [];
  const name = (i: string | null) => (i ? p.accounts.get(i)?.name ?? i : "none");
  const order = { merge: 0, set_parent: 1, set_fields: 2 } as const;
  for (const it of [...p.items].sort((a, b) => order[a.op] - order[b.op])) {
    const groupId = `grp_${stableHash(it.key)}`;
    const warn = it.warn.length ? ` ⚠ ${it.warn.join(" ⚠ ")}` : "";
    if (it.op === "merge") {
      for (const [field, value] of Object.entries(it.fill)) {
        ops.push({
          id: `op_${stableHash(`${it.key}:fill:${field}`)}`,
          objectType: "account",
          objectId: it.survivorId,
          operation: "set_field",
          field,
          beforeValue: null,
          afterValue: value,
          reason: `Before merging ${name(it.loserId)} into ${name(it.survivorId)}: fill the survivor's blank ${field} from the duplicate.`,
          riskLevel: "low",
          approvalRequired: true,
          sourceRuleOrPolicy: "hierarchy.merge_fill",
          rollback: `Clear ${field} on ${it.survivorId}.`,
          groupId,
        });
      }
      const loser = p.accounts.get(it.loserId)!;
      ops.push({
        id: `op_${stableHash(it.key)}`,
        objectType: "account",
        objectId: it.survivorId,
        operation: "merge_records",
        beforeValue: [it.survivorId, it.loserId],
        afterValue: it.survivorId,
        reason: `Merge ${name(it.loserId)} (${it.loserId}) into ${name(it.survivorId)} (${it.survivorId}): ${it.why}. Moves ${it.moves}.${warn}`,
        riskLevel: "high",
        approvalRequired: true,
        sourceRuleOrPolicy: "hierarchy.merge",
        rollback: "IRREVERSIBLE. The recovery snapshot holds the merged record's values for recreating it by hand.",
        groupId,
        recoverySnapshot: [{ id: it.loserId, name: loser.name, domain: loser.domain, parentAccountId: accountParentId(loser), ownerId: loser.ownerId, raw: loser.raw }],
      });
    } else if (it.op === "set_parent") {
      ops.push({
        id: `op_${stableHash(it.key)}`,
        objectType: "account",
        objectId: it.accountId,
        operation: it.to ? "link_record" : "clear_field",
        field: "parentAccountId",
        beforeValue: it.from,
        afterValue: it.to,
        reason: `Parent of ${name(it.accountId)}: ${name(it.from)} -> ${name(it.to)}. ${it.why}.${warn}`,
        riskLevel: "medium",
        approvalRequired: true,
        sourceRuleOrPolicy: "hierarchy.parent",
        rollback: `Set the parent of ${it.accountId} back to ${it.from ?? "none"}.`,
        evidenceIds: it.citations.map(evidenceId),
        groupId,
      });
    } else {
      for (const [field, value] of Object.entries(it.fields)) {
        ops.push({
          id: `op_${stableHash(`${it.key}:${field}`)}`,
          objectType: "account",
          objectId: it.accountId,
          operation: "set_field",
          field,
          beforeValue: it.expect[field],
          afterValue: value,
          reason: `${name(it.accountId)}: ${field} ${it.expect[field] ?? "blank"} -> ${value}.`,
          riskLevel: "low",
          approvalRequired: true,
          sourceRuleOrPolicy: "hierarchy.field",
          rollback: `Set ${field} back to ${it.expect[field] ?? "blank"}.`,
          evidenceIds: it.citations.map(evidenceId),
          groupId,
        });
      }
    }
  }
  assertNoOwnerWrites(ops, p.policy);
  const n = { merge: 0, set_parent: 0, set_fields: 0 };
  for (const it of p.items) n[it.op]++;
  return {
    id: `patch_plan_${stableHash(`hierarchy:${p.group}:${p.rootId}:${createdAt}`)}`,
    title: `Account hierarchy: ${p.group}`,
    createdAt,
    status: ops.length ? "needs_approval" : "draft",
    dryRun: true,
    summary: `${n.merge} merge(s), ${n.set_parent} parent move(s), ${n.set_fields} field fix(es) for ${p.group}; ${p.flags.length} flag(s) for a person. Owners are not changed.`,
    findings: [],
    evidence,
    assumptions: [
      { id: "hierarchy.owners", text: "No account or deal owner is set or changed; routing decides owners.", source: "workspace policy" },
      { id: "hierarchy.research", text: `Research for ${p.group} from ${p.research.researchedAt} by ${p.research.researchedBy}; only claims with a verbatim-verified or person-attested citation produce operations.`, source: "verbatim evidence gate" },
    ],
    openQuestions: p.flags,
    operations: ops,
  };
}

/** The owner rules are enforced here, not just by construction: a plan that writes an owner is refused. */
export function assertNoOwnerWrites(ops: PatchOperation[], policy: HierarchyPolicy): void {
  for (const op of ops) {
    const ownerField = op.field && /^(ownerId|OwnerId|hubspot_owner_id)$/.test(op.field);
    if (ownerField && op.objectType === "account" && policy.rules.neverChangeAccountOwners) throw new Error(`policy: account owners never change (${op.id})`);
    if (ownerField && op.objectType === "deal" && policy.rules.neverChangeDealOwners) throw new Error(`policy: deal owners never change (${op.id})`);
  }
}

/** A proposal as plain JSON for storage and the review page: items, flags, suggestions and the family's accounts. */
export type ProposalJson = {
  group: string;
  rootId: string;
  today: string;
  items: HierarchyItem[];
  flags: string[];
  hints: string[];
  accounts: Array<{ id: string; name: string; domain?: string; parentId?: string; ownerId?: string }>;
  counts: { merge: number; set_parent: number; set_fields: number; flags: number };
};

export function proposalToJson(p: HierarchyProposal): ProposalJson {
  const counts = { merge: 0, set_parent: 0, set_fields: 0, flags: p.flags.length };
  for (const it of p.items) counts[it.op]++;
  return {
    group: p.group,
    rootId: p.rootId,
    today: p.today,
    items: p.items,
    flags: p.flags,
    hints: p.hints,
    accounts: [...p.accounts.values()].map((a) => ({
      id: String(a.id),
      name: a.name,
      ...(a.domain ? { domain: a.domain } : {}),
      ...(accountParentId(a) ? { parentId: accountParentId(a) } : {}),
      ...(a.ownerId ? { ownerId: a.ownerId } : {}),
    })),
    counts,
  };
}
