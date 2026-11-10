/**
 * Probe runs (docs/research-agent-patterns.md, R1): before a full run, a field
 * researches a random PROBE_SIZE of the records that run would touch, and the
 * outcome says whether the question works on this scope. Probe answers go
 * through the normal gate, so they are the run's first slice, not a throwaway.
 * Node-free: imported by convex/researchAgents.ts and the UI.
 */
import type { SystemOneAnswer, SystemOneQuestion } from "../segments/jev";
import { aboutPerson } from "./agentLoop.ts";

/** Records a probe researches. */
export const PROBE_SIZE = 25;
/** Fewer settled records than this and a probe says nothing. */
export const PROBE_MIN = 5;
/** Ready when at least this share of settled records got an answer. */
const READY_SHARE = 0.6;
/** Undecidable when at least this share of settled records got none. */
const UNDECIDABLE_SHARE = 0.5;
/** Doesn't split when one value takes at least this share of the answers. */
const ONE_VALUE_SHARE = 0.9;

export type ProbeStatus = "answered" | "unknown" | "no_evidence" | "rejected" | "error";
/** Jev's read of one record: its pick and the probability of every option ("true"/"false" for yes/no fields). */
export type JevRead = { choice: string; confidence: number; probabilities: Record<string, number> };
export type ProbeRow = { status?: ProbeStatus; value?: string | number | boolean; jev?: JevRead; inferred?: boolean };

export type ProbeVerdict = {
  kind: "pending" | "too_few" | "ready" | "mixed" | "undecidable" | "doesnt_split";
  /** Records researched to an outcome (errors left out: a later run retries them). */
  settled: number;
  answered: number;
  /** The most common answer and its share of answers, for classify and yes/no fields. */
  top: { value: string | number | boolean; share: number } | null;
  /** Jev's reads of the sample, when the field is classify or yes/no and Jev ran. */
  jev: JevSummary | null;
};

/** Confidence at or above this counts as a confident read (the gate's default auto-accept threshold). */
export const JEV_CONFIDENT = 0.8;

export type JevSummary = {
  read: number;
  /** Records per pick, most common first, with how many of them were confident. */
  picks: Array<{ choice: string; count: number; confident: number }>;
  /** Reads by confidence band: at least JEV_CONFIDENT, at least 0.6, below. */
  bands: { high: number; mid: number; low: number };
};

export function jevSummary(rows: readonly ProbeRow[]): JevSummary | null {
  const reads = rows.flatMap((r) => (r.jev ? [r.jev] : []));
  if (!reads.length) return null;
  const by = new Map<string, { count: number; confident: number }>();
  const bands = { high: 0, mid: 0, low: 0 };
  for (const j of reads) {
    const e = by.get(j.choice) ?? { count: 0, confident: 0 };
    e.count++;
    if (j.confidence >= JEV_CONFIDENT) { e.confident++; bands.high++; } else if (j.confidence >= 0.6) bands.mid++; else bands.low++;
    by.set(j.choice, e);
  }
  const picks = [...by.entries()].map(([choice, e]) => ({ choice, ...e })).sort((a, b) => b.count - a.count);
  return { read: reads.length, picks, bands };
}

/**
 * What a probe's rows say about the field. Errors don't count either way. A
 * finished probe judges whatever settled, so a stopped one still reads.
 */
export function probeVerdict(rows: ProbeRow[], field: { kind: "classify" | "qa"; answerType?: string | null }, finished: boolean): ProbeVerdict {
  const settled = rows.filter((r) => r.status && r.status !== "error");
  const answered = settled.filter((r) => r.status === "answered" && r.value !== undefined);
  const counts = new Map<string | number | boolean, number>();
  for (const r of answered) counts.set(r.value!, (counts.get(r.value!) ?? 0) + 1);
  const [topValue, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const categorical = field.kind === "classify" || field.answerType === "boolean";
  const top = categorical && topValue !== null ? { value: topValue, share: topCount / answered.length } : null;
  const out = { settled: settled.length, answered: answered.length, top, jev: jevSummary(rows) };
  if (!finished && (!rows.length || rows.some((r) => !r.status))) return { kind: "pending", ...out };
  if (settled.length < PROBE_MIN) return { kind: "too_few", ...out };
  const share = answered.length / settled.length;
  if (1 - share >= UNDECIDABLE_SHARE) return { kind: "undecidable", ...out };
  if (top && answered.length >= PROBE_MIN && top.share >= ONE_VALUE_SHARE) return { kind: "doesnt_split", ...out };
  return { kind: share >= READY_SHARE ? "ready" : "mixed", ...out };
}

/** `n` items of `pool` in random order (a partial Fisher-Yates shuffle); `rand` is for tests. */
export function pickSample<T>(pool: readonly T[], n: number, rand: () => number = Math.random): T[] {
  const a = [...pool];
  const k = Math.min(n, a.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

/** Characters of evidence Jev reads per record. */
const JEV_STATE_CHARS = 6000;
const AROUND = 400;

/**
 * What Jev reads to classify one record: who and where, then excerpts of what the research read.
 * About a person: the passages that name them in full come first, then the start of pages from their
 * company's site or about them; a search result about someone else with their surname is left out.
 */
export function jevStateFor(
  subject: { name: string; domain: string; person?: { name: string; title?: string } },
  pages: ReadonlyArray<{ url: string; text: string }>,
): Record<string, unknown> {
  const parts: string[] = [];
  let left = JEV_STATE_CHARS;
  const add = (url: string, text: string) => {
    if (left <= 0 || !text.trim()) return;
    const t = text.slice(0, left);
    parts.push(`[${url}] ${t}`);
    left -= t.length;
  };
  const person = subject.person;
  const fullName = person && namePattern(person.name);
  if (fullName) {
    for (const p of pages) {
      for (const m of p.text.matchAll(fullName)) {
        if (left <= 0) break;
        add(p.url, p.text.slice(Math.max(0, (m.index ?? 0) - AROUND), (m.index ?? 0) + AROUND));
      }
    }
  }
  const ownSite = (url: string) => { try { const h = new URL(url).hostname.toLowerCase(); return h === subject.domain || h.endsWith(`.${subject.domain}`); } catch { return false; } };
  for (const p of pages) if (!person || ownSite(p.url) || aboutPerson(p, person.name)) add(p.url, p.text.slice(0, 1200));
  return {
    ...(person ? { person: { name: person.name, ...(person.title ? { title: person.title } : {}) } } : {}),
    company: { name: subject.name, domain: subject.domain },
    evidence: parts,
  };
}

/**
 * Whether Jev has anything to read about the record. About a person: a title on the record, a page
 * that names them in full, or a page about them; otherwise Jev only knows their employer and parks
 * them in a catch-all option with false confidence. About a company: any page read.
 */
export function jevGrounded(
  subject: { name: string; domain: string; person?: { name: string; title?: string } },
  pages: ReadonlyArray<{ url: string; text: string }>,
): boolean {
  const person = subject.person;
  if (!person) return pages.some((p) => p.text.trim());
  if (person.title?.trim()) return true;
  const full = namePattern(person.name);
  return pages.some((p) => aboutPerson(p, person.name) || (!!full && new RegExp(full.source, "iu").test(p.text)));
}

/** A person's first and last name as written on a page (a middle initial allowed), matched globally; null for a one-word name. */
function namePattern(name: string): RegExp | null {
  const words = name.trim().split(/\s+/).filter((w) => !/^(?:jr|sr|ii|iii|iv|phd|md|mba)\.?$/i.test(w));
  if (words.length < 2) return null;
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}])${esc(words[0])}\\s+(?:\\p{L}\\.?\\s+)?${esc(words[words.length - 1])}(?![\\p{L}])`, "giu");
}

/** The Jev question for a field: a choice over a classify field's options, a yes/no for a boolean question; null otherwise. */
export function jevQuestionFor(spec: { kind: "classify" | "qa"; question: string; answerType?: string; options?: Array<{ key: string; label: string; description?: string }>; entityType?: "account" | "contact" }): SystemOneQuestion | null {
  const about = spec.entityType === "contact" ? "this person" : "this company";
  if (spec.kind === "classify" && spec.options?.length) {
    return {
      type: "choice",
      instructions: `About ${about}: ${spec.question}`,
      criteria: Object.fromEntries(spec.options.map((o) => [o.key, o.description ? `${o.label}: ${o.description}` : o.label])),
    };
  }
  if (spec.answerType === "boolean") return { type: "noul", instructions: `About ${about}: ${spec.question}` };
  return null;
}

/** A Jev answer as a read: a choice as is; a yes/no probability as "true"/"false". */
export function jevReadOf(a: SystemOneAnswer): JevRead {
  if (a.type === "choice") return { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
  const p = Math.min(1, Math.max(0, a.noul));
  return { choice: p >= 0.5 ? "true" : "false", confidence: Math.max(p, 1 - p), probabilities: { true: p, false: 1 - p } };
}

/**
 * Where no page states the answer, a Jev read at least this confident is proposed as the answer
 * (the write gate still decides: auto-accept needs its own Jev check of the evidence). Below it the
 * record stays unknown.
 */
export const JEV_INFER_MIN = 0.6;

/** A Jev pick as the field's value: a classify option's key, or a yes/no; null when it is neither. */
export function inferredValue(spec: { kind: "classify" | "qa"; answerType?: string; options?: Array<{ key: string }> }, choice: string): string | boolean | null {
  if (spec.kind === "classify") return spec.options?.some((o) => o.key === choice) ? choice : null;
  if (spec.answerType === "boolean") return choice === "true" ? true : choice === "false" ? false : null;
  return null;
}

/** An excerpt cut at word boundaries, still word for word from its page. */
function excerpt(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2))}…`;
}

/**
 * The evidence of an answer Jev inferred: what it read, quoted word for word (the person's title on
 * the record, then the passages it read first), ending "Source: <url> (inferred by Jev)" so readers
 * (ai-cell.tsx quoteAndSource) can tell it from a stated answer.
 */
export function inferredEvidence(
  subject: { name: string; domain: string; person?: { name: string; title?: string } },
  pages: ReadonlyArray<{ url: string; text: string }>,
  read: JevRead,
): string {
  const lines = [`Inferred by Jev (${read.confidence.toFixed(2)}): no page read states it outright. What it read:`];
  if (subject.person?.title) lines.push(`Title on the record: "${subject.person.title}"`);
  const passages = (jevStateFor(subject, pages).evidence as string[]).slice(0, 2);
  let source = "";
  for (const p of passages) {
    const m = p.match(/^\[(\S+)\] ([\s\S]*)$/);
    if (!m) continue;
    source ||= m[1];
    lines.push(`"${excerpt(m[2], 280)}" (${m[1]})`);
  }
  return `${lines.join("\n")}\n\nSource: ${source || "record"} (inferred by Jev)`;
}
