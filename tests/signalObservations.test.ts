import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planSignalObservations,
  type LoggedObservation, type OpenSignalRow, type SeenSignal, type Signal,
} from "../convex/lib/signals/observations.ts";
import type { Activity } from "../convex/lib/activities.ts";
import { recordTimeline, type FieldChange } from "../convex/lib/timeline.ts";

const D = (n: number) => Date.UTC(2026, 9, n);
const growth = (quote: string, url = "https://boards.greenhouse.io/acme/1"): Signal =>
  ({ bucket: "job", trigger: "hiring: head of growth", quote, url, board: "greenhouse" });

function account(openRows: OpenSignalRow[] = []) {
  const log: LoggedObservation[] = [];
  return {
    log,
    check(read: SeenSignal[], now: number) {
      const planned = planSignalObservations(log, openRows, read, now);
      for (const p of planned) log.push({ ...p, seq: log.length + 1 });
      return planned.map((p) => ({ type: p.body.type, observedAt: p.observedAt, occurredAt: p.occurredAt, quote: p.body.type === "signal_seen" ? p.body.signal.quote : undefined }));
    },
  };
}

test("a signal's life: seen once, a changed quote seen again, gone when it disappears, a new interval when it returns", () => {
  const acme = account();
  assert.deepEqual(acme.check([{ signal: growth("Own pipeline"), occurredAt: D(1) }], D(2)), [{ type: "signal_seen", observedAt: D(2), occurredAt: D(1), quote: "Own pipeline" }]);
  assert.deepEqual(acme.check([{ signal: growth("Own pipeline"), occurredAt: D(1) }], D(3)), []);
  assert.deepEqual(acme.check([{ signal: growth("Own all pipeline") }], D(4)), [{ type: "signal_seen", observedAt: D(4), occurredAt: undefined, quote: "Own all pipeline" }]);
  assert.deepEqual(acme.check([], D(5)), [{ type: "signal_gone", observedAt: D(5), occurredAt: undefined, quote: undefined }]);
  assert.deepEqual(acme.check([], D(6)), []);
  assert.deepEqual(acme.check([{ signal: growth("Own all pipeline", "https://boards.greenhouse.io/acme/2") }], D(7)), [{ type: "signal_seen", observedAt: D(7), occurredAt: undefined, quote: "Own all pipeline" }]);
});

test("the timeline merges field changes, signal events and activities newest first, in that order on a tie", () => {
  const acme = account();
  acme.check([{ signal: growth("Own pipeline"), occurredAt: D(1) }], D(2));
  acme.check([{ signal: growth("Own all pipeline") }], D(4));
  acme.check([], D(6));
  const fields: FieldChange[] = [
    { field: "employees", oldValue: "120", newValue: "150", actorId: "u1", at: D(5), source: "fsgtm" },
    { field: "name", oldValue: "Acme", newValue: "Acme Inc", actorId: "sf", at: D(4), source: "salesforce" },
    { field: "industry", oldValue: null, newValue: "Software", actorId: "u1", at: D(3) },
  ];
  const activities: Activity[] = [
    { kind: "meeting", id: "m1", at: D(8), ownerId: "u1", title: "Kickoff", startAt: D(8) },
    { kind: "note", id: "n1", at: D(4), ownerId: "u1", body: "Met at the conference" },
    { kind: "task", id: "t1", at: D(2), ownerId: null, subject: "Send pricing", dueDate: "2026-10-09", status: "not_started" },
    { kind: "call", id: "c1", at: D(3), ownerId: "u1", subject: null, outcome: "no_answer" },
  ];
  assert.deepEqual(recordTimeline(fields, acme.log, activities), [
    { kind: "meeting", id: "m1", at: D(8), ownerId: "u1", title: "Kickoff", startAt: D(8) },
    { kind: "signal_ended", at: D(6), trigger: "hiring: head of growth", startedAt: D(1) },
    { kind: "field_changed", at: D(5), field: "employees", from: "120", to: "150", actorId: "u1", source: "fsgtm" },
    { kind: "field_changed", at: D(4), field: "name", from: "Acme", to: "Acme Inc", actorId: "sf", source: "salesforce" },
    { kind: "signal_quote_changed", at: D(4), trigger: "hiring: head of growth", quote: "Own all pipeline", url: "https://boards.greenhouse.io/acme/1", previousQuote: "Own pipeline" },
    { kind: "note", id: "n1", at: D(4), ownerId: "u1", body: "Met at the conference" },
    { kind: "field_changed", at: D(3), field: "industry", from: null, to: "Software", actorId: "u1", source: null },
    { kind: "call", id: "c1", at: D(3), ownerId: "u1", subject: null, outcome: "no_answer" },
    { kind: "task", id: "t1", at: D(2), ownerId: null, subject: "Send pricing", dueDate: "2026-10-09", status: "not_started" },
    { kind: "signal_started", at: D(1), trigger: "hiring: head of growth", quote: "Own pipeline", url: "https://boards.greenhouse.io/acme/1" },
  ]);
});

test("an account's timeline places each linked deal's creation among its other events", () => {
  const deal = { streamId: "ent_d1", name: "Atlas expansion", stage: "Discovery", amount: 1_200_000, currency: "EUR", createdAt: D(3) };
  const fields: FieldChange[] = [{ field: "industry", oldValue: null, newValue: "Software", actorId: "u1", at: D(2) }];
  const activities: Activity[] = [{ kind: "note", id: "n1", at: D(4), ownerId: "u1", body: "Budget approved" }];
  assert.deepEqual(recordTimeline(fields, [], activities, [deal]), [
    { kind: "note", id: "n1", at: D(4), ownerId: "u1", body: "Budget approved" },
    { kind: "deal_created", at: D(3), deal },
    { kind: "field_changed", at: D(2), field: "industry", from: null, to: "Software", actorId: "u1", source: null },
  ]);
});

test("an account with open signals and no history is seeded once, closing rows its last check did not refresh", () => {
  const row = { quote: "Own pipeline", sourceUrl: "https://boards.greenhouse.io/acme/1", source: "greenhouse", observedAt: D(1), firstSeenAt: D(2) };
  const acme = account([
    { ...row, trigger: "hiring: head of growth", lastSeenAt: D(10) },
    { ...row, trigger: "hiring: sdr", observedAt: D(0), lastSeenAt: D(6) },
  ]);
  assert.deepEqual(acme.check([{ signal: growth("Own pipeline"), occurredAt: D(1) }], D(11)), [
    { type: "signal_seen", observedAt: D(2), occurredAt: D(1), quote: "Own pipeline" },
    { type: "signal_seen", observedAt: D(2), occurredAt: D(0), quote: "Own pipeline" },
    { type: "signal_gone", observedAt: D(6), occurredAt: undefined, quote: undefined },
  ]);
  assert.deepEqual(acme.check([{ signal: growth("Own pipeline"), occurredAt: D(1) }], D(12)), []);
});
