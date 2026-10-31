import assert from "node:assert/strict";
import { test } from "node:test";
import { activityBand, segmentBreakdown, SEGMENTS_MAX, tenureBand, titleKey, type SegmentPerson } from "../convex/lib/linkedin/segments.ts";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const DAY = 86_400_000;
const person = (over: Partial<SegmentPerson> = {}): SegmentPerson => ({
  state: "queued", invitedAt: null, connectedAt: null, lastSentAt: null,
  title: null, company: null, seniority: null, roleStart: null, activity: null, ...over,
});
const invited = (over: Partial<SegmentPerson> = {}) => person({ state: "invited", invitedAt: NOW - 10 * DAY, ...over });
const accepted = (over: Partial<SegmentPerson> = {}) => person({ state: "connected", invitedAt: NOW - 10 * DAY, connectedAt: NOW - 5 * DAY, ...over });
const replied = (over: Partial<SegmentPerson> = {}) => person({ state: "replied", invitedAt: NOW - 10 * DAY, connectedAt: NOW - 5 * DAY, lastSentAt: NOW - 4 * DAY, ...over });

test("rates per segment: acceptance over invited, response over everyone connected", () => {
  const rows = segmentBreakdown([
    replied({ title: "VP Sales" }), accepted({ title: "vp, sales " }), invited({ title: "VP Sales" }), invited({ title: "VP Sales" }),
    person({ state: "replied", connectedAt: NOW - DAY, title: "Director of Sales" }),
    invited({ title: null }),
  ], "title", NOW);
  assert.deepEqual(rows.map((r) => r.segment), ["VP Sales", "Director of Sales", "Unknown"]);
  const vp = rows[0];
  assert.deepEqual([vp.people, vp.invited, vp.accepted, vp.connected, vp.replied, vp.acceptRate, vp.responseRate], [4, 4, 2, 2, 1, 50, 50]);
  // Already connected, never invited: no acceptance rate, but a response rate.
  assert.deepEqual([rows[1].acceptRate, rows[1].responseRate], [null, 100]);
});

test("seniority prefers the enriched value, else reads the title", () => {
  const rows = segmentBreakdown([
    invited({ title: "Chief Revenue Officer" }), invited({ seniority: "vp", title: "Head of Sales" }), invited({ title: "Account Executive" }),
  ], "seniority", NOW);
  assert.deepEqual(rows.map((r) => r.segment).sort(), ["C-level", "Unknown", "VP"]);
});

test("small title and company groups fold into Other; Unknown stays last", () => {
  const people = Array.from({ length: SEGMENTS_MAX + 3 }, (_, i) => invited({ company: `Co ${i}` }));
  people.push(invited({ company: "Co 0" }), invited({ company: null }));
  const rows = segmentBreakdown(people, "company", NOW);
  assert.equal(rows[0].segment, "Co 0");
  assert.equal(rows.length, SEGMENTS_MAX + 2);
  assert.deepEqual(rows.slice(-2).map((r) => [r.segment, r.people]), [["Other", 3], ["Unknown", 1]]);
});

test("bands: time in role and recent activity, in fixed order", () => {
  assert.equal(tenureBand("2026-03-01", NOW), "Under 1 year");
  assert.equal(tenureBand("2022-01-01", NOW), "3–5 years");
  assert.equal(tenureBand("garbage", NOW), "Unknown");
  assert.equal(activityBand(null, NOW), "Not checked");
  assert.equal(activityBand({ lastActiveAt: null, checkedAt: NOW }, NOW), "No posts or comments found");
  assert.equal(activityBand({ lastActiveAt: NOW - 60 * DAY, checkedAt: NOW }, NOW), "Active 31–90 days ago");
  const rows = segmentBreakdown([invited(), invited({ activity: { lastActiveAt: NOW - DAY, checkedAt: NOW } })], "activity", NOW);
  assert.deepEqual(rows.map((r) => r.segment), ["Active in last 30 days", "Not checked"]);
  assert.equal(titleKey("  "), "Unknown");
});
