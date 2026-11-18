/**
 * A CRM sync's upserts hold the wakes a ledger write schedules (the record service's nudge, webhooks, automations,
 * module feeds, deal history, the party mirror's drain): one per transaction, they ran beside the sync and took more
 * of the deployment than the sync's own writes. The readers follow cursors, so one wake reaches every write before
 * it: the sync wakes them on a timer and when it ends (convex/objects.ts wakeHeldWrites).
 *
 * Pure: no database access, no Node-only imports.
 */
const held = new WeakSet<object>();

/** Hold this transaction's wakes; whoever calls it must see wakeHeldWrites run after. */
export const holdWakes = (ctx: object) => void held.add(ctx);

export const wakesHeld = (ctx: object) => held.has(ctx);
