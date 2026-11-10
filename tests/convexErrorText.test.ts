import assert from "node:assert/strict";
import test from "node:test";
import { ConvexError } from "convex/values";
import { explainConvexError } from "../src/lib/convexErrorText.ts";

// Messages as ConvexHttpClient raised them against a local backend.
const typeMismatch = new Error('[Request ID: 762387dfba8a7a57] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .amount\nValue: "lots"\nValidator: v.float64()\n\n');
const missingNested = new Error('[Request ID: 53a1cd24080f454e] Server Error\nArgumentValidationError: Object is missing the required field `dir`. Consider wrapping the field validator in `v.optional(...)` if this is expected.\nPath: .sort\nObject: {field: "nofield"}\nValidator: v.object({dir: v.union(v.literal("asc"), v.literal("desc")), field: v.string()})\n\n');
const rejected = Object.assign(new ConvexError("unknown sort field nofield"), { message: "[Request ID: 10894a8f88238959] Server Error\nUncaught ConvexError: unknown sort field nofield\n    at asListError (../../convex/objects.ts:879:2)\n" });
const redacted = new Error("[Request ID: 0a1b2c3d] Server Error");

const NOISE = /Server Error|Request ID|Uncaught|\bat \w|v\.optional|Validator:/;

test("argument failures name the field and what it takes, without author-facing advice", () => {
  const amount = explainConvexError(typeMismatch);
  assert.deepEqual([amount.kind, amount.field, amount.requestId], ["invalid_argument", "amount", "762387dfba8a7a57"]);
  assert.match(amount.message, /number/);
  const dir = explainConvexError(missingNested);
  assert.deepEqual([dir.kind, dir.field], ["invalid_argument", "sort.dir"]);
  assert.match(dir.message, /asc.*desc/);
  for (const e of [amount, dir]) assert.doesNotMatch(e.message, NOISE);
});

test("a ConvexError keeps its own message; a redacted error says what to do", () => {
  assert.deepEqual(explainConvexError(rejected), { kind: "rejected", message: "unknown sort field nofield", requestId: "10894a8f88238959" });
  const internal = explainConvexError(redacted);
  assert.equal(internal.kind, "internal");
  assert.match(internal.message, /0a1b2c3d/);
});

test("a union of a number and a literal reads as both choices", () => {
  const e = explainConvexError(new Error('[Request ID: 1] Server Error\nArgumentValidationError: Object is missing the required field `compare`.\n\nObject: {}\nValidator: v.object({compare: v.union(v.float64(), v.literal("yoy")), year: v.float64()})\n\n'));
  assert.equal(e.field, "compare");
  assert.doesNotMatch(e.message, /v\.|float64/);
  assert.match(e.message, /number.*"yoy"/);
});

test("grouped MCP tools name args.<field> and their action, and a null result says nothing matched", async () => {
  const { toolErrorMessage, toolResultText } = await import("../src/app/mcp/_canonTools.ts");
  const grouped = { name: "canon_pacing", inputSchema: { action: {}, args: {} } } as never;
  const message = toolErrorMessage(grouped, { action: "history", args: {} }, new Error("[Request ID: 1] Server Error\nArgumentValidationError: Object is missing the required field `year`.\n\nObject: {}\nValidator: v.object({year: v.float64()})\n\n"));
  assert.match(message, /^canon_pacing history: args\.year is required/);
  assert.equal(JSON.parse(toolResultText({ name: "canon_deal_play", writes: true }, { action: "get" }, null)).found, false);
  assert.deepEqual(JSON.parse(toolResultText({ name: "canon_reports", writes: true }, { action: "remove" }, null)), { ok: true });
});

test("a whole number the caller sent reads as sent, not as Convex's float", () => {
  const e = explainConvexError(new Error('[Request ID: 2] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .domain\nValue: 12345.0\nValidator: v.string()\n\n'));
  assert.match(e.message, /\(got 12345\)$/);
});
