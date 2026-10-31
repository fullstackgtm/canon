/**
 * A record's timeline (docs/signal-ledger.md, Reads): its field changes from the record service's
 * `field_history`, its observations (an account's signal events, a contact's LinkedIn events, emails sent and hot-lead replies) and its
 * activities (lib/activities.ts), and an account's deals as they were created, merged newest first. Pure: a page calls it with the bounded reads it has.
 */
import type { Activity } from "./activities";
import type { EmailEvent, LinkedinEvent, LoggedObservation, Observation } from "./signals/observations";

type Value = string | number | null;

/** A `field_history` row as the record service returns it. `source` is absent on rows written before service 1.2.0. */
export type FieldChange = { field: string; oldValue: Value; newValue: Value; actorId: string; at: number; source?: string };

/** A deal linked to the record (deals.forCompany, at most COMPANY_DEALS_MAX), with its stage as shown. */
export type CreatedDeal = { streamId: string | null; name: string; stage: string | null; amount: number | null; currency: string; createdAt: number };

export type TimelineItem =
  | { kind: "field_changed"; at: number; field: string; from: Value; to: Value; actorId: string; source: string | null }
  | { kind: "signal_started"; at: number; trigger: string; quote: string; url: string }
  | { kind: "signal_quote_changed"; at: number; trigger: string; quote: string; url: string; previousQuote: string }
  | { kind: "signal_ended"; at: number; trigger: string; startedAt: number }
  | { kind: "linkedin"; at: number; key: string; event: LinkedinEvent }
  | { kind: "hot_lead"; at: number; provider: string; reply: string }
  | { kind: "email"; at: number; key: string; event: EmailEvent }
  | { kind: "deal_created"; at: number; deal: CreatedDeal }
  | Activity;

type Open = { trigger: string; quote: string; startedAt: number };

/**
 * Whether an observation is intake's copy of a LinkedIn message a cadence sent (its webhook echo): the cadence's
 * `message_sent` already shows it, so it is not shown twice. Decided when the log is read, so either may land first.
 */
function echoesOfCadence(log: ReadonlyArray<{ body: Observation }>): (body: Observation) => boolean {
  const sent = new Set(log.flatMap((o) => (o.body.type === "linkedin" && o.body.event.kind === "message_sent" && o.body.event.messageId ? [o.body.event.messageId] : [])));
  return (body) => body.type === "linkedin" && body.event.kind === "message" && body.event.direction === "out" && sent.has(body.key.slice("linkedin:msg:".length));
}

/** A log's events, oldest first. A `signal_gone` whose opening fell outside the read is dropped, and so is an erased observation. */
function observationEvents(log: readonly LoggedObservation[]): TimelineItem[] {
  const open = new Map<string, Open>();
  const out: TimelineItem[] = [];
  const echo = echoesOfCadence(log);
  for (const entry of [...log].sort((a, b) => a.seq - b.seq)) {
    const body = entry.body;
    if (echo(body)) continue;
    switch (body.type) {
      case "signal_seen": {
        const { trigger, quote, url } = body.signal;
        const live = open.get(body.key);
        if (live) {
          out.push({ kind: "signal_quote_changed", at: entry.observedAt, trigger, quote, url, previousQuote: live.quote });
          open.set(body.key, { ...live, quote });
        } else {
          const startedAt = entry.occurredAt ?? entry.observedAt;
          out.push({ kind: "signal_started", at: startedAt, trigger, quote, url });
          open.set(body.key, { trigger, quote, startedAt });
        }
        break;
      }
      case "signal_gone": {
        const live = open.get(body.key);
        if (live) out.push({ kind: "signal_ended", at: entry.observedAt, trigger: live.trigger, startedAt: live.startedAt });
        open.delete(body.key);
        break;
      }
      case "linkedin":
        // A message intake read is dated when it was sent; a backfilled one was observed long after.
        out.push({ kind: "linkedin", at: body.event.kind === "message" ? entry.occurredAt ?? entry.observedAt : entry.observedAt, key: body.key, event: body.event });
        break;
      case "email":
        out.push({ kind: "email", at: entry.occurredAt ?? entry.observedAt, key: body.key, event: body.event });
        break;
      case "hot_lead":
        out.push({ kind: "hot_lead", at: entry.occurredAt ?? entry.observedAt, provider: body.provider, reply: body.reply });
        break;
      case "erased":
        break;
    }
  }
  return out;
}

/** Field changes (newest first, as the service returns them), an observation log, activities and created deals, as one list newest first. Ties keep that order. */
export function recordTimeline(fieldHistory: readonly FieldChange[], log: readonly LoggedObservation[], activities: readonly Activity[], deals: readonly CreatedDeal[] = []): TimelineItem[] {
  const fields = fieldHistory.map((h): TimelineItem => ({
    kind: "field_changed", at: h.at, field: h.field, from: h.oldValue, to: h.newValue, actorId: h.actorId, source: h.source ?? null,
  }));
  const created = deals.map((deal): TimelineItem => ({ kind: "deal_created", at: deal.createdAt, deal }));
  return [...fields, ...observationEvents(log).reverse(), ...activities, ...created].sort((a, b) => b.at - a.at);
}
