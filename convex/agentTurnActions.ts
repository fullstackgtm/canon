"use node";

/**
 * Run one event agent turn (convex/agentTurns.ts): resolve the event's
 * account in the agent's workspace, ask each of the agent's AI fields about it
 * with the research loop (lib/research/agentLoop.ts) on the OWNER's ChatGPT
 * plan, and hand the answers to finishTurn, which submits them to the write
 * gate. Every model call is charged to the turn's budget before it is made.
 * When the agent has a route, a finished turn then adds the event's contact
 * to the route's audience if the answers qualify (lib/agents/routing.ts).
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { resolveLlm } from "./lib/llmResolver";
import { principalClient } from "./records";
import { fetchPage } from "./researchAgentActions";
import { isFactualField, evidenceText, researchCompany, saveBatches, type FetchedPage } from "./lib/research/agentLoop";
import { runtimeExtractor } from "./lib/research/factualExtraction";
import { BudgetExhausted, SKIP_REASONS, findAccount, turnMeter } from "./lib/agents/webhook";
import { findContact, qualifies, type QualifyRule } from "./lib/agents/routing";

type Output = { fieldSlug: string; label: string; status: string; value?: string | number | boolean; reason?: string };
type Fact = { fieldSlug: string; entityId: string; value: string | number | boolean; evidence: string; confidence: number };
type Account = { recordId: string; entityId: Id<"canonEntities">; name: string; domain: string };
type RouteOutcome =
  | { kind: "not_qualified" | "no_contact" | "error"; message: string }
  | { kind: "contact"; contactId: string; email: string; name: string };

export const runTurn = internalAction({
  args: { turnId: v.id("agentTurns") },
  handler: async (ctx, args): Promise<null> => {
    const started = Date.now();
    const loaded = await ctx.runQuery(internal.agentTurns.loadTurn, args);
    if (!loaded || !(await ctx.runMutation(internal.agentTurns.startTurn, args))) return null;
    const { turn, ownerUserId, budget, fields, principals } = loaded;
    const client = principals && principalClient(ctx, turn.orgId as string, principals);
    const spend = { modelCalls: 0, tokens: 0, pagesRead: 0, ms: 0 };
    const finish = (
      r: { status: "done" | "skipped" | "failed"; skip?: { reason: string; message: string }; error?: string },
      more: { account?: Account; outputs?: Output[]; facts?: Fact[]; budgetHit?: "tokens" | "time" } = {},
    ) => ctx.runMutation(internal.agentTurns.finishTurn, {
      turnId: args.turnId, ...r, outputs: more.outputs ?? [], facts: more.facts ?? [],
      ...(more.account ? { account: more.account } : {}), ...(more.budgetHit ? { budgetHit: more.budgetHit } : {}),
      spend: { ...spend, ms: Date.now() - started },
    });
    /** The route's verdict on the finished turn; a lookup error is recorded on the turn, never fails it. */
    const route = async (outputs: Output[], r: { audienceId: Id<"audiences">; rule?: QualifyRule }) => {
      const record = (outcome: RouteOutcome) => ctx.runMutation(internal.agentTurns.routeTurn, { turnId: args.turnId, audienceId: r.audienceId, outcome });
      try {
        const verdict = qualifies(r.rule, outputs);
        const email = turn.subject.email;
        if (!verdict.ok) return await record({ kind: "not_qualified", message: verdict.message });
        if (!email) return await record({ kind: "no_contact", message: "Qualified, but the event has no email to find the contact by." });
        // Existing contacts only: creating one here would write a record outside the ledger's gates.
        const contact = await findContact(client!, turn.orgId as string, email);
        if (contact === "ambiguous") return await record({ kind: "no_contact", message: `Qualified, but several contacts have ${email}.` });
        if (!contact) return await record({ kind: "no_contact", message: `Qualified, but no contact in this workspace has ${email}.` });
        await record({ kind: "contact", contactId: contact.id, email, name: contact.fullName || email });
      } catch (error) {
        await record({ kind: "error", message: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      }
    };
    const skipped = (reason: keyof typeof SKIP_REASONS) => finish({ status: "skipped", skip: { reason, message: SKIP_REASONS[reason] } });
    try {
      const llm = await resolveLlm(ctx, ownerUserId);
      if (!llm) { await skipped("owner_not_connected"); return null; }
      // It reads only what its owner (and a test turn's runner) sees (CP14); without them it reads nothing.
      if (!client) { await finish({ status: "failed", error: "The agent's owner, or the person who ran this test, is no longer a member of this workspace." }); return null; }
      // A deal event's account comes from its deal; the turn records it only once its principals' client finds it.
      const domain = loaded.domain;
      const row = domain ? await findAccount(client, turn.orgId as string, domain) : null;
      if (!row || !domain) { await skipped("no_account"); return null; }
      const [promoted] = await ctx.runMutation(internal.canonEntities.anchorAccounts, {
        orgId: turn.orgId, accounts: [{ recordId: row.id, domain, name: row.name }],
      });
      const account: Account = { recordId: row.id, entityId: promoted.entityId, name: row.name, domain };

      const meter = turnMeter(budget, started);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budget.maxSeconds * 1000);
      const model = llm.model ?? DEFAULT_MODELS[llm.provider];
      const call = (prompt: string, tool: string, schema: object) => {
        meter.charge(prompt);
        return forcedToolCall(prompt, tool, schema, model, { ...llm, fetchImpl: (input, init) => fetch(input, { ...init, signal: controller.signal }) });
      };
      const outputs: Output[] = [];
      const facts: Fact[] = [];
      const pages = new Map<string, FetchedPage>();
      let budgetHit: "tokens" | "time" | undefined;
      try {
        const homepage = await fetchPage(`https://${domain}/`);
        for (const f of fields) {
          if (budgetHit) { outputs.push({ fieldSlug: f.slug, label: f.label, status: "not_asked", reason: `The turn's ${budgetHit} budget ran out.` }); continue; }
          try {
            const r = await researchCompany(f.spec, { name: row.name, domain }, { fetchPage, call, ...(isFactualField(f.spec) ? { extract: runtimeExtractor({ signal: controller.signal, chargeBeforeDispatch: (prompt) => meter.charge(prompt) }) } : {}), homepage, maxReads: budget.maxRounds, signal: controller.signal });
            for (const p of r.pages) pages.set(p.url, p);
            const fd = r.finding;
            if (fd.status === "answered" && fd.value !== null) {
              outputs.push({ fieldSlug: f.slug, label: f.label, status: "answered", value: fd.value });
              facts.push({ fieldSlug: f.slug, entityId: promoted.entityId, value: fd.value, evidence: evidenceText(fd), confidence: fd.confidence });
            } else {
              outputs.push({ fieldSlug: f.slug, label: f.label, status: fd.status === "answered" ? "unknown" : fd.status, reason: "reason" in fd ? fd.reason : undefined });
            }
          } catch (error) {
            const hit = error instanceof BudgetExhausted ? error.limit : controller.signal.aborted ? "time" : undefined;
            if (hit) budgetHit = hit;
            outputs.push({ fieldSlug: f.slug, label: f.label, status: hit ? "not_asked" : "error", reason: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
          }
        }
      } finally {
        clearTimeout(timer);
      }
      spend.modelCalls = meter.spent.modelCalls;
      spend.tokens = meter.spent.tokens;
      spend.pagesRead = pages.size;
      for (const batch of saveBatches([...pages.values()])) await ctx.runMutation(internal.researchAgents.savePages, { orgId: turn.orgId, pages: batch });
      const finished = await finish({ status: "done" }, { account, outputs, facts, ...(budgetHit ? { budgetHit } : {}) });
      if (finished?.status === "done" && loaded.route) await route(finished.outputs, loaded.route);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`agent turn ${args.turnId} failed: ${message}`);
      await finish({ status: "failed", error: message });
    }
    return null;
  },
});
