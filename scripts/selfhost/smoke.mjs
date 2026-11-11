import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const image = process.argv[2] || "canoncrm-selfhost:os3";
const name = `canoncrm-selfhost-smoke-${process.pid}`;
const volume = `${name}-data`;
const memory = process.env.SELFHOST_SMOKE_MEMORY || "2g";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const inside = (script) => docker("exec", name, "node", "--experimental-strip-types", "--input-type=module", "-e", script);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(demo = true) {
  const start = performance.now();
  docker("run", "-d", "--name", name, "--memory", memory, "--memory-swap", memory,
    ...(demo ? ["-e", "CANON_AUTH=clerk", "-e", "FSGTM_ENABLE_DEMO_DATA=true"] : []), "-v", `${volume}:/data`, image);
  for (let n = 0; n < 240; n++) {
    const state = JSON.parse(docker("inspect", name, "--format", "{{json .State}}"));
    assert.equal(state.Running, true, `Container exited (${state.ExitCode}, OOM=${state.OOMKilled})`);
    if (state.Health.Status === "healthy") return Number(((performance.now() - start) / 1000).toFixed(2));
    await delay(1000);
  }
  throw new Error("Container did not become healthy within four minutes");
}

function seeded() {
  return JSON.parse(inside(`
    async function query(path) {
      const r = await fetch('http://127.0.0.1:3210/api/query', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path, args:{}, format:'json'}) });
      const body = await r.json();
      if (!r.ok || body.status !== 'success') throw new Error('Seed query failed for '+path);
      return body.value;
    }
    const user = await query('users:me');
    const accounts = await query('accounts:context');
    const deals = await query('deals:list');
    if (!user || accounts.accounts.length < 3 || deals.length < 3) throw new Error('Missing seeded data');
    const {readFile} = await import('node:fs/promises');
    const token = (await readFile('/data/credentials/record_service_token','utf8')).trim();
    process.env.TOKEN_ENCRYPTION_KEY = (await readFile('/data/credentials/token_encryption_key','utf8')).trim();
    const {encryptToken, decryptToken} = await import('/app/convex/lib/encryption.ts');
    if (await decryptToken(await encryptToken('self-host smoke credential')) !== 'self-host smoke credential') throw new Error('Generated encryption key cannot encrypt credentials');
    const r = await fetch('http://127.0.0.1:8787/v1/workspaces/'+user.orgId+'/accounts/list', {method:'POST', headers:{Authorization:'Bearer '+token, 'Content-Type':'application/json', 'X-Workspace-Id':user.orgId}, body:'{}'});
    const record = await r.json();
    if (!r.ok || record.total < 1) throw new Error('DuckDB read failed ('+r.status+')');
    console.log(JSON.stringify({orgId:user.orgId,userId:user._id,accounts:accounts.accounts.length,deals:deals.length,recordAccounts:record.total,tokenEncryptionRoundTrip:true}));
  `));
}

function keyFingerprint() {
  return inside(`
    import {readdir, readFile} from 'node:fs/promises';
    import {createHash} from 'node:crypto';
    const hash = createHash('sha256');
    for (const file of (await readdir('/data/credentials')).sort()) hash.update(file).update(await readFile('/data/credentials/'+file));
    console.log(hash.digest('hex'));
  `);
}

let failed = false;
try {
  docker("volume", "create", volume);
  const coldStartSeconds = await boot();
  const first = seeded();
  const keys = keyFingerprint();
  await delay(30_000);
  let stats;
  let quietSamples = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    stats = JSON.parse(docker("stats", name, "--no-stream", "--format", "{{json .}}"));
    quietSamples = Number.parseFloat(stats.CPUPerc) < 2 ? quietSamples + 1 : 0;
    if (quietSamples === 3) break;
    await delay(1000);
  }
  assert.equal(quietSamples, 3, "Container did not become idle for three consecutive samples");
  const ps = docker("exec", name, "ps", "-e", "-o", "pid,ppid,comm,rss", "--sort=-rss");
  const mounts = JSON.parse(docker("inspect", name, "--format", "{{json .Mounts}}"));
  assert.deepEqual(mounts.map((m) => m.Destination), ["/data"]);
  console.log(JSON.stringify({image, imageBytes: Number(docker("image", "inspect", image, "--format", "{{.Size}}")), memoryLimit: memory, coldStartSeconds, stats, seed: first}, null, 2));
  console.log(ps);
  docker("stop", "--time", "40", name);
  assert.equal(docker("inspect", name, "--format", "{{.State.ExitCode}}"), "0");
  docker("rm", name);
  const restartSeconds = await boot();
  assert.deepEqual(seeded(), first);
  assert.equal(keyFingerprint(), keys);
  console.log(JSON.stringify({restartSeconds, persistedSeedAndKeys: true, mounts: mounts.map((m) => m.Destination)}));
  docker("stop", "--time", "40", name);
  docker("rm", name);
  await boot(false);
  const anonymous = inside(`
    const r = await fetch('http://127.0.0.1:3210/api/query', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:'users:me',args:{},format:'json'})});
    const body = await r.json();
    if (!r.ok || body.status !== 'success') throw new Error('Anonymous query failed');
    console.log(JSON.stringify(body.value));
  `);
  assert.equal(anonymous, "null");
  console.log("Demo access is off without the smoke-only environment flag");
  inside(`
    const url = 'http://127.0.0.1:3000/api/local-auth';
    const headers = {Origin:'http://localhost:3000', 'Content-Type':'application/json'};
    const {execFileSync} = await import('node:child_process');
    const setupCode = execFileSync(process.execPath, ['scripts/selfhost/setup-code.mjs'], {encoding:'utf8'}).trim();
    const created = await fetch(url, {method:'POST', headers, body:JSON.stringify({kind:'register', email:'owner@example.test', name:'Docker owner', workspaceName:'Docker smoke', password:'docker smoke password', setupCode})});
    if (created.status !== 200) throw new Error('Local owner setup failed ('+created.status+'): '+await created.text());
    const cookie = created.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('Local owner session cookie is missing');
    const session = await fetch(url, {headers:{Cookie:cookie}});
    const {token} = await session.json();
    if (session.status !== 200 || !token) throw new Error('Local session did not mint a token');
    const response = await fetch('http://127.0.0.1:3210/api/query', {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+token}, body:JSON.stringify({path:'users:me',args:{},format:'json'})});
    const user = await response.json();
    if (!response.ok || user.status !== 'success' || user.value?.email !== 'owner@example.test' || user.value?.role !== 'admin') throw new Error('Local token did not resolve the owner');
    const logout = await fetch(url, {method:'POST',headers:{...headers,Cookie:cookie},body:JSON.stringify({kind:'sign-out'})});
    if (logout.status !== 200) throw new Error('Local sign-out failed');
    const ended = await (await fetch(url, {headers:{Cookie:cookie}})).json();
    if (ended.token !== null) throw new Error('Signed-out session still has access');
  `);
  console.log("Local owner signup, signed session, and sign-out passed without Clerk or demo access");
  inside(`
    const r = await fetch('http://127.0.0.1:8790/run', {method:'POST'});
    if (r.status !== 401) throw new Error('The built-in recipe runtime did not refuse an unsigned call ('+r.status+')');
  `);
  console.log("The built-in recipe runtime answers on loopback and refuses an unsigned call");
  docker("exec", name, "pkill", "-TERM", "-x", "convex-local-ba");
  for (let n = 0; n < 45; n++) {
    if (docker("inspect", name, "--format", "{{.State.Running}}") === "false") break;
    await delay(1000);
  }
  assert.equal(docker("inspect", name, "--format", "{{.State.Running}}"), "false");
  assert.notEqual(docker("inspect", name, "--format", "{{.State.ExitCode}}"), "0");
  console.log("Child failure stopped the container");
} catch (error) {
  failed = true;
  console.error(error.message);
  try { console.error(docker("logs", "--tail", "100", name)); } catch {}
  process.exitCode = 1;
} finally {
  if (!(failed && process.env.SELFHOST_SMOKE_KEEP === "1")) {
    try { docker("rm", "-f", name); } catch {}
    try { docker("volume", "rm", volume); } catch {}
  } else console.error(`Kept ${name} and ${volume} for diagnosis`);
}
