/**
 * `fullstackgtm hierarchy detect|research|verify|plan`: the account hierarchy manager's stages from the CLI.
 * detect, verify and plan are read-only. research reads the CRM snapshot and the web. plan builds a dry-run
 * PatchPlan; `--save` stores it for `fullstackgtm plans approve` and `apply`, the only path that writes a CRM.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectCandidateGroups, detectToText } from "../accountHierarchy/detect.ts";
import { proposalToMarkdown } from "../accountHierarchy/markdown.ts";
import { buildHierarchyProposal, toPatchPlan, type DomainRoute } from "../accountHierarchy/plan.ts";
import { resolvePolicy, type HierarchyPolicy } from "../accountHierarchy/policy.ts";
import { checkResearch, verifyResearch, type GroupResearch, type ResearchVerification } from "../accountHierarchy/research.ts";
import { researchGroup } from "../accountHierarchy/researchAgent.ts";
import { emitPlan } from "./fix.ts";
import { numericOption, option, readSnapshot, repeatedOption, resolveChatgptLlm } from "./shared.ts";

const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as T;
const write = (path: string, text: string) => writeFileSync(resolve(process.cwd(), path), text);
/** `research.json` -> `research.verification.json`; a name without `.json` gets the suffix appended, never overwritten. */
export const companionPath = (path: string, kind: "verification" | "pages") => `${path.replace(/\.json$/i, "")}.${kind}.json`;

function loadPolicy(args: string[]): HierarchyPolicy {
  const path = option(args, "--policy");
  return resolvePolicy(path ? readJson(path) : {});
}

export async function accountHierarchyCommand(subcommand: string, rest: string[]) {
  const policy = loadPolicy(rest);

  if (subcommand === "detect") {
    const report = detectCandidateGroups(await readSnapshot(rest), policy);
    const out = option(rest, "--out");
    const rendered = rest.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : `${detectToText(report, numericOption(rest, "--limit") ?? 80)}\n`;
    if (out) write(out, rendered);
    console.log(rendered.trimEnd());
    return;
  }

  if (subcommand === "research") {
    const group = option(rest, "--group");
    const rootId = option(rest, "--root-account-id");
    const out = option(rest, "--out");
    if (!group || !rootId || !out) throw new Error("Usage: fullstackgtm hierarchy research --group <name> --root-account-id <id> --out <research.json> [--account-id <id>...] [source options] [--policy <path>]");
    const llm = await resolveChatgptLlm();
    if (!llm) throw new Error("hierarchy research runs on your ChatGPT plan: sign in once with `fullstackgtm login chatgpt`.");
    const snapshot = await readSnapshot(rest);
    // The accounts to research: the detected group containing the root, plus any named with --account-id.
    const detected = detectCandidateGroups(snapshot, policy).groups.find((g) => g.accountIds.includes(rootId));
    const ids = new Set([rootId, ...(detected?.accountIds ?? []), ...repeatedOption(rest, "--account-id")]);
    const accounts = snapshot.accounts.filter((a) => ids.has(String(a.id)));
    console.error(`Researching ${group}: ${accounts.length} account(s)...`);
    const run = await researchGroup({ llm, group, rootId, accounts, snapshot, policy, today: option(rest, "--today") ?? undefined });
    write(out, `${JSON.stringify(run.research, null, 2)}\n`);
    write(companionPath(out, "verification"), `${JSON.stringify(run.verification, null, 2)}\n`);
    write(companionPath(out, "pages"), `${JSON.stringify(run.pages)}\n`);
    const results = Object.values(run.verification.checks).reduce<Record<string, number>>((n, c) => ((n[c.result] = (n[c.result] ?? 0) + 1), n), {});
    console.error(`Research written to ${out} (${run.model}, ${run.turns} turns, ${run.research.entities.length} entities; citations: ${JSON.stringify(results)}).`);
    return;
  }

  const researchPath = option(rest, "--research");
  if (!researchPath) throw new Error(`Usage: fullstackgtm hierarchy ${subcommand} --research <research.json> ...`);
  const research = checkResearch(readJson<GroupResearch>(researchPath));
  const pagesPath = option(rest, "--pages") ?? companionPath(researchPath, "pages");
  let pages: Record<string, string> = {};
  try {
    pages = readJson(pagesPath);
  } catch {
    // no saved agent fetches: every page is fetched fresh
  }

  if (subcommand === "verify") {
    const verification = await verifyResearch(research, { pages });
    const out = option(rest, "--out") ?? companionPath(researchPath, "verification");
    write(out, `${JSON.stringify(verification, null, 2)}\n`);
    for (const c of Object.values(verification.checks)) console.log(`${c.result.padEnd(15)} ${c.url}  "${c.quote.slice(0, 70)}"${c.detail ? `  (${c.detail})` : ""}`);
    return;
  }

  if (subcommand === "plan") {
    const verificationPath = option(rest, "--verification");
    const verification: ResearchVerification = verificationPath ? readJson(verificationPath) : await verifyResearch(research, { pages });
    const routesPath = option(rest, "--routes");
    const proposal = buildHierarchyProposal({
      snapshot: await readSnapshot(rest),
      research,
      verification,
      policy,
      routes: routesPath ? readJson<DomainRoute[]>(routesPath) : undefined,
      today: option(rest, "--today") ?? undefined,
      vendorParentNames: repeatedOption(rest, "--vendor-parent-name").length ? repeatedOption(rest, "--vendor-parent-name") : undefined,
    });
    const markdown = option(rest, "--markdown");
    if (markdown) write(markdown, proposalToMarkdown(proposal));
    const plan = toPatchPlan(proposal);
    if (!rest.includes("--json") && !rest.includes("--save") && !option(rest, "--out")) {
      console.log(proposalToMarkdown(proposal).trimEnd());
      return;
    }
    await emitPlan(plan, rest);
    return;
  }

  throw new Error("Usage: fullstackgtm hierarchy <report|link|detect|research|verify|plan> ...");
}
