import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteFound } from "../modules/kernel/evidence.ts";
import { aiProblems, choiceValues, fakeAnswer, gateAnswer, outputSchema, type AiDecl } from "../modules/kernel/ai.ts";
import type { ModuleManifest } from "../modules/kernel/manifest.ts";

const line = "Honestly the per-seat price was about forty percent over what Acme quoted us.";

test("a quote counts only word for word, case and spacing aside, and at least 12 characters", () => {
  assert.equal(quoteFound("the per-seat price was about forty percent over what Acme quoted us", line), true);
  assert.equal(quoteFound("THE PER-SEAT PRICE  was about forty percent", line), true);
  assert.equal(quoteFound("Acme was 40% cheaper", line), false, "a paraphrase");
  assert.equal(quoteFound("forty", line), false, "too short to mean anything");
});

/** A review's drivers, each with quotes from the deal's activities: win-loss.md's draft, in miniature. */
const str = { fieldType: { type: "string" as const }, optional: false };
const manifest = {
  ops: { "reviews.saveDraft": { label: "Save", kind: "update", collection: "reviews", fields: ["summary", "drivers"], roles: ["rep"], agent: "allowed" } },
  collections: { reviews: { schema: { type: "object", value: {
    summary: { fieldType: { type: "string", maxLength: 2000 }, optional: true },
    drivers: { fieldType: { type: "array", value: { type: "object", value: {
      reason: str, quotes: { fieldType: { type: "array", value: { type: "object", value: { text: str, source: str } } }, optional: false },
    } } }, optional: true },
  } }, key: "auto", indexes: {}, access: {} } },
} as unknown as ModuleManifest;
const ai: AiDecl = {
  prompt: "Draft the review.", output: { op: "reviews.saveDraft", key: { arg: "review" }, fields: ["summary", "drivers"] },
  choices: { "drivers[].reason": { read: "reasons" } },
  evidence: [{ quote: "drivers[].quotes[].text", source: "drivers[].quotes[].source", in: "acts", text: ["text"], dropParent: "drivers[]" }],
};
const doc = (key: string, data: Record<string, unknown>) => ({ key, version: 1, data, owner: null, parentKey: null, createdAt: 0, updatedAt: 0 });
const reads = {
  reasons: [doc("price", { label: "Price" }), doc("integrations", { label: "Integrations" }), doc("fit", { label: "Product fit" })],
  acts: [{ id: "call1", text: `Birch: ${line}` }, { id: "note1", text: "They need the Workday integration before they can roll out." }],
};

test("the gate keeps quotes found in the record they name, and drops paraphrases, strangers and drivers left bare", () => {
  const schema = outputSchema(manifest, ai)!;
  const choices = choiceValues(ai, reads);
  assert.deepEqual(choices, { "drivers[].reason": ["price", "integrations", "fit"] });
  const raw = {
    summary: "Lost on price to Acme.",
    drivers: [
      { reason: "price", quotes: [{ text: "the per-seat price was about forty percent over", source: "call1" }, { text: "Acme was 40% cheaper", source: "call1" }] },
      { reason: "integrations", quotes: [{ text: "need the Workday integration before they can roll out", source: "note1" }] },
      { reason: "fit", quotes: [{ text: "the per-seat price was about forty percent over", source: "garnetCall" }] },
      { reason: "timing", quotes: [{ text: "need the Workday integration", source: "note1" }] },
    ],
    extra: "dropped: not a field the op writes",
  };
  const g = gateAnswer(ai, schema, raw, reads, choices);
  assert.deepEqual(g.data.drivers, [
    { reason: "price", quotes: [{ text: "the per-seat price was about forty percent over", source: "call1" }] },
    { reason: "integrations", quotes: [{ text: "need the Workday integration before they can roll out", source: "note1" }] },
  ]);
  assert.equal(g.data.extra, undefined);
  assert.equal(g.kept, 2);
  assert.deepEqual(g.dropped.map((d) => [d.path, d.why]), [
    ["drivers[3].reason", "not one of the choices it read (reasons)"],
    ["drivers[0].quotes[1].text", "not found word for word in the record it names"],
    ["drivers[2].quotes[0].text", "names a record it didn't read"],
    ["drivers[2]", "no quote left"],
  ]);
  // Canon's test model answers from the reads alone, and its answer passes the gate whole.
  const fake = gateAnswer(ai, schema, fakeAnswer(ai, schema, reads, choices), reads, choices);
  assert.deepEqual([fake.kept, fake.dropped.length], [2, 0]);
});

test("an AI step fills fields its update op writes, and quotes sit in a list of a read", () => {
  const bad: AiDecl = { ...ai, output: { ...ai.output, fields: ["summary", "drivers", "status"] }, evidence: [{ quote: "summary", in: "nothing" }] };
  const call = { label: "Draft", roles: ["rep"], agent: "allowed", args: { type: "object", value: { review: str } }, reads: { reasons: { view: "x" }, acts: { view: "y" } }, writes: ["reviews"], returns: "value", ai: bad } as const;
  assert.deepEqual(aiProblems(manifest, "draft", call as never), [
    "calls.draft.ai.output.fields[2] names status, which reviews.saveDraft doesn't write",
    "calls.draft.ai.evidence[0].quote sits in no list: a quote that fails drops its list item, so it sits in one",
    "calls.draft.ai.evidence[0].in names nothing, which draft doesn't read",
  ]);
});
