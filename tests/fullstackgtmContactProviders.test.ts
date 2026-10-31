import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTACT_PROVIDER_CAPABILITIES,
  runContactWaterfall,
  validateContactWaterfall,
  type ContactProviderAdapter,
} from "../engine/src/contactProviders.ts";
import { parseEnrichConfig } from "../engine/src/enrich.ts";
test("contact capability registry advertises only implemented provider operations", () => {
  assert.deepEqual(Object.keys(CONTACT_PROVIDER_CAPABILITIES), ["pipe0", "quickenrich"]);
  assert.deepEqual(CONTACT_PROVIDER_CAPABILITIES.pipe0[0].outputFields, ["work_email", "mobile"]);
  assert.throws(
    () => validateContactWaterfall([{ provider: "hunter", fields: ["work_email"] }]),
    /unsupported provider "hunter".*implemented: pipe0/,
  );
  assert.throws(
    () => validateContactWaterfall([{ provider: "pipe0", fields: ["direct_dial"] }]),
    /pipe0 does not implement "direct_dial".*available: work_email, mobile/,
  );
});

test("contact waterfall is fill-only and later steps receive only unresolved prospects", async () => {
  const batchNames: string[][] = [];
  let call = 0;
  const adapter: ContactProviderAdapter = {
    provider: "pipe0",
    resolve: async (prospects) => {
      batchNames.push(prospects.map((prospect) => prospect.fullName ?? ""));
      call++;
      return prospects.map((prospect, index) => (
        call === 1 && index > 0 ? prospect : { ...prospect, email: `found-${call}@example.com` }
      ));
    },
  };
  const result = await runContactWaterfall({
    prospects: [
      { fullName: "Already Found", email: "keep@example.com" },
      { fullName: "First Provider" },
      { fullName: "Second Provider" },
    ],
    steps: [
      { provider: "pipe0", fields: ["work_email"] },
      { provider: "pipe0", fields: ["work_email"] },
    ],
    adapters: { pipe0: adapter },
  });

  assert.deepEqual(batchNames, [["First Provider", "Second Provider"], ["Second Provider"]]);
  assert.deepEqual(result.prospects.map((prospect) => prospect.email), [
    "keep@example.com",
    "found-1@example.com",
    "found-2@example.com",
  ]);
  assert.deepEqual(result.attempts.map((attempt) => attempt.attempted), [2, 1]);
  assert.deepEqual(result.attempts.map((attempt) => attempt.added.work_email), [1, 1]);
});

test("contact waterfall refuses cardinality changes that could attach data to the wrong person", async () => {
  await assert.rejects(
    runContactWaterfall({
      prospects: [{ fullName: "One" }, { fullName: "Two" }],
      steps: [{ provider: "pipe0", fields: ["work_email"] }],
      adapters: { pipe0: { provider: "pipe0", resolve: async () => [{ email: "wrong@example.com" }] } },
    }),
    /returned 1 result\(s\) for 2 input\(s\)/,
  );
});

test("enrich config accepts explicit contactWaterfall and rejects unavailable capabilities", () => {
  const base = {
    sources: { explorium: { kind: "api" } },
    match: { contact: { keys: ["email"], onAmbiguous: "skip" } },
    fields: {},
    policy: { overwrite: "never" },
    acquire: {
      discovery: { explorium: { provider: "explorium", contactWaterfall: [{ provider: "pipe0", fields: ["work_email"] }] } },
      create: { contact: { matchKey: "email", properties: { email: "email" } } },
    },
  };
  const parsed = parseEnrichConfig(JSON.stringify(base));
  assert.deepEqual(parsed.acquire?.discovery?.explorium.contactWaterfall, [{ provider: "pipe0", fields: ["work_email"] }]);

  const invalid = structuredClone(base);
  invalid.acquire.discovery.explorium.contactWaterfall = [{ provider: "pipe0", fields: ["direct_dial"] }];
  assert.throws(() => parseEnrichConfig(JSON.stringify(invalid)), /does not implement.*direct_dial/);
});
