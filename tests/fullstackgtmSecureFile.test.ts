import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { platform } from "node:process";
import test from "node:test";
import { getCredential, storeCredential } from "../engine/src/credentials.ts";
import { writeSecureFileAtomic } from "../engine/src/secureFile.ts";

const posix = platform !== "win32";

test("secure file writer rejects a destination symlink without touching its target", { skip: !posix }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-secure-file-"));
  try {
    const victim = join(dir, "victim");
    const destination = join(dir, "credentials.json");
    writeFileSync(victim, "do not replace");
    symlinkSync(victim, destination);
    assert.throws(() => writeSecureFileAtomic(destination, "secret"), /symbolic link/i);
    assert.equal(readFileSync(victim, "utf8"), "do not replace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credential persistence rejects a symlinked managed home", { skip: !posix }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-secure-home-"));
  const previous = process.env.FSGTM_HOME;
  try {
    const victim = join(dir, "victim");
    const linkedHome = join(dir, "home");
    writeFileSync(victim, "sentinel");
    symlinkSync(dir, linkedHome);
    process.env.FSGTM_HOME = linkedHome;
    const now = new Date().toISOString();
    assert.throws(
      () => storeCredential("hubspot", { kind: "private_app", accessToken: "secret", createdAt: now, updatedAt: now }),
      /symbolic link/i,
    );
    assert.equal(readFileSync(victim, "utf8"), "sentinel");
    assert.equal(existsSync(join(dir, "credentials.json")), false);
  } finally {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("credential reads reject a credentials symlink without reading or changing its target", { skip: !posix }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-secure-read-"));
  const previous = process.env.FSGTM_HOME;
  try {
    const victim = join(dir, "victim.json");
    const home = join(dir, "home");
    mkdirSync(home);
    writeFileSync(victim, JSON.stringify({ version: 1, providers: { hubspot: { accessToken: "victim-secret" } } }));
    symlinkSync(victim, join(home, "credentials.json"));
    process.env.FSGTM_HOME = home;

    assert.throws(() => getCredential("hubspot"), /symbolic link/i);
    assert.match(readFileSync(victim, "utf8"), /victim-secret/);
  } finally {
    if (previous === undefined) delete process.env.FSGTM_HOME;
    else process.env.FSGTM_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed replacement leaves no partial file or temporary residue", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-secure-failure-"));
  try {
    const destination = join(dir, "already-a-directory");
    mkdirSync(destination);
    assert.throws(() => writeSecureFileAtomic(destination, "must not survive"));
    assert.deepEqual(readdirSync(dir), ["already-a-directory"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent secure writes publish only complete payloads and clean temporary files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-secure-concurrent-"));
  const destination = join(dir, "state.json");
  const modulePath = resolve(import.meta.dirname, "../engine/src/secureFile.ts");
  const payloads = Array.from({ length: 8 }, (_, index) => JSON.stringify({ index, data: String(index).repeat(16_000) }));
  writeSecureFileAtomic(destination, payloads[0]);

  try {
    const children = payloads.map(
      (payload) =>
        new Promise<void>((resolveChild, rejectChild) => {
          const script = `import { writeSecureFileAtomic } from ${JSON.stringify(modulePath)}; writeSecureFileAtomic(process.argv[1], process.argv[2]);`;
          const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, destination, payload], {
            stdio: "ignore",
          });
          child.once("error", rejectChild);
          child.once("exit", (code) => (code === 0 ? resolveChild() : rejectChild(new Error(`writer exited ${code}`))));
        }),
    );

    while (children.length > 0) {
      const observed = readFileSync(destination, "utf8");
      assert.ok(payloads.includes(observed), "reader must never observe a partial or mixed payload");
      const settled = await Promise.race([
        Promise.all(children).then(() => true),
        new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 2)),
      ]);
      if (settled) break;
    }
    await Promise.all(children);
    assert.ok(payloads.includes(readFileSync(destination, "utf8")));
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp-")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
