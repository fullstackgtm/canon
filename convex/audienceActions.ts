/**
 * Audience actions (GT6): preview, CSV export and the push to a sequencer
 * campaign (Instantly, EmailBison or Smartlead: lib/outbound/sequencers.ts).
 * A push needs an admin or manager, and the caller names how many contacts it
 * expects to send (from the preview): if the audience has changed since, it
 * stops and asks for a new preview. The API key is read and decrypted here and
 * goes nowhere but the provider's request. `provider` defaults to Instantly,
 * the only one there was before.
 */
import { can, refusal } from "./lib/capabilities";
import { ConvexError, v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { callerClient, clientFor } from "./records";
import type { Access } from "./lib/access";
import { WRITE_CHUNK } from "./audiences";
import { accountNamesByList } from "./lib/recordClient";
import { decryptFromStorage } from "./lib/tokenHelpers";
import { listFilter } from "./lib/objects/validators";
import { AUDIENCE_MAX, csvOf, emailKey, planPush, readAll, summaryOf, type OutboundContact } from "./lib/outbound/audience";
import { SequencerError, type SequencerCampaign, type SequencerClient } from "./lib/outbound/client";
import { previewPush, pushTo, type MemberRow, type PushPorts, type PushPreview, type PushResult } from "./lib/outbound/push";
import { normalizeInstanceUrl, SEQUENCERS, targetOf, type SequencerId } from "./lib/outbound/sequencers";
import { sequencerId } from "./audiences";
import { resolveContacts, type Resolved } from "./lib/outbound/resolve";

export type Caller = { orgId: Id<"organizations">; userId: Id<"users">; role: string; capabilities?: readonly string[]; access?: Access };

/** A person; during an admin's "view as" preview only reads (`read: true`) go through, as with records.requireCaller (CP14). */
async function requireMember(ctx: ActionCtx, opts: { read?: boolean } = {}): Promise<Caller> {
  const caller = await ctx.runQuery(internal.audiences.caller, {});
  if (!caller) throw new ConvexError("Not authenticated");
  if (caller.access.preview && !opts.read) throw new ConvexError(`You are viewing as ${caller.access.preview.asName}: changes are off until you exit the preview`);
  return caller;
}

async function requireIntegrations(ctx: ActionCtx): Promise<Caller> {
  const caller = await requireMember(ctx);
  if (!can(caller, "integrations.manage")) throw new ConvexError(refusal("integrations.manage"));
  return caller;
}

/** The audience's people: as a person sees them when `who` is a person's (CP14), else (the system) the whole workspace. */
async function contactsFor(ctx: ActionCtx, who: { orgId: Id<"organizations">; access?: Access }, filter: Parameters<typeof resolveContacts>[1], addedIds: string[] = []): Promise<Resolved> {
  const orgId = who.orgId;
  const client = who.access ? callerClient(ctx, { orgId: who.orgId as string, access: who.access }) : clientFor(ctx);
  const ws = orgId as string;
  return resolveContacts(
    {
      listContacts: (req) => client.listRegister(ws, "contact", req),
      getContact: (id) => client.getContact(ws, id),
      accountNames: (ids) => accountNamesByList(client, ws, ids),
      customValues: (streamIds): Promise<Record<string, Record<string, string | number | boolean>>> => ctx.runQuery(internal.objects.customFieldValues, { orgId, streamIds }),
    },
    filter,
    addedIds,
  );
}

const tooLarge = (r: Resolved) => new ConvexError(`This audience has ${r.total.toLocaleString("en-US")} contacts; the limit is ${AUDIENCE_MAX.toLocaleString("en-US")}. Edit its filter to narrow it.`);

/** The audience's contacts now. A person reads only audiences they can see; the system (`{ orgId }` alone) reads any in the org. */
export async function audienceContacts(ctx: ActionCtx, caller: Caller | Pick<Caller, "orgId">, audienceId: Id<"audiences">): Promise<{ audience: Doc<"audiences">; contacts: OutboundContact[] }> {
  const viewer = "userId" in caller ? { userId: caller.userId, role: caller.role, ...(caller.capabilities ? { capabilities: [...caller.capabilities] } : {}) } : undefined;
  const audience: Doc<"audiences"> | null = await ctx.runQuery(internal.audiences.get, { orgId: caller.orgId, audienceId, ...(viewer ? { viewer } : {}) });
  if (!audience) throw new ConvexError("Audience not found");
  const added: string[] = await ctx.runQuery(internal.audiences.addedContactIds, { audienceId: audience._id });
  const resolved = await contactsFor(ctx, caller, audience.filter, added);
  if (resolved.tooLarge) throw tooLarge(resolved);
  return { audience, contacts: resolved.contacts };
}

async function sequencerFor(ctx: ActionCtx, orgId: Id<"organizations">, provider: SequencerId): Promise<SequencerClient> {
  const def = SEQUENCERS[provider];
  const stored: { accessToken: string; instanceUrl: string | null } | null = await ctx.runQuery(internal.audiences.sequencerKey, { orgId, provider });
  if (!stored) throw new ConvexError(`${def.label} is not connected. Add your ${def.keyLabel} in Integrations.`);
  return def.create({ apiKey: await decryptFromStorage(stored.accessToken), ...(stored.instanceUrl ? { instanceUrl: stored.instanceUrl } : {}) });
}

const campaignOrThrow = (provider: SequencerId, id: string) => {
  if (!SEQUENCERS[provider].campaignId.test(id)) throw new ConvexError(`That is not a ${SEQUENCERS[provider].label} campaign id.`);
  return id;
};

/** The provider's refusal as a message for the user; anything else is ours to raise. */
async function viaSequencer<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof SequencerError) throw new ConvexError(cause.message);
    throw cause;
  }
}

function portsFor(ctx: ActionCtx, caller: Caller, audienceId: Id<"audiences">): PushPorts {
  // One time for the whole run, so its rows read as one send in the history.
  const at = Date.now();
  return {
    suppressed: async (contacts) => {
      const blocked = new Map<string, string>();
      for (let i = 0; i < contacts.length; i += 100) {
        const chunk = contacts.slice(i, i + 100);
        const statuses = await ctx.runQuery(internal.suppressions.checkIdentifiers, { orgId: caller.orgId, identifiers: chunk.map((c) => ({ ...(c.email ? { email: c.email } : {}) })), purpose: "automated_outreach" });
        statuses.forEach((status, j) => { if (status.email.blocked) blocked.set(chunk[j].id, status.email.text!); });
      }
      return blocked;
    },
    sentEmails: async (target) => new Set(await readAll((cursor) => ctx.runQuery(internal.audiences.sentEmails, { audienceId, target, cursor }))),
    record: async (target, rows) => {
      for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
        await ctx.runMutation(internal.audiences.recordMembers, { orgId: caller.orgId, audienceId, userId: caller.userId, target, at, rows: rows.slice(i, i + WRITE_CHUNK) });
      }
    },
  };
}

/** Connect a sequencer: the key (and EmailBison's host) is checked against the live API, then stored encrypted. */
export const connectSequencer = action({
  args: { provider: sequencerId, apiKey: v.string(), instanceUrl: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const caller = await requireIntegrations(ctx);
    const def = SEQUENCERS[args.provider];
    const apiKey = args.apiKey.trim();
    if (!apiKey) throw new ConvexError(`Paste your ${def.label} ${def.keyLabel}.`);
    let instanceUrl: string | undefined;
    if (def.instanceUrl) {
      instanceUrl = normalizeInstanceUrl(args.instanceUrl ?? "") ?? undefined;
      if (!instanceUrl) throw new ConvexError(`Enter your ${def.instanceUrl.label} as an https address, like ${def.instanceUrl.placeholder}.`);
    }
    await viaSequencer(() => def.create({ apiKey, instanceUrl }).validate());
    await ctx.runMutation(internal.audiences.storeSequencerKey, { orgId: caller.orgId, userId: caller.userId, provider: args.provider, apiKey, ...(instanceUrl ? { instanceUrl } : {}) });
    return { ok: true };
  },
});

export const campaigns = action({
  args: { provider: v.optional(sequencerId) },
  handler: async (ctx, args): Promise<SequencerCampaign[]> => {
    const caller = await requireMember(ctx);
    const provider = args.provider ?? "instantly";
    return viaSequencer(async () => (await sequencerFor(ctx, caller.orgId, provider)).listCampaigns());
  },
});

export const refreshSummary = internalAction({
  args: { orgId: v.id("organizations"), audienceId: v.id("audiences") },
  handler: async (ctx, args) => {
    const computedAt = Date.now();
    const { audience, contacts } = await audienceContacts(ctx, { orgId: args.orgId }, args.audienceId);
    const base = summaryOf(planPush(contacts, new Set()));
    await ctx.runMutation(internal.audiences.storeSummary, {
      ...args, filter: audience.filter,
      summary: {
        total: base.total,
        withEmail: base.total - base.skippedNoEmail,
        customVariables: [...new Set(contacts.flatMap((c) => Object.keys(c.custom)))].sort(),
        computedAt,
      },
    });
  },
});

/** What the audience holds now, and (with a campaign) what a push to it would do. Writes nothing. */
export const preview = action({
  args: { audienceId: v.id("audiences"), campaignId: v.optional(v.string()), provider: v.optional(sequencerId) },
  handler: async (ctx, args): Promise<{ total: number; withEmail: number; customVariables: string[]; push: PushPreview | null }> => {
    const provider = args.provider ?? "instantly";
    const caller = await requireMember(ctx, { read: true });
    const { contacts } = await audienceContacts(ctx, caller, args.audienceId);
    const base = summaryOf(planPush(contacts, new Set()));
    return {
      total: base.total,
      withEmail: base.total - base.skippedNoEmail,
      customVariables: [...new Set(contacts.flatMap((c) => Object.keys(c.custom)))].sort(),
      push: args.campaignId ? await previewPush(provider, contacts, campaignOrThrow(provider, args.campaignId), portsFor(ctx, caller, args.audienceId)) : null,
    };
  },
});

/** The audience as CSV, custom fields as extra columns. Records the snapshot. */
export const exportCsv = action({
  args: { audienceId: v.id("audiences") },
  handler: async (ctx, args): Promise<{ csv: string; count: number }> => {
    const caller = await requireMember(ctx, { read: true });
    const { contacts } = await audienceContacts(ctx, caller, args.audienceId);
    const rows: MemberRow[] = contacts.map((c) => ({ contactId: c.id, ...(emailKey(c.email) ? { email: emailKey(c.email) } : {}), outcome: "exported" }));
    await portsFor(ctx, caller, args.audienceId).record("csv", rows);
    return { csv: csvOf(contacts), count: contacts.length };
  },
});

/** The contacts a list view's filter matches, as CSV. Nothing is recorded: an audience is what keeps a history. */
export const exportViewCsv = action({
  args: { filter: v.array(listFilter) },
  handler: async (ctx, args): Promise<{ csv: string; count: number }> => {
    const caller = await requireMember(ctx, { read: true });
    const resolved = await contactsFor(ctx, caller, args.filter);
    if (resolved.tooLarge) throw tooLarge(resolved);
    return { csv: csvOf(resolved.contacts), count: resolved.contacts.length };
  },
});

/** Add the audience's new contacts to a sequencer campaign. Repeating it adds only contacts not yet sent there. */
export const push = action({
  args: { audienceId: v.id("audiences"), campaignId: v.string(), expectToSend: v.number(), provider: v.optional(sequencerId) },
  handler: async (ctx, args): Promise<PushResult & { target: string }> => {
    const caller = await requireIntegrations(ctx);
    const provider = args.provider ?? "instantly";
    campaignOrThrow(provider, args.campaignId);
    const { contacts } = await audienceContacts(ctx, caller, args.audienceId);
    const ports = portsFor(ctx, caller, args.audienceId);
    const now = await previewPush(provider, contacts, args.campaignId, ports);
    if (now.toSend !== args.expectToSend) throw new ConvexError(`The audience changed: ${now.toSend} contacts would be sent, not ${args.expectToSend}. Preview again.`);
    const client = await sequencerFor(ctx, caller.orgId, provider);
    const result = await viaSequencer(() => pushTo({ provider, contacts, campaignId: args.campaignId, client, ports }));
    return { ...result, target: targetOf(provider, args.campaignId) };
  },
});
