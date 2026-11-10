import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConvexError } from "convex/values";
import { buildPackage } from "../scripts/recipe-package.ts";
import { commitOf, githubFixture, type Tags } from "../scripts/recipe-github-fixture.ts";
import { appJwt } from "../convex/lib/githubApp.ts";
import { runPlays } from "../convex/lib/recipeRuntime.ts";
import { packageRecipe } from "../convex/lib/recipes.ts";
import { RECIPES, contributionsOf, refOf, type AnyDescriptor } from "../recipes/index.ts";
import { MODEL_POINTS } from "../recipes/models.ts";
import { fromManifest, parseManifest, toManifest, type Manifest } from "../recipes/manifest.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { upgradeDiff, upgradedOverrides } from "../recipes/upgrade.ts";
import { handle, type Loader } from "../services/recipe-runtime/src/index.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const velocity = buildPackage("recipes/fsgtm-velocity-deal");
/** The path an error names: what it refuses, without pinning how it says so. */
const refused = (errors: string[]) => errors.map((e) => e.split(" ")[0]);
/** A value from the loaded modules' realm, comparable with deepStrictEqual. */
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
const files = (dir: string, f: Record<string, string>) => Object.fromEntries(Object.entries(f).map(([k, v]) => [`${dir}/${k}`, v]));
const importCode = (code: string) => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Promise<{ run: (s: unknown, c: unknown) => unknown }>;
const loader: Loader = { get: (_id, code) => ({ getEntrypoint: () => ({ run: async (s, c) => (await importCode((await code()).modules["recipe.js"])).run(s, c) as unknown[] }) }) };

/** Route fetch to the recipe runtime and a GitHub fixture, with `env` set, until the test ends. */
function stubNetwork(t: { after: (fn: () => void) => void }, github: (url: string, init?: RequestInit) => Response, env: Record<string, string>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => String(url).startsWith("https://runtime.test")
    ? handle(new Request(url, init), { LOADER: loader, RECIPE_RUNTIME_SECRET: "test-secret" })
    : github(String(url), init)) as typeof fetch;
  const all = { RECIPE_RUNTIME_URL: "https://runtime.test", RECIPE_RUNTIME_SECRET: "test-secret", RECIPE_GITHUB_API_BASE: "https://gh.test/api", RECIPE_GITHUB_RAW_BASE: "https://gh.test/raw", RECIPE_GITHUB_WEB_BASE: "https://gh.test/web", ...env };
  Object.assign(process.env, all);
  t.after(() => {
    globalThis.fetch = real;
    for (const k of Object.keys(all)) delete process.env[k];
  });
}

test("a package's manifest is checked strictly, and a preview pins the commit its ref names and runs its evals in the runtime", async (t) => {
  const built = await velocity;
  const bad = JSON.parse(JSON.stringify(built.manifest)) as Manifest & { dealPage: unknown[]; data: { people: { fields: Array<{ question: unknown }> } } };
  bad.data.people.fields[1].question = { setting: "noSuchSetting" };
  bad.dealPage.push({ component: "iframe" });
  (bad.defaults as Record<string, unknown>).pitchPhrases = "(demo+)+";
  const out = parseManifest(bad);
  assert.equal(out.ok, false);
  assert.deepEqual(refused(out.ok ? [] : out.errors), ["dealPage[14].component"], "shape errors come first");
  bad.dealPage.pop();
  const cross = parseManifest(bad);
  assert.deepEqual(refused(cross.ok ? [] : cross.errors), ["defaults.pitchPhrases", "data.people.fields.1.question"]);

  const canon = RECIPES["canon-base"];
  const withModels = (tables: Record<string, Record<string, unknown>>) => {
    const points = Object.keys(tables);
    const keys = new Set(points.flatMap((p) => Object.keys(MODEL_POINTS[p as keyof typeof MODEL_POINTS].settings)));
    const schema = canon.settingsSchema.filter((d) => keys.has(d.key));
    const m: Manifest = plain(built.manifest);
    return parseManifest({
      ...m, permissions: { ...m.permissions, slots: [...m.permissions.slots.filter((p: string) => !points.includes(p)), ...points] },
      settingsSchema: [...m.settingsSchema.filter((d) => !keys.has(d.key)), ...schema], defaults: { ...m.defaults, ...Object.fromEntries(schema.map((d) => [d.key, canon.settings[d.key]])) },
      models: Object.fromEntries(points.map((p) => [p, { tables: tables[p] }])),
    });
  };
  const copied = { "health.model": canon.models["health.model"]!.tables, "scoring.lead": canon.models["scoring.lead"]!.tables };
  assert.equal(withModels(copied).ok, true, "a package can copy Canon's health and lead models");
  const torn = withModels({ "health.model": { "canon.health": [{}] }, "scoring.lead": { "canon.leadRules": [{ field: "title", operator: "contains" }] } });
  assert.deepEqual([...new Set(refused(torn.ok ? [] : torn.errors))], ["models.health.model:", "models.scoring.lead:"], "a row missing cells is refused, not thrown");
  const nullField = parseManifest({ ...plain(built.manifest), fields: [null, ...built.manifest.fields!] });
  assert.deepEqual(refused(nullField.ok ? [] : nullField.errors), ["fields[0]:"], "a field that isn't one is refused, not thrown");

  const tags: Tags = {
    "v1.0.0": files("velocity-deal", built.files),
    "v9.0.0": files("velocity-deal", { ...built.files, "dist/customization.js": "x".repeat(1024 * 1024 + 1) }),
  };
  stubNetwork(t, githubFixture("fullstackgtm/canon-recipes", () => tags), {});

  const user = { _id: "user", orgId: "org", role: "admin" };
  const loaded = loadConvex(["recipes.ts"], { "lib.ts": (r) => ({ ...r, getCurrentUser: async () => user, requireUser: async () => user, agentClientOf: async () => null }) });
  const db = memoryDb({ organizations: [{ _id: "org" }], users: [user] });
  const fn = loaded["recipes.ts"];
  const act = { runQuery: (ref: unknown, args: unknown) => fn[String(ref).split(".").pop()!].handler({ db }, args) };

  const preview = await fn.previewInstall.handler(act, { source: "github:fullstackgtm/canon-recipes/velocity-deal@v1.0.0" });
  assert.deepEqual(plain({ id: preview.id, version: preview.version, pinned: preview.pinned, bundleHash: preview.bundleHash }), {
    id: "@fsgtm/velocity-deal", version: built.manifest.version, bundleHash: built.hash,
    pinned: { kind: "github-public", owner: "fullstackgtm", repo: "canon-recipes", path: "velocity-deal", ref: "v1.0.0", sha: commitOf(tags["v1.0.0"]) },
  });
  assert.deepEqual(plain(preview.evals.map((e: { name: string; ok: boolean }) => [e.name, e.ok])), built.manifest.evals.map((e) => [e.name, true]));
  await assert.rejects(fn.previewInstall.handler(act, { source: "github:fullstackgtm/canon-recipes/velocity-deal@v9.0.0" }), /dist\/customization\.js is larger/);

  const source = { ...preview.pinned };
  await db.insert("recipePackages", { orgId: "org", recipeId: preview.id, source, version: "1.0.0", manifest: JSON.stringify(built.manifest), bundleHash: built.hash, bundleStorageId: "bundle", installedBy: "user", installedAt: 1, status: "installed" });
  await db.insert("recipeRevisions", { orgId: "org", recipeId: preview.id, revision: 1, settings: { emailMaxWords: 75 }, parent: null, author: { kind: "user", id: "user" }, status: "current", createdAt: 1 });
  const apply = (fromSha: string, fromRevision: number | null) => fn.applyUpgrade.handler({ db, storage: { delete: async () => {} } }, {
    recipeId: preview.id, source, version: "1.0.1", manifest: JSON.stringify({ ...built.manifest, version: "1.0.1" }), bundleHash: built.hash, storageId: "next", choices: {}, fromSha, fromRevision,
  });
  await assert.rejects(apply(source.sha, null), /changed since you checked/, "settings saved after the check");
  await assert.rejects(apply("another-commit", 1), /changed since you checked/, "a package installed after the check");
  assert.equal(db.rows("recipePackages")[0].version, "1.0.0", "nothing written");
});

test("a recipe's markdown and its TypeScript use exactly the same names, checked when it's packaged and again when it's installed", async (t) => {
  const markdown = readFileSync("recipes/fsgtm-velocity-deal/recipe.md", "utf8")
    .replace("keeper: rule canon.keeper", "keeper: rule keeper")
    .replace("stage: viewModel canon.stage", "stage: viewModel stage")
    .replace("people.capability.clean: parse canon.capabilities", "people.capability.clean: parse capabilities")
    .replace("drafts.check: check canon.draftChecks", "drafts.check: check canon.draftChecks, check draft");
  const dir = (ts: string | null, md = markdown) => {
    const d = mkdtempSync(join(tmpdir(), "recipe-"));
    writeFileSync(join(d, "recipe.md"), md);
    if (ts !== null) writeFileSync(join(d, "keeper.ts"), `import { defineRecipe } from ${JSON.stringify(new URL("../recipes/sdk.ts", import.meta.url).pathname)};\nimport { cleanCapabilities, keeperReport, stageOf } from ${JSON.stringify(new URL("../recipes/builtins.ts", import.meta.url).pathname)};\nexport default defineRecipe((canon) => {\n  canon.rule("keeper", (input, s) => keeperReport(input, s as never));\n  canon.viewModel("stage", (input, s) => stageOf(input as never, s as never));\n  canon.parse("capabilities", (raw, ids) => cleanCapabilities(raw, ids));\n  canon.check("draft", () => []);\n${ts}\n});\n`);
    return d;
  };
  const line = markdown.split("\n").findIndex((l) => l === "keeper: rule keeper") + 1;
  await assert.rejects(buildPackage(dir(null)), new RegExp(`recipe\\.md:${line}: error: rule keeper is not registered by the customization's TypeScript`));
  await assert.rejects(buildPackage(dir(`  canon.check("spare", () => []);`)), /the TypeScript registers check spare, which customization\.md never uses/);
  const built = await buildPackage(dir(""));
  assert.deepEqual(Object.keys(built.files), ["customization.md", "dist/customization.js"]);

  const tags: Tags = {
    "v2.1.0": files("velocity-deal", built.files),
    "v2.2.0": files("velocity-deal", { ...built.files, "customization.md": built.markdown.replace(/^version: .*$/m, "version: 9.9.9") }),
    "v2.3.0": files("velocity-deal", { "recipe.md": built.markdown }),
  };
  stubNetwork(t, githubFixture("fullstackgtm/canon-recipes", () => tags), {});
  const user = { _id: "user", orgId: "org", role: "admin" };
  const fn = loadConvex(["recipes.ts"], { "lib.ts": (r) => ({ ...r, getCurrentUser: async () => user, requireUser: async () => user, agentClientOf: async () => null }) })["recipes.ts"];
  const db = memoryDb({ organizations: [{ _id: "org" }], users: [user] });
  const act = { runQuery: (ref: unknown, args: unknown) => fn[String(ref).split(".").pop()!].handler({ db }, args) };
  const preview = (tag: string) => fn.previewInstall.handler(act, { source: `github:fullstackgtm/canon-recipes/velocity-deal@${tag}` });
  const ok = await preview("v2.1.0");
  assert.deepEqual(plain(ok.parts.filter((p: { from: string }) => p.from === "code")), [
    { play: "stage", from: "code", name: "viewModel stage" },
    { play: "keeper", from: "code", name: "rule keeper" },
    { play: "drafts.check", from: "code", name: "check draft" },
    { play: "people.capability.clean", from: "code", name: "parse capabilities" },
  ]);
  assert.equal(ok.evals.every((e: { ok: boolean }) => e.ok), true);
  await assert.rejects(preview("v2.2.0"), /dist\/customization\.js was built from another customization\.md/);
  await assert.rejects(preview("v2.3.0"), /it names code \(viewModel stage, rule keeper, check draft, parse capabilities\) and the package has no dist\/customization\.js/);
});

test("a package's page offers exactly the actions its recipe.md writes, and one stored before recipes placed actions keeps FSGTM's", () => {
  const actionFree = readFileSync("recipes/fsgtm-velocity-deal/recipe.md", "utf8").replace(/```action\n[\s\S]*?```\n/g, "");
  const manifest = toManifest(parseRecipe(actionFree).recipe);
  const runs = (id: string, m: unknown) => packageRecipe({ _id: id, manifest: JSON.stringify(m), bundleHash: "h", source: { sha: "s" } } as never)
    .dealPage.filter((s) => s.component === "summary" || s.component === "queue").map((s) => (s.actions ?? []).map((a) => a.runs));
  assert.deepEqual(runs("new", manifest), [[], []]);
  const stored = { ...manifest, dealPage: manifest.dealPage.map(({ actions: _, ...s }) => s) };
  assert.deepEqual(runs("stored", stored), [["nav.nextDeal"], ["kernel.researchAccount"]]);
});

test("a package stored in format 2 keeps running as stored, and a format 2 recipe.md is refused at install with one line", async () => {
  const markdown = readFileSync("recipes/fsgtm-velocity-deal/recipe.md", "utf8");
  // Stored before fields, templates and models were points: no `fields`, and its people fields inline in its plays data are its fields.
  const { fields: _fields, templates: _templates, models: _models, ...manifest } = toManifest(parseRecipe(markdown).recipe);
  const stored = { ...manifest, engines: { canon: "2" }, permissions: { ...manifest.permissions, slots: ["deal.page"] } };
  const recipe = packageRecipe({ _id: "format-2", manifest: JSON.stringify(stored), bundleHash: "h", source: { sha: "s" } } as never);
  assert.deepEqual(contributionsOf(recipe).map((c) => [c.point, c.key, c.declares === recipe.dealPage]), [
    ["deal.page", "page", true], ["fields", "still_at_company", false], ["fields", "primary_goal", false], ["fields", "responsible_systems", false],
  ]);
  assert.deepEqual(recipe.permissions.slots, ["deal.page"]);

  const format2 = markdown.replace('engines: { canon: "3" }', 'engines: { canon: "2" }').replace(/^contributes: .*$/m, "contributes: deal.page").replace("icps], llm:", "icps], slots: [deal.page], llm:");
  const user = { _id: "user", orgId: "org", role: "admin" };
  const fn = loadConvex(["recipes.ts"], { "lib.ts": (r) => ({ ...r, getCurrentUser: async () => user, requireUser: async () => user, agentClientOf: async () => null }) })["recipes.ts"];
  const db = memoryDb({ organizations: [{ _id: "org" }], users: [user] });
  const act = { runQuery: (ref: unknown, args: unknown) => fn[String(ref).split(".").pop()!].handler({ db }, args) };
  await assert.rejects(fn.previewInstall.handler(act, { markdown: format2 }), (e: Error) => /line 7: written for customization format 2/.test(e.message) && !/; line \d+:/.test(e.message));
});

const int = (key: string, max = 100): AnyDescriptor => ({ key, label: key.toUpperCase(), help: "", group: "g", kind: "int", min: 0, max });

test("an upgrade's three-way diff keeps overrides, takes untouched defaults and asks about each conflict", () => {
  const from = { settingsSchema: ["a", "b", "c", "d", "e", "r"].map((k) => int(k)), settings: { a: 1, b: 1, c: 1, d: 1, e: 1, r: 1 } };
  const to = { settingsSchema: [int("a"), int("b"), int("c"), int("d"), int("e", 10), int("n")], settings: { a: 1, b: 2, c: 1, d: 2, e: 1, n: 7 } };
  const lines = upgradeDiff(from, to, { c: 5, d: 5, e: 50, r: 3 });
  assert.deepEqual(lines, [
    { key: "a", kind: "unchanged", value: 1 },
    { key: "b", kind: "takesDefault", from: 1, to: 2 },
    { key: "c", kind: "keepsOverride", value: 5, default: 1 },
    { key: "d", kind: "conflict", override: 5, from: 1, to: 2 },
    { key: "e", kind: "invalid", dropped: 50, to: 1, reason: "E must now be between 0 and 10" },
    { key: "n", kind: "added", value: 7 },
    { key: "r", kind: "removed", default: 1, dropped: 3 },
  ]);
  assert.deepEqual(upgradedOverrides(lines, {}), { overrides: { c: 5 }, unchosen: ["d"] });
  assert.deepEqual(upgradedOverrides(lines, { d: "keep" }), { overrides: { c: 5, d: 5 }, unchosen: [] });
  assert.deepEqual(upgradedOverrides(lines, { d: "take" }), { overrides: { c: 5 }, unchosen: [] });
});

test("an installed recipe's code never runs in-process: with no runtime, runPlays refuses before loading its bundle", async () => {
  delete process.env.RECIPE_RUNTIME_URL;
  const { manifest, hash } = await velocity;
  const loads: string[] = [];
  const ctx = { storage: { get: async (id: string) => { loads.push(id); return null; } } } as never;
  const ref = refOf(fromManifest(manifest), manifest.defaults, { hash, storageId: "stored-bundle" });
  await assert.rejects(runPlays(ctx, ref, [{ fn: "stage", input: [{ probability: 0.5, members: [] }] }]), (e) => e instanceof ConvexError && /only in the customization runtime/.test(String(e.data)));
  assert.deepEqual(loads, []);
});

test("the GitHub App's JWT is RS256 from GitHub's PKCS#1 key, issued 60 s back and expiring within 10 minutes", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const now = 1_760_000_000_000;
  const jwt = await appJwt("123456", privateKey.replace(/\n/g, "\\n"), now);
  const [header, payload, signature] = jwt.split(".");
  assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")), "signature verifies with the public key");
  const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
  assert.deepEqual(json(header), { alg: "RS256", typ: "JWT" });
  const claims = json(payload);
  assert.deepEqual({ iss: claims.iss, iat: claims.iat }, { iss: "123456", iat: now / 1000 - 60 });
  assert.ok(claims.exp > now / 1000 && claims.exp - claims.iat <= 600);
});

test("a workspace reads a private repo only through its own GitHub connection and only the repos it covers, and a lost one says to reconnect", async (t) => {
  const built = await velocity;
  const calls: string[] = [];
  stubNetwork(t, (url) => { calls.push(new URL(url).pathname); return new Response("Not Found", { status: 404 }); }, {
    GITHUB_RECIPES_APP_ID: "123", GITHUB_RECIPES_APP_SLUG: "canon-recipes",
    GITHUB_RECIPES_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey,
  });
  const admin = { _id: "admin", orgId: "org", role: "admin" };
  const loaded = loadConvex(["recipes.ts"], { "lib.ts": (r) => ({ ...r, getCurrentUser: async () => admin, requireUser: async () => admin, agentClientOf: async () => null }) });
  const db = memoryDb({ organizations: [{ _id: "org" }, { _id: "other" }], users: [admin] });
  const fn = loaded["recipes.ts"];
  const act = { runQuery: (ref: unknown, args: unknown) => fn[String(ref).split(".").pop()!].handler({ db }, args) };
  await db.insert("githubRecipeConnections", { orgId: "other", installationId: 77, account: { login: "acme-agency", type: "Organization" }, repos: ["acme-agency/private-recipes"], connectedBy: "someone", connectedAt: 1, status: "connected" });

  await assert.rejects(fn.previewInstall.handler(act, { source: "github:acme-agency/private-recipes/velocity-deal@v1.0.0" }), /wasn't found/);
  assert.ok(!calls.some((p) => p.startsWith("/api/app/")), "no token minted through another workspace's installation");

  const source = { kind: "github-app", installationId: 77, owner: "acme-agency", repo: "private-recipes", path: "velocity-deal", ref: "v1.0.0", sha: "a".repeat(40) };
  await db.insert("recipePackages", { orgId: "org", recipeId: "@fsgtm/velocity-deal", source, version: "1.0.0", manifest: JSON.stringify(built.manifest), bundleHash: built.hash, bundleStorageId: "bundle", installedBy: "admin", installedAt: 1, status: "installed" });
  calls.length = 0;
  await assert.rejects(fn.checkUpgrade.handler(act, { recipeId: "@fsgtm/velocity-deal" }), /reconnect GitHub/, "an installation this workspace never connected");
  assert.deepEqual(calls, []);
  const own = await db.insert("githubRecipeConnections", { orgId: "org", installationId: 77, account: { login: "acme-agency", type: "Organization" }, repos: ["acme-agency/handbook"], connectedBy: "admin", connectedAt: 2, status: "connected" });
  await assert.rejects(fn.checkUpgrade.handler(act, { recipeId: "@fsgtm/velocity-deal" }), /reconnect GitHub/, "a repo the person who connected it couldn't see");
  assert.deepEqual(calls, [], "no token minted for a repo outside the connection");
  await db.patch(own, { repos: ["acme-agency/handbook", "Acme-Agency/Private-Recipes"] });
  await assert.rejects(fn.checkUpgrade.handler(act, { recipeId: "@fsgtm/velocity-deal" }), /reconnect GitHub/, "GitHub no longer has the installation");
  assert.deepEqual(calls, ["/api/app/installations/77/access_tokens"]);
});

test("a package stored before its recipe said the research cadences, limits and answer fields runs FSGTM's until it upgrades", () => {
  const { recipe } = parseRecipe(readFileSync("recipes/fsgtm-velocity-deal/recipe.md", "utf8"));
  const stored = JSON.parse(JSON.stringify(toManifest(recipe))) as { data: Record<string, Record<string, unknown>> };
  for (const k of ["facts", "touches", "firstTouch", "output", "review"]) delete stored.data.drafts[k];
  for (const k of ["everyDays", "buyers", "fit"]) delete stored.data.people[k];
  delete stored.data.research;
  const plays = refOf(fromManifest(stored as unknown as Manifest)).plays!;
  const fsgtm = refOf(RECIPES["fsgtm-enterprise-deal"]).plays!;
  assert.deepEqual([plays.drafts.facts, plays.drafts.touches, plays.drafts.firstTouch, plays.research, plays.people.everyDays, plays.people.buyers], [8, 6, ["email", "linkedin"], fsgtm.research, 7, 10]);
  assert.deepEqual([plays.drafts.output, plays.drafts.review, plays.people.fit], [fsgtm.drafts.output, fsgtm.drafts.review, fsgtm.people.fit]);
  assert.equal(plays.quietDays, 5);
});

test("a package with neither customization.md nor recipe.md refuses only once the bundle's fetch has settled, so none is left running", async (t) => {
  let bundleSettled = false;
  const slowBundle = () => new Promise<Response>((done) => setTimeout(() => { bundleSettled = true; done(new Response("Not Found", { status: 404 })); }, 20));
  stubNetwork(t, ((url: string) => (/\/(recipe|customization)\.md$/.test(url) ? new Response("Not Found", { status: 404 }) : slowBundle())) as never, {});
  const { openSource } = loadConvex(["lib/recipeSources.ts"])["lib/recipeSources.ts"] as unknown as { openSource: (s: unknown, c: unknown[]) => Promise<{ fetchPackage: (sha: string) => Promise<unknown> }> };
  const reader = await openSource({ kind: "github-public", owner: "fullstackgtm", repo: "canon-recipes", path: "velocity-deal", ref: "v2.0.0" }, []);
  await assert.rejects(reader.fetchPackage("a".repeat(40)), /customization\.md wasn't found/);
  assert.equal(bundleSettled, true);
});
