/**
 * Market segments for a vendor domain, from its website text. Pure and
 * runtime-agnostic: the Jev call is injected (`ask`), the data is a generated
 * bundle (services/prospect-index/scripts/export-segment-data.ts).
 *
 *   buyers    who the site says it sells to: one Jev Noul per archetype
 *   adjacent  segments the site doesn't name, via a standards-based chain:
 *             product kind (O*NET software category/example) -> roles that use
 *             it, or whose pay or work it manages -> industries where those
 *             roles are concentrated (BLS OEWS) -> archetypes
 *
 * Measured on services/prospect-index/benchmark (103 vendors): buyers top-1
 * correct for 89% of vertical vendors. See docs/jtbd-classifier.md.
 */
import data from "./segmentData.v1.json" with { type: "json" };

export type JevQuestion = { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };
/** One Jev systemOne request; returns the Noul probability for each question id. */
export type JevAsk = (state: unknown, questions: Record<string, JevQuestion>, estTokens: number) => Promise<Record<string, number>>;

type Bundle = {
  archetypes: Array<{ key: string; label: string; group: string; definition: string }>;
  pdlIndustries: Record<string, string[]>;
  occupations: string[];
  occupationCodes: string[];
  groups: string[];
  occByGroup: number[][];
  categories: Record<string, { occs: number[]; examples: Array<[string, number[]]> }>;
  industries: string[];
  occIndustries: Record<string, Array<[number, number, number]>>;
  industryArchetypes: Array<Record<string, number>>;
};
const D = data as unknown as Bundle;

export const SEGMENT_DATA_SOURCES = (data as { sources: Record<string, string> }).sources;

const MIN_CAT_P = 0.6;
const MIN_CAT_FALLBACK_P = 0.3;
const MAX_CATS = 4;
const MIN_EX_P = 0.5;
const EX_CHUNK = 400;
const MIN_GROUP_P = 0.5;
const MAX_SUBJECT_GROUPS = 4;
const MIN_ROLE = 0.2;
const MAX_ROLES = 25;

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/** "healthcare/dental_practice" -> "Dental practices" (taxonomy/archetype_labels.v1.json). */
export function archetypeLabel(key: string): string {
  return D.archetypes.find((a) => a.key === key)?.label ?? key;
}

/** BLS titles read as legal text: "Sales Representatives, Wholesale and Manufacturing, Except
 *  Technical and Scientific Products" -> "wholesale and manufacturing sales representatives". */
export function occupationPhrase(title: string): string {
  let t = title.replace(/, All Other$/, "").replace(/, Except .*$/, "").replace(/ \(.*\)$/, "");
  const parts = t.split(", ");
  if (parts.length === 2) t = `${parts[1]} ${parts[0]}`;
  else if (parts.length === 3 && parts[2].startsWith("and ")) t = parts.join(", "); // "A, B, and C" is a list
  else if (parts.length === 3) t = `${parts[1]} ${parts[0]} (${parts[2]})`;
  return t.toLowerCase();
}

/** "Agencies, Brokerages, and Other Insurance Related Activities" -> "insurance agencies and brokerages". */
export function industryPhrase(title: string): string {
  const t = title.replace(/ \(.*\)$/, "").replace(/ \d{4}(, \d{4})*( only)?/g, "");
  const special: Record<string, string> = {
    "Agencies, Brokerages, and Other Insurance Related Activities": "insurance agencies and brokerages",
  };
  return (special[t] ?? t).toLowerCase();
}

// ───────────────────────────── Buyers ─────────────────────────────

export type BuyerScore = { archetype: string; p: number };

export async function directBuyers(ask: JevAsk, domain: string, siteText: string): Promise<BuyerScore[]> {
  const qs: Record<string, JevQuestion> = {};
  D.archetypes.forEach((a, i) => {
    qs[`q${i}`] = {
      type: "noul",
      instructions: `Is the product or service sold on the website in \`website\` built for, or marketed to, this kind of business as a customer: ${a.definition}?`,
      criteria: {
        true: "The website names or clearly targets this kind of business as a customer",
        false: "This kind of business is not a stated or clear target customer",
      },
    };
  });
  const p = await ask({ website: { domain, text: siteText } }, qs, 9_000);
  return D.archetypes.map((a, i) => ({ archetype: a.key, p: p[`q${i}`] ?? 0 })).sort((x, y) => y.p - x.p);
}

// ───────────────────────────── Job chain ─────────────────────────────

export type ChainSegment = {
  archetype: string;
  score: number;
  industry: string;
  role: string;
  via: "user" | "subject";
  job: string | null;
  /** For user roles: the vendor's buyer type where the role is concentrated. */
  at: string | null;
};

/** Industries that correspond to a business type (BLS industry -> archetype p >= 0.3). */
const BUYER_INDUSTRY_P = 0.3;
/** A user role gets full weight when it is at least this share of a buyer industry's workforce. */
const FULL_WEIGHT_SHARE = 0.02;

/**
 * `buyers` (optional, may still be resolving): the vendor's named buyer types.
 * When given, a user role only counts if it is concentrated in one of the
 * buyers' industries: the people who use products like this *at the vendor's
 * customers*, followed to where else they work. Without it every matched role
 * counts, which lets broad software categories (CRM, scheduling) pull in
 * unrelated occupations.
 */
export async function jobChain(
  ask: JevAsk, domain: string, siteText: string, opts: { buyers?: Promise<string[]> } = {},
): Promise<{ jobs: string[]; segments: ChainSegment[] }> {
  const website = { domain, text: siteText };
  const catNames = Object.keys(D.categories);

  // 1. Product categories and subject occupation groups, in parallel.
  const catQs: Record<string, JevQuestion> = {};
  catNames.forEach((name, i) => {
    catQs[`q${i}`] = {
      type: "noul",
      instructions: `Is the main product sold on the website in \`website\` a kind of: ${name}`,
      criteria: { true: "Yes, that is what the product is", false: "No, or only a minor feature" },
    };
  });
  const grpQs: Record<string, JevQuestion> = {};
  D.groups.forEach((title, i) => {
    grpQs[`q${i}`] = {
      type: "noul",
      instructions: `Does the product sold on the website in \`website\` calculate, track or manage something about workers in this occupation group (such as their pay, commissions, schedules, assignments, performance or records): ${title}`,
    };
  });
  const [pc, pg] = await Promise.all([ask({ website }, catQs, 6_000), ask({ website }, grpQs, 6_000)]);
  const ranked = catNames.map((name, i) => ({ name, p: pc[`q${i}`] ?? 0 })).sort((a, b) => b.p - a.p);
  // Fall back to the best two categories when none is clear-cut.
  let cats = ranked.filter((c) => c.p >= MIN_CAT_P).slice(0, MAX_CATS);
  if (!cats.length) cats = ranked.filter((c) => c.p >= MIN_CAT_FALLBACK_P).slice(0, 2);

  // 2. Software examples the product is a direct alternative to.
  const exs = cats.flatMap((c) => D.categories[c.name].examples.map(([example, occs]) => ({ example, occs, category: c.name })));
  const exP = new Array<number>(exs.length).fill(0);
  await Promise.all(chunk(exs.map((e, i) => ({ e, i })), EX_CHUNK).map(async (part) => {
    const qs: Record<string, JevQuestion> = {};
    part.forEach(({ e }, j) => {
      // A competitor test, not a resemblance test: "CRM" resembles everything.
      qs[`q${j}`] = {
        type: "noul",
        instructions: `Is the main product sold on the website in \`website\` a direct alternative to ${e.example} (${e.category}), so that a buyer would choose one or the other for the same purpose?`,
        criteria: { true: "Yes, a direct alternative for the same users and purpose", false: "No, a different kind of product or for different users" },
      };
    });
    const p = await ask({ website }, qs, 3_000 + part.length * 30);
    part.forEach(({ i }, j) => (exP[i] = p[`q${j}`] ?? 0));
  }));
  const matched = exs.map((e, i) => ({ ...e, p: exP[i] })).filter((e) => e.p >= MIN_EX_P).sort((a, b) => b.p - a.p);

  // Buyer gate (see the function comment): industry -> the buyer type it belongs to.
  const buyerKeys = await (opts.buyers ?? Promise.resolve([] as string[]));
  const buyerAt = new Map<number, string>();
  D.industryArchetypes.forEach((archs, ii) => {
    const best = buyerKeys.map((k) => [k, archs[k] ?? 0] as const).filter(([, p]) => p >= BUYER_INDUSTRY_P).sort((a, b) => b[1] - a[1])[0];
    if (best) buyerAt.set(ii, best[0]);
  });
  const atBuyer = (o: number): { at: string; share: number } | null | undefined => {
    if (!buyerAt.size) return null; // no buyers named: ungated
    const hit = (D.occIndustries[o] ?? []).filter(([ii]) => buyerAt.has(ii)).sort((a, b) => b[1] - a[1])[0];
    return hit ? { at: buyerAt.get(hit[0])!, share: hit[1] } : undefined; // undefined: not concentrated at any buyer
  };
  const roleAt = (o: number) => { const x = atBuyer(o); return x === undefined ? undefined : (x?.at ?? null); };
  // A role counts in proportion to how much of the buyers' workforce it is: dental
  // assistants are ~30% of a dental office, dispatchers a fraction of a percent of a clinic.
  const buyerWeight = (o: number) => { const x = atBuyer(o); return x === undefined ? 0 : x === null ? 1 : Math.min(1, x.share / FULL_WEIGHT_SHARE); };

  // 3a. User roles: occupations listing a matched example (examples shared by
  //     many occupations are generic, so their credit is spread); weaker,
  //     specificity-discounted credit for using a matched category at all.
  //     (Dropping the category credit was tried: it thinned good adjacents,
  //     e.g. Samsara lost oil & gas and utilities, without fixing 7shifts.)
  // Software developers and other computer occupations (SOC 15-12xx), and computer and
  // information systems managers (11-3021), list almost every software category; as
  // users they only ever point back at software companies.
  const user = new Map<number, { w: number; job: string }>();
  const bump = (o: number, w: number, job: string) => {
    if (D.occupationCodes[o].startsWith("15-12") || D.occupationCodes[o] === "11-3021") return;
    w *= buyerWeight(o);
    if (w <= 0) return;
    if (w > (user.get(o)?.w ?? 0)) user.set(o, { w, job });
  };
  for (const e of matched) for (const o of e.occs) bump(o, e.p * Math.min(1, 2 / Math.sqrt(e.occs.length)), e.example);
  for (const c of cats) {
    const occs = D.categories[c.name].occs;
    const spec = Math.min(1, 40 / Math.max(1, occs.length));
    for (const o of occs) bump(o, 0.5 * c.p * spec, c.name);
  }

  // 3b. Subject roles: detailed occupations within the strongest groups.
  const subject = new Map<number, number>();
  const topGroups = D.groups.map((_, i) => ({ i, p: pg[`q${i}`] ?? 0 })).filter((x) => x.p >= MIN_GROUP_P).sort((a, b) => b.p - a.p).slice(0, MAX_SUBJECT_GROUPS);
  if (topGroups.length) {
    const occs = topGroups.flatMap((g) => D.occByGroup[g.i].map((o) => ({ o, pg: g.p })));
    const qs: Record<string, JevQuestion> = {};
    occs.forEach((x, i) => {
      qs[`q${i}`] = { type: "noul", instructions: `Does the product sold on the website in \`website\` calculate, track or manage something about people employed as (such as their pay, commissions, schedules, assignments, performance or records): ${D.occupations[x.o]}` };
    });
    const p = await ask({ website }, qs, 3_000 + occs.length * 40);
    occs.forEach((x, i) => subject.set(x.o, Math.max(subject.get(x.o) ?? 0, x.pg * (p[`q${i}`] ?? 0))));
  }

  type Role = { o: number; weight: number; via: "user" | "subject"; job: string | null };
  const toRoles = (m: Map<number, number>, via: Role["via"]): Role[] => [...m.entries()]
    .filter(([, w]) => w >= MIN_ROLE).sort((a, b) => b[1] - a[1]).slice(0, MAX_ROLES)
    .map(([o, weight]) => ({ o, weight, via, job: via === "user" ? (user.get(o)?.job ?? null) : null }));
  const userRoles = toRoles(new Map([...user].map(([k, v]) => [k, v.w])), "user");
  const subjectRoles = toRoles(subject, "subject");

  // 4. Industries per channel: role density, counted only where the role is at
  //    least 2x as concentrated as nationally (the bundle keeps only those);
  //    each channel scaled by its strongest role.
  const industriesFor = (roles: Role[]) => {
    const ind = new Map<number, { score: number; role: Role; best: number }>();
    for (const r of roles) for (const [ii, share, lift] of D.occIndustries[r.o] ?? []) {
      const contrib = r.weight * share * Math.max(0, Math.log2(Math.min(lift, 64)) - 1);
      if (contrib <= 0) continue;
      const cur = ind.get(ii) ?? { score: 0, role: r, best: 0 };
      ind.set(ii, { score: cur.score + contrib, role: contrib > cur.best ? r : cur.role, best: Math.max(cur.best, contrib) });
    }
    const max = Math.max(1e-9, ...[...ind.values()].map((v) => v.score));
    const scale = roles[0]?.weight ?? 0;
    return new Map([...ind].map(([k, v]) => [k, { score: (scale * v.score) / max, role: v.role }]));
  };
  const iu = industriesFor(userRoles), is = industriesFor(subjectRoles);

  // 5. Archetypes: strongest industry path.
  const seg = new Map<string, ChainSegment>();
  for (const ii of new Set([...iu.keys(), ...is.keys()])) {
    const u = iu.get(ii), sb = is.get(ii);
    const pick = (sb?.score ?? 0) > (u?.score ?? 0) ? sb! : u!;
    for (const [a, p] of Object.entries(D.industryArchetypes[ii] ?? {})) {
      const score = pick.score * p;
      if (score > (seg.get(a)?.score ?? 0)) {
        seg.set(a, {
          archetype: a, score, industry: D.industries[ii], role: D.occupations[pick.role.o], via: pick.role.via, job: pick.role.job,
          at: pick.role.via === "user" ? (roleAt(pick.role.o) ?? null) : null,
        });
      }
    }
  }
  return {
    jobs: [...cats.map((c) => c.name), ...matched.slice(0, 8).map((e) => e.example)],
    segments: [...seg.values()].sort((a, b) => b.score - a.score),
  };
}

// ───────────────────────────── Combined ─────────────────────────────

export type MarketSegment = {
  archetype: string;
  label: string;
  group: string;
  kind: "buyer" | "adjacent";
  score: number;
  why: string;
  /** PDL industries used to estimate the segment's size until companies are tagged. */
  pdlIndustries: string[];
};

export type MarketSegments = {
  buyers: MarketSegment[];
  adjacent: MarketSegment[];
  /** Sells broadly (many archetypes plausible): segments are a weak guide. */
  horizontal: boolean;
  jobs: string[];
};

const MAX_BUYERS = 8;
const MIN_BUYER_P = 0.5;
const MAX_ADJACENT = 5;
const MIN_ADJACENT = 0.15;
const HORIZONTAL_AT = 15; // archetypes with p >= 0.5: so broad the gate is meaningless anyway
/**
 * Jev's answer to "is this a general-purpose tool?" at or above this marks the vendor
 * horizontal. On the benchmark: all 13 horizontal vendors, and 4 of 90 vertical ones
 * (iSolved, Shopify, Pendo, CaptivateIQ, all cross-industry in practice). The old
 * breadth rule (15+ named buyers) caught 4 of 13.
 */
const GENERAL_PURPOSE_AT = 0.7;

export async function generalPurpose(ask: JevAsk, domain: string, siteText: string): Promise<number> {
  const p = await ask({ website: { domain, text: siteText } }, {
    q0: {
      type: "noul",
      instructions: "Is the main product sold on the website in `website` a general-purpose business tool that most kinds of businesses could use, rather than one built for particular industries?",
      criteria: { true: "General-purpose: useful to businesses in almost any industry", false: "Built for, or mainly sold to, particular industries" },
    },
  }, 4_000);
  return p.q0 ?? 0;
}

function adjacentWhy(s: ChainSegment): string {
  const role = occupationPhrase(s.role);
  const where = industryPhrase(s.industry);
  if (s.via === "subject") return `Products like yours manage the pay or work of ${role}, who are concentrated in ${where}.`;
  if (s.at) {
    const sentence = `${role} use products like yours at ${archetypeLabel(s.at).toLowerCase()}, and are also concentrated in ${where}.`;
    return sentence.charAt(0).toUpperCase() + sentence.slice(1);
  }
  const tool = s.job && !/software$/i.test(s.job) ? `tools like ${s.job}` : (s.job ?? "this kind of software").toLowerCase();
  const sentence = `${role} use ${tool}, and they are concentrated in ${where}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** Buyers must be at least this likely to open the adjacent-segment gate (see jobChain). */
export const GATE_MIN_P = 0.5;

/** Adjacent candidates the chain proposes; Jev keeps the plausible ones (up to MAX_ADJACENT). */
const ADJACENT_CANDIDATES = 10;
const MIN_PLAUSIBLE = 0.5;

/**
 * One Jev request: would each candidate business type plausibly buy this product,
 * even if the site doesn't mention it? The chain finds candidates from occupation
 * data; this check removes the ones that don't make sense for the product
 * (measured: ~half of unfiltered adjacent segments failed it).
 */
export async function plausibleCustomers(ask: JevAsk, domain: string, siteText: string, keys: string[]): Promise<number[]> {
  if (!keys.length) return [];
  const qs: Record<string, JevQuestion> = {};
  keys.forEach((k, i) => {
    const def = D.archetypes.find((a) => a.key === k)?.definition ?? k;
    qs[`q${i}`] = {
      type: "noul",
      instructions: `Would this kind of business plausibly buy the product sold on the website in \`website\`, even if the website does not mention it: ${def}?`,
      criteria: { true: "A realistic customer: it has the need this product serves", false: "Not a realistic customer for this product" },
    };
  });
  const p = await ask({ website: { domain, text: siteText } }, qs, 4_000);
  return keys.map((_, i) => p[`q${i}`] ?? 0);
}

export async function marketSegments(
  ask: JevAsk, domain: string, siteText: string, opts: { gateMinP?: number; plausibilityCheck?: boolean } = {},
): Promise<MarketSegments> {
  const gateMinP = opts.gateMinP ?? GATE_MIN_P;
  const check = opts.plausibilityCheck ?? true;
  const buyersP = directBuyers(ask, domain, siteText);
  const generalP = generalPurpose(ask, domain, siteText).catch(() => 0);
  const namedOf = (bs: BuyerScore[]) => bs.filter((b) => b.p >= MIN_BUYER_P && !b.archetype.endsWith("/other"));
  // The chain's Jev calls start now; it waits for the buyers only when scoring roles.
  // A horizontal vendor names too many buyers for the gate to mean anything, so it runs ungated.
  const isHorizontal = (n: BuyerScore[], g: number) => n.length >= HORIZONTAL_AT || g >= GENERAL_PURPOSE_AT;
  const gate = Promise.all([buyersP, generalP]).then(([bs, g]) => {
    const n = namedOf(bs);
    return isHorizontal(n, g) ? [] : n.filter((b) => b.p >= gateMinP).map((b) => b.archetype);
  });
  const [buyerScores, chain] = await Promise.all([buyersP, jobChain(ask, domain, siteText, { buyers: gate })]);
  const groupOf = (k: string) => D.archetypes.find((a) => a.key === k)?.group ?? "";
  const named = namedOf(buyerScores);
  const buyers: MarketSegment[] = named.slice(0, MAX_BUYERS).map((b) => ({
    archetype: b.archetype, label: archetypeLabel(b.archetype), group: groupOf(b.archetype), kind: "buyer", score: Number(b.p.toFixed(3)),
    why: `${domain} names or clearly targets this kind of business.`,
    pdlIndustries: D.pdlIndustries[b.archetype] ?? [],
  }));
  const taken = new Set(named.map((b) => b.archetype));
  let candidates = chain.segments
    .filter((s) => !taken.has(s.archetype) && !s.archetype.endsWith("/other") && s.score >= MIN_ADJACENT)
    .slice(0, check ? ADJACENT_CANDIDATES : MAX_ADJACENT);
  if (check) {
    const p = await plausibleCustomers(ask, domain, siteText, candidates.map((c) => c.archetype));
    candidates = candidates.filter((_, i) => p[i] >= MIN_PLAUSIBLE);
  }
  const adjacent: MarketSegment[] = candidates
    .slice(0, MAX_ADJACENT)
    .map((s) => ({
      archetype: s.archetype, label: archetypeLabel(s.archetype), group: groupOf(s.archetype), kind: "adjacent", score: Number(s.score.toFixed(3)),
      why: adjacentWhy(s), pdlIndustries: D.pdlIndustries[s.archetype] ?? [],
    }));
  return { buyers, adjacent, horizontal: isHorizontal(named, await generalP), jobs: chain.jobs };
}
