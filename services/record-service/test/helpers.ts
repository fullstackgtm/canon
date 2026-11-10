import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type Config } from "../src/app.ts";

export const TOKEN = "test-token-0123456789abcdef";

export function tempDir(prefix = "rs-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0, host: "127.0.0.1", dataDir: tempDir(), token: TOKEN, maxOpen: 64, memoryLimit: "256MB", threads: 2,
    readPool: 2, maxGroup: 64, checkpointIntervalMs: 60_000, version: "test", ...over,
  };
}

export async function startApp(over: Partial<Config> = {}) {
  const cfg = testConfig(over);
  const app = createApp(cfg);
  const port = await app.listen();
  return { app, cfg, base: `http://127.0.0.1:${port}`, client: client(`http://127.0.0.1:${port}`) };
}

export function client(base: string, token = TOKEN) {
  const call = async (method: string, path: string, body?: unknown, ws?: string, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(ws ? { "x-workspace-id": ws } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
  return {
    call,
    ws: (ws: string) => ({
      post: (path: string, body: unknown = {}) => call("POST", `/v1/workspaces/${ws}/${path}`, body, ws),
      get: (path: string) => call("GET", `/v1/workspaces/${ws}/${path}`, undefined, ws),
    }),
  };
}

export function fixtureAccounts(n: number, seed = 0) {
  const industries = ["Software", "Fintech", "Healthcare", "Manufacturing", "Retail"];
  const countries = ["US", "GB", "DE", "CA"];
  return Array.from({ length: n }, (_, i) => ({
    domain: `co${seed}-${i}.example.com`,
    name: `Company ${seed}-${String(i).padStart(5, "0")}`,
    industry: industries[i % industries.length],
    employees: 10 + ((i * 37) % 5000),
    country: countries[i % countries.length],
    segmentIds: i % 3 === 0 ? ["seg-a"] : ["seg-b"],
  }));
}
