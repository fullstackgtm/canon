import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../engine/src/mcp.ts";
import {
  auditSnapshot,
  buildAuditLog,
  createFilePlanStore,
  defaultPolicy,
  sampleSnapshot,
  type StoredPlan,
} from "../engine/src/index.ts";

/**
 * fullstackgtm_apply governance: the MCP apply path must behave like CLI
 * apply — plans that live in the plan store get the store's approval-digest
 * verification (approvals cannot be supplied, widened, or tampered via tool args), and
 * every run is recorded back onto the stored plan so `plans show` and
 * `audit-log export` include MCP applies.
 */

async function withMcpClient<T>(
  env: Record<string, string>,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  // In-process server over a linked in-memory transport (the stdio wiring is
  // covered once in fullstackgtmMcp.test.ts). Tool handlers read FSGTM_HOME and
  // the mock-HubSpot vars from process.env at call time, so scope them here.
  const keys = ["FULLSTACKGTM_PROFILE", "HUBSPOT_ACCESS_TOKEN", "HUBSPOT_API_BASE_URL", ...Object.keys(env)];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  delete process.env.FULLSTACKGTM_PROFILE;
  delete process.env.HUBSPOT_ACCESS_TOKEN;
  delete process.env.HUBSPOT_API_BASE_URL;
  Object.assign(process.env, env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "fullstackgtm-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function textPayload(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content[0]?.type, "text");
  return content[0].text;
}

/** Mock HubSpot: 200 + a generic body every route needs ({id}, empty results). */
function startMockHubspot(): Promise<{ server: Server; baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "created-1", results: [] }));
  });
  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolveStart({ server, baseUrl: `http://127.0.0.1:${address.port}`, requests });
    });
  });
}

/**
 * A fresh FSGTM_HOME with the sample audit plan saved and one create_task
 * operation approved through the store (which signs the approval digests with
 * the home's signing key — the same key the MCP server will verify with).
 */
async function seedApprovedPlan(home: string) {
  const previousHome = process.env.FSGTM_HOME;
  const previousProfile = process.env.FULLSTACKGTM_PROFILE;
  process.env.FSGTM_HOME = home;
  delete process.env.FULLSTACKGTM_PROFILE;
  try {
    const plan = auditSnapshot(sampleSnapshot, defaultPolicy("2026-05-03"));
    const taskOp = plan.operations.find((operation) => operation.operation === "create_task")!;
    const store = createFilePlanStore();
    await store.save(plan);
    await store.approveOperations(plan.id, [taskOp.id], {});
    return { plan, taskOp, planFile: join(home, "plans", `${plan.id}.json`) };
  } finally {
    if (previousHome === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previousHome;
    if (previousProfile !== undefined) process.env.FULLSTACKGTM_PROFILE = previousProfile;
  }
}

function readStored(planFile: string): StoredPlan {
  return JSON.parse(readFileSync(planFile, "utf8")) as StoredPlan;
}

test("mcp apply on a store-backed plan persists the run, flips status, and keeps the run shape", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-mcp-apply-"));
  const { server, baseUrl, requests } = await startMockHubspot();
  try {
    const { plan, taskOp, planFile } = await seedApprovedPlan(home);
    const payload = await withMcpClient(
      { FSGTM_HOME: home, HUBSPOT_ACCESS_TOKEN: "test-token", HUBSPOT_API_BASE_URL: baseUrl },
      async (client) => {
        const result = await client.callTool({
          name: "fullstackgtm_apply",
          arguments: { provider: "hubspot", planId: plan.id },
        });
        assert.ok(!(result as { isError?: boolean }).isError, textPayload(result));
        return JSON.parse(textPayload(result));
      },
    );

    // Backward-compatible response: the run's own fields stay top-level.
    assert.equal(payload.planId, plan.id);
    assert.equal(payload.provider, "hubspot");
    assert.equal(payload.status, "applied");
    assert.ok(Array.isArray(payload.results));
    assert.ok(typeof payload.startedAt === "string" && typeof payload.finishedAt === "string");
    const appliedResult = payload.results.find(
      (result: { operationId: string }) => result.operationId === taskOp.id,
    );
    assert.equal(appliedResult.status, "applied");
    // Additive governance metadata.
    assert.equal(payload.governance.planSource, "store");
    assert.equal(payload.governance.approvalDigestsVerified, true);
    assert.equal(payload.governance.runRecorded, true);
    // The write actually reached the (mock) provider.
    assert.ok(requests.some((line) => line.startsWith("POST /crm/v3/objects/tasks")), requests.join("\n"));

    // Persistence: runs[] gained the run and the plan status flipped to applied.
    const stored = readStored(planFile);
    assert.equal(stored.status, "applied");
    assert.equal(stored.runs.length, 1);
    assert.equal(stored.runs[0].status, "applied");
    assert.equal(stored.runs[0].planId, plan.id);

    // audit-log export now sees the MCP-applied run.
    process.env.FSGTM_HOME = home;
    try {
      const log = buildAuditLog(await createFilePlanStore().list(), new Date().toISOString());
      assert.equal(log.entryCount, 1);
    } finally {
      delete process.env.FSGTM_HOME;
    }
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("mcp apply refuses a stored plan whose approved operation was tampered after approval", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-mcp-tamper-"));
  const { server, baseUrl, requests } = await startMockHubspot();
  try {
    const { taskOp, planFile } = await seedApprovedPlan(home);
    // Post-approval edit: change the approved operation's value on disk while
    // keeping the recorded approval and digests.
    const stored = readStored(planFile);
    const tampered = stored.plan.operations.find((operation) => operation.id === taskOp.id)!;
    tampered.afterValue = "Wire funds to attacker";
    writeFileSync(planFile, `${JSON.stringify(stored, null, 2)}\n`);

    await withMcpClient(
      { FSGTM_HOME: home, HUBSPOT_ACCESS_TOKEN: "test-token", HUBSPOT_API_BASE_URL: baseUrl },
      async (client) => {
        const result = await client.callTool({
          name: "fullstackgtm_apply",
          arguments: { provider: "hubspot", planId: stored.plan.id },
        });
        assert.equal((result as { isError?: boolean }).isError, true);
        assert.match(textPayload(result), /Refusing to apply plan/);
        assert.match(textPayload(result), /differ from what was approved/);
        assert.ok(textPayload(result).includes(taskOp.id));
      },
    );

    // Nothing was written and nothing was recorded.
    assert.deepEqual(requests, []);
    const after = readStored(planFile);
    assert.equal(after.status, "approved");
    assert.equal(after.runs.length, 0);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("mcp apply schema rejects caller-supplied approvals that could widen the stored set", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-mcp-widen-"));
  const { server, baseUrl, requests } = await startMockHubspot();
  try {
    const { plan, taskOp, planFile } = await seedApprovedPlan(home);
    const unapprovedOp = plan.operations.find((operation) => operation.id !== taskOp.id)!;

    await withMcpClient(
      { FSGTM_HOME: home, HUBSPOT_ACCESS_TOKEN: "test-token", HUBSPOT_API_BASE_URL: baseUrl },
      async (client) => {
        const result = await client.callTool({
          name: "fullstackgtm_apply",
          arguments: {
            provider: "hubspot",
            planId: plan.id,
            approvedOperationIds: [taskOp.id, unapprovedOp.id],
          },
        });
        assert.equal((result as { isError?: boolean }).isError, true);
        assert.match(textPayload(result), /approvedOperationIds|Unrecognized|unknown/i);
      },
    );

    assert.deepEqual(requests, []);
    assert.equal(readStored(planFile).runs.length, 0);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("mcp apply rejects external plan files and requires a stored plan id", async () => {
  const home = mkdtempSync(join(tmpdir(), "fsgtm-mcp-external-"));
  const { server, baseUrl } = await startMockHubspot();
  try {
    // Raw plan file only — never saved to the store in this home.
    const plan = auditSnapshot(sampleSnapshot, defaultPolicy("2026-05-03"));
    const planFile = join(home, "external-plan.json");
    writeFileSync(planFile, JSON.stringify(plan, null, 2));

    await withMcpClient(
      { FSGTM_HOME: home, HUBSPOT_ACCESS_TOKEN: "test-token", HUBSPOT_API_BASE_URL: baseUrl },
      async (client) => {
        const result = await client.callTool({
          name: "fullstackgtm_apply",
          arguments: { provider: "hubspot", planPath: planFile },
        });
        assert.equal((result as { isError?: boolean }).isError, true);
        assert.match(textPayload(result), /planId|planPath|Unrecognized|unknown/i);
      },
    );

    // No store entry appeared as a side effect.
    process.env.FSGTM_HOME = home;
    try {
      assert.deepEqual(await createFilePlanStore().list(), []);
    } finally {
      delete process.env.FSGTM_HOME;
    }
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
