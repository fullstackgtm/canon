import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { POST as mcpPost } from "../src/app/mcp/route.ts";
import { GET as mcpResourceMetadata } from "../src/app/.well-known/oauth-protected-resource/mcp/route.ts";
import { pairDevice } from "../cli/canon.ts";

const toolsList = (authorization?: string) => new Request("http://localhost/mcp", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(authorization ? { Authorization: authorization } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});

test("a self-hosted /mcp is served without the hosted flag, takes only paired CLI tokens, and advertises no OAuth", async () => {
  process.env.CANON_AUTH = "local";
  delete process.env.MCP_REMOTE_ENABLED;
  // mcp-handler starts a cleanup interval on its first request and never unrefs it, which would keep this file running.
  const setIntervalReal = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => setIntervalReal(...args).unref()) as typeof setInterval;
  try {
    assert.equal((await mcpPost(toolsList())).status, 401, "no token");
    assert.equal((await mcpPost(toolsList("Bearer oat_from_some_oauth_server"))).status, 401, "a token that isn't a paired CLI token");
    process.env.MCP_REMOTE_ENABLED = "true";
    assert.equal((await mcpResourceMetadata(new Request("http://localhost/.well-known/oauth-protected-resource/mcp"))).status, 404);
  } finally {
    globalThis.setInterval = setIntervalReal;
    delete process.env.CANON_AUTH;
    delete process.env.MCP_REMOTE_ENABLED;
  }
});

test("canon login against a self-hosted Canon pairs through its device flow and keeps the token without printing it", async () => {
  const home = mkdtempSync(join(tmpdir(), "canon-cli-"));
  process.env.CANON_HOME = home;
  const token = `fsgtm_${"a".repeat(64)}`;
  const polls = ["pending", "approved"];
  const requests: string[] = [];
  const lines: string[] = [];
  const opened: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push(`${new URL(url).pathname} ${init?.body ?? ""}`);
    if (url.endsWith("/api/cli/auth/start")) {
      return Response.json({ deviceCode: "d".repeat(64), userCode: "ABCD-EFGH", verificationUrl: "https://crm.example.com/dashboard/cli-auth?code=ABCD-EFGH", expiresInSeconds: 900, intervalSeconds: 3 });
    }
    const status = polls.shift();
    return Response.json(status === "approved" ? { status, cliToken: token } : { status });
  }) as typeof fetch;
  try {
    await pairDevice("https://crm.example.com", { fetchImpl, open: (url) => opened.push(url), wait: async () => {}, log: (line) => lines.push(line) });
    assert.deepEqual(JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")), { "https://crm.example.com": { cliToken: token } });
    assert.deepEqual(opened, ["https://crm.example.com/dashboard/cli-auth?code=ABCD-EFGH"]);
    assert.equal(requests.filter((r) => r.startsWith("/api/cli/auth/poll")).length, 2, "it polls until the pairing is approved");
    assert.ok(lines.join("\n").includes("ABCD-EFGH") && !lines.join("\n").includes(token), "it shows the code to approve, never the token");
  } finally {
    delete process.env.CANON_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
