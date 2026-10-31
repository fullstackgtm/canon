"use node";

/**
 * One extraction pass over an email thread or LinkedIn conversation (convex/conversationExtract.ts claims it). Runs
 * on the ChatGPT plan of the conversation's owner, as them: without a plan nothing is read. Only answers that quote
 * the thread word for word are proposed (lib/conversations/facts.ts), through the facts ledger with the thread's kind
 * as their source (callFacts.submitConversation), so the org's auto-accept rules per (source, attribute) apply. A
 * counterpart the CRM does not have is suggested, never created (lib/conversations/extract.ts).
 */
import { integrationEnabled } from "./lib/integrationsAvailable.ts";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { DEFAULT_MODELS, forcedToolCall } from "../engine/src/llm.ts";
import { resolveLlm } from "./lib/llmResolver";
import { clientFor, principalClient } from "./records";
import { CONVERSATION_FACTS_SCHEMA, conversationFactsPrompt, groundedFacts, groundedSuggestionRead, threadText, type ConversationFactsContext } from "./lib/conversations/facts";
import { contactBySlug } from "./lib/conversations/intake";
import { conversationSuggestions, personKey, slugOfCounterpart, unknownCounterpart } from "./lib/conversations/extract";
import type { ContactRow } from "./lib/recordContract";
import { classifyConversation, gateSuggestions, jevClassifier } from "./lib/conversations/classify";

type Outcome = { proposed: number; suggested: number; skipped?: string };

export const extract = internalAction({
  args: { conversationId: v.id("conversations"), lease: v.number() },
  handler: async (ctx, args): Promise<Outcome> => {
    // A counterpart intake matched to no one and this pass found.
    let matched: string | undefined;
    const skip = async (skipped: string): Promise<Outcome> => {
      await ctx.runMutation(internal.conversationExtract.finish, { ...args, skipped, ...(matched ? { contactId: matched } : {}) });
      return { proposed: 0, suggested: 0, skipped };
    };
    const c = await ctx.runQuery(internal.conversationExtract.context, { conversationId: args.conversationId });
    if ("skip" in c) return skip(c.skip);
    const llm = await resolveLlm(ctx, c.ownerUserId);
    if (!llm) return skip("no ChatGPT plan connected");

    // The people the conversation was matched to, as its owner sees them (CP14).
    const client = principalClient(ctx, c.orgId, [c.access]);
    const register = clientFor(ctx);
    const contacts = (await Promise.all(c.contactIds.map((id) => client.getContact(c.orgId, id)))).flatMap((x) => (x ? [x] : []));

    // An unmatched counterpart is checked against the whole register (a record the owner's role hides is not
    // suggested twice); one added since intake matched nothing is read as matched when the owner sees it, with the
    // open deal they are on, and matches the conversation from now on.
    let deal = c.deal;
    let unknown = contacts.length || c.contactIds.length ? null : unknownCounterpart(c.channel, c.counterpart);
    let domainAccount: { id: string; domain: string } | null = null;
    if (unknown) {
      let found: string | null = null;
      if (c.channel === "email") {
        found = (await register.listRegister(c.orgId, "contact", { filter: [{ field: "email", op: "eq", value: unknown.key }], limit: 1 })).rows[0]?.id ?? null;
      } else {
        const slug = slugOfCounterpart(c.counterpart)!;
        found = contactBySlug(slug, (await register.listRegister(c.orgId, "contact", { filter: [{ field: "linkedinUrl", op: "contains", value: `/in/${slug}` }], limit: 5 })).rows);
      }
      if (unknown.domain) {
        const row = (await register.listRegister(c.orgId, "account", { filter: [{ field: "domain", op: "eq", value: unknown.domain }], limit: 1 })).rows[0];
        if (row) domainAccount = { id: row.id, domain: unknown.domain };
      }
      if (found) {
        const seen = await client.getContact(c.orgId, found);
        if (seen) {
          contacts.push(seen);
          matched = seen.id;
        }
        unknown = null;
      }
    }
    const domainKnown = Boolean(domainAccount);
    // The deal the conversation is about: its people's open deal, else their company's (an email from someone new at
    // a company with an open deal joins that deal). A company the workspace has won is a customer.
    const companies = [
      ...(domainAccount ? [domainAccount] : []),
      ...[...new Set(contacts.map((x) => x.accountId).filter((id): id is string => Boolean(id)))].map((id) => ({ id })),
    ];
    const related = await ctx.runQuery(internal.conversationExtract.dealOf, { conversationId: args.conversationId, contactIds: contacts.map((x) => x.id), companies });
    deal = deal ?? related.deal;
    const byKey = new Map<string, ContactRow>(contacts.flatMap((x) => {
      const key = personKey(x);
      return key ? [[key, x] as const] : [];
    }));

    const context: ConversationFactsContext = {
      source: { kind: c.channel, id: args.conversationId }, title: c.title, day: c.day, summary: null,
      text: threadText(c.messages), owner: c.owner,
      deal: deal ? { name: deal.name, stage: deal.stage, nextStep: deal.nextStep, closeDate: deal.closeDate } : null,
      people: [...byKey].map(([key, x]) => ({ email: key, name: x.fullName || null, title: x.title || null })),
      newPeople: unknown ? [{ email: unknown.key, name: unknown.name }] : [],
      newDomains: unknown?.domain && !domainKnown ? [unknown.domain] : [],
      askOpportunity: !deal,
      askMentions: false,
    };
    const model = llm.model ?? DEFAULT_MODELS[llm.provider];
    let raw: unknown;
    try {
      raw = await forcedToolCall(conversationFactsPrompt(context, c.define), "crm_updates", CONVERSATION_FACTS_SCHEMA, model, llm);
    } catch (cause) {
      // Not retried on a timer: the next message on the thread starts another pass, which reads this one's messages too.
      console.error("conversation extraction failed", args.conversationId, cause);
      return skip("the model call failed");
    }

    // Only a sales conversation suggests a deal; vendors, newsletters and cold outreach to us suggest nothing.
    const jevKey = integrationEnabled("jev") ? process.env.JEV_API_KEY : undefined;
    const classification = await classifyConversation({
      channel: c.channel, title: c.title, email: c.channel === "email" ? c.counterpart.email ?? null : null, text: context.text,
      // Only the whole thread shows nobody answered; a later pass reads a window that may leave our replies out.
      ...(c.firstPass ? { fromUs: c.messages.filter((m) => m.direction === "us").length, fromThem: c.messages.filter((m) => m.direction === "them").length } : {}),
      customer: related.customer, openDeal: Boolean(deal),
    }, jevKey ? jevClassifier(jevKey) : null);
    const planned = gateSuggestions(classification, conversationSuggestions({
      conversationId: args.conversationId, channel: c.channel, unknown,
      email: c.channel === "email" ? c.counterpart.email?.toLowerCase() ?? null : null,
      domainKnown, hasDeal: Boolean(deal), read: groundedSuggestionRead(raw, context),
    }));
    const suggested = planned.length ? await ctx.runMutation(internal.callSuggestions.record, {
      orgId: c.orgId, userId: c.ownerUserId, conversationId: args.conversationId, suggestions: planned, reason: "suggested",
    }) : 0;

    const facts = groundedFacts(raw, context).map((f) =>
      f.entityType === "opportunity" ? f : { entityType: f.entityType, contactId: byKey.get(f.email.toLowerCase())!.id, attribute: f.attribute, value: f.value, evidence: f.evidence });
    const result = facts.length ? await ctx.runMutation(internal.callFacts.submitConversation, {
      orgId: c.orgId, userId: c.ownerUserId, kind: c.channel, title: c.title, facts, model: `${llm.provider}:${model}`,
      ...(deal ? { dealId: deal.id } : {}),
    }) : null;
    await ctx.runMutation(internal.conversationExtract.finish, {
      ...args, readAt: c.readAt, ...(result?.patchPlanId ? { patchPlanId: result.patchPlanId } : {}), ...(matched ? { contactId: matched } : {}),
    });
    return { proposed: result?.proposed ?? 0, suggested };
  },
});
