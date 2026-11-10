"use node";

/**
 * After a meeting is logged (convex/granolaActions.ts), read what it changed:
 * the deal's next step and close date, and job titles people gave. Runs on the
 * ChatGPT plan of the person whose meeting it was; without one, nothing is
 * proposed. Only answers that quote the call word for word are proposed
 * (lib/conversations/facts.ts), through the write gate (convex/callFacts.ts).
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { resolveLlm } from "./lib/llmResolver";
import { clientFor, principalClient } from "./records";
import { CONVERSATION_FACTS_SCHEMA, conversationFactsPrompt, groundedFacts, groundedSuggestionRead, type ConversationFactsContext } from "./lib/conversations/facts";
import { externalParticipants } from "./lib/calls/granola";
import { planSuggestions, suggestionReason } from "./lib/calls/suggestions";
import { WHO_IS_PER_MEETING, type Identity, type NamedPerson } from "./lib/calls/whoIs";
import { domainOfEmail } from "./lib/calls/granola";
import { FREE_EMAIL_DOMAINS } from "../engine/src/freeEmailDomains.ts";
import { mentionResearcher, whoIsResearcher } from "./callSuggestionActions";
import { classifyConversation, gateSuggestions, jevClassifier } from "./lib/conversations/classify";

/** People named in one meeting that are researched (each costs a couple of searches on the owner's plan). */
const NAMED_RESEARCH_MAX = 3;

/** People and companies one meeting is checked against the register for. */
const MATCH_MAX = 50;

export const propose = internalAction({
  args: { orgId: v.id("organizations"), callId: v.id("callRecordings"), userId: v.id("users") },
  handler: async (ctx, args): Promise<{ proposed: number; suggested: number; skipped?: string }> => {
    const call = await ctx.runQuery(internal.callFacts.context, args);
    if (!call) return { proposed: 0, suggested: 0, skipped: "call or writer is gone" };

    // Who was on the call, with the job titles on record, read as the writer sees them (CP14).
    const access = await ctx.runQuery(internal.granola.writerAccess, { orgId: args.orgId, userId: args.userId });
    if (!access) return { proposed: 0, suggested: 0, skipped: "writer is no longer a member" };
    const client = principalClient(ctx, args.orgId, [access]);
    const contacts = (await Promise.all(call.contactIds.map((id) => client.getContact(args.orgId, id)))).flatMap((c) => (c ? [c] : []));
    const byEmail = new Map(contacts.flatMap((c) => (c.email ? [[c.email.toLowerCase(), c] as const] : [])));
    const people = call.attendees.flatMap((a) => {
      const contact = byEmail.get(a.email.toLowerCase());
      return contact ? [{ email: a.email, name: contact.fullName || a.name, title: contact.title || null }] : [];
    });

    // The other side's people and companies the register has no record of: what this meeting may suggest adding.
    // Existence is read across the whole register, so a record the writer's role hides is not suggested twice.
    const suggesting = !call.membersOnly || call.memberAttended;
    const { people: others, domains } = externalParticipants(
      { attendees: call.attendees, owner: call.ownerEmail ? { name: null, email: call.ownerEmail } : null }, call.teamAddresses,
    );
    const register = clientFor(ctx);
    const unknownEmails = others.map((p) => p.email.toLowerCase()).filter((e) => !byEmail.has(e));
    const [knownPeople, knownCompanies] = suggesting ? await Promise.all([
      unknownEmails.length ? register.listRegister(args.orgId, "contact", { filter: [{ field: "email", op: "in", value: unknownEmails }], limit: MATCH_MAX }) : { rows: [] },
      domains.length ? register.listRegister(args.orgId, "account", { filter: [{ field: "domain", op: "in", value: domains }], limit: MATCH_MAX }) : { rows: [] },
    ]) : [{ rows: [] }, { rows: [] }];
    const knownEmails = new Set([...byEmail.keys(), ...knownPeople.rows.flatMap((r) => (typeof r.values.email === "string" ? [r.values.email.toLowerCase()] : []))]);
    const knownDomains = new Set(knownCompanies.rows.flatMap((r) => (typeof r.values.domain === "string" ? [r.values.domain.toLowerCase()] : [])));
    const newPeople = suggesting ? others.filter((p) => !knownEmails.has(p.email.toLowerCase())) : [];
    const newDomains = suggesting ? domains.filter((d) => !knownDomains.has(d)) : [];

    const context: ConversationFactsContext = {
      source: { kind: "call", id: args.callId }, title: call.title, day: call.meetingDay, summary: call.summary, text: call.transcript,
      deal: call.recent && call.deal ? { name: call.deal.name, stage: call.deal.stage, nextStep: call.deal.nextStep, closeDate: call.deal.closeDate } : null,
      people: call.recent ? people : [],
      newPeople, newDomains,
      // Every meeting in the lookback is read for what it suggests adding: the company and people it names, and a
      // new deal (Ryan, 2026-10-12: Granola often lists no attendees, and the Example Buyer demo was four weeks old).
      askOpportunity: suggesting && !call.deal,
      askMentions: suggesting,
    };

    // A recent meeting is read by the model (on the writer's ChatGPT plan); an old one only suggests who was on it.
    const llm = call.recent || suggesting ? await resolveLlm(ctx, args.userId) : null;
    const wantsModel = Boolean(context.deal || context.people.length || newPeople.length || newDomains.length || context.askOpportunity || context.askMentions);
    let raw: unknown = null;
    let model = "";
    if (llm && wantsModel) {
      model = llm.model ?? DEFAULT_MODELS[llm.provider];
      raw = await forcedToolCall(conversationFactsPrompt(context, call.define), "crm_updates", CONVERSATION_FACTS_SCHEMA, model, llm);
    }

    // People on personal email: who they are professionally, researched for a recent meeting (a few per meeting,
    // on the same ChatGPT plan); the rest can be researched from the suggestions panel.
    const identities: Record<string, Identity> = {};
    const researched = new Set<string>();
    if (suggesting && llm && call.recent) {
      const whoIs = whoIsResearcher(llm, args.orgId);
      for (const p of newPeople.filter((x) => x.name && FREE_EMAIL_DOMAINS.has(domainOfEmail(x.email))).slice(0, WHO_IS_PER_MEETING)) {
        const email = p.email.toLowerCase();
        researched.add(email);
        const found = await whoIs(p, {
          title: call.title, summary: call.summary, transcript: call.transcript,
          ownerLabel: call.ownerName, oneOnOne: call.attendees.length === 1, webUrl: call.webUrl,
        });
        if (found) identities[email] = found;
      }
    }
    // The company the meeting named and its people: placed through public sources, skipping anyone the company already has.
    const read = raw ? groundedSuggestionRead(raw, context) : { companyNames: {}, titles: {}, opportunity: null };
    let mentions: Parameters<typeof planSuggestions>[0]["mentions"] = null;
    const named = read.mentioned?.company;
    if (suggesting && llm && named) {
      const research = mentionResearcher(llm, args.orgId);
      const company = await research.company(named.name, named.searchHint, named.evidence);
      const account = company
        ? (await register.listRegister(args.orgId, "account", { filter: [{ field: "domain", op: "eq", value: company.companyDomain }], limit: 1 })).rows[0]
        : undefined;
      const existingNames = account ? new Set((await register.listContacts(args.orgId, { filter: { accountId: account.id }, limit: 200 })).rows.map((c) => c.fullName.toLowerCase())) : new Set<string>();
      // Never the note's owner or the workspace's members: the model sometimes lists the owner among the people named.
      const attendeeNames = new Set([...call.attendees.flatMap((a) => (a.name ? [a.name] : [])), call.ownerName, ...call.memberNames]
        .map((n) => n.toLowerCase().split(" ")[0]!).filter(Boolean));
      const people: Array<{ name: string; evidence: string; found?: NamedPerson | null }> = [];
      for (const pp of (read.mentioned?.people ?? []).filter((x) => !attendeeNames.has(x.name.toLowerCase().split(" ")[0]!)).slice(0, NAMED_RESEARCH_MAX)) {
        // Only a company research placed can place its people; an unidentified one keeps the names the meeting used.
        const found = company ? await research.person(pp.name, company, pp.evidence) : null;
        const fullName = (found?.fullName ?? pp.name).toLowerCase();
        if ([...existingNames].some((n) => n === fullName || (!found && n.startsWith(`${pp.name.toLowerCase()} `)))) continue;
        people.push({ ...pp, found });
      }
      if (account && company) knownDomains.add(company.companyDomain);
      mentions = { name: named.name, company, evidence: named.evidence, people };
    }
    // Only a sales meeting suggests a deal; a vendor's pitch, a customer check-in or an interview does not.
    const jevKey = integrationEnabled("jev") ? process.env.JEV_API_KEY : undefined;
    const classification = suggesting ? await classifyConversation({
      channel: "call", title: call.title, summary: call.summary, text: call.transcript, customer: call.customer, openDeal: Boolean(call.deal),
    }, jevKey ? jevClassifier(jevKey) : null) : null;
    const planned = suggesting && classification ? gateSuggestions(classification, planSuggestions({
      callKey: args.callId, attendees: newPeople, knownEmails, knownDomains, meetingDomains: domains, identities, researched, now: Date.now(),
      hasDeal: Boolean(call.deal), recent: call.recent,
      read, mentions,
    })) : [];
    // Recorded every time, with why, so the Granola page can say why a meeting suggested nothing.
    const suggested: number = await ctx.runMutation(internal.callSuggestions.record, {
      orgId: args.orgId, callId: args.callId, userId: args.userId, suggestions: planned,
      reason: suggestionReason({ ourMeeting: suggesting, others: others.length, planned: planned.length }),
    });

    const facts = raw ? groundedFacts(raw, context).map((f) =>
      f.entityType === "opportunity" ? f : { entityType: f.entityType, contactId: byEmail.get(f.email.toLowerCase())!.id, attribute: f.attribute, value: f.value, evidence: f.evidence }) : [];
    if (!facts.length) return { proposed: 0, suggested, ...(llm ? {} : { skipped: call.recent ? "no ChatGPT plan connected" : "older meeting: suggestions only" }) };
    const result = await ctx.runMutation(internal.callFacts.submit, {
      orgId: args.orgId, userId: args.userId, callId: args.callId, model: `${llm!.provider}:${model}`, facts,
      ...(call.deal ? { dealId: call.deal.id as Id<"deals"> } : {}),
    });
    return { proposed: result?.proposed ?? 0, suggested };
  },
});
