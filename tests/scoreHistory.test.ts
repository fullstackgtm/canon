import assert from "node:assert/strict";
import { test } from "node:test";
import { fieldsAsOf, fitAsOf, heatAsOf, scoreHistory, type IcpVersion } from "../convex/lib/scoreHistory.ts";
import type { LoggedObservation } from "../convex/lib/signals/observations.ts";
import type { FieldChange } from "../convex/lib/timeline.ts";
import { defaultModel } from "../recipes/index.ts";

const HEAT = defaultModel("signals.heat");

const D = (n: number) => Date.UTC(2026, 9, n);
const job = (title: string) => ({ bucket: "job" as const, trigger: `hiring: ${title}`, quote: "q", url: "https://boards.greenhouse.io/acme/1", board: "greenhouse" as const });
const log: LoggedObservation[] = [
  { seq: 1, observedAt: D(3), occurredAt: D(2), body: { type: "signal_seen", key: "job:greenhouse:growth", signal: job("head of growth") } },
  { seq: 2, observedAt: D(5), body: { type: "signal_seen", key: "job:greenhouse:revops", signal: job("revops manager") } },
  { seq: 3, observedAt: D(8), body: { type: "signal_gone", key: "job:greenhouse:growth" } },
];
const weights = (band: { min: number; max: number; weight: number }) => ({ base: 10, industries: { software: 40 }, countries: {}, employeeBands: [band] });
const v1: IcpVersion = { version: 1, acceptedAt: D(1), weights: weights({ min: 500, max: 999, weight: 25 }) };
const v2: IcpVersion = { version: 2, acceptedAt: D(9), weights: weights({ min: 700, max: 999, weight: 30 }) };
// Created on day 4 with industry and employees; employees edited on day 10. Industry has no history row.
const account = { industry: "software", employees: 720, fieldUpdatedAt: { domain: D(4), industry: D(4), employees: D(10) } };
const history: FieldChange[] = [{ field: "employees", oldValue: "640", newValue: "720", actorId: "u1", at: D(10) }];

test("heat as of a date counts the signals live then: started by their posting date, ended when seen gone", () => {
  assert.deepEqual([D(1), D(2), D(5), D(8)].map((t) => heatAsOf(log, t, HEAT).score), [0, 22, 38, 20]);
});

test("fit as of a date scores the fields then under the version given, and is unknown before the row was on record", () => {
  assert.deepEqual(fitAsOf(fieldsAsOf(account, history, D(3)), v1), { known: false, missing: ["industry", "employees"] });
  assert.deepEqual(fitAsOf(fieldsAsOf(account, history, D(6)), v1), { known: true, fit: 75 });
  assert.deepEqual(fitAsOf(fieldsAsOf(account, history, D(6)), v2), { known: true, fit: 50 });
  assert.deepEqual(fitAsOf(fieldsAsOf(account, history, D(11)), v2), { known: true, fit: 80 });
});

test("score history lists each change to fit or heat with its cause, newest first, with first contact", () => {
  const points = scoreHistory({ account, history, log, versions: [v2, v1], firstContactAt: D(6), heat: HEAT });
  assert.deepEqual(points.map((p) => [new Date(p.at).getUTCDate(), p.fit.known ? p.fit.fit : null, p.heat, p.causes]), [
    [10, 80, 19, [{ kind: "field", field: "employees", from: 640, to: 720 }]],
    [9, 50, 19, [{ kind: "weights", from: 1, to: 2 }]],
    [8, 75, 20, [{ kind: "signal_ended", trigger: "hiring: head of growth" }]],
    [6, 75, 37, [{ kind: "first_contact" }]],
    [5, 75, 38, [{ kind: "signal_started", trigger: "hiring: revops manager" }]],
    [2, null, 22, [{ kind: "signal_started", trigger: "hiring: head of growth" }]],
    [1, null, 0, [{ kind: "weights", from: null, to: 1 }]],
  ]);
});
