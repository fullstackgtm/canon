/**
 * Jev questions behind the TAM explorer's AI segments, and how their answers
 * become account traits. Pure: the actions in convex/tamActions.ts do the I/O.
 *
 * - Yes/no segments ("employs commissioned reps"): one Noul per account. The
 *   trait is yes / no / unsure; unsure is the middle band, where the evidence
 *   doesn't settle it either way.
 * - Choice segments (jobs to be done: the vendor's buyer types): one Choice
 *   per account; the trait is the option key, or unsure when no option is a
 *   clear favourite.
 * - Revenue: a Choice over revenue bands. The account gets the band's
 *   representative value as an estimate, with the answer's confidence.
 */
import type { SystemOneAnswer, SystemOneQuestion } from "../segments/jev";
import { archetypeLabel } from "../segments/marketSegments.ts";

/** Homepage characters sent as evidence (~1.5k tokens). */
export const SITE_TEXT_CHARS = 6000;
export const YES_AT = 0.65;
export const NO_AT = 0.35;
/** A Choice whose top option is below this is unsure. */
export const CHOICE_MIN_P = 0.4;
export const UNSURE = "unsure";

export type AccountEvidence = {
  name: string;
  domain: string;
  industry?: string;
  employees?: number;
  country?: string;
  siteText?: string | null;
};

export function evidenceState(a: AccountEvidence) {
  return {
    company: {
      name: a.name,
      domain: a.domain,
      ...(a.industry ? { industry: a.industry } : {}),
      ...(a.employees !== undefined ? { employees: a.employees } : {}),
      ...(a.country ? { country: a.country } : {}),
    },
    website: a.siteText ? { text: a.siteText.slice(0, SITE_TEXT_CHARS) } : { text: null, note: "The homepage could not be read." },
  };
}

export function noulQuestion(criterion: string): SystemOneQuestion {
  return {
    type: "noul",
    instructions: {
      criterion,
      question:
        "Does `criterion` hold for the company described in `company`? Use `website.text` as evidence, and what is commonly true of businesses like it where the evidence is indirect.",
    },
    criteria: {
      true: "The criterion clearly or very probably holds for this company.",
      false: "The criterion clearly or very probably does not hold for this company.",
    },
  };
}

export type ChoiceOption = { key: string; label: string; description?: string };
export const NONE_OPTION = "none";

export function choiceQuestion(instructions: string, options: ChoiceOption[]): SystemOneQuestion {
  const criteria: Record<string, string> = {};
  for (const o of options) criteria[o.key] = o.description ? `${o.label}: ${o.description}` : o.label;
  criteria[NONE_OPTION] = "None of the other options fits this company.";
  return { type: "choice", instructions: { question: instructions, about: "The company in `company`, with `website.text` as evidence." }, criteria };
}

export const optionKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
/** Choice options Jev picks between; more than this dilutes every probability. */
export const MAX_JTBD_OPTIONS = 12;

type ResearchSegment = { archetype: string; label: string; why: string };
export type ResearchSegments = { jobs: string[]; buyers: ResearchSegment[]; adjacent: ResearchSegment[] };

/**
 * Jobs-to-be-done options: the jobs onboarding research found for the vendor,
 * or its buyer types when research produced no jobs.
 */
export function jtbdOptions(ms: ResearchSegments | undefined | null): { from: "jobs" | "buyers"; options: ChoiceOption[] } {
  const seen = new Set<string>();
  const add = (into: ChoiceOption[], option: ChoiceOption) => {
    if (!option.key || option.key === NONE_OPTION || seen.has(option.key) || into.length >= MAX_JTBD_OPTIONS) return;
    seen.add(option.key);
    into.push(option);
  };
  const jobs: ChoiceOption[] = [];
  for (const job of ms?.jobs ?? []) {
    const text = job.trim();
    add(jobs, { key: optionKey(text), label: text.charAt(0).toUpperCase() + text.slice(1) });
  }
  if (jobs.length) return { from: "jobs", options: jobs };
  const buyers: ChoiceOption[] = [];
  for (const s of ms ? [...ms.buyers, ...ms.adjacent] : []) {
    add(buyers, { key: optionKey(s.archetype), label: s.label || archetypeLabel(s.archetype), description: s.why || undefined });
  }
  return { from: "buyers", options: buyers };
}

/** The trait value an answer becomes. */
export function bucketFor(answer: SystemOneAnswer): string {
  if (answer.type === "noul") return answer.noul >= YES_AT ? "yes" : answer.noul <= NO_AT ? "no" : UNSURE;
  const top = answer.probabilities[answer.choice] ?? 0;
  return top < CHOICE_MIN_P ? UNSURE : answer.choice;
}

export const REVENUE_BANDS = [
  { key: "under-1m", label: "Under $1M", value: 500_000 },
  { key: "1m-10m", label: "$1M–$10M", value: 3_000_000 },
  { key: "10m-50m", label: "$10M–$50M", value: 22_000_000 },
  { key: "50m-100m", label: "$50M–$100M", value: 70_000_000 },
  { key: "100m-500m", label: "$100M–$500M", value: 220_000_000 },
  { key: "500m-1b", label: "$500M–$1B", value: 700_000_000 },
  { key: "over-1b", label: "Over $1B", value: 3_000_000_000 },
] as const;

export function revenueQuestion(): SystemOneQuestion {
  return {
    type: "choice",
    instructions: {
      question: "What is this company's most likely annual revenue?",
      about: "The company in `company` (employee count, industry and country are strong signals), with `website.text` as evidence.",
    },
    criteria: Object.fromEntries(REVENUE_BANDS.map((b) => [b.key, `${b.label} in annual revenue`])),
  };
}

export function revenueFrom(answer: SystemOneAnswer): { revenue: number; confidence: number } | null {
  if (answer.type !== "choice") return null;
  const band = REVENUE_BANDS.find((b) => b.key === answer.choice);
  return band ? { revenue: band.value, confidence: answer.confidence } : null;
}

/** Trait keys from labels: "Employs commissioned reps" -> "employs-commissioned-reps". */
export function traitKeyFor(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "segment";
  const key = /^[a-z0-9]/.test(base) ? base : `s-${base}`;
  if (!taken.has(key) && key !== "jtbd") return key;
  for (let i = 2; ; i++) if (!taken.has(`${key}-${i}`)) return `${key}-${i}`;
}

/** Rough Jev cost: input tokens are billed (https://docs.typesafe.ai/models); ~2k per account. */
export const EST_TOKENS_PER_ACCOUNT = 2000;
export const JEV_USD_PER_MTOK = 0.042;
