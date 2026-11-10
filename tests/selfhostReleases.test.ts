import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listReleases, parseContract, planData } from "../scripts/selfhost/releases.mjs";

const hasSshKeygen = spawnSync("ssh-keygen", ["-?"], { stdio: "ignore" }).error === undefined;

test("only release tags signed with the pinned key count, and a changed repository key is not trusted", { skip: !hasSshKeygen && "ssh-keygen is not installed" }, () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "selfhost-releases-test-")));
  try {
    for (const name of ["publisher", "intruder"]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", join(temp, name)]);
    const signer = (name: string) => `${name}@example.com namespaces="git" ${readFileSync(join(temp, `${name}.pub`), "utf8").trim()}`;
    const upstream = join(temp, "upstream");
    mkdirSync(upstream);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
    git(upstream, "init", "-q", "-b", "main");
    for (const [key, value] of [["commit.gpgsign", "false"], ["user.name", "Publisher"], ["user.email", "publisher@example.com"], ["gpg.format", "ssh"]]) git(upstream, "config", key, value);
    mkdirSync(join(upstream, "scripts/selfhost"), { recursive: true });
    writeFileSync(join(upstream, "scripts/selfhost/release-signers"), `# keys\n${signer("publisher")}\n`);
    git(upstream, "add", ".");
    git(upstream, "commit", "-qm", "First");
    const tag = (name: string, key?: string) => key
      ? git(upstream, "-c", `user.signingkey=${join(temp, key)}`, "tag", "-s", name, "-m", `Changes in ${name}`)
      : git(upstream, "tag", "-a", name, "-m", `Changes in ${name}`);
    tag("release/2026-11-01", "publisher");

    const install = join(temp, "install");
    git(temp, "clone", "-q", upstream, install);
    let result = listReleases(install);
    assert.equal(result.signers.pinnedNow, true);
    assert.equal(result.newest, "release/2026-11-01");
    assert.equal(result.available.length, 0);

    writeFileSync(join(upstream, "app.txt"), "two\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-qm", "Second");
    tag("release/2026-11-02", "publisher");
    tag("release/2026-11-03");
    tag("release/2026-11-04", "intruder");
    result = listReleases(install);
    assert.deepEqual(result.available.map((release) => release.name), ["release/2026-11-02"]);
    assert.equal(result.available[0].notes, "Changes in release/2026-11-02");
    mkdirSync(join(install, "scripts/selfhost"), { recursive: true });
    writeFileSync(join(install, "scripts/selfhost/data-contract.json"), JSON.stringify({ epoch: 4, minEpoch: 0, migrations: [] }));
    git(install, "add", "scripts/selfhost/data-contract.json");
    git(install, "-c", "user.name=A", "-c", "user.email=a@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "Merged, not migrated");
    assert.equal(listReleases(install, { fetch: false }).data.epoch, 0);
    assert.equal(listReleases(install, { fetch: false, markDataCurrent: true }).data.epoch, 4);
    assert.equal(result.unverified, 2);

    writeFileSync(join(install, "scripts/selfhost/release-signers"), `${signer("intruder")}\n`);
    result = listReleases(install, { fetch: false });
    assert.equal(result.signers.repoChanged, true);
    assert.deepEqual(result.available.map((release) => release.name), ["release/2026-11-02"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

const contract = (epoch: number, minEpoch: number, migrations: { epoch: number; run: string }[] = []) => ({ epoch, minEpoch, migrations });

test("a release that narrows data is held until the release carrying its migration is installed", () => {
  const plan = planData(contract(1, 0), [
    { name: "a", contract: contract(2, 0, [{ epoch: 2, run: "migrations:widen" }]) },
    { name: "b", contract: contract(3, 2) },
  ]);
  assert.deepEqual(plan.map((r) => [r.name, r.safe, r.requiresFirst]), [["a", true, null], ["b", false, "a"]]);
  assert.deepEqual(plan[0].migrations.map((m) => m.run), ["migrations:widen"]);
  assert.deepEqual(parseContract(null), contract(0, 0));
  assert.throws(() => parseContract(JSON.stringify(contract(1, 2))), /Invalid data contract/);
});

test("merge preview reports clashes without touching the checkout or running a configured merge driver", () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "merge-preview-test-")));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: temp, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    for (const [key, value] of [["commit.gpgsign", "false"], ["user.name", "A"], ["user.email", "a@example.com"]]) git("config", key, value);
    writeFileSync(join(temp, "app.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "First");
    git("switch", "-qc", "release");
    writeFileSync(join(temp, "app.txt"), "theirs\n");
    git("commit", "-qam", "Release");
    const release = git("rev-parse", "HEAD");
    git("switch", "-q", "main");
    writeFileSync(join(temp, "app.txt"), "mine\n");
    git("commit", "-qam", "Mine");
    const marker = join(temp, "driver-ran");
    git("config", "merge.evil.driver", `touch ${marker}`);
    writeFileSync(join(temp, ".git/info/attributes"), "* merge=evil\n");
    const script = new URL("../scripts/selfhost/merge-preview.sh", import.meta.url).pathname;
    const result = spawnSync("bash", [script, release], { cwd: temp, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /CLASHES/);
    assert.match(result.stdout, /app\.txt/);
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(join(temp, "app.txt"), "utf8"), "mine\n");
    assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "main");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
