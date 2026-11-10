// Backs up and restores a Docker Compose install of Canon. See docs/updating.md.
//
//   node scripts/selfhost/backup.mjs [--out <dir>]
//   node scripts/selfhost/backup.mjs --verify <archive>
//   node scripts/selfhost/backup.mjs --restore <archive> [--replace]
//
// A backup stops the container, so the Convex SQLite database and every DuckDB
// workspace are closed at one moment, and archives the whole /data volume with a
// manifest of every file's size and SHA-256. It then starts the container and
// waits for it to be healthy. Restore checks the archive and its data epoch
// before it changes anything, sets the volume's current contents aside, and puts
// them back if the restored install does not become healthy. The archive holds
// the generated credentials, so treat it as a secret.
//
// Run it from the Compose checkout on the Docker host. Volume work runs in a
// short-lived container from the install's own image, with this directory
// mounted read-only. Node built-ins, git and docker only.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip, createGzip } from "node:zlib";
import { parseContract, planData } from "./releases.mjs";

export const FORMAT = "canon-selfhost-backup";
export const FORMAT_VERSION = 1;
export const ASIDE = ".restore-previous";
const ORIGINALS = ".originals.json";
const MANIFEST = "manifest.json";
const BLOCK = 512;
const CANON_UID = 1001;
// The Convex backend's scratch space: each boot unpacks its function runtime there. Kept as an empty directory.
const SCRATCH = new Set(["convex/tmp"]);

// The archive is a tar any tar tool reads: ustar headers, plus a pax header for a path over
// 100 bytes or a file over 8 GiB. Layout: data/<path in the volume> for every file and
// directory, then manifest.json.
function header(path, { type, size = 0, mode, mtime }) {
  const block = Buffer.alloc(BLOCK);
  const field = (offset, length, value) => block.write(value, offset, length, "utf8");
  const octal = (offset, length, value) => field(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
  field(0, 100, path.slice(0, 100));
  octal(100, 8, mode & 0o7777);
  octal(108, 8, CANON_UID);
  octal(116, 8, CANON_UID);
  octal(124, 12, size < 8 ** 11 ? size : 0);
  octal(136, 12, Math.floor(mtime));
  field(148, 8, "        ");
  field(156, 1, type);
  field(257, 8, "ustar\u000000");
  let sum = 0;
  for (const byte of block) sum += byte;
  field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function* entryHeaders(path, meta) {
  const pax = [];
  if (Buffer.byteLength(path) > 100) pax.push(["path", path]);
  if ((meta.size ?? 0) >= 8 ** 11) pax.push(["size", String(meta.size)]);
  if (pax.length) {
    const body = Buffer.from(pax.map(([key, value]) => {
      const text = ` ${key}=${value}\n`;
      let length = text.length;
      while (`${length}${text}`.length !== length) length = `${length}${text}`.length;
      return `${length}${text}`;
    }).join(""));
    yield header("pax", { type: "x", size: body.length, mode: 0o644, mtime: meta.mtime });
    yield body;
    yield padding(body.length);
  }
  yield header(path, meta);
}

const padding = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

async function collect(chunks) {
  const all = [];
  for await (const chunk of chunks) all.push(chunk);
  return Buffer.concat(all);
}

function parseHeader(block) {
  if (block.every((byte) => byte === 0)) return null;
  const text = (offset, length) => block.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/s, "");
  const number = (offset, length) => Number.parseInt(text(offset, length).trim() || "0", 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  if (sum !== number(148, 8)) throw new Error("Archive header checksum mismatch");
  const prefix = text(345, 155);
  return { path: prefix ? `${prefix}/${text(0, 100)}` : text(0, 100), type: text(156, 1) || "0", mode: number(100, 8), size: number(124, 12), mtime: number(136, 12) };
}

// Each entry's `chunks` must be read to the end before the next entry is taken.
async function* readTar(file) {
  const input = createReadStream(file).pipe(createGunzip())[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  const fill = async (n) => {
    while (buffer.length < n) {
      const next = await input.next();
      if (next.done) throw new Error("Archive ends early");
      buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value;
    }
  };
  const take = async (n) => { await fill(n); const out = buffer.subarray(0, n); buffer = buffer.subarray(n); return out; };
  async function* body(size) {
    let left = size;
    while (left > 0) {
      if (!buffer.length) await fill(1);
      const chunk = buffer.subarray(0, Math.min(left, buffer.length));
      buffer = buffer.subarray(chunk.length);
      left -= chunk.length;
      yield chunk;
    }
    await take(padding(size).length);
  }
  let pax = {};
  for (;;) {
    const entry = parseHeader(await take(BLOCK));
    if (!entry) return;
    if (entry.type === "x") {
      const text = (await collect(body(entry.size))).toString("utf8");
      pax = Object.fromEntries([...text.matchAll(/^\d+ ([^=]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
      continue;
    }
    if (pax.path) entry.path = pax.path;
    if (pax.size) entry.size = Number(pax.size);
    pax = {};
    if (entry.type !== "0" && entry.type !== "5") throw new Error(`Archive entry ${entry.path} is not a file or directory`);
    entry.path = entry.path.replace(/\/$/, "");
    const chunks = body(entry.type === "0" ? entry.size : 0);
    yield { ...entry, chunks };
    for await (const chunk of chunks) void chunk;
  }
}

const safePath = (path) => path.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes("\\"));

async function* walk(root, dir = root) {
  for (const name of (await readdir(dir)).sort()) {
    if (dir === root && name === ASIDE) continue;
    const path = join(dir, name);
    const info = await lstat(path);
    const rel = relative(root, path).split(sep).join("/");
    if (info.isDirectory()) {
      yield { rel, path, info, type: "5" };
      if (!SCRATCH.has(rel)) yield* walk(root, path);
    }
    else if (info.isFile()) yield { rel, path, info, type: "0" };
    else if (info.isSocket() || info.isFIFO()) continue;
    else throw new Error(`${rel} is not a regular file or directory`);
  }
}

/** Writes the volume at `dataDir` to `file` and returns the manifest. The services must be stopped. Check the result with verifyArchive. */
export async function pack(dataDir, file, meta) {
  const members = [];
  let manifest;
  async function* stream() {
    for await (const { rel, path, info, type } of walk(dataDir)) {
      const name = `data/${rel}`;
      if (type === "5") { yield* entryHeaders(`${name}/`, { type, mode: info.mode, mtime: info.mtimeMs / 1000 }); continue; }
      yield* entryHeaders(name, { type, size: info.size, mode: info.mode, mtime: info.mtimeMs / 1000 });
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length; yield chunk; }
      if (size !== info.size) throw new Error(`${rel} changed while it was archived. Stop Canon and try again`);
      yield padding(size);
      members.push({ path: name, size, sha256: hash.digest("hex") });
    }
    manifest = { format: FORMAT, formatVersion: FORMAT_VERSION, createdAt: new Date().toISOString(), ...meta, members };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    yield* entryHeaders(MANIFEST, { type: "0", size: bytes.length, mode: 0o600, mtime: Date.now() / 1000 });
    yield bytes;
    yield padding(bytes.length);
    yield Buffer.alloc(BLOCK * 2);
  }
  const partial = `${file}.partial`;
  try {
    await pipeline(Readable.from(stream()), createGzip(), createWriteStream(partial, { mode: 0o600 }));
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  await rename(partial, file);
  return manifest;
}

function checkManifest(manifest, seen) {
  if (manifest?.format !== FORMAT) throw new Error("Not a Canon backup");
  if (manifest.formatVersion !== FORMAT_VERSION) throw new Error(`Backup format ${manifest.formatVersion} is not supported by this checkout`);
  if (!Number.isSafeInteger(manifest.dataEpoch) || manifest.dataEpoch < 0) throw new Error("Backup manifest has no valid data epoch");
  const listed = new Map(manifest.members.map((m) => [m.path, m]));
  if (listed.size !== seen.size) throw new Error(`Backup holds ${seen.size} files but its manifest lists ${listed.size}`);
  for (const [path, actual] of seen) {
    const expected = listed.get(path);
    if (!expected) throw new Error(`${path} is in the backup but not in its manifest`);
    if (expected.size !== actual.size || expected.sha256 !== actual.sha256) throw new Error(`${path} does not match its checksum`);
  }
}

/** Reads the whole archive and checks every file against the manifest. Writes nothing. */
export async function verifyArchive(file) {
  const seen = new Map();
  let manifest;
  for await (const entry of readTar(file)) {
    if (entry.path === MANIFEST) { manifest = JSON.parse((await collect(entry.chunks)).toString("utf8")); continue; }
    if (!entry.path.startsWith("data/") || !safePath(entry.path)) throw new Error(`Unexpected path ${entry.path} in backup`);
    if (entry.type !== "0") continue;
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of entry.chunks) { hash.update(chunk); size += chunk.length; }
    seen.set(entry.path, { size, sha256: hash.digest("hex") });
  }
  if (!manifest) throw new Error("Backup has no manifest");
  checkManifest(manifest, seen);
  return manifest;
}

/** Whether this checkout can run on the archive's data, and the migrations to run after restoring it. */
export function restorePlan(manifest, contract) {
  if (manifest.dataEpoch > contract.epoch) {
    return { ok: false, reason: `The backup's data is at epoch ${manifest.dataEpoch}, newer than this checkout supports (${contract.epoch}). Check out the release the backup came from, or a later one` };
  }
  const [plan] = planData({ epoch: manifest.dataEpoch, minEpoch: 0, migrations: [] }, [{ name: "this checkout", contract }]);
  if (!plan.safe) return { ok: false, reason: `The backup's data is at epoch ${manifest.dataEpoch}, older than this checkout can read (${contract.minEpoch}). Check out an earlier release, restore, and update from there` };
  return { ok: true, migrations: plan.migrations.map((m) => m.run) };
}

/**
 * The restore steps on a directory: /data inside the helper container, or a temporary directory in tests.
 * `owner` is the uid and gid restored files get, or null to leave them.
 */
export function directoryVolume(dataDir, owner = process.getuid?.() === 0 ? CANON_UID : null) {
  const inspect = async () => {
    const names = existsSync(dataDir) ? await readdir(dataDir) : [];
    return { entries: names.filter((n) => n !== ASIDE), aside: names.includes(ASIDE) };
  };
  return {
    inspect,
    async setAside() {
      const { entries, aside } = await inspect();
      if (aside) throw new Error(`${ASIDE} already exists in the volume, left by a restore that did not finish. Inspect it before you remove it`);
      await mkdir(join(dataDir, ASIDE), { mode: 0o700 });
      await writeFile(join(dataDir, ASIDE, ORIGINALS), JSON.stringify(entries));
      for (const name of entries) await rename(join(dataDir, name), join(dataDir, ASIDE, name));
      return { setAside: entries.length };
    },
    async extract(file) {
      const seen = new Map();
      let manifest;
      const dirs = [];
      for await (const entry of readTar(file)) {
        if (entry.path === MANIFEST) { manifest = JSON.parse((await collect(entry.chunks)).toString("utf8")); continue; }
        if (!entry.path.startsWith("data/") || !safePath(entry.path)) throw new Error(`Unexpected path ${entry.path} in backup`);
        const target = join(dataDir, entry.path.slice("data/".length));
        if (entry.type === "5") {
          await mkdir(target, { recursive: true, mode: 0o700 });
          dirs.push([target, entry]);
          continue;
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const hash = createHash("sha256");
        let size = 0;
        const out = await open(target, "wx", 0o600);
        try {
          for await (const chunk of entry.chunks) { hash.update(chunk); size += chunk.length; await out.write(chunk); }
          await out.sync();
        } finally { await out.close(); }
        seen.set(entry.path, { size, sha256: hash.digest("hex") });
        await chmod(target, entry.mode);
        await utimes(target, entry.mtime, entry.mtime);
        if (owner !== null) await chown(target, owner, owner);
      }
      for (const [target, entry] of dirs.reverse()) {
        await chmod(target, entry.mode);
        if (owner !== null) await chown(target, owner, owner);
      }
      if (!manifest) throw new Error("Backup has no manifest");
      checkManifest(manifest, seen);
      return { restored: seen.size };
    },
    async dropAside() {
      await rm(join(dataDir, ASIDE), { recursive: true, force: true });
      return {};
    },
    async putBack() {
      const { entries, aside } = await inspect();
      if (!aside) throw new Error(`No ${ASIDE} to put back`);
      const originals = new Set(JSON.parse(await readFile(join(dataDir, ASIDE, ORIGINALS), "utf8")));
      const moved = new Set((await readdir(join(dataDir, ASIDE))).filter((name) => name !== ORIGINALS));
      // Extraction starts only after every original is set aside, so an original still in place was never moved.
      for (const name of entries) if (moved.has(name) || !originals.has(name)) await rm(join(dataDir, name), { recursive: true, force: true });
      for (const name of moved) await rename(join(dataDir, ASIDE, name), join(dataDir, name));
      await rm(join(dataDir, ASIDE, ORIGINALS));
      await rmdir(join(dataDir, ASIDE));
      return {};
    },
  };
}

/**
 * The volume and the service are passed in so tests can supply a directory and a fake.
 * @param {string} archive
 * @param {{ repo: string, replace?: boolean, log?: (line: string) => void,
 *   volume: { inspect(): Promise<{ entries: string[], aside: boolean }>, setAside(): Promise<unknown>, extract(file: string): Promise<unknown>, dropAside(): Promise<unknown>, putBack(): Promise<unknown> },
 *   service: { stop(): Promise<boolean>, startHealthy(): Promise<boolean> } }} options
 */
export async function restore(archive, { repo, replace = false, log = console.log, volume, service }) {
  const manifest = await verifyArchive(archive);
  log(`Checked ${manifest.members.length} files against the manifest.`);
  const contract = parseContract(readFileSync(join(repo, "scripts/selfhost/data-contract.json"), "utf8"));
  const plan = restorePlan(manifest, contract);
  if (!plan.ok) throw new Error(plan.reason);
  const current = await volume.inspect();
  if (current.aside) throw new Error(`The volume still holds ${ASIDE} from a restore that did not finish. Inspect it before you remove it`);
  if (current.entries.length && !replace) throw new Error("The volume already holds an installation. Pass --replace to set it aside and restore over it");
  const wasRunning = await service.stop();
  try {
    await volume.setAside();
    await volume.extract(archive);
    if (!await service.startHealthy()) throw new Error("The restored installation did not become healthy");
  } catch (error) {
    log(`${error.message}. Putting the previous state back.`);
    await service.stop();
    await volume.putBack();
    if (wasRunning) log(await service.startHealthy() ? "The previous installation is back and healthy." : "The previous state is back, but Canon did not become healthy. Check docker compose logs canoncrm.");
    else log("The previous state is back. Canon was stopped before the restore and is still stopped.");
    throw error;
  }
  await volume.dropAside();
  mkdirSync(join(repo, ".canon"), { recursive: true, mode: 0o700 });
  writeFileSync(join(repo, ".canon/data-epoch"), `${manifest.dataEpoch}\n`);
  return { manifest, migrations: plan.migrations };
}

const docker = (args, options = {}) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function compose(repo, service = "canoncrm") {
  const run = (...args) => docker(["compose", ...args], { cwd: repo });
  const config = JSON.parse(run("config", "--format", "json"));
  const volume = config.volumes?.data?.name;
  const image = run("config", "--images").split("\n").find(Boolean);
  if (!volume || !image) throw new Error("docker compose config has no data volume or image. Run this from the Canon checkout");
  const container = () => run("ps", "-a", "-q", service) || null;
  const running = (id) => id !== null && docker(["inspect", "--format", "{{.State.Running}}", id]) === "true";
  const helper = (op, mounts, ...args) => {
    const result = spawnSync("docker", ["run", "--rm", "--network", "none", "--user", "0", "--entrypoint", "node",
      "-v", `${volume}:/data`, "-v", `${dirname(fileURLToPath(import.meta.url))}:/canon-tools:ro`, ...mounts.flatMap((m) => ["-v", m]),
      image, "/canon-tools/backup.mjs", "--inside", op, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
    if (result.status !== 0) throw new Error(result.stderr.trim().split("\n").at(-1) || `Volume step ${op} failed`);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };
  return {
    volume, image, container, running,
    helper,
    stop: async () => { const id = container(); const was = running(id); if (was) run("stop", "--timeout", "40", service); return was; },
    create: () => run("up", "--no-start", service),
    startHealthy: async (timeoutMs = 600_000) => {
      run("up", "-d", service);
      const id = container();
      const inspect = () => JSON.parse(docker(["inspect", "--format", "{{json .}}", id]));
      const restarts = inspect().RestartCount;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { State: state, RestartCount: count } = inspect();
        // The restart policy brings a crashed container back up, so a restart counts as a failed start.
        if (!state.Running || count !== restarts) return false;
        if (state.Health?.Status === "healthy") return true;
        await delay(1000);
      }
      return false;
    },
  };
}

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8" }).trim();
}

function dataEpoch(repo) {
  const file = join(repo, ".canon/data-epoch");
  if (existsSync(file)) {
    const epoch = Number(readFileSync(file, "utf8").trim());
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Invalid .canon/data-epoch");
    return epoch;
  }
  return parseContract(readFileSync(join(repo, "scripts/selfhost/data-contract.json"), "utf8")).epoch;
}

function outsideRepo(repo, dir) {
  const rel = relative(repo, dir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error("Keep backups outside the checkout. `docker compose build` copies the checkout into the image, and a backup holds the install's credentials");
  }
}

/** Stops the container, archives the volume, then starts it again and waits until it is healthy. */
export async function backup({ repo = repoRoot(), out = resolve(repo, "../canon-backups"), log = console.log } = {}) {
  outsideRepo(repo, out);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const stack = compose(repo);
  if (!docker(["volume", "ls", "-q", "--filter", `name=^${stack.volume}$`])) throw new Error(`No ${stack.volume} volume to back up`);
  const meta = {
    app: { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), image: docker(["image", "inspect", "--format", "{{.Id}}", stack.image]) },
    dataEpoch: dataEpoch(repo),
    recordServiceContract: docker(["run", "--rm", "--network", "none", "--entrypoint", "sed", stack.image, "-n", 's/^export const CONTRACT_VERSION = "\\([0-9.]*\\)".*/\\1/p', "/app/services/record-service/src/contract.ts"]),
  };
  const name = `canon-backup-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.tar.gz`;
  const started = performance.now();
  const wasRunning = await stack.stop();
  const stopped = performance.now();
  let archived = stopped;
  let healthy = true;
  try {
    stack.helper("pack", [`${out}:/backup`], `/backup/${name}`, JSON.stringify(meta), String(process.getuid?.() ?? ""), String(process.getgid?.() ?? ""));
    archived = performance.now();
  } finally {
    if (wasRunning) { log("Starting Canon again."); healthy = await stack.startHealthy(); }
  }
  const done = performance.now();
  const file = join(out, name);
  if (!healthy) throw new Error(`Backup written to ${file}, but Canon did not become healthy after restarting. Check docker compose logs canoncrm`);
  const manifest = await verifyArchive(file);
  const seconds = (a, b) => Number(((b - a) / 1000).toFixed(1));
  return {
    archive: file, files: manifest.members.length, bytes: statSync(file).size, dataEpoch: manifest.dataEpoch,
    stopSeconds: seconds(started, stopped), archiveSeconds: seconds(stopped, archived), downtimeSeconds: wasRunning ? seconds(started, done) : 0,
    verifySeconds: seconds(done, performance.now()),
  };
}

export async function restoreCompose(archive, { repo = repoRoot(), replace = false, log = console.log } = {}) {
  const file = resolve(archive);
  const stack = compose(repo);
  if (!docker(["image", "ls", "-q", stack.image])) throw new Error(`Image ${stack.image} not found. Run docker compose build first`);
  if (!stack.container()) stack.create();
  const mount = [`${dirname(file)}:/backup:ro`];
  const volume = {
    inspect: async () => stack.helper("inspect", []),
    setAside: async () => stack.helper("set-aside", []),
    extract: async () => stack.helper("extract", mount, `/backup/${basename(file)}`),
    dropAside: async () => stack.helper("drop-aside", []),
    putBack: async () => stack.helper("put-back", []),
  };
  return restore(file, { repo, replace, log, volume, service: stack });
}

async function inside(op, args) {
  if (op === "pack") {
    const [file, meta, uid, gid] = args;
    const manifest = await pack("/data", file, JSON.parse(meta));
    if (uid && gid) await chown(file, Number(uid), Number(gid));
    return manifest;
  }
  const volume = directoryVolume("/data");
  const step = { inspect: volume.inspect, "set-aside": volume.setAside, extract: () => volume.extract(args[0]), "drop-aside": volume.dropAside, "put-back": volume.putBack }[op];
  if (!step) throw new Error(`Unknown volume step ${op}`);
  return step();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const usage = "Usage: node scripts/selfhost/backup.mjs [--out <dir>] | --verify <archive> | --restore <archive> [--replace]";
  try {
    if (args[0] === "--inside") console.log(JSON.stringify(await inside(args[1], args.slice(2))));
    else if (args.includes("--verify")) {
      const file = value("--verify");
      if (!file || args.length !== 2) throw new Error(usage);
      const manifest = await verifyArchive(file);
      const plan = restorePlan(manifest, parseContract(readFileSync(join(repoRoot(), "scripts/selfhost/data-contract.json"), "utf8")));
      const bytes = manifest.members.reduce((sum, m) => sum + m.size, 0);
      console.log(`OK ${file}: ${manifest.members.length} files, ${bytes} bytes, taken ${manifest.createdAt} at commit ${manifest.app.commit.slice(0, 12)}, data epoch ${manifest.dataEpoch}.`);
      console.log(plan.ok ? `This checkout can restore it${plan.migrations.length ? `, then run: ${plan.migrations.join(", ")}` : ""}.` : `This checkout cannot restore it. ${plan.reason}.`);
    } else if (args.includes("--restore")) {
      const file = value("--restore");
      if (!file || args.some((arg, i) => !["--restore", "--replace"].includes(arg) && i !== args.indexOf("--restore") + 1)) throw new Error(usage);
      const { manifest, migrations } = await restoreCompose(file, { replace: args.includes("--replace") });
      console.log(`Restored ${manifest.members.length} files from ${manifest.createdAt}. Canon is healthy.${migrations.length ? ` Run these migrations next: ${migrations.join(", ")}.` : ""}`);
    } else {
      if (args.some((arg, i) => arg !== "--out" && i !== args.indexOf("--out") + 1) || (args.includes("--out") && !value("--out"))) throw new Error(usage);
      const result = await backup({ out: value("--out") ? resolve(value("--out")) : undefined });
      console.log(`Wrote ${result.archive} (${result.files} files, ${result.bytes} bytes). Canon was down for ${result.downtimeSeconds}s, ${result.archiveSeconds}s of it archiving.`);
      console.log(`Check it with: node scripts/selfhost/backup.mjs --verify ${result.archive}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
