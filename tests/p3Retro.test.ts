import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, toRow, type RawPr } from "../scripts/p3-retro.ts";

const pr = (number: number, title: string, paths: string[], body = "", commits = 1): RawPr => ({
  number,
  title,
  body,
  createdAt: "2026-10-06T00:00:00Z",
  mergedAt: "2026-10-06T01:00:00Z",
  commits: Array.from({ length: commits }),
  files: paths.map((path) => ({ path, additions: 100 })),
});

test("a run of groundwork PRs and an over-budget review are breaches", () => {
  const rows = [
    pr(1, "Add the ledger", ["convex/ledger.ts"]),
    pr(2, "Widen the schema", ["convex/schema.ts"]),
    pr(3, "Fold accounts", ["convex/fold.ts", "tests/fold.test.ts"], "Kind: groundwork\nReview rounds: 5/3"),
    pr(4, "Projector", ["services/record-service/projector.ts"], "", 19),
  ].map(toRow);
  const { breaches, userVisibleShare } = summarize(rows);
  assert.equal(userVisibleShare, 0);
  assert.ok(breaches.some((b) => b.startsWith("4 groundwork PRs in a row")));
  assert.ok(breaches.some((b) => b.startsWith("no user-visible change in the first two")));
  assert.ok(breaches.some((b) => b.startsWith("#3 took 5 review rounds")));
  assert.ok(breaches.some((b) => b.startsWith("#4 has 19 commits")));
});

test("a stated kind wins over inference, and UI work breaks a groundwork run", () => {
  const rows = [
    pr(1, "Add the ledger", ["convex/ledger.ts"]),
    pr(2, "List views", ["app/dashboard/records/page.tsx"]),
    pr(3, "Tidy", ["convex/a.ts"], "Kind: user-visible"),
  ].map(toRow);
  assert.deepEqual(rows.map((r) => [r.kind, r.kindInferred]), [["groundwork", true], ["user-visible", true], ["user-visible", false]]);
  assert.deepEqual(summarize(rows).breaches, []);
});
