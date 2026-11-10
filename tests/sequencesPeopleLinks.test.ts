import assert from "node:assert/strict";
import { test } from "node:test";
import { calls } from "../modules/examples/sequences/server.ts";
import type { ReadDoc } from "../modules/kernel/calls.ts";

test("recent call people use current readable Canon records, each person once in latest-call order", async () => {
  const task = (contact: string, callAt: number): ReadDoc => ({ key: `${contact}|${callAt}`, data: { contact, callAt,
    contactName: "Old cached name", title: "Old cached title" }, version: 1, owner: "rep", parentKey: null, createdAt: 1, updatedAt: 1 });
  const result = await calls.recentPeople({ now: 100, caller: { userId: "rep", role: "rep" }, args: {} }, {
    tasks: [task("con_hidden", 90), task("con_b", 80), task("con_a", 70), task("con_b", 60)],
    people: [{ id: "con_a", name: "Ada", title: "CFO", companyId: "acc_a" }, { id: "con_b", name: "Bo" }],
  });
  assert.deepEqual(result, { value: { rows: [
    { person: "con_b", name: "Bo", title: null, company: null, companyLink: null, callAt: 80 },
    { person: "con_a", name: "Ada", title: "CFO", company: "acc_a", companyLink: "Company record", callAt: 70 },
  ] } });
});
