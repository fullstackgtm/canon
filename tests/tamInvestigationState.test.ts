import assert from "node:assert/strict";
import test from "node:test";
import { appendEvent, creditReservation, INVESTIGATION_TRIGGERS, transition } from "../convex/lib/tam/investigation.ts";
test("moves through planning, start, pause, continuation and completion", () => {
  assert.deepEqual([
    transition("planning", "awaiting_start"), transition("awaiting_start", "running"), transition("running", "paused_at_cap"), transition("paused_at_cap", "running"), transition("running", "done"), transition("planning", "failed"),
  ], ["awaiting_start", "running", "paused_at_cap", "running", "done", "failed"]);
  for (const [from, to] of [["planning", "running"], ["awaiting_start", "done"], ["done", "running"], ["failed", "running"], ["running", "running"]] as const) assert.throws(() => transition(from, to));
});
test("reserves the smaller estimate or cap and preserves a bounded event tail", () => {
  assert.deepEqual([creditReservation(800, 500), creditReservation(120, 500), creditReservation(800, 1000, 500)], [500, 120, 300]);
  assert.throws(() => creditReservation(10, -1));
  const events = Array.from({ length: 48 }, (_, at) => ({ at, stage: "source", message: String(at) }));
  const next = appendEvent(events, { at: 48, stage: "done", message: "Complete" });
  assert.deepEqual([next.length, next[0], next.at(-1), events[0]], [48, { at: 1, stage: "source", message: "1" }, { at: 48, stage: "done", message: "Complete" }, { at: 0, stage: "source", message: "0" }]);
});

test("signup planning starts automatically while manual planning waits for a click", () => {
  assert.equal(transition("planning", INVESTIGATION_TRIGGERS.signup.planned, "signup"), "running");
  assert.equal(transition("planning", INVESTIGATION_TRIGGERS.manual.planned, "manual"), "awaiting_start");
  assert.throws(() => transition("planning", "awaiting_start", "signup"));
  assert.equal(transition("running", "paused_at_cap", "signup"), "paused_at_cap");
  assert.equal(transition("paused_at_cap", "running", "signup"), "running");
});
