import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { checkWorkflow, type WorkflowInput, type WorkflowProposal } from "../convex/lib/workflowAgent.ts";
import { standInWorkflow } from "../convex/lib/workflowStandIn.ts";
import { STANDARD_OBJECTS, plainObjectDef, resolveObjectDef } from "../convex/lib/objects/registry.ts";
import { describeLayout } from "../recipes/md/edit.ts";

const expectation = z.object({ request: z.string().min(4), targets: z.array(z.string()).min(1), blocks: z.array(z.enum(["table", "list", "metric", "chart", "board", "form", "detail"])).min(1), canonical: z.boolean().default(false) });
export const workflowCases = z.array(expectation).length(20).parse([
  { request: "Renewals desk", targets: ["renewals"], blocks: ["table", "metric"], canonical: true },
  { request: "SDR morning queue", targets: ["morning-queue", "contact"], blocks: ["list", "form"], canonical: true },
  ...[
    ["Deal review: show my open deals, amount and close date, with a count", "deal-review", "table"],
    ["Partner sourcing: a page of accounts to explore with owners", "partner-sourcing", "list"],
    ["Churn watch: accounts and their last activity, plus a count", "churn-watch", "table"],
    ["Pipeline hygiene: open deals missing a close date", "pipeline-hygiene", "table"],
    ["Exec weekly: pipeline amount by stage and a deal count", "exec-weekly", "chart"],
    ["New-logo hunt: a list of prospective accounts", "new-logo-hunt", "list"],
    ["Expansion plays: accounts to review for expansion", "expansion-plays", "table"],
    ["Event follow-up: list contacts and put a task form on their record", "event-follow-up", "list"],
    ["Manager coaching: a pipeline board grouped by stage", "manager-coaching", "board"],
    ["My overdue tasks: a task list ordered by due date", "overdue-tasks", "list"],
    ["Call prep: list people with their company and title", "call-prep", "table"],
    ["Territory review: accounts by industry in a chart", "territory-review", "chart"],
    ["Close plan: list open deals by close date", "close-plan", "table"],
    ["Inbound triage: a lead list and count", "inbound-triage", "list"],
    ["Customer handoff: won deals ordered by close date", "customer-handoff", "table"],
    ["Forecast desk: deal amounts and a total metric", "forecast-desk", "metric"],
    ["Recruit champions: contact list with title and owner", "champions", "list"],
    ["Task capture: new page with a create task form", "task-capture", "form"],
  ].map(([request, target, block]) => ({ request: `${request}. Create a page with slug ${target}.`, targets: [target], blocks: [block] })),
]);

export function fixtureInput(request: string): WorkflowInput {
  const markdown = readFileSync(new URL("../recipes/canon-base/recipe.md", import.meta.url), "utf8");
  return { request, pages: ["deal", "account", "contact"].map((target) => ({ target, recipeId: "canon-base", markdown, baseMarkdown: markdown, layerRevision: 0 })), objects: Object.values(STANDARD_OBJECTS).map((s) => plainObjectDef(resolveObjectDef(s))) };
}
export function checkExpectation(c: typeof workflowCases[number], result: WorkflowProposal): string[] {
  const errors = [...result.dropped];
  for (const target of c.targets) if (!result.targets.some((t) => t.target === target)) errors.push(`missing target ${target}`);
  const blocks = result.targets.flatMap((t) => { const layout = describeLayout(t.markdown, t.target); if ("error" in layout) { errors.push(layout.error); return []; } return layout.sections.map((s) => s.component); });
  for (const block of c.blocks) if (!blocks.includes(block)) errors.push(`missing block ${block}`);
  return errors;
}
async function main() {
  const real = process.env.RECIPE_AGENT_REAL_MODEL === "true";
  const url = process.env.WORKFLOW_EVAL_CONVEX_URL;
  const token = process.env.WORKFLOW_EVAL_AUTH_TOKEN;
  if (real && (!url || !token)) throw new Error("Real evals need WORKFLOW_EVAL_CONVEX_URL and WORKFLOW_EVAL_AUTH_TOKEN in the environment, and a connected ChatGPT plan. Local backend also needs RECIPE_AGENT_REAL_MODEL=true.");
  const client = real ? new ConvexHttpClient(url!) : null;
  if (client) client.setAuth(token!);
  let failures = 0;
  const rows = [];
  for (const c of workflowCases) {
    if (!real && !c.canonical) { rows.push({ request: c.request, result: "SCHEMA ONLY" }); continue; }
    const input = fixtureInput(c.request);
    try {
      const result = client ? await client.action(makeFunctionReference<"action", { request: string }, WorkflowProposal>("pageCustomize:workflow"), { request: c.request }) : checkWorkflow(input, standInWorkflow(input));
      const errors = checkExpectation(c, result);
      if (errors.length) failures++;
      rows.push({ request: c.request, result: errors.length ? errors.join("; ") : "PASS" });
    } catch (e) { failures++; rows.push({ request: c.request, result: String(e) }); }
  }
  console.table(rows);
  if (failures) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
