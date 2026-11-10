import assert from "node:assert/strict";
import test from "node:test";
import { formatTimeLeft, movingObjects, nextRate, objectSecondsLeft, syncSecondsLeft } from "../convex/lib/syncObjectProgress.ts";

test("the write rate is smoothed across samples and ignores samples too close together to tell", () => {
  const r1 = nextRate(undefined, { done: 0, at: 0 }, { done: 100, at: 5_000 });
  assert.equal(r1, 20);
  assert.equal(nextRate(r1, { done: 100, at: 5_000 }, { done: 105, at: 6_000 }), 20);
  // A slow page moves the rate part of the way, not all of it.
  const r2 = nextRate(r1, { done: 100, at: 5_000 }, { done: 150, at: 10_000 });
  assert.ok(r2! < 20 && r2! > 10);
});

test("time left: per object at its own rate, the whole sync at the objects' combined rate", () => {
  const companies = { object: "accounts", done: 30_000, total: 30_000, finished: true, perSecond: 200 };
  const contacts = { object: "contacts", done: 20_000, total: 66_000, finished: false, perSecond: 30 };
  const deals = { object: "deals", done: 4_000, total: 14_000, finished: false, perSecond: 10 };
  assert.equal(objectSecondsLeft(companies), 0);
  assert.equal(objectSecondsLeft(contacts), 46_000 / 30);
  assert.equal(syncSecondsLeft([companies, contacts, deals]), (46_000 + 10_000) / 40);
  // No rate yet, or no total: no estimate.
  assert.equal(objectSecondsLeft({ ...contacts, perSecond: undefined }), undefined);
  assert.equal(syncSecondsLeft([{ ...deals, total: undefined }]), undefined);
  assert.equal(syncSecondsLeft([companies]), 0);
  assert.equal(formatTimeLeft(30), "less than a minute left");
  assert.equal(formatTimeLeft(12 * 60), "about 12 min left");
  assert.equal(formatTimeLeft(90 * 60), "about 1 h 30 min left");
  assert.equal(formatTimeLeft(undefined), null);
});

test("the objects writing now: companies alone until they are in, then people and deals together", () => {
  const at = (accounts: boolean, contacts = false) => [
    { object: "accounts", done: 10, total: 10, finished: accounts, updatedAt: 1 },
    { object: "contacts", done: 0, total: 5, finished: contacts, updatedAt: 1 },
    { object: "deals", done: 0, total: 5, finished: false, updatedAt: 1 },
  ];
  assert.deepEqual(movingObjects(at(false)), ["accounts"]);
  assert.deepEqual(movingObjects(at(true)), ["contacts", "deals"]);
  assert.deepEqual(movingObjects(at(true, true)), ["deals"]);
});
