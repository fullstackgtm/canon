import assert from "node:assert/strict";
import test from "node:test";
import {
  HUBSPOT_DEFAULT_FIELD_MAPPINGS,
  SALESFORCE_DEFAULT_FIELD_MAPPINGS,
  mappedField,
  mappedFields,
  normalizeFieldMappings,
  readMappedValue,
} from "../convex/lib/crmMappings.ts";

test("normalizes field mappings and drops invalid values", () => {
  assert.deepEqual(
    normalizeFieldMappings({
      accounts: {
        name: "company_name",
        empty: "",
        nested: 42,
      },
      bad: null,
    }),
    {
      accounts: {
        name: "company_name",
      },
    },
  );
});

test("resolves canonical and provider alias object mappings", () => {
  const mappings = {
    companies: {
      name: "company_name",
    },
  };

  assert.equal(mappedField(mappings, "accounts", "name", "name"), "company_name");
  assert.equal(mappedField(mappings, "accounts", "domain", "domain"), "domain");
});

test("returns unique provider fields for sync property selection", () => {
  const fields = mappedFields(
    {
      deals: {
        name: "deal_label",
        amount: "amount",
      },
    },
    "deals",
    HUBSPOT_DEFAULT_FIELD_MAPPINGS.deals,
  );

  assert.equal(fields.includes("deal_label"), true);
  assert.equal(fields.includes("amount"), true);
  assert.equal(new Set(fields).size, fields.length);
});

test("includes provider defaults for deal next-step patching", () => {
  assert.equal(HUBSPOT_DEFAULT_FIELD_MAPPINGS.deals.nextStep, "hs_next_step");
  assert.equal(SALESFORCE_DEFAULT_FIELD_MAPPINGS.deals.nextStep, "NextStep");
  assert.equal(
    mappedField({ opportunities: { nextStep: "NextStep__c" } }, "deals", "nextStep", "NextStep"),
    "NextStep__c",
  );
});

test("reads mapped values with direct and dotted provider paths", () => {
  const source = {
    website: "example.com",
    nested: {
      custom: "Enterprise",
    },
  };

  assert.equal(
    readMappedValue(source, { accounts: { domain: "website" } }, "accounts", "domain", "domain"),
    "example.com",
  );
  assert.equal(
    readMappedValue(
      source,
      { accounts: { industry: "nested.custom" } },
      "accounts",
      "industry",
      "industry",
    ),
    "Enterprise",
  );
});
