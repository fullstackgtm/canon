import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, resolveConfiguredRules, rulePackageTrustFromCli } from "../engine/src/config.ts";
import { createFilePlanStore } from "../engine/src/planStore.ts";
import { ipIsPrivate, publicHttpGet, type PublicLookup, type PublicRequestHop } from "../engine/src/publicHttp.ts";
import { readSecureRegularFile, writeSecureFileAtomic } from "../engine/src/secureFile.ts";
import { auditSnapshot, defaultPolicy, sampleSnapshot } from "../engine/src/index.ts";

const posix = process.platform !== "win32";
const basePlan = auditSnapshot(sampleSnapshot, defaultPolicy("2026-05-03"));

// Fixed-seed generator: reproducible breadth without a fuzz corpus or dependency.
function values(seed: number, count: number): number[] {
  let state = seed >>> 0;
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  });
}

test("plan lifecycle state machine preserves terminal and claim invariants", async () => {
  // 7 seeds: the smallest prefix of this sequence that reaches all three recovery branches (seed % 3).
  const seeds = values(0x46534754, 7);
  assert.deepEqual(new Set(seeds.map((seed) => seed % 3)), new Set([0, 1, 2]));
  for (const seed of seeds) {
    const dir = mkdtempSync(join(tmpdir(), "fsgtm-plan-property-"));
    const store = createFilePlanStore(dir);
    const plan = { ...basePlan, id: `${basePlan.id}-${seed}` };
    try {
      await store.save(plan);
      const operation = plan.operations[seed % plan.operations.length];
      await store.approveOperations(plan.id, [operation.id, operation.id]);
      assert.deepEqual((await store.get(plan.id))?.approvedOperationIds, [operation.id]);

      // Independent store instances model independent CLI processes sharing disk.
      const contenders = Array.from({ length: 8 }, () => createFilePlanStore(dir));
      const outcomes = await Promise.allSettled(contenders.map((candidate) => candidate.claimApply(plan.id, { provider: "mock", source: "cli" })));
      const winners = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof store.claimApply>>> => outcome.status === "fulfilled");
      assert.equal(winners.length, 1, `seed ${seed} must grant exactly one claim`);
      assert.equal((await store.get(plan.id))?.status, "applying");
      await assert.rejects(store.reject(plan.id), /applying/);
      await assert.rejects(store.approveOperations(plan.id, [operation.id]), /frozen/);
      const winner = winners[0].value;
      if (seed % 3 === 0) {
        const aborted = await store.abortApplyPreflight(plan.id, winner.claimId, "deterministic preflight failure");
        assert.equal(aborted.status, "approved");
        const retry = await store.claimApply(plan.id, { provider: "mock", source: "cli" });
        await store.markApplyUncertain(plan.id, retry.claimId);
      } else if (seed % 3 === 1) {
        const uncertain = await store.markApplyUncertain(plan.id, winner.claimId);
        assert.equal(uncertain.applyAttempts?.at(-1)?.status, "uncertain");
      }
      const recovered = await store.recoverApply(plan.id);
      assert.equal(recovered.status, "needs_approval");
      assert.deepEqual(recovered.approvedOperationIds, []);
      await assert.rejects(store.claimApply(plan.id, { provider: "mock", source: "cli" }), /only an approved plan/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("secure atomic writes preserve exact payloads, permissions, and reject symlink components", { skip: !posix }, () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-file-property-"));
  try {
    for (const n of values(0x53414645, 24).map((value) => value % 8193)) {
      const destination = join(dir, `payload-${n}.json`);
      const payload = JSON.stringify({ n, value: "x".repeat(n) });
      writeSecureFileAtomic(destination, payload);
      assert.equal(readFileSync(destination, "utf8"), payload);
      assert.equal(readSecureRegularFile(destination), payload);
      assert.equal(lstatSync(destination).mode & 0o777, 0o600);
    }
    const outside = join(dir, "outside");
    const root = join(dir, "managed");
    mkdirSync(outside);
    mkdirSync(root);
    assert.throws(() => readSecureRegularFile(outside), /non-regular/i);
    writeFileSync(join(outside, "sentinel"), "unchanged");
    for (const depth of [1, 2, 4]) {
      const prefix = join(root, `case-${depth}`);
      mkdirSync(prefix);
      let cursor = prefix;
      for (let index = 1; index < depth; index++) {
        cursor = join(cursor, `level-${index}`);
        mkdirSync(cursor);
      }
      const link = join(cursor, "escape");
      symlinkSync(outside, link);
      assert.throws(() => writeSecureFileAtomic(join(link, "secret"), "leak"), /symbolic link/i);
      assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "unchanged");
    }
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public address classification rejects generated non-global ranges and permits known public addresses", () => {
  const privatePrefixes = ["0", "10", "100.64", "127", "169.254", "172.16", "192.0.0", "192.0.2", "192.168", "198.18", "198.51.100", "203.0.113", "224", "255"];
  for (const [index, prefix] of privatePrefixes.entries()) {
    const components = prefix.split(".");
    const suffix = values(index + 1, 4 - components.length).map((value) => value % 254 + 1);
    const address = [...components, ...suffix].join(".");
    assert.equal(ipIsPrivate(address), true, `${address} is not globally routable`);
  }
  for (const address of ["::127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1"]) {
    assert.equal(ipIsPrivate(address), true, `${address} must not bypass the SSRF guard`);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(ipIsPrivate(address), false, `${address} is a known public address`);
  }
});

test("redirect state machine validates every hop and permanently drops credentials after origin change", async () => {
  const lookup: PublicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const seen: Array<{ host: string; headers: Record<string, string> }> = [];
  const requestHop: PublicRequestHop = async (url, _addresses, headers) => {
    seen.push({ host: url.hostname, headers: { ...headers } });
    if (seen.length < 4) {
      const host = seen.length === 1 ? "b.example" : seen.length === 2 ? "a.example" : "c.example";
      return { status: 302, headers: new Headers({ location: `https://${host}/${seen.length}` }), body: new Uint8Array() };
    }
    return { status: 200, headers: new Headers(), body: new Uint8Array([1]) };
  };
  await publicHttpGet("https://a.example/", {
    lookup, requestHop,
    headers: { Authorization: "secret", Cookie: "secret", "X-Safe": "kept" },
  });
  assert.deepEqual(seen.map(({ host }) => host), ["a.example", "b.example", "a.example", "c.example"]);
  assert.equal(seen[0].headers.Authorization, "secret");
  for (const hop of seen.slice(1)) assert.deepEqual(hop.headers, { "X-Safe": "kept" });
});

test("plugin trust combinations never execute code without explicit config and allow flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fsgtm-plugin-property-"));
  try {
    const sentinel = join(dir, "executed");
    writeFileSync(join(dir, "plugin.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "yes"); export const rules = [];`);
    writeFileSync(join(dir, "fullstackgtm.config.json"), JSON.stringify({ rulePackages: ["./plugin.mjs"] }));
    const loaded = loadConfig("fullstackgtm.config.json", dir)!;

    for (const flags of [[], ["--no-plugins"], ["--allow-plugins", "--no-plugins"]]) {
      rmSync(sentinel, { force: true });
      if (flags.includes("--allow-plugins") && flags.includes("--no-plugins")) {
        assert.throws(() => rulePackageTrustFromCli(flags, loaded.path), /cannot be used together/);
      } else {
        const trust = rulePackageTrustFromCli(flags, loaded.path);
        if (flags.includes("--no-plugins")) await resolveConfiguredRules(loaded, [], trust);
        else await assert.rejects(resolveConfiguredRules(loaded, [], trust), /explicit trust/);
      }
      assert.equal(readFileSync(join(dir, "fullstackgtm.config.json"), "utf8").includes("plugin.mjs"), true);
      assert.throws(() => readFileSync(sentinel), /ENOENT/);
    }

    assert.throws(() => rulePackageTrustFromCli(["--allow-plugins"]), /requires --config/);
    await resolveConfiguredRules(loaded, [], rulePackageTrustFromCli(["--allow-plugins"], loaded.path));
    assert.equal(readFileSync(sentinel, "utf8"), "yes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
