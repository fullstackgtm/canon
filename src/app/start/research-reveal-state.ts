export const CARD_LABELS = {
  offer: "Your company",
  market: "Your market",
  buyers: "Who buys it",
  team: "Your team and setup",
  plan: "How to differentiate",
};
export type CardId = keyof typeof CARD_LABELS;
export const CARD_IDS = Object.keys(CARD_LABELS) as CardId[];
export function isCardId(id: string): id is CardId {
  return Object.hasOwn(CARD_LABELS, id);
}

type Phase = {
  id: string;
  card: CardId;
  kind: "loading" | "reveal";
  minMs: number;
  maxMs: number;
};
export const PHASES: Phase[] = CARD_IDS.flatMap((card) => [
  { id: `${card}-loading`, card, kind: "loading", minMs: 5200, maxMs: 30000 },
  {
    id: `${card}-reveal`,
    card,
    kind: "reveal",
    minMs: card === "market" ? 6500 : 5000,
    maxMs: 7000,
  },
]);
export type PhaseState = { index: number; since: number };
export function phaseIndex(value: string | null) {
  if (value === "waitlist") return PHASES.length;
  const index = PHASES.findIndex((phase) => phase.id === value);
  return index < 0 ? 0 : index;
}
export function qaSpeed(value: string | null) {
  const speed = Number(value);
  return Number.isFinite(speed) && speed > 0
    ? Math.min(20, Math.max(0.1, speed))
    : 1;
}
export function advancePhase(
  state: PhaseState,
  now: number,
  ready: readonly CardId[],
  speed = 1,
): PhaseState {
  const phase = PHASES[state.index];
  if (!phase) return state;
  const elapsed = (now - state.since) * speed;
  if (
    elapsed < phase.maxMs &&
    (elapsed < phase.minMs ||
      (phase.kind === "loading" && !ready.includes(phase.card)))
  )
    return state;
  return { index: state.index + 1, since: now };
}
export function visibleCards(state: PhaseState, ready: readonly CardId[]) {
  return CARD_IDS.filter(
    (card) =>
      ready.includes(card) &&
      state.index >=
        PHASES.findIndex(
          (phase) => phase.card === card && phase.kind === "reveal",
        ),
  );
}

export type ResearchEvent = { at: number; kind: string; text: string };
export function replaySchedule(events: readonly ResearchEvent[]) {
  let at = 0;
  return events.map((event, index) => {
    if (index)
      at += Math.min(6000, Math.max(200, event.at - events[index - 1].at));
    return at;
  });
}
export function replayEvents(
  events: readonly ResearchEvent[],
  elapsed: number,
) {
  const schedule = replaySchedule(events);
  const duration = schedule.at(-1) ?? 0;
  const sourceTime = duration ? (elapsed * duration) / 57000 : elapsed;
  return events.filter((_, index) => schedule[index] <= sourceTime);
}

export const SCREENS = [...CARD_IDS, "waitlist"] as const;
export type ScreenId = (typeof SCREENS)[number];
export function screenAt(index: number): ScreenId {
  return PHASES[index]?.card ?? "waitlist";
}
export function screenForKey(
  screen: ScreenId,
  key: string,
  frontier: number,
): ScreenId | null {
  const available = SCREENS.slice(0, SCREENS.indexOf(screenAt(frontier)) + 1);
  const index = available.indexOf(screen);
  if (key === "Home") return available[0];
  if (key === "End") return available.at(-1) ?? screen;
  if (key === "ArrowLeft") return available[Math.max(0, index - 1)];
  if (key === "ArrowRight")
    return available[Math.min(available.length - 1, index + 1)];
  return null;
}
export function resumePhase(params: URLSearchParams, now: number) {
  const view = phaseIndex(params.get("phase"));
  const index = Math.max(view, phaseIndex(params.get("progress")));
  const since = Number(params.get("since"));
  return {
    state: { index, since: since > 0 && since <= now ? since : now },
    browsing: view < index ? screenAt(view) : null,
  };
}
