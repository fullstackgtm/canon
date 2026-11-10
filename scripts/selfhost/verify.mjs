import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, restoreCompose } from "./backup.mjs";

export async function verifyDeployment(site, backend = `${site}/convex`, bootstrapOwner = false, env = {
  SELFHOST_SMOKE_EMAIL: process.env.SELFHOST_SMOKE_EMAIL,
  SELFHOST_SMOKE_PASSWORD: process.env.SELFHOST_SMOKE_PASSWORD,
}, { restart, backupRestore } = {}) {
  const start = performance.now();
  const check = async (name, run) => {
    const at = performance.now();
    try {
      const value = await run();
      console.log(`PASS ${name} (${((performance.now() - at) / 1000).toFixed(2)}s)`);
      return value;
    } catch (error) {
      console.error(`FAIL ${name}`);
      throw error;
    }
  };
  const origin = new URL(site);
  assert.ok(origin.protocol === "https:" || (origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)), "Use HTTPS, or HTTP on localhost");
  assert.equal(origin.origin, site, "Pass the site origin without a trailing slash or path");
  const backendUrl = new URL(backend);
  assert.ok(backendUrl.protocol === "https:" || (backendUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(backendUrl.hostname)), "Use a secure backend URL");
  assert.ok(!backendUrl.username && !backendUrl.password && !backendUrl.search && !backendUrl.hash, "Backend URL must not contain credentials, query, or fragment");
  const generated = bootstrapOwner && !env.SELFHOST_SMOKE_EMAIL && !env.SELFHOST_SMOKE_PASSWORD;
  const email = generated ? `owner-${randomUUID().slice(0, 8)}@selfhost.invalid` : env.SELFHOST_SMOKE_EMAIL;
  const password = generated ? randomUUID() + randomUUID() : env.SELFHOST_SMOKE_PASSWORD;
  assert.ok(email && password, "Set SELFHOST_SMOKE_EMAIL and SELFHOST_SMOKE_PASSWORD to an installation owner's credentials, or pass --bootstrap-owner on a fresh install");
  if (generated) console.log(`Bootstrapping throwaway owner ${email}; the password is not saved, so use this only on a test install`);
  const request = (url, options = {}) => fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(30_000) });
  let token;
  const convex = async (kind, path, args = {}) => {
    const response = await request(`${backend}/api/${kind}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    assert.equal(response.status, 200, `Backend HTTP failure at ${path}`);
    const result = await response.json();
    assert.equal(result.status, "success", `Backend function failed at ${path}`);
    return result.value;
  };
  await check("health: app and backend reachable, demo access off", async () => {
    const version = await request(`${site}/api/public/version`);
    assert.equal(version.status, 200, "Version endpoint unavailable");
    assert.equal((await version.json()).environment, "selfhost", "Set APP_ENVIRONMENT=selfhost on the Next app");
    assert.equal(await convex("query", "users:me"), null, "Anonymous demo access must be off");
  });
  await check("/sign-in serves HTML", async () => {
    const response = await request(`${site}/sign-in`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /<html/i);
  });
  const auth = (body, cookie) => request(`${site}/api/local-auth`, {
    method: "POST", headers: { Origin: site, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  let cookie;
  try {
    const owner = await check(bootstrapOwner ? "first owner registration and local sign-in" : "owner local sign-in", async () => {
      if (bootstrapOwner) {
        const registration = await auth({ kind: "register", email, password, name: "Installation owner", workspaceName: "My workspace" });
        assert.equal(registration.status, 200, "First owner setup failed. On an existing install omit --bootstrap-owner");
        cookie = registration.headers.get("set-cookie")?.split(";")[0];
        assert.ok(cookie, "Registration must set a session cookie");
        assert.equal((await auth({ kind: "sign-out" }, cookie)).status, 200);
      }
      const login = await auth({ kind: "sign-in", email, password });
      assert.equal(login.status, 200, "Owner sign-in failed");
      cookie = login.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie, "Sign-in must set a session cookie");
      const session = await request(`${site}/api/local-auth`, { headers: { Cookie: cookie } });
      assert.equal(session.status, 200, "Session endpoint failed");
      ({ token } = await session.json());
      assert.equal(typeof token, "string", "Session must mint a token");
      const user = await convex("query", "users:me");
      assert.equal(user.email, email.trim().toLowerCase());
      assert.equal(user.role, "admin");
      return user;
    });
    const marker = `selfhost-smoke-${randomUUID()}`;
    const companyName = `Verification company ${marker}`;
    const personName = `Verification person ${marker}`;
    const dealName = `Verification deal ${marker}`;
    const companyId = await check("company create and read back", async () => {
      const result = await convex("action", "records:upsert", { object: "account", accounts: [{ domain: `${marker}.example.test`, name: companyName }], idempotencyKey: `${marker}-company` });
      assert.equal(result.upserted, 1);
      assert.equal(result.ids.length, 1);
      assert.equal((await convex("action", "records:get", { id: result.ids[0] })).account.name, companyName);
      return result.ids[0];
    });
    const personId = await check("person create and read back", async () => {
      const result = await convex("action", "records:upsert", { object: "contact", contacts: [{ fullName: personName, email: `${marker}@example.test`, accountId: companyId }], idempotencyKey: `${marker}-person` });
      assert.equal(result.upserted, 1);
      assert.equal(result.ids.length, 1);
      const company = await convex("action", "records:get", { id: companyId });
      const person = company.contacts.find((contact) => contact.id === result.ids[0]);
      assert.equal(person?.fullName, personName);
      assert.equal(person.accountId, companyId);
      return result.ids[0];
    });
    // The timeline reads the record service's projection of the ledger, so this proves the record service can pull from Convex.
    await check("note shows on the company timeline", async () => {
      const note = await convex("action", "activityTargets:logScoped", { object: "note", values: { body: `Verification note ${marker}` }, targets: [{ object: "account", id: companyId }] });
      assert.equal(note.status, "applied", "Saving the note failed");
      const deadline = Date.now() + 30_000;
      for (;;) {
        const timeline = await convex("action", "activityTargets:forRecord", { object: "account", id: companyId }).catch(() => null);
        if (timeline?.activities.some((activity) => activity.id === note.streamId)) return;
        assert.ok(Date.now() < deadline, "The note did not reach the company timeline within 30 s: the record service cannot read the ledger");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    });
    const dealId = await check("deal create and read back", async () => {
      const [pipeline] = await convex("query", "pipelines:list");
      assert.ok(pipeline?.stages.length, "At least one deal stage required");
      const result = await convex("action", "deals:createScoped", { name: dealName, companyId, amount: 12300, currency: "USD", closeDate: "2030-12-31", stage: pipeline.stages[0].value, pipelineId: pipeline.id });
      const deal = await convex("query", "deals:get", { dealId: result.dealId });
      assert.equal(deal.name, dealName);
      assert.equal(deal.companyId, companyId);
      assert.equal(deal.amount, 12300);
      return result.dealId;
    });
    await check("authenticated dashboard and WebSocket", async () => {
      const dashboard = await request(`${site}/dashboard`, { headers: { Cookie: cookie } });
      assert.equal(dashboard.status, 200);
      await dashboard.arrayBuffer();
      const ws = new WebSocket(`${backend.replace(/^http/, "ws")}/api/1.31.7/sync`);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); reject(new Error("WebSocket upgrade timed out")); }, 15_000);
        ws.addEventListener("open", () => { clearTimeout(timeout); ws.close(); resolve(); }, { once: true });
        ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket upgrade failed")); }, { once: true });
      });
    });
    const persisted = (name, interrupt) => check(`${name}: health, session, owner, company, person and deal persist`, async () => {
      await interrupt();
      const session = await request(`${site}/api/local-auth`, { headers: { Cookie: cookie } });
      assert.equal(session.status, 200, "Session must survive restart");
      ({ token } = await session.json());
      assert.equal(typeof token, "string");
      assert.equal((await convex("query", "users:me"))._id, owner._id);
      const company = await convex("action", "records:get", { id: companyId });
      assert.equal(company.account.name, companyName);
      assert.equal(company.contacts.find((person) => person.id === personId)?.fullName, personName);
      const deal = await convex("query", "deals:get", { dealId });
      assert.equal(deal.name, dealName);
      assert.equal(deal.companyId, companyId);
      assert.equal(deal.amount, 12300);
    });
    if (restart) await persisted("container restart", restart);
    if (backupRestore) await persisted("backup and restore", backupRestore);
  } finally {
    if (cookie) await check("local sign-out", async () => assert.equal((await auth({ kind: "sign-out" }, cookie)).status, 200));
  }
  console.log(`PASS verification complete (${((performance.now() - start) / 1000).toFixed(2)}s)`);
}

export function containerRestart(container, sshHost, site) {
  assert.match(container, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "Pass a container name or ID");
  if (sshHost) assert.match(sshHost, /^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/, "Pass an SSH host or configured SSH alias");
  const docker = (...args) => execFileSync(sshHost ? "ssh" : "docker", sshHost ? ["-o", "BatchMode=yes", "--", sshHost, "docker", ...args] : args,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 }).trim();
  return async () => {
    const inspect = () => JSON.parse(docker("inspect", container))[0];
    assert.ok(inspect().Config.Env.includes(`SITE_URL=${site}`), "Restart container SITE_URL must match the verified origin");
    docker("restart", "--time", "40", container);
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const { State: state } = inspect();
      assert.equal(state.Running, true, "Container exited after restart");
      if (state.Health?.Status === "healthy") return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Container did not become healthy within ten minutes");
  };
}

// Takes a backup, restores it over the running install, and removes the archive. Run from the Compose checkout.
export function composeBackupRestore(site) {
  return async () => {
    const container = execFileSync("docker", ["compose", "ps", "-q", "canoncrm"], { encoding: "utf8" }).trim();
    assert.ok(container, "No running canoncrm service in this checkout's Compose project");
    assert.ok(JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }))[0].Config.Env.includes(`SITE_URL=${site}`), "The Compose container's SITE_URL must match the verified origin");
    const out = mkdtempSync(join(tmpdir(), "canon-verify-backup-"));
    try {
      const taken = await backup({ out, log: () => {} });
      console.log(`  backup: ${taken.files} files, ${taken.bytes} bytes, ${taken.downtimeSeconds}s down`);
      await restoreCompose(taken.archive, { replace: true, log: () => {} });
    } finally { rmSync(out, { recursive: true, force: true }); }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const positional = [];
    let bootstrapOwner = false, backupRestore = false, container, sshHost;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--bootstrap-owner") bootstrapOwner = true;
      else if (args[i] === "--backup-restore") backupRestore = true;
      else if (["--restart-container", "--ssh"].includes(args[i])) {
        const flag = args[i];
        const value = args[++i];
        assert.ok(value && !value.startsWith("-"), `Missing value for ${flag}`);
        if (flag === "--ssh") sshHost = value;
        else container = value;
      } else {
        assert.ok(!args[i].startsWith("-"), "Unknown verification option");
        positional.push(args[i]);
      }
    }
    assert.ok(positional.length <= 2, "Pass site URL and optional backend URL");
    assert.ok(!sshHost || container, "--ssh requires --restart-container");
    const site = positional[0] ?? process.env.SITE_URL;
    await verifyDeployment(site, positional[1] ?? (positional[0] ? `${site}/convex` : process.env.NEXT_PUBLIC_CONVEX_URL ?? `${site}/convex`), bootstrapOwner, process.env,
      { restart: container ? containerRestart(container, sshHost, site) : undefined, backupRestore: backupRestore ? composeBackupRestore(site) : undefined });
  } catch (error) { console.error(`FAIL verification: ${error.message}`); process.exitCode = 1; }
}
