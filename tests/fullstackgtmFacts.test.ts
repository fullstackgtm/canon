import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { storeCredential } from "../engine/src/credentials.ts";
import { readFactBatch, submitFactBatch, validateFactBatch } from "../engine/src/hostedFacts.ts";

async function withHome(fn: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-facts-"));
  const previous = process.env.FSGTM_HOME;
  process.env.FSGTM_HOME = dir;
  try { await fn(); } finally {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const batch = {
  agentId: "renewal-bot", sourceKind: "call" as const, title: "Next steps from Tuesday's calls",
  facts: [{ crmProvider: "salesforce" as const, crmId: "006X", attribute: "nextStep", value: "Send MSA", evidence: "call 42 @ 12:03: 'send the MSA Friday'" }],
};

test("batch validation rejects user/CRM sources and facts without a deal", () => {
  assert.equal(validateFactBatch(batch).ok, true);
  assert.equal(validateFactBatch({ ...batch, sourceKind: "salesforce" }).ok, false, "an agent cannot submit as a CRM");
  assert.equal(validateFactBatch({ ...batch, sourceKind: "user" }).ok, false, "or as a person");
  assert.equal(validateFactBatch({ ...batch, facts: [{ attribute: "nextStep", value: "x" }] }).ok, false);
  assert.equal(validateFactBatch({ ...batch, facts: [{ dealId: "d1", attribute: "nextStep", value: { nested: 1 } }] }).ok, false);
  assert.equal(validateFactBatch({ ...batch, facts: [] }).ok, false);
});

test("batch validation: account and contact facts need a record to point at", () => {
  const fact = (f: Record<string, unknown>) => validateFactBatch({ ...batch, facts: [{ attribute: "custom.ehr_vendor", value: "Epic", ...f }] }).ok;
  assert.ok(fact({ entityType: "account", domain: "acme.com" }));
  assert.ok(fact({ entityType: "account", recordId: "acc_acme_com" }));
  assert.ok(fact({ entityType: "account", crmProvider: "hubspot", crmId: "901" }));
  assert.ok(fact({ entityType: "contact", email: "ana@acme.com" }));
  assert.equal(fact({ entityType: "account", email: "ana@acme.com" }), false, "an email does not identify an account");
  assert.equal(fact({ entityType: "contact", domain: "acme.com" }), false, "a domain does not identify a person");
  assert.equal(fact({ entityType: "account", dealId: "d1" }), false);
  assert.equal(fact({ entityType: "lead", domain: "acme.com" }), false);
});

test("submit is unpaired without a broker credential", () => withHome(async () => {
  assert.deepEqual(await submitFactBatch(batch, { fetchImpl: () => { throw new Error("no network"); } }), { status: "unpaired" });
}));

test("submit and status call the hosted gate with the paired token", () => withHome(async () => {
  storeCredential("broker", { kind: "broker", baseUrl: "https://dev.canoncrm.com", accessToken: "fsgtm_test" } as never);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (init.method === "POST") return Response.json({ patchPlanId: "p1", proposed: 1, unchanged: 0, verifying: 0, rejected: [] });
    return Response.json({ patchPlanId: "p1", status: "pending_approval", counts: { proposed: 1, accepted: 0, rejected: 0, superseded: 0 } });
  }) as typeof fetch;
  const out = await submitFactBatch(batch, { fetchImpl });
  assert.equal(out.status, "ok");
  assert.equal(calls[0].url, "https://dev.canoncrm.com/api/cli/canon/proposals");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer fsgtm_test");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), batch);
  const status = await readFactBatch("p1", { fetchImpl });
  assert.equal(status.status, "ok");
  assert.equal(calls[1].url, "https://dev.canoncrm.com/api/cli/canon/proposals?patchPlanId=p1");
  const denied = await submitFactBatch(batch, { fetchImpl: (async () => new Response("{}", { status: 401 })) as typeof fetch });
  assert.deepEqual(denied, { status: "error", reason: "hosted authentication was rejected; pair the CLI again" });
}));
