import assert from "node:assert/strict";
import { test } from "node:test";
import { FIRST_PARTY_MARKDOWN, RECIPE_BUNDLES } from "../recipes/_bundles.generated.ts";
import { bundleHash } from "../services/recipe-runtime/src/protocol.ts";
import { readFileSync } from "node:fs";
import { merge3 } from "../recipes/merge.ts";

/** The canon-base version Canon ships, which a copy of it was made from or merges up to. */
const BASE = /^version: (\S+)$/m.exec(FIRST_PARTY_MARKDOWN["canon-base"])![1];
import { handle, type Loader } from "../services/recipe-runtime/src/index.ts";
import { loadConvex, memoryDb } from "./convexHandlers.ts";

const user = { _id: "user", orgId: "org", role: "admin", name: "Riley" };
const mods = loadConvex(["workspaceRecipes.ts", "recipes.ts", "lib/recipes.ts"], {
  "lib.ts": (r) => ({ ...r, getCurrentUser: async () => user, requireUser: async () => user, agentClientOf: async () => null }),
});

/** A workspace with an admin, and an action context that runs the modules' queries and mutations on it. */
function workspace(fn = mods) {
  const db = memoryDb({ organizations: [{ _id: "org", name: "Acme", slug: "acme" }], users: [user] });
  const stored = new Set<string>();
  let blobs = 0;
  const storage = { store: async () => { stored.add(`blob:${++blobs}`); return `blob:${blobs}`; }, delete: async (id: string) => { stored.delete(id); } };
  const scheduled: string[] = [];
  const scheduler = { runAfter: async (_ms: number, ref: unknown) => { scheduled.push(String(ref)); return null; } };
  const mods = fn;
  const fnw = mods["workspaceRecipes.ts"];
  const call = (ref: unknown, args: unknown) => fnw[String(ref).split(".").pop()!].handler({ db, storage, scheduler }, args);
  const ctx = { db, storage, scheduler, runQuery: call, runMutation: call };
  return { db, ctx, stored, scheduled, fn: fnw, recipes: mods["recipes.ts"], lib: mods["lib/recipes.ts"] as unknown as Record<string, (...args: unknown[]) => Promise<any>> };
}

const plain = (x: unknown) => JSON.parse(JSON.stringify(x));
/** A module's plain function, which loadConvex types as a handler. */
const fnOf = (mod: Record<string, unknown>, name: string) => mod[name] as (...args: unknown[]) => Promise<any>;
/** `markdown` with the section headed `title` moved above the one headed `above`, as an editor would. */
function moveAbove(markdown: string, title: string, above: string) {
  const lines = markdown.split("\n");
  const at = (t: string) => lines.findIndex((l) => new RegExp(`^#+ ${t} \\{`).test(l));
  const from = at(title), to = at(above);
  const level = /^#+/.exec(lines[from])![0].length;
  const end = lines.findIndex((l, i) => i > from && new RegExp(`^#{1,${level}} `).test(l));
  return [...lines.slice(0, to), ...lines.slice(from, end), ...lines.slice(to, from), ...lines.slice(end)].join("\n");
}

test("Customize copies a recipe's markdown with its provenance and settings, and keeps a TypeScript bundle by its hash", async () => {
  const w = workspace();
  await w.db.insert("recipeRevisions", { orgId: "org", recipeId: "fsgtm-enterprise-deal", revision: 4, settings: { quietDays: 9 }, parent: null, author: { kind: "user", id: "user" }, status: "current", createdAt: 1 });
  const { recipeId } = await w.fn.customize.handler(w.ctx, { recipeId: "fsgtm-enterprise-deal" });
  assert.equal(recipeId, "@workspace/fsgtm-enterprise-deal");

  const source = FIRST_PARTY_MARKDOWN["fsgtm-enterprise-deal"];
  const [pkg] = w.db.rows("recipePackages");
  assert.deepEqual(plain(pkg.source), {
    kind: "workspace", markdownHash: (w.db.rows("recipeMarkdownRevisions")[0].markdownHash as string), bundle: "kept",
    forkedFrom: { id: "fsgtm-enterprise-deal", version: "1.2.0", markdownHash: await bundleHash(source) },
  });
  assert.equal(pkg.bundleHash, RECIPE_BUNDLES["fsgtm-enterprise-deal"]!.hash, "the copy runs the source's exact bundle");

  const [rev] = w.db.rows("recipeMarkdownRevisions");
  const changed = (rev.markdown as string).split("\n").filter((l, i) => l !== source.split("\n")[i]);
  assert.deepEqual(changed, ['id: "@workspace/fsgtm-enterprise-deal"', `title: "Acme's Enterprise multi-touch deal"`, "author: { org: acme, kind: agency }"]);
  assert.equal(rev.status, "current");
  assert.deepEqual(plain(w.db.rows("recipeRevisions").filter((r) => r.recipeId === recipeId).map((r) => r.settings)), [{ quietDays: 9 }], "the copy starts on the source's settings");

  const again = await w.fn.customize.handler(w.ctx, { recipeId: "fsgtm-enterprise-deal" });
  assert.equal(again.recipeId, "@workspace/fsgtm-enterprise-deal-2");
});

test("a save refuses a stale base, an error at its line and inline TypeScript; a save and a revert each write a revision", async () => {
  const w = workspace();
  const { recipeId } = await w.fn.customize.handler(w.ctx, { recipeId: "canon-base" });
  const open = await w.fn.editor.handler(w.ctx, { recipeId });
  const lineOf = (md: string, text: string) => md.split("\n").findIndex((l) => l.includes(text)) + 1;

  const moved = moveAbove(open.markdown, "Timeline", "Overview");
  await assert.rejects(w.fn.save.handler(w.ctx, { recipeId, markdown: moved, baseRevision: 0 }), /since you opened it/);
  const broken = moved.replace("{section=timeline", "{section=timelime");
  await assert.rejects(w.fn.save.handler(w.ctx, { recipeId, markdown: broken, baseRevision: 1 }), new RegExp(`line ${lineOf(broken, "section=timelime")}:`));
  const coded = `${moved}\n\`\`\`ts\ncanon.check("x", () => []);\n\`\`\`\n`;
  await assert.rejects(w.fn.save.handler(w.ctx, { recipeId, markdown: coded, baseRevision: 1 }), new RegExp(`line ${lineOf(coded, "```ts")}:`));
  assert.equal(w.db.rows("recipeMarkdownRevisions").length, 1, "nothing written");

  const saved = await w.fn.save.handler(w.ctx, { recipeId, markdown: moved, note: "Timeline first", baseRevision: 1 });
  assert.deepEqual(plain(saved), { revision: 2, changed: true, ignoredSettings: [], evals: [], evalsNotRun: null, blocked: false });
  const dealPage = async () => (await w.lib.recipeIn(w.ctx, "org", recipeId)).recipe.dealPage.map((s: { component: string }) => s.component);
  assert.deepEqual(plain((await dealPage()).slice(0, 3)), ["header", "timeline", "fields"]);

  const reverted = await w.fn.revert.handler(w.ctx, { recipeId, revision: 1 });
  assert.equal(reverted.revision, 3);
  const revs = await w.fn.revisions.handler(w.ctx, { recipeId });
  assert.deepEqual(plain(revs.revisions.map((r: { revision: number; status: string; note: string }) => [r.revision, r.status, r.note])), [
    [3, "current", "Reverted to revision 1"], [2, "superseded", "Timeline first"], [1, "superseded", `Customized from Canon defaults v${BASE}`],
  ]);
  assert.equal((await w.fn.markdown.handler(w.ctx, { recipeId })).markdown, open.markdown);
  assert.deepEqual(plain((await dealPage()).slice(0, 3)), ["header", "fields", "fields"]);
  assert.deepEqual([...w.stored], ["blob:3"], "each save's builtins bundle replaced the one before");
});

test("a workspace recipe enabled at the deal page is what enabledFor and orgRecipe run", async () => {
  const w = workspace();
  const { recipeId } = await w.fn.customize.handler(w.ctx, { recipeId: "fsgtm-enterprise-deal" });
  const open = await w.fn.editor.handler(w.ctx, { recipeId });
  await w.fn.save.handler(w.ctx, { recipeId, markdown: moveAbove(open.markdown, "Activity", "Next action"), baseRevision: 1 });
  assert.equal((await w.lib.orgRecipe(w.ctx, "org")).recipe.id, "fsgtm-enterprise-deal", "off until someone picks it");

  await w.recipes.enableContribution.handler(w.ctx, { point: "deal.page", recipeId, key: "page" });
  const [on] = await w.lib.enabledFor(w.ctx, "org", "deal.page");
  assert.equal(on.recipe.id, recipeId);
  const run = await w.lib.orgRecipe(w.ctx, "org");
  const titles = run.recipe.dealPage.map((s: { title: string }) => s.title);
  assert.ok(titles.indexOf("Activity") < titles.indexOf("Next action"));
  assert.deepEqual(plain(run.ref.bundle), { hash: RECIPE_BUNDLES["fsgtm-enterprise-deal"]!.hash, storageId: "blob:1" });
  assert.equal(run.plays?.quietDays, 14);

  // A copy of a version that places its header, products, splits and apps can take them all out; only a copy of an
  // older version, which never named them, has them drawn where they were.
  const frame = await w.recipes.forOrg.handler(w.ctx, {});
  assert.equal(frame.dealPage.oldFrame, false);
  const current = (await w.fn.editor.handler(w.ctx, { recipeId })).markdown as string;
  const bare = current.replace(/### Deal \{section=header\}[\s\S]*?(?=### Queue)/, "").replace(/### Products \{section=products\}[\s\S]*?(?=## Writing a touch)/, "");
  await w.fn.save.handler(w.ctx, { recipeId, markdown: bare, baseRevision: 2 });
  const after = await w.recipes.forOrg.handler(w.ctx, {});
  assert.deepEqual([after.dealPage.oldFrame, after.dealPage.sections.some((s: { component: string }) => ["header", "products", "splits", "apps"].includes(s.component))], [false, false]);
  (w.db.rows("recipePackages")[0].source as { forkedFrom: { version: string } }).forkedFrom.version = "1.1.0";
  assert.equal((await w.recipes.forOrg.handler(w.ctx, {})).dealPage.oldFrame, true);
});

test("merge3 applies a change only one side made, marks a clash, and keeps text both made alike; a merged save records its upstream", async () => {
  const base = "a\nb\nc\nd\ne\nf";
  assert.deepEqual(merge3(base, "a\nB\nc\nd\ne\nf", "a\nb\nc\nd\nE\nf\ng"), { text: "a\nB\nc\nd\nE\nf\ng", conflicts: 0, applied: 2 });
  assert.deepEqual(merge3(base, "a\nb\nC1\nd\ne\nf", "a\nb\nC2\nd\ne\nf", "upstream v2"), { text: "a\nb\n<<<<<<< yours\nC1\n=======\nC2\n>>>>>>> upstream v2\nd\ne\nf", conflicts: 1, applied: 0 });
  assert.deepEqual(merge3(base, "a\nX\nc\nd\ne\nf", "a\nX\nc\nd\ne\nf"), { text: "a\nX\nc\nd\ne\nf", conflicts: 0, applied: 1 });

  // A copy of Canon defaults 1.1.0, before it gained the ICP fit model; Canon now ships a later one.
  const w = workspace();
  const now = FIRST_PARTY_MARKDOWN["canon-base"].split("\n");
  const fit = now.findIndex((l) => l.startsWith("# ICP fit")), next = now.findIndex((l, i) => i > fit && l.startsWith("# "));
  const older = [...now.slice(0, fit), ...now.slice(next)].join("\n").replace(`version: ${BASE}`, "version: 1.1.0").replace(" scoring.fit,", "").replace("lead scoring, ICP fit,", "lead scoring,");
  const { recipeId } = await fnOf(w.fn, "copyOf")(w.ctx, { recipeId: "canon-base" }, older);
  assert.deepEqual(plain((await w.fn.editor.handler(w.ctx, { recipeId })).upstream), { id: "canon-base", title: "Canon defaults", version: BASE, from: "1.1.0" });
  const ours = (await w.fn.editor.handler(w.ctx, { recipeId })).markdown.replace(/^description: .*$/m, 'description: "Ours."');
  const u = await w.fn.upstream.handler(w.ctx, { recipeId });
  const merged = merge3(u.base, ours, u.theirs, `upstream v${BASE}`);
  assert.equal(merged.conflicts, 1, "both changed the description");
  const resolved = merged.text.replace(/<<<<<<< yours\n(.*)\n=======\n.*\n>>>>>>> upstream v[\d.]+/, "$1");
  assert.ok(resolved.includes("# ICP fit {model=scoring.fit}") && resolved.includes('description: "Ours."'));
  const out = await w.fn.save.handler(w.ctx, { recipeId, markdown: resolved, baseRevision: 1, upstreamVersion: BASE });
  assert.equal(out.revision, 2);
  const [pkg] = w.db.rows("recipePackages");
  assert.deepEqual(plain((pkg.source as { forkedFrom: unknown }).forkedFrom), { id: "canon-base", version: BASE, markdownHash: await bundleHash(FIRST_PARTY_MARKDOWN["canon-base"]) });
  const rev = w.db.rows("recipeMarkdownRevisions").find((r) => r.revision === 2)!;
  assert.deepEqual([rev.note, (rev.upstream as { version: string }).version, (rev.upstream as { markdown: string }).markdown === u.theirs], [`Merged upstream v${BASE}`, BASE, true]);
  assert.equal((await w.fn.editor.handler(w.ctx, { recipeId })).upstream, null);
});

test("a save runs the draft's evals in the runtime, and failing ones stop it until the admin saves anyway", async (t) => {
  const importCode = (code: string) => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Promise<{ run: (s: unknown, c: unknown) => unknown }>;
  const loader: Loader = { get: (_id, code) => ({ getEntrypoint: () => ({ run: async (s, c) => (await importCode((await code()).modules["recipe.js"])).run(s, c) as unknown[] }) }) };
  const runtime = ((url: string, init?: RequestInit) => handle(new Request(url, init), { LOADER: loader, RECIPE_RUNTIME_SECRET: "test-secret" })) as typeof fetch;
  Object.assign(process.env, { RECIPE_RUNTIME_URL: "https://runtime.test", RECIPE_RUNTIME_SECRET: "test-secret" });
  t.after(() => { delete process.env.RECIPE_RUNTIME_URL; delete process.env.RECIPE_RUNTIME_SECRET; });
  const w = workspace(loadConvex(["workspaceRecipes.ts", "recipes.ts", "lib/recipes.ts"], { "lib.ts": (r) => ({ ...r, getCurrentUser: async () => user, requireUser: async () => user, agentClientOf: async () => null }) }, { fetch: runtime }));
  const velocity = readFileSync("recipes/fsgtm-velocity-deal/recipe.md", "utf8");
  const pkg = await fnOf(w.recipes, "checkPackage")(velocity, null);
  await w.db.insert("recipePackages", {
    orgId: "org", recipeId: "@fsgtm/velocity-deal", version: "3.0.0", manifest: pkg.manifestText, bundleHash: pkg.hash, bundleStorageId: "blob:0",
    source: { kind: "github-public", owner: "fsgtm", repo: "recipes", ref: "v3.0.0", sha: "a".repeat(40) }, installedBy: "user", installedAt: 1, status: "installed",
  });
  const { recipeId } = await fnOf(w.fn, "copyOf")(w.ctx, { recipeId: "@fsgtm/velocity-deal" }, velocity);
  const looser = (await w.fn.editor.handler(w.ctx, { recipeId })).markdown.replace("| emailMaxWords | int | 60 |", "| emailMaxWords | int | 80 |");

  const blocked = await w.fn.save.handler(w.ctx, { recipeId, markdown: looser, baseRevision: 1 });
  assert.deepEqual(plain({ blocked: blocked.blocked, changed: blocked.changed, failing: blocked.evals.filter((e: { ok: boolean }) => !e.ok).map((e: { name: string }) => e.name), of: blocked.evals.length }),
    { blocked: true, changed: false, failing: ["70 words is too long"], of: 6 });
  assert.equal(w.db.rows("recipeMarkdownRevisions").length, 1, "nothing saved");

  const anyway = await w.fn.save.handler(w.ctx, { recipeId, markdown: looser, baseRevision: 1, acceptFailingEvals: true });
  assert.deepEqual([anyway.blocked, anyway.revision], [false, 2]);
});

test("a save that takes the ICP fit model away from the copy in force rescores on the fallback's", async () => {
  const w = workspace();
  const { recipeId } = await w.fn.customize.handler(w.ctx, { recipeId: "canon-base" });
  const open = await w.fn.editor.handler(w.ctx, { recipeId });
  const richer = open.markdown.replace("| fitBase | int | 10 |", "| fitBase | int | 20 |");
  await w.fn.save.handler(w.ctx, { recipeId, markdown: richer, baseRevision: 1 });
  await w.recipes.enableContribution.handler(w.ctx, { point: "scoring.fit", recipeId, key: "model" });
  w.scheduled.length = 0;

  const lines: string[] = richer.split("\n");
  const from = lines.findIndex((l) => l.startsWith("# ICP fit")), to = lines.findIndex((l, i) => i > from && l.startsWith("# "));
  const without = [...lines.slice(0, from), ...lines.slice(to)].join("\n").replace(" scoring.fit,", "");
  await w.fn.save.handler(w.ctx, { recipeId, markdown: without, baseRevision: 2 });
  assert.equal(w.db.rows("fitReconciliations")[0].revision, 2);
  assert.equal(w.db.rows("fitReconciliations")[0].acknowledgedRevision, 0);
  assert.equal(w.scheduled.length, 0, "the outstanding fit reconciliation also picks up the fallback model");
});

test("a kept-bundle copy reverts across an upstream merge to the revision's own bundle; a legacy revision with none is refused", async () => {
  let bundles!: { FIRST_PARTY_MARKDOWN: Record<string, string>; RECIPE_BUNDLES: Record<string, { hash: string; code: string }> };
  const w = workspace(loadConvex(["workspaceRecipes.ts", "recipes.ts", "lib/recipes.ts"], {
    "lib.ts": (r) => ({ ...r, getCurrentUser: async () => user, requireUser: async () => user, agentClientOf: async () => null }),
    "../recipes/_bundles.generated.ts": (r) => (bundles = { ...r, FIRST_PARTY_MARKDOWN: { ...FIRST_PARTY_MARKDOWN }, RECIPE_BUNDLES: { ...RECIPE_BUNDLES } } as typeof bundles),
  }));
  const id = "fsgtm-enterprise-deal";
  const { recipeId } = await w.fn.customize.handler(w.ctx, { recipeId: id });
  const before = (await w.fn.editor.handler(w.ctx, { recipeId })).markdown;
  const old = { hash: RECIPE_BUNDLES[id]!.hash, storageId: "blob:1" };

  // Upstream changes a prompt, so it ships a new bundle; the copy merges it.
  bundles.FIRST_PARTY_MARKDOWN[id] = FIRST_PARTY_MARKDOWN[id].replace("Compare these ICP buyers", "Compare these two ICP buyers");
  const code = "export async function run() { return []; }";
  bundles.RECIPE_BUNDLES[id] = { hash: await bundleHash(code), code };
  const u = await w.fn.upstream.handler(w.ctx, { recipeId });
  const merged = merge3(u.base, before, u.theirs, `upstream v${u.version}`);
  await w.fn.save.handler(w.ctx, { recipeId, markdown: merged.text, baseRevision: 1, upstreamVersion: u.version });
  const pkg = () => w.db.rows("recipePackages")[0];
  assert.deepEqual([pkg().bundleHash, pkg().bundleStorageId], [bundles.RECIPE_BUNDLES[id].hash, "blob:2"]);

  // Before each revision recorded its bundle, the code revision 1 ran is unknown once a merge has replaced it.
  const rev1 = w.db.rows("recipeMarkdownRevisions").find((r) => r.revision === 1)!;
  const recorded = rev1.bundle;
  delete rev1.bundle;
  await assert.rejects(w.fn.revert.handler(w.ctx, { recipeId, revision: 1 }), /doesn't record the TypeScript bundle it ran on.*upstream v1\.2\.0/);
  rev1.bundle = recorded;

  const reverted = await w.fn.revert.handler(w.ctx, { recipeId, revision: 1 });
  assert.equal(reverted.revision, 3);
  assert.deepEqual([pkg().bundleHash, pkg().bundleStorageId], [old.hash, old.storageId], "the package runs revision 1's bundle again");
  assert.equal((await w.fn.markdown.handler(w.ctx, { recipeId })).markdown, before);
  await w.recipes.enableContribution.handler(w.ctx, { point: "deal.page", recipeId, key: "page" });
  assert.deepEqual(plain((await w.lib.orgRecipe(w.ctx, "org")).ref.bundle), old, "runPlays and evals load the old bundle");
  assert.deepEqual([...w.stored].sort(), ["blob:1", "blob:2"], "no bundle a revision records is deleted");
});
