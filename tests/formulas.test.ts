// Formula and rollup fields (CP7c, convex/lib/objects/formula.ts): what an
// admin's expression parses to, what is refused when it is defined, and that a
// computed field takes no writes. Evaluation is the record service's
// (services/record-service/test/computed.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { addField, updateField } from "../convex/lib/objects/fieldBuilder.ts";
import { FormulaError, parseFormula } from "../convex/lib/objects/formula.ts";
import { listColumns } from "../convex/lib/objects/listSpec.ts";
import { coerce, RegistryError, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";

const deal = resolveObjectDef(STANDARD_OBJECTS.deal);

test("formulas parse to typed trees, and bad ones are refused at definition time", () => {
  const accepted: Array<[string, string]> = [
    ["daysBetween(today(), closeDate)", "number"],
    ["amount * (probability / 100) - 5", "number"],
    ["-amount", "number"],
    ["concat(name, ' (', stage, ')')", "text"],
    ["IF(isClosed AND isWon, 'won', \"open\")", "text"],
    ["amount >= 50000 or not isBlank(nextStep)", "checkbox"],
    ["closeDate < today()", "checkbox"],
    ["round(amount / 3, 2)", "number"],
    ["if(isClosed, closeDate, today())", "date"],
    ["updatedAt > createdAt", "checkbox"],
  ];
  for (const [src, type] of accepted) assert.equal(parseFormula(deal, src).t, type, src);
  assert.deepEqual(parseFormula(deal, "amount / 2"), {
    t: "number", k: "bin", op: "/", left: { t: "number", k: "field", name: "amount", money: true }, right: { t: "number", k: "num", v: 2 },
  });

  const refused = [
    "", "amout + 1", "sum(amount)", "amount + name", "name > 3", "isClosed < isWon", "if(amount, 1, 2)", "if(isClosed, 1, 'a')",
    "round(amount, digits)", "round(amount, 11)", "daysBetween(closeDate)", "today(1)", "(amount", "amount)", "'open", "amount $ 2",
    "not amount", "1e999", `${"(".repeat(30)}1${")".repeat(30)}`, "x".repeat(1001),
  ];
  for (const src of refused) assert.throws(() => parseFormula(deal, src), FormulaError, src);
});

test("a formula or rollup field is checked when defined, and refuses writes", () => {
  const { ext, field } = addField("deal", undefined, { label: "Days to close", type: "formula", compute: { formula: "daysBetween(today(), closeDate)", returns: "number" } });
  assert.deepEqual([field.type, "returns" in field && field.returns], ["formula", "number"]);
  assert.throws(() => addField("deal", undefined, { label: "Bad", type: "formula", compute: { formula: "name", returns: "number" } }), RegistryError);
  // A register lists companies and people without createdAt, so a formula naming it would save and read empty: refuse it.
  assert.throws(() => addField("contact", undefined, { label: "Age", type: "formula", compute: { formula: "daysBetween(createdAt, today())", returns: "number" } }), RegistryError);
  assert.throws(() => updateField("deal", ext, field.fieldId, { compute: { formula: "amout", returns: "number" } }), RegistryError);
  assert.throws(() => updateField("deal", ext, field.fieldId, { required: true }), RegistryError);

  const def = resolveObjectDef(STANDARD_OBJECTS.deal, ext);
  assert.equal(listColumns(def).get(field.apiName)?.kind, "number", "lists, filters and sorts as the type it gives");
  const write = coerce(def, { [field.apiName]: 4 }, { mode: "update" });
  assert.equal(write.ok, false);
  assert.equal(!write.ok && write.errors[0].field, field.apiName);

  const related = (o: string) => (o === "deal" ? def : null);
  const rollup = { object: "deal", via: "companyId", fn: "sum" as const, field: "amount" };
  const open = addField("account", undefined, { label: "Open pipeline", type: "rollup", compute: { formula: "not isClosed", rollup } }, new Set(), related);
  assert.equal("returns" in open.field && open.field.returns, "currency", "a sum of amounts is money");
  assert.equal(coerce(resolveObjectDef(STANDARD_OBJECTS.account, open.ext), { "custom.open_pipeline": 1 }, { mode: "update" }).ok, false);
  for (const bad of [{ ...rollup, via: "name" }, { ...rollup, field: "name" }, { ...rollup, fn: "count" as const }, { ...rollup, object: "lead" }]) {
    assert.throws(() => addField("account", undefined, { label: "X", type: "rollup", compute: { formula: "", rollup: bad } }, new Set(), related), RegistryError, JSON.stringify(bad));
  }
  assert.throws(() => addField("account", undefined, { label: "X", type: "rollup", compute: { formula: "amount", rollup } }, new Set(), related), RegistryError, "a filter must be true or false");
});
