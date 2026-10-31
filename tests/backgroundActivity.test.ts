import assert from "node:assert/strict";
import test from "node:test";
import { backgroundActivityLabel, formatRelativeTime, partitionBackgroundActivity } from "../src/lib/background-activity.ts";

test("tray groups running work above recent work and labels the launcher", () => {
  const entries = [
    { id: "1", kind: "contact_sweep" as const, title: "Contact sweep", status: "processing" as const, startedAt: 3, href: "/" },
    { id: "2", kind: "crm_sync" as const, title: "hubspot sync", status: "completed" as const, startedAt: 2, href: "/" },
    { id: "3", kind: "contact_sweep" as const, title: "Contact sweep", status: "failed" as const, startedAt: 1, href: "/" },
  ];
  const { active, recent } = partitionBackgroundActivity(entries);
  assert.deepEqual(active.map((e) => e.id), ["1"]);
  assert.deepEqual(recent.map((e) => e.id), ["2", "3"]);
  assert.equal(backgroundActivityLabel(1), "1 background job in progress");
  assert.equal(backgroundActivityLabel(0), "View background activity");
  assert.equal(formatRelativeTime(1_000_000, 1_000_000 + 5 * 60_000), "5 min ago");
});
