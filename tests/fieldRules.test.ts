// Required fields and validation rules (CP7b, convex/lib/objects/rules.ts):
// what an admin's rules do on every write, and which sources they never refuse.
import assert from "node:assert/strict";
import test from "node:test";
import { addField, updateField } from "../convex/lib/objects/fieldBuilder.ts";
import { autoMap, classify, readRows } from "../convex/lib/objects/csvImport.ts";
import { coerce, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";
import type { FieldRule } from "../convex/lib/objects/rules.ts";
import { checkUpdate } from "../convex/lib/objects/write.ts";

const NOW = Date.parse("2026-10-10T12:00:00Z");

/** An account with one custom field of `type`, required and carrying `rules`. */
function accountWith(label: string, type: "text" | "number" | "date", rules: FieldRule[], required = false) {
  const { ext, field } = addField("account", undefined, { label, type });
  const withRules = updateField("account", ext, field.fieldId, { rules, required });
  return { def: resolveObjectDef(STANDARD_OBJECTS.account, withRules), api: field.apiName, ext: withRules };
}

test("each rule refuses a value that breaks it, naming the rule and the field, and passes one that does not", () => {
  const cases: Array<[string, "text" | "number" | "date", FieldRule[], unknown, string | null]> = [
    ["Employee ID", "text", [{ kind: "pattern", pattern: "^E-\\d{4}$", message: "Use the form E-1234" }], "E-12", "Employee ID breaks its pattern rule: Use the form E-1234"],
    ["Employee ID", "text", [{ kind: "pattern", pattern: "^E-\\d{4}$", message: "Use the form E-1234" }], "E-1234", null],
    ["Code", "text", [{ kind: "maxLength", value: 3 }], "abcd", "Code breaks its maximum length rule: must be at most 3 characters"],
    ["Tier", "text", [{ kind: "oneOf", values: ["gold", "silver"] }], "bronze", "Tier breaks its one-of rule: must be one of gold, silver"],
    ["Seats", "number", [{ kind: "min", value: 1 }, { kind: "max", value: 10 }], "0", "Seats breaks its minimum rule: must be at least 1"],
    ["Seats", "number", [{ kind: "min", value: 1 }, { kind: "max", value: 10 }], 11, "Seats breaks its maximum rule: must be at most 10"],
    ["Seats", "number", [{ kind: "min", value: 1 }, { kind: "max", value: 10 }], 10, null],
    ["Renews", "date", [{ kind: "date", when: "notPast" }], "2026-10-09", "Renews breaks its date rule: must not be in the past"],
    ["Renews", "date", [{ kind: "date", when: "notPast" }], "2026-10-10", null],
    ["Signed", "date", [{ kind: "date", when: "notFuture" }], "2026-10-11", "Signed breaks its date rule: must not be in the future"],
  ];
  for (const [label, type, rules, value, message] of cases) {
    const { def, api } = accountWith(label, type, rules);
    const out = coerce(def, { [api]: value }, { mode: "update", now: NOW });
    assert.deepEqual(out.ok ? null : out.errors.map((e) => `${e.field}: ${e.message}`), message === null ? null : [`${api}: ${message}`], `${label} ${String(value)}`);
  }
});

test("required: a create must set it, an edit cannot clear it, and an edit of another field leaves a record that breaks a rule alone", () => {
  const { def, api } = accountWith("Employee ID", "text", [{ kind: "maxLength", value: 5 }], true);
  const errors = (input: Record<string, unknown>, mode: "create" | "update") => {
    const out = coerce(def, input, { mode, now: NOW });
    return out.ok ? [] : out.errors.map((e) => `${e.field}:${e.rule ?? e.message}`);
  };
  assert.deepEqual(errors({ name: "Acme" }, "create"), [`${api}:Employee ID is required`]);
  assert.deepEqual(errors({ [api]: "" }, "update"), [`${api}:Employee ID is required`]);
  assert.deepEqual(errors({ name: "Acme" }, "update"), []);
  assert.deepEqual(errors({ name: "Acme", [api]: "E-1" }, "create"), []);
});

test("a CRM sync is never refused by a rule or a required custom field; Canon's own creates skip only the must-set check", () => {
  const { def, api } = accountWith("Employee ID", "text", [{ kind: "maxLength", value: 3 }], true);
  assert.equal(coerce(def, { name: "Acme", [api]: "too long" }, { mode: "create", rules: "off" }).ok, true);
  assert.equal(coerce(def, { [api]: null }, { mode: "update", rules: "off" }).ok, true);
  assert.equal(coerce(def, { name: "Acme" }, { mode: "create", rules: "system" }).ok, true);
  assert.equal(coerce(def, { name: "Acme", [api]: "too long" }, { mode: "create", rules: "system" }).ok, false);
});

test("the write path (objects.write, the record API, MCP, agents) refuses by source: a person and an agent are checked, Salesforce is not", async () => {
  const { def, api } = accountWith("Employee ID", "text", [{ kind: "pattern", pattern: "^E-\\d+$", message: "Use the form E-1234" }]);
  const store = { findByExternalId: async () => null };
  const check = (kind: "user" | "agent_run" | "salesforce") =>
    checkUpdate(store, { orgId: "o", def, source: { kind, ref: "t" }, mayWrite: () => true }, { [api]: "nope" }, null);
  assert.deepEqual((await check("user")).map((e) => e.rule), ["pattern"]);
  assert.deepEqual((await check("agent_run")).map((e) => e.rule), ["pattern"]);
  assert.deepEqual(await check("salesforce"), []);
});

test("a CSV dry run fails a row that breaks a rule or leaves a required field empty, per row with the rule's name", () => {
  const { def, api } = accountWith("Employee ID", "text", [{ kind: "pattern", pattern: "^E-\\d{4}$", message: "Use the form E-1234" }], true);
  const header = ["Company", "Website", "Employee ID"];
  const csv = [header, ["Acme", "acme.com", "E-1234"], ["Globex", "globex.com", "7"], ["Initech", "initech.com", ""]];
  const outcomes = classify("account", def, readRows("account", def, autoMap("account", def, header), csv), new Map());
  assert.deepEqual(outcomes.map((o) => (o.kind === "error" ? o.errors.map((e) => `${e.field}:${e.rule ?? e.message}`) : o.kind)), [
    "create", [`${api}:pattern`], [`${api}:Employee ID is required`],
  ]);
});

test("the builder refuses rules a type does not take, a pattern that does not compile or has no message, and clears them on an empty list", () => {
  const { ext, field } = addField("account", undefined, { label: "Code", type: "text" });
  const set = (rules: FieldRule[]) => updateField("account", ext, field.fieldId, { rules });
  assert.throws(() => set([{ kind: "min", value: 1 }]));
  assert.throws(() => set([{ kind: "pattern", pattern: "(", message: "x" }]));
  assert.throws(() => set([{ kind: "pattern", pattern: "^a$", message: " " }]));
  const kept = set([{ kind: "maxLength", value: 3 }]);
  assert.equal(kept.customFields[0]!.rules?.length, 1);
  assert.equal(updateField("account", kept, field.fieldId, { rules: [] }).customFields[0]!.rules, undefined);
  // Deals hold scalars only, so a list-valued deal field could never satisfy a required check.
  const regions = addField("deal", undefined, { label: "Regions", type: "multipicklist", options: [{ label: "NA" }] });
  assert.throws(() => updateField("deal", regions.ext, regions.field.fieldId, { required: true }));
});
