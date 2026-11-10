// Me · My team · Everyone (src/lib/report-scope.ts): whose records a scoped report reads.
import assert from "node:assert/strict";
import test from "node:test";
import { scopeOwners } from "../src/lib/report-scope.ts";

const users = [
  { _id: "vp" }, { _id: "mgr", managerId: "vp" }, { _id: "rep1", managerId: "mgr" }, { _id: "rep2", managerId: "mgr" }, { _id: "sdr", managerId: "rep1" }, { _id: "other", managerId: "vp" },
];

test("me reads only the caller's records", () => assert.deepEqual(scopeOwners("me", "rep2", users), ["rep2"]));

test("a manager's team is everyone below them", () => {
  assert.deepEqual(scopeOwners("team", "mgr", users).sort(), ["mgr", "rep1", "rep2", "sdr"]);
});

test("a rep no one reports to reads their peers under the same manager", () => {
  assert.deepEqual(scopeOwners("team", "rep2", users).sort(), ["rep1", "rep2"]);
});

test("someone with no manager and no reports reads only their own", () => {
  assert.deepEqual(scopeOwners("team", "solo", [{ _id: "solo" }]), ["solo"]);
});
