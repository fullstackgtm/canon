// Onboarding chain: visitor domain -> JTBDs their product does -> conditions
// that create demand for those jobs -> archetypes that have those conditions.
// One Jev request (website text + one Noul per JTBD); everything after that
// is code over the cached taxonomy, so it is fast and deterministic.
import { systemOne, type Question } from "./client.ts";
import { allArchetypes, archetypeConditions, jtbd } from "./taxonomy.ts";

const MAX_TEXT = 12_000; // chars of site text; Jev accuracy drops with long, noisy state

function textOf(html: string) {
  return html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

/** Homepage text, plus a pricing/product page when one is linked, capped for Jev. */
export async function fetchSiteText(domain: string): Promise<string> {
  const get = async (url: string) => {
    const r = await fetch(url, { headers: { "user-agent": "fullstackgtm-icp/1 (+https://fullstackgtm.com)" }, redirect: "follow", signal: AbortSignal.timeout(12_000) });
    return r.ok ? await r.text() : "";
  };
  const home = await get(`https://${domain}/`);
  let text = textOf(home);
  const extra = [...home.matchAll(/href="(\/(?:pricing|product|platform|features|solutions)[^"#?]*)"/gi)].map((m) => m[1])[0];
  if (extra) text += " " + textOf(await get(`https://${domain}${extra}`).catch(() => ""));
  return text.slice(0, MAX_TEXT);
}

// Centrality multipliers for Score levels: a job that is only incidental to
// what the site sells should barely move the TAM.
const CENTRALITY = [1.0, 0.55, 0.15]; // core, secondary, incidental

/**
 * How well a condition separates archetypes: conditions most archetypes have
 * (e.g. handles_financial_transactions) say little about who the buyer is.
 * 1 when no archetype has it strongly, falling toward 0.35 when all do.
 */
function specificity(scores: Record<string, Record<string, number>>, condition: string) {
  const vals = Object.values(scores).map((s) => s[condition] ?? 0);
  const share = vals.filter((v) => v >= 0.6).length / Math.max(1, vals.length);
  return 1 - 0.65 * share;
}

export type Segment = {
  archetype: string;            // "group/archetype"
  groupLabel: string;
  definition: string;
  relevance: number;            // 0..1, best path strength
  jtbd: string; jtbdLabel: string; pJtbd: number; centrality: number;
  condition: string; conditionLabel: string; pCondition: number;
  why: string;
};

export async function segmentsForDomain(domain: string, opts: { minJtbd?: number; siteText?: string } = {}) {
  const tax = jtbd();
  const ac = archetypeConditions();
  if (!ac) throw new Error("run scoreArchetypeConditions.ts first");
  const siteText = opts.siteText ?? (await fetchSiteText(domain));
  if (siteText.length < 200) throw new Error(`could not read enough of ${domain}`);

  // 1. Which jobs does the product sold on this site do for its customers?
  const questions: Record<string, Question> = {};
  for (const [k, j] of Object.entries(tax.jtbd)) {
    questions[k] = {
      type: "noul",
      instructions: `Does the product or service sold on the website in \`website\` directly help its customers do this job: ${j.label}?`,
      criteria: { true: "This job is a core use of what the website sells", false: "The website does not sell something that does this job" },
    };
  }
  const r = await systemOne({ website: { domain, text: siteText } }, questions, 6000);
  const pJtbd = Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, (a as { noul: number }).noul]));
  const minJ = opts.minJtbd ?? 0.5;
  const detected = Object.entries(pJtbd).filter(([, p]) => p >= minJ).sort((a, b) => b[1] - a[1]);

  // 1b. How central is each detected job to what the site sells? (second request:
  // needs the detected set). Score levels: core / secondary / incidental.
  const centralQs: Record<string, Question> = {};
  for (const [k] of detected) {
    centralQs[k] = {
      type: "score",
      instructions: `How central is this job to what the website in \`website\` sells: ${tax.jtbd[k].label}?`,
      criteria: [
        "Core: it is the main purpose of the product; buyers purchase it to do this job",
        "Secondary: a supporting feature or benefit, not the main reason to buy",
        "Incidental: mentioned in passing (e.g. security, compliance or reporting claims) but not what the product is for",
      ],
    };
  }
  const centrality: Record<string, number> = {};
  if (detected.length) {
    const c = await systemOne({ website: { domain, text: siteText } }, centralQs, 6000);
    for (const [k, a] of Object.entries(c.answers)) {
      // Expected multiplier over the level distribution (keeps uncertainty).
      const probs = (a as { probabilities?: Record<string, number> }).probabilities ?? {};
      centrality[k] = Object.entries(probs).reduce((acc, [lvl, p]) => acc + p * (CENTRALITY[Number(lvl)] ?? 0), 0);
    }
  }
  const jobs = detected.map(([k, p]) => [k, p * (centrality[k] ?? 1)] as [string, number]).sort((a, b) => b[1] - a[1]);

  const specCache: Record<string, number> = {};
  const spec = (c: string) => (specCache[c] ??= specificity(ac.scores, c));

  // 2-3. Strongest path to each archetype: P(job) x weight(job -> condition) x P(archetype has condition).
  const segments: Segment[] = [];
  for (const a of allArchetypes()) {
    let best: Segment | null = null;
    for (const [j, pj] of jobs) {
      for (const [c, w] of Object.entries(tax.jtbd[j].conditions)) {
        const pc = tax.condition_overrides[a.key]?.[c] ?? ac.scores[a.key]?.[c] ?? 0;
        const rel = pj * w * pc * spec(c);
        if (!best || rel > best.relevance) {
          best = {
            archetype: a.key, groupLabel: a.groupLabel, definition: a.definition, relevance: rel,
            jtbd: j, jtbdLabel: tax.jtbd[j].label, pJtbd: pJtbd[j], centrality: centrality[j] ?? 1, condition: c, conditionLabel: tax.conditions[c], pCondition: pc,
            // Condition descriptions are written as standalone statements, so quote them rather than splice grammar.
            why: `${a.definition}. Typical trait: ${tax.conditions[c].charAt(0).toLowerCase()}${tax.conditions[c].slice(1)}, so they need "${tax.jtbd[j].label.toLowerCase()}".`,
          };
        }
      }
    }
    if (best) segments.push(best);
  }
  segments.sort((x, y) => y.relevance - x.relevance);
  return { domain, model: r.model, jobs: jobs.map(([k, w]) => ({ jtbd: k, label: tax.jtbd[k].label, p: pJtbd[k], centrality: centrality[k] ?? 1, weight: w })), segments };
}
