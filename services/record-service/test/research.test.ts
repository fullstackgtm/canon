import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { ResearchImports } from "../src/research.ts";
import { client, fixtureAccounts, startApp } from "./helpers.ts";

test("prepared research is isolated, bound to one org, fill-only, restartable, and idempotent", async () => {
  const first = await startApp();
  let app = first.app;
  let api = first.client;
  const { cfg } = first;
  const sessionId = "session_private";
  const records = fixtureAccounts(1001);
  const body = { sessionId, expiresAt: Date.now() + 60_000, source: "pdl", records };
  try {
    assert.equal((await client(first.base, "wrong").call("POST", "/v1/research/prepare", body)).status, 401);
    assert.equal((await api.call("POST", "/v1/research/prepare", body)).status, 200);
    assert.equal((await api.call("POST", "/v1/research/prepare", body)).json.total, 1001);
    assert.equal((await api.call("POST", "/v1/research/prepare", { ...body, records: [] })).status, 409);
    assert.equal((await api.ws(sessionId).post("accounts/list")).status, 404, "session ids cannot address staging through workspace reads");
    await api.ws("orgA").post("provision");
    assert.equal((await api.ws("orgA").post("accounts/list")).json.total, 0);
    await api.ws("orgA").post("accounts/upsert", { records: [{ ...records[0], name: "Curated name" }], source: "manual", idempotencyKey: "manual" });
    const a = await api.ws("orgA").post("research/commit", { sessionId });
    assert.deepEqual(a.json, { importedAccounts: 500, total: 1001, done: false });
    assert.equal((await api.ws("orgB").post("research/commit", { sessionId })).status, 409);
    // Simulate a crash after the account commit but before its progress file write.
    const progressPath = join(cfg.dataDir, "research", `${sessionId}.json`);
    const beforeProgress = JSON.parse(await readFile(progressPath, "utf8"));
    beforeProgress.offset = 0;
    beforeProgress.importedAccounts = 0;
    await writeFile(progressPath, JSON.stringify(beforeProgress));
    await app.shutdown();
    app = createApp(cfg);
    api = client(`http://127.0.0.1:${await app.listen()}`);
    assert.equal((await api.ws("orgB").post("research/commit", { sessionId })).status, 409);
    assert.deepEqual((await api.ws("orgA").post("research/commit", { sessionId })).json, a.json, "replay the durable account result before advancing progress");
    await api.ws("orgA").post("research/commit", { sessionId });
    const done = await api.ws("orgA").post("research/commit", { sessionId });
    assert.deepEqual(done.json, { importedAccounts: 1001, total: 1001, done: true });
    assert.deepEqual((await api.ws("orgA").post("research/commit", { sessionId })).json, done.json);
    const list = await api.ws("orgA").post("accounts/list", { filter: { q: records[0].domain } });
    assert.equal(list.json.rows[0].name, "Curated name");
    assert.equal((await api.ws("orgA").post("accounts/list")).json.total, 1001);
    assert.equal((await api.ws("orgA").post("contacts/list")).json.total, 0);
    assert.deepEqual(JSON.parse(await readFile(join(cfg.dataDir, "research", `${sessionId}.json`), "utf8")).records, []);
  } finally { await app.shutdown(); }
});

test("expired research cannot be claimed or reused and its staged records are removed", async () => {
  const { app, cfg, client: api } = await startApp();
  try {
    const body = { sessionId: "expired", expiresAt: Date.now() + 60_000, records: fixtureAccounts(1), source: "pdl" };
    assert.equal((await api.call("POST", "/v1/research/prepare", { ...body, expiresAt: Date.now() - 1 })).status, 410);
    await api.call("POST", "/v1/research/prepare", body);
    const claimed = { ...body, sessionId: "claimed_expired", records: fixtureAccounts(501) };
    await api.call("POST", "/v1/research/prepare", claimed);
    await api.ws("org").post("research/commit", { sessionId: claimed.sessionId });
    const claimedPath = join(cfg.dataDir, "research", "claimed_expired.json");
    const partial = JSON.parse(await readFile(claimedPath, "utf8"));
    partial.expiresAt = Date.now() - 1;
    await writeFile(claimedPath, JSON.stringify(partial));
    assert.equal((await api.ws("org").post("research/commit", { sessionId: claimed.sessionId })).status, 410);
    const path = join(cfg.dataDir, "research", "expired.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.expiresAt = Date.now() - 1;
    await writeFile(path, JSON.stringify(state));
    assert.equal((await api.ws("org").post("research/commit", { sessionId: "expired" })).status, 410);
    assert.equal((await api.call("POST", "/v1/research/prepare", body)).status, 410);
    const restored = { ...body, sessionId: "expired-claim", expiresAt: Date.now() + 60_000 };
    assert.equal((await api.call("POST", "/v1/research/prepare", restored)).status, 200);
    assert.deepEqual((await api.ws("org").post("research/commit", { sessionId: restored.sessionId })).json, { importedAccounts: 1, total: 1, done: true });
    assert.equal((await api.call("POST", "/v1/research/prepare", restored)).status, 200, "the fixed new preparation body remains retryable");
    await new ResearchImports(cfg.dataDir).expire();
    await assert.rejects(readFile(path), { code: "ENOENT" });
    await assert.rejects(readFile(claimedPath), { code: "ENOENT" });
  } finally { await app.shutdown(); }
});
