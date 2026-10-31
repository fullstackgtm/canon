import assert from "node:assert/strict";
import test from "node:test";
import {
  CARD_IDS,
  PHASES,
  advancePhase,
  screenForKey,
  resumePhase,
  screenAt,
  phaseIndex,
  qaSpeed,
  replayEvents,
  replaySchedule,
  visibleCards,
} from "../src/app/start/research-reveal-state.ts";

test("live and cached findings wait for loading and reveal dwell without duplicate snapshots advancing them", () => {
  let state = { index: 0, since: 0 };
  assert.deepEqual(advancePhase(state, 5199, CARD_IDS), state);
  assert.deepEqual(advancePhase(state, 5200, []), state);
  state = advancePhase(state, 5200, CARD_IDS);
  assert.equal(PHASES[state.index].id, "offer-reveal");
  assert.deepEqual(visibleCards(state, CARD_IDS), ["offer"]);
  assert.deepEqual(advancePhase(state, 10199, CARD_IDS), state);
  state = advancePhase(state, 10200, CARD_IDS);
  assert.equal(PHASES[state.index].id, "market-loading");
  assert.deepEqual(visibleCards(state, CARD_IDS), ["offer"]);
  while (state.index < PHASES.length)
    state = advancePhase(
      state,
      state.since + PHASES[state.index].maxMs,
      CARD_IDS,
    );
  assert.deepEqual(visibleCards(state, CARD_IDS), CARD_IDS);
  assert.equal(advancePhase(state, 999999, CARD_IDS), state);
});

test("timeouts never reveal unavailable data and late findings appear without restarting earlier phases", () => {
  const state = advancePhase({ index: 0, since: 0 }, 30000, []);
  assert.equal(state.index, 1);
  assert.deepEqual(visibleCards(state, []), []);
  assert.deepEqual(visibleCards(state, ["offer"]), ["offer"]);
  assert.equal(
    advancePhase({ index: 0, since: 0 }, 260, ["offer"], 20).index,
    1,
  );
  assert.equal(phaseIndex("market-reveal"), 3);
  assert.equal(phaseIndex("invalid"), 0);
  for (const value of [null, "no", "Infinity", "0", "-2"])
    assert.equal(qaSpeed(value), 1);
  assert.equal(qaSpeed("999"), 20);
});

test("cached event playback keeps real events in order and finishes at 57 seconds", () => {
  const events = [0, 1, 120001].map((at, index) => ({
    at,
    kind: "fetch",
    text: `source ${index}`,
  }));
  assert.deepEqual(replaySchedule(events), [0, 200, 6200]);
  assert.deepEqual(replayEvents(events, 0), [events[0]]);
  assert.deepEqual(replayEvents(events, 57000), events);
  assert.deepEqual(replayEvents([], 100), []);
});

test("finished screens support bounded navigation, and URL refresh resumes both progress and review", () => {
  assert.equal(screenForKey("offer", "ArrowLeft", 5), "offer");
  assert.equal(screenForKey("buyers", "ArrowRight", 5), "buyers");
  assert.equal(screenForKey("market", "ArrowRight", 5), "buyers");
  assert.equal(screenForKey("team", "Home", 9), "offer");
  assert.equal(screenForKey("team", "End", 10), "waitlist");
  assert.equal(screenForKey("buyers", "Tab", 9), null);
  const resumed = resumePhase(
    new URLSearchParams("phase=offer-reveal&progress=team-loading&since=12000"),
    14000,
  );
  assert.deepEqual(resumed, {
    state: { index: 6, since: 12000 },
    browsing: "offer",
  });
  assert.equal(screenAt(resumed.state.index), "team");
  assert.equal(phaseIndex("waitlist"), PHASES.length);
  assert.equal(
    resumePhase(new URLSearchParams("phase=nonsense&since=999999"), 14000).state
      .since,
    14000,
  );
});
