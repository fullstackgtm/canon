// Classify companies into business archetypes with Jev, two levels deep.
//
//   stage 1: Choice over the 16 groups, BATCH companies per request. Group
//            definitions are sent once in `state`; each company's question
//            lists only the option keys, so tokens per company stay small.
//   stage 2: Choice over the archetypes of the company's group, batched BY
//            GROUP so `state` carries only that group's definitions. When the
//            top group is uncertain (< SECOND_GROUP_BELOW), the runner-up group
//            is classified too.
// Output per company: top group, and up to 3 archetypes with probability
// p(group) * p(archetype | group).
import { systemOne, type Question } from "./client.ts";
import { readFileSync, existsSync } from "node:fs";
import { allArchetypes, archetypes } from "./taxonomy.ts";

export type CompanyIn = { domain: string; name: string; industry?: string | null; sizeBand?: string | null; country?: string | null; locality?: string | null; about?: string | null };
export type CompanyTags = {
  domain: string;
  group: string; pGroup: number; groupConfidence: number;
  archetypes: Array<{ key: string; p: number }>; // "group/archetype", best first, max 3
};

const BATCH = Number(process.env.JEV_BATCH ?? 25);
const SECOND_GROUP_BELOW = 0.75;
const UNCLEAR = "unclear";

const record = (c: CompanyIn) => {
  const r: Record<string, string> = { name: c.name, website: c.domain };
  if (c.industry) r.industry = c.industry;
  if (c.sizeBand) r.employees = c.sizeBand;
  if (c.country) r.location = [c.locality, c.country].filter(Boolean).join(", ");
  if (c.about) r.homepage = c.about;
  return r;
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const SHORTLIST = Number(process.env.JEV_SHORTLIST ?? 10);
const SHORTLIST_MIN_P = 0.3;
const NONE = "none_of_these";

/** industry -> best-first archetype keys ("group/archetype"), from taxonomy/industry_archetypes.v1.json. */
function industryShortlists(): Map<string, string[]> {
  const path = new URL("../../taxonomy/industry_archetypes.v1.json", import.meta.url).pathname;
  if (!existsSync(path)) return new Map();
  const { scores } = JSON.parse(readFileSync(path, "utf8")) as { scores: Record<string, Record<string, number>> };
  return new Map(Object.entries(scores).map(([ind, s]) => [ind,
    Object.entries(s).filter(([, p]) => p >= SHORTLIST_MIN_P).sort((a, b) => b[1] - a[1]).slice(0, SHORTLIST).map(([k]) => k)]));
}

/**
 * Fast path: companies with an industry get ONE Choice over that industry's
 * ~10 plausible archetypes (batched by industry, definitions shared in state),
 * plus a "none of these" escape. Companies with no industry, or that escape,
 * go through the full two-stage classifier. This is most of the cost saving:
 * every option is ~10 tokens per company.
 */
export async function classifyCompaniesFast(companies: CompanyIn[], concurrency = 24): Promise<CompanyTags[]> {
  const lists = industryShortlists();
  const defsByKey = Object.fromEntries(allArchetypes().map((a) => [a.key, a.definition]));
  const out: Array<CompanyTags | null> = companies.map(() => null);
  const byIndustry = new Map<string, number[]>();
  companies.forEach((c, i) => {
    const list = c.industry ? lists.get(c.industry) : undefined;
    if (!list?.length) return;
    if (!byIndustry.has(c.industry!)) byIndustry.set(c.industry!, []);
    byIndustry.get(c.industry!)!.push(i);
  });
  const work = [...byIndustry.entries()].flatMap(([ind, idx]) => chunks(idx, BATCH).map((b) => ({ ind, b })));
  await mapLimit(work, concurrency, async ({ ind, b }) => {
    const keys = lists.get(ind)!;
    // Option ids must be unique; "other" exists in every group, so ids are group-qualified only when needed.
    const ids = keys.map((k) => (k.endsWith("/other") ? k.replace("/", "_") : k.split("/")[1]));
    const types = Object.fromEntries(ids.map((id, n) => [id, defsByKey[keys[n]]]));
    const criteria = Object.fromEntries([...ids.map((id) => [id, null]), [NONE, "None of the listed business types fits"]]);
    const questions: Record<string, Question> = {};
    b.forEach((_, j) => {
      questions[`c${j}`] = {
        type: "choice",
        instructions: `Which business type in \`types\` best describes the business \`companies[${j}]\`? Judge from its name, website domain, industry and homepage text when present.`,
        criteria,
      };
    });
    const r = await systemOne({ types, companies: b.map((i) => record(companies[i])) }, questions, 250 + b.length * 130);
    b.forEach((i, j) => {
      const probs = (r.answers[`c${j}`] as { probabilities: Record<string, number> }).probabilities;
      if ((probs[NONE] ?? 0) >= 0.5) return; // escape -> full classifier
      const ranked = ids.map((id, n) => ({ key: keys[n], p: probs[id] ?? 0 })).sort((x, y) => y.p - x.p);
      const top = ranked.slice(0, 3).map((a) => ({ key: a.key, p: Number(a.p.toFixed(3)) }));
      const group = top[0].key.split("/")[0];
      const pGroup = ranked.filter((a) => a.key.startsWith(group + "/")).reduce((acc, a) => acc + a.p, 0);
      out[i] = { domain: companies[i].domain, group, pGroup: Number(pGroup.toFixed(3)), groupConfidence: Number(((top[0]?.p ?? 0) - (top[1]?.p ?? 0)).toFixed(3)), archetypes: top };
    });
  });
  const rest = companies.map((c, i) => ({ c, i })).filter((x) => !out[x.i]);
  if (rest.length) {
    const tags = await classifyCompanies(rest.map((x) => x.c), concurrency);
    rest.forEach((x, n) => (out[x.i] = tags[n]));
  }
  return out as CompanyTags[];
}

export async function classifyCompanies(companies: CompanyIn[], concurrency = 24): Promise<CompanyTags[]> {
  const tax = archetypes();
  const groupKeys = Object.keys(tax.groups);
  const groupDefs = Object.fromEntries(Object.entries(tax.groups).map(([k, g]) => [k, `${g.label}: ${g.definition}`]));
  const groupCriteria = Object.fromEntries([...groupKeys.map((k) => [k, null]), [UNCLEAR, "Not enough information to tell what the business does"]]);

  // ---- stage 1: group ----
  const g1 = new Map<number, Record<string, number>>(); // company index -> group probabilities
  await mapLimit(chunks(companies.map((c, i) => ({ c, i })), BATCH), concurrency, async (batch) => {
    const questions: Record<string, Question> = {};
    batch.forEach((_, j) => {
      questions[`c${j}`] = {
        type: "choice",
        instructions: `Which category in \`categories\` best describes the business \`companies[${j}]\`? Judge from its name, website domain, industry and homepage text when present.`,
        criteria: groupCriteria,
      };
    });
    const r = await systemOne({ categories: groupDefs, companies: batch.map((b) => record(b.c)) }, questions, 400 + batch.length * 140);
    batch.forEach((b, j) => g1.set(b.i, (r.answers[`c${j}`] as { probabilities: Record<string, number> }).probabilities));
  });

  // ---- stage 2: archetype within group(s), batched by group ----
  const jobs = new Map<string, Array<{ i: number; pGroup: number }>>();
  companies.forEach((_, i) => {
    const probs = Object.entries(g1.get(i) ?? {}).filter(([k]) => k !== UNCLEAR).sort((a, b) => b[1] - a[1]);
    if (!probs.length) return;
    const take = probs[0][1] < SECOND_GROUP_BELOW ? probs.slice(0, 2) : probs.slice(0, 1);
    for (const [g, p] of take) {
      if (!jobs.has(g)) jobs.set(g, []);
      jobs.get(g)!.push({ i, pGroup: p });
    }
  });
  const arch = new Map<number, Array<{ key: string; p: number }>>();
  const work = [...jobs.entries()].flatMap(([g, list]) => chunks(list, BATCH).map((b) => ({ g, b })));
  await mapLimit(work, concurrency, async ({ g, b }) => {
    const defs = tax.groups[g].archetypes;
    const criteria = Object.fromEntries(Object.keys(defs).map((k) => [k, null]));
    const questions: Record<string, Question> = {};
    b.forEach((_, j) => {
      questions[`c${j}`] = {
        type: "choice",
        instructions: `Which business type in \`types\` best describes the business \`companies[${j}]\`? Judge from its name, website domain, industry and homepage text when present.`,
        criteria,
      };
    });
    const r = await systemOne({ types: defs, companies: b.map((x) => record(companies[x.i])) }, questions, 300 + b.length * 120);
    b.forEach((x, j) => {
      const probs = (r.answers[`c${j}`] as { probabilities: Record<string, number> }).probabilities;
      const list = arch.get(x.i) ?? [];
      for (const [k, p] of Object.entries(probs)) list.push({ key: `${g}/${k}`, p: x.pGroup * p });
      arch.set(x.i, list);
    });
  });

  return companies.map((c, i) => {
    const probs = g1.get(i) ?? {};
    const [group, pGroup] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0] ?? [UNCLEAR, 0];
    const top = (arch.get(i) ?? []).sort((a, b) => b.p - a.p).slice(0, 3).map((a) => ({ key: a.key, p: Number(a.p.toFixed(3)) }));
    const sorted = Object.values(probs).sort((a, b) => b - a);
    return { domain: c.domain, group, pGroup: Number(pGroup.toFixed(3)), groupConfidence: Number(((sorted[0] ?? 0) - (sorted[1] ?? 0)).toFixed(3)), archetypes: top };
  });
}
