"use node";

/**
 * The parts of a deal's play that read the web (docs/deal-plays.md):
 * adding cited items, whose quotes Canon checks against the cited page, and
 * the research run, which searches with the starter's ChatGPT plan, reads
 * the results and drafts the brief, the map notes and a first plan.
 * The prompts are the workspace recipe's; everything it saves passes
 * lib/plays/research.ts's screen first.
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_MODELS, chatgptWebSearch, forcedToolCall } from "../engine/src/llm.ts";
import { resolveLlm } from "./lib/llmResolver";
import { canonResearchLlm } from "./lib/canonModel";
import { RECORD_MICRO } from "./lib/research/runPlan";
import { principalClient, requireCaller } from "./records";
import { may, type Access } from "./lib/access";
import { peopleOfCompany, rowsById } from "./associations";
import { fetchPage, googleSearch } from "./researchAgentActions";
import { locateQuote, type FetchedPage } from "./lib/research/agentLoop";
import { unreadable } from "./lib/research/webSearch";
import { buildPlane, changePlay, type ItemInput, type PlaneCaller } from "./dealPlays";
import { jevSystemOne } from "./lib/segments/jev";
import { employment, PEOPLE_RESEARCH_MAX, PEOPLE_RESEARCH_POLL_MS, PEOPLE_RESEARCH_WAIT_MS, type Center } from "./lib/plays/peopleResearch";
import { playItemKind } from "./lib/plays/validators";
import { screenFindings, type ResearchSubject } from "./lib/plays/research";
import { BRIEF_TOOL, PLAN_TOOL, briefSchema, planSchema, researchLimits } from "./lib/plays/runs";
import { playsFor } from "./lib/recipes";
import { checkJobChanges, enrichCompany, enrichPeople } from "./lib/researchEnrich";
import { brandName } from "./lib/research/agentLoop";
import { runPlays } from "./lib/recipeRuntime";

/** Items one call may add, and pages it reads at once to check them. */
const ADD_MAX = 25;
const FETCH_CONCURRENCY = 4;
/** One run's ceiling, inside Convex's 10-minute action limit. */
const RUN_MS = 5 * 60_000;

async function pool<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/**
 * Add evidence to a deal's brief. An item with a quote and a source is `verified` when Canon finds the quote word
 * for word in that page, `unverified` when it doesn't (or can't read the page); one without a source is `none`.
 * This is how an outside agent (over /mcp) writes the research it did.
 */
export const addItems = action({
  args: {
    streamId: v.string(),
    items: v.array(v.object({ kind: playItemKind, text: v.string(), quote: v.optional(v.string()), sourceUrl: v.optional(v.string()), occurredOn: v.optional(v.string()) })),
  },
  handler: async (ctx, args): Promise<{ added: number; verified: number; unverified: number }> => {
    if (args.items.length > ADD_MAX) throw new ConvexError(`Add at most ${ADD_MAX} items at a time`);
    // Authorize before reading any page the caller names.
    const caller = await requireCaller(ctx);
    if (!may(caller.access, "deal", "edit")) throw new ConvexError("Your role cannot edit deal records");
    const loaded = await ctx.runQuery(internal.dealPlays.load, {
      orgId: caller.orgId as Id<"organizations">, userId: caller.userId as Id<"users">, streamId: args.streamId, access: caller.access,
    });
    if (!loaded?.canEdit) throw new ConvexError(loaded ? "Only admins, managers and the deal's owner can change its play" : "Deal not found");
    const checked: ItemInput[] = await pool(args.items, FETCH_CONCURRENCY, async (it): Promise<ItemInput> => {
      const quote = it.quote?.trim();
      const url = it.sourceUrl?.trim();
      if (!url || !/^https?:\/\//i.test(url)) return { ...it, sourceUrl: undefined, evidence: "none" };
      if (!quote) return { ...it, sourceUrl: url, evidence: "unverified" };
      const page = await fetchPage(url).catch(() => null);
      return { ...it, quote, sourceUrl: url, evidence: page && locateQuote(quote, [page], url) ? "verified" : "unverified" };
    });
    await changePlay(ctx, args.streamId, { op: "addItems", items: checked });
    return {
      added: checked.length,
      verified: checked.filter((i) => i.evidence === "verified").length,
      unverified: checked.filter((i) => i.evidence === "unverified").length,
    };
  },
});

/**
 * Research the deal's account in the background, on the starter's ChatGPT plan. Without one it runs on Canon's
 * research model and costs one research credit once it lands (docs/credits.md CR4). Watch `research` on dealPlays.get.
 */
export const research = action({
  args: { streamId: v.string() },
  handler: async (ctx, args): Promise<{ started: true }> => {
    const caller = await requireCaller(ctx);
    if (!may(caller.access, "deal", "edit")) throw new ConvexError("Your role cannot edit deal records");
    const orgId = caller.orgId as Id<"organizations">;
    const userId = caller.userId as Id<"users">;
    const loaded = await ctx.runQuery(internal.dealPlays.load, { orgId, userId, streamId: args.streamId, access: caller.access });
    if (!loaded) throw new ConvexError("Deal not found");
    if (!loaded.deal.companyId) throw new ConvexError("Link this deal to a company first");
    const onCredits = !(await resolveLlm(ctx, userId));
    if (onCredits) {
      if (!canonResearchLlm()) throw new ConvexError("Research runs on your ChatGPT plan. Sign in with ChatGPT under Integrations → ChatGPT.");
      await ctx.runQuery(internal.researchAgents.checkResearchCredits, { orgId });
    }
    // The company's profile first (1 credit if found): it fills the account's empty fields and adds its columns.
    const account = (await principalClient(ctx, orgId, [caller.access]).get(orgId, loaded.deal.companyId))?.account;
    if (account?.domain) {
      await enrichCompany(ctx, caller, { id: account.id, domain: account.domain, employees: account.employees, industry: account.industry, country: account.country, linkedinUrl: account.linkedinUrl });
    }
    // The questions the deal's gaps raise right now (the recipe's prep): the run aims its searches at them.
    const questions = (await buildPlane(ctx, caller, args.streamId))?.prep.questions ?? [];
    const startedAt = await ctx.runMutation(internal.dealPlays.claimResearch, { orgId, userId, streamId: args.streamId });
    await ctx.scheduler.runAfter(0, internal.dealPlayActions.runResearch, { orgId, userId, streamId: args.streamId, startedAt, access: caller.access, questions, ...(onCredits ? { onCredits: true } : {}) });
    return { started: true };
  },
});

export const runResearch = internalAction({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string(), startedAt: v.number(), access: v.any(), questions: v.optional(v.array(v.string())), onCredits: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<null> => {
    const { orgId, userId, streamId, startedAt } = args;
    const questions = (args.questions ?? []).slice(0, 5);
    const fail = async (error: string): Promise<null> => ctx.runMutation(internal.dealPlays.failResearch, { orgId, streamId, startedAt, error });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RUN_MS);
    const signal = controller.signal;
    try {
      const llm = args.onCredits ? canonResearchLlm() : await resolveLlm(ctx, userId);
      if (!llm) return await fail(args.onCredits ? "Canon's research model isn't configured on this deployment." : "Your ChatGPT sign-in is missing or expired. Sign in under Integrations → ChatGPT and run it again.");
      // Search: ChatGPT's own on its plan; on Canon's model, Google through treg where paid calls are on (else none).
      const google = llm.provider === "chatgpt" ? undefined : googleSearch(orgId);
      const model = llm.model ?? DEFAULT_MODELS[llm.provider];
      const call = (prompt: string, tool: string, schema: object) =>
        forcedToolCall(prompt, tool, schema, model, { ...llm, fetchImpl: (input, init) => fetch(input, { ...init, signal }) });

      // It reads only what its starter sees (CP14).
      const access = args.access as Access;
      const client = principalClient(ctx, orgId, [access]);
      const [loaded, committee] = await Promise.all([
        ctx.runQuery(internal.dealPlays.load, { orgId, userId, streamId, access }),
        ctx.runQuery(internal.dealCommittee.dealPeople, { orgId, userId, streamId, access }),
      ]);
      if (!loaded || !committee) return await fail("The deal is gone, or you no longer see it.");
      const companyId = loaded.deal.companyId;
      if (!companyId) return await fail("Link this deal to a company first.");
      const [companyRows, companyPeople, contacts] = await Promise.all([
        rowsById(client, orgId, "account", [companyId]),
        peopleOfCompany(ctx, client, orgId, companyId),
        rowsById(client, orgId, "contact", committee.members.map((m) => m.contactId)),
      ]);
      const company = companyRows.get(companyId);
      const domain = company && typeof company.values.domain === "string" ? company.values.domain : "";
      if (!company || !domain) return await fail("The deal's company has no domain to research.");
      const roleOf = new Map(committee.members.map((m) => [m.contactId, m.role]));
      const known = new Map<string, { id: string; name: string; title: string | null }>();
      for (const p of companyPeople) known.set(p.id, { id: p.id, name: p.name, title: p.title });
      for (const [id, row] of contacts) if (!known.has(id) && row.title) known.set(id, { id, name: row.title, title: typeof row.values.title === "string" ? row.values.title : null });
      const subject: ResearchSubject = {
        company: company.title || domain, domain, dealName: loaded.deal.name, context: loaded.play?.context ?? null,
        people: [...known.values()].filter((p) => roleOf.has(p.id)).map((p) => ({ name: p.name, title: p.title, role: roleOf.get(p.id) ?? null })),
        questions,
      };

      const now = new Date();
      const [planPrompt] = await runPlays(ctx, loaded.recipe, [{ fn: "research.planPrompt", input: [subject, now.getUTCFullYear()] }]);
      const plays = playsFor(loaded.recipe);
      const limits = researchLimits(plays);
      const planned = (await call(planPrompt, PLAN_TOOL, planSchema(plays))) as { queries?: unknown };
      const plannedQueries = (Array.isArray(planned?.queries) ? planned.queries : []).map(String).map((q) => q.trim()).filter(Boolean);
      const queries = (plannedQueries.length ? plannedQueries : [`"${subject.company}" news`, `"${subject.company}" leadership team`]).slice(0, limits.searches);

      const pages: FetchedPage[] = [];
      const seen = new Set<string>();
      const keep = (p: FetchedPage | null) => {
        if (!p?.text || seen.has(p.url) || pages.length >= limits.pages) return;
        seen.add(p.url);
        pages.push(p);
      };
      keep(await fetchPage(`https://${domain}/`).catch(() => null));
      let searches = 0;
      for (const q of queries) {
        if (signal.aborted) break;
        searches++;
        if (google) {
          const rows = await google(q.slice(0, 200)).catch(() => []);
          // Google's own snippet of a result counts as evidence like a page, as research agents read it.
          for (const r of rows) if (r.snippet) keep({ url: r.url, text: `${r.title} ${r.snippet}`.trim(), links: [], snippet: true });
          continue;
        }
        if (llm.provider !== "chatgpt") continue;
        const hits = await chatgptWebSearch(q.slice(0, 200), model, { ...llm, signal }).catch(() => []);
        // A result's title is the search engine's own words about the page: kept as a snippet, as research agents do.
        for (const h of hits) if (h.title && unreadable(h.url)) keep({ url: h.url, text: h.title, links: [], snippet: true });
        const readable = hits.filter((h) => !unreadable(h.url) && !seen.has(h.url)).slice(0, limits.readsPerSearch);
        for (const page of await Promise.all(readable.map((h) => fetchPage(h.url).catch(() => null)))) keep(page);
      }
      if (!pages.length) return await fail("Canon couldn't read the company's site or any search result.");

      const today = now.toISOString().slice(0, 10);
      const [briefPrompt] = await runPlays(ctx, loaded.recipe, [{ fn: "research.briefPrompt", input: [subject, pages, today] }]);
      const raw = await call(briefPrompt, BRIEF_TOOL, briefSchema(plays, loaded.recipe.settings, questions.length));
      const screened = screenFindings(raw, pages, [...known.values()], today, questions);
      await ctx.runMutation(internal.dealPlays.saveResearch, {
        orgId, streamId, startedAt,
        brief: { whyNow: screened.whyNow, alphaHypothesis: screened.alphaHypothesis, alphaPitch: screened.alphaPitch },
        items: screened.items,
        people: screened.people.map((p) => ({ ...p, suggestedRole: roleOf.has(p.contactId) ? undefined : p.suggestedRole ?? undefined })),
        steps: screened.steps,
        stats: { searches, pages: pages.length, dropped: screened.dropped },
        answers: screened.answers,
      });
      // Research on Canon's model costs one credit when it found something; a run that failed or kept nothing is free.
      if (args.onCredits && (screened.items.length || screened.people.length)) {
        const ref = `deal-research:${orgId}:${streamId}:${startedAt}`;
        const paid = await ctx.runMutation(internal.credits.charge, { orgId, ref, amountMicro: RECORD_MICRO, note: `Deal research: ${subject.company}` });
        if (paid) await ctx.runAction(internal.credits.meterCharge, { ref, provider: "research" }).catch((e) => console.warn(`deal research: Metronome report failed: ${e instanceof Error ? e.message.slice(0, 160) : e}`));
        else console.warn(`deal research: ${streamId} landed but the workspace could not pay its credit`);
      }
    } catch (error) {
      await fail(signal.aborted ? "Research ran out of time. Run it again." : error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
    return null;
  },
});

// ───────────────────────────── People research ─────────────────────────────

/**
 * Check whether the deal's people (by record id) still work at its company (lib/researchEnrich.ts checkJobChanges):
 * those with a profile URL, at most monthly each. Returns who left, and a note saying where they went.
 */
export async function checkDealPeople(
  ctx: ActionCtx, caller: { orgId: string; userId: string; access: Access }, deal: { companyId: string | null; companyName: string | null }, employedSlug: string, contactIds: readonly string[],
): Promise<{ departed: Set<string>; note: string | null }> {
  if (!deal.companyId || !contactIds.length) return { departed: new Set(), note: null };
  const client = principalClient(ctx, caller.orgId, [caller.access]);
  const account = (await client.get(caller.orgId, deal.companyId))?.account;
  if (!account) return { departed: new Set(), note: null };
  const company = brandName(deal.companyName ?? account.name);
  const contacts = await Promise.all(contactIds.map((id) => client.getContact(caller.orgId, id)));
  const people = contacts.flatMap((c) => (c?.linkedinUrl ? [{ id: c.id, fullName: c.fullName, linkedinUrl: c.linkedinUrl, title: c.title, email: c.email, updatedAt: c.updatedAt, company }] : []));
  const { departures, note } = await checkJobChanges(ctx, caller, people, employedSlug);
  return { departed: new Set(departures.map((d) => d.id)), note };
}

/**
 * Start researching people at the deal's account as `userId`, on their plan (issue #394, lib/plays/peopleResearch.ts):
 * the recipe's people fields run over them, then finishPeopleResearch reads the answers into each one's remit and capability.
 * The keeper calls this weekly as the deal's owner. Returns a note on any field that couldn't run now.
 */
export async function startPeopleResearch(ctx: ActionCtx, caller: PlaneCaller, streamId: string, contactIds: readonly string[], onCredits = false): Promise<string | null> {
  const orgId = caller.orgId as Id<"organizations">;
  const userId = caller.userId as Id<"users">;
  const claimed: { startedAt: number; runIds: Id<"researchRuns">[]; note: string | null } = await ctx.runMutation(internal.dealPlays.claimPeopleResearch, {
    orgId, userId, streamId, contactIds: [...contactIds], ...(onCredits ? { onCredits: true } : {}),
  });
  await ctx.scheduler.runAfter(claimed.runIds.length ? PEOPLE_RESEARCH_POLL_MS : 0, internal.dealPlayActions.finishPeopleResearch, {
    orgId, userId, streamId, startedAt: claimed.startedAt, access: caller.access, ...(onCredits ? { onCredits: true } : {}),
  });
  return claimed.note;
}

/** Research the chosen people at the deal's account now, as the caller and on their ChatGPT plan. Watch `peopleResearch`. */
export const researchPeople = action({
  args: { streamId: v.string(), contactIds: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ note: string | null }> => {
    const caller = await requireCaller(ctx);
    if (!may(caller.access, "deal", "edit")) throw new ConvexError("Your role cannot edit deal records");
    if (args.contactIds.length > PEOPLE_RESEARCH_MAX) throw new ConvexError(`Research at most ${PEOPLE_RESEARCH_MAX} people at a time`);
    const plane = await buildPlane(ctx, caller, args.streamId);
    if (!plane) throw new ConvexError("Deal not found");
    // Only people this deal lists for the caller: the runs research whoever they're given.
    const listed = new Set(plane.prospects.flatMap((p) => (p.contactId ? [p.contactId] : [])));
    const contactIds = args.contactIds.filter((id) => listed.has(id));
    if (!contactIds.length) throw new ConvexError("Choose people at this deal's account");
    // Without a ChatGPT plan the people fields run on Canon's research model and spend credits.
    const onCredits = !(await resolveLlm(ctx, caller.userId as Id<"users">));
    if (onCredits && !canonResearchLlm()) throw new ConvexError("Research runs on your ChatGPT plan. Sign in with ChatGPT under Integrations → ChatGPT.");
    // Each person's profile first (1 credit each found): it fills their empty fields, and research reads it as
    // their own page.
    const client = principalClient(ctx, caller.orgId, [caller.access]);
    const domain = plane.deal.companyId ? (await client.get(caller.orgId, plane.deal.companyId))?.account.domain ?? "" : "";
    const people = domain ? (await Promise.all(contactIds.map((id) => client.getContact(caller.orgId, id)))).flatMap((c) => (c ? [{ id: c.id, fullName: c.fullName, title: c.title, linkedinUrl: c.linkedinUrl, domain }] : [])) : [];
    const enriched = await enrichPeople(ctx, caller, people);
    // Then whether each still works there (8 credits a check, at most monthly): someone who left isn't researched here.
    const checked = await checkDealPeople(ctx, caller, plane.deal, plane.recipeData.peopleSlugs.employed, contactIds);
    const staying = contactIds.filter((id) => !checked.departed.has(id));
    const note = staying.length ? await startPeopleResearch(ctx, caller, args.streamId, staying, onCredits) : null;
    return { note: [enriched.note, checked.note, note].filter(Boolean).join(" ") || null };
  },
});

/**
 * Once the people fields' runs finish (or PEOPLE_RESEARCH_WAIT_MS passes), read each person's answers: Jev calls their
 * remit innovation or stability, and the model writes the capability the seller's product could give them.
 */
export const finishPeopleResearch = internalAction({
  args: { orgId: v.id("organizations"), userId: v.id("users"), streamId: v.string(), startedAt: v.number(), access: v.any(), onCredits: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<null> => {
    const { orgId, userId, streamId, startedAt } = args;
    const fail = (error: string) => ctx.runMutation(internal.dealPlays.failPeopleResearch, { orgId, streamId, startedAt, error });
    try {
      const loaded = await ctx.runQuery(internal.dealPlays.load, { orgId, userId, streamId, access: args.access });
      const state = loaded?.play?.peopleResearch;
      if (!state || state.status !== "running" || state.startedAt !== startedAt) return null;
      if (Date.now() - startedAt < PEOPLE_RESEARCH_WAIT_MS && await ctx.runQuery(internal.researchAgents.runsLive, { runIds: state.runIds })) {
        await ctx.scheduler.runAfter(PEOPLE_RESEARCH_POLL_MS, internal.dealPlayActions.finishPeopleResearch, args);
        return null;
      }
      const caller = await ctx.runQuery(internal.dealPlays.principalCaller, { orgId, userId });
      const plane = caller ? await buildPlane(ctx, caller, streamId) : null;
      if (!plane) { await fail("The deal is no longer visible to whoever started this research."); return null; }
      const { people: spec } = playsFor(plane.recipe);
      const people = plane.prospects.filter((p) => p.contactId && state.contactIds.includes(p.contactId));
      const answers: Record<string, Record<string, { value: unknown; evidence: string | null }>> = await ctx.runQuery(internal.researchAgents.peopleAnswers, {
        orgId, access: args.access, recordIds: people.map((p) => p.contactId!),
      });
      const text = (contactId: string, slug: string) => {
        const value = answers[contactId]?.[slug]?.value;
        return typeof value === "string" && value.trim() && value !== "unknown" ? value.trim() : null;
      };
      // Someone research found has left the company gets no remit or capability: there is nothing there to sell them.
      const left = people.filter((p) => employment(answers[p.contactId!]?.[spec.slugs.employed]) === false);
      const rows = people.filter((p) => !left.includes(p))
        .map((p) => ({ contactId: p.contactId!, name: p.name, title: p.title, goal: text(p.contactId!, spec.slugs.goal), systems: text(p.contactId!, spec.slugs.systems) }));
      const notes: string[] = left.length ? [`${left.map((p) => p.name).join(", ")} no longer ${left.length === 1 ? "works" : "work"} at ${plane.deal.companyName ?? "the account"}.`] : [];

      // Jev: innovation or stability, from the title and the researched goal.
      const key = integrationEnabled("jev") ? process.env.JEV_API_KEY : undefined;
      const centers = new Map<string, { center: Center; confidence: number }>();
      if (!key) notes.push("Jev is not configured, so no innovation or stability call.");
      else {
        await pool(rows.filter((r) => r.title || r.goal), 4, async (r) => {
          const out = await jevSystemOne(key, { title: r.title, goal: r.goal }, { center: spec.center }, {
            fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
          }).catch(() => null);
          const a = out?.answers.center;
          if (a?.type === "choice" && (a.choice === "innovation" || a.choice === "stability")) centers.set(r.contactId, { center: a.choice, confidence: a.confidence });
        });
      }

      // The capability hypothesis: only with something that says what the seller sells, and some research to tie it to.
      const [product] = await runPlays(ctx, plane.recipe, [{ fn: "people.productContext", input: [{ context: plane.brief.context }, plane.pointOfView] }]);
      const researched = rows.filter((r) => r.goal || r.systems);
      let capabilities = new Map<string, string | null>();
      // Started without a ChatGPT plan: the one capability call for the deal runs on Canon's research model.
      const llm = researched.length && product ? (await resolveLlm(ctx, userId)) ?? (args.onCredits ? canonResearchLlm() : null) : null;
      if (!product) notes.push("Add a product brief or an ICP point of view to get each person's new capability.");
      else if (researched.length && !llm) notes.push("Sign in with ChatGPT under Integrations → ChatGPT to get each person's new capability.");
      else if (llm) {
        const [prompt] = await runPlays(ctx, plane.recipe, [{ fn: "people.capability.prompt", input: [{ company: plane.deal.companyName ?? "the account", product, people: researched }] }]);
        const raw = await forcedToolCall(prompt, spec.capability.tool, spec.capability.schema, llm.model ?? DEFAULT_MODELS[llm.provider], llm).catch((cause) => {
          notes.push(`The capability step failed: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause)}.`);
          return null;
        });
        const [cleaned] = await runPlays(ctx, plane.recipe, [{ fn: "people.capability.clean", input: [raw, researched.map((r) => r.contactId)] }]);
        capabilities = new Map(cleaned);
      }

      await ctx.runMutation(internal.dealPlays.savePeopleResearch, {
        orgId, streamId, startedAt, ...(notes.length ? { note: notes.join(" ") } : {}),
        people: [
          ...rows.map((r) => {
            const c = centers.get(r.contactId);
            const capability = capabilities.get(r.contactId);
            return { contactId: r.contactId, ...(c ? { center: c.center, centerConfidence: c.confidence } : {}), ...(capability ? { capability } : {}) };
          }),
          // Saved with nothing, which clears a remit or capability an earlier run wrote while they were still there.
          ...left.map((p) => ({ contactId: p.contactId! })),
        ],
      });
    } catch (cause) {
      await fail(cause instanceof Error ? cause.message : String(cause));
    }
    return null;
  },
});
