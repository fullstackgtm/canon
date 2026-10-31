import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";
import { isFactualField } from "../convex/lib/research/agentLoop.ts";

test("Pi-enabled admission schedules new factual work in Convex and event projection preserves judgments", async () => {
  const field = { _id: "field", orgId: "org", slug: "product", entityType: "account", kind: "qa", label: "Product", question: "What does Acme sell?", answerType: "text", createdBy: "owner" };
  const db = memoryDb({
    researchAgents: [field, { ...field, _id: "judgment", slug: "goal", judgment: true }],
    chatgptAuth: [{ _id: "plan", userId: "owner", status: "connected" }],
    agents: [{ _id: "agent", orgId: "org", ownerUserId: "owner", fieldSlugs: ["product", "goal"] }],
    agentTurns: [{ _id: "turn", agentId: "agent", subject: { domain: "acme.example" } }],
  });
  const modules = loadConvex(["researchAgents.ts", "agentTurns.ts"], {
    "lib.ts": (real) => ({ ...real, requireUser: async () => ({ _id: "owner", orgId: "org" }) }),
    "agents.ts": (real) => ({ ...real, ensureFieldAgent: async () => "agent", actingAgent: async () => ({ ok: true }) }),
    "permissions.ts": (real) => ({ ...real, principalAccess: async () => [] }),
    "lib/research/piEnablement.ts": (real) => ({ ...real, piResearchEnabled: () => true }),
  }, { process: { env: { TOKEN_ENCRYPTION_KEY: "test-encryption-key" } } });
  const scheduled: string[] = [];
  const started = await modules["researchAgents.ts"].startRun.handler({ db, scheduler: { runAfter: async (_delay: number, ref: unknown) => { scheduled.push(String(ref)); } } }, { slug: "product" });
  assert.equal(started.refused, null);
  assert.deepEqual(scheduled, ["internal.researchAgentActions.runSlice"]);
  assert.equal(db.rows("researchRuns")[0].runtime ?? "convex", "convex");
  const loaded = await modules["agentTurns.ts"].loadTurn.handler({ db }, { turnId: "turn" });
  assert.equal(loaded.fields[0].spec.entityType, "account");
  assert.equal(isFactualField(loaded.fields[0].spec), true);
  assert.equal(loaded.fields[1].spec.judgment, true);
  assert.equal(isFactualField(loaded.fields[1].spec), false);
});
