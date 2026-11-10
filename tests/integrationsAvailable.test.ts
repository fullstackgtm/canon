import assert from "node:assert/strict";
import { test } from "node:test";
import { INTEGRATIONS_AVAILABLE, integrationsAvailable, moduleRuntimeAvailable, type IntegrationFeature } from "../convex/lib/integrationsAvailable.ts";

test("vendor features stay off until every required key is present and expose only booleans", () => {
  assert.deepEqual(integrationsAvailable({}), {
    billing: false, chatgpt: false, openrouter: false, treg: false, unipile: false,
    dialer: false, salesforce: false, email: false, emailLog: false, scrapingbee: false, jev: false,
    metronome: false, pi: false, recipeRuntime: false, recordService: false,
  });
  for (const feature of Object.keys(INTEGRATIONS_AVAILABLE) as IntegrationFeature[]) {
    const definition = INTEGRATIONS_AVAILABLE[feature];
    const env: Record<string, string> = Object.fromEntries(definition.keys.map((key) => [key, "secret-never-returned"]));
    if (feature === "pi") env.CANON_PI_RESEARCH_ENABLED = "true";
    assert.equal(integrationsAvailable(env)[feature], true, feature);
    for (const key of definition.keys) {
      assert.equal(integrationsAvailable({ ...env, [key]: "  " })[feature], false, `${feature} without ${key}`);
    }
    assert.ok(Object.values(integrationsAvailable(env)).every((value) => typeof value === "boolean"));
  }
  assert.equal(moduleRuntimeAvailable({}, {}), true);
  assert.equal(moduleRuntimeAvailable({ server: "server.ts" }, {}), false);
  assert.equal(moduleRuntimeAvailable({ server: "server.ts" }, { RECIPE_RUNTIME_URL: "url", RECIPE_RUNTIME_SECRET: "secret" }), true);
  assert.equal(integrationsAvailable({ CANON_PI_URL: "url", CANON_PI_SECRET: "secret" }).pi, false);
});
