import assert from "node:assert/strict";
import test from "node:test";
import { suggestCommittee, type Person } from "../convex/lib/committee.ts";

const people: Person[] = [
  { id: "ceo", fullName: "Ada Lim", title: "CEO" },
  { id: "gc", fullName: "Jane Roe", title: "General Counsel" },
  { id: "vpsales", fullName: "Bo Diaz", title: "VP Sales" },
  { id: "vplegal", fullName: "Sam Lee", title: "VP Legal Operations" },
  { id: "eng", fullName: "Cy Park", title: "Software Engineer" },
];

test("the N-1 is the most senior person below the Executive in the Executive's department", () => {
  const picks = suggestCommittee(people, { executive: "gc" }, new Set(["gc"]));
  assert.deepEqual(picks.map((p) => [p.slot, p.contactId]), [["n1", "vplegal"]]);
});

test("with no anchor the most senior title is the Executive; a CEO has no department, so anyone below counts", () => {
  const picks = suggestCommittee(people.filter((p) => p.id !== "gc" && p.id !== "vplegal"), {}, new Set());
  assert.deepEqual(picks.map((p) => [p.slot, p.contactId]), [["executive", "ceo"], ["n1", "vpsales"]]);
});

test("nobody at director level or above means no picks", () => {
  const picks = suggestCommittee([{ id: "a", fullName: "A", title: "Account Manager" }, { id: "b", fullName: "B", title: "Analyst" }], {}, new Set());
  assert.deepEqual(picks, []);
});
