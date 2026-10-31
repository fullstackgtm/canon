/**
 * Research on the people at a deal's account (issue #394): what each one is trying to do, which systems they run,
 * and what the seller's product would let them do that their current tools can't.
 *
 * The first two are contact AI fields (researchAgents): researched on the web, each answer resting on a quote, and
 * shared by every deal and the contacts list. The last two are this deal's reading of those answers, kept on the
 * play's people notes: Jev classifies whether the person runs an innovation or a stability remit, and the model
 * writes the new capability as a hypothesis from the answers and the seller's product. Neither is a CRM fact.
 *
 * Which fields run, what the model is asked and how often are the recipe's (recipes/). This file holds the request
 * cap, the stuck-run timing and the reading of an answer that every recipe shares.
 */

/**
 * Whether research says the person still works at the company: true or false only from an answer resting on a quote.
 * A boolean field's answer can be Jev's inference from pages that don't mention them, and not finding someone is no
 * sign they left, so an inferred answer says nothing here.
 */
export function employment(answer: { value: unknown; evidence?: string | null } | undefined): boolean | null {
  if (typeof answer?.value !== "boolean" || !answer.evidence) return null;
  if (/^Inferred by Jev\b/i.test(answer.evidence) || /\(inferred by Jev\)$/i.test(answer.evidence)) return null;
  return answer.value;
}

/** People one research request covers: a run researches each of them once per field. */
export const PEOPLE_RESEARCH_MAX = 25;
/** Field runs still going after this are left to finish on their own; the deal reads what landed. */
export const PEOPLE_RESEARCH_WAIT_MS = 30 * 60_000;
export const PEOPLE_RESEARCH_POLL_MS = 60_000;

export type Center = "innovation" | "stability";
export const CENTER_LABEL: Record<Center, string> = { innovation: "Innovation", stability: "Stability" };

/** Whether the keeper should research the deal's people again: the last run is `everyDays` old (the recipe's), or stuck. */
export function peopleResearchDue(last: { status: string; startedAt: number; finishedAt?: number | null } | null, now: number, everyDays: number): boolean {
  if (!last) return true;
  if (last.status === "running") return now - last.startedAt > PEOPLE_RESEARCH_WAIT_MS * 2;
  return now - (last.finishedAt ?? last.startedAt) > everyDays * 86_400_000;
}
