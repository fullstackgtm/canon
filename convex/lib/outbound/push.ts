/**
 * Pushing an audience to a sequencer campaign: plan it, send what is new,
 * record who went. The store is a port, so the same code runs in an action and
 * in a test. Which provider it is comes only from the registry.
 *
 * Pure: no database access, no Node-only imports.
 */
import { emailKey, planPush, summaryOf, type OutboundContact, type PushPlan } from "./audience.ts";
import type { BeforeBatch, OnBatch, SequencerClient } from "./client.ts";
import { SEQUENCERS, targetOf, type SequencerId } from "./sequencers.ts";

export type MemberRow = { contactId: string; email?: string; outcome: "sent" | "exported" | "skipped"; reason?: string };

export type PushPorts = {
  /** Required live check, repeated immediately before each provider batch. */
  suppressed(contacts: readonly OutboundContact[]): Promise<ReadonlyMap<string, string>>;
  /** Lowercase emails already sent to `target` from this audience. */
  sentEmails(target: string): Promise<Set<string>>;
  record(target: string, rows: MemberRow[]): Promise<void>;
};

/** The plan, with the contacts the provider would refuse taken out of `send`. */
function planFor(provider: SequencerId, contacts: readonly OutboundContact[], sent: ReadonlySet<string>) {
  const plan: PushPlan = planPush(contacts, sent);
  const req = SEQUENCERS[provider].requires;
  const unfit = req ? plan.send.filter((c) => !req.accepts(c)) : [];
  if (unfit.length) plan.send = plan.send.filter((c) => req!.accepts(c));
  const base = summaryOf(plan);
  return { plan, unfit, summary: { ...base, total: base.total + unfit.length, skippedUnfit: unfit.length } };
}

export type PushPreview = ReturnType<typeof planFor>["summary"] & { skippedSuppressed: number };

/** What a push would do, for the preview. Reads only. */
export async function previewPush(provider: SequencerId, contacts: readonly OutboundContact[], campaignId: string, ports: Pick<PushPorts, "sentEmails" | "suppressed">): Promise<PushPreview> {
  const { plan, summary } = planFor(provider, contacts, await ports.sentEmails(targetOf(provider, campaignId)));
  const suppressed = await ports.suppressed(plan.send);
  const skippedSuppressed = plan.send.filter((c) => suppressed.has(c.id)).length;
  return { ...summary, toSend: summary.toSend - skippedSuppressed, skippedSuppressed };
}

export type PushResult = PushPreview & { sent: number; rejected: number };

export async function pushTo(opts: { provider: SequencerId; contacts: readonly OutboundContact[]; campaignId: string; client: SequencerClient; ports: PushPorts }): Promise<PushResult> {
  const { provider, campaignId, client, ports } = opts;
  const { label, requires } = SEQUENCERS[provider];
  const target = targetOf(provider, campaignId);
  const { plan, unfit, summary } = planFor(provider, opts.contacts, await ports.sentEmails(target));
  const row = (c: OutboundContact, outcome: MemberRow["outcome"], reason?: string): MemberRow => ({
    contactId: c.id, ...(emailKey(c.email) ? { email: emailKey(c.email) } : {}), outcome, ...(reason ? { reason } : {}),
  });
  await ports.record(target, [
    ...plan.noEmail.map((c) => row(c, "skipped", "no email")),
    ...plan.duplicates.map((c) => row(c, "skipped", "same email as another contact")),
    ...unfit.map((c) => row(c, "skipped", requires!.reason)),
  ]);
  let sent = 0;
  const suppressedIds = new Set<string>();
  const recordBatch: OnBatch = async (batch, result) => {
    const created = new Set(result.created);
    // The provider named the leads it added: those are sent, the rest were skipped there. If it only gave counts,
    // an all-accepted batch is sent, and a mixed one records nothing, so the next push retries it (providers skip repeats).
    const known = created.size > 0 || result.uploaded === 0 || result.uploaded === batch.length;
    if (!known) return;
    const rows = batch.map((c) =>
      (created.size > 0 ? created.has(emailKey(c.email)) : result.uploaded === batch.length)
        ? row(c, "sent")
        : row(c, "skipped", `${label} skipped it: already in the campaign, invalid or blocklisted`),
    );
    sent += rows.filter((r) => r.outcome === "sent").length;
    await ports.record(target, rows);
  };
  const checkBatch: BeforeBatch = async (batch) => {
    const suppressed = await ports.suppressed(batch);
    const blocked = batch.filter((c) => suppressed.has(c.id) && !suppressedIds.has(c.id));
    if (blocked.length) await ports.record(target, blocked.map((c) => row(c, "skipped", suppressed.get(c.id)!)));
    blocked.forEach((c) => suppressedIds.add(c.id));
    return batch.filter((c) => !suppressed.has(c.id) && !suppressedIds.has(c.id));
  };
  // Keep the required check in this orchestrator as well as the adapters. A future adapter cannot bypass it.
  for (let i = 0; i < plan.send.length; i += SEQUENCERS[provider].batchSize) {
    const batch = await checkBatch(plan.send.slice(i, i + SEQUENCERS[provider].batchSize));
    if (batch.length) await client.addLeads(campaignId, batch, recordBatch, checkBatch);
  }
  return { ...summary, toSend: summary.toSend - suppressedIds.size, skippedSuppressed: suppressedIds.size, sent, rejected: plan.send.length - suppressedIds.size - sent };
}
