/**
 * Who a meeting attendee on personal email is (convex/callSuggestionActions.ts runs it): the search
 * queries, the prompt over what the searches found, and the check that keeps only an identification
 * quoted word for word from a page or search result that names the person. Search engines find the
 * pages; Canon proves the answer, as research agents do (docs/research-agent-patterns.md).
 *
 * Pure: no database access, no Node-only imports.
 */
import { FREE_EMAIL_DOMAINS } from "../../../engine/src/freeEmailDomains.ts";
import { domainOfEmail } from "./granola.ts";

/** Searches one identification makes, and the text of each page the prompt sees. */
export const WHO_IS_QUERIES = 3;
const PAGE_TEXT_MAX = 4000;
/** People one meeting researches when its suggestions are made; the rest can be researched from the panel. */
export const WHO_IS_PER_MEETING = 5;

export type WhoIsPerson = { email: string; name: string | null };
/** A source: a searched page or result, or the meeting's own transcript (`transcript` says how its lines are attributed). */
export type WhoIsPage = { url: string; text: string; snippet?: boolean; transcript?: { ownerLabel: string; oneOnOne: boolean } };
/** The meeting, as research reads it: the owner's side is labelled `ownerLabel` in the transcript. */
export type WhoIsMeeting = { title: string; summary: string | null; transcript?: string | null; ownerLabel?: string; oneOnOne?: boolean; webUrl?: string | null };
/** Transcript text one identification reads, and companies it may add to the searches. */
const EXCERPT_MAX = 6000;
const HINTS_MAX = 2;
export type Identity = {
  fullName: string;
  title?: string;
  companyName: string;
  companyDomain: string;
  linkedinUrl?: string;
  /** Word for word from `sourceUrl`, naming the person. */
  quote: string;
  sourceUrl: string;
};

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/**
 * The name to search for: the attendee's, when it has a first and last name; else one read from the
 * address (alex.rivera@gmail.com → Alex Rivera); else the single name Granola gave, which only an exact
 * address match can confirm (see groundedIdentity).
 */
export function searchName(p: WhoIsPerson): { name: string; full: boolean } {
  const given = p.name?.trim().replace(/\s+/g, " ") ?? "";
  if (given.split(" ").length >= 2) return { name: given, full: true };
  const local = p.email.slice(0, p.email.indexOf("@")).replace(/\d+/g, "").toLowerCase();
  const parts = local.split(/[._-]+/).filter((w) => /^[a-z]{2,}$/i.test(w));
  if (parts.length >= 2) return { name: parts.slice(0, 3).map(cap).join(" "), full: true };
  // A first name known and run together with the rest of the address: alexrivera21 → Alex Rivera, riveraalex → Alex Rivera.
  const first = given.toLowerCase();
  const joined = parts[0] ?? "";
  if (/^[a-z]{2,}$/.test(first) && joined.length >= first.length + 2) {
    if (joined.startsWith(first)) return { name: `${cap(first)} ${cap(joined.slice(first.length))}`, full: true };
    if (joined.endsWith(first)) return { name: `${cap(first)} ${cap(joined.slice(0, -first.length))}`, full: true };
  }
  return { name: given || local, full: false };
}

/**
 * What the person said in the meeting, and what was said about them: in a one-on-one, every line from the
 * other side; otherwise lines labelled with their name or naming them. Empty without a transcript.
 */
export function meetingExcerpt(p: WhoIsPerson, meeting: WhoIsMeeting): string {
  if (!meeting.transcript) return "";
  const first = fold(searchName(p).name.split(" ")[0] ?? "");
  const owner = fold(meeting.ownerLabel ?? "");
  const lines = meeting.transcript.split("\n").filter((line) => {
    // A line without a speaker is no one's: never the other side's by default.
    if (line.indexOf(":") <= 0) return false;
    const label = fold(line.slice(0, line.indexOf(":")));
    if (meeting.oneOnOne) return label !== owner;
    return (first.length >= 2 && (label.split(" ")[0] === first || fold(line).includes(first)));
  });
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 1 > EXCERPT_MAX) break;
    out += `${line}\n`;
  }
  return out.trim();
}

/** The meeting transcript as a source, attributed as meetingExcerpt reads it. */
export function transcriptSource(p: WhoIsPerson, meeting: WhoIsMeeting): WhoIsPage | null {
  const text = meetingExcerpt(p, meeting);
  return text ? { url: meeting.webUrl || "meeting-transcript", text, transcript: { ownerLabel: meeting.ownerLabel ?? "", oneOnOne: Boolean(meeting.oneOnOne) } } : null;
}

/** Companies the meeting ties the person to, for the searches: the model's read of the excerpt, at most a couple. */
export const WHO_IS_HINT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { companies: { type: "array", items: { type: "string" } } },
  required: ["companies"],
} as const;

export function hintPrompt(p: WhoIsPerson, excerpt: string): string {
  return [
    `Here is what ${searchName(p).name} said in a meeting (or what was said about them). List the companies they work for, run, or represent (not tools or vendors they merely use), at most ${HINTS_MAX}. An empty list if none is said.`,
    excerpt,
  ].join("\n\n");
}

export function hintsOf(raw: unknown): string[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { companies?: unknown }).companies) ? (raw as { companies: unknown[] }).companies : [];
  return list.flatMap((c) => (typeof c === "string" && c.trim() && c.length <= 80 ? [c.trim().replace(/["<>]/g, "")] : [])).slice(0, HINTS_MAX);
}

export function whoIsQueries(p: WhoIsPerson, meeting: { title: string }, hints: readonly string[] = []): string[] {
  const { name } = searchName(p);
  return [`"${name}" LinkedIn`, ...hints.map((c) => `"${name}" ${c}`), `"${p.email}"`, `"${name}" ${meeting.title.replace(/["<>/]/g, " ").slice(0, 60)}`]
    .map((q) => q.replace(/\s+/g, " ").trim())
    .filter((q, i, all) => q && all.indexOf(q) === i)
    .slice(0, WHO_IS_QUERIES + Math.min(hints.length, HINTS_MAX));
}

export const WHO_IS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    fullName: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
    companyName: { type: ["string", "null"] },
    companyDomain: { type: ["string", "null"], description: "The current employer's website domain, such as acme.com; give the one you know when the sources don't show it (Canon checks it)" },
    linkedinUrl: { type: ["string", "null"] },
    quote: { type: ["string", "null"] },
    sourceUrl: { type: ["string", "null"] },
  },
  required: ["found", "fullName", "title", "companyName", "companyDomain", "linkedinUrl", "quote", "sourceUrl"],
} as const;

export function whoIsPrompt(p: WhoIsPerson, meeting: WhoIsMeeting, pages: readonly WhoIsPage[]): string {
  const { name } = searchName(p);
  return [
    `Identify one specific person for a CRM: ${name} <${p.email}>, who attended a meeting titled "${meeting.title}".`,
    meeting.summary ? `What the meeting covered:\n${meeting.summary.slice(0, 1500)}` : "",
    "From the sources below only, say who this person is professionally: their full name, current job title, current employer, and their LinkedIn profile URL if a source shows it. For the employer's website domain, use the one a source shows, else the company's domain you know; Canon visits it to check.",
    "Set found to true when the sources point to one professional with this name (for example a LinkedIn result or a page about them). The meeting is only a tie-breaker: use it to choose when the sources show several different people with this name, and set found to false if you still cannot tell which one it is. Never guess an employer the sources don't state.",
    "`quote` must be copied word for word from one source and must name both the person and their employer (a LinkedIn result title such as \"Jane Doe - VP Sales - Acme | LinkedIn\" does). From the meeting transcript, a line where the person says where they work counts (\"We at Acme...\"). `sourceUrl` is that source's URL as listed.",
    ...pages.map((pg, i) => `Source ${i + 1}: ${pg.url}${pg.transcript ? " (what was said in the meeting; each line starts with its speaker)" : pg.snippet ? " (search result)" : ""}\n${pg.text.slice(0, pg.transcript ? EXCERPT_MAX : PAGE_TEXT_MAX)}`),
  ].filter(Boolean).join("\n\n");
}

const fold = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

/** The employer's name as the check against its own website reads it: its first word, lowercased. */
export const companyKey = (companyName: string) => fold(companyName).split(/\s+/)[0] ?? "";

/**
 * Whether `domain` is this employer's site: a searched page sits on it, or its homepage (fetched by the
 * caller) names the company. A domain the model knew but nothing confirms is not used.
 */
export function domainConfirmed(identity: Pick<Identity, "companyName" | "companyDomain">, pages: readonly WhoIsPage[], homepageText: string | null): boolean {
  const onSite = pages.some((pg) => {
    try { return new URL(pg.url).hostname.replace(/^www\./, "") === identity.companyDomain; } catch { return false; }
  });
  const key = companyKey(identity.companyName);
  return onSite || Boolean(homepageText && key.length >= 2 && fold(homepageText).includes(key));
}

/** A website domain, bare and lowercased; null for anything else or free mail. */
export function companyDomainOf(raw: string | null): string | null {
  if (!raw) return null;
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !FREE_EMAIL_DOMAINS.has(host) && host !== "linkedin.com" ? host : null;
}

/**
 * The model's identification, kept only when its quote is word for word in the source it cites, among
 * the pages searched, and names the person: their full name, or, when only a first name is known, their
 * exact address. The employer must be a real company domain (not free mail, not LinkedIn), and a
 * LinkedIn URL is kept only when the searches turned it up.
 */
export function groundedIdentity(raw: unknown, p: WhoIsPerson, pages: readonly WhoIsPage[]): Identity | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (r.found !== true) return null;
  const quote = str(r.quote);
  const sourceUrl = str(r.sourceUrl);
  const page = pages.find((pg) => pg.url === sourceUrl);
  if (!quote || !page || !fold(page.text).includes(fold(quote))) return null;
  const { name, full } = searchName(p);
  // The person: their first and last name as words (a middle name or initial may sit between), or, with only a
  // first name known, their exact address. A quote from the meeting itself is theirs when its line is: in a
  // one-on-one, any line from the other side; otherwise a line labelled with their first name.
  const words = new Set(fold(quote).split(/[^a-z0-9@.'-]+/));
  const tokens = fold(name).split(" ").filter(Boolean);
  const said = page.transcript ? page.text.split("\n").find((line) => line.indexOf(":") > 0 && fold(line).includes(fold(quote))) : undefined;
  const speaker = said ? fold(said.slice(0, Math.max(0, said.indexOf(":")))) : "";
  const theirs = Boolean(page.transcript && said && (page.transcript.oneOnOne ? speaker !== fold(page.transcript.ownerLabel) : speaker.split(" ")[0] === tokens[0]));
  const names = theirs || (full ? words.has(tokens[0]!) && words.has(tokens[tokens.length - 1]!) : fold(quote).includes(p.email.toLowerCase()));
  if (!names) return null;
  const companyName = str(r.companyName)?.slice(0, 120);
  const companyDomain = companyDomainOf(str(r.companyDomain));
  if (!companyName || !companyDomain || companyDomain === domainOfEmail(p.email)) return null;
  // The employer: the quote must tie them to it, by its name's first word or its domain's label.
  const firstWord = fold(companyName).split(/\s+/)[0] ?? "";
  const label = companyDomain.split(".")[0]!;
  if (!(firstWord.length >= 2 && fold(quote).includes(firstWord)) && !fold(quote).includes(label)) return null;
  const linkedin = str(r.linkedinUrl);
  const seen = linkedin && /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\//i.test(linkedin) && pages.some((pg) => pg.url.replace(/\/$/, "") === linkedin.replace(/\/$/, ""));
  return {
    fullName: str(r.fullName)?.slice(0, 120) ?? name,
    ...(str(r.title) ? { title: str(r.title)!.slice(0, 120) } : {}),
    companyName, companyDomain,
    ...(seen ? { linkedinUrl: linkedin! } : {}),
    quote: quote.slice(0, 500), sourceUrl: sourceUrl!,
  };
}

/** A company the meeting names (often only a short name, "Example Buyer"): its full name and confirmed website. */
export type CompanyIdentity = { companyName: string; companyDomain: string; quote: string; sourceUrl: string };

export function companyQueries(name: string, hint: string): string[] {
  return [`"${name}" ${hint}`, `"${name}" company`, `"${name}" LinkedIn company`]
    .map((q) => q.replace(/["<>]/g, (ch) => (ch === '"' ? ch : " ")).replace(/\s+/g, " ").trim())
    .filter((q, i, all) => q.length > 4 && all.indexOf(q) === i)
    .slice(0, WHO_IS_QUERIES);
}

export const COMPANY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    companyName: { type: ["string", "null"] },
    companyDomain: { type: ["string", "null"], description: "Its website domain, such as acme.com; give the one you know when the sources don't show it (Canon checks it)" },
    quote: { type: ["string", "null"] },
    sourceUrl: { type: ["string", "null"] },
  },
  required: ["found", "companyName", "companyDomain", "quote", "sourceUrl"],
} as const;

export function companyPrompt(name: string, hint: string, said: string, pages: readonly WhoIsPage[]): string {
  return [
    `A sales meeting was with a company called "${name}" (${hint}). What the meeting said about it: "${said}"`,
    "From the sources below, identify that company: its full name and its website domain. Set found to false if the sources describe different companies with this name and none fits what the meeting said.",
    "`quote` must be copied word for word from one source and name the company; `sourceUrl` is that source's URL.",
    ...pages.map((pg, i) => `Source ${i + 1}: ${pg.url}${pg.snippet ? " (search result)" : ""}\n${pg.text.slice(0, PAGE_TEXT_MAX)}`),
  ].join("\n\n");
}

/** The company, kept when its quote is in the source it cites and names it as the meeting did. Its website is confirmed by the caller (domainConfirmed). */
export function groundedCompany(raw: unknown, name: string, pages: readonly WhoIsPage[]): CompanyIdentity | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (r.found !== true) return null;
  const quote = str(r.quote);
  const sourceUrl = str(r.sourceUrl);
  const page = pages.find((pg) => pg.url === sourceUrl);
  if (!quote || !page || !fold(page.text).includes(fold(quote))) return null;
  if (!fold(quote).includes(companyKey(name))) return null;
  const companyName = str(r.companyName)?.slice(0, 120) ?? name;
  const companyDomain = companyDomainOf(str(r.companyDomain));
  return companyDomain ? { companyName, companyDomain, quote: quote.slice(0, 500), sourceUrl: sourceUrl! } : null;
}

/** Who someone the meeting names only by first name is, at the company it was with. */
export function atCompanyQueries(name: string, companyName: string): string[] {
  return [`"${name}" "${companyName}" LinkedIn`, `"${name}" ${companyName}`].map((q) => q.replace(/\s+/g, " ").trim());
}

export function atCompanyPrompt(name: string, company: CompanyIdentity, said: string, pages: readonly WhoIsPage[]): string {
  return [
    `A meeting with ${company.companyName} (${company.companyDomain}) named "${name}" from that company: "${said}"`,
    "From the sources below only, find that person: their full name, current job title, and LinkedIn profile URL if a source shows it. Set found to false unless one person with that name works at that company.",
    "`quote` must be copied word for word from one source and name both the person and the company; `sourceUrl` is that source's URL. Use the company's name and domain as given.",
    ...pages.map((pg, i) => `Source ${i + 1}: ${pg.url}${pg.snippet ? " (search result)" : ""}\n${pg.text.slice(0, PAGE_TEXT_MAX)}`),
  ].join("\n\n");
}

export type NamedPerson = { fullName: string; title?: string; linkedinUrl?: string; quote: string; sourceUrl: string };

/**
 * The person, kept when the quote is in its source and names them (their first name, or a longer form of it:
 * Court → Courtney) and the company. Their full name must start with the name the meeting used.
 */
export function groundedAtCompany(raw: unknown, name: string, company: CompanyIdentity, pages: readonly WhoIsPage[]): NamedPerson | null {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (r.found !== true) return null;
  const quote = str(r.quote);
  const sourceUrl = str(r.sourceUrl);
  const page = pages.find((pg) => pg.url === sourceUrl);
  if (!quote || !page || !fold(page.text).includes(fold(quote))) return null;
  const first = fold(name).split(" ")[0] ?? "";
  const fullName = str(r.fullName)?.slice(0, 120);
  if (!fullName || !fold(fullName).startsWith(first) || fold(fullName).split(" ").length < 2) return null;
  const quoteWords = fold(quote).split(/[^a-z0-9'-]+/);
  if (!quoteWords.some((w) => w.startsWith(first)) || !fold(quote).includes(companyKey(company.companyName)) && !fold(quote).includes(company.companyDomain.split(".")[0]!)) return null;
  const linkedin = str(r.linkedinUrl);
  const seen = linkedin && /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\//i.test(linkedin) && pages.some((pg) => pg.url.replace(/\/$/, "") === linkedin.replace(/\/$/, ""));
  return {
    fullName, ...(str(r.title) ? { title: str(r.title)!.slice(0, 120) } : {}), ...(seen ? { linkedinUrl: linkedin! } : {}),
    quote: quote.slice(0, 500), sourceUrl: sourceUrl!,
  };
}
