// GENERATED from convex/lib/objects/duplicates.ts by scripts/sync-object-core.ts. Edit the source, then rerun the script.
/**
 * Duplicate candidates over the register (CP15b, docs/core-crm-parity.md).
 *
 * Pure and Node-free: the record service runs it over its register rows (a copy under src/core, see
 * scripts/sync-object-core.ts) and the in-memory fake runs the same code, so tests and the service agree.
 *
 * The keys are engine/src/dedupe.ts's (a normalized domain, a lowercased email, a lowercased name) plus the
 * ones a CRM user expects: LinkedIn URL, a company name without its legal suffix, a domain's family (acme.com
 * and acme.co.uk), and the same name at the same company. Rows that share any key are one group (union-find),
 * so A~B by email and B~C by name is one group of three. Each group carries every reason that linked it.
 */

export type DuplicateObject = "account" | "contact";
export type MatchReason = "email" | "linkedin" | "domain" | "name_at_company" | "name" | "domain_family";

/** What matching reads of one register row, and what the view shows of it. */
export type DuplicateRow = {
  id: string;
  /** A company's name or a person's full name. */
  name: string;
  domain?: string | null;
  email?: string | null;
  /** A person's other emails (#299): any one of them shared with another person is a match, as the primary is. */
  otherEmails?: readonly string[] | null;
  linkedinUrl?: string | null;
  /** A contact's company (record id). */
  accountId?: string | null;
  /** One line to tell records apart: a company's industry, a person's title. */
  detail?: string | null;
};

export type DuplicateGroup = {
  /** At most `GROUP_IDS_MAX` members, the merge dialog's limit. */
  members: DuplicateRow[];
  /** How many records the group really has. */
  size: number;
  /** Every reason that linked members, with the value they share, strongest first. */
  matches: Array<{ reason: MatchReason; value: string }>;
  score: number;
};

export const GROUP_IDS_MAX = 9;
/** A key shared by more rows than this is generic ("unknown", a parked domain), never proof. */
const BUCKET_MAX = 50;

/** Strength per reason: an identifier first, a name alone last. */
export const REASON_WEIGHT: Record<MatchReason, number> = { email: 100, linkedin: 90, domain: 80, name_at_company: 70, name: 50, domain_family: 40 };

const SUFFIX = /\s(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|sa|bv|ag|pty|lp|llp)$/;

/** A company name as people compare it: case, punctuation and a trailing legal suffix aside. */
export function nameKey(name: string | null | undefined): string {
  let n = (name ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2 && SUFFIX.test(n); i++) n = n.replace(SUFFIX, "");
  return n;
}

const personKey = (name: string | null | undefined) => (name ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

export function linkedinKey(url: string | null | undefined): string {
  return (url ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^(www|[a-z]{2})\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

export function domainKey(domain: string | null | undefined): string {
  return (domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);

/** The label a domain is registered under: acme.com, acme.io and acme.co.uk are all "acme". */
export function domainFamily(domain: string | null | undefined): string {
  const labels = domainKey(domain).split(".").filter(Boolean);
  if (labels.length < 2) return "";
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  return labels.length >= 3 && last.length === 2 && SECOND_LEVEL.has(second) ? labels[labels.length - 3] : second;
}

const emailKey = (email: string | null | undefined) => (email ?? "").trim().toLowerCase();

/** A row's keys for one reason: one, or several (a person's emails), "" for none. */
type Bucketer = { reason: MatchReason; keyOf: (r: DuplicateRow) => string | readonly string[] };

const BUCKETERS: Record<DuplicateObject, Bucketer[]> = {
  account: [
    { reason: "linkedin", keyOf: (r) => linkedinKey(r.linkedinUrl) },
    { reason: "domain", keyOf: (r) => domainKey(r.domain) },
    { reason: "name", keyOf: (r) => nameKey(r.name) },
    { reason: "domain_family", keyOf: (r) => domainFamily(r.domain) },
  ],
  contact: [
    { reason: "email", keyOf: (r) => [...new Set([r.email, ...(r.otherEmails ?? [])].map(emailKey).filter(Boolean))] },
    { reason: "linkedin", keyOf: (r) => linkedinKey(r.linkedinUrl) },
    { reason: "name_at_company", keyOf: (r) => (r.accountId && personKey(r.name).includes(" ") ? `${personKey(r.name)}@${r.accountId}` : "") },
  ],
};

/** Candidate groups among `rows`, strongest first (ties by the smallest member id). Rows with no key match nothing. */
export function findDuplicates(object: DuplicateObject, rows: readonly DuplicateRow[]): DuplicateGroup[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(x) !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  for (const r of rows) parent.set(r.id, r.id);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const links: Array<{ reason: MatchReason; value: string; ids: string[] }> = [];
  for (const { reason, keyOf } of BUCKETERS[object]) {
    const buckets = new Map<string, string[]>();
    for (const r of rows) {
      const keys = keyOf(r);
      for (const key of typeof keys === "string" ? [keys] : keys) {
        if (!key) continue;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(r.id);
        else buckets.set(key, [r.id]);
      }
    }
    for (const [value, ids] of buckets) {
      if (ids.length < 2 || ids.length > BUCKET_MAX) continue;
      links.push({ reason, value, ids });
      for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]));
    }
  }
  const groups = new Map<string, { ids: Set<string>; matches: Map<MatchReason, string> }>();
  for (const link of links) {
    const root = find(link.ids[0]);
    const g = groups.get(root) ?? { ids: new Set<string>(), matches: new Map<MatchReason, string>() };
    for (const id of link.ids) g.ids.add(id);
    // A name at a company is keyed by both; the view shows the name.
    if (!g.matches.has(link.reason)) g.matches.set(link.reason, link.reason === "name_at_company" ? link.value.slice(0, link.value.lastIndexOf("@")) : link.value);
    groups.set(root, g);
  }
  return [...groups.values()]
    .map((g) => {
      const ids = [...g.ids].sort();
      const matches = [...g.matches].map(([reason, value]) => ({ reason, value })).sort((a, b) => REASON_WEIGHT[b.reason] - REASON_WEIGHT[a.reason]);
      return {
        members: ids.slice(0, GROUP_IDS_MAX).map((id) => byId.get(id)!),
        size: ids.length,
        matches,
        score: REASON_WEIGHT[matches[0].reason] + 5 * (matches.length - 1),
      };
    })
    .sort((a, b) => b.score - a.score || (a.members[0].id < b.members[0].id ? -1 : 1));
}

/** Every pair of ids, each as `a|b` with a < b: what a dismissal stores and what a group is checked against. */
export function pairKeys(ids: readonly string[]): string[] {
  const sorted = [...ids].sort();
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) out.push(`${sorted[i]}|${sorted[j]}`);
  return out;
}
