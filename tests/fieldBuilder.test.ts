// The field builder (CP7a, convex/lib/objects/fieldBuilder.ts) and the field
// types it adds: what an admin's edits do to the registry, and what the
// registry then accepts.
import assert from "node:assert/strict";
import test from "node:test";
import { addField, archiveField, restoreField, updateField } from "../convex/lib/objects/fieldBuilder.ts";
import { autoMap, importColumns, readRows } from "../convex/lib/objects/csvImport.ts";
import { listColumns, registerListDef } from "../convex/lib/objects/listSpec.ts";
import { coerce, resolveObjectDef, STANDARD_OBJECTS } from "../convex/lib/objects/registry.ts";

const risk = (reserved = new Set<string>()) => addField("account", undefined, {
  label: "Renewal risk", type: "picklist", options: [{ label: "High", color: "red" }, { label: "Low", color: "green" }],
}, reserved);
const def = (ext: ReturnType<typeof risk>["ext"]) => resolveObjectDef(STANDARD_OBJECTS.account, ext);

test("a new field gets a stable custom.<slug> id; a rename and an option edit change only labels, order and colours", () => {
  const { ext, field } = risk();
  assert.deepEqual([field.fieldId, field.apiName, ext.registryVersion], ["custom.renewal_risk", "custom.renewal_risk", 1]);
  const renamed = updateField("account", ext, field.fieldId, {
    label: "Churn risk",
    options: [{ value: "low", label: "Low", color: "teal" }, { label: "Medium" }, { value: "high", label: "Severe", active: false }],
  });
  const f = def(renamed).byFieldId.get("custom.renewal_risk" as never)!;
  assert.deepEqual([f.apiName, f.label], ["custom.renewal_risk", "Churn risk"]);
  assert.deepEqual("options" in f && f.options, [
    { value: "low", label: "Low", active: true, color: "teal" },
    { value: "medium", label: "Medium", active: true },
    { value: "high", label: "Severe", active: false },
  ]);
  // An option records hold is archived, never dropped; an archived option takes no new values.
  assert.throws(() => updateField("account", renamed, field.fieldId, { options: [{ value: "low", label: "Low" }] }));
  assert.equal(coerce(def(renamed), { "custom.renewal_risk": "high" }, { mode: "update" }).ok, false);
  // A slug an AI field holds, or an archived field held, is not reused.
  assert.equal(risk(new Set(["renewal_risk"])).field.apiName, "custom.renewal_risk_2");
  const again = addField("account", archiveField("account", ext, field.fieldId, 5), { label: "Renewal risk", type: "text" });
  assert.equal(again.field.apiName, "custom.renewal_risk_2");
});

test("the builder makes date-and-time fields, and long text only on text fields", () => {
  const { ext, field } = addField("lead", undefined, { label: "Demo at", type: "datetime" });
  assert.equal(field.type, "datetime");
  const notes = addField("lead", ext, { label: "Brief", type: "text", multiline: true });
  assert.equal(notes.field.multiline, true);
  assert.equal(updateField("lead", notes.ext, notes.field.fieldId, { multiline: false }).customFields.find((f) => f.fieldId === notes.field.fieldId)!.multiline, undefined);
  assert.throws(() => updateField("lead", notes.ext, field.fieldId, { multiline: true }), /only text can be long text/);
});

test("an archived field takes no writes and leaves list columns, then comes back whole on restore", () => {
  const { ext, field } = risk();
  const archived = archiveField("account", ext, field.fieldId, 1000);
  assert.equal(def(archived).byFieldId.get(field.fieldId)!.archivedAt, 1000, "kept in the definition, so the projection keeps its column");
  assert.equal(coerce(def(archived), { "custom.renewal_risk": "high" }, { mode: "update" }).ok, false);
  assert.equal(listColumns(def(archived)).has("custom.renewal_risk"), false);
  assert.equal(registerListDef("account", def(archived)).byApiName.has("custom.renewal_risk"), false);
  const restored = restoreField("account", archived, field.fieldId);
  assert.equal(registerListDef("account", def(restored)).byApiName.has("custom.renewal_risk"), true);
  assert.deepEqual(coerce(def(restored), { "custom.renewal_risk": "high" }, { mode: "update" }), { ok: true, values: [{ fieldId: "custom.renewal_risk", value: "high" }] });
});

test("emails, phones and links keep their order (the first is primary), drop repeats and refuse what they are not", () => {
  let ext = addField("contact", undefined, { label: "Other emails", type: "emails" }).ext;
  ext = addField("contact", ext, { label: "Phones", type: "phones" }).ext;
  ext = addField("contact", ext, { label: "Links", type: "links" }).ext;
  const contact = resolveObjectDef(STANDARD_OBJECTS.contact, ext);
  const ok = coerce(contact, {
    "custom.other_emails": "Zed@Example.com; ann@example.com; zed@example.com",
    "custom.phones": ["+1 (555) 010-0100", "020 7946 0018 ext 4"],
    "custom.links": ["https://acme.com/team", "github.com/acme"],
  }, { mode: "update" });
  assert.deepEqual(ok, { ok: true, values: [
    { fieldId: "custom.other_emails", value: ["zed@example.com", "ann@example.com"] },
    { fieldId: "custom.phones", value: ["+1 (555) 010-0100", "020 7946 0018 ext 4"] },
    { fieldId: "custom.links", value: ["https://acme.com/team", "github.com/acme"] },
  ] });
  for (const bad of [{ "custom.other_emails": ["not an email"] }, { "custom.phones": "call me" }, { "custom.links": ["no spaces allowed.com x"] }]) {
    assert.equal(coerce(contact, bad, { mode: "update" }).ok, false, JSON.stringify(bad));
  }
});

test("a CSV column maps to a custom field by its label, and a picklist cell by an option's label", () => {
  const { ext } = risk();
  const header = ["Company", "Website", "Renewal risk"];
  const mapping = autoMap("account", def(ext), header);
  assert.deepEqual(mapping, ["name", "domain", "custom.renewal_risk"]);
  const [row] = readRows("account", def(ext), mapping, [header, ["Acme", "acme.com", "HIGH"]]);
  assert.deepEqual(row.kind === "read" && row.values, { name: "Acme", domain: "acme.com", "custom.renewal_risk": "high" });
  // A deal import writes scalars only (csvImports.ts factValues): list-valued fields are not offered for deals.
  let dealExt = addField("deal", undefined, { label: "Regions", type: "multipicklist", options: [{ label: "NA" }] }).ext;
  dealExt = addField("deal", dealExt, { label: "Signed MSA", type: "checkbox" }).ext;
  const dealCols = importColumns("deal", resolveObjectDef(STANDARD_OBJECTS.deal, dealExt)).map((c) => c.apiName);
  assert.deepEqual([dealCols.includes("custom.signed_msa"), dealCols.includes("custom.regions")], [true, false]);
});
