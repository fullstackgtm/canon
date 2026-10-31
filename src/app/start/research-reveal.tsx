"use client";

import { useEffect, useRef, useState } from "react";
import {
  PHASES,
  advancePhase,
  qaSpeed,
  visibleCards,
  replayEvents,
  resumePhase,
  screenAt,
  screenForKey,
  type ResearchEvent,
  type CardId,
  type ScreenId,
} from "./research-reveal-state";
export { CARD_LABELS, isCardId, type CardId } from "./research-reveal-state";

export function useResearchReveal(
  completions: CardId[],
  enabled = true,
  failed = false,
  events: ResearchEvent[] = [],
) {
  const [state, setState] = useState({ index: 0, since: 0 });
  const [clock, setClock] = useState(0);
  const [started, setStarted] = useState<number | null>(null);
  const [browsing, setBrowsing] = useState<ScreenId | null>(null);
  const [qa, setQa] = useState({ speed: 1, frozen: false, replay: false });
  const [reduced, setReduced] = useState(true);
  const current = useRef(completions);
  useEffect(() => {
    current.current = completions;
  }, [completions]);
  useEffect(() => {
    if (!enabled) return;
    const params = new URLSearchParams(window.location.search);
    const now = Date.now();
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    const resumed = resumePhase(params, now);
    const frame = requestAnimationFrame(() => {
      setState(resumed.state);
      setBrowsing(resumed.browsing);
      setStarted(now);
      setClock(now);
      setQa({
        speed: qaSpeed(params.get("speed")),
        frozen: params.get("frozen") === "1",
        replay: params.get("replay") === "1",
      });
      change();
    });
    media.addEventListener("change", change);
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener("change", change);
    };
  }, [enabled]);
  const replay = qa.replay;
  const ticking =
    started !== null &&
    !qa.frozen &&
    !failed &&
    (state.index < PHASES.length ||
      (replay && (clock - started) * qa.speed < 57000));
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setClock(now);
      setState((previous) =>
        advancePhase(previous, now, current.current, qa.speed),
      );
    }, 100);
    return () => clearInterval(timer);
  }, [ticking, qa.speed]);
  const screen = browsing ?? screenAt(state.index);
  useEffect(() => {
    if (started === null) return;
    const url = new URL(window.location.href);
    const progress = PHASES[state.index]?.id ?? "waitlist";
    url.searchParams.set("progress", progress);
    url.searchParams.set(
      "phase",
      browsing
        ? browsing === "waitlist"
          ? "waitlist"
          : `${browsing}-reveal`
        : progress,
    );
    url.searchParams.set("since", String(state.since));
    window.history.replaceState(window.history.state, "", url);
  }, [state.index, state.since, browsing, started]);
  const previousScreen = useRef(screen);
  useEffect(() => {
    if (previousScreen.current === screen) return;
    previousScreen.current = screen;
    if (
      !document.activeElement?.closest(
        "input,textarea,select,[contenteditable=true]",
      )
    ) {
      document.getElementById("stage-title")?.focus({ preventScroll: true });
    }
  }, [screen]);
  function navigate(target: ScreenId) {
    const available = screenAt(state.index);
    if (target === "waitlist" && available !== "waitlist") return;
    const targetIndex =
      target === "waitlist"
        ? PHASES.length
        : PHASES.findIndex((phase) => phase.card === target);
    if (targetIndex > state.index) return;
    setBrowsing(target === available ? null : target);
  }
  function move(key: string) {
    const next = screenForKey(screen, key, state.index);
    if (next) navigate(next);
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest(
            "input,textarea,select,[contenteditable=true],[role=dialog]",
          ))
      )
        return;
      const next = screenForKey(screen, event.key, state.index);
      if (!next) return;
      event.preventDefault();
      setBrowsing(next === screenAt(state.index) ? null : next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, state.index]);
  return {
    screen,
    phase: PHASES[state.index],
    frontier: state.index,
    browsing: browsing !== null,
    revealed: visibleCards(state, completions),
    reduced,
    navigate,
    move,
    elapsed: qa.frozen ? 0 : Math.max(0, clock - state.since) * qa.speed,
    events: replay
      ? replayEvents(
          events,
          qa.frozen || started === null
            ? 0
            : Math.max(0, clock - started) * qa.speed,
        )
      : events,
    settled: state.index >= PHASES.length,
  };
}
