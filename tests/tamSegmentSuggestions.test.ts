import assert from "node:assert/strict";
import test from "node:test";
import {
  bucketCounts,
  contextText,
  parseSuggestions,
  questionFor,
  splitScore,
  suggestionPrompt,
  type SuggestionContext,
} from "../convex/lib/tam/segmentSuggestions.ts";

const context: SuggestionContext = {
  vendorDomain: "commissionly.example",
  buyers: [{ label: "Wholesale distributors", why: "They pay field reps on commission." }],
  jobs: ["calculate sales commissions"],
  existingSegments: [{ label: "Commissioned reps", criterion: "The company employs commissioned sales reps." }],
  closedDeals: [
    { name: "Acme renewal", won: true, account: "Acme Supply", industry: "Wholesale", employees: 240, amount: 48000 },
    { name: "Beta pilot", won: false, account: "Beta Labs", industry: "Software" },
  ],
  callInsights: [{ type: "pain_point", text: "Spreadsheets break every quarter", evidence: "our spreadsheet breaks every single quarter close" }],
  sampleAccounts: [{ name: "Gamma Foods", industry: "Food distribution", employees: 120, country: "US" }],
};

test("prompt and context carry every input, and mark existing segments as off-limits", () => {
  const text = contextText(context);
  assert.match(text, /WON: Acme renewal \(Acme Supply, Wholesale, 240 employees, \$48,000\)/);
  assert.match(text, /LOST: Beta pilot/);
  assert.match(text, /our spreadsheet breaks every single quarter close/);
  assert.match(text, /Gamma Foods \(Food distribution, 120 employees, US\)/);
  assert.match(text, /do not repeat/);
  assert.match(suggestionPrompt(context), /homepage/);
  assert.match(suggestionPrompt(context), /never propose a trait that restates them/);
});

test("parseSuggestions keeps only verbatim basis quotes, drops duplicates and malformed choices", () => {
  const inputs = contextText(context);
  const out = parseSuggestions(
    {
      suggestions: [
        {
          label: "Field sales team",
          kind: "noul",
          criterion: "The company sells through a team of field sales reps.",
          rationale: "Won deals are distributors.",
          basis: ["Our Spreadsheet  breaks every single quarter close", "a quote that is not in the inputs"],
          options: [{ label: "ignored for yes/no" }],
        },
        // Repeats an existing segment.
        { label: "Commissioned reps", kind: "noul", criterion: "x x x x", rationale: "", basis: [] },
        // A choice with one option is not a choice.
        { label: "Motion", kind: "choice", criterion: "Primary sales motion?", options: [{ label: "Self-serve" }], rationale: "", basis: [] },
        {
          label: "Sales motion",
          kind: "choice",
          criterion: "What is the company's primary sales motion?",
          options: [{ label: "Self-serve" }, { label: "Field sales", description: "reps visit customers" }, { label: "Field Sales" }, { label: "None" }],
          rationale: "Motion predicts commission complexity.",
          basis: [],
        },
        { label: "", kind: "noul", criterion: "missing label", rationale: "", basis: [] },
      ],
    },
    inputs,
    context.existingSegments,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].basis, ["Our Spreadsheet  breaks every single quarter close"]);
  assert.equal(out[0].options, undefined);
  assert.equal(out[1].kind, "choice");
  assert.deepEqual(out[1].options?.map((o) => o.key), ["self-serve", "field-sales"]);
  assert.equal(out[1].options?.[1].description, "reps visit customers");
  assert.deepEqual(parseSuggestions("garbage", inputs, []), []);
});

test("questionFor builds the same Jev questions as hand-made segments", () => {
  assert.equal(questionFor({ kind: "noul", criterion: "It sells to dentists." }).type, "noul");
  const choice = questionFor({ kind: "choice", criterion: "Motion?", options: [{ key: "a", label: "A" }, { key: "b", label: "B" }] });
  assert.equal(choice.type, "choice");
  assert.ok("none" in (choice as { criteria: Record<string, unknown> }).criteria);
});

test("bucketCounts uses Jev's thresholds; splitScore rewards decisive, two-sided splits", () => {
  const counts = bucketCounts([
    { type: "noul", noul: 0.9 },
    { type: "noul", noul: 0.1 },
    { type: "noul", noul: 0.5 },
    null,
  ]);
  assert.deepEqual(counts, { yes: 1, no: 1, unsure: 1 });

  const splits = splitScore({ yes: 12, no: 25, unsure: 3 });
  assert.equal(splits.verdict, "splits");
  assert.equal(splits.score, 0.925);
  const oneSided = splitScore({ yes: 39, no: 1 });
  assert.equal(oneSided.verdict, "one-sided");
  assert.ok(oneSided.score < splits.score);
  // 2 of 40 is decisive but a sliver: one-sided, and scored well below a real split.
  const sliver = splitScore({ yes: 2, no: 38 });
  assert.equal(sliver.verdict, "one-sided");
  assert.equal(sliver.score, 0.25);
  assert.equal(splitScore({ yes: 5, no: 5, unsure: 30 }).verdict, "mostly-unsure");
  assert.equal(splitScore({}).verdict, "not-measured");
  assert.equal(splitScore({ "field-sales": 20, "self-serve": 15, none: 5 }).verdict, "splits");
});
