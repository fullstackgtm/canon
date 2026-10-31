import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveObjectDef, STANDARD_OBJECTS, withCustomField, type FieldValue, type OrgObjectExtension } from "../convex/lib/objects/registry.ts";
import { domainOfEmail, lifecycleAfterConversion, planConversion, writesFor } from "../convex/lib/objects/leadConversion.ts";

const withRegion = (object: "lead" | "contact", type: "text" | "number" = "text"): OrgObjectExtension =>
  withCustomField(STANDARD_OBJECTS[object], undefined, "custom.region", type)!;
const defs = (contactRegion: "text" | "number" | null = "text") => ({
  lead: resolveObjectDef(STANDARD_OBJECTS.lead, withRegion("lead")),
  contact: resolveObjectDef(STANDARD_OBJECTS.contact, contactRegion ? withRegion("contact", contactRegion) : undefined),
  account: resolveObjectDef(STANDARD_OBJECTS.account),
});
const lead: Record<string, FieldValue> = {
  firstName: "Ada", lastName: "Lovelace", company: "Atlas Cloud", email: "Ada@AtlasCloud.example", title: "CTO", phone: null,
  status: "qualified", leadSource: "webinar", "custom.region": "EMEA",
};

test("the field map carries standard fields by table and custom fields by apiName, and lists what it cannot carry", () => {
  const plan = planConversion(defs(), lead);
  assert.deepEqual(plan.person, { fullName: "Ada Lovelace", email: "ada@atlascloud.example" });
  assert.deepEqual(plan.company, { name: "Atlas Cloud", domain: "atlascloud.example" });
  assert.deepEqual(plan.fields.map((f) => `${f.target}.${f.apiName}=${f.value}`), ["contact.title=CTO", "contact.leadStatus=qualified", "contact.custom.region=EMEA"]);
  assert.deepEqual(plan.skipped.map((s) => s.from), ["Lead source"]);

  // A field with no home on the person or company, or one of another type, is listed with its reason, not dropped.
  assert.equal(planConversion(defs(null), lead).skipped.some((s) => s.from === "region"), true);
  assert.equal(planConversion(defs("number"), lead).skipped.some((s) => s.from === "region"), true);
  // A personal mailbox names no company; a typed domain wins.
  assert.equal(domainOfEmail("a@gmail.com"), null);
  assert.equal(planConversion(defs(), { ...lead, email: "ada@gmail.com" }, "Acme.com").company.domain, "acme.com");
});

test("an existing company and person are kept as they are; a new person is primary and gets the mapped fields", () => {
  const plan = planConversion(defs(), lead);
  const fresh = writesFor(plan, { company: null, person: null }, true);
  assert.deepEqual(fresh, {
    createsCompany: true, createsPerson: true, title: "CTO", accountPatch: null, primary: true, stage: "opportunity",
    personPatch: { leadStatus: "qualified", "custom.region": "EMEA", lifecycleStage: "opportunity" },
  });
  const matched = writesFor(plan, { company: { id: "acc_atlas" }, person: { id: "con_ada", stage: "mql" } }, false);
  assert.deepEqual(matched, {
    createsCompany: false, createsPerson: false, title: undefined, accountPatch: null, primary: false, stage: "sql",
    personPatch: { lifecycleStage: "sql" },
  });
});

test("a conversion moves a lifecycle stage forward only", () => {
  assert.equal(lifecycleAfterConversion(null, false), "sql");
  assert.equal(lifecycleAfterConversion("lead", true), "opportunity");
  assert.equal(lifecycleAfterConversion("customer", true), null);
  assert.equal(lifecycleAfterConversion("evangelist", false), null);
});
