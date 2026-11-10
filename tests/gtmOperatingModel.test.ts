import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { getGtmOperatingModel } from "../src/lib/gtm-operating-model.ts";
import { GET } from "../src/app/api/gtm/operating-model/route.ts";
import { main as gtmMain } from "../scripts/fsgtm.ts";
import { captureCli } from "./support/cli.ts";

const model = getGtmOperatingModel();

test("every operating-model primitive documents both CRMs, Convex coverage, and patch operations", () => {
  assert.ok(model.primitives.length >= 25, "expected a first-class primitive registry");

  for (const primitive of model.primitives) {
    assert.ok(primitive.id, "primitive has an id");
    assert.ok(primitive.name, `${primitive.id} has a name`);
    assert.ok(primitive.description, `${primitive.id} has a description`);
    assert.ok(primitive.crmRepresentation.salesforce, `${primitive.id} documents Salesforce representation`);
    assert.ok(primitive.crmRepresentation.hubspot, `${primitive.id} documents HubSpot representation`);
    assert.ok(primitive.providerSupport.salesforce, `${primitive.id} documents Salesforce support`);
    assert.ok(primitive.providerSupport.hubspot, `${primitive.id} documents HubSpot support`);
    assert.ok(primitive.convexTables.length > 0, `${primitive.id} maps to Convex coverage`);
    assert.ok(primitive.agentUseCases.length > 0, `${primitive.id} has agent use cases`);
    assert.ok(primitive.patchPlanOperations.length > 0, `${primitive.id} has patch-plan operations`);
  }
});

test("operating model exposes CLI, API, and MCP registry access paths", () => {
  assert.match(model.surfaces.cli, /operating-model/);
  assert.match(model.surfaces.cli, /--json/);
  assert.match(model.surfaces.api, /\/api\/gtm\/operating-model/);
  assert.match(model.surfaces.mcp, /gtm_operating_model/);

  const mcpSource = readFileSync("scripts/fsgtm-mcp.ts", "utf8");
  assert.match(mcpSource, /registerTool\(\s*["']gtm_operating_model["']/);
});

test("operating model safety requires approval and audit metadata before writes", () => {
  for (const requiredField of [
    "id",
    "objectType",
    "objectId",
    "operation",
    "field",
    "beforeValue",
    "afterValue",
    "reason",
    "riskLevel",
    "approvalRequired",
    "sourceRuleOrPolicy",
    "rollback",
  ]) {
    assert.ok(
      model.mutationPolicy.requiredPatchOperationFields.includes(requiredField),
      `missing required patch field ${requiredField}`,
    );
  }

  assert.ok(model.primitives.find((primitive) => primitive.id === "patch_plan"));
  assert.ok(model.primitives.find((primitive) => primitive.id === "approval"));
});

test("operating model API route returns the public registry envelope without Convex env", async () => {
  const prior = process.env.NEXT_PUBLIC_CONVEX_URL;
  delete process.env.NEXT_PUBLIC_CONVEX_URL;
  try {
    const response = await GET(new Request("http://localhost/api/gtm/operating-model"));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, { operatingModel: model });
  } finally {
    if (prior === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
    else process.env.NEXT_PUBLIC_CONVEX_URL = prior;
  }
});

test("hosted app CLI prints operating model JSON without requiring Convex env", async () => {
  const result = await captureCli(() => gtmMain(["operating-model", "--json"]), { NEXT_PUBLIC_CONVEX_URL: undefined });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.product, "CanonCRM");
  assert.equal(payload.version, model.version);
  assert.equal(payload.primitives.length, model.primitives.length);
  assert.ok(payload.primitives.some((primitive: { id: string }) => primitive.id === "territory"));
  assert.match(payload.surfaces.api, /\/api\/gtm\/operating-model/);
});
