/**
 * Observations (docs/signal-ledger.md): dated facts Canon saw about an account
 * or contact and could not fetch again. A signal's life is two events: `signal_seen` opens
 * it (and records each changed quote) and `signal_gone` closes it. A contact's are LinkedIn events. The open set
 * in `accountSignals` is a cache next to this log; the log is the history.
 * Pure and free of Node imports: the schema, mutations and the UI query use it.
 */
import { v, type Infer } from "convex/values";

export const boardValidator = v.union(v.literal("greenhouse"), v.literal("lever"), v.literal("ashby"));

export const subjectValidator = v.union(
  v.object({ object: v.literal("account"), domain: v.string() }),
  v.object({ object: v.literal("contact"), contactId: v.string() }),
);

/**
 * One signal, by bucket. `job` comes from a public job board. `site`, `blog` and `social` come from the
 * account's own website (convex/lib/signals/website.ts): a sitemap date, a feed post, a profile link.
 */
export const signalValidator = v.union(
  v.object({ bucket: v.literal("job"), trigger: v.string(), quote: v.string(), url: v.string(), board: boardValidator, reposted: v.optional(v.literal(true)) }),
  v.object({ bucket: v.literal("site"), trigger: v.string(), quote: v.string(), url: v.string() }),
  v.object({ bucket: v.literal("blog"), trigger: v.string(), quote: v.string(), url: v.string() }),
  v.object({ bucket: v.literal("social"), trigger: v.string(), quote: v.string(), url: v.string() }),
);

/**
 * What happened between a LinkedIn sender and a contact. Text is the exact text sent, rendered at send time.
 * A reply carries no text: the worker learns only that one arrived, and the message stays in LinkedIn.
 * A `message` is one read by conversation intake (convex/conversations.ts), keyed `linkedin:msg:<id>`: its text
 * stays in conversationMessages, behind the owner's permission check, never in the log.
 */
export const linkedinEventValidator = v.union(
  v.object({ kind: v.literal("invite_sent"), cadenceId: v.id("linkedinCadences"), step: v.number(), note: v.optional(v.string()) }),
  v.object({ kind: v.literal("invite_accepted"), cadenceId: v.id("linkedinCadences") }),
  // `messageId` is LinkedIn's id of the message sent (since issue #920): intake's echo of it (`linkedin:msg:<id>`) is not shown again.
  v.object({ kind: v.literal("message_sent"), cadenceId: v.id("linkedinCadences"), step: v.number(), body: v.string(), messageId: v.optional(v.string()) }),
  v.object({ kind: v.literal("reply_received"), cadenceId: v.id("linkedinCadences") }),
  v.object({ kind: v.literal("message"), direction: v.union(v.literal("in"), v.literal("out")) }),
);

export const emailEventValidator = v.union(
  v.object({ kind: v.literal("sent"), userId: v.id("users"), from: v.string(), to: v.string(), subject: v.string(), body: v.string() }),
  // An email a CRM logged (a HubSpot import, CP12): which way it went, as the CRM kept it. `userId` is its owner, when one maps.
  v.object({
    kind: v.literal("logged"), provider: v.literal("hubspot"), direction: v.union(v.literal("inbound"), v.literal("outbound")),
    userId: v.optional(v.id("users")), from: v.string(), to: v.string(), subject: v.string(), body: v.string(),
  }),
  // An email that landed in a user's linked inbox about the contact (Unipile webhook, DP4; G2 in docs/gmail-sending.md):
  // their reply verbatim above the quoted thread (before G2 only the subject was kept and `body` is ""), what it is
  // (`reply`, an `auto_reply` with the day they're back, or a `bounce` notice for their address, `body` ""), a
  // reply's `class`, and the Message-ID it answers.
  // From CI2 `body` is always "": an email's text is kept only by conversation intake, behind the owner's permission check.
  v.object({
    kind: v.literal("received"), userId: v.id("users"), from: v.string(), to: v.string(), subject: v.string(), body: v.string(),
    reply: v.optional(v.union(v.literal("reply"), v.literal("auto_reply"), v.literal("bounce"))),
    class: v.optional(v.union(v.literal("interested"), v.literal("not_now"), v.literal("not_interested"), v.literal("unsubscribe"))),
    returnOn: v.optional(v.string()), bounceStatus: v.optional(v.string()), hardBounce: v.optional(v.boolean()), inReplyTo: v.optional(v.string()),
  }),
  // An email conversation intake read (CI2), keyed `email:msg:<Message-ID>`: who and what, never the text, which stays
  // in conversationMessages behind the owner's permission check.
  v.object({ kind: v.literal("message"), direction: v.union(v.literal("in"), v.literal("out")), userId: v.id("users"), from: v.string(), to: v.string(), subject: v.string() }),
);

export const observationBodyValidator = v.union(
  v.object({ type: v.literal("room"), key: v.string(), event: v.union(v.literal("opened"), v.literal("acted")),
    module: v.string(), share: v.string(), root: v.string(), grant: v.string(), visitor: v.string(), day: v.string(),
    dealStreamId: v.optional(v.string()), op: v.optional(v.string()), accountId: v.string(),
  }),
  v.object({ type: v.literal("signal_seen"), key: v.string(), signal: signalValidator }),
  v.object({ type: v.literal("signal_gone"), key: v.string() }),
  v.object({ type: v.literal("linkedin"), key: v.string(), event: linkedinEventValidator }),
  // A contact who replied to cold outreach with real interest (convex/lib/outbound/hotLeads.ts). `reply` is verbatim.
  v.object({ type: v.literal("hot_lead"), key: v.string(), provider: v.literal("explee"), campaignId: v.number(), personId: v.string(), reply: v.string() }),
  // A reply to a user's own Gmail that reads as interested (convex/emailAccounts.ts logReceived). `reply` is verbatim.
  v.object({ type: v.literal("hot_lead"), key: v.string(), provider: v.literal("gmail"), userId: v.id("users"), reply: v.string() }),
  // An email a user sent the contact from a linked account (convex/emailActions.ts), or one a CRM import logged. Subject and body are exactly what was sent.
  v.object({ type: v.literal("email"), key: v.string(), event: emailEventValidator }),
  // Erasing a contact replaces each of its observations with this, in place, so `seq` stays gap-free.
  v.object({ type: v.literal("erased"), key: v.string(), erasedAt: v.number() }),
);

export type Board = Infer<typeof boardValidator>;
export type Subject = Infer<typeof subjectValidator>;
export type Signal = Infer<typeof signalValidator>;
export type Bucket = Signal["bucket"];
/** The buckets one read covers: a job board read says nothing about the website's signals, and the reverse. */
export const JOB_BUCKETS: readonly Bucket[] = ["job"];
export const WEBSITE_BUCKETS: readonly Bucket[] = ["site", "blog", "social"];
export type LinkedinEvent = Infer<typeof linkedinEventValidator>;
export type EmailEvent = Infer<typeof emailEventValidator>;
export type Observation = Infer<typeof observationBodyValidator>;

/** An observation to append: `observedAt` is when Canon saw it, `occurredAt` when the source says it happened. */
export type PlannedObservation = { body: Observation; observedAt: number; occurredAt?: number };
/** An appended observation. `seq` orders a subject's log: one subject is always on one shard. */
export type LoggedObservation = PlannedObservation & { seq: number };
/** A row of `accountSignals`, the open set kept before observations existed. */
export type OpenSignalRow = {
  trigger: string; quote: string; sourceUrl: string; source: string; reposted?: boolean;
  observedAt: number; firstSeenAt: number; lastSeenAt: number;
};
export type SeenSignal = { signal: Signal; occurredAt?: number };

export const subjectKey = (subject: Subject): string => {
  switch (subject.object) {
    case "account": return `account:${subject.domain}`;
    case "contact": return `contact:${subject.contactId}`;
  }
};

export const signalKey = (signal: Signal): string =>
  signal.bucket === "job" ? `job:${signal.board}:${signal.trigger}` : `${signal.bucket}:${signal.trigger}`;

const bucketOfKey = (key: string) => key.slice(0, key.indexOf(":")) as Bucket;

const isBoard = (source: string): source is Board => source === "greenhouse" || source === "lever" || source === "ashby";

const seen = (signal: Signal, observedAt: number, occurredAt?: number): PlannedObservation =>
  ({ body: { type: "signal_seen", key: signalKey(signal), signal }, observedAt, ...(occurredAt === undefined ? {} : { occurredAt }) });

/**
 * The history an account had before observations: one `signal_seen` per open row, at its first sighting.
 * A row the account's latest check did not refresh had already gone, so it is closed at its last sighting.
 */
export function seedFromOpenRows(rows: readonly OpenSignalRow[]): PlannedObservation[] {
  const lastCheck = Math.max(...rows.map((r) => r.lastSeenAt));
  return rows.flatMap((row): PlannedObservation[] => {
    if (!isBoard(row.source)) return [];
    const signal: Signal = { bucket: "job", trigger: row.trigger, quote: row.quote, url: row.sourceUrl, board: row.source, ...(row.reposted ? { reposted: true as const } : {}) };
    const open = seen(signal, row.firstSeenAt, row.observedAt);
    return row.lastSeenAt < lastCheck ? [open, { body: { type: "signal_gone", key: signalKey(signal) }, observedAt: row.lastSeenAt }] : [open];
  });
}

/** Each key's latest observation, in log order. */
function latestByKey(log: readonly LoggedObservation[]): Map<string, Observation> {
  const latest = new Map<string, Observation>();
  for (const entry of [...log].sort((a, b) => a.seq - b.seq)) latest.set(entry.body.key, entry.body);
  return latest;
}

/**
 * What one read of an account's board or website appends. A new signal, or an open one whose quote or link
 * changed, is seen; an open one that is still the same writes nothing; an open one of the read's `buckets`
 * missing from the read is gone. Open means the key's latest observation is `signal_seen`. An account with
 * no log is seeded first.
 */
export function planSignalObservations(
  log: readonly LoggedObservation[], openRows: readonly OpenSignalRow[], read: readonly SeenSignal[], now: number,
  buckets: readonly Bucket[] = JOB_BUCKETS,
): PlannedObservation[] {
  const seed = log.length ? [] : seedFromOpenRows(openRows);
  const latest = latestByKey([...log, ...seed.map((entry, seq) => ({ ...entry, seq }))]);
  const out = [...seed];
  const current = new Set<string>();
  for (const { signal, occurredAt } of read) {
    const key = signalKey(signal);
    current.add(key);
    const last = latest.get(key);
    const unchanged = last?.type === "signal_seen" && last.signal.quote === signal.quote && last.signal.url === signal.url;
    if (!unchanged) out.push(seen(signal, now, occurredAt));
  }
  for (const [key, last] of latest) if (last.type === "signal_seen" && !current.has(key) && buckets.includes(bucketOfKey(key))) out.push({ body: { type: "signal_gone", key }, observedAt: now });
  return out;
}
