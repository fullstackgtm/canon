export const INVESTIGATION_TRIGGERS = {
  manual: { planningMoves: ["awaiting_start", "failed"], planned: "awaiting_start", freeOnly: false, capCredits: 500 },
  signup: { planningMoves: ["running", "failed"], planned: "running", freeOnly: true, capCredits: 500 },
} as const;
export type InvestigationTrigger = keyof typeof INVESTIGATION_TRIGGERS;
export const INVESTIGATION_MOVES = {
  planning: ["awaiting_start", "failed"],
  awaiting_start: ["running", "failed"],
  running: ["paused_at_cap", "done", "failed"],
  paused_at_cap: ["running", "done", "failed"],
  done: [], failed: [],
} as const;
export type InvestigationStatus = keyof typeof INVESTIGATION_MOVES;
export type PlanSource = { kind: "directory" | "people_phrase" | "catalog"; ref: string; label: string; estimatedCompanies: number };
export type InvestigationCounts = { found: number; duplicates: number; rejected: number; kept: number };
export type InvestigationEvent = { at: number; stage: string; message: string };
export function transition(from: InvestigationStatus, to: InvestigationStatus, trigger: InvestigationTrigger = "manual"): InvestigationStatus {
  const moves: readonly string[] = from === "planning" ? INVESTIGATION_TRIGGERS[trigger].planningMoves : INVESTIGATION_MOVES[from];
  if (!moves.includes(to)) throw new Error(`Invalid investigation transition ${from} to ${to}`);
  return to;
}
export function creditReservation(estimate: number, cap: number, spent = 0): number {
  if (![estimate, cap, spent].every((n) => Number.isSafeInteger(n) && n >= 0) || cap < 1) throw new Error("Invalid credit budget");
  return Math.max(0, Math.min(estimate - spent, cap - spent));
}
export function appendEvent(events: readonly InvestigationEvent[], event: InvestigationEvent): InvestigationEvent[] {
  return [...events, { ...event, message: event.message.slice(0, 600) }].slice(-48);
}
