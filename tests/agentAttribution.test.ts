import assert from "node:assert/strict";
import test from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import { declaredLabel, proposalSourceRefBase, provenanceOf, type ActingAgent } from "../convex/lib/agents/attribution.ts";

const ORG = "org1" as Id<"organizations">;
const fieldAgent = {
  _id: "agent1", _creationTime: 1, orgId: ORG, slug: "ehr_vendor", label: "EHR vendor", kind: "hosted",
  ownerUserId: "owner1", ledgerKey: "research:ehr_vendor", createdBy: "owner1", createdAt: 1, updatedAt: 1,
} as unknown as ActingAgent;

test("provenanceOf: an agent attribution is the agent, accountable to the run's starter", () => {
  const p = provenanceOf({ kind: "agent", agent: fieldAgent, triggeredBy: "starter1" as Id<"users"> });
  assert.deepEqual(p, {
    orgId: "org1", actor: { kind: "agent", id: "agent1" }, createdBy: "starter1", agentId: "agent1", refKey: "research:ehr_vendor",
  });
});

test("provenanceOf: a user attribution is the user, never an agent, and keeps the label as its namespace", () => {
  const p = provenanceOf({
    kind: "user", orgId: ORG, userId: "u1" as Id<"users">, cliTokenId: "tok1" as Id<"cliTokens">, label: declaredLabel("claude-code"),
  });
  assert.deepEqual(p, { orgId: "org1", actor: { kind: "user", id: "u1" }, createdBy: "u1", cliTokenId: "tok1", refKey: "claude-code" });
  assert.equal("agentId" in p, false);
});

test("a field agent's sourceRef is byte-identical to the pre-agent one (`${sourceKind}:research:<slug>:${objectKey}`)", () => {
  const p = provenanceOf({ kind: "agent", agent: fieldAgent, triggeredBy: "starter1" as Id<"users"> });
  assert.equal(proposalSourceRefBase("agent_run", p, "ent42"), "agent_run:research:ehr_vendor:ent42");
});

test("declaredLabel: accepts a tool name and refuses reserved agent namespaces", () => {
  assert.equal(declaredLabel("claude-code"), "claude-code");
  assert.throws(() => declaredLabel("research:x"), /may not start with "research:"/);
  assert.throws(() => declaredLabel("agent:x"), /may not start with "agent:"/);
  assert.throws(() => declaredLabel(""), /1 to 200 characters/);
  assert.throws(() => declaredLabel("x".repeat(201)), /1 to 200 characters/);
});
