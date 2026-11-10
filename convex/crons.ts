import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("refresh audience summaries", { minutes: 15 }, internal.audiences.refreshSummaries, {});
// Deal page edits on /operatortools (convex/lib/pageEditsDashboard.ts); a refusal or error also refreshes it at once.
crons.interval("seed default modules", { hours: 1 }, internal.moduleDefaults.sweep, {});
// Audiences move into a module: copy each workspace's audiences into it wherever it is on (convex/audienceImport.ts).
crons.interval("copy audiences into their module", { minutes: 15 }, internal.audienceImport.sweep, {});
// Top-level market sizes (docs/tam-and-icps.md): each dimension unfiltered, shared by every workspace.
crons.interval("warm market sizes", { hours: 168 }, internal.marketSize.warm, {});

// Unipile webhooks (status, LinkedIn messages, received mail): registered once, re-checked daily so new sources reach deployments already linked.
crons.interval("ensure unipile webhooks", { hours: 24 }, internal.linkedinActions.ensureWebhooksDaily, {});
crons.interval("refresh linkedin sender feeds", { minutes: 15 }, internal.linkedinFeeds.refreshSenders, {});
// Conversation intake: re-read each opted-in account's chats, in case a webhook was missed (convex/conversations.ts).
crons.interval("reconcile linkedin conversation intake", { hours: 24 }, internal.conversations.reconcile, {});
// Read email threads and LinkedIn conversations that have been quiet 10 minutes for what they changed (convex/conversationExtract.ts).
crons.interval("extract quiet conversations", { minutes: 5 }, internal.conversationExtract.startDue, {});
// Deal plays (docs/deal-plays.md): check each open deal's play once a day as its owner; draft the touches due.
crons.interval("deal play keeper", { hours: 1 }, internal.dealPlayKeeper.tick, {});

// End HubSpot/Salesforce sync runs that outlived Convex's action limit, so a killed sync cannot block syncing for good.
crons.interval("end stale crm syncs", { minutes: 5 }, internal.integrations.endStaleSyncs, {});
crons.interval("restart stopped party mirror drains", { minutes: 5 }, internal.canon.sweepPartyMirror, {});

crons.interval(
  "run scheduled crm syncs",
  // Every 15 minutes, so an hourly schedule runs about hourly rather than every other tick.
  { minutes: 15 },
  internal.integrationActions.runScheduledSyncs,
);

// LinkedIn cadences: start a send chain for each sender with work due (convex/linkedinWorker.ts).
crons.interval(
  "linkedin sender tick",
  { minutes: 5 },
  internal.linkedinWorker.tick,
  {},
);

// Explee: bring each new hot lead (a reply with real interest) in as a contact (convex/expleeActions.ts).
crons.interval(
  "explee hot leads tick",
  { minutes: 10 },
  internal.expleeActions.tick,
  {},
);

// Granola: log each new meeting on its people, company and deal (convex/granolaActions.ts).
crons.interval(
  "granola meetings tick",
  { minutes: 15 },
  internal.granolaActions.tick,
  {},
);

crons.interval(
  "salesforce shadow sync tick",
  { seconds: 15 },
  internal.salesforceSync.tick,
  {},
);

// BugDrop intake: requeue due and stranded intakes, link worker PRs, and
// discover Issues whose webhook was missed. No-ops until configured.




// AI fields with a weekly or monthly refresh: start the due ones on their agent
// owner's ChatGPT plan; hold (and say why) the ones that can't run.
crons.interval(
  "refresh due ai fields",
  { hours: 1 },
  internal.researchAgents.startDueRefreshes,
  {},
);

// Signals: start the daily job-board check for every org that turned it on and whose time has come.
crons.interval(
  "check due account signals",
  { hours: 1 },
  internal.signals.startDue,
  {},
);

// Staged fills nobody approved in time, and the staged copies of approved ones (convex/staging.ts).
crons.interval(
  "expire staged fills",
  { hours: 6 },
  internal.staging.expire,
  {},
);

// Record webhooks: wake each org's fan-out, send due deliveries, purge old ones (convex/recordWebhooks.ts).
crons.interval(
  "sweep record webhooks",
  { minutes: 1 },
  internal.recordWebhooks.sweep,
  {},
);

// Automation rules: wake each org's fan-out, resend runs whose executor died, purge old runs (convex/automations.ts).
crons.interval(
  "sweep automation rules",
  { minutes: 1 },
  internal.automations.sweep,
  {},
);

// Modules: their deal feeds, due schedules and timed transitions, and runs for keys left waiting (convex/moduleJobs.ts).
crons.interval(
  "sweep module jobs",
  { minutes: 1 },
  internal.moduleJobs.sweep,
  {},
);

// The outbox: send what is due, and settle sends that died mid-flight (convex/outboundDispatch.ts).
crons.interval("dispatch outbound messages", { minutes: 1 }, internal.outboundDispatch.tick, {});

// Dialer: hang up and close sessions past their two hours, freeing their numbers (convex/dialer.ts).
crons.interval(
  "reap expired dialer sessions",
  { minutes: 10 },
  internal.dialer.reapExpired,
  {},
);

crons.interval("notify expiring customer links", { hours: 1 }, internal.visits.notifyExpiring, {});

// Record creates' Idempotency-Keys past their day (convex/lib/idempotency.ts).
crons.interval("purge expired idempotency keys", { hours: 1 }, internal.apiIdempotency.purgeExpired, {});

export default process.env.CANONCRM_LOCAL_STACK === "true" &&
  process.env.CANONCRM_LOCAL_CRONS !== "true"
  ? cronJobs()
  : crons;
