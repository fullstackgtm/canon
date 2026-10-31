/**
 * Canon tools for the work that fills and keeps the CRM: researching a
 * company and populating its market, the ICP, TAM scoring, AI fields,
 * audiences, signals, and the review decisions a person makes in the app.
 *
 * Each tool groups one area's named actions. `args` passes through to the
 * Convex function the dashboard calls, whose validator checks it, so a tool
 * stays a list of names rather than a copy of each schema.
 */
import type { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { z } from "zod/v4";
import { api } from "../../../convex/_generated/api.js";
import type { CanonTool } from "./_canonTools.ts";

type Ref = FunctionReference<"query" | "mutation" | "action", "public">;
type Step = { kind: "query" | "mutation" | "action"; ref: Ref; args: string };

export const q = (ref: Ref, args = "{}"): Step => ({ kind: "query", ref, args });
export const m = (ref: Ref, args = "{}"): Step => ({ kind: "mutation", ref, args });
export const a = (ref: Ref, args = "{}"): Step => ({ kind: "action", ref, args });

function call(convex: ConvexHttpClient, step: Step, args: Record<string, unknown>) {
  if (step.kind === "query") return convex.query(step.ref as never, args as never);
  if (step.kind === "mutation") return convex.mutation(step.ref as never, args as never);
  return convex.action(step.ref as never, args as never);
}

/** One tool over a set of named actions; the description lists each action's args. */
export function groupTool(name: string, summary: string, actions: Record<string, Step>, opts: { destructive?: boolean } = {}): CanonTool {
  const names = Object.keys(actions) as [string, ...string[]];
  return {
    name,
    description: `${summary}\nActions and their args:\n${names.map((n) => `- ${n}: ${actions[n].args}`).join("\n")}`,
    inputSchema: {
      action: z.enum(names),
      args: z.record(z.string(), z.unknown()).optional().describe("The action's arguments, as listed above"),
    },
    writes: names.some((n) => actions[n].kind !== "query"),
    ...(opts.destructive ? { destructive: true } : {}),
    run: async (convex, input) => {
      const step = actions[String(input.action)];
      if (!step) throw new Error(`Unknown action ${String(input.action)}`);
      return call(convex, step, (input.args ?? {}) as Record<string, unknown>);
    },
  };
}

const ICP_SPEC = "{ market: { industries: string[] (Leadsforge values, lowercase), employeeBands: string[] (\"1-10\"…\"10001+\"), countries: string[] (ISO, lowercase; where the company is) }, persona: { levels, departments, titles: string[], countries?: string[] (ISO, lowercase; where the buyer is) }, exclude: { industries, countries, titles: string[] }, custom?: [{ slug (an account AI field), values?: string[] (option keys, \"true\"/\"false\", or exact text), min?, max? }] }";
const ICP_QUERY = "a query line (docs/icp-tree.md): space-separated key:value,value clauses. Company keys: industry (canonical industry, words joined by -, e.g. software-development), size (\"1-10\"…\"10001+\"), country (ISO, lowercase), field.<account AI field slug>:<answers> or field.<slug>:min..max; -industry and -country exclude. A segment (not an ICP) also takes region (north-america, latin-america, europe, middle-east-africa, asia-pacific; not with country), city, owner (a member id, or none) and revenue (bands: 1m-10m, 50m+); -region and -owner exclude. Person keys, inside has(…) or on a persona: level (cxo, vp, head, director, manager, owner, founder, partner), dept (e.g. sales, revenue-operations), title (a word in the job title; quote phrases: title:\"chief revenue officer\"), -title (never), location. An ICP takes company keys and one has(…), its buyer (none: C-suite to Director). A segment narrows its parent's accounts: company keys, has(…) (someone like this works there) and -has(…) (no one like this does). A persona takes person keys only: the people to reach at its parent's accounts. Example ICP: industry:software-development size:201-500,501-1000 country:us has(level:vp,head dept:revenue-operations -title:intern)";
const TAM_FILTER = "filter?: { segmentId?, status?, ownerId?, minFit?, q?, icpId?, industry?: string[], country?: string[], employeeMin?, employeeMax?, sizeBand?: string[], region?: string[], traits?: { <segmentKey>: string[] } }";

export const canonJobTools: CanonTool[] = [
  groupTool(
    "canon_research",
    "Research a company's website into an ICP and market, then claim it into this workspace: the claim imports the market's accounts and starts populating the CRM with buyers from free sources (hours; watch with status). Use once per workspace, with the workspace's own company domain.",
    {
      start: m(api.researchSessions.start, "{ domain: string } -> { token }"),
      session: q(api.researchSessions.get, "{ token: string } (the research's status, ICP and market)"),
      claim: m(api.researchSessions.claim, "{ token: string } (call once research is ready; applies the plan and starts import)"),
      status: q(api.researchSessions.forMyOrg, "{} (the claimed research's import and population progress)"),
    },
  ),
  groupTool(
    "canon_icp",
    "The workspace's ICPs: distinct pockets of the market, each a tree: the ICP (companies and its buyer), segments that narrow its accounts, and personas, the people to reach inside them. Every node is one query line, the same text the ICPs page shows and edits. An account is in an ICP only when it meets every criterion (unknown values and unanswered AI fields count as not met); inside, fit ranks how central it is; outside every active ICP, fit is 0. The default ICP starts Add records. Also legacy scoring profiles, top accounts by fit, and 'challenge my ICP' (proposed changes to accept or dismiss). List an ICP's accounts with canon_tam facets or AI-field runs using filter.icpId.",
    {
      list: q(api.icps.list, "{} -> { canEdit, icps, research }"),
      tree: q(api.icpTree.list, "{} -> { canEdit, icps (each with its query), nodes: [{ _id, icpId, parentId? (the segment it sits under; none: under the ICP), kind: segment|persona, name, query, role?, pointOfView?, offer? }] }"),
      tree_counts: a(api.icpTree.counts, "{} -> { nodes: [{ id, accounts, people (personas) }], overlaps: [{ a, b, accounts }] (accounts each pair of siblings shares) } | null (record service too old)"),
      add_node: m(api.icpTree.createNode, `{ icpId, parentId? (a segment; none: directly under the ICP), kind: "segment"|"persona", name, query: ${ICP_QUERY}, role? (a persona's part, e.g. "Champion"), pointOfView?, offer? }`),
      update_node: m(api.icpTree.updateNode, "{ nodeId, name?, query?, role?, pointOfView?, offer? }"),
      remove_node: m(api.icpTree.removeNode, "{ nodeId } (removes what sits under it too)"),
      stats: a(api.icps.stats, "{} -> { gates: [{ id (icpId), members, unverified }] } (active ICPs; unverified = would pass but a value is unknown)"),
      create: m(api.icps.create, `{ name, description?, pointOfView? (what you believe about this buyer's problem, 1-2 sentences; deal outreach drafts open from it), offer? (the one free thing a first touch may offer this buyer, e.g. "a one-page check of which plans to cut"), query: ${ICP_QUERY} (or spec: ${ICP_SPEC}), active?: boolean }`),
      update: m(api.icps.update, `{ icpId, name?, description?, pointOfView? ("" clears it), offer? ("" clears it), query? (or spec?), active?: boolean }`),
      set_default: m(api.icps.setDefault, "{ icpId }"),
      remove: m(api.icps.remove, "{ icpId }"),
      derive_from_website: a(api.icpActions.deriveFromWebsite, "{ domain } (saved off unless it is the first ICP)"),
      import_research: m(api.icps.importFromResearch, "{} (saves the claimed signup research's ICP)"),
      profiles: q(api.icp.listProfiles),
      profile: q(api.icp.getProfile, "{ profileId }"),
      create_profile: m(api.icp.createProfile, "{ name, description?, attributes: [{ field, operator, value, weight }], isDefault: boolean }"),
      update_profile: m(api.icp.updateProfile, "{ profileId, name?, description?, attributes?, isDefault? }"),
      top_accounts: q(api.icp.getTopAccounts, "{ limit? }"),
      challenge: m(api.icpChallenge.start),
      challenge_latest: q(api.icpChallenge.latest),
      challenge_accept: m(api.icpChallenge.accept, "{ runId, index }"),
      challenge_dismiss: m(api.icpChallenge.dismiss, "{ runId, index, reason? }"),
    },
  ),
  groupTool(
    "canon_tam",
    "The total addressable market: segments (traits accounts are scored on), breakdowns, and scoring or revenue-estimate runs over a scope of accounts.",
    {
      segments: q(api.tam.segments),
      jobs: q(api.tam.jobs),
      facets: a(api.tam.facets, `{ groupBy, limit?, ${TAM_FILTER} }`),
      create_segment: m(api.tam.createSegment, "{ label, criterion }"),
      ensure_jtbd: m(api.tam.ensureJtbd),
      start_job: m(api.tam.startJob, `{ kind: "segment" | "revenue", segmentKey? (for segment), ${TAM_FILTER.replace("filter?", "filter")} }`),
      cancel_job: m(api.tam.cancelJob, "{ jobId }"),
    },
  ),
  groupTool(
    "canon_ai_fields",
    "AI fields: a question researched for every account or contact in a scope, with cited answers. Runs spend the starter's ChatGPT plan, which costs no credits; without one they use Canon's research model at 1 workspace credit per answer found.",
    {
      list: q(api.researchAgents.list),
      create: m(api.researchAgents.create, '{ label, kind: "classify" | "qa", question, options?: [{ key, label, description? }], answerType?: "text" | "number" | "boolean", entityType?: "account" | "contact" }'),
      update: m(api.researchAgents.update, "{ slug, label, question, options?: [{ key, label, description? }] (classify: keep every existing key; new keys add options), askAgain?: true to make every record count as unanswered }"),
      run: m(api.researchAgents.startRun, `{ slug, ${TAM_FILTER} (accounts) | contacts?: { kind: "all" } | { kind: "view", viewId } | { kind: "ids", ids }, capCredits?: without a ChatGPT plan, the most the run may spend at 1 credit per answer (default 100) }`),
      probe: m(api.researchAgents.startProbe, `{ slug, ${TAM_FILTER} (accounts) | contacts?: same as run }: research a random 25 of what run would, then read the verdict in runs`),
      runs: q(api.researchAgents.runs, "{ slug }"),
      watch_ticket: a(api.piRuntime.watch, "{ runId }: a fresh 60-second WebSocket ticket for an enabled Pi run's progress counts"),
      cancel_run: m(api.researchAgents.cancelRun, "{ runId }"),
      answers: a(api.researchAgents.answersScoped, "{ slug, limit? }: the answers on records you can see"),
      contact_answers: a(api.researchAgents.contactAnswersScoped, "{ slugs: string[], recordIds: string[] }"),
      set_refresh: m(api.researchAgents.setRefresh, '{ slug, cadence: "weekly" | "monthly" | null }'),
      set_auto_accept: m(api.researchAgents.setAutoAccept, "{ slug, minConfidence: number | null }"),
      remove: m(api.researchAgents.remove, "{ slug }"),
    },
  ),
  groupTool(
    "canon_audiences",
    "Audiences: saved contact lists (filters as in canon_list_records) to export or push to a sequencer campaign: provider \"instantly\" (the default), \"emailbison\" or \"smartlead\", each connected in Integrations. Each is private to its creator until shared; create_from_icp starts one from a saved ICP (filter accountIcpIds).",
    {
      list: q(api.audiences.list),
      create: m(api.audiences.create, "{ name, filter: [{ field, op, value? }], viewId? }"),
      create_from_icp: m(api.audiences.createFromIcp, "{ icpId }: a private audience of the people at the ICP's accounts"),
      update: m(api.audiences.update, "{ audienceId, name?, filter?: [{ field, op, value? }], shared? }"),
      history: q(api.audiences.history, "{ audienceId }"),
      campaigns: a(api.audienceActions.campaigns, "{ provider? }"),
      preview: a(api.audienceActions.preview, "{ audienceId, campaignId?, provider? }"),
      push: a(api.audienceActions.push, "{ audienceId, campaignId, expectToSend: number (the preview's count), provider? }"),
      export_csv: a(api.audienceActions.exportCsv, "{ audienceId }"),
    },
  ),
  groupTool(
    "canon_signals",
    "Buying signals (job-board hiring) and the heat score for top accounts.",
    {
      status: q(api.signals.status),
      set_enabled: m(api.signals.setEnabled, "{ enabled: boolean }"),
      check_now: m(api.signals.checkNow),
      for_account: a(api.signals.forAccountScoped, "{ domain }"),
      heat: a(api.signals.heatByDomainScoped, "{ domains: string[] } -> heat and growth by domain, for the companies you see"),
    },
  ),
  groupTool(
    "canon_review",
    "Decisions a reviewer makes in the app: accept or reject proposed facts (see canon_review_queue), and approve, reject or apply a patch plan (see canon_patch_plans). Applying writes the approved operations to the connected CRM.",
    {
      decide_facts: a(api.canonGate.decideScoped, '{ decisions: [{ factId, status: "accepted" | "rejected" }] }'),
      resolve_contested: a(api.canonGate.resolveContestedScoped, "{ factId } (makes that fact the field's value)"),
      decide_plan: m(api.patchPlans.approve, '{ patchPlanId, decision: "approved" | "rejected", reason?, approvedOperationIds?: string[] }'),
      apply_plan: a(api.patchPlanActions.apply, "{ patchPlanId } (an approved plan)"),
    },
    { destructive: true },
  ),
];
