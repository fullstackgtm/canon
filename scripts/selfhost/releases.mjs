// Lists Canon releases this checkout can upgrade to, counting only release tags
// signed with the pinned release key. See docs/updating.md.
//
//   node scripts/selfhost/releases.mjs [--remote <name>] [--no-fetch] [--json] [--mark-data-current]
//
// Releases are tags named release/<date> on the public repository. They are
// fetched to refs/canon/releases/* so they never clash with local tags. The
// first run pins scripts/selfhost/release-signers to .canon/release-signers.
// After that the pinned copy decides. A later change to the repository's copy
// is reported and not trusted, so a compromised repository or a merge cannot
// swap the key. Node built-ins and git only.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_SIGNERS = "scripts/selfhost/release-signers";
const PINNED_SIGNERS = ".canon/release-signers";

const DATA_CONTRACT = "scripts/selfhost/data-contract.json";

// What a commit says about stored data. A commit from before contracts existed is epoch 0.
/** @returns {{ epoch: number, minEpoch: number, migrations: { epoch: number, run: string }[], bridge?: string }} */
export function parseContract(text, label = DATA_CONTRACT) {
  if (text === null) return { epoch: 0, minEpoch: 0, migrations: [] };
  const value = JSON.parse(text);
  const whole = (n) => Number.isSafeInteger(n) && n >= 0;
  const valid = whole(value.epoch) && whole(value.minEpoch) && value.minEpoch <= value.epoch && Array.isArray(value.migrations)
    && value.migrations.every((m) => whole(m.epoch) && m.epoch <= value.epoch && typeof m.run === "string" && m.run)
    && (value.bridge === undefined || /^release\/\d{4}-\d{2}-\d{2}$/.test(value.bridge));
  if (!valid) throw new Error(`Invalid data contract in ${label}`);
  return value;
}

// Oldest release first. A release is safe only if the installed data epoch is one it can upgrade from.
/**
 * @template {{ name: string, contract: ReturnType<typeof parseContract> }} R
 * @param {ReturnType<typeof parseContract>} installed
 * @param {R[]} available
 */
export function planData(installed, available) {
  return available.map((release, index) => {
    const safe = release.contract.minEpoch <= installed.epoch;
    const requiresFirst = safe ? null : available.slice(0, index).filter((r) => r.contract.minEpoch <= installed.epoch && r.contract.epoch >= release.contract.minEpoch).at(0)?.name ?? "an earlier release that is no longer listed";
    const migrations = release.contract.migrations.filter((m) => m.epoch > installed.epoch).sort((a, b) => a.epoch - b.epoch);
    return { ...release, safe, requiresFirst, migrations };
  });
}

const DATA_EPOCH = ".canon/data-epoch";

// The epoch the stored data has reached. A merge moves HEAD before migrations run, so
// HEAD is trusted only on the first run; after that only --mark-data-current moves this.
function installedEpoch(repo, head, mark) {
  const file = join(repo, DATA_EPOCH);
  if (mark || !existsSync(file)) {
    mkdirSync(join(repo, ".canon"), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${head.epoch}\n`);
  }
  const epoch = Number(readFileSync(file, "utf8").trim());
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`Invalid ${DATA_EPOCH}`);
  return { ...head, epoch };
}

const keys = (text) => text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));

export function pinSigners(repo) {
  const source = join(repo, REPO_SIGNERS);
  const pinned = join(repo, PINNED_SIGNERS);
  const repoKeys = existsSync(source) ? keys(readFileSync(source, "utf8")) : [];
  if (!existsSync(pinned)) {
    if (!repoKeys.length) return { file: null, pinnedNow: false, repoChanged: false };
    mkdirSync(join(repo, ".canon"), { recursive: true, mode: 0o700 });
    copyFileSync(source, pinned);
    return { file: pinned, pinnedNow: true, repoChanged: false };
  }
  const pinnedKeys = keys(readFileSync(pinned, "utf8"));
  return { file: pinnedKeys.length ? pinned : null, pinnedNow: false, repoChanged: repoKeys.join("\n") !== pinnedKeys.join("\n") };
}

export function listReleases(repo, { remote, fetch = true, markDataCurrent = false } = {}) {
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remotes = git(["remote"]).split("\n").filter(Boolean);
  const from = remote ?? (remotes.includes("upstream") ? "upstream" : remotes.includes("origin") ? "origin" : undefined);
  if (fetch) {
    if (!from) throw new Error("This checkout has no upstream or origin remote to fetch releases from");
    git(["fetch", "--quiet", "--no-tags", from, "+refs/tags/release/*:refs/canon/releases/*"]);
  }
  const signers = pinSigners(repo);
  const contractAt = (rev) => {
    const shown = spawnSync("git", ["show", `${rev}:${DATA_CONTRACT}`], { cwd: repo, encoding: "utf8" });
    return parseContract(shown.status === 0 ? shown.stdout : null, `${rev}:${DATA_CONTRACT}`);
  };
  const head = git(["rev-parse", "HEAD"]);
  const refs = git(["for-each-ref", "--format=%(refname)", "refs/canon/releases/"]).split("\n").filter(Boolean).sort();
  const releases = [];
  let unverified = 0;
  for (const ref of refs) {
    const name = ref.slice("refs/canon/releases/".length);
    const verified = signers.file !== null && spawnSync("git", ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${signers.file}`, "verify-tag", ref], { cwd: repo, stdio: "ignore" }).status === 0;
    if (!verified) { unverified++; continue; }
    const commit = git(["rev-parse", `${ref}^{commit}`]);
    const installed = spawnSync("git", ["merge-base", "--is-ancestor", commit, head], { cwd: repo, stdio: "ignore" }).status === 0;
    const notes = git(["for-each-ref", "--format=%(contents)", ref]).replace(/-----BEGIN SSH SIGNATURE-----[\s\S]*$/, "").trim();
    releases.push({ name: `release/${name}`, commit, installed, notes, contract: contractAt(commit) });
  }
  const data = installedEpoch(repo, contractAt(head), markDataCurrent);
  const available = planData(data, releases.filter((release) => !release.installed));
  const nextSafe = available.filter((release) => release.safe).at(-1)?.name ?? null;
  return { remote: from, head, signers, releases, available, data, nextSafe, newest: releases.at(-1)?.name ?? null, unverified };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const remoteAt = args.indexOf("--remote");
  const known = new Set(["--no-fetch", "--json", "--remote", "--mark-data-current"]);
  if (args.some((arg, i) => !known.has(arg) && i !== remoteAt + 1) || (remoteAt >= 0 && !args[remoteAt + 1])) {
    console.error("Usage: node scripts/selfhost/releases.mjs [--remote <name>] [--no-fetch] [--json] [--mark-data-current]");
    process.exitCode = 1;
  } else {
    try {
      const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
      const result = listReleases(repo, { remote: remoteAt >= 0 ? args[remoteAt + 1] : undefined, fetch: !args.includes("--no-fetch"), markDataCurrent: args.includes("--mark-data-current") });
      if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
      else {
        if (!result.signers.file) console.log(`No release key is pinned and ${REPO_SIGNERS} has none, so no release can be verified.`);
        if (result.signers.pinnedNow) console.log(`Pinned the release key from ${REPO_SIGNERS} to ${PINNED_SIGNERS}.`);
        if (result.signers.repoChanged) console.log(`${REPO_SIGNERS} no longer matches the pinned key. Still using ${PINNED_SIGNERS}. Replace it only after confirming the new key with the publisher.`);
        console.log(`Running ${result.head.slice(0, 12)}. Newest verified release: ${result.newest ?? "none"}.`);
        if (result.unverified) console.log(`Ignored ${result.unverified} release tag(s) without a valid signature from the pinned key.`);
        if (!result.available.length) console.log("No newer verified release.");
        for (const release of result.available) console.log(`\n${release.name} (${release.commit.slice(0, 12)})${release.safe ? "" : ` NOT SAFE YET: take ${release.requiresFirst} first`}${release.migrations.length ? `\nMigrations, in order: ${release.migrations.map((m) => m.run).join(", ")}` : ""}${release.notes ? `\n${release.notes}` : ""}`);
        if (result.available.length) console.log(`\nNewest release safe for this data: ${result.nextSafe ?? "none"}.`);
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
