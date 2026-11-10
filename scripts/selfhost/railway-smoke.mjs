import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { verifyDeployment } from "./verify.mjs";

if (process.argv[2] === "--url") {
  try { await verifyDeployment(process.argv[3], `${process.argv[3]}/convex`, process.argv[4] === "--bootstrap-owner"); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else {

const image = process.argv[2] || "canoncrm-selfhost:railway-amd64";
const platform = process.argv[3] || "linux/amd64";
const name = `canoncrm-railway-${process.pid}`;
const volume = `${name}-data`;
const files = mkdtempSync(join(tmpdir(), "canoncrm-railway-"));
const cookies = join(files, "cookies");
const headers = join(files, "headers");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const site = `http://127.0.0.1:${port}`;

function request(path, body, authenticated = false) {
  const output = execFileSync("curl", ["--silent", "--show-error", "--max-time", "120",
    "--cookie", cookies, "--cookie-jar", cookies, "--write-out", "\n%{http_code}",
    ...(authenticated ? ["--header", `@${headers}`] : []),
    ...(body ? ["--header", `Origin: ${site}`, "--header", "Content-Type: application/json", "--data-binary", "@-"] : []),
    `${site}${path}`], { encoding: "utf8", input: body ? JSON.stringify(body) : undefined });
  const boundary = output.lastIndexOf("\n");
  assert.equal(Number(output.slice(boundary + 1)), 200, `HTTP failure at ${path}`);
  return output.slice(0, boundary);
}

async function healthy(start) {
  for (let n = 0; n < 600; n++) {
    const state = JSON.parse(docker("inspect", name, "--format", "{{json .State}}"));
    assert.equal(state.Running, true, `Container exited (${state.ExitCode}, OOM=${state.OOMKilled})`);
    if (state.Health.Status === "healthy") {
      assert.equal(JSON.parse(request("/api/public/version")).environment, "selfhost");
      return Number(((performance.now() - start) / 1000).toFixed(2));
    }
    await delay(1000);
  }
  throw new Error("Container did not become healthy within ten minutes");
}

function session() {
  const { token } = JSON.parse(request("/api/local-auth"));
  assert.equal(typeof token, "string", "Session must mint a token");
  writeFileSync(headers, `Authorization: Bearer ${token}\n`, { mode: 0o600 });
}

function convex(kind, path, args = {}) {
  const response = JSON.parse(request(`/convex/api/${kind}`, { path, args, format: "json" }, true));
  assert.equal(response.status, "success", `Convex failure at ${path}`);
  return response.value;
}

function fingerprint() {
  return docker("exec", name, "node", "--input-type=module", "-e", `
    import {readdirSync,readFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    const hash=createHash('sha256');
    for(const file of readdirSync('/data/credentials').sort()) hash.update(file).update(readFileSync('/data/credentials/'+file));
    console.log(hash.digest('hex'));
  `);
}

try {
  docker("volume", "create", volume);
  docker("run", "--rm", "--platform", platform, "--entrypoint", "/usr/bin/chown", "-v", `${volume}:/data`, image, "0:0", "/data");
  const start = performance.now();
  docker("run", "-d", "--platform", platform, "--name", name, "-m", "2g", "--memory-swap", "2g",
    "-e", "PORT=8080", "-e", `SITE_URL=${site}`, "-p", `127.0.0.1:${port}:8080`, "-v", `${volume}:/data`, image);
  const coldStartSeconds = await healthy(start);
  const anonymous = JSON.parse(request("/convex/api/query", { path: "users:me", args: {}, format: "json" }));
  assert.equal(anonymous.status, "success");
  assert.equal(anonymous.value, null, "Demo access must be off");
  const owner = { email: "owner@example.test", password: "u7Qp4Nw9Zc2Vm8Ks" };
  request("/api/local-auth", { kind: "register", ...owner, name: "Test owner", workspaceName: "Test workspace" });
  request("/api/local-auth", { kind: "sign-out" });
  request("/api/local-auth", { kind: "sign-in", ...owner });
  session();
  const user = convex("query", "users:me");
  assert.equal(user.email, owner.email);
  assert.equal(user.role, "admin");
  convex("action", "records:upsert", { object: "account", accounts: [{ domain: "persistence.example.test", name: "Persistent account" }], idempotencyKey: "persistence-check" });
  const records = convex("action", "records:list");
  assert.equal(records.total, 1);
  assert.match(JSON.stringify(records), /Persistent account/);
  assert.match(request("/dashboard"), /CanonCRM/);
  const ws = new WebSocket(`${site.replace("http:", "ws:")}/convex/api/1.31.7/sync`);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error("WebSocket upgrade timed out")); }, 15_000);
    ws.addEventListener("open", () => { clearTimeout(timeout); ws.close(); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket upgrade failed")); }, { once: true });
  });
  const keys = fingerprint();
  await delay(30_000);
  let stats;
  let quiet = 0;
  for (let n = 0; n < 60; n++) {
    stats = JSON.parse(docker("stats", name, "--no-stream", "--format", "{{json .}}"));
    quiet = Number.parseFloat(stats.CPUPerc) < 2 ? quiet + 1 : 0;
    if (quiet === 3) break;
    await delay(1000);
  }
  assert.equal(quiet, 3, "Three consecutive idle CPU samples required");
  const rss = docker("exec", name, "ps", "-e", "-o", "pid,ppid,uid,comm,rss", "--sort=-rss");
  const mounts = JSON.parse(docker("inspect", name, "--format", "{{json .Mounts}}"));
  assert.deepEqual(mounts.map((mount) => mount.Destination), ["/data"]);
  const restart = performance.now();
  docker("restart", "--time", "40", name);
  const restartSeconds = await healthy(restart);
  session();
  assert.equal(convex("query", "users:me")._id, user._id);
  assert.deepEqual(convex("action", "records:list"), records);
  assert.equal(fingerprint(), keys);
  assert.match(request("/dashboard"), /CanonCRM/);
  await verifyDeployment(site, `${site}/convex`, false, { SELFHOST_SMOKE_EMAIL: owner.email, SELFHOST_SMOKE_PASSWORD: owner.password });
  console.log(JSON.stringify({ image, platform, imageId: docker("image", "inspect", image, "--format", "{{.Id}}"),
    imageBytes: Number(docker("image", "inspect", image, "--format", "{{.Size}}")), coldStartSeconds, restartSeconds,
    stats, rootOwnedVolume: true, ownerSignupAndSignIn: true, dashboard: true, websocketUpgrade: true,
    persistedSessionOwnerRecordsAndKeys: true, demoData: false, name, volume, site }, null, 2));
  console.log(rss);
} finally {
  rmSync(files, { recursive: true, force: true });
  if (process.env.SELFHOST_RAILWAY_KEEP !== "1") {
    try { docker("rm", "-f", name); } catch {}
    try { docker("volume", "rm", volume); } catch {}
  } else console.log(`Kept ${name} and ${volume}`);
}
}
