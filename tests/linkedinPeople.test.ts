import assert from "node:assert/strict";
import test from "node:test";
import { linkedinPeople } from "../src/lib/linkedin-people.ts";

test("sent connections remain visible ahead of a multi-page invite queue", () => {
  const queued = Array.from({ length: 41 }, (_, i) => ({
    id: `queued-${i}`, state: "queued", lastSentAt: null, position: i + 1,
  }));
  const sent = ["invited", "done", "connected", "replied", "stopped", "withdrawn", "failed"].map((state, i) => ({
    id: state, state, lastSentAt: 100 + i, position: null,
  }));
  const unsent = { id: "unsent", state: "failed", lastSentAt: null, position: null };
  const people = [...queued, ...sent, unsent];
  const expectedSent = [...sent].reverse();

  assert.deepEqual(linkedinPeople(people, "all").slice(0, 20), [...expectedSent, ...queued.slice(0, 13)]);
  assert.deepEqual(linkedinPeople(people, "sent"), expectedSent);
  assert.deepEqual(linkedinPeople(people, "queued"), queued);
  assert.equal(linkedinPeople(people, "all").at(-1), unsent);
  assert.deepEqual(people, [...queued, ...sent, unsent]);
});
