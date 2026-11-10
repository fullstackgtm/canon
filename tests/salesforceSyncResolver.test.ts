import assert from "node:assert/strict";
import test from "node:test";
import { normalizeValue, resolveField, valuesEqual } from "../convex/lib/sfConflict.ts";
import type { SyncAuthority } from "../engine/src/sync/salesforceSync/types.ts";

const AUTH: SyncAuthority[] = ["fsgtm", "salesforce", "newest", "review"];
const DIRS = ["inbound", "outbound"] as const;
// fsgtmAt vs sfAt orderings
const TIMES: Array<[string, number | undefined, number | undefined]> = [
  ["fsgtm-newer", 200, 100],
  ["sf-newer", 100, 200],
  ["tie", 150, 150],
  ["fsgtm-missing", undefined, 100],
  ["sf-missing", 100, undefined],
];

function expected(a: SyncAuthority, dir: "inbound" | "outbound", t: string): string {
  if (a === "review") return "conflict";
  if (a === "salesforce") return dir === "inbound" ? "apply" : "skip";
  if (a === "fsgtm") return dir === "outbound" ? "apply" : "skip";
  // newest; tie goes to the side that produced the change
  const fsgtmWins = t === "fsgtm-newer" || t === "sf-missing" || (t === "tie" && dir === "outbound");
  return dir === "outbound" ? (fsgtmWins ? "apply" : "skip") : (fsgtmWins ? "skip" : "apply");
}

test("resolver: exhaustive authority x direction x timestamp table (values differ)", () => {
  let n = 0;
  for (const a of AUTH) for (const d of DIRS) for (const [name, f, s] of TIMES) {
    const got = resolveField({ authority: a, direction: d, fsgtmValue: "A", fsgtmAt: f, sfValue: "B", sfAt: s });
    assert.equal(got.action, expected(a, d, name), `${a}/${d}/${name}`);
    n++;
  }
  assert.equal(n, 40);
});

test("resolver: equal values are a no-op for every authority and direction", () => {
  const pairs: Array<[unknown, unknown]> = [["x", "x"], [null, ""], [undefined, null], [42, "42"], ["  a ", "a"], [true, "true"], [1.5, "1.50"]];
  for (const a of AUTH) for (const d of DIRS) for (const [x, y] of pairs) {
    assert.equal(resolveField({ authority: a, direction: d, fsgtmValue: x, fsgtmAt: 1, sfValue: y, sfAt: 2 }).action, "noop", `${a}/${d}/${String(x)}`);
  }
});

test("normalizeValue distinguishes real differences", () => {
  assert.equal(valuesEqual("Acme", "acme"), false);
  assert.equal(valuesEqual(0, null), false);
  assert.equal(valuesEqual("0", ""), false);
  assert.equal(normalizeValue({ a: 1 }), '{"a":1}');
});
