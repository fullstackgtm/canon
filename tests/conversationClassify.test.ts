import assert from "node:assert/strict";
import test from "node:test";
import { classifyConversation, gateSuggestions, obviousClass, type ClassifyInput } from "../convex/lib/conversations/classify.ts";
import type { PlannedSuggestion } from "../convex/lib/calls/suggestions.ts";

const base: ClassifyInput = { channel: "email", title: "Grace", email: "grace@acme.com", text: "Can we see a demo next week?", fromUs: 1, fromThem: 2, customer: false, openDeal: false };
const planned: PlannedSuggestion[] = [
  { kind: "account", key: "acme.com", values: { domain: "acme.com" } },
  { kind: "contact", key: "grace@acme.com", values: { email: "grace@acme.com", name: "Grace" } },
  { kind: "deal", key: "conversation:c", values: { name: "Acme pilot" } },
];

test("bulk senders, unsubscribe footers and threads nobody answered are marketing without asking Jev", () => {
  assert.equal(obviousClass({ ...base, email: "no-reply@vendor.io" }), "marketing");
  assert.equal(obviousClass({ ...base, email: "newsletter+weekly@vendor.io" }), "marketing");
  assert.equal(obviousClass({ ...base, text: "Big launch! Unsubscribe here." }), "marketing");
  assert.equal(obviousClass({ ...base, fromUs: 0 }), "marketing");
  assert.equal(obviousClass(base), null);
  // A meeting is always read.
  assert.equal(obviousClass({ ...base, channel: "call", fromUs: 0 }), null);
});

test("only a confident sales conversation suggests a deal; customers suggest people; vendors and the rest nothing", async () => {
  const jev = (choice: string, confidence = 0.9) => async () => ({ choice, confidence });
  const kinds = (c: Awaited<ReturnType<typeof classifyConversation>>) => gateSuggestions(c, planned).map((s) => s.kind);
  assert.deepEqual(kinds(await classifyConversation(base, jev("sales"))), ["account", "contact", "deal"]);
  assert.deepEqual(kinds(await classifyConversation(base, jev("sales", 0.4))), ["account", "contact"]);
  assert.deepEqual(kinds(await classifyConversation(base, jev("customer"))), ["contact"]);
  assert.deepEqual(kinds(await classifyConversation(base, jev("vendor"))), []);
  assert.deepEqual(kinds(await classifyConversation({ ...base, email: "noreply@x.io" }, jev("sales"))), []);
  // Without Jev (or when it fails) a won company is a customer and anyone else is read as sales.
  assert.deepEqual(kinds(await classifyConversation({ ...base, customer: true }, null)), ["contact"]);
  assert.deepEqual(kinds(await classifyConversation(base, async () => { throw new Error("down"); })), ["account", "contact", "deal"]);
});
