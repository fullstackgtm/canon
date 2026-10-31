/**
 * Is the Canon layout skill enough to make the edits people ask for? Five realistic requests, each with the
 * recipe.md change it should produce on FSGTM's Velocity recipe. For each, this checks that the skill
 * (recipes/skills/canon-layout/SKILL.md) documents every component, action, setting kind and key the change uses,
 * that the changed recipe.md parses with no errors, and that its evals still pass. No model runs, so it costs nothing.
 *
 *   node --experimental-strip-types scripts/layout-skill-sufficiency.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRecipe, runnable } from "../recipes/compose.ts";
import { mismatch } from "../recipes/evals.ts";
import { parseRecipe } from "../recipes/md/parse.ts";
import { unifiedDiff } from "../convex/lib/recipeAgentDiff.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = readFileSync(join(ROOT, "recipes/skills/canon-layout/SKILL.md"), "utf8");
const BASE = readFileSync(join(ROOT, "recipes/fsgtm-velocity-deal/recipe.md"), "utf8");

/** `md` with `from` replaced by `to`, where `from` occurs exactly once. */
function swap(md: string, from: string, to: string): string {
  const at = md.indexOf(from);
  if (at < 0 || md.indexOf(from, at + 1) >= 0) throw new Error(`expected exactly one ${JSON.stringify(from.slice(0, 60))}`);
  return md.slice(0, at) + to + md.slice(at + from.length);
}

/** The section starting at `heading`, through the line before the next heading of its level. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`${heading}\n`);
  const next = md.indexOf("\n### ", start + heading.length);
  if (start < 0 || next < 0) throw new Error(`no section ${heading}`);
  return md.slice(start, next + 1);
}

const ACTIVITY = '### Activity {section=touches when="stage != in" collapsed=true}';
const NEXT = '### Next action {section=plan when="stage != in"}';
const FIFTEEN = (i: number) => `Sentence ${i} has exactly fifteen words in it so this email runs long right here.`;
const FOURTEEN = (i: number) => `Sentence ${i} has exactly fourteen words in it so the email runs long here.`;

type Case = { request: string; edit(md: string): string; uses: string[] };

const CASES: Case[] = [
  {
    request: "move Activity above Next action",
    edit: (md) => { const s = section(md, ACTIVITY); return swap(swap(md, s, ""), `${NEXT}\n`, `${s}${NEXT}\n`); },
    uses: ["`touches`", "`plan`", "{section=<component>}", "`when=`", "`collapsed=true`", "**Move a section.**"],
  },
  {
    request: "hide the Redraft button",
    edit: (md) => swap(md, '```action\nid: redraft\nlabel: Redraft\nruns: kernel.redraftStep\nprompt: drafts.prompt\nshows: draft.by == "keeper"\n```\n\n', ""),
    uses: ["`kernel.redraftStep`", "`draftPanel`", "`shows`", "**Hide a button.**"],
  },
  {
    request: "add an AI field asking which CRM they use",
    edit: (md) => swap(md, "  autoAccept: 0.8\n```\n\n```people", [
      "  autoAccept: 0.8",
      "- slug: crm_in_use",
      "  label: CRM in use",
      "  object: account",
      "  kind: qa",
      "  answer: text",
      "  question: \"Which CRM does this company run its sales on, such as Salesforce, HubSpot or Pipedrive? Ground it in job postings that name it, the company's own site and its integrations pages.\"",
      "  judgment: true",
      "  refresh: monthly",
      "  autoAccept: 0.8",
      "```\n\n```people",
    ].join("\n")),
    uses: ["```` ```ai-fields ````", "`slug`", "`account`", "`qa`", "`text`", "`question`", "`judgment: true`", "`monthly`", "`autoAccept`", "`fields`", "**Add an AI field.**"],
  },
  {
    request: "make emails max 70 words",
    edit: (md) => {
      let out = swap(md, "| emailMaxWords | int | 60 | 20 to 400 |", "| emailMaxWords | int | 70 | 20 to 400 |");
      out = swap(out, "emails stay under 60", "emails stay under 70");
      out = swap(out, "- name: 70 words is too long\n  description: A 70-word email fails \"Reads without scrolling on a phone\" at the 60-word cap.",
        "- name: 75 words is too long\n  description: A 75-word email fails \"Reads without scrolling on a phone\" at the 70-word cap.");
      return swap(out, [0, 1, 2, 3, 4].map(FOURTEEN).join(" "), [0, 1, 2, 3, 4].map(FIFTEEN).join(" "));
    },
    uses: ["`int`", "`<min> to <max>`", "Default cell", "`drafts.check`", "`length(int, int, phrases)`", "**Tune a setting.**", "rewrite that eval"],
  },
  {
    request: "rename Check now to Run the keeper",
    edit: (md) => swap(md, "label: Check now\n", "label: Run the keeper\n"),
    uses: ["`kernel.checkNow`", "`keeper`", "`label`", "**Rename a section or a button.**"],
  },
];

let failed = 0;
for (const c of CASES) {
  const md = c.edit(BASE);
  const missing = c.uses.filter((term) => !SKILL.includes(term));
  const { recipe, problems } = parseRecipe(md);
  const errors = problems.filter((p) => p.level === "error");
  const results = errors.length ? [] : runRecipe(runnable(recipe), [], recipe.defaults, recipe.evals.map((e) => e.call), null);
  const evalFails = recipe.evals.flatMap((e, i) => {
    const r = results[i];
    const why = !r ? "not run" : r.ok ? mismatch(e.expect, r.value, recipe.defaults) : r.error.message;
    return why ? [`${e.name}: ${why}`] : [];
  });
  const ok = !missing.length && !errors.length && !evalFails.length;
  if (!ok) failed++;
  const diffLines = unifiedDiff(BASE, md).split("\n").filter((l) => /^[-+][^-+]/.test(l)).length;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.request}: skill documents ${c.uses.length - missing.length}/${c.uses.length}, parses with ${errors.length} errors, evals ${recipe.evals.length - evalFails.length}/${recipe.evals.length}, ${diffLines} lines changed`);
  for (const m of missing) console.log(`       the skill doesn't mention ${m}`);
  for (const e of errors) console.log(`       line ${e.line}: ${e.message}`);
  for (const e of evalFails) console.log(`       eval ${e}`);
}
console.log(failed ? `${failed} of ${CASES.length} requests the skill can't carry` : `the skill carries all ${CASES.length} requests`);
process.exit(failed ? 1 : 0);
