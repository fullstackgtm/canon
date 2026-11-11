import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { backendEnv } from "../scripts/selfhost/platform.mjs";

const run = promisify(execFile);

// The Node action runner's two kinds of call: back into Convex at new URL(path, CONVEX_CLOUD_ORIGIN), and a Node
// action's own fetch of a URL Convex handed it, such as a storage URL.
const NODE_ACTION = `
  for (const url of [new URL("/api/actions/query", process.env.CONVEX_CLOUD_ORIGIN), process.env.CONVEX_CLOUD_ORIGIN + "/api/storage/abc"]) {
    const response = await fetch(url, { method: "POST", body: "{}" });
    if (!response.ok) throw new Error(url + " answered " + response.status);
  }`;

test("the backend's Node actions reach it on its in-container address whatever host port the browser uses", async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.headers.host}${request.url}`);
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const backend = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const port of [3000, 3919]) {
      const site = `http://localhost:${port}`;
      const env = backendEnv(
        { PATH: process.env.PATH, CONVEX_CLOUD_ORIGIN: `${site}/convex`, CONVEX_SITE_ORIGIN: `${site}/convex-site` },
        { backend: `http://${backend}`, backendSite: "http://127.0.0.1:9" },
      );
      await run(process.execPath, ["--input-type=module", "-e", NODE_ACTION], { env });
    }
  } finally {
    server.close();
  }
  const calls = [`POST ${backend}/api/actions/query`, `POST ${backend}/api/storage/abc`];
  assert.deepEqual(seen, [...calls, ...calls]);
  const entrypoint = readFileSync("scripts/selfhost/entrypoint.mjs", "utf8");
  assert.match(entrypoint, /daemon\("Convex", "\/convex\/run_backend\.sh", \[\], backendEnv\(env, /, "the container starts the backend with this environment");
});
