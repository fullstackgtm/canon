#!/usr/bin/env node
/**
 * canon — a thin CLI over Canon's hosted MCP endpoint (<url>/mcp).
 *
 * All logic lives in the app; this only authenticates and calls tools.
 *   - `canon login` runs the MCP OAuth flow (discovery, dynamic client
 *     registration, PKCE) in the browser with a loopback redirect, then keeps
 *     and refreshes the tokens in ~/.canon/credentials.json (0600).
 *   - Headless agents set CANON_TOKEN to a paired CLI token instead.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const DEFAULT_URL = "https://canoncrm.com";
const CALLBACK_PORT = Number(process.env.CANON_CALLBACK_PORT ?? 8976);
const VERSION = "0.1.0";

type Stored = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };
type CredentialFile = Record<string, Stored>;

function credentialsPath() {
  const dir = process.env.CANON_HOME ?? join(homedir(), ".canon");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, "credentials.json");
}

function readCredentials(): CredentialFile {
  try {
    return JSON.parse(readFileSync(credentialsPath(), "utf8")) as CredentialFile;
  } catch {
    return {};
  }
}

function updateCredentials(base: string, patch: (s: Stored) => Stored | undefined) {
  const all = readCredentials();
  const next = patch(all[base] ?? {});
  if (next) all[base] = next;
  else delete all[base];
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Printed below as a fallback.
  }
}

class CliOAuthProvider implements OAuthClientProvider {
  private base: string;
  private onAuthorize: (url: URL) => void;
  constructor(base: string, onAuthorize: (url: URL) => void) {
    this.base = base;
    this.onAuthorize = onAuthorize;
  }
  get redirectUrl() {
    return `http://127.0.0.1:${CALLBACK_PORT}/callback`;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Canon CLI",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return readCredentials()[this.base]?.client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    updateCredentials(this.base, (s) => ({ ...s, client }));
  }
  tokens() {
    return readCredentials()[this.base]?.tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    updateCredentials(this.base, (s) => ({ ...s, tokens }));
  }
  redirectToAuthorization(url: URL) {
    this.onAuthorize(url);
  }
  saveCodeVerifier(verifier: string) {
    updateCredentials(this.base, (s) => ({ ...s, verifier }));
  }
  codeVerifier() {
    const v = readCredentials()[this.base]?.verifier;
    if (!v) throw new Error("No PKCE verifier saved; run `canon login` again.");
    return v;
  }
}

/** Waits for the OAuth redirect on the loopback port and returns the code. */
function awaitCallback(): { server: Server; code: Promise<string> } {
  let resolve!: (code: string) => void;
  let reject!: (error: Error) => void;
  const code = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    const c = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(c ? "<p>Canon CLI is signed in. You can close this tab.</p>" : `<p>Sign-in failed: ${error ?? "no code"}.</p>`);
    if (c) resolve(c);
    else reject(new Error(`Authorization failed: ${error ?? "no code returned"}`));
  });
  server.on("error", (e) => reject(e as Error));
  server.listen(CALLBACK_PORT, "127.0.0.1");
  return { server, code };
}

function baseUrl(flags: Map<string, string>) {
  return (flags.get("--url") ?? process.env.CANON_URL ?? DEFAULT_URL).replace(/\/+$/, "");
}

/** A failed connection in terms of what to do next: the transport's own message is "Error POSTing to endpoint:" and nothing else. */
function connectionError(endpoint: URL, error: unknown): Error {
  const code = error instanceof StreamableHTTPError ? error.code : undefined;
  if (code === 401 || code === 403) return new Error(`${endpoint.origin} refused the token (HTTP ${code}). Run \`canon login\`, or pair a new CLI token for CANON_TOKEN.`);
  if (code === 404) return new Error(`No Canon MCP endpoint at ${endpoint.href} (HTTP 404). Check --url or CANON_URL; a local or self-hosted server needs MCP_REMOTE_ENABLED=true.`);
  if (code !== undefined) return new Error(`${endpoint.href} answered HTTP ${code}. Retry once; if it fails again, check the server's logs.`);
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined)?.code ?? error.message : String(error);
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|EAI_AGAIN/.test(cause)) return new Error(`Could not reach ${endpoint.origin} (${cause}). Check --url or CANON_URL and that the server is running.`);
  return error instanceof Error ? error : new Error(String(error));
}

async function connect(base: string, opts: { interactive: boolean }): Promise<Client> {
  const endpoint = new URL(`${base}/mcp`);
  try {
    return await connectTo(endpoint, base, opts);
  } catch (error) {
    throw connectionError(endpoint, error);
  }
}

async function connectTo(endpoint: URL, base: string, opts: { interactive: boolean }): Promise<Client> {
  const client = new Client({ name: "canon-cli", version: VERSION });
  const headless = process.env.CANON_TOKEN;
  if (headless) {
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${headless}` } } }));
    return client;
  }
  if (!opts.interactive && !readCredentials()[base]?.tokens) {
    throw new Error(`Not signed in to ${base}. Run \`canon login\` (or set CANON_TOKEN).`);
  }
  let callback: ReturnType<typeof awaitCallback> | null = null;
  const provider = new CliOAuthProvider(base, (url) => {
    if (!opts.interactive) throw new Error("Not signed in. Run `canon login` first (or set CANON_TOKEN).");
    callback = awaitCallback();
    console.error(`Opening your browser to sign in to Canon:\n  ${url.href}`);
    openBrowser(url.href);
  });
  const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    if (!(error instanceof UnauthorizedError) || !callback) throw error;
    const pending: ReturnType<typeof awaitCallback> = callback;
    try {
      await transport.finishAuth(await pending.code);
    } finally {
      pending.server.close();
    }
    const retry = new Client({ name: "canon-cli", version: VERSION });
    await retry.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
    return retry;
  }
}

async function callTool(base: string, name: string, args: Record<string, unknown>) {
  const client = await connect(base, { interactive: false });
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
    if (result.isError) {
      console.error(text);
      process.exitCode = 1;
      return;
    }
    console.log(text);
  } finally {
    await client.close();
  }
}

function parseArgs(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`--args is not valid JSON (${error instanceof Error ? error.message : String(error)}). Pass an object, e.g. --args '{"action":"list"}', or --args @file.json.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("--args must be a JSON object, e.g. --args '{\"action\":\"list\"}'.");
  return value as Record<string, unknown>;
}

const USAGE = `canon ${VERSION} — Canon from the command line (talks to <url>/mcp)

  canon login [--url <url>]            sign in through the browser (OAuth)
  canon logout [--url <url>]
  canon whoami
  canon deals [--name <text>] [--limit <n>]
  canon deal <dealId> [--known-at <ms>] [--valid-at <ms>]
  canon receipts <dealId> <field>
  canon propose --in <batch.json>      propose facts for review
  canon status <batchId>
  canon review                         facts awaiting review, contested fields
  canon audit [--rule <id>]
  canon plans [<planId>] [--status <s>]
  canon tools                          list every hosted tool
  canon call <tool> [--args <json>]    call any hosted tool; --args @file.json reads a file
                                       e.g. canon call canon_research --args '{"action":"start","args":{"domain":"acme.com"}}'

Environment: CANON_URL (default ${DEFAULT_URL}); CANON_TOKEN to use a paired CLI
token instead of OAuth (headless agents).`;

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags.set(a, next); i++; } else flags.set(a, "true");
    } else positional.push(a);
  }
  return { positional, flags };
}

/** `@path` reads the JSON from a file (large batches); anything else is the JSON itself. */
function readArgs(v: string) {
  return v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v;
}

function num(v: string | undefined) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got ${v}`);
  return n;
}

export async function main(argv = process.argv.slice(2)) {
  const { positional: [command, ...rest], flags } = parse(argv);
  const base = baseUrl(flags);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return;
    case "--version":
    case "version":
      console.log(VERSION);
      return;
    case "login": {
      const client = await connect(base, { interactive: true });
      await client.close();
      console.log(`Signed in to ${base}.`);
      return;
    }
    case "logout":
      updateCredentials(base, () => undefined);
      console.log(`Signed out of ${base}.`);
      return;
    case "whoami":
      return callTool(base, "canon_whoami", {});
    case "deals":
      return callTool(base, "canon_list_deals", { ...(flags.has("--name") ? { nameContains: flags.get("--name") } : {}), ...(flags.has("--limit") ? { limit: num(flags.get("--limit")) } : {}) });
    case "deal":
      if (!rest[0]) throw new Error("Usage: canon deal <dealId>");
      return callTool(base, "canon_get_deal", { dealId: rest[0], ...(flags.has("--known-at") ? { knownAt: num(flags.get("--known-at")) } : {}), ...(flags.has("--valid-at") ? { validAt: num(flags.get("--valid-at")) } : {}) });
    case "receipts":
      if (!rest[1]) throw new Error("Usage: canon receipts <dealId> <field>");
      return callTool(base, "canon_field_receipts", { dealId: rest[0], attribute: rest[1] });
    case "propose": {
      const path = flags.get("--in");
      if (!path) throw new Error("Usage: canon propose --in <batch.json>");
      return callTool(base, "canon_propose_facts", JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
    }
    case "status":
      if (!rest[0]) throw new Error("Usage: canon status <batchId>");
      return callTool(base, "canon_fact_batch_status", { batchId: rest[0] });
    case "review":
      return callTool(base, "canon_review_queue", {});
    case "audit":
      return callTool(base, "canon_hygiene_audit", flags.has("--rule") ? { rule: flags.get("--rule") } : {});
    case "plans":
      return callTool(base, "canon_patch_plans", { ...(rest[0] ? { patchPlanId: rest[0] } : {}), ...(flags.has("--status") ? { status: flags.get("--status") } : {}) });
    case "tools": {
      const client = await connect(base, { interactive: false });
      try {
        const { tools } = await client.listTools();
        for (const t of tools) console.log(`${t.name.padEnd(26)} ${(t.description ?? "").split(". ")[0]}`);
      } finally {
        await client.close();
      }
      return;
    }
    case "call":
      if (!rest[0]) throw new Error("Usage: canon call <tool> [--args <json>]");
      return callTool(base, rest[0], flags.has("--args") ? parseArgs(readArgs(flags.get("--args")!)) : {});
    default:
      throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
