import { CREDIT_RATES } from "../creditPacks.ts";
import { webPersonNameKey } from "./webPeople.ts";

export type BuyerRole = "decision_maker" | "champion" | "other";
export type Classification = { role: BuyerRole; reasoning: string };
export type FoundPerson = { fullName: string; title?: string; headline?: string; linkedinUrl?: string; url: string; quote?: string };
export type EmailCheck = { email: string | null; emailStatus: "valid" | "catch_all" | "invalid" | "not_checked" };
export const FINDER_STEPS = [
  { source: "linkedin_titles", label: "LinkedIn buyer titles", paid: false },
  { source: "linkedin_any", label: "LinkedIn anyone at the company", paid: false },
  { source: "website_staff", label: "Company website", paid: false },
  { source: "review_replies", label: "Signed Google review replies", paid: true },
  { source: "exa_owner", label: "Exa owner answer", paid: true },
] as const;
export type PeopleSource = typeof FINDER_STEPS[number]["source"];
export type KeptPerson = FoundPerson & Classification & EmailCheck & { source: PeopleSource; sendable: boolean; contactId: string };
export type BuyerContext = { companyType: string; whatYouSell: string; buyerTitles: string[]; departments: string[] };
export const PEOPLE_LIMIT = 5;
export const peopleEstimate = (limit = PEOPLE_LIMIT) => limit * (CREDIT_RATES.contact + CREDIT_RATES.verifiedEmail);
export const personCredits = (person: EmailCheck) => CREDIT_RATES.contact + (person.email && person.emailStatus === "valid" ? CREDIT_RATES.verifiedEmail : 0);

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const phraseIn = (text: string, phrase: string) => Boolean(words(phrase)) && ` ${words(text)} `.includes(` ${words(phrase)} `);
export const DEFAULT_BUYER_TITLES = ["owner", "founder", "president", "CEO", "chief executive officer", "general manager", "estimator"];
const DEPARTMENT_TITLES: Record<string, string[]> = {
  engineering: ["engineering", "engineer", "development", "developer"],
  estimating: ["estimating", "estimator"], operations: ["operations", "ops"],
  finance: ["finance", "financial", "accounting"], sales: ["sales"], marketing: ["marketing"],
  "information technology": ["information technology", "IT"], it: ["information technology", "IT"],
  "human resources": ["human resources", "HR", "people", "talent"],
};

export async function classifyPerson(person: FoundPerson, context: BuyerContext, model?: (prompt: string) => Promise<Classification>): Promise<Classification> {
  const title = person.title ?? "";
  const match = [...DEFAULT_BUYER_TITLES, ...context.buyerTitles].find((keyword) => phraseIn(title, keyword));
  if (match) return { role: "decision_maker", reasoning: `Title matches ${match}.` };
  const buyingDepartments = context.departments.flatMap((department) => DEPARTMENT_TITLES[words(department)] ?? [department]);
  if (["manager", "lead", "head"].some((word) => phraseIn(title, word)) && buyingDepartments.some((department) => phraseIn(title, department))) {
    return { role: "champion", reasoning: "Manages or leads the buying department." };
  }
  if (model) {
    try {
      const answer = await model(`Company type: ${context.companyType}. We sell: ${context.whatYouSell}. Here is a person's title and headline: ${title}, ${person.headline ?? ""}. Are they a decision maker, a champion, or neither for this purchase? Answer with one word and one sentence of reasoning.`);
      if (["decision_maker", "champion", "other"].includes(answer.role) && answer.reasoning.trim()) return { role: answer.role, reasoning: answer.reasoning.trim().slice(0, 600) };
    } catch { /* A model outage still leaves a person worth keeping. */ }
  }
  return { role: "other", reasoning: "No qualified title was established." };
}

export type PeoplePorts = {
  paid: boolean; address?: string; context: BuyerContext;
  find: (source: PeopleSource) => Promise<FoundPerson[]>;
  suppressed: (name: string) => Promise<boolean>;
  existing: (person: FoundPerson) => boolean;
  model?: (prompt: string) => Promise<Classification>;
  email: (person: FoundPerson) => Promise<EmailCheck>;
  keep: (person: Omit<KeptPerson, "contactId">) => Promise<string | null>;
};

export async function findCompanyPeople(ports: PeoplePorts) {
  const candidates = new Map<string, FoundPerson & Classification & { source: PeopleSource }>();
  const notes: string[] = [];
  const sourceCounts = Object.fromEntries(FINDER_STEPS.map((step) => [step.source, 0])) as Record<PeopleSource, number>;
  for (const step of FINDER_STEPS) {
    if (step.paid && !ports.paid) { notes.push(`${step.label} skipped because paid calls are off.`); continue; }
    if (step.source === "exa_owner" && (!ports.address || [...candidates.values()].some((p) => p.role === "decision_maker"))) continue;
    try {
      for (const person of (await ports.find(step.source)).slice(0, 100)) {
        const key = webPersonNameKey(person.fullName);
        if (!key || await ports.suppressed(person.fullName)) continue;
        const prior = candidates.get(key);
        if (prior && (prior.role !== "other" || person.title === prior.title)) continue;
        const classified = await classifyPerson(person, ports.context, ports.model);
        if (!prior || classified.role !== "other") candidates.set(key, { ...person, ...classified, source: step.source });
      }
    } catch { notes.push(`${step.label} was unavailable. Other sources continued.`); }
  }
  const all = [...candidates.values()];
  const qualified = all.filter((p) => p.role !== "other");
  const selected = (qualified.length ? qualified : all.slice(0, 1)).filter((p) => !ports.existing(p))
    .sort((a, b) => Number(b.role === "decision_maker") - Number(a.role === "decision_maker")).slice(0, PEOPLE_LIMIT);
  const people: KeptPerson[] = [];
  let credits = 0;
  if (!ports.paid) notes.push("Paid email verification skipped because paid calls are off. No email credits charged.");
  for (const person of selected) {
    if (await ports.suppressed(person.fullName)) continue;
    let email: EmailCheck = { email: null, emailStatus: "not_checked" };
    if (ports.paid) {
      try { email = await ports.email(person); }
      catch { notes.push(`Email lookup for ${person.fullName} was unavailable. No email credits charged.`); }
    }
    if (await ports.suppressed(person.fullName)) continue;
    const kept = { ...person, ...email, sendable: email.emailStatus === "valid" && Boolean(email.email) };
    const contactId = await ports.keep(kept);
    if (!contactId) continue;
    people.push({ ...kept, contactId });
    credits += personCredits(kept);
    sourceCounts[person.source]++;
  }
  return { people, sourceCounts, notes, credits };
}

/** A reviewer name is never used. Only a full name on the final signature line qualifies. */
export function signedReviewReplies(replies: Array<{ text: string; url: string }>): FoundPerson[] {
  return replies.flatMap(({ text, url }) => {
    const match = text.match(/(?:\n|\s[-–—]\s)(?:thanks[,!]?\s*|regards[,!]?\s*|sincerely[,!]?\s*)?([\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){1,3})(?:\s*[,|–—-]\s*(?:owner|founder))?[.!]?\s*$/u);
    return match && !/^(best regards|thank you|customer service|the team)$/i.test(match[1]) ? [{ fullName: match[1], title: "Owner", url, quote: text.slice(-2000) }] : [];
  });
}
