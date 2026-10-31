import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, readFixture, structureDiffs, targets } from "../scripts/recipe-check.ts";

test("FSGTM on markdown and TypeScript, and Velocity on markdown and Canon's built-ins, return what the TypeScript recipes returned for every frozen call, and the kernel's runs send what they sent", async () => {
  const fixture = readFixture();
  assert.deepEqual(await structureDiffs(fixture), []);
  for (const { name, run, recipe } of await targets()) {
    const out = await compare(fixture, run, recipe);
    assert.deepEqual({ name, differ: out.differ, same: out.same }, { name, differ: 0, same: 4953 }, [...out.byFn.values()].find((t) => t.example)?.example);
  }
});
