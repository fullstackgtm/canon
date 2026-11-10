import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseRecipe } from "../recipes/md/parse.ts";
import { termsFor, DEFAULT_DEAL_TERMS } from "../recipes/terms.ts";
import { cleanReview } from "../convex/lib/plays/drafts.ts";
import { summarizeState, verifiedState, type StateSource } from "../convex/lib/plays/state.ts";

test("recipe terms turn cited concessions into stable risks and survive the draft model review", () => {
  for (const name of ["fsgtm-enterprise-deal", "fsgtm-velocity-deal"]) {
    const parsed = parseRecipe(readFileSync(`recipes/${name}/recipe.md`, "utf8"));
    assert.deepEqual(parsed.problems, []);
    assert.deepEqual(parsed.recipe.data?.terms, DEFAULT_DEAL_TERMS);
  }
  assert.deepEqual(termsFor({}), DEFAULT_DEAL_TERMS);
  assert.deepEqual(termsFor({ terms: [] }), []);
  const terms = termsFor({});
  const quote = "Please strike auto-renew from the renewal.";
  const sources: StateSource[] = [{ kind: "call", id: "call:1", text: quote, buyerTexts: [quote], activity: true, at: 1 }];
  const cited = { kind: "call", id: "call:1", quote };
  const concern = { kind: "objection", title: "Model title", text: "The buyer requests removal of auto-renew.", raisedBy: "Buyer", sources: [cited] };
  const state = verifiedState({ summary: "A renewal.", stage: { label: "Negotiation", reason: "Terms under discussion." }, qualification: [], concerns: [
    { ...concern, key: "term:auto_renew" },
    { ...concern, key: "term:payment", sources: [{ ...cited, quote: "We agreed net 90." }] },
    { ...concern, key: "term:invented" },
    { ...concern, key: "other", kind: "risk", text: "Another issue." },
  ] }, { name: "Test", lines: [] }, sources, { read: 1, total: 1, omitted: 0, partial: false, inventoryLimited: false }, "Negotiation", 2, terms);
  assert.deepEqual(state.concerns.map((c) => [c.key, c.kind, c.title, c.severity, c.sources[0].quote]), [
    ["term:auto_renew", "risk", "Auto-renew", "high", quote], ["other", "risk", "Model title", undefined, quote],
  ]);
  state.concerns[1].lastObservedAt = 3;
  assert.equal(summarizeState(state).mainIssue, "The buyer requests removal of auto-renew.");
  const review = { relevant: true, wouldReply: true, termConcessions: ["auto_renew"] };
  assert.deepEqual(cleanReview(review, false, terms)?.termConcessions, [{ key: "auto_renew", label: "Auto-renew", severity: "high" }]);
  assert.equal(cleanReview({ ...review, termConcessions: ["invented"] }, false, terms), null);
});
