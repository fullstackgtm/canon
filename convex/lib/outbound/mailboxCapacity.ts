import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { DAILY_SEND_CAP, DAY_MS, validAddress } from "../email/compose";
import { DEFAULT_RECIPIENT_WEEKLY_CAP, validRecipientWeeklyCap } from "./emailPolicy";
import { mailboxGrantSignatureValid } from "./mailboxGrants";
import { ownerEmailFrozenValid } from "./ownerEmailPreparation";
import { hashP4Sq1EmailBinding } from "./mailboxReceipts";
import { boundMailboxRow, mailboxMetadataShape } from "./mailboxBinding";
import type { P4MailboxMetadata } from "./mailboxTypes";

const WEEK_MS = 7 * DAY_MS, SCAN_MAX = 1000, MODULE_CAP = 500;
const time = (at: number) => Number.isSafeInteger(at) && at >= 0;
const clock = (now: number) => time(now) && now <= Number.MAX_SAFE_INTEGER - WEEK_MS - 1;
type WindowCapacity = { count: number; notBefore: number | null; scanExhausted: boolean; valid: boolean };
function windowCapacity(times: number[], max: number, window: number, now: number, exhausted: boolean): WindowCapacity {
  if (!clock(now) || times.some((at) => !time(at) || at > now)) return { count: max, notBefore: null, scanExhausted: exhausted, valid: false };

  const notBefore = exhausted ? now + window + 1 : times.length >= max ? times.sort((a, b) => a - b)[times.length - max] + window + 1 : null;
  return { count: exhausted ? Math.max(max, times.length) : times.length, notBefore, scanExhausted: exhausted, valid: true };
}

export async function readMailboxDailyCapacity(ctx: QueryCtx, accountId: Id<"emailAccounts">, now: number): Promise<WindowCapacity> {
  if (!clock(now)) return windowCapacity([], DAILY_SEND_CAP, DAY_MS, now, false);
  const times: number[] = [];
  let scanned = 0;
  for await (const row of ctx.db.query("emailSends").withIndex("by_accountId_and_at", (q) => q.eq("accountId", accountId).gte("at", now - DAY_MS)).order("desc")) {
    scanned++;
    if (!time(row.at) || row.at > now) return { count: DAILY_SEND_CAP, notBefore: null, scanExhausted: false, valid: false };
    if (row.state !== "failed") times.push(row.at);
    if (scanned >= SCAN_MAX || times.length >= DAILY_SEND_CAP) break;
  }

  return windowCapacity(times, DAILY_SEND_CAP, DAY_MS, now, scanned >= SCAN_MAX);
}

type Counts = { mailbox: number; grant: number; recipient: number; module: number };
type HoldCode = `outbound.capacity.${"mailbox" | "grant" | "recipient" | "module" | "scan_exhausted"}`;
export type P4MailboxCapacity = { state: "available"; counts: Counts }
  | { state: "held"; notBefore: number; code: HoldCode; text: string; counts: Counts }
  | { state: "refused"; code: "outbound.capacity.invalid_binding" | "outbound.capacity.invalid_history"; text: string };
const refused = (history = false): P4MailboxCapacity => ({ state: "refused", code: history ? "outbound.capacity.invalid_history" : "outbound.capacity.invalid_binding",
  text: history ? "Capacity history cannot be proven safely." : "A canonical mailbox row, signed grant cap and workspace policy are required." });
const canonicalAddress = (address: string) => typeof address === "string" && validAddress(address) && address === address.trim().toLowerCase();

export async function assessP4MailboxCapacity(ctx: QueryCtx, outboundMessageId: Id<"outboundMessages">): Promise<P4MailboxCapacity> {
  const row = await ctx.db.get(outboundMessageId), m = row ? boundMailboxRow(row) : null;
  return row && m ? assess(ctx, m, row) : refused();
}

export async function assessPreparedMailboxCapacity(ctx: QueryCtx, m: P4MailboxMetadata): Promise<P4MailboxCapacity> {
  return mailboxMetadataShape(m) && !m.attempt ? assess(ctx, m, null) : refused();
}

async function assess(ctx: QueryCtx, m: P4MailboxMetadata, row: Doc<"outboundMessages"> | null): Promise<P4MailboxCapacity> {
  const now = Date.now();
  if (!clock(now)) return refused(true);
  if (!canonicalAddress(m.prepared.recipient.address) || !canonicalAddress(m.prepared.sender.address)) return refused();
  const p = m.prepared, grant = m.kind === "owner.exact-email.v1" ? null : await ctx.db.get(m.prepared.grantId), org = await ctx.db.get(p.orgId), account = await ctx.db.get(p.sender.id);
  const personal = m.kind === "owner.exact-email.v1" && m.prepared.purpose === "manual_action";
  const cap = personal ? DEFAULT_RECIPIENT_WEEKLY_CAP : org?.outboundEmailPolicy?.recipientWeeklyCap ?? DEFAULT_RECIPIENT_WEEKLY_CAP;
  if (!org || !personal && !validRecipientWeeklyCap(cap) || !account || account.orgId !== p.orgId || account.userId !== p.sender.ownerId
    || account.address.trim().toLowerCase() !== p.sender.address) return refused();
  if (m.kind === "owner.exact-email.v1") {
    if (!(await ownerEmailFrozenValid(m.prepared))) return refused();
  } else if (!grant || grant.orgId !== p.orgId || grant.moduleId !== p.moduleId || grant.senderId !== p.sender.id
    || grant.ownerId !== p.sender.ownerId || grant.mailboxLinkHash !== p.sender.mailboxLinkHash
    || !Number.isInteger(grant.maxPerDay) || grant.maxPerDay < 1 || grant.maxPerDay > DAILY_SEND_CAP || !(await mailboxGrantSignatureValid(grant))) return refused();
  if (m.kind === "manifest.automated-email.v1") {
    if (!grant || grant.template.kind !== "manifest" || grant.template.name !== m.prepared.template.name || grant.template.hash !== m.prepared.template.hash) return refused();
  } else if (m.kind === "sq1.email.v1") {
    if (!grant) return refused();
    const request = await ctx.db.get(m.request.requestId), authority = m.prepared.template.authority;
    if (grant.template.kind !== "sq1.template-set.v1" || grant.template.launchId !== authority.launchId || grant.template.hash !== authority.hash
      || !request || request.orgId !== p.orgId || request.moduleId !== p.moduleId || request.launchId !== authority.launchId
      || request.authorizationEpoch !== m.request.epoch || await hashP4Sq1EmailBinding(request, m.prepared) !== m.request.digest) return refused();
    if (row ? !("frozen" in request) || !request.frozen || request.frozen.digest !== m.request.digest
      || !("outboundMessageId" in request) || request.outboundMessageId !== row._id || request.frozen.grantId !== grant._id
      || request.frozen.renderedHash !== p.renderedHash || request.frozen.templateSetHash !== grant.template.hash
      : request.state !== "preparing") return refused();
  }
  const daily = await readMailboxDailyCapacity(ctx, p.sender.id, now);
  const moduleRows = await ctx.db.query("outboundMessages").withIndex("by_orgId_and_module_and_claimedAt", (q) => q.eq("orgId", p.orgId).eq("module", p.moduleId).gte("claimedAt", now - DAY_MS)).order("desc").take(SCAN_MAX);
  const recipientRows = personal ? [] : await ctx.db.query("outboundMessages").withIndex("by_orgId_and_target_and_claimedAt", (q) => q.eq("orgId", p.orgId).eq("target", `address:${p.recipient.address}`).gte("claimedAt", now - WEEK_MS)).order("desc").take(SCAN_MAX);
  const moduleTimes: number[] = [], grantTimes: number[] = [], recipientTimes: number[] = [];
  for (const prior of moduleRows) {
    if (prior.claimedAt === undefined || !time(prior.claimedAt) || prior.claimedAt > now) return refused(true);
    moduleTimes.push(prior.claimedAt);
    if (prior.channel === "email" && prior.kind === "automated" && grant && prior.mailbox && "grantId" in prior.mailbox.prepared && prior.mailbox.prepared.grantId === grant._id) {
      const bound = boundMailboxRow(prior);
      if (!bound) return refused(true);
      const sender = bound.prepared.sender;
      if (sender.id !== grant.senderId || sender.ownerId !== grant.ownerId || sender.mailboxLinkHash !== grant.mailboxLinkHash) return refused(true);
      grantTimes.push(prior.claimedAt);
    }
  }
  for (const prior of recipientRows) {
    if (prior.claimedAt === undefined || !time(prior.claimedAt) || prior.claimedAt > now) return refused(true);
    if (prior.channel === "email" && prior.kind === "automated" && prior.mailbox) {
      if (!boundMailboxRow(prior)) return refused(true);
      recipientTimes.push(prior.claimedAt);
    }
  }

  const windows = [
    { key: "mailbox", what: "100 mailbox attempts per rolling day", value: daily },
    { key: "grant", what: "the owner's signed daily grant cap", value: windowCapacity(grantTimes, grant?.maxPerDay ?? DAILY_SEND_CAP, DAY_MS, now, !!grant && moduleRows.length === SCAN_MAX) },
    { key: "recipient", what: "the workspace recipient cap per rolling week", value: windowCapacity(recipientTimes, cap, WEEK_MS, now, recipientRows.length === SCAN_MAX) },
    { key: "module", what: "500 module claims per rolling day", value: windowCapacity(moduleTimes, MODULE_CAP, DAY_MS, now, moduleRows.length === SCAN_MAX) },
  ] as const;
  if (windows.some((w) => !w.value.valid)) return refused(true);
  const counts: Counts = { mailbox: daily.count, grant: windows[1].value.count, recipient: windows[2].value.count, module: windows[3].value.count };
  let hold: { notBefore: number; code: HoldCode; text: string } | null = null;
  for (const w of windows) {
    const notBefore = w.value.notBefore;
    if (notBefore !== null && (hold === null || notBefore > hold.notBefore)) hold = { notBefore,
      code: w.value.scanExhausted ? "outbound.capacity.scan_exhausted" : `outbound.capacity.${w.key}`,
      text: w.value.scanExhausted ? "Capacity scan reached its safety bound; held until this window has aged out." : `Held to respect ${w.what}.` };
  }
  return hold ? { state: "held", ...hold, counts } : { state: "available", counts };
}
