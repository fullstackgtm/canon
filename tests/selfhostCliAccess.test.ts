import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { POST as mcpPost } from "../src/app/mcp/route.ts";
import { GET as mcpResourceMetadata } from "../src/app/.well-known/oauth-protected-resource/mcp/route.ts";
import { createServer } from "node:http";
import { canonTools } from "../src/app/mcp/_canonTools.ts";
import { main, pairDevice, requestBase } from "../cli/canon.ts";

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
    for (const mode of ["local", "convex"]) {
      process.env.CANON_AUTH = mode;
      for (const token of [undefined, "Bearer oat_from_some_oauth_server"]) {
        const response = await mcpPost(toolsList(token));
        assert.equal(response.status, 401);
        assert.doesNotMatch(response.headers.get("www-authenticate") ?? "", /resource_metadata/);
        const body = await response.json();
        assert.match(body.error_description, /canon login/);
        assert.match(body.error_description, /Authorization: Bearer/);
      }
      process.env.MCP_REMOTE_ENABLED = "true";
      assert.equal((await mcpResourceMetadata(new Request("http://localhost/.well-known/oauth-protected-resource/mcp"))).status, 404);
      delete process.env.MCP_REMOTE_ENABLED;
    }
  } finally {
    globalThis.setInterval = setIntervalReal;
    delete process.env.CANON_AUTH;
    delete process.env.MCP_REMOTE_ENABLED;
  }
});

test("canon login against a self-hosted Canon pairs through its device flow and keeps the token without printing it", async () => {
  const home = mkdtempSync(join(tmpdir(), "canon-cli-"));
  process.env.CANON_HOME = home;
  process.env.CANON_INTERNAL_URL = "http://127.0.0.1:3000";
  process.env.SITE_URL = "https://crm.example.com";
  const token = `fsgtm_${"a".repeat(64)}`;
  const polls = ["pending", "approved"];
  const requests: string[] = [];
  const lines: string[] = [];
  const opened: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    assert.equal(new URL(url).origin, "http://127.0.0.1:3000");
    requests.push(`${new URL(url).pathname} ${init?.body ?? ""}`);
    if (url.endsWith("/api/cli/auth/start")) {
      return Response.json({ deviceCode: "d".repeat(64), userCode: "ABCD-EFGH", verificationUrl: "http://127.0.0.1:3000/dashboard/cli-auth?code=ABCD-EFGH", expiresInSeconds: 900, intervalSeconds: 3 });
    }
    const status = polls.shift();
    return Response.json(status === "approved" ? { status, cliToken: token } : { status });
  }) as typeof fetch;
  try {
    await pairDevice("https://crm.example.com", { fetchImpl, open: (url) => opened.push(url), wait: async () => {}, log: (line) => lines.push(line) });
    assert.deepEqual(JSON.parse(readFileSync(join(home, "credentials.json"), "utf8")), { "https://crm.example.com": { cliToken: token } });
    const output: string[] = [];
    const log = console.log;
    console.log = (line: string) => output.push(line);
    try {
      await main(["mcp-config"]);
      assert.ok(!output.join("\n").includes(token));
      assert.ok(output.join("\n").includes(join(home, "credentials.json")));
      output.length = 0;
      await main(["mcp-config", "--url", "https://crm.example.com", "--show-token"]);
      const config = output.join("\n");
      assert.ok(config.includes(`Authorization: Bearer ${token}`));
      const json = JSON.parse(config.slice(config.indexOf("{"), config.lastIndexOf("}") + 1));
      assert.deepEqual(json.mcpServers.canon, { url: "https://crm.example.com/mcp", headers: { Authorization: `Bearer ${token}` } });
      assert.match(config, /bearer_token_env_var = "CANON_TOKEN"/);
    } finally { console.log = log; }
    assert.deepEqual(opened, ["https://crm.example.com/dashboard/cli-auth?code=ABCD-EFGH"]);
    assert.equal(requests.filter((r) => r.startsWith("/api/cli/auth/poll")).length, 2, "it polls until the pairing is approved");
    assert.ok(lines.join("\n").includes("ABCD-EFGH") && !lines.join("\n").includes(token), "it shows the code to approve, never the token");
  } finally {
    delete process.env.CANON_INTERNAL_URL;
    delete process.env.SITE_URL;
    delete process.env.CANON_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI discovery and MCP requests use the internal address while configuration and credential lookup use the public address", async () => {
  const home = mkdtempSync(join(tmpdir(), "canon-cli-routing-"));
  const requests: string[] = [];
  const toolCalls: unknown[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url!);
    if (req.url === "/.well-known/oauth-protected-resource/mcp") { res.writeHead(200).end("{}"); return; }
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    assert.equal(req.headers.authorization, "Bearer routing-test-token");
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.method === "tools/call") toolCalls.push(message.params);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "routing-test", version: "1" } }
      : { content: [{ type: "text", text: "member confirmed" }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const saved = { ...process.env };
  const log = console.log;
  const output: string[] = [];
  console.log = (line: string) => output.push(line);
  try {
    process.env.CANON_HOME = home;
    process.env.CANON_INTERNAL_URL = `http://127.0.0.1:${address.port}`;
    process.env.SITE_URL = "https://public.example";
    delete process.env.CANON_URL;
    delete process.env.CANON_TOKEN;
    writeFileSync(join(home, "credentials.json"), JSON.stringify({ "https://public.example": { cliToken: "routing-test-token" } }));
    await main(["login"]);
    await main(["whoami"]);
    const cases = [
      ["records", "create", "canon_records", { object: "custom_kit", rows: [{ "custom.name": "Kit" }] }],
      ["records", "archive", "canon_records", { object: "lead", streamIds: ["s1"] }],
      ["integrations", "stop_sync", "canon_integrations", { provider: "hubspot", expectedRunIds: ["run"] }],
      ["tam", "list_suggestions", "canon_tam", {}],
      ["tam", "accept_suggestion", "canon_tam", { runId: "run", index: 0 }],
      ["audiences", "export_view_csv", "canon_audiences", { filter: [] }],
      ["csv-upload", "generate_url", "canon_csv_upload", {}],
      ["csv-upload", "claim", "canon_csv_upload", { storageId: "file", sha256: "hash" }],
    ] as const;
    for (const [command, action, name, args] of cases) {
      await main([command, action, "--args", JSON.stringify(args)]);
      assert.deepEqual(toolCalls.at(-1), { name, arguments: { action, args } });
    }
    await main(["mcp-config", "--show-token"]);
    assert.ok(requests.includes("/.well-known/oauth-protected-resource/mcp"));
    assert.ok(requests.filter((path) => path === "/mcp").length >= 4);
    assert.ok(output.join("\n").includes("https://public.example/mcp"));
    assert.ok(!output.join("\n").includes(process.env.CANON_INTERNAL_URL));
    output.length = 0;
    process.env.CANON_TOKEN = "routing-test-token";
    process.env.CANON_URL = "https://env.example";
    await main(["mcp-config"]);
    assert.ok(output.join("\n").includes("https://env.example/mcp"));
    output.length = 0;
    await main(["mcp-config", "--url", "https://flag.example/"]);
    assert.ok(output.join("\n").includes("https://flag.example/mcp"));
    delete process.env.CANON_INTERNAL_URL;
    assert.equal(requestBase("https://public.example"), "https://public.example");
  } finally {
    console.log = log;
    process.env = saved;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("canon_get_record accepts id as the streamId alias and preserves existing argument precedence", async () => {
  const tool = canonTools.find((tool) => tool.name === "canon_get_record")!;
  const ids: string[] = [];
  const client = { action: async (_fn: unknown, args: { id: string }) => { ids.push(args.id); return args; } };
  assert.ok(tool.inputSchema.id);
  for (const args of [{ id: "register" }, { streamId: "stream" }, { id: "alias", streamId: "preferred" }]) {
    await tool.run(client as never, args);
  }
  assert.deepEqual(ids, ["register", "stream", "preferred"]);
});
