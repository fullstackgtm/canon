import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeCompanyName, normalizeFirstName, normalizeVariables, renderVariables } from "../convex/lib/sequences/variables.ts";
import { loadConvex } from "./convexHandlers.ts";

test("campaign variables normalize names, suffixes and whitespace without losing intentional capitals", () => {
  assert.equal(normalizeCompanyName("  SMITH   PAVING INC. "), "Smith Paving");
  assert.equal(normalizeCompanyName("IBM Corp"), "IBM");
  assert.equal(normalizeCompanyName("smith paving L.L.C."), "Smith Paving");
  assert.equal(normalizeFirstName("JOHN"), "John");
  assert.equal(normalizeFirstName("mcdonald"), "McDonald");
  assert.equal(normalizeFirstName("DeAndre"), "DeAndre");
  assert.equal(normalizeFirstName("O'Brien"), "O'Brien");
  assert.equal(normalizeFirstName("van der Meer"), "van der Meer");
  assert.deepEqual(normalizeVariables({ title: "  VP   of Sales ", "to.firstName": " ", "company.name": "SMITH PAVING INC." }), { title: "VP of Sales", "to.firstName": "Smith Paving team", "company.name": "Smith Paving" });
});

test("the rendered greeting falls back to the company team and fails closed on unresolved variables and catch-all email", () => {
  const template = { subject: "Hello {{firstName}}", body: "Hi {first_name}, meet {{company}}." };
  const values = { "to.firstName": "", "company.name": "SMITH PAVING INC.", "to.email": "sam@smith.test" };
  const result = renderVariables(template, values, "valid");
  assert.equal(result.subject, "Hello Smith Paving team");
  assert.equal(result.body, "Hi Smith Paving team, meet Smith Paving.");
  assert.deepEqual(result.problems, []);
  assert.deepEqual(renderVariables(template, values, "catch_all").problems, ["Email must have Canon status valid."]);
  assert.deepEqual(renderVariables({ subject: "Hi", body: "Hello {{custom.missing}}" }, values, "valid").problems, ["Required variable custom.missing is empty.", "The message contains a leftover placeholder."]);
  assert.deepEqual(renderVariables({ subject: "Hi", body: "{{custom.code}}" }, { ...values, "custom.code": "PLACEHOLDER" }, "valid").problems, ["Variable custom.code is still all caps."]);
  assert.deepEqual(renderVariables({ subject: "Hi", body: "{{constructor}}" }, values, "valid").problems, ["Required variable constructor is empty.", "The message contains a leftover placeholder."]);
  assert.deepEqual(renderVariables(template, { ...values, "company.name": "" }, "valid").problems, ["Required variable to.firstName is empty.", "Required variable company.name is empty.", "The message contains a leftover placeholder."]);
});

test("approval requires a signed review of the same recipients and template versions", async () => {
  const graph = loadConvex(["lib/sequences/preflight.ts"], {}, { process: { env: { TOKEN_ENCRYPTION_KEY: "fixture-only" } } });
  const { signVariableReview, requireVariableReview } = graph["lib/sequences/preflight.ts"] as unknown as typeof import("../convex/lib/sequences/preflight");
  const plan = { orgId: "org", userId: "user", sequenceKey: "seq", version: 1, templates: [{ step: 1, variant: "A", subject: "Hi", body: "Hello" }], recipients: [{ key: "enrolled", version: 1, contactId: "con_a", name: "John" }], senders: [], usesEmail: true };
  await assert.rejects(requireVariableReview(plan));
  const token = await signVariableReview(plan);
  await requireVariableReview(plan, token);
  await assert.rejects(requireVariableReview({ ...plan, version: 2 }, token));
  await assert.rejects(requireVariableReview({ ...plan, recipients: [...plan.recipients, { key: "other", version: 1, contactId: "con_b", name: "Other" }] }, token));
});
