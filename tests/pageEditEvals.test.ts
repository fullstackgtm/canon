import assert from "node:assert/strict";
import { test } from "node:test";
import { DRAWN, refuseSectionRename } from "../recipes/md/pointed.ts";

// Customize mode's deterministic refusal: a model renamed the section the person pointed into. The live-model eval set
// is scripts/page-customize-eval.mjs; these are its cases that need no model.
const field = (text: string) => `${DRAWN}, reading "${text}" in the area headed "asdf"`;
const opportunity = field("Opportunity nameSpeedeon - QuotaQueue commissions software");

test("a request about the title renames the section even when the click landed on a field row", () => {
  assert.equal(refuseSectionRename("change title to Overview", opportunity, "asdf"), null);
  assert.equal(refuseSectionRename("rename the heading to Overview", opportunity, "asdf"), null);
  assert.equal(refuseSectionRename("rename asdf to Overview", opportunity, "asdf"), null);
  assert.equal(refuseSectionRename("call this section Overview", opportunity, "asdf"), null);
  assert.equal(refuseSectionRename("change section title to Opportunity name", opportunity, "asdf"), null);
});

test("a request about the drawn control is refused, not applied to the section", () => {
  assert.equal(refuseSectionRename("rename this to Deal", opportunity, "asdf"), "Opportunity nameSpeedeon - QuotaQueue commissions software");
  assert.ok(refuseSectionRename("rename Opportunity name to Deal name", opportunity, "asdf"));
  assert.ok(refuseSectionRename("change the opportunity name title to Deal", opportunity, "asdf"));
  assert.ok(refuseSectionRename("rename this to Find people", field("Search contacts"), "Choose who to reach first"));
});

test("pointing at the title, a part or a button never trips the drawn-control rule", () => {
  assert.equal(refuseSectionRename("rename this to Deal", `the section's title, reading "Overview"`, "Overview"), null);
  assert.equal(refuseSectionRename("rename this to Deal", undefined, "Overview"), null);
});
