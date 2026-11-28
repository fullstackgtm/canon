import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { checkWorkflow, type WorkflowProposal } from "../convex/lib/workflowAgent.ts";
import { standInWorkflow } from "../convex/lib/workflowStandIn.ts";
import { DEFAULT_IMAGE_REQUEST, referenceImageError } from "../recipes/imageReferences.ts";
import { fixtureInput } from "./workflow-evals.ts";
import { referenceExpectation, scoreReferencePage, type ReferenceScore } from "./reference-image-score.ts";

const fixtures = new URL("../tests/fixtures/reference-images/", import.meta.url);
const cases = [
  "lightning-style-opportunity",
  "hub-style-deal",
  "attio-style-record",
  "linear-style-issue",
] as const;
const [standInCase] = cases;
const target = "deal";
const workflow = makeFunctionReference<
  "action",
  { request: string; images: string[]; currentTarget: string },
  WorkflowProposal & { model: string }
>("pageCustomize:workflow");

function attachment(name: typeof cases[number]) {
  const bytes = readFileSync(new URL(`${name}.png`, fixtures));
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${name} is not a PNG`);
  const image = `data:image/png;base64,${bytes.toString("base64")}`;
  const error = referenceImageError([image]);
  if (error) throw new Error(`${name}: ${error}`);
  return image;
}

type Result = { name: typeof cases[number]; dropped?: string[]; score?: ReferenceScore };

async function runCases(client: ConvexHttpClient | undefined): Promise<Result[]> {
  const catalog = cases.map((name) => ({
    name,
    expected: referenceExpectation.parse(JSON.parse(readFileSync(new URL(`${name}.json`, fixtures), "utf8"))),
  }));
  const results: Result[] = [];
  for (const { name, expected } of catalog) {
    if (!client && name !== standInCase) {
      results.push({ name });
      continue;
    }
    const image = attachment(name);
    let proposal: WorkflowProposal;
    if (client) {
      const reply = await client.action(workflow, { request: DEFAULT_IMAGE_REQUEST, images: [image], currentTarget: target });
      if (!reply.model || reply.model === "local:stand-in") {
        throw new Error("Real evals need a model-backed workflow action. Check the backend's RECIPE_AGENT_REAL_MODEL setting.");
      }
      proposal = reply;
    } else {
      const input = { ...fixtureInput("Make this deal page look like the attached Salesforce-style reference."), imageReference: { currentTarget: target } };
      proposal = checkWorkflow(input, standInWorkflow(input));
    }
    const markdown = proposal.targets.find((page) => page.target === target)?.markdown ?? "";
    results.push({ name, score: scoreReferencePage(markdown, target, proposal.summary, expected), dropped: proposal.dropped });
  }
  return results;
}

const baselineSchema = z.strictObject({
  mode: z.enum(["stand-in", "real"]),
  scores: z.partialRecord(z.enum(cases), z.int().min(0).max(100)),
});

async function main() {
  const { values } = parseArgs({ options: {
    baseline: { type: "string" },
    json: { type: "boolean" },
    "visual-judge": { type: "boolean" },
  } });
  const real = process.env.RECIPE_AGENT_REAL_MODEL === "true";
  const mode = real ? "real" : "stand-in";
  const baseline = values.baseline === undefined
    ? undefined
    : baselineSchema.parse(JSON.parse(readFileSync(values.baseline, "utf8")));
  if (baseline && baseline.mode !== mode) throw new Error(`Baseline mode must be ${mode}.`);
  if (baseline) {
    for (const name of real ? cases : [standInCase]) {
      if (baseline.scores[name] === undefined) throw new Error(`Baseline is missing ${name}.`);
    }
  }
  if (values["visual-judge"]) {
    if (!real) throw new Error("--visual-judge requires RECIPE_AGENT_REAL_MODEL=true.");
    console.error("Visual judge skipped. The eval has no authenticated rendered page for proposed markdown.");
  }

  let client: ConvexHttpClient | undefined;
  if (real) {
    const { WORKFLOW_EVAL_CONVEX_URL: url, WORKFLOW_EVAL_AUTH_TOKEN: token } = process.env;
    if (!url || !token) throw new Error("Set WORKFLOW_EVAL_CONVEX_URL and WORKFLOW_EVAL_AUTH_TOKEN in the environment for real evals.");
    client = new ConvexHttpClient(url, { auth: token, logger: false });
  }

  const results = await runCases(client);
  const scores: z.infer<typeof baselineSchema>["scores"] = {};
  for (const { name, score, dropped } of results) {
    if (!score) continue;
    scores[name] = score.total;
    if (score.error || dropped?.length) console.error(name, score.error ?? "", ...(dropped ?? []));
    if (!real && (score.error || dropped?.length)) process.exitCode = 1;
    const previous = baseline?.scores[name];
    if (previous !== undefined && previous - score.total > 5) {
      console.error(`${name} fell from ${previous} to ${score.total} (>5 points).`);
      process.exitCode = 1;
    }
  }
  if (values.json) {
    console.log(JSON.stringify({ mode, scores }, null, 2));
    return;
  }
  console.table(results.map(({ name, score }) => ({
    case: name,
    result: score ? mode : "schema only",
    ...Object.fromEntries(Object.entries(score?.criteria ?? {}).map(([key, value]) =>
      [key, `${Number(value.earned.toFixed(2))}/${value.possible}`],
    )),
    total: score?.total,
  })));
  for (const { name, score } of results) {
    for (const [key, entry] of Object.entries(score?.criteria ?? {})) {
      if (entry.missed.length) console.log(`${name} / ${key}: ${entry.missed.join(", ")}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
