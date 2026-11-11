import assert from "node:assert/strict";
import test from "node:test";
import { providerProblems, type ProviderDecl } from "../modules/kernel/providers.ts";
import { PROVIDERS, ProviderUnavailable, resolveCapability, runChain, type Resolution } from "../convex/lib/providers/registry.ts";

const env = { TREG_TOKEN: "t" };
const chainOf = (r: Resolution) => r.chain.map((c) => `${c.provider}:${c.source}`);

test("email.find resolves to the workspace's own key first, then the deployment's, else a reason naming both", () => {
  assert.deepEqual(chainOf(resolveCapability("email.find", { workspace: new Set(["deepline"]), env })), ["deepline:workspace", "treg:deployment"]);
  assert.deepEqual(chainOf(resolveCapability("email.find", { workspace: new Set(), env })), ["treg:deployment"]);
  assert.deepEqual(chainOf(resolveCapability("email.find", { workspace: new Set(["deepline"]), env: { TREG_TOKEN: " " } })), ["deepline:workspace"]);
  assert.deepEqual(chainOf(resolveCapability("email.find", { workspace: new Set(["deepline"]), env }, { sources: ["deployment"] })), ["treg:deployment"]);
  const none = resolveCapability("email.find", { workspace: new Set(), env: {} });
  assert.deepEqual(none.chain, []);
  assert.ok(none.reason?.includes("Deepline") && none.reason.includes("TREG_TOKEN"), none.reason ?? "");
});

test("Find email order: a Deepline hit skips treg; a miss or a failure runs it; the last provider's error is the caller's", async () => {
  const both = resolveCapability("email.find", { workspace: new Set(["deepline"]), env });
  const run = async (resolution: Resolution, deepline: (last: boolean) => Promise<string | null>) => {
    let treg = 0;
    const out = await runChain(resolution, async ({ provider }, last) => (provider === "deepline" ? deepline(last) : (treg += 1, "treg")));
    return { out, treg };
  };
  assert.deepEqual(await run(both, async () => "ada@acme.example"), { out: "ada@acme.example", treg: 0 });
  assert.deepEqual(await run(both, async () => null), { out: "treg", treg: 1 });
  assert.deepEqual(await run(both, async () => { throw new Error("Deepline down"); }), { out: "treg", treg: 1 });
  assert.deepEqual(await run(resolveCapability("email.find", { workspace: new Set(), env }), async () => "unused"), { out: "treg", treg: 1 });
  const alone = resolveCapability("email.find", { workspace: new Set(["deepline"]), env: {} });
  assert.deepEqual(await run(alone, async (last) => (last ? "miss" : null)), { out: "miss", treg: 0 });
  await assert.rejects(run(alone, async () => { throw new Error("Deepline down"); }), /Deepline down/);
  await assert.rejects(run(resolveCapability("email.find", { workspace: new Set(), env: {} }), async () => "unused"), ProviderUnavailable);
});

test("every registered provider is a valid declaration, and a bad one is refused with each problem's path", () => {
  for (const decl of Object.values(PROVIDERS)) assert.deepEqual(providerProblems(decl), [], decl.id);
  const bad: ProviderDecl = { id: "Bad", label: " ", capabilities: ["email.find", "nope" as never], keys: [{ name: "lower", source: "workspace" }], cost: { credits: 0, per: "call" }, limits: [{ max: 1.5, per: "day" }] };
  assert.deepEqual(providerProblems(bad).map((p) => p.split(" ")[0]), ["id", "label", "capabilities[1]", "keys[0].name", "cost.credits", "limits[0].max"]);
});
