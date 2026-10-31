import assert from "node:assert/strict";
import test from "node:test";
import { dueCount, groupTasks, localDay } from "../src/lib/my-tasks.ts";

const t = (id: string, dueDate: string | null, status: string | null = "not_started", subject = id) => ({ id, subject, dueDate, status });

test("open tasks group by the viewer's day; done ones drop out; each group sorts by date then subject", () => {
  const groups = groupTasks(
    [t("late2", "2026-10-08"), t("later", "2026-10-12"), t("now-b", "2026-10-10", null, "b"), t("now-a", "2026-10-10", "waiting", "a"), t("late1", "2026-10-01"), t("open", null), t("done", "2026-10-01", "completed")],
    "2026-10-10",
  );
  assert.deepEqual(groups.overdue.map((x) => x.id), ["late1", "late2"]);
  assert.deepEqual(groups.today.map((x) => x.id), ["now-a", "now-b"]);
  assert.deepEqual(groups.upcoming.map((x) => x.id), ["later"]);
  assert.deepEqual(groups.none.map((x) => x.id), ["open"]);
  assert.equal(dueCount(groups), 4);
});

test("localDay is the local calendar day, zero padded", () => {
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});
