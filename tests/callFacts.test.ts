import assert from "node:assert/strict";
import test from "node:test";
import { groundedFacts, threadText, type ConversationFactsContext } from "../convex/lib/conversations/facts.ts";

const context: ConversationFactsContext = {
  source: { kind: "call", id: "call" },
  title: "Acme sync",
  day: "2026-10-11",
  summary: "Legal review starts next week.",
  text: "Riley: Where are you on budget?\nSam Lee: Budget is approved.  We want to sign by November 20th.\nSam Lee: I just moved into the CFO role last month.\nRiley: I'll send the order form by Thursday.",
  deal: { name: "Acme expansion", stage: "Proposal", nextStep: "Book the demo", closeDate: "2026-12-31" },
  people: [{ email: "sam@acme.example", name: "Sam Lee", title: "VP Finance" }],
};

test("only values quoted word for word from the call are proposed, with real dates on or after the meeting", () => {
  const facts = groundedFacts({
    // Whitespace and case differ from the transcript: still the same words.
    nextStep: { value: "Send the order form by Thursday", evidence: "i'll send the order form by thursday." },
    closeDate: { value: "2026-11-20", evidence: "We want to sign by November 20th." },
    titles: [
      { email: "Sam@acme.example", value: "CFO", evidence: "I just moved into the CFO role last month." },
      { email: "stranger@acme.example", value: "CEO", evidence: "I just moved into the CFO role last month." },
    ],
  }, context);
  assert.deepEqual(facts.map((f) => [f.entityType, f.attribute, f.value]), [
    ["opportunity", "nextStep", "Send the order form by Thursday"],
    ["opportunity", "closeDate", "2026-11-20"],
    ["contact", "title", "CFO"],
  ]);
});

test("a paraphrased quote, an impossible or past date, and a value already on record are dropped", () => {
  const facts = groundedFacts({
    nextStep: { value: "Book the demo", evidence: "Riley: I'll send the order form by Thursday." },
    closeDate: { value: "2026-02-30", evidence: "We want to sign by November 20th." },
    titles: [{ email: "sam@acme.example", value: "CFO", evidence: "Sam said he is the new CFO now." }],
  }, context);
  assert.deepEqual(facts, []);
  assert.deepEqual(groundedFacts({ closeDate: { value: "2026-10-01", evidence: "We want to sign by November 20th." } }, context), []);
  // No deal linked: deal answers are ignored.
  assert.deepEqual(groundedFacts({ nextStep: { value: "Send it", evidence: "I'll send the order form by Thursday." } }, { ...context, deal: null }), []);
});

test("a LinkedIn thread is grounded the same way: a quote of one message counts, the line's prefix is not needed", () => {
  const day = Date.UTC(2026, 9, 20);
  const thread: ConversationFactsContext = {
    ...context, source: { kind: "linkedin", id: "conversation" }, title: "Sam Lee", day: "2026-10-20", summary: null,
    text: threadText([
      { at: day + 60_000, from: "Sam Lee", direction: "them", text: "Makes sense.\nWe want to sign by November 20th." },
      { at: day, from: "Riley", direction: "us", text: "Where are you on budget?" },
    ]),
  };
  assert.match(thread.text, /^\[2026-10-20\] Riley \(us\): Where are you on budget\?\n\[2026-10-20\] Sam Lee \(them\): Makes sense\. We want/);
  const facts = groundedFacts({
    closeDate: { value: "2026-11-20", evidence: "We want to sign by November 20th." },
    nextStep: { value: "Send pricing", evidence: "Sam wants pricing sent over." },
  }, thread);
  assert.deepEqual(facts.map((f) => [f.attribute, f.value]), [["closeDate", "2026-11-20"]]);
});
