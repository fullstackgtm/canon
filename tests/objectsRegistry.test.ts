import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_ATTRIBUTES, CONTACT_ATTRIBUTES, DEAL_ATTRIBUTES, isKnownAttribute, type DealAttribute } from "../convex/lib/canon/attributes.ts";
import {
  coerce,
  resolveObjectDef,
  STANDARD_ASSOCIATIONS,
  STANDARD_OBJECTS,
  type FieldId,
  type OrgObjectExtension,
} from "../convex/lib/objects/registry.ts";

const tierOptions = [
  { value: "gold", label: "Gold", active: true },
  { value: "silver", label: "Silver", active: true },
  { value: "legacy", label: "Legacy", active: false },
];
const accountExtension: OrgObjectExtension = {
  registryVersion: 3,
  customFields: [
    { fieldId: "f_tier" as FieldId, apiName: "custom.tier", label: "Tier", type: "picklist", options: tierOptions },
    { fieldId: "f_regions" as FieldId, apiName: "custom.regions", label: "Regions", type: "multipicklist", options: [
      { value: "NA", label: "North America", active: true },
      { value: "EMEA", label: "EMEA", active: true },
      { value: "APAC", label: "APAC", active: true },
    ] },
    { fieldId: "f_renewal" as FieldId, apiName: "custom.renewal_date", label: "Renewal date", type: "date" },
    { fieldId: "f_partner" as FieldId, apiName: "custom.is_partner", label: "Partner", type: "checkbox" },
    { fieldId: "f_score" as FieldId, apiName: "custom.score", label: "Score", type: "formula", formula: "employees / 10", returns: "number" },
  ],
};
const account = resolveObjectDef(STANDARD_OBJECTS.account, accountExtension);
const deal = resolveObjectDef(STANDARD_OBJECTS.deal);
const meeting = resolveObjectDef(STANDARD_OBJECTS.meeting);

test("the ledger's attribute lists follow the registry's factLedger fields", () => {
  assert.deepEqual(DEAL_ATTRIBUTES, [
    "name", "amount", "currency", "closeDate", "stage", "forecastCategory",
    "probability", "isClosed", "isWon", "crmOwnerId", "dealType", "nextStep", "splitAllocations",
  ]);
  assert.deepEqual(ACCOUNT_ATTRIBUTES, ["name", "domain", "industry", "employees", "annualRevenue", "country", "linkedinUrl", "ownerId"]);
  assert.deepEqual(CONTACT_ATTRIBUTES, ["fullName", "title", "email", "phone", "linkedinUrl", "ownerId"]);
  assert.equal(isKnownAttribute("account", "phone"), false, "a registry field outside the facts ledger stays unknown to it");
  assert.equal(isKnownAttribute("account", "custom.tier"), true);
  assert.equal(isKnownAttribute("opportunity", "custom.tier"), false);
  const literal: DealAttribute = "crmOwnerId";
  // @ts-expect-error DealAttribute stays a literal union, not string
  const bogus: DealAttribute = "description";
  assert.equal(literal, "crmOwnerId");
  assert.equal(bogus, "description");
});

test("every standard object resolves, and associations and lookups point at real objects", () => {
  const names = new Set(Object.keys(STANDARD_OBJECTS));
  for (const [name, spec] of Object.entries(STANDARD_OBJECTS)) {
    const def = resolveObjectDef(spec);
    assert.equal(def.apiName, name);
    assert.ok(def.byFieldId.has(def.titleFieldId), `${name} title field exists`);
    assert.equal(new Set(def.fields.map((f) => f.fieldId)).size, def.fields.length, `${name} fieldIds are unique`);
    for (const f of def.fields) if (f.type === "lookup") assert.ok(names.has(f.lookupTo), `${name}.${f.apiName} -> ${f.lookupTo}`);
  }
  for (const a of STANDARD_ASSOCIATIONS) assert.ok([a.from, a.to].flat().every((o) => names.has(o)), a.apiName);
});

test("resolveObjectDef appends custom fields, keyed by their own fieldId, and overrides standard picklists", () => {
  assert.equal(account.registryVersion, 3);
  assert.equal(account.byApiName.get("custom.tier")?.fieldId, "f_tier");
  assert.equal(account.byFieldId.get("f_tier" as FieldId)?.apiName, "custom.tier");
  assert.equal(account.byApiName.get("name")?.fieldId, "name");
  assert.deepEqual(account.fields.slice(-5).map((f) => f.apiName), ["custom.tier", "custom.regions", "custom.renewal_date", "custom.is_partner", "custom.score"]);

  const ownStages = resolveObjectDef(STANDARD_OBJECTS.deal, {
    registryVersion: 1,
    customFields: [],
    picklistOptions: { stage: [{ value: "Discovery", label: "Discovery", active: true }] },
  });
  assert.deepEqual(coerce(ownStages, { stage: "Discovery" }, { mode: "update" }), { ok: true, values: [{ fieldId: "stage", value: "Discovery" }] });
  assert.equal(coerce(ownStages, { stage: "prospecting" }, { mode: "update" }).ok, false);
});

test("resolveObjectDef rejects a malformed or colliding custom field", () => {
  const bad = (customFields: OrgObjectExtension["customFields"]) => () => resolveObjectDef(STANDARD_OBJECTS.account, { registryVersion: 1, customFields });
  assert.throws(bad([{ fieldId: "f1" as FieldId, apiName: "tier", label: "Tier", type: "text" }]), /custom\.<slug>/);
  assert.throws(bad([{ fieldId: "f1" as FieldId, apiName: "custom.Tier", label: "Tier", type: "text" }]), /custom\.<slug>/);
  assert.throws(bad([{ fieldId: "name" as FieldId, apiName: "custom.name", label: "Name", type: "text" }]), /already has a field/);
  assert.throws(bad([
    { fieldId: "f1" as FieldId, apiName: "custom.a", label: "A", type: "text" },
    { fieldId: "f2" as FieldId, apiName: "custom.a", label: "A again", type: "text" },
  ]), /already has a field/);
  assert.throws(() => resolveObjectDef(STANDARD_OBJECTS.deal, { registryVersion: 1, customFields: [], picklistOptions: { name: [] } }), /not a picklist/);
});

test("coerce normalizes CSV-style input to typed values", () => {
  const result = coerce(account, {
    name: "  Acme  ",
    employees: "1200",
    annualRevenue: "2500000.50",
    "custom.tier": "gold",
    "custom.regions": "EMEA;NA;EMEA",
    "custom.renewal_date": "2026-12-01T09:30:00-08:00",
    "custom.is_partner": "FALSE",
  }, { mode: "create" });
  assert.deepEqual(result, {
    ok: true,
    values: [
      { fieldId: "name", value: "Acme" },
      { fieldId: "employees", value: 1200 },
      { fieldId: "annualRevenue", value: 2500000.5 },
      { fieldId: "f_tier", value: "gold" },
      { fieldId: "f_regions", value: ["EMEA", "NA"] },
      { fieldId: "f_renewal", value: "2026-12-01" },
      { fieldId: "f_partner", value: false },
    ],
  });
});

test("coerce normalizes dates, datetimes, lists and empties", () => {
  const ok = (def: typeof account, input: Record<string, unknown>) => {
    const r = coerce(def, input, { mode: "update" });
    assert.ok(r.ok, JSON.stringify(r));
    return r.values.map((v) => v.value);
  };
  assert.deepEqual(ok(meeting, { startAt: "2026-10-06T12:00:00Z", endAt: "2026-10-06T14:00:00+02:00" }), [Date.UTC(2026, 9, 6, 12), Date.UTC(2026, 9, 6, 12)]);
  assert.deepEqual(ok(meeting, { startAt: 1_790_000_000_000 }), [1_790_000_000_000]);
  assert.deepEqual(ok(meeting, { endAt: "2026-10-06" }), [Date.UTC(2026, 9, 6)]);
  assert.deepEqual(ok(deal, { closeDate: Date.UTC(2026, 11, 31, 23, 59) }), ["2026-12-31"]);
  assert.deepEqual(ok(account, { "custom.regions": ["NA", "APAC", "NA"] }), [["APAC", "NA"]]);
  assert.deepEqual(ok(account, { "custom.regions": [], industry: "", domain: null, "custom.is_partner": true }), [null, null, null, true]);
});

test("coerce rejects each class of bad input and stores nothing", () => {
  const errors = (def: typeof account, input: Record<string, unknown>, mode: "create" | "update" = "update") => {
    const r = coerce(def, input, { mode });
    assert.equal(r.ok, false, JSON.stringify(input));
    return r.ok ? [] : r.errors.map((e) => `${e.field}: ${e.message}`);
  };
  assert.deepEqual(errors(account, { revenue: 5 }), ["revenue: account has no field revenue"]);
  assert.deepEqual(errors(account, { createdAt: 5 }), ["createdAt: Created is set by the system and cannot be written"]);
  assert.deepEqual(errors(account, { "custom.score": 5 }), ["custom.score: Score is a formula field: its value is computed, so it cannot be written"]);
  assert.deepEqual(errors(account, { employees: "12 people" }), ["employees: Employees must be a number"]);
  assert.deepEqual(errors(account, { employees: "1,200" }), ["employees: Employees must be a number"]);
  assert.deepEqual(errors(account, { name: 42 }), ["name: Account name must be text"]);
  assert.deepEqual(errors(account, { "custom.is_partner": "yes" }), ["custom.is_partner: Partner must be true or false"]);
  assert.deepEqual(errors(account, { "custom.tier": "platinum" }), ["custom.tier: Tier: \"platinum\" is not an option"]);
  assert.deepEqual(errors(account, { "custom.tier": "legacy" }), ["custom.tier: Tier: \"legacy\" is no longer an active option"]);
  assert.deepEqual(errors(account, { "custom.regions": ["NA", "MARS"] }), ["custom.regions: Regions: \"MARS\" is not an option"]);
  assert.deepEqual(errors(account, { "custom.renewal_date": "2026-02-30" }), ["custom.renewal_date: Renewal date must be a date (YYYY-MM-DD)"]);
  assert.deepEqual(errors(account, { "custom.renewal_date": "12/01/2026" }), ["custom.renewal_date: Renewal date must be a date (YYYY-MM-DD)"]);
  assert.deepEqual(errors(meeting, { startAt: "2026-10-06T12:00:00" }), ["startAt: Start time must be a date and time with a timezone, or epoch milliseconds"]);
  assert.deepEqual(errors(deal, { closeDate: "2026-10-06T99:99:99+99:99" }), ["closeDate: Close date must be a date (YYYY-MM-DD)"], "an impossible time or offset");
  assert.deepEqual(errors(meeting, { startAt: "2026-10-06T24:00:00Z" }), ["startAt: Start time must be a date and time with a timezone, or epoch milliseconds"]);
  assert.deepEqual(errors(deal, { closeDate: 1e20 }), ["closeDate: Close date must be a date (YYYY-MM-DD)"], "a number past JavaScript's date range");
  assert.deepEqual(errors(deal, { closeDate: Date.UTC(10_000, 0, 1) }), ["closeDate: Close date must be a date (YYYY-MM-DD)"], "a five-digit year");
  assert.deepEqual(errors(meeting, { startAt: 8.64e15 + 1 }), ["startAt: Start time must be a date and time with a timezone, or epoch milliseconds"]);
  assert.deepEqual(errors(account, { name: "" }), ["name: Account name is required"], "a required field cannot be cleared on update");
  assert.deepEqual(errors(deal, { name: "Acme renewal", amount: 5000 }, "create"), [
    "currency: Currency is required",
    "closeDate: Close date is required",
    "isClosed: Closed is required",
    "isWon: Won is required",
    "dealType: Deal type is required",
  ]);
  assert.deepEqual(coerce(deal, { amount: 5000 }, { mode: "update" }), { ok: true, values: [{ fieldId: "amount", value: 5000 }] }, "update checks only the given fields");
});
