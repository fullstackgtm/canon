/**
 * Customize mode's instruction step, checked for user success against real models (Jev, and Luna on the dev user's
 * ChatGPT plan) on your own local stack. Each case is what a person asked and pointed at, and what they should get:
 * a change (`want: "change"`, judged by `ok` on the diff) or a refusal (`want: "refuse"`, nothing may change). Cases
 * with `steps` replay a short session, each instruction applied to the last one's result, the way the page queues them.
 * It reports success, false refusals (wanted a change, got nothing) and wrong edits (changed, but not what was asked)
 * per category and per model. Add a case for every false refusal found in pageEditAttempts (outcome "refused").
 * Nothing is saved. The deterministic refusal rules are tested without models in tests/pageEditEvals.test.ts.
 *
 *   node scripts/page-customize-eval.mjs "$PWD" "$DEVSTACK_SANDBOX_HOME" [name filter]   # from .devstack/ports.env
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const repo = process.argv[2], sandbox = process.argv[3];
if (!repo || !sandbox) throw new Error("usage: node scripts/page-customize-eval.mjs <repo> <DEVSTACK_SANDBOX_HOME>");
const out = mkdtempSync(join(tmpdir(), "page-customize-eval-"));
const filter = process.argv[4] ? new RegExp(process.argv[4], "i") : null;
const recipes = { "fsgtm-enterprise-deal": readFileSync(`${repo}/recipes/fsgtm-enterprise-deal/recipe.md`, "utf8"), "canon-base": readFileSync(`${repo}/recipes/canon-base/recipe.md`, "utf8") };
const markdown = recipes["fsgtm-enterprise-deal"];
const has = (d, re) => re.test(d);
const cases = [
  { name: "badge in Summary (a part)", request: "remove the at risk label", target: { component: "summary", nth: 0 }, pointed: 'the section\'s "health" part, reading "At risk" in an area reading "At risk $145,000.00 · closes 2026-11-17 Research account"', ok: (r) => has(r.diff, /\+### Summary \{section=summary show="[^"]*"\}/) && !has(r.diff, /\+### Summary.*show="[^"]*health/) },
  { name: "Products title", request: "rename to services", target: { component: "products", nth: 0 }, pointed: 'the section\'s title, reading "Products" in the area headed "Products"', ok: (r) => has(r.diff, /\+### Services \{section=products/i) },
  { name: "Credit splits title", request: "change to splits", target: { component: "splits", nth: 0 }, pointed: 'the section\'s title, reading "Credit splits" in the area headed "Credit splits"', ok: (r) => has(r.diff, /\+### splits \{section=splits/i) },
  { name: "header button", request: "remove this button", target: { component: "header", nth: 0 }, pointed: 'a button reading "Archive" in the area headed "Atlas Cloud - Platform Expansion"', ok: (r) => has(r.diff, /-runs: kernel\.archive/) && !has(r.diff, /-runs: kernel\.restore/) },
  { name: "a component's own control (fixed)", request: "rename this to Find people", target: { component: "fanOut", nth: 0 }, pointed: 'a control or text the section\'s component draws, reading "Search contacts" in the area headed "Choose who to reach first"', ok: (r) => !r.changed },
  { name: "stage gate", request: "only show this when we're closing", target: { component: "fanOut", nth: 0 }, pointed: 'in the area headed "Choose who to reach first"', ok: (r) => has(r.diff, /\+.*section=fanOut.*stage = close|\+.*section=fanOut.*stage in \[close\]/) },
  { name: "every stage + open", request: "show this in every stage and open it by default", target: { component: "keeper", nth: 0 }, pointed: 'in the area headed "Deal health"', ok: (r) => has(r.diff, /\+### Deal health \{section=keeper\}/) },
  { name: "rename button", request: "rename the research account button to Dig in", target: { component: "summary", nth: 0 }, pointed: 'a button reading "Research account"', ok: (r) => has(r.diff, /\+label: Dig in/) },
  { name: "setting: email words", request: "email drafts should be at most 60 words", target: { component: "fanOut", nth: 0 }, pointed: 'in the area headed "Choose who to reach first"', ok: (r) => has(r.diff, /\+\| emailMaxWords \| int \| 60 \|/) },
  { name: "page move (pointed at the header)", request: "move Prep above Choose who to reach first", target: { component: "header", nth: 0 }, pointed: 'the section\'s title, reading "Atlas Cloud - Platform Expansion" in the area headed "Atlas Cloud - Platform Expansion"', ok: (r) => { const m = /\+### Prep|\-### Prep/.test(r.diff); return m; } },
  { name: "setting: quiet days", request: "call a deal quiet after 10 days instead of 14", target: { component: "keeper", nth: 0 }, pointed: 'in the area headed "Deal health"', ok: (r) => has(r.diff, /\+\| quietDays \| int \| 10 \|/) },
  { name: "stage exit", request: "the first stage's exit should be: a buyer books a meeting", target: { component: "stageRail", nth: 0 }, pointed: 'a control or text the section\'s component draws, reading "Leave this stage when: Someone at the account replies and agrees to talk."', ok: (r) => has(r.diff, /\+in: \{ label: Find the way in, exit: .*books a meeting/i) },
  { name: "remove button", request: "get rid of the remove step button", target: { component: "plan", nth: 0 }, pointed: 'in the area headed "Next action"', ok: (r) => has(r.diff, /-.*runs: kernel\.removeStep/) && !has(r.diff, /\+.*runs: kernel\.removeStep/) },
  { name: "setting, pointed at a drawn control", request: "suggest 4 people to reach first", target: { component: "fanOut", nth: 0 }, pointed: 'a control or text the section\'s component draws, reading "Search contacts" in the area headed "Choose who to reach first"', ok: (r) => has(r.diff, /\+\| suggestedFirstTouches \| int \| 4 \|/) },
  { name: "prompt (frozen here)", request: "make the first touch sound warmer and more casual", target: { component: "fanOut", nth: 0 }, pointed: 'a button reading "Draft first touches for 0"', ok: (r) => !has(r.diff, /\+.*(warm|casual)/i) },
];
// Sessions on the base deal page. A field row reads its label run into its value, the way the browser reports it.
const field = (label, value, area) => `a control or text the section's component draws, reading "${label}${value}" in the area headed "${area}"`;
const title = (t) => `the section's title, reading "${t}" in the area headed "${t}"`;
const base = { recipe: "canon-base", category: "rename" };
cases.push(
  { ...base, name: "rename back after a rename, pointed at a field", steps: [
    { request: "change title to asdf", target: { component: "fields", nth: 0 }, pointed: field("Opportunity name", "Speedeon - QuotaQueue commissions software", "Overview"), ok: (r) => has(r.diff, /\+## asdf \{section=fields/) },
    { request: "change title to Overview", target: { component: "fields", nth: 0 }, pointed: field("Opportunity name", "Speedeon - QuotaQueue commissions software", "asdf"), ok: (r) => has(r.diff, /\+## Overview \{section=fields/) },
  ] },
  { ...base, name: "rename by its title", request: "call it Basics", target: { component: "fields", nth: 0 }, pointed: title("Overview"), ok: (r) => has(r.diff, /\+## Basics \{section=fields/) },
  { ...base, name: "rename the section by name, pointed at a field", request: "rename the Pipeline section to Forecast", target: { component: "fields", nth: 1 }, pointed: field("Amount", "$12,000", "Pipeline"), ok: (r) => has(r.diff, /\+## Forecast \{section=fields/) },
  { ...base, name: "rename a field label (drawn)", want: "refuse", request: "rename Opportunity name to Deal name", target: { component: "fields", nth: 0 }, pointed: field("Opportunity name", "Speedeon", "Overview") },
  { ...base, name: "rename this, pointed at a field (drawn)", want: "refuse", request: "rename this to Deal", target: { component: "fields", nth: 0 }, pointed: field("Opportunity name", "Speedeon", "Overview") },
  { ...base, category: "layout", name: "fold, pointed at a field", request: "start this folded", target: { component: "fields", nth: 2 }, pointed: field("Notes", "Met at SaaStr", "Notes"), ok: (r) => has(r.diff, /\+## Notes \{section=fields collapsed=true\}/) },
  { ...base, category: "layout", name: "move below another section", request: "move this below More", target: { component: "fields", nth: 1 }, pointed: title("Pipeline"), ok: (r) => /-## Pipeline/.test(r.diff) || /\+## Pipeline/.test(r.diff) || /-## More|\+## More/.test(r.diff) },
);
const refuseCases = new Set(["a component's own control (fixed)", "prompt (frozen here)"]);
const categoryOf = (c) => c.category ?? (/setting|exit|prompt/.test(c.name) ? "behavior" : /title|rename/i.test(c.name) ? "rename" : /control/.test(c.name) ? "drawn" : "layout");

function run(recipeId, md, step) {
  const args = { recipeId, markdown: md, request: step.request, pointed: step.pointed, ...(step.target ? { target: step.target } : {}) };
  try {
    const out = execFileSync("./node_modules/.bin/convex", ["run", "pageCustomize:edit", JSON.stringify(args)], { cwd: repo, env: (({ CONVEX_DEPLOYMENT: _, ...rest }) => ({ ...rest, HOME: sandbox, CONVEX_AGENT_MODE: "anonymous" }))(process.env), maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] }).toString();
    const j = JSON.parse(out);
    return { markdown: j.markdown, changed: j.markdown !== md, summary: j.summary, diff: j.diff, by: j.by, route: j.route, refusedBy: j.refusedBy ?? null };
  } catch (e) {
    const msg = String(e.stderr ?? e.message).split("\n").find((l) => /Couldn't|Error|error/.test(l)) ?? String(e.stderr ?? e).slice(0, 300);
    return { markdown: md, changed: false, summary: msg, diff: "", by: "error", route: "", refusedBy: "error" };
  }
}

const results = [];
for (const c of cases.filter((c) => !filter || filter.test(c.name))) {
  const recipeId = c.recipe ?? "fsgtm-enterprise-deal";
  let md = recipes[recipeId];
  const want = c.want ?? (refuseCases.has(c.name) ? "refuse" : "change");
  const steps = c.steps ?? [{ request: c.request, target: c.target, pointed: c.pointed, ok: c.ok }];
  const t = Date.now();
  let r, outcome = "success", at = 0;
  for (const [k, step] of steps.entries()) {
    r = run(recipeId, md, step);
    at = k;
    // A refusal case passes when nothing changed (its own `ok`, if any, can check more); a change case needs its `ok`.
    if (want === "refuse") { if (r.changed || (step.ok && !step.ok(r))) { outcome = "wrong edit"; break; } }
    else if (!r.changed) { outcome = "false refusal"; break; }
    else if (!step.ok(r)) { outcome = "wrong edit"; break; }
    md = r.markdown;
  }
  const s = ((Date.now() - t) / 1000).toFixed(1);
  results.push({ name: c.name, category: categoryOf(c), want, outcome, pass: outcome === "success", step: steps.length > 1 ? at + 1 : undefined, by: r.by, refusedBy: r.refusedBy, s, summary: r.summary.slice(0, 200), route: r.route, diff: r.diff.split("\n").filter((l) => /^[+-][^+-]/.test(l)).slice(0, 4).join(" | ").slice(0, 300) });
  console.log(`${outcome === "success" ? "PASS" : "FAIL"} ${c.name}${steps.length > 1 ? ` (step ${at + 1}/${steps.length})` : ""} [${r.by}${r.refusedBy ? ` refused:${r.refusedBy}` : ""} ${s}s] ${outcome === "success" ? "" : `${outcome}: `}${r.summary.slice(0, 140)}`);
}
const tally = (rows) => `${rows.filter((r) => r.pass).length}/${rows.length}`;
const by = (k) => Object.entries(Object.groupBy(results, (r) => r[k] ?? "-")).map(([g, rows]) => `${g} ${tally(rows)}`).join(", ");
const wanted = results.filter((r) => r.want === "change");
console.log(`\nsuccess ${tally(results)}; false refusals ${wanted.filter((r) => r.outcome === "false refusal").length}/${wanted.length}; wrong edits ${results.filter((r) => r.outcome === "wrong edit").length}/${results.length}`);
console.log(`by category: ${by("category")}`);
console.log(`by model: ${by("by")}`);
writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
console.log(`results: ${join(out, "results.json")}`);
