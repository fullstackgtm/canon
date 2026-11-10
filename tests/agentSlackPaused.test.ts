import assert from "node:assert/strict";
import test from "node:test";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? null));
const ORG = "organizations:one";
const AGENT = "agents:watch";
const OWNER = "users:owner";
let session: Record<string, unknown> | null = null;
const loaded = loadConvex(["agentTurns.ts", "agentSlack.ts", "agents.ts"], {
  "lib.ts": (real) => ({ ...real, getCurrentUser: async () => session, requireUser: async () => session }),
});

function world(mode: "all" | "failures", pause?: Record<string, unknown>) {
  const db = memoryDb({
    organizations: [{ _id: ORG }],
    users: [{ _id: OWNER, orgId: ORG, role: "manager", name: "Owner", clerkUserId: "owner", isActive: true }],
    agents: [{
      _id: AGENT, orgId: ORG, slug: "watch", ledgerKey: "agent:watch", label: "Watch", kind: "hosted", ownerUserId: OWNER,
      fieldSlugs: ["fit"], budget: { turnsPerDay: 20, maxRounds: 3, maxTokens: 4000, maxSeconds: 120 }, slack: { mode },
      ...(pause ? { pause } : {}), createdBy: OWNER, createdAt: 1, updatedAt: 1,
    }],
    integrations: [{ _id: "integrations:slack", orgId: ORG, provider: "slack", accessToken: "cipher", isActive: true }],
  });
  const sends: unknown[] = [];
  const ctx = () => ({
    db, auth: { getUserIdentity: async () => null }, storage: {},
    scheduler: { runAfter: async (_delay: number, ref: unknown, args: unknown) => { if (String(ref).endsWith("agentSlack.send")) sends.push(plain(args)); return null; } },
  }) as never;
  const call = (file: string, name: string, args: Record<string, unknown>) => loaded[file][name].handler(ctx(), args);
  let n = 0;
  const event = () => call("agentTurns.ts", "receive", { agentId: AGENT, eventKey: `e${++n}`, payload: "{}", subject: { domain: "acme.test" } });
  return { db, sends, call, event };
}

test("a paused agent records its skipped turns and posts none of them to Slack, and posts again once resumed", async () => {
  const byPerson = { reason: "paused_by_user", at: 1, by: OWNER };
  for (const mode of ["all", "failures"] as const) {
    for (const pause of [byPerson, { reason: "imported", at: 1 }]) {
      const w = world(mode, pause);
      const { turnId } = await w.event();
      assert.deepEqual(plain((await w.db.get(turnId))?.skip), { reason: "paused", message: pause.reason === "imported" ? "Paused: imported from another workspace. Resume it to run it on what happens from then on" : "Paused by its owner or an admin" });

      session = await w.db.get(OWNER);
      await w.call("agentTurns.ts", "testRun", { agentId: AGENT, payload: JSON.stringify({ domain: "acme.test" }) });
      // A turn queued before the pause and a turn that was running: each ends without a message.
      await w.db.insert("agentTurns", { _id: "agentTurns:queued", orgId: ORG, agentId: AGENT, trigger: "webhook", eventKey: "q", status: "queued", subject: {}, outputs: [], createdAt: 1, updatedAt: 1 });
      await w.call("agentTurns.ts", "startTurn", { turnId: "agentTurns:queued" });
      await w.db.insert("agentTurns", { _id: "agentTurns:running", orgId: ORG, agentId: AGENT, trigger: "webhook", eventKey: "r", status: "running", subject: {}, outputs: [], createdAt: 1, updatedAt: 1 });
      await w.call("agentTurns.ts", "finishTurn", { turnId: "agentTurns:running", status: "failed", outputs: [], facts: [], spend: { modelCalls: 0, tokens: 0, pagesRead: 0, ms: 0 }, error: "boom" });
      assert.equal(await w.call("agentSlack.ts", "prepare", { turnId: "agentTurns:running" }), null);
      assert.deepEqual(w.db.rows("agentTurns").map((t) => t.status), ["skipped", "skipped", "skipped", "failed"]);
      assert.deepEqual(w.sends, [], `${mode}, ${pause.reason}`);

      await w.call("agents.ts", "setPaused", { agent: { agentId: AGENT }, paused: false });
      const resumed = await w.event();
      assert.equal(plain(await w.db.get(resumed.turnId))?.skip?.reason, "owner_not_connected");
      assert.deepEqual(w.sends, [{ turnId: resumed.turnId }]);
    }
  }
});

test("an agent the system pauses for its owner latches the pause on the event and posts nothing", async () => {
  const w = world("all");
  await w.db.patch(OWNER, { isActive: false });
  const { turnId } = await w.event();
  assert.equal(plain(await w.db.get(AGENT))?.pause?.reason, "owner_inactive");
  assert.equal((await w.db.get(turnId))?.status, "skipped");
  assert.deepEqual(w.sends, []);
});
