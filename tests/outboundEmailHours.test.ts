import assert from "node:assert/strict";
import { test } from "node:test";
import { automatedEmailHours } from "../convex/lib/outbound/emailHours.ts";

const at = (time: string, over: Record<string, unknown> = {}) => automatedEmailHours({ now: Date.parse(time), purpose: "automated", workspaceTimezone: "UTC", ...over } as never);
function held(time: string, expected: string, over: Record<string, unknown> = {}) {
  const result = at(time, over);
  assert.equal(result.state, "held");
  if (result.state !== "held") throw new Error("Expected held hours");
  assert.equal(result.notBefore, Date.parse(expected));
  assert.equal(at(expected, over).state, "allow");
}

test("weekday hours include 08:00 and exclude 18:00 with the earliest next opening", () => {
  held("2026-10-19T07:59:59.999Z", "2026-10-19T08:00:00Z");
  assert.equal(at("2026-10-19T08:00:00Z").state, "allow");
  assert.equal(at("2026-10-19T17:59:59.999Z").state, "allow");
  held("2026-10-19T18:00:00Z", "2026-10-20T08:00:00Z");
});

test("Friday close and weekend reads hold until Monday", () => {
  for (const time of ["2026-10-23T18:00:00Z", "2026-10-24T10:00:00Z", "2026-10-25T10:00:00Z"]) held(time, "2026-10-26T08:00:00Z");
});

test("spring and fall DST weekends use the offset at the future local opening", () => {
  const zone = { recipientTimezone: "America/New_York" };
  held("2026-03-06T23:00:00Z", "2026-03-09T12:00:00Z", zone);
  held("2026-10-30T22:00:00Z", "2026-11-02T13:00:00Z", zone);
});

test("fractional offsets and half-hour DST shifts preserve the exact local opening", () => {
  held("2026-10-19T02:14:59.999Z", "2026-10-19T02:15:00Z", { recipientTimezone: "Asia/Kathmandu" });
  held("2026-10-19T12:15:00Z", "2026-10-20T02:15:00Z", { recipientTimezone: "Asia/Kathmandu" });
  held("2026-10-02T07:30:00Z", "2026-10-04T21:00:00Z", { recipientTimezone: "Australia/Lord_Howe" });
  held("2026-04-03T07:00:00Z", "2026-04-05T21:30:00Z", { recipientTimezone: "Australia/Lord_Howe" });
});

test("the first available canonical timezone wins, and invalid chosen authority never falls back", () => {
  held("2026-10-19T08:00:00Z", "2026-10-19T12:00:00Z", { recipientTimezone: "America/New_York", companyTimezone: "invalid" });
  held("2026-10-19T08:00:00Z", "2026-10-19T12:00:00Z", { recipientTimezone: null, companyTimezone: "America/New_York" });
  assert.equal(at("2026-10-19T08:00:00Z", { recipientTimezone: null, companyTimezone: null }).state, "allow");
  for (const recipientTimezone of ["", "invalid", " America/New_York", "+05:30"]) assert.equal(at("2026-10-19T08:00:00Z", { recipientTimezone }).state, "refused");
  assert.equal(at("2026-10-19T08:00:00Z", { workspaceTimezone: null }).state, "refused");
});

test("trusted personal/manual purposes bypass only hours, while invalid time and classification refuse", () => {
  for (const purpose of ["personal", "manual"]) assert.equal(at("2026-10-24T22:00:00Z", { purpose, workspaceTimezone: null }).state, "allow");
  for (const now of [NaN, Infinity, null, -1, 1.5, Number.MAX_SAFE_INTEGER]) assert.equal(at("2026-10-19T08:00:00Z", { now, purpose: "manual" }).state, "refused");
  assert.equal(at("2026-10-19T08:00:00Z", { purpose: "approved" }).state, "refused");
});
