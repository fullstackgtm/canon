/**
 * An installable module's manifest (docs/modules.md): everything Canon reads to give a module its data, its nav
 * entry and its pages, without running module code. `parseModuleManifest` checks one strictly, with every error a
 * path, as `recipes/manifest.ts` checks a recipe. Pure, with no Node-only imports: Convex queries and mutations, the
 * browser and tests all import it.
 */
import { CAPABILITIES, type Capability } from "../../convex/lib/capabilities.ts";
import { canonCallProblems, CANON_OPERATIONS, type CanonOperation } from "./canonOperations.ts";
import { EVERY_CANON_SOURCE, MAX_DIMENSIONS, MAX_MEASURES, RECORD_GRANT, grantsSource, isCanonSource, isMeasure, joinedDimension, recordObjectName, recordObjectOf, reportReads, reportType, sourceFields, type ReportDecl } from "./reports.ts";
import { WIDGETS, coreOf, fieldParentsAt, mapFieldSpecAt, isScalar, literalChoices, validatorProblems, valueProblems, widgetFits, widgetOf, type FieldSpec, type ObjectValidator, type RefTo, type Scalar, type ValidatorJSON, type Widget } from "./schema.ts";
import { jobKeyProblem } from "./calls.ts";
import { parseDateRange } from "./dateRange.ts";
import { roomRecordCollections, roomRecordFields, roomSource } from "./room.ts";
import { memberPathValid } from "./memberAccess.ts";
import { visitorDomain } from "./visitorIdentity.ts";
import { AI_INPUT_MAX, AI_PER_DAY_MAX, AI_PROMPT_MAX, aiProblems, stepProblems, type AiDecl } from "./ai.ts";
import { PROPOSAL_OPERATION_NAMES, type ProposalOperation } from "./proposals.ts";
import { EMAIL_SENDERS, OUTBOUND_CHANNELS, OUTBOX_ACTIONS, OUTBOX_STATES, SEND_KINDS, TEMPLATE_BINDS, placeholders, type OutboundDecl, type OutboxAction, type OutboxState, type SendKind, type TemplateDecl } from "./outbound.ts";
import { ICP_TREE_FIELDS, icpTreeSchemaFits } from "./icpTree.ts";
import type { DefinitionEdit, EditableHierarchy, EditorCall, InlineEdit } from "./editor.ts";
import { mismatch } from "../../recipes/templates.ts";
import { reportSpec, type ReportSpec } from "../../convex/lib/objects/validators.ts";
import type { ViewFilter } from "../../convex/lib/objects/validators.ts";
import type { RowFocus } from "./setMap.ts";
import { CSV_IMPORT_BATCH_MAX, csvImportProblems, type CsvImportDecl } from "./csvImport.ts";

export const MODULE_FILE = "module.json";
/**
 * module.json as fetched, and as Canon stores it (minified, in UTF-8 bytes). A package row holds the serving manifest
 * in one Convex document of at most 1 MiB, and an upgrade's next manifest has a document of its own
 * (moduleManifests): 900 KB leaves the rest of the row over 100 KB.
 */
export const MODULE_MAX_BYTES = 2 * 1024 * 1024;
export const MODULE_STORED_MAX_BYTES = 900 * 1024;
/** The module API this Canon speaks. A manifest names it, so a later API can tell an older module apart. */
export const MODULE_API = "1";

export type PacingSource = { id: string; label: string; collection: string; date: string; amount: string; filter?: readonly ViewFilter[]; coverage?: boolean };

export type Role = "admin" | "manager" | "rep" | "other";
export type WriteRole = Role | "visitor";
export const ROLES: readonly Role[] = ["admin", "manager", "rep", "other"];

/** Which docs of a collection a role reads: every doc, its teams' owners', its own, or none. */
/** `hier`: the caller's docs and those of everyone under them by manager (users' `managerId`, ten levels). */
export type Scope = "all" | "team" | "hier" | "own" | "ownerOrUnrestricted" | "none";
/**
 * A condition on a doc: one field's value is one of `in` (a missing field reads as null), or it holds a value other
 * than `neq` (a missing field fails it); `all` of several; or `ref`, the module doc a field names passes `where`
 * (false when there is none): "reps see a statement only while its plan is active". The field is a doc ref, or holds
 * the key of a doc of `collection`.
 */
export type RowWhere =
  | { field: string; in: readonly Scalar[] } | { field: string; neq: Scalar }
  | { all: readonly RowWhere[] } | { ref: string; collection?: string; where: RowWhere };
/** How many docs away a row condition's refs reach: a dispute's statement's plan is two. */
export const MAX_REF_CHAIN = 3;
/**
 * A scope narrowed further by one field, such as "reps see only submitted ones" or "reps never see drafts"; or widened
 * by `or`, the docs a condition holds on besides the scope's own: "reps see their own audiences and the shared ones".
 * `members` adds read-only access for named user refs; its optional scope retains the existing base authority.
 */
export type ReadScope = Scope | { scope: Exclude<Scope, "none">; where: RowWhere } | { scope: "own" | "team" | "hier"; or: RowWhere }
  | { members: string; scope?: Exclude<Scope, "none"> };

/**
 * Whether a doc's `data` passes `w`. `related` reads the doc a `ref` names (its collection's data, or null): the
 * field of `from` (the doc under test, or a related doc a chain reached), of `collection`, or the type the field's
 * ref names. Without it, a `ref` fails.
 */
export type RelatedDoc = (field: string, collection: string | undefined, from: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
export async function rowWhereHolds(w: RowWhere, data: Record<string, unknown>, related?: RelatedDoc): Promise<boolean> {
  if ("all" in w) { for (const x of w.all) if (!(await rowWhereHolds(x, data, related))) return false; return true; }
  if ("ref" in w) { const doc = related ? await related(w.ref, w.collection, data) : null; return doc !== null && (await rowWhereHolds(w.where, doc, related)); }
  const value = data[w.field];
  if ("in" in w) return w.in.includes((value ?? null) as Scalar);
  return value !== undefined && value !== null && value !== w.neq;
}
/** Whether `w` reads a related doc anywhere. */
export const whereReadsRef = (w: RowWhere): boolean => ("ref" in w ? true : "all" in w ? w.all.some(whereReadsRef) : false);

export const MAX_COLLECTIONS = 40;
/** A collection's indexes, and each index's fields. Each index is one of moduleDocs' physical slots. */
export const MAX_INDEXES = 8;
export const MAX_INDEX_FIELDS = 4;
/** A set collection's index starts with the parent's key and generation, so it has two fields left for its own. */
export const MAX_SET_INDEX_FIELDS = MAX_INDEX_FIELDS - 2;
export const MAX_VIEW_LIMIT = 1000;
/** The most rows one page binding reads (its view's `limit`, or the page's own): past them a table says so. */
export const MAX_PAGE_ROWS = 1000;
/** A page's bindings: each is one index read, in the page's one query. */
export const MAX_PAGE_BINDS = 20;
/** A call's read plan entries, each one index read in the call's one query (measured: docs/modules.md, "Server code"). */
export const MAX_READS = 40;
/**
 * Calls a module declares. Each is a few hundred bytes of the stored manifest and one entry the page and judge read by
 * name, so the cap is the stored manifest's size, not a per-call cost (docs/modules.md, "Server code").
 */
export const MAX_CALLS = 100;
/**
 * Views a module declares. Like a call, a view costs its bytes of the stored manifest and a name a page, call or guard
 * reads it by; nothing runs per view until one is read. Measured (2026-10-18, Field visits' views repeated): about 120
 * bytes a view, and checking the manifest took 4.6 ms at 100 views, 4.4 ms at 200 and 4.8 ms at 300 (median of 21).
 */
export const MAX_VIEWS = 250;
/** Guards on one op or transition: each is judged in order on every write and on every page that shows the action. */
export const MAX_GUARDS = 20;
/** A form or dialog field's label: a checkbox's label is its whole sentence ("I have read and accept this plan…"). */
export const MAX_FIELD_LABEL = 200;
/** A job key's parts, and the most keys one call of a job takes. */
export const MAX_KEY_PARTS = 4;
export const MAX_JOB_BATCH = 200;

export type CollectionDecl = {
  /** The documents' shape. Its top-level fields are what views, ops, forms and tables name. */
  schema: ObjectValidator;
  /** Maximum live documents. Sets cannot declare a collection-wide limit. */
  max?: number;
  /** "auto": Canon makes each doc's key. `from`: the key is these fields' values joined by "|", so it is unique. */
  key: "auto" | { from: readonly string[] };
  /** A `ref users` field naming the doc's owner: what `own` and `team` read scopes compare with the caller. */
  owner?: string;
  indexes: Record<string, readonly string[]>;
  /** Per role. Admins always read every doc; a role left out reads none. */
  access: Partial<Record<Role, ReadScope>>;
  retainedEvidence?: { deal: string };
  /** Docs that belong to one doc of `parent`: readable only while that doc is, for the same caller. */
  setOf?: { parent: string };
  /** The text field a picker and a ref show a doc by (its first required text field when left out, else its key). */
  title?: string;
  /** Canon timelines and activity reads, from the live doc under this collection's read scope. */
  activity?: ActivityDecl;
  /**
   * A seal over the doc (docs/modules.md, "Integrity"): a transition with `seal` stores in `field` a hash of `fields`
   * and of the live docs of each set in `children` (their listed fields). `{ intact: true }` and a page's `integrity`
   * badge recompute it. Canon owns `field`: no op or call writes it, and a transition's `set` only unsets it.
   */
  integrity?: IntegrityDecl;
  /**
   * Reports over the collection (docs/modules.md, "Reports and charts"): the fields a report groups and filters by,
   * and the number fields it measures. Canon projects the collection's docs into the record service, so a report
   * answers over every doc the caller reads, past any index.
   */
  report?: ReportDecl;
  /** What one doc of it is called in words ("Team group"): a picker's "Pick a team group". Its name, split, when left out. */
  label?: string;
};
export type ActivityDecl = {
  kind: string;
  subject: string;
  /** A date field or a timestamp field with widget `time`. Defaults to creation time. */
  at?: string;
  dueDate?: string;
  status?: string;
  owner?: string;
  /** Scalar or array refs to the named Canon objects. Deals hold projected deal ids. */
  targets: { companies?: string; people?: string; deals?: string };
  /** A declared module page, with literal segments followed by `:key`. */
  path: string;
};
export type IntegrityDecl = { field: string; fields: readonly string[]; children?: Record<string, readonly string[]> };

/** A value a view computes from its arguments, the caller or the clock. */
export type Expr = Scalar | { arg: string } | { caller: "userId" } | ClockExpr;
/**
 * The time a read runs, as ms or as today's date (UTC), or `nowPlusDays` days on (back, when negative): a view or a
 * read plan bounded to "from today", "the last 90 days" or (with `fiscalYearStart`) "this fiscal year" reads only
 * that range, past any number of older docs.
 */
export type ClockExpr = { now: "ms" | "date" } | { nowPlusDays: number; as?: "ms" | "date" };
const DAY_MS = 86_400_000;
export const isClock = (x: unknown): x is ClockExpr => isRecord(x) && ("now" in x || "nowPlusDays" in x);
/** A clock value at `now` (ms): `nowPlusDays` is ms unless `as` says date, as a machine's is. */
export function clockValue(x: ClockExpr, now: number): string | number {
  const at = "now" in x ? now : now + x.nowPlusDays * DAY_MS;
  const as = "now" in x ? x.now : x.as ?? "ms";
  return as === "date" ? new Date(at).toISOString().slice(0, 10) : at;
}
/** A view argument's type. A list (`string[]`, `number[]`) is only for `eq` and `parent`: the view reads each value. */
export type ArgType = "string" | "number" | "boolean" | "string[]" | "number[]";
export const ARG_TYPES: readonly ArgType[] = ["string", "number", "boolean", "string[]", "number[]"];
export const isListArg = (t: ArgType | undefined): boolean => t === "string[]" || t === "number[]";
/** The most values one list argument holds: each is one index range, so a read with more refuses. */
export const MAX_IN_VALUES = 500;
/** Bounds on the index field after `eq`: one index range. */
export type RangeDecl = { gte?: Expr; gt?: Expr; lte?: Expr; lt?: Expr };

export type ViewDecl =
  | {
      kind: "list";
      collection: string;
      args?: Record<string, ArgType>;
      /** For a set collection: the parent doc's key. */
      parent?: Expr;
      /**
       * Read by an index, its leading fields equal to `eq`; without one, every doc in key order. An `eq` value (or a
       * set's `parent`) that names a list argument reads one range per value, in the list's order: an `in`.
       */
      index?: string;
      eq?: readonly Expr[];
      /** Bounds on the index's next field after `eq`, as "visits on or after from". */
      range?: RangeDecl;
      order?: "asc" | "desc";
      limit?: number;
      /** Only the docs that pass it. Read after the index, so a narrow `where` over a wide index returns fewer than `limit`. */
      where?: RowWhere;
    }
  | { kind: "one"; collection: string; args?: Record<string, ArgType>; key: Expr };

/** How an agent may run an op or a transition: as the person would, by proposal a person approves, or never (with the reason). */
const WRITE_ROLES: readonly WriteRole[] = [...ROLES, "visitor"];

export type AgentMode = "allowed" | "propose" | "human";
export const AGENT_MODES: readonly AgentMode[] = ["allowed", "propose", "human"];

export type OpDecl = {
  capability?: Capability;
  label: string;
  kind: "create" | "update" | "delete";
  collection: string;
  /** The fields the op writes. A create's other fields are left out, except the owner, which defaults to the caller. */
  fields?: readonly string[];
  /** Who may run it. Empty with `system`: only Canon runs it. */
  roles: readonly WriteRole[];
  share?: string;
  agent: AgentMode;
  /** Why an agent may not run it: required when `agent` is "human". */
  reason?: string;
  /**
   * Fields the op writes itself, never from the form: a constant, the time, the caller, or a value computed from the
   * doc (an update's doc before it changes; a create's doc as given).
   */
  set?: Record<string, OpExpr>;
  /**
   * Conditions on the doc the op writes, each refusing it with its message: an update's or a delete's doc before it
   * changes, a create's doc as it would be (`parentKey` names a set doc's parent). Checked for every caller, an
   * agent, a call and an approved proposal alike.
   */
  guards?: readonly Guard[];
  /** Only Canon runs it (a job), never a person or their agent. Its roles are empty. */
  system?: true;
  /** Job keys the write makes stale, in the same transaction: computed on the doc before and after it. */
  dirties?: readonly DirtyDecl[];
  /** Notifications and sends the write makes, from the doc after it (a delete's: the doc as it was). `when` skips one. */
  effects?: readonly (NotifyEffect | SendEffect)[];
};

/**
 * A job key a write makes stale (docs/modules.md, "Jobs, watches and schedules"): one value per part of the job's
 * key, each computed from the written doc; `"*"` (trailing parts only) stands for every value, as "every rep of this
 * period". A part that computes null dirties nothing.
 */
export type DirtyDecl = { job: string; key: readonly MachineExpr[] };
/** The wildcard part of a job key. */
export const ANY = "*";

/**
 * Background work over keys (docs/modules.md, "Jobs, watches and schedules"). Canon runs `call` (a system call) over
 * the keys something dirtied, in batches that share their first `batchBy` parts, one key's writes applied all or
 * none. Keys equal but for the `order` part run one at a time, ascending, so a later period waits for an earlier one.
 */
export type JobDecl = {
  label: string;
  call: string;
  /** The key's parts, joined by "|": as ["period", "plan", "user"]. */
  key: readonly string[];
  /** How many leading parts one call's keys share: they come to the call as single values, the rest as lists. */
  batchBy?: number;
  order?: string;
  /**
   * What the `order` part sorts by: a field of the doc of `collection` whose key it is (a period's `start`), read when
   * the key is dirtied. Without it, the part's own text sorts.
   */
  orderBy?: { collection: string; field: string };
  /** Keys per call (50). A batch that fails is split in two until the key that fails is alone. */
  batch?: number;
  /** Runs of one key before Canon stops retrying it and shows its error (5). */
  attempts?: number;
};
export type FeedDecl = { feed: string; call: string; fields: readonly string[]; backfillDays?: number };
/** Canon's records changing, as the records ledger saw them: each change of a deal with its fields before and after. */
export type WatchDecl = { object: WatchedObject; call: string; fields: readonly string[] };
/** A system call Canon runs on a clock: every `everyMinutes`, or daily at `dailyAt` (UTC, "HH:MM"). */
export type ScheduleDecl = { label: string; call: string; everyMinutes?: number; dailyAt?: string };

/** A value an op's `set` computes: a machine's values, without arguments (an op takes none) or created docs. */
export type OpExpr = Exclude<MachineExpr, { arg: string } | { created: string }> | { unset: true };

/**
 * A value a call's read plan computes: a constant, an argument of the call, the caller, or the values of `field` in
 * an earlier read of the same plan (distinct, nulls left out, lists spread), for a list argument. A module doc's
 * fields are `key` (the default), `parentKey`, `owner` and its data's; a Canon record's are `id` (the default) and
 * its granted ones.
 */
export type CallExpr = Scalar | { arg: string } | { caller: "userId" } | { read: string; field?: string } | { toMs: CallExpr; endOfDay?: true } | { toDate: CallExpr }
  | ClockExpr | WorkspaceExpr | { fiscalYearStart: CallExpr; as?: "ms" | "date"; years?: number };
/** A workspace setting a module reads (docs/modules.md, "Fiscal year"): the month (1 to 12) its fiscal year starts. */
export type WorkspaceExpr = { workspace: "fiscalYearStartMonth" };
/** The Canon records a module may read, each with the fields an install grants it. `id` and `createdAt` are always read. */
export const CANON_FIELDS = {
  match: ["by", "personId", "leadId", "companyId", "accountOwner", "candidates"],
  market: ["facets", "sample"],
  web: ["url", "text", "search"],
  social: ["search"],
  me: ["profile", "posts", "counterparts"],
  plan: ["status", "available"],
  signup: ["domain", "spec", "query", "heuristic", "saved", "icp", "sells"],
  deals: ["name", "amount", "currency", "closeDate", "stage", "dealType", "revenueType", "forecastCategory", "probability", "isClosed", "isWon", "closedAt", "nextStep", "ownerId", "splits", "companyId", "companyName", "products", "contractLengthMonths", "arr", "mrr", "createdAt", "updatedAt", "crmProvider", "crmId", "source", "custom"],
  dealState: ["state", "stateHidden", "terms"],
  conversations: ["dealId", "channel", "at", "ownerUserId", "counterpart", "subject", "messages", "more", "inventoryLimited"],
  stageHistory: ["deal", "stage", "fromStage", "changedAt", "leftAt", "daysInStage", "daysSoFar", "current", "ownerId"],
  users: ["name", "email", "role", "managerId", "startDate", "endDate", "title", "department", "isActive"],
  teams: ["name", "managerId", "memberIds"],
  senders: ["ownerId", "name", "address", "status"],
  recording: ["consent", "internalRecording", "internalDomains", "retentionDays", "region"],
  targets: ["year", "fyStart", "coverage", "total", "months", "repMonths", "teamMonths", "repTeam"],
  companies: ["name", "domain", "industry", "employees", "annualRevenue", "country", "city", "status", "ownerId"],
  people: ["name", "title", "email", "phone", "linkedinUrl", "companyId", "ownerId", "lifecycleStage", "suppression"],
  activities: ["kind", "activityKind", "source", "href", "at", "date", "ownerId", "dealId", "companyId", "personId", "subject", "status", "dueDate", "direction", "outcome", "durationSeconds", "text", "transcript", "insights"],
  /** A person's touches from their observations: email, LinkedIn, deal room visits and cold-email replies, never their text. */
  observations: ["personId", "at", "channel", "event", "direction"],
  audiences: ["name", "size", "shared", "createdBy"],
  /**
   * Canon's recorded calls and meetings (docs/modules.md, "Calls"). `transcript` grants `calls.transcript`, one call's
   * lines with their speakers, sides and times; `insights` adds Canon's insights on it.
   */
  calls: ["title", "at", "durationSeconds", "ownerId", "dealId", "provider", "analyzedAt", "transcript", "insights"],
  /** The module's own proposals (docs/modules.md, "Writes to Canon records"): each one's plan status and row counts. */
  proposals: ["operation", "status", "reason", "decidedAt", "total", "applied", "skipped", "failed", "pending", "skippedRows", "created"],
  /** Hosted research's field registrations (AI fields), as the AI fields page shows them (docs/modules.md, "Server code"). */
  research: ["label", "attribute", "kind", "question", "options", "answerType", "entity", "autoAccept", "refreshCadence", "refreshNextAt", "refreshHold", "recipe", "owner", "agentStatus", "agentMessage", "latestRun", "canEditGate", "canRefresh", "refreshEstimate"],
  researchRuns: ["status", "inScope", "planned", "done", "skipped", "answered", "unknown", "noEvidence", "inferred", "errors", "pagesRead", "llmCalls", "error", "stop", "credits", "scheduled", "probe", "updatedAt", "runtime", "sample", "verdict", "progress"],
  researchTraces: ["recordId", "label", "status", "value", "quote", "sourceUrl", "reason", "jev", "inferred", "steps", "ms", "calls", "model", "promptVersion"],
  researchAnswers: ["entityId", "account", "value", "status", "evidence", "confidence", "verification", "verifiedBy", "observedAt", "decidedBy"],
  /**
   * Canon's run history (docs/modules.md, "Runs"): CLI runs, retained evidence and lead runs, syncs, patch-plan events,
   * health checks and record jobs. `findings`, `events`, `crm` and `document` come only with one run (`runs.cli`,
   * `runs.artifact`).
   */
  runs: ["kind", "title", "detail", "status", "at", "durationMs", "counts", "error", "href", "startedAt", "progress", "phases", "stoppable", "findings", "events", "crm", "document"],
  agents: ["label", "fields", "budget", "turnsToday", "route", "crmTrigger", "slack", "webhook", "principal"],
  agentTurns: ["trigger", "status", "skip", "subject", "account", "outputs", "spend", "budgetHit", "error", "payload", "waiting", "routing", "slack"],
  agentOptions: ["fields", "owners", "audiences", "slack", "permissions", "grantSigningReady"],
  agentGrants: ["fieldLabel", "entityType", "allowedValues", "maxPerDay", "expiresAt", "createdBy", "revokedAt", "state", "stateLabel", "usedToday"],
} as const;
/**
 * What a Canon record's choice fields read as in a page's text, by object and field (`latestRun.status` a nested
 * one's), as a collection schema's `labels` do: `{$row.kind}` shows "Classify".
 */
export const CANON_LABELS: Partial<Record<CanonObject, Record<string, Record<string, string>>>> = {
  research: {
    kind: { classify: "Classify", qa: "Question" },
    entity: { account: "Accounts", contact: "People" },
    refreshCadence: { weekly: "Weekly", monthly: "Monthly" },
    agentStatus: { active: "Active", paused: "Paused", archived: "Archived" },
    "latestRun.status": { running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled" },
  },
};
export type CanonObject = keyof typeof CANON_FIELDS;
/**
 * The deal fields a watch may watch: the ones a deal's records-ledger entries carry, so every change to them is an
 * entry with the value before and after. Splits, products and the CRM fields change on the deal row only.
 */
export const WATCHED_DEAL_FIELDS = ["name", "amount", "currency", "closeDate", "stage", "forecastCategory", "probability", "isClosed", "isWon", "ownerId", "companyId", "dealType"] as const;
/**
 * What a watch may watch, by object: the fields records-ledger entries carry for it, in a module's names. Companies
 * and people reach the ledger once someone works them; activities are its notes, tasks, calls and meetings.
 */
export const WATCHED_FIELDS = {
  deals: WATCHED_DEAL_FIELDS,
  companies: ["name", "domain", "industry", "employees", "country", "status", "ownerId"],
  people: ["name", "title", "email", "phone", "linkedinUrl", "ownerId", "lifecycleStage"],
  activities: ["kind", "at", "ownerId", "dealId", "companyId", "personId", "subject", "status", "dueDate", "direction", "outcome", "durationSeconds"],
} as const;
export type WatchedObject = keyof typeof WATCHED_FIELDS;
const WATCHABLE = [...new Set(Object.values(WATCHED_FIELDS).flat())];
/** Canon's reads a read plan may name: each reads one granted object, as the caller sees it, by an index. */
export const CANON_READS = {
  "match.inbound": { object: "match", args: { email: "string", companyName: "string" }, optional: ["companyName"] },
  "social.search": { object: "social", args: { source: "string", query: "string", limit: "number" }, optional: ["limit"] },
  "me.context": { object: "me", args: { section: "string" }, optional: ["section"] },
  "me.status": { object: "me", args: {} },
  "web.search": { object: "web", args: { queries: "string[]" } },
  "web.pages": { object: "web", args: { domain: "string", urls: "string[]" }, optional: ["domain", "urls"] },
  "ai.plan": { object: "plan", args: {} },
  "market.sample": { object: "market", args: { queries: "string[]" } },
  "deals.latestClosed": { object: "deals", args: { won: "boolean" } },
  "companies.bestFit": { object: "companies", args: {} },
  "research.signup": { object: "signup", args: {} },
  "market.facets": { object: "market", args: { query: "string", groupBy: "string" }, optional: ["groupBy"] },
  "deals.closedBetween": { object: "deals", args: { from: "string", to: "string" } },
  "deals.updatedSince": { object: "deals", args: { since: "number" } },
  "deals.byIds": { object: "deals", args: { ids: "string[]" } },
  "deals.forOwner": { object: "deals", args: { owner: "string" } },
  "deals.asOf": { object: "deals", args: { at: "number", from: "string", to: "string" } },
  "deals.changesBetween": { object: "deals", args: { since: "number", until: "number", from: "string", to: "string" } },
  "users.all": { object: "users", args: {} },
  "users.withInactive": { object: "users", args: {} },
  "teams.all": { object: "teams", args: {} },
  "recording.policy": { object: "recording", args: {} },
  "targets.forYear": { object: "targets", args: { year: "number", on: "string" }, optional: ["year", "on"] },
  "senders.byIds": { object: "senders", args: { ids: "string[]" } },
  "senders.forMembers": { object: "senders", args: { ids: "string[]" } },
  "companies.byIds": { object: "companies", args: { ids: "string[]" } },
  "people.byIds": { object: "people", args: { ids: "string[]" } },
  "suppression.check": { object: "people", args: { ids: "string[]", purpose: "string" }, optional: ["purpose"] },
  "people.forCompanies": { object: "people", args: { ids: "string[]" } },
  /** The people on each deal (its contacts and their roles), as the caller sees them: a row per deal and person, with `dealId` and `role`. */
  "deals.people": { object: "people", args: { ids: "string[]" } },
  "deals.state": { object: "dealState", args: { ids: "string[]" } },
  "deals.conversations": { object: "conversations", args: { ids: "string[]" } },
  /**
   * What each person did, oldest first, from `since` to `until` (ms): email, LinkedIn, deal room visits and cold-email
   * replies (`types` narrows), for the people the caller sees. A row per touch.
   */
  "observations.forPeople": { object: "observations", args: { people: "string[]", since: "number", until: "number", types: "string[]" }, optional: ["since", "until", "types"] },
  "activities.forDeals": { object: "activities", args: { ids: "string[]", since: "number" }, optional: ["since"] },
  "activities.forCompanies": { object: "activities", args: { ids: "string[]", since: "number" }, optional: ["since"] },
  "audiences.all": { object: "audiences", args: {} },
  /** One record: a frozen copy of the audience's members now, as `{ id, createdAt, audience, count, pages }`. */
  "audiences.snapshot": { object: "audiences", args: { audience: "string" } },
  /** One page (0-based, `SNAPSHOT_PAGE` people) of a snapshot this module took, as people records. */
  "audiences.members": { object: "people", args: { snapshot: "string", page: "string" } },
  /**
   * One record: the people a module interface's doc names, frozen now as the reader sees them (`provides.<name>.people`),
   * as `{ id, createdAt, source, count, withEmail, pages }`. Without `module`, one of this module's own interfaces.
   */
  "people.snapshot": { object: "people", args: { module: "string", provide: "string", key: "string" }, optional: ["module"] },
  /** One record: caller-visible count, withEmail, customVariables and computedAt for the doc, frozen nowhere. */
  "people.count": { object: "people", args: { module: "string", provide: "string", key: "string" }, optional: ["module"] },
  /** One page (0-based, `SNAPSHOT_PAGE` people) of a snapshot this module took, as people records. */
  "people.snapshotPage": { object: "people", args: { snapshot: "string", page: "string" } },
  "proposals.byIds": { object: "proposals", args: { ids: "string[]" } },
  "calls.between": { object: "calls", args: { from: "string", to: "string" } },
  "calls.byIds": { object: "calls", args: { ids: "string[]" } },
  /** One record: the call's granted fields, `timed`, its `segments` and, granted, its `insights`. At most one a plan. */
  "calls.transcript": { object: "calls", args: { call: "string" } },
  /** The workspace's AI fields as the AI fields page lists them: its fields, their gate, owner, refresh and latest run. */
  "research.fields": { object: "research", args: { slug: "string" }, optional: ["slug"] },
  /** Latest ten runs, or any selected run of the field, through the platform's CP14 projection. */
  "research.runs": { object: "researchRuns", args: { slug: "string", run: "string" }, optional: ["run"] },
  "research.traces": { object: "researchTraces", args: { run: "string" } },
  /** Action-only. Record-service admission precedes the platform answer projection. */
  "research.answers": { object: "researchAnswers", args: { slug: "string" } },
  /** Run history from `from` to `to` (dates, UTC; either open), excluding quiet CLI successes and duplicate retained output; refuses past the read's limit. */
  "runs.between": { object: "runs", args: { from: "string", to: "string" }, optional: ["from", "to"] },
  /** One record: a CLI run with its findings and events. None for a role that sees only some records. */
  "runs.cli": { object: "runs", args: { run: "string" } },
  /** One record: a retained evidence or lead run with its document. */
  "runs.artifact": { object: "runs", args: { artifact: "string" } },
  /** Live event agents, whole or refused. An optional id selects one live event agent. */
  "agents.event": { object: "agents", args: { agent: "string" }, optional: ["agent"] },
  /** The fixed latest 25 turns, newest first, with principal and audience visibility applied now. */
  "agents.turns": { object: "agentTurns", args: { agent: "string" } },
  /** One row of safe management metadata, projected to reads.agentOptions. */
  "agents.options": { object: "agentOptions", args: { agent: "string" }, optional: ["agent"] },
  /** An agent's complete standing grants and exact recent usage, without signing material. */
  "agents.grants": { object: "agentGrants", args: { agent: "string" } },
  /** One research run. Its traces are returned only for a principal or a viewer with full record visibility. */
  "runs.research": { object: "runs", args: { run: "string" } },
} as const satisfies Record<string, { object: CanonObject; args: Record<string, ArgType>; optional?: readonly string[] }>;
export type CanonRead = keyof typeof CANON_READS;
/**
 * The Canon reads served by the record service (companies, people, activities): Canon reads them in the call's
 * action, after the plan's one query, as the caller (docs/modules.md, "Server code"). So no later read takes its
 * values from one of them.
 */
export const RECORD_SERVICE_OBJECTS: readonly CanonObject[] = ["companies", "people", "activities", "observations"];
export const isRecordServiceRead = (read: CanonRead) => read === "match.inbound" || read === "audiences.snapshot" || read === "deals.conversations" || RECORD_SERVICE_OBJECTS.includes(CANON_READS[read].object);
/**
 * Whether a page may bind a Canon read (docs/modules.md, "Pages"): one Canon answers in the page's query, so it updates
 * live. Record-service reads and deal company names need an action.
 */
export const pageReadable = (read: CanonRead, manifest: ModuleManifest) => read !== "research.answers" && read !== "me.context" && read !== "web.pages" && read !== "web.search" && read !== "social.search" && read !== "market.sample" && read !== "deals.latestClosed" && !isRecordServiceRead(read) && !(CANON_READS[read].object === "deals" && manifest.reads?.deals?.includes("companyName"));
/**
 * People per page of an audience snapshot (docs/modules.md, "Audiences"): a job reads one page per key, so a
 * 25,000-person audience is 50 keys, each well under a read's limit.
 */
export const SNAPSHOT_PAGE = 500;
/** The most docs one read of a read plan returns. A read with more refuses the call: compute never sees part of a set. */
export const MAX_READ_DOCS = 5000;

/**
 * One entry of a call's read plan: a module view, or a Canon read, with arguments from the call. Canon resolves the
 * whole plan in one query, as the caller.
 */
export type ReadDecl =
  | { view: string; args?: Record<string, CallExpr>; limit?: number }
  /** `custom`: a deal read carries each deal's custom fields too (`reads.deals` grants `custom`), at most 500 deals. */
  | { canon: CanonRead; args?: Record<string, CallExpr>; limit?: number; custom?: true }
  /**
   * Another module's published interface (docs/modules.md, "Reading another module"): `provide` names one the module
   * `module` declares in `provides` and this one in `uses`. Read as the caller, under that module's own read scopes;
   * `{ missing }` when it isn't installed, on, or providing it.
   */
  | { module: string; provide: string; args?: Record<string, CallExpr>; limit?: number }
  /**
   * A territory tree over the workspace's companies (docs/modules.md, "Territories"): an earlier read's docs as its
   * nodes, each a query line, counted by the record service as the caller sees companies, with precedence among
   * siblings, named companies, and optionally owners, deal pipeline and bookings by territory, and one node's cells.
   */
  | { tree: TreeRead }
  /** Literal overlapping ICP sets, compiled from earlier own-doc list reads and counted as the caller. */
  | { icpTree: IcpTreeRead }
  /**
   * An aggregate over every doc of a reported collection the caller reads (docs/modules.md, "Reports and charts"):
   * counts, sums, mins and maxes by up to two dimensions, from the record service, never the docs themselves. A wide
   * status count with no 5,000-doc read.
   */
  | { report: ReportRead }
  /**
   * A team aggregate (docs/modules.md, "Team aggregates"): a count, sums and averages over every doc of a reported
   * collection, the docs the caller can't read row by row too, given to the call's code only when they come from at
   * least `minOwners` owners. Never the docs, never a doc's own value: a rep's team benchmark.
   */
  | { aggregate: AggregateRead };
/**
 * A team aggregate's shape: its collection (reported, with an owner, not a set), its values (count, sum, avg; never a
 * min or a max, which is one doc's value), a filter whose values from the call's arguments only test `eq` (so two
 * arguments read disjoint sets, never one inside another), and the fewest owners it needs (3 at least, the default).
 */
export type AggregateRead = { collection: string; values: readonly { fn: "count" | "sum" | "avg"; field?: string }[]; filter?: readonly ReportReadFilter[]; minOwners?: number };
/** The fewest owners a team aggregate reads over: with the caller one of them, the rest are at least two people. */
export const MIN_AGGREGATE_OWNERS = 3;
/** A read plan's report: its collection, the dimensions it groups by, its values (a count when none) and its filter. */
export type ReportRead = ReportShape & { filter?: readonly ReportReadFilter[] };
/** A report read's filter: a dimension of the doc's own, an operator, and a value from the call. */
export type ReportReadFilter = { field: string; op: (typeof REPORT_READ_OPS)[number]; value?: CallExpr };
export const REPORT_READ_OPS = ["eq", "neq", "in", "gt", "gte", "lt", "lte", "empty", "notEmpty"] as const;

/**
 * A server function (docs/modules.md, "Server code"): Canon reads its `reads` as the caller, runs the module's code
 * on them in the recipe runtime, and applies the writes it returns, each checked, all or none.
 */
export type CallDecl = {
  capability?: Capability;
  /** Human-only platform write; never executes module code or a read plan. */
  canon?: { operation: CanonOperation; then?: {
    machine: string; transition: string; key: string; expect: string;
    input: Record<string, { field: string }>;
    args: { jobId: { result: "jobId" } };
  } };
  label: string;
  /** What the caller supplies, checked as a collection's schema is. */
  args?: ObjectValidator;
  roles: readonly Role[];
  /**
   * How an agent may start it. Each transition it returns is checked again against its own agent mode. `propose`: an
   * agent's run writes nothing; its writes wait as one patch plan a person approves (docs/modules.md, "Agents").
   */
  agent: "allowed" | "human" | "propose";
  /** A proposed run's summary on Patch plans: a text over its arguments and value, `{$args.call|money}`, `{$value.count}`. */
  proposal?: { summary: Text };
  reason?: string;
  reads: Record<string, ReadDecl>;
  /** The collections its writes may touch. Anything else refuses the whole call. */
  writes: readonly string[];
  /** "value": the call returns its result to the caller as well. */
  returns: "none" | "value";
  /** Only Canon runs it (a job), in its own isolate, reading every doc. Its roles are empty. */
  system?: true;
  /** How a page shows the value it returns, under the button that ran it. Needs `returns: "value"`. */
  result?: CallResult;
  /** A sentence the person confirms before a page runs it. */
  confirm?: string;
  /**
   * A hosted AI step in place of code (docs/modules.md, "Hosted AI steps"): Canon asks the caller's model for the
   * fields of one doc, keeps only the quotes it finds word for word, and writes them through a declared update op.
   */
  ai?: AiDecl;
  /** A pure member continuation scheduled by a transition, without a model call. */
  step?: { key: string; machine: string; fail: string; logFailure?: { domain: string; stage: "deriving" } };
};

/**
 * A call's value on the page: `table` (the rows of `rows`, a field of the value, or the value when it is a list; each
 * column's text fills `{$row.<field>}`), `kpis` (figures from `{$result.<field>}`) or `message` (the value as text).
 */
export type CallResult =
  | ({ kind: "table"; rows?: string; columns: readonly Column[]; empty?: Text } & TableKeys)
  | { kind: "kpis"; items: readonly ({ label: string; value: Text } & KpiExtras)[] }
  | { kind: "message" };

/**
 * A value a guard, a transition's `set` or an effect computes: a constant, an argument of the transition, a field of
 * the doc it moves (`key` is its key, `parentKey` a set doc's parent), the caller, or the time. Computed ones:
 * `increment` adds `by` (1) to a number field (missing reads as 0); `nowPlusDays` is the time `n` days on, in ms or
 * as a date; `copy` is a field's value as stored, a list or an object too; `lookup` is a field of the first doc a
 * view returns (null when none); `created` is the key of a doc an earlier effect of the transition created.
 */
export type MachineExpr =
  | Scalar | { shared: { from: "root" | "parent"; field: string } } | { visitor: "email" | "name" | "label" | "verified" | "id" } | { arg: string } | { doc: string } | { caller: "userId" | "role" } | { now: "ms" | "date" }
  | { increment: string; by?: number } | { nowPlusDays: number; as?: "ms" | "date" } | { copy: string }
  | { lookup: { view: string; args?: Record<string, MachineExpr> }; field: string } | { created: string }
  /** A date (`YYYY-MM-DD`, UTC) as ms (its start, or its last ms with `endOfDay`), or a time in ms as its date. */
  | { toMs: MachineExpr; endOfDay?: true } | { toDate: MachineExpr }
  /** A time (ms) or a date plus `days` (computed: a field's, a lookup's), as the base is, or `as` says. */
  | { addDays: MachineExpr; days: MachineExpr; as?: "ms" | "date" }
  /** The first value less the second, each a number (a field's, a lookup's); none when either isn't: a version's net change. */
  | { subtract: readonly [MachineExpr, MachineExpr] }
  /** How many docs a list view returns for its arguments: a new step's position after the steps there are. */
  | { count: { view: string; args?: Record<string, MachineExpr> } }
  /** The workspace's fiscal year start month, or the day the fiscal year holding a date or a time starts (a date, or `as`). */
  | WorkspaceExpr | { fiscalYearStart: MachineExpr; as?: "ms" | "date"; years?: number }
  /** Where the person ran a transition that declares `evidence`: their IP address or browser, as Canon's web server saw them. */
  | { evidence: Evidence };
/** What a transition's `evidence` records of where a person ran it (docs/modules.md, "Evidence"). */
export const EVIDENCE = ["ip", "userAgent"] as const;
export type Evidence = (typeof EVIDENCE)[number];
/** A value a `set` writes: any value, or `{ unset: true }`, which removes an optional field. */
export type SetExpr = MachineExpr | { unset: true };
/** Who a notification goes to: a value naming a member (`{ doc: "rep" }`, the caller), or every member of `role`. */
export type Recipient = MachineExpr | { role: readonly Role[] };

/**
 * A condition on a doc: `field` names a field of the doc under test (the transitioning doc, or in a count's `where`
 * the counted doc). `count` reads a declared list view, at most 1,000 docs, whoever can see them.
 */
export type Predicate =
  | { shared: { from: "root" | "parent" }; where: Predicate }
  | { field: string; in: readonly Scalar[] }
  | { field: string; eq: MachineExpr }
  | { field: string; ne: MachineExpr }
  | { field: string; gte: MachineExpr }
  | { field: string; lte: MachineExpr }
  | { truthy: MachineExpr }
  | { caller: "isOwner" | "isNotOwner" | "ownerOnTeam" }
  | { role: readonly Role[] }
  | { not: Predicate }
  | { all: readonly Predicate[] }
  | { any: readonly Predicate[] }
  | { count: { view: string; args?: Record<string, MachineExpr>; where?: Predicate }; atLeast?: number; atMost?: number }
  /** A related doc, read by its key (a field holding it, or `parentKey`), passes `where`; false when there's none. */
  | { ref: { collection: string; key: MachineExpr }; where: Predicate }
  /** Every row of the list field `list` passes `where` (true for none). In `where`, `field` names the row's fields. */
  | { every: { list: string; where: Predicate } }
  /** The doc is sealed and still matches its seal: its collection's `integrity` hash, recomputed. */
  | { intact: true }
  /** How many rows of `list` pass `where` (every row without one). */
  | { items: { list: string; where?: Predicate }; atLeast?: number; atMost?: number }
  /** The number of characters of a text field (a missing one: 0) is in bounds: a 500-character note. */
  | { length: string; atLeast?: number; atMost?: number }
  /** The rows of `list` hold `field` in ascending order (`strict`: no two equal), a row without one failing it: tiers by their floor. */
  | { ordered: { list: string; field: string; strict?: true } }
  /** No two rows of `list` hold ranges `from` to `to` that overlap (a missing `to` runs on): tiers that don't overlap. */
  | { disjoint: { list: string; from: string; to: string } }
  /** No two rows of `list` hold the same `field`. */
  | { unique: { list: string; field: string } }
  /** The sum of `field` over the rows of `list` (a list of numbers: the numbers), a missing value as 0. */
  | { sum: { list: string; field?: string }; eq: MachineExpr } | { sum: { list: string; field?: string }; ne: MachineExpr }
  | { sum: { list: string; field?: string }; gte: MachineExpr } | { sum: { list: string; field?: string }; lte: MachineExpr }
  /**
   * No key of `job` under `keyPrefix` is waiting or running, and the module's deal feed has read the ledger as far as
   * it goes now: what the job wrote is current. A period's close and a statement's lock declare it.
   */
  | { fresh: { job: string; keyPrefix: readonly MachineExpr[] } };
export type Guard = { when: Predicate; message: string };

/**
 * What else a transition does in the same transaction: move related docs through their machine, create a doc, or
 * copy one with its sets and related docs. `when` (on the moved doc, after the move) skips an effect that doesn't
 * apply; `as` names a doc an effect creates, for a later effect's `{ created }`.
 */
export type EffectDecl = { when?: Predicate } & (
  | { machine: string; transition: string; key: MachineExpr; onlyFrom?: readonly string[] }
  /**
   * `bulk`: past one transition's write cap, as a job: the doc waits in the state its transition moved it to while
   * Canon moves the view's docs in batches, then runs `then`, a system transition of the doc's machine, once every doc
   * has moved. A doc whose move is refused stops it there, named, until a person retries it (or moves the doc on).
   * Without `then` (only for a transition with no guards, which no doc refuses) the doc moves on at once.
   */
  | { machine: string; transition: string; view: string; args?: Record<string, MachineExpr>; onlyFrom?: readonly string[]; bulk?: { then?: string } }
  | { create: string; parent?: MachineExpr; data: Record<string, MachineExpr>; as?: string }
  | {
      /** A new doc of `copy` with the fields of the doc `key` names (its machine fields at their initial state), then `set`. */
      copy: string; key: MachineExpr; set?: Record<string, MachineExpr>;
      /** Set collections of `copy` whose docs are copied under the new doc. */
      children?: readonly string[];
      /** Docs of `collection` whose `field` holds the copied doc's key, copied with it pointing at the new doc. */
      related?: readonly { collection: string; field: string }[];
      as?: string;
    }
  | Omit<NotifyEffect, "when">
  | Omit<SendEffect, "when">
);
/**
 * An in-app notification (docs/modules.md, "Notifications") to each recipient but the person who caused it: a
 * `message` (`{$doc.<field>|format}` from the doc after the move or the write) and a `link`, a page of the module
 * (`:key`, `:field`). A transition's effect, or an op's.
 */
/**
 * `subject`: the line the bell shows above the message, filled as the message is; `badge`: what kind of notice it is
 * ("Dispute"); `email`: it is emailed too, to each member who wants this module's notices by email (docs/modules.md,
 * "Outbound").
 */
export type NotifyEffect = { when?: Predicate; notify: readonly Recipient[]; message: string; link?: string; subject?: string; badge?: string; email?: true };
/**
 * A message sent through the outbox (docs/modules.md, "Outbound"), decided in the write's own transaction: a template
 * to a Slack channel, webhook, members or canonical contacts. People email names an explicit sender; Canon decides
 * its grant or exact-owner consent. `approval: "person"` holds a legacy-channel send for a person.
 */
type LegacySendTo = { slack: string } | { webhook: string } | { members: readonly Recipient[] };
export type SendTo = LegacySendTo | { people: readonly MachineExpr[] };
export type SendEffect = { when?: Predicate; send: { template: string } & (
  | { to: LegacySendTo; kind?: SendKind; approval?: "person"; from?: never }
  | { to: { people: readonly MachineExpr[] }; from: { sender: MachineExpr }; kind?: "personal" | "automated"; approval?: never }
) };

/** A transition's target: a state, the state a field saved, or the first case whose `when` holds. */
export type TargetDecl = string | { restore: string; fallback: string } | { cases: readonly { when: Predicate; to: string }[]; else: string };

export type TransitionDecl = {
  capability?: Capability;
  label: string;
  from: readonly string[];
  /**
   * A state; the state saved in a field (a dispute's resolution restores the status it saved), else `fallback`; or
   * the first case whose `when` holds on the doc, else `else`. Left out, the doc stays in its state: an action on it,
   * such as Duplicate, with its guards, effects and history.
   */
  to?: TargetDecl;
  /** Who may run it. Empty: only as another transition's effect, or with `system`, as Canon. */
  roles: readonly WriteRole[];
  share?: string;
  /** Only Canon runs it as itself (a job), as "System" in the history; never a person or their agent. Roles are empty. */
  system?: true;
  agent: AgentMode;
  reason?: string;
  /** A sentence the person confirms before it runs. */
  confirm?: string;
  guards?: readonly Guard[];
  /** What the caller supplies (a reason, a note), checked as a collection's schema is. */
  args?: ObjectValidator;
  /** Fields it writes on the doc, from the doc before the move, its args, the caller or the time; `{ unset: true }` removes one. */
  set?: Record<string, SetExpr>;
  /** Seal the doc as it moves: its collection's `integrity` hash over its fields and set docs, stored in its field. */
  seal?: true;
  effects?: readonly EffectDecl[];
  /** Job keys the move makes stale, computed on the doc after it moves. */
  dirties?: readonly DirtyDecl[];
  /**
   * What Canon records of where the person ran it, from its web server's view of the request, signed there: an
   * e-signature's IP address and browser. On the doc's history row, and in `set` as `{ evidence }`. A person only.
   */
  evidence?: readonly Evidence[];
  /**
   * A field holding a time (ms) or a date: Canon runs this system transition on each doc in a `from` state once the
   * time has come. The collection needs an index that starts with the machine's field and this one.
   */
  at?: string;
  /**
   * A hosted AI call (one with `ai.queue`) Canon starts once the move is done, on this doc, in the background, as the
   * person who moved it, or for a system move as the doc's owner (docs/modules.md, "Hosted AI steps").
   */
  ai?: string;
  run?: string;
};

/** A state machine over one field of a collection: only its transitions change that field. */
export type MachineDecl = {
  collection: string;
  field: string;
  states: readonly string[];
  initial: string;
  transitions: Record<string, TransitionDecl>;
};

/** A value a page computes: a constant, a route parameter or the caller. */
export type PageExpr = Scalar | { route: string } | { caller: "userId" } | { query: string; default?: Scalar };
/**
 * A value a form fills a field with: a page value, a field of a doc the page binds (`key` is its key), a field of the
 * table row an action sits on (`{ row }`), or today's date (`{ today: true }`, as the person's browser has it).
 */
export type FormExpr = PageExpr | { bind: string; field: string } | { row: string } | { today: true };
/**
 * Per row, how many docs of a list view hold the row's `of` value (its key by default) in `by` (a field, or
 * `parentKey` for a set): the view takes one list argument, read once for every row. With `collect`, the distinct
 * values those docs hold in that field instead, as a list: a plan's reps from its assignments, for an avatars column.
 */
export type CountDecl = { view: string; by: string; of?: string; collect?: string };
/**
 * A view the page reads, its arguments from the page or from a field of a doc another binding reads (`{ bind, field }`:
 * the statement's rep and plan, for its previous and next). `join` names ref fields whose doc (a module doc, a deal or a member, as the caller may read it)
 * comes with each row, so text reads `{$row.deal.amount}`; `count` adds a number per row (`{$row.notes}`); `limit`
 * the rows it reads (its view's, else 50; at most 1,000).
 */
export type Binding =
  | { view: string; args?: Record<string, FormExpr>; join?: readonly string[]; count?: Record<string, CountDecl>; limit?: number; call?: undefined; canon?: undefined }
  /**
   * A call's value, run when the page opens (docs/modules.md, "Values a page loads"): a call that writes nothing and
   * returns its value, its arguments from the page or a doc another binding reads. The page keeps it per arguments
   * and runs it again on Refresh.
   */
  | { call: string; args?: Record<string, FormExpr>; refreshMinutes?: number; refreshOn?: readonly string[]; view?: undefined; join?: undefined; count?: undefined; limit?: undefined; canon?: undefined }
  /**
   * A Canon read the manifest's `reads` grants, read in the page's query as the caller, so it updates live as a view
   * does (docs/modules.md, "Pages"): its records are the rows, `key` each one's `id`. At most `limit` (50), else it refuses.
   */
  | { canon: CanonRead; args?: Record<string, FormExpr>; limit?: number; view?: undefined; call?: undefined; join?: undefined; count?: undefined };

/** Text with `{$<bind>.<field>}` or `{$row.<field>}` placeholders, each with an optional format: `{$row.amount|money}`. */
export type Text = string;
/** A row's value a table sorts, filters, groups, searches or totals by: a field, a count, or `<join>.<field>`. */
export type RowPath = string;
export const FORMATS = ["money", "date", "time", "number", "percent", "user", "ref", "file", "fy", "stage", "dealType", "dealSource", "json"] as const;
export type Format = (typeof FORMATS)[number];

/**
 * A create's or an update's values from the page: `fixed` fields the person never sees (the plan the page is on),
 * `initial` ones the form starts from.
 */
/**
 * The page a transition action opens after it runs, on a doc its effects created (a Duplicate's copy): a path whose
 * `:key` is that doc's key, or `{ created, path? }`, `created` naming the effect's `as` (`true`: the first created) and
 * `path` the page (by default the table's `rowLink` on a row, else the page's own path).
 */
export type TransitionThen = string | { created: true | string; path?: string } | { created?: undefined; path: string };
/** A value a form or a dialog starts from: a page value, or a text over the page and the row ("{$row.name} (Copy)"). */
export type InitialExpr = FormExpr | { text: Text };
export type Prefill = { fixed?: Record<string, FormExpr>; initial?: Record<string, InitialExpr> };
export type JsonQueryExpr = { query: string; json: true };
export type FormPrefill = { fixed?: Record<string, FormExpr | JsonQueryExpr>; initial?: Record<string, InitialExpr> };
/**
 * Only on the docs whose field holds one of `in`, is set (or not), or names the person who opens the page (`me: true`)
 * or doesn't (`me: false`): a row action shows on the rows it fits ("Assign to me" while someone else holds it).
 */
export type ActionWhen = { field: string; in: readonly Scalar[] } | { field: string; set: boolean } | { field: string; me: boolean };
/**
 * A value of the page an action's `when` tests: a URL parameter (with its default), a route parameter, or a field of a
 * doc the page binds.
 */
export type PageValue = { query: string; default?: Scalar } | { route: string } | { bind: string; field: string };
/** What a page value is compared with: a constant, or today's year, month (`YYYY-MM`) or date. */
export type WhenValue = Scalar | { now: "year" | "month" | "date" };
/** Only while a page value holds one of `in`, is set (or not), or is at least (`gte`) or at most (`lte`) a value. */
export type PageWhen = { page: PageValue } & ({ in: readonly Scalar[] } | { set: boolean } | { gte: WhenValue } | { lte: WhenValue });
/**
 * What every action may carry: `when` (on its doc, or on a page value: no Recalculate for a past year), `aria` (what a
 * screen reader says for its button, filled as its label is: "Dispute {$row.dealName}"), and on a write, `toast` (what
 * it says when it is done, in place of "<Label>: done").
 */
type ActionCommon = { when?: ActionWhen | PageWhen; aria?: Text; toast?: Text };
/**
 * A dialog's words, each a text over the page and the row: its `title` (else the action's label), the line under it
 * (`description`) and its submit button's label (`submit`, else the title). "Approve \"{$row.period}\"?" on an Approve.
 */
export type DialogWords = { title?: Text; description?: Text; submit?: Text; badge?: Text };
/**
 * What a write waits for once it is done: the keys of `job` under `keyPrefix` it made stale, until none waits or runs.
 * Then it says `toast`, a text over the page, the row, a call's value (`{$result.*}`) and `{$job.seconds}`:
 * "Commissions updated: {$result.statements} statements in {$job.seconds}s".
 */
export type JobWait = {
  job: string; keyPrefix?: readonly FormExpr[]; toast: Text;
  /**
   * The jobs `job`'s runs dirty in turn, each under its own prefix: the wait lasts until none of them waits or runs
   * either. Recalculate dirties `route`, whose runs dirty `recalc`: `{ "job": "route", "follow": [{ "job": "recalc" }] }`.
   * A run that dirties the next job's keys finishes its own key in the same transaction, so the wait never sees a gap.
   */
  follow?: readonly { job: string; keyPrefix?: readonly FormExpr[] }[];
  /** What the action's button says while its wait lasts, a text over the page and the row ("Recalculating {$query.year}"). */
  busy?: Text;
};
/**
 * What every write action may carry besides: its dialog's words, a job it waits for, and `blocked: "hide"`: hidden,
 * rather than shown disabled, while a guard the server judged on its doc (and the values the action fixes) fails:
 * no "Reset to this step" on a step ahead of the approval.
 */
type WriteCommon = { dialog?: DialogWords; wait?: JobWait; blocked?: "hide" };
export type ActionRef = ActionCommon & (
  /** `key`: on a call's row, the row field naming the doc an update or a delete writes. */
  | ({ op: string; label?: string; target?: string; key?: FormExpr; parent?: PageExpr; then?: string; fields?: readonly FormField[] } & Prefill & WriteCommon)
  /** `then`: a page the call's value opens, its `:params` from the value's fields (`:key` its `key`): a draft it made. */
  | ({ call: string; label?: string; initial?: Record<string, InitialExpr>; args?: Record<string, FormExpr>; confirm?: string; then?: string; fields?: readonly FormField[] } & WriteCommon)
  /**
   * `fields`: the arguments its dialog asks for, in order, with labels; `fixed`: arguments the page gives, never shown;
   * `initial`: what its dialog's fields start from; `key`: on a call's row, the row field naming the doc it moves.
   */
  | ({ transition: string; machine: string; label?: string; target?: string; key?: FormExpr; fields?: readonly FormField[]; fixed?: Record<string, FormExpr>; initial?: Record<string, InitialExpr>; then?: TransitionThen } & WriteCommon)
  /**
   * A page of the module, its `:params` (in its path and its query) from the row, the doc `target` binds, or the route;
   * its `{$...}` values filled as text is. `report`: the report builder `id` on that page opens with this shape.
   */
  | { navigate: string; label: string; target?: string; report?: ReportLink }
  /** Download an export (`exports`), its arguments from the page: CSV, or with `formats`, a choice of CSV and Excel. */
  | { export: string; label?: string; args?: Record<string, FormExpr>; formats?: readonly ExportFormat[]; dialog?: DialogWords; toast?: Text; members?: ExportMembers; picks?: readonly ExportPick[]; count?: ExportCount }
  /** Import a CSV (`csvImports`): Canon's Upload → Match columns → Review → Import into the import's call. */
  | { csvImport: string; label?: string }
  /** Print the page as a document: the browser's print, with Canon's print stylesheet. The value is the label. */
  | { print: string }
  /** Download the page as a PDF Canon renders on its server: what printing it prints. The value is the label. */
  | { pdf: string; filename?: string }
  /**
   * A menu of actions under one button ("Export": CSV, Excel, a PDF, a sealed payroll file). Its items are no menus;
   * each may carry a `line` under its label ("Choose format, reps, and periods") and a `separator` above it.
   */
  | { menu: string; items: readonly (ActionRef & MenuItemExtras)[] }
  /**
   * Start Canon's "view as" preview of the member `viewAs` names (an admin's, never their own), then open `path`, a page
   * of the module filled as a navigate's is: a rep's own statement as they see it.
   */
  | { viewAs: FormExpr; label: string; path?: string }
  /** Open a Canon page: Settings > Team, the deals list, or the deal a bound doc's joined ref names (`bind`, `ref`). */
  | { canon: CanonLink["canon"]; label: string; bind?: string; ref?: string; query?: Record<string, Text> });

/** What a menu's item may carry besides its action: a line under its label, a rule above it. */
export type MenuItemExtras = { line?: Text; separator?: true };
/**
 * An export's dialog picks members (docs/modules.md, "Records, exports and print"): its call's argument `arg`, a list
 * of member ids, from the workspace's members of `roles` (every role without), searched, with Select all and Clear,
 * every one picked to start; then the format as cards and "Export N <format>".
 */
export type ExportMembers = { arg: string; label?: Text; roles?: readonly Role[] };
/** Another list the export dialog picks from beside its members (the periods), every option picked to start: its call's argument `arg`. */
export type ExportPick = { arg: string; label?: Text; options: FieldOptions };
/**
 * What the export dialog counts: the rows of the list binding `from` (statements) for each member (`member`, a row's
 * member field) and each pick's option (`picks`: per argument, the row field holding the option's value), and in a
 * summary, the rows every pick holds on, under `label` ("Statements"), beside how many members and options are picked.
 */
export type ExportCount = { from: string; label: Text; member?: RowPath; picks?: Record<string, RowPath> };
/**
 * A field a form or a dialog shows. `rows` (a transition's argument holding a record of choices): one choice per row of
 * a list binding, each row shown by `title` and keyed by `value` (its key by default), starting from `initial`, a
 * row value: per-rep acceptance at publish.
 */
export type FormField = { field: string; label: string; widget?: Widget; help?: Text; placeholder?: Text; rows?: RowChoices; options?: FieldOptions; optionTargets?: readonly { path: string; options: FieldOptions }[]; hide?: readonly Scalar[] };
/**
 * A field picked from what a doc holds rather than typed: one option per row of the list binding `from`, or per item of
 * the list `list` holds on the doc `from` binds (an approval workflow's `steps`). Each option's value is the row's or the
 * item's `value` (else a row's key, an item's position from 0), and its label `label`, a text over the page, the row
 * and `{$item.<field>}`, with `{$item.n}` the item's place from 1: "Step {$item.n}: {$item.label} ({$item.role})".
 */
/** `sub`: a line under each option ("{$item.title} · {$item.plans} plans"); `badge`: a tag beside it ("{$item.role}"). Empty texts show nothing. */
/** `by`: groups in the source whose key selects a sibling-dependent list of choices. */
export type FieldOptions = { by?: { sibling: string; key: string; list: string }; from: string; list?: string; value?: string; label: Text; sub?: Text; badge?: Text };
export type RowChoices = { from: string; list?: string; title: Text; value?: RowPath; initial?: RowPath; options?: { list: RowPath; value?: RowPath; label: Text } };
/** A report builder on another page, opened with a shape: its rows, columns, values and chart. */
export type ReportLink = { id: string; rows?: readonly ReportKey[]; columns?: readonly ReportKey[]; values?: readonly ReportValue[]; chart?: (typeof REPORT_CHART_KINDS)[number] };
/** The formats an export downloads as. */
export const EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
/**
 * A component shows only while a bound doc's field holds one of `in`, or is `set` (or isn't), or while a list binding
 * is (or isn't) `empty`.
 */
type Common = { roles?: readonly Role[]; when?: { bind: string; field: string; in: readonly Scalar[] } | { bind: string; field: string; set: boolean } | { bind: string; empty: boolean } };
/**
 * A table column. `sort`: the row value a click on its header sorts by. `total`: the sum a group's header and the
 * table's foot show. `link`: a page its cell opens (`:params` from the row's fields, `:key` its key), or
 * `{ record }`, the Canon page of the deal a joined ref names.
 */
export type Column = {
  edit?: InlineEdit;
  definition?: DefinitionEdit;
  label: string; value: Text; align?: "end"; sort?: RowPath;
  /**
   * Where the cell goes: a page of the module, a joined deal's record, a Canon page, a Canon path a row value holds
   * (`{ path }`, `/dashboard/...` only: a run's integration or import) or a web page a row value holds (`{ url }`,
   * http or https only, in a new tab).
   */
  link?: string | { record: string } | CanonLink | { path: RowPath } | { url: RowPath };
  /**
   * The sum of `sum` over a section's rows (its header) and the table's (its foot); with `over`, that sum over the sum of
   * `over` (attainment: credited over quota, as `percent`), none when `over` sums to 0.
   */
  total?: { sum: RowPath; over?: RowPath; format?: Format };
  /** What a section's header says in this column: a text over the section's first row ("{$row.deal.amount|money} deal value"). */
  group?: Text;
  /** What the cell says when its text comes out empty ("Ongoing", "Plan default"). */
  empty?: Text;
  /** The cell's tone by a row value: the first case that holds (`in`, `gte`, `lte`; none: always), as a badge with `badge`. */
  tone?: ColumnTone;
  /** What the cell says on hover, a text over the row: "$X credited revenue against $Y quota". */
  tooltip?: Text;
  /** A text over the row a button beside the cell copies: a rep's email. */
  copy?: Text;
  /** A row value holding a list of members (or one), drawn as their initials, with every name on hover and in a list. */
  avatars?: RowPath;
  /** The cell shows only on the rows this holds on (a badge on hidden plans only); empty on the others. */
  when?: RowWhen;
  /** The cell's text by a row condition: the first case that holds on the row gives it, else `value` ("Manual review"). */
  cases?: ReadonlyArray<{ when: RowWhen; value: Text }>;
  /**
   * A 3px bar under the cell, as full as `value` (a fraction: 1 is full, past it full) and toned by `tone` as a column's
   * is (by default Canon's primary): attainment against quota.
   */
  bar?: { value: RowPath; tone?: { by: RowPath; cases: ColumnTone["cases"] } };
  /**
   * The cell's text as a button that lists the items of the row's list `items` (a list of members or values, or of
   * rows), each as `label`, a text over the row and `{$item.<field>}` (`{$item.value}` for a plain value), under `title`:
   * "Applied to 2 of 4 reps" listing the reps.
   */
  popover?: { items: RowPath; label: Text; title?: Text };
  /**
   * The cell's text as a toggle that opens, under the row across the table, `body`: components over the page with the
   * row as `{$row...}` (a deal's walkthrough, a dispute's thread). Its `label` is the toggle's when the text is empty.
   */
  expand?: { label?: Text; body: readonly Node[]; bind?: Record<string, { view: string; args?: Record<string, FormExpr> }> };
  /**
   * One column per item of a list (docs/modules.md, "Tables"): the rows of a binding (a list's docs, or a call's value or
   * its `rows` field), or the twelve months of a fiscal year in fiscal order (`fiscalMonths`, the year as a page value:
   * `{ "query": "year" }`; this fiscal year without one). In the column's texts and row paths, `{col}` stands for the
   * item's `key` and `{$col.<field>}` for its fields: a month's `label` ("Jul"), `month` (YYYY-MM), `start`, `end`.
   */
  each?: ColumnEach;
  /** A page its header opens, a text over the page and (in an `each` column) the item: a period's statements. */
  headerLink?: string;
};
/**
 * A grid whose every cell is a doc of its own (a quota per rep and month): the docs of the list `from` whose `row` field
 * holds the row doc's key and whose `column` field holds the column's key; the cell edits their `field` through the
 * grid's update `op`, and an empty cell typed into makes one through `create` (row, column, value and `fixed`).
 */
export type GridCells = { from: string; row: string; column: string; create?: string; fixed?: Record<string, FormExpr> };
export type ColumnEach = { from: string; rows?: string } | { fiscalMonths: FormExpr | null };
/** `ai`: a value a hosted AI step filled (docs/modules.md, "Hosted AI steps"), in Canon's provenance colour. */
export const TONE_NAMES = ["info", "success", "warn", "danger", "neutral", "ai"] as const;
export type ToneName = (typeof TONE_NAMES)[number];
/**
 * Lines a transcript marks: each row of the list bind `from` (or each item of its `list` field) names a line by
 * `segment` (the line's index), optionally a range of its text by `start` and `end` (characters into the line), a
 * tone (one, or by a value of the row as a column's), and a label over the row ("{$row.tracker|ref}").
 */
export type TranscriptHighlight = { from: string; list?: RowPath; segment: string; start?: string; end?: string; tone?: ToneName | { by: string; cases: ColumnTone["cases"] }; label: Text };
/** What a transcript line action's `{ row }` values read: the line's index, speaker, side (rep, customer, unknown), times and text. */
export const TRANSCRIPT_LINE_FIELDS = ["segment", "speaker", "side", "startSec", "endSec", "text"] as const;
export type ColumnTone = { by: RowPath; cases: readonly ({ tone: ToneName } & ({ in: readonly Scalar[] } | { gte: number } | { lte: number } | Record<never, never>))[]; badge?: true };
/**
 * A Canon page a module links to: Settings > Team, the deals list, the deal a joined deal ref names (`ref`, a ref field
 * the binding joins), the company or person a ref names (`ref`, a companies or people ref field), or the companies list
 * (`?line=` query lines, ";" between them, every one of which a company must pass; `?of=` names them), each opened as
 * Canon's own page.
 */
export const CANON_PAGES = ["team", "deals", "deal", "company", "person", "settings", "targets", "workspace", "patchPlans", "companies", "people"] as const;
/** The record pages a link names by a ref: each with the ref it takes. */
const RECORD_PAGES: Partial<Record<(typeof CANON_PAGES)[number], RefTo>> = { deal: "deals", company: "companies", person: "people" };
export type CanonLink = { canon: (typeof CANON_PAGES)[number]; ref?: string; query?: Record<string, Text> };
/** A report's dimension: a field of its collection, a date bucketed by `bucket` (month by default). */
export type ReportKey = string | { field: string; bucket?: (typeof REPORT_BUCKET_NAMES)[number] };
export const REPORT_BUCKET_NAMES = ["day", "week", "month", "quarter", "year"] as const;
export type ReportValue = { fn: "count" | "sum" | "avg" | "min" | "max"; field?: string };
export const REPORT_CHART_KINDS = ["table", "bar", "column", "line", "area", "pie", "number"] as const;
/** How a report's chart draws its values: stacked, and per value (in order) its axis and a column chart's bars or line. */
export type ReportDisplay = { stacked?: boolean; axes?: readonly ("left" | "right")[]; types?: readonly ("bar" | "line")[]; shares?: readonly boolean[] };
/** A report a page shows: its collection, the dimensions down its rows and across its columns, and its values. */
export type ReportShape = { collection: string; rows?: readonly ReportKey[]; columns?: readonly ReportKey[]; values?: readonly ReportValue[] };
/** A value a job status line names: a page value, or a field of a doc the page binds. */
export type StatusExpr = FormExpr;
export type Node = Common & (
  | { c: "header"; title: Text; subtitle?: Text; actions?: readonly ActionRef[] }
  | { c: "prose"; text: Text }
  | { c: "recordEditor"; title?: Text; from: string; rows: string; selection: RowFocus; model: string; options: string; version: string; versionArg: string; change: EditorCall & { arg: string }; message: EditorCall & { fieldArg: string; valueArg: string } }
  /** A call's canonical overlapping sets, with URL selection and an optional read-only row inspector. */
  | { c: "setMap"; from: string; rows: string; overlaps: string; selection: RowFocus; title?: Text; frameLabel?: Text; empty?: Text;
      focus?: { title: Text; items: readonly { label: Text; value: Text }[]; sharedLabel?: Text } }
  /** Rows of a list binding, or of a call binding's value (`rows`, a field of it): the same table either way. */
  | ({ c: "table"; from: string; columns: readonly Column[]; rows?: string; empty?: Text } & TableKeys)
  | ({ c: "form"; op: string; from?: string; parent?: PageExpr; fields: readonly FormField[]; submit?: string } & FormPrefill)
  /** `items`, or every transition of `machine` the caller may run on the doc `target` binds, in its current state. */
  | { c: "actions"; items?: readonly ActionRef[]; machine?: string; target?: string }
  | { c: "empty"; text: Text; action?: ActionRef }
  /** `param`: the URL parameter (`?view=`) naming the open tab by its `id`, so a link opens that tab. */
  | { c: "tabs"; param?: string; tabs: readonly { label: string; id?: string; roles?: readonly Role[]; body: readonly Node[] }[] }
  /** `list`: names after the text, one per row of a binding (`rows`, a call value's field), each `label` over the row. */
  | { c: "banner"; tone: "info" | "warn" | "success" | "danger" | "ai"; text: Text; actions?: readonly ActionRef[]; list?: { from: string; rows?: string; label: Text } }
  | { c: "statusSteps"; from: string; machine: string; steps?: readonly string[] }
  /** `hide`: events whose actor is one of `actors` (System, an agent, a person), from the roles in `roles` (all when left out). */
  /**
   * `hide`: events from the roles in `roles` (all when left out) whose actor is one of `actors` (System, an agent, a person)
   * and whose kind or verb is one of `events` (a transition `machine.name`, an op, or `create`, `update`, `delete`,
   * `event`), each list matching any when left out; `keep` names verbs it never hides (System's "Statement created").
   */
  | { c: "timeline"; of: string; limit?: number; hide?: TimelineHide }
  /**
   * One list from several: each source's rows in a common shape (what it is, a title, a line under it, a date, a link
   * and its actions), newest first. An inbox of approvals, disputes and requests.
   */
  | { c: "queue"; sources: readonly QueueSource[]; empty?: Text; search?: boolean; filters?: boolean; group?: boolean }
  /** A job's keys under a prefix: waiting, running, retrying or stopped with an error, and when jobs last ran. */
  | { c: "jobStatus"; job: string; keyPrefix?: readonly StatusExpr[]; label?: string }
  /** Labels and values in a grid: a record's fields, each a text with formats. */
  | { c: "detail"; items: readonly { label: string; value: Text; span?: 2 }[]; columns?: 2 | 3 | 4 }
  /** Figures: a text, a list's total of a row value, or its count. A list read short shows none. */
  | { c: "kpis"; items: readonly KpiItem[] }
  /**
   * Messages on a doc (a list bind, oldest first): each its `body`, `author` (a member field) and time; `post` adds one,
   * under `parent` (in a row's expansion, `{ "row": "key" }`: the row's doc).
   * `tags`: words after an author's name by their role, "(Rep)".
   */
  | { c: "thread"; from: string; body: RowPath; author?: RowPath; at?: RowPath; post?: { op: string; fixed?: Record<string, FormExpr>; parent: PageExpr | { row: string } | { root: true }; field: string; label?: string; button?: string; placeholder?: Text }; empty?: Text; tags?: Partial<Record<Role, string>> }
  /**
   * Steps in order (a list bind sorted by `order`): each its `title`, approver, state and time, `done`/`failed` states
   * marked. The state is a field of each step (`state`), or `progress`: where the doc the steps belong to stands.
   */
  | { c: "approvalChain"; from: string; title: Text; approver?: RowPath; state?: RowPath; progress?: ChainProgress; at?: RowPath; order?: RowPath; note?: Text; done?: readonly Scalar[]; failed?: readonly Scalar[]; actions?: readonly ActionRef[]; empty?: Text }
  /** Previous and next over an ordered list (by `sort`, else as read): the doc whose key is `current`, linked by `link`. */
  | { c: "periodNav"; from: string; current: FormExpr; label: Text; link: string; sort?: RowPath }
  /** Whether a sealed doc still matches its seal: its collection's `integrity`, recomputed on the server. */
  | { c: "integrity"; from: string }
  | { c: "shareLinks"; share: string; from: string }
  /**
   * A Canon call's transcript (`call`: its id, a page value or a bound doc's field), loaded by Canon as the caller, so no
   * module doc holds its text: each line's speaker, side and time, the ranges `highlights` mark, and `lineActions`
   * (creates) whose `{ row }` values read the line (TRANSCRIPT_LINE_FIELDS).
   */
  | { c: "transcript"; call: FormExpr; highlights?: readonly TranscriptHighlight[]; lineActions?: readonly ActionRef[]; empty?: Text }
  /** One person's calling controls and history. `from` binds a read-only call returning people with their granted phone. */
  | { c: "phone"; record: PageExpr; from: string; phone: RowPath }
  /**
   * Canon's dialer working a list (docs/modules.md, "Calling people"): the rep's session, the live call, its outcome
   * and their lines and voicemail settings, drawn by Canon. The rows of `from`, in order, are who to call: `person`
   * holds a person's id, `name` their name and `phone` their number, which only picks who is next (Canon dials the
   * number on the person's record, after its compliance checks). A person this session called since `since` (a time in
   * ms: when the list was loaded) isn't next again. `skip` runs on the next row. `campaign` names the audience the rows
   * came from, which the abandoned-call cap counts by.
   */
  | { c: "phone"; from: string; person: RowPath; name: RowPath; phone: RowPath; detail?: Text; skip?: ActionRef; since?: FormExpr; campaign?: { id: FormExpr; name: Text }; empty?: Text }
  /** A call's value the page loaded (a `{ call }` binding), as the call's `result` draws it, with Refresh. */
  | { c: "callResult"; from: string; label?: string }
  /**
   * The bulk moves a doc waits on (a period paying its statements): moving, or stopped with the docs that refused,
   * each linked by `link`, and Retry for a person who may run the move.
   */
  | { c: "bulkStatus"; from: string; link?: string; label?: string }
  /**
   * The module's outbox (docs/modules.md, "Outbound"): the messages it sent or will send that the reader may see, every
   * one (`from: "module"`) or those a bound doc caused, in `states`, with the `actions` a person may take on them.
   */
  | { c: "outbox"; from: string; states?: readonly OutboxState[]; actions?: readonly OutboxAction[]; empty?: string }
  | { c: "pacing"; id: string; title?: string; sources: readonly PacingSource[]; target?: string }
  | { c: "dashboards"; title?: string }
  /**
   * A report builder (docs/modules.md, "Reports and charts"): the collection's dimensions and measures as a palette,
   * dropped on rows, columns and values, with filters, a results table with totals and a chart. It opens as declared;
   * each person saves their own versions of it, and may share one with the workspace.
   */
  /**
   * `sources`: other reported collections the builder offers beside `collection`, each its own palette: a report reads
   * one source, inferred from the first pick, and the other sources' items wait until it is cleared (or a person pins
   * a source). `display`: how its chart draws: stacked, and per value its axis and (columns) bars or a line.
   */
  | ({ c: "report"; id: string; title?: string; chart?: (typeof REPORT_CHART_KINDS)[number]; sources?: readonly string[]; display?: ReportDisplay } & ReportShape)
  /**
   * A chart: of a list binding's rows or a call binding's (`rows`, a field of its value), each row's `y` summed (a count
   * without one) by `x` and split by `series`; or of a `report`. `stacked` bars stack their series.
   */
  | {
      c: "chart"; kind: "bar" | "line" | "stacked" | "pie" | "waterfall"; title?: string;
      from?: string; rows?: string; x?: RowPath; y?: RowPath; series?: RowPath; bucket?: (typeof REPORT_BUCKET_NAMES)[number];
      /**
       * A waterfall's totals, fields of the call's value: the `start` it walks from and the `end` it should reach (from the
       * steps when absent), with their bars' labels. Its rows are the steps, in their order, each `y` a signed change.
       */
      start?: string; end?: string; startLabel?: string; endLabel?: string;
      report?: ReportShape;
      /** Bars by their value (largest first, or `dir`) rather than their label; the `top` n of them; values as `format`. */
      order?: "value" | "label"; dir?: "asc" | "desc"; top?: number; format?: "number" | "money" | "percent";
      /** A page a click on a bar or a point opens, its `{$x}` (and `{$series}`) the clicked value: the month's statements. */
      link?: string;
    }
  /**
   * A URL parameter stepped by `step` (1) with Previous and Next, starting at `default` (a number, this year, or this
   * fiscal year: the year it ends in), within `min` and `max`: a `?year=` navigator a page's bindings read. A fiscal
   * stepper (or `format: "fy"`) names its years as fiscal years: FY2027 when the year doesn't start in January.
   */
  | { c: "stepper"; param: string; label?: string; step?: number; default: number | "thisYear" | "thisFiscalYear"; min?: number; max?: number; format?: "fy" }
  /**
   * A date range in two URL parameters (`?from=2026-07-01&to=2026-09-30`) a page's bindings read: presets, or words a
   * person types ("last 2 quarters", "since March", "Q3 2026"), in the workspace's fiscal year. `default`: the words it
   * starts from when the URL names no range ("This month").
   */
  | { c: "dateRange"; from: string; to: string; label?: string; default?: string }
  /**
   * A create (`op`) or a call (`call`) asked in steps (docs/modules.md, "Forms and widgets"): each step's fields, with
   * Back and Next (Next waits for the step's required fields), a choice with descriptions as radio cards, and on the way
   * a `preview` card of what it will make, texts over the page and `{$draft.<field>}`. The last step's button submits.
   */
  | ({ c: "wizard"; op?: string; call?: string; steps: readonly { title: Text; description?: Text; fields: readonly FormField[] }[]; preview?: { title?: Text; items: readonly { label: Text; value: Text }[] }; submit?: Text; then?: string; toast?: Text } & Prefill)
  /**
   * A spreadsheet of numbers (docs/modules.md, "Forms and widgets"): a row per doc of the list `from`, titled `title`,
   * and a column per item of `each` (a fiscal year's months, or a binding's rows), each cell the doc's record field
   * `field` at the item's key (`{col}`). Cells take typing and a block pasted from a spreadsheet; Save runs the update
   * `op` on each doc that changed.
   */
  | { c: "grid"; from: string; op: string; field: string; title: Text; each: ColumnEach; label: Text; widget?: "number" | "money" | "percent"; total?: true; cells?: GridCells }
  /** Rows as a tree: each row under the row whose `id` (its key by default) its `parent` holds; an org chart. */
  /**
   * Rows as a tree, with search, zoom, Expand all and Collapse all; a click on a row opens its inspector: its `details`
   * (texts over the row), who it reports to and how many report to it.
   */
  | { c: "tree"; from: string; rows?: string; id?: RowPath; parent: RowPath; title: Text; subtitle?: Text; link?: string; canonLink?: CanonLink; empty?: Text; details?: readonly { label: string; value: Text }[] }
  /**
   * Rows as a flow canvas: each row a node after the row whose `id` (its key by default) its `parent` holds, or without
   * `parent` after the row before it (steps in order). `action` labels the arrow into a node, `metric` and `card` sit
   * on it, `tone` (done, active, planned, failed, exit) colors it, and a click opens its `details`.
   */
  | { c: "flow"; from: string; rows?: string; id?: RowPath; parent?: RowPath; title: Text; action?: Text; metric?: Text; card?: Text; tone?: Text; empty?: Text; details?: readonly { label: string; value: Text }[] }
);
/**
 * A step's state from the doc the steps belong to (`of`, a one-doc bind): `at` is its field holding the current step's
 * position, `by` each step's own. Before it: done; at it: current (failed while `failed` holds on the doc, done while
 * `complete` does); after it: waiting.
 */
export type TimelineHide = { actors?: readonly ("system" | "agent" | "person")[]; events?: readonly string[]; keep?: readonly string[]; roles?: readonly Role[] };
export type ChainProgress = { of: string; at: string; by: RowPath; complete?: InWhen; failed?: InWhen };
type InWhen = { field: string; in: readonly Scalar[] };
/** What a table does with its rows, a list binding's or a call's (docs/modules.md, "Tables, queues and status"). */
export type TableKeys = {
  hierarchy?: EditableHierarchy;
  rowLink?: string; rowActions?: readonly ActionRef[];
  /** Single-row URL focus, shared with a setMap's selection. Row hover lights that map without changing the URL. */
  focus?: RowFocus;
  /** Names the table's sort, filters and search in the URL (`?<id>.sort=`), so a link opens it as it was. */
  id?: string;
  sort?: { by: RowPath; dir?: "asc" | "desc" };
  /**
   * Chips over a choice, member, ref, true/false or date field: the rows holding the picked values (dates: a range). A
   * choice field offers every value its schema holds; `options` on a call's rows names a field of its value holding
   * the values to offer (every stage, not only the ones the rows hold).
   */
  filters?: readonly { field: RowPath; label: string; options?: string }[];
  /** The row values a search box matches, as they show. */
  search?: readonly RowPath[];
  /**
   * Sections by a row value, each with its count and its columns' totals, open or `collapsed`. `link`: a page the
   * section's header opens, its `:params` from the section's first row (the plan a section of statements is for).
   */
  /** `pageSize`: each group shows its first rows, and its own "Show more" adds as many again (QuotaQueue's deals list). */
  group?: { by: RowPath; collapsed?: boolean; link?: string; pageSize?: number };
  /** Rows shown before "Show more" (50). */
  pageSize?: number;
  /** What the table says when its search, filters or chip leave no row ("No approvals match"), over Clear filters. */
  emptyFiltered?: Text;
  /**
   * Checkboxes on the rows, and these actions over the ones picked (transitions, deletes or calls), each row's run on
   * its own with every check: "Complete current step" on the statements picked.
   */
  select?: {
    actions: readonly ActionRef[];
    /**
     * "Edit (N)": one dialog with a row per picked doc and a column per field, each cell its editor, starting from the
     * doc; Save runs the update `op` on each row that changed, checked as one row's edit is ("Edit reps (3)"). On a
     * call's rows, `key` is the row field naming each doc (the row's key by default), read as the caller reads it now.
     */
    edit?: { op: string; label?: Text; fields: readonly FormField[]; key?: RowPath };
    /**
     * A URL parameter that holds the picked rows' keys, comma-separated, while any are picked: a binding or a call's
     * argument reads it as `{ "query": "<param>" }` (a list argument takes it as a list), so picking rows narrows what
     * the rest of the page reads (the calculation of the reps picked).
     */
    param?: string;
  };
  /**
   * One-tap chips over the rows, each the rows its `when` holds on (a field among values, set or not, or `me`: a member
   * field naming the person), with its count after the search: "Assigned to me", "Exceptions". One chip at a time, or All.
   */
  chips?: readonly { label: Text; when: TableChipWhen }[];
  /** The rows that need the person (a dot on each), which `summary` counts. */
  attention?: TableChipWhen;
  /** A line over the rows: "{n} shown · {m} need attention · {t} total". */
  summary?: true;
  /** Ways the person may section the rows, picked in a select beside the search ("Group by: Kind"), else `group`. */
  groupBy?: readonly { by: RowPath; label: Text }[];
  /** A bar that stays at the foot of the window while the table shows, with `label` and each total column's sum. */
  totalBar?: { label: Text };
  /** At a phone's width, each row as a card of its columns' labels and values, with its actions under them. */
  cards?: true;
  /**
   * Rows dragged by a handle into a new order (while no sort, filter, search or chip narrows them), then `call` run with
   * the rows' keys in that order as its argument `arg` (`keys` by default) and `args` from the page: a plan's rules.
   * `by`: the row field that holds the order, by which the table shows its rows.
   */
  reorder?: { call: string; arg?: string; args?: Record<string, FormExpr>; by?: RowPath };
};
/**
 * A row condition (a chip, `attention`, a column's `when`, a contributed badge or Team column): a row value (a field, a
 * count or a joined doc's field) among `in`, set or not, naming the person who reads it (`me: true`) or not (`me: false`),
 * or a number at least `gte`.
 */
export type RowWhen = { field: RowPath; in: readonly Scalar[] } | { field: RowPath; set: boolean } | { field: RowPath; me: boolean } | { field: RowPath; gte: number };
export type TableChipWhen = RowWhen;
/** The most row actions a table, a queue source or an approval chain shows on a row (past 3 they fold into More). */
export const MAX_ROW_ACTIONS = 12;
/**
 * A figure: a text, a list's total of a row value, or its count. `tone` colours it by `by` (a text that reads as a number
 * or a value) through cases as a column's; `trend` is a text whose number's sign draws an arrow up or down; `hint` a
 * line under it.
 */
export type KpiExtras = { tone?: { by: Text; cases: ColumnTone["cases"] }; trend?: Text; hint?: Text };
export type KpiItem = { label: string } & KpiExtras & ({ value: Text } | { total: { from: string; sum: RowPath; format?: Format } } | { count: string });
/** `attention`: a row that needs the person (a field holding one of `in`, or set): the queue's Needs attention filter. */
export type QueueSource = { from: string; label: string; title: Text; subtitle?: Text; date?: RowPath; link?: string; actions?: readonly ActionRef[]; attention?: ActionWhen };
export const COMPONENTS = ["header", "prose", "recordEditor", "setMap", "table", "form", "actions", "empty", "tabs", "banner", "statusSteps", "timeline", "queue", "jobStatus", "detail", "kpis", "thread", "approvalChain", "periodNav", "integrity", "callResult", "bulkStatus", "pacing", "dashboards", "report", "chart", "tree", "stepper", "dateRange", "wizard", "grid", "transcript", "phone", "shareLinks", "outbox", "flow"] as const;
export type ComponentName = (typeof COMPONENTS)[number];

export type PageDecl = {
  /** "visits" or "visits/:key": `:name` segments are route parameters. */
  path: string;
  title: Text;
  /** Who sees the page; every role when absent. Cosmetic: the views and ops re-check on the server. */
  roles?: readonly Role[];
  /**
   * Pages with a tab show as tabs under the module's nav entry, by `order`: each role's tab set is the tabs of the
   * pages it sees, narrowed by the tab's own `roles` (a page a rep may open from a link without it in their tabs).
   */
  tab?: { label: string; order: number; roles?: readonly Role[] };
  bind?: Record<string, Binding>;
  /**
   * A transition Canon runs when the caller opens the page, on the doc `target` binds, while it is in one of the
   * transition's `from` states and the caller's role may run it: a statement marked viewed. Once it has moved, opening
   * the page again does nothing.
   */
  onOpen?: { machine: string; transition: string; target: string };
  /**
   * What the page shows when it can't be drawn (a read it makes refuses, or a component fails): the reason, `text`
   * if given, and a link `back` to another page of the module, with Try again. `missing`: what it says when a doc
   * the route names (a `one` binding read by a `:param`) isn't there or isn't the caller's to read, in place of the
   * page; Canon's "Not found, or not yours to see" without one.
   */
  fallback?: { text?: string; missing?: string; heading?: string; actions?: readonly { label: string; path: string }[]; back: { label: string; path: string } };
  /**
   * The page as a document (its PDF): `heading` a line over its title ("Commission Statement"), `wordmark` at the top of
   * every page, `footer` the line at the foot of every page ("Generated by Commissions"), each a text over the page.
   */
  document?: { heading?: Text; wordmark?: Text; footer?: Text };
  /**
   * URL parameters the page keeps for each person in their browser (a range's `from` and `to`, a tab's `param`): opened
   * with none of them in its URL, the page opens as that person last left it.
   */
  persist?: readonly string[];
  body: readonly Node[];
};

export type ShareWhere = { field: string; in: readonly Scalar[] } | { field: string; neq: Scalar } | { all: readonly ShareWhere[] };
export type SharePage = { path: string; title: Text; bind?: Record<string, { root: true } | { rootList: string } | { set: string; key?: { route: string }; where?: { field: string; eq: { route: string } } }>; body: readonly Node[] };
export type ShareDecl = {
  label: string;
  collection: string;
  when?: ShareWhere;
  identity: { default: "link" | "email"; allow: readonly ("link" | "email")[]; domains?: readonly string[] };
  expiresDays: { default: number; max: number };
  read: Record<string, { fields: readonly string[]; where?: ShareWhere }>;
  members: readonly ("name" | "title")[];
  write: { ops: readonly string[]; transitions: readonly string[] };
  pages: readonly SharePage[];
  issue: { roles: readonly Role[]; agent: "human"; notify?: "owner" };
  record?: { collection: string };
  signals?: true;
  limits: { writesPerHour: number; uploadsPerDay: number; uploadBytes: number };
};
export const SHARE_COMPONENTS = ["header", "banner", "detail", "kpis", "statusSteps", "table", "thread", "actions", "empty", "tabs"] as const;

export const NAV_ICONS = ["box", "clipboard", "coins", "receipt", "scale", "target", "briefcase", "chart", "map", "check", "inbox", "send", "layout", "linkedin", "phone", "radio", "bot", "plug", "sparkles", "key"] as const;
export type NavIcon = (typeof NAV_ICONS)[number];
export const NAV_SECTIONS = ["CRM", "Work", "Activity", "Admin"] as const;
/**
 * The places in the nav for Canon's pages that are not core (docs/modules.md, "Places in the nav"), each under the id
 * workspace.nav hides it by, in its section. A module shows Canon's page there (`links`) or takes the place with its
 * own entry (`nav.slot`): it keeps the place's position and id, and the page's old URL, and every URL under it, opens
 * the module.
 */
export const NAV_SLOTS = {
  icps: { section: "CRM", label: "ICPs", icon: "target", href: "/dashboard/icps" },
  audiences: { section: "CRM", label: "Audiences", icon: "send", href: "/dashboard/audiences" },
  "my-work": { section: "Work", label: "My work", icon: "check", href: "/dashboard/tasks", badge: "dueTasks" },
  review: { section: "Work", label: "Review", icon: "inbox", href: "/dashboard/facts" },
  reports: { section: "Activity", label: "Reports", icon: "layout", href: "/dashboard/dashboards" },
  linkedin: { section: "Activity", label: "LinkedIn", icon: "linkedin", href: "/dashboard/linkedin" },
  dialer: { section: "Activity", label: "Dialer", icon: "phone", href: "/dashboard/dialer" },
  runs: { section: "Activity", label: "Runs", icon: "radio", href: "/dashboard/runs" },
  agents: { section: "Activity", label: "Agents", icon: "bot", href: "/dashboard/agents" },
  integrations: { section: "Admin", label: "Integrations", icon: "plug", href: "/dashboard/integrations" },
  "ai-fields": { section: "Admin", label: "AI fields", icon: "sparkles", href: "/dashboard/fields" },
  "cli-pairing": { section: "Admin", label: "CLI Pairing", icon: "key", href: "/dashboard/cli-auth" },
} as const satisfies Record<string, { section: (typeof NAV_SECTIONS)[number]; label: string; icon: NavIcon; href: string; badge?: "dueTasks" }>;
export type NavSlot = keyof typeof NAV_SLOTS;

export type ModuleManifest = {
  kind: "module";
  /** Source distribution policy. Older installed and third-party manifests may omit it. */
  visibility?: "open" | "private";
  /** `@scope/name`, as a recipe package's. Data is keyed by it, so it survives upgrades. */
  id: string;
  version: string;
  title: string;
  description: string;
  author: { org: string };
  engines: { moduleApi: typeof MODULE_API };
  /**
   * The module's one nav entry. `landing` is the page it opens: one for everyone, or one per role with a `default`
   * for the roles it doesn't name (a rep opens Commissions on My statements).
   */
  nav?: { label: string; icon: NavIcon; section: (typeof NAV_SECTIONS)[number]; landing: string | Landing; slot?: NavSlot };
  /** The places in the nav where the module shows Canon's own page (NAV_SLOTS). */
  links?: readonly NavSlot[];
  /**
   * Installed and on in every workspace, unless an admin turned it off or uninstalled it there (docs/modules.md,
   * "Default modules"). Only the modules Canon ships are seeded.
   */
  default?: true;
  /** Canon-owned imports run once per workspace when this version first serves. */
  imports?: readonly string[];
  reports?: Record<string, { name: string; report: string; spec: ReportSpec }>;
  dashboards?: Record<string, { name: string; tiles: Array<{ report: string; wide: boolean }> }>;
  collections: Record<string, CollectionDecl>;
  views: Record<string, ViewDecl>;
  ops: Record<string, OpDecl>;
  machines?: Record<string, MachineDecl>;
  /**
   * The Canon records the module reads, and which of their fields: the install screen lists them. `records` names the
   * Canon objects it may report on (docs/modules.md, "Reports and charts"): `companies`, `people`, a custom object's
   * apiName, or `*` for every one, each as the reading person's role shows it, with every field and related record they see.
   */
  reads?: Partial<Record<CanonObject, readonly string[]>> & { records?: readonly string[] };
  /** What the module may send (docs/modules.md, "Outbound"): the install screen lists it, and an admin turns each channel on. */
  outbound?: OutboundDecl;
  /** The messages its sends render, by name. */
  templates?: Record<string, TemplateDecl>;
  /**
   * The writes to Canon's own records the module's calls may propose (docs/modules.md, "Writes to Canon records"),
   * from Canon's registry (kernel/proposals.ts). Each proposal waits as a patch plan a person approves; the install
   * screen lists them.
   */
  proposes?: readonly ProposalOperation[];
  /**
   * Interfaces other modules may read (docs/modules.md, "Reading another module"): a name with its version
   * (`tallies.v1`), the view that serves it (its arguments are the interface's) and the fields it hands over, frozen:
   * an upgrade may add an interface, never change or drop one; a change ships as `tallies.v2` beside it.
   */
  provides?: Record<string, ProvideDecl>;
  /** The other modules' interfaces this one reads, by module id: the install screen lists them. */
  uses?: Record<string, readonly string[]>;
  /** The server bundle's path in the package, as "dist/module.js" (scripts/module-build.ts). Required with `calls`. */
  server?: string;
  calls?: Record<string, CallDecl>;
  jobs?: Record<string, JobDecl>;
  watches?: readonly WatchDecl[];
  feeds?: Record<string, FeedDecl>;
  schedules?: Record<string, ScheduleDecl>;
  /** CSV a page downloads and an agent reads (docs/modules.md, "Exports"). */
  exports?: Record<string, ExportDecl>;
  /** CSV a person imports through Canon's import flow into a call (docs/modules.md, "CSV imports"). */
  csvImports?: Record<string, CsvImportDecl>;
  /**
   * Per collection, what upgrading from an older version does to each stored doc (docs/modules.md, "Upgrades and
   * migrations"): the first entry whose `from` range holds the installed version runs its `call`, a function the
   * server bundle exports in `calls` (not a declared call), on every doc, as Canon, before the new version serves.
   * A collection this version removes may be migrated too: each of its docs drops, and may patch another doc.
   */
  migrations?: Record<string, readonly MigrationDecl[]>;
  /**
   * A job dirtied once when this version starts serving over an earlier one (docs/modules.md, "Upgrades"): the
   * backfill a new version needs, run once. `key`: one value or "*" per part of the job's key (every part "*" when
   * left out).
   */
  upgrade?: { job: string; key?: readonly string[] };
  /**
   * What the module adds to Canon's own pages (docs/modules.md, "On Canon's pages"), each read from a list view with
   * no arguments as the person who opens the page (their read scope, as any view): badges on the deals list's rows,
   * and columns, each a filter too, on Settings > Team.
   */
  contributes?: Contributions;
  pages: readonly PageDecl[];
  shares?: Record<string, ShareDecl>;
};
/** A territory tree read's shape (see ReadDecl): which earlier reads and fields make the tree, and what it answers. */
export type TreeRead = {
  nodes: string; query: string; parent?: string; order?: string;
  named?: { read: string; node: string; company: string };
  owners?: boolean; deals?: boolean; market?: boolean;
  cells?: { node: CallExpr; by: readonly ("country" | "region" | "sizeBand" | "industry")[] };
  /** A company to place: the value's `placed` names the territory it lands in (none: null), and whether by name. */
  place?: CallExpr;
};
export type IcpTreeRead = { icps: string; nodes: string; market?: boolean };
/** A published interface: the view that serves it, and the doc fields it hands over (with key, owner and times). */
export type ProvideDecl = {
  view: string; fields: readonly string[];
  /**
   * The people each doc names (docs/modules.md, "People queries"): `filter`, the field holding a People list filter, and
   * `added`, a set under the doc whose `field` holds people added one at a time. `people.snapshot` freezes them.
   */
  people?: { filter: string; added?: { set: string; field: string } };
};
/** An interface's name: a word and its version, `tallies.v1`. */
export const PROVIDE_NAME = /^[a-z][A-Za-z0-9]{0,40}\.v[1-9][0-9]{0,2}$/;

export function isPeopleFilterField(field: FieldSpec): boolean {
  const array = coreOf(field.fieldType);
  const item = array.type === "array" ? coreOf(array.value) : null;
  return item?.type === "object" && ["field", "op"].every((k) => !!item.value[k] && !item.value[k].optional && coreOf(item.value[k].fieldType).type === "string");
}

export function peopleFilterForms(m: ModuleManifest, role?: Role): PeopleFilterForm[] {
  return m.pages.flatMap((p) => {
    if (role && p.roles && !p.roles.includes(role)) return [];
    const walk = (nodes: readonly Node[]): PeopleFilterForm[] => nodes.flatMap((n) => {
      if (role && n.roles && !n.roles.includes(role)) return [];
      if (n.c === "tabs") return n.tabs.flatMap((t) => role && t.roles && !t.roles.includes(role) ? [] : walk(t.body));
      if (n.c !== "form") return [];
      const op = m.ops[n.op];
      if (!op || op.system || (role && !op.roles.includes(role))) return [];
      return Object.entries(n.fixed ?? {}).flatMap(([f, x]) => {
        const field = m.collections[op.collection]?.schema.value[f];
        return x !== null && typeof x === "object" && "json" in x && field && isPeopleFilterField(field) ? [{ path: p.path, param: x.query }] : [];
      });
    });
    return walk(p.body);
  });
}

export type PeopleListAction = { id: string; label: string; path: string; param: string; roles?: readonly Role[] };
export type PeopleFilterForm = { path: string; param: string };

/**
 * `deals.badges`: per deal, a badge for each doc of `view` whose `deal` field names it (`when` on the doc), its `label`
 * a text over the doc ("Override", "Held"). `team.columns`: per member, the texts `value` makes of the docs of `view`
 * whose `member` field (a member ref, or `owner`) names them, each once ("Enterprise AE 2027"); `filter` offers them
 * as a filter. `join` names ref fields the texts read (`{$row.plan.name}`). `key`: the doc field whose value a link to
 * Settings > Team names a value by (`?plan=<plan key>` with `key: "plan"`), the doc's key by default.
 * `people.listActions` hands the list's expanded filter to a declared module form; it reads no module docs.
 */
export type Contributions = {
  people?: { listActions: readonly PeopleListAction[] };
  deals?: { badges: readonly { view: string; deal: string; label: Text; tone?: ToneName; when?: RowWhen; join?: readonly string[]; count?: true }[] };
  team?: { columns: readonly { label: string; view: string; member: string; value: Text; filter?: boolean; join?: readonly string[]; key?: string; when?: RowWhen }[] };
} & { [K in PanelPage as `${K}Page`]?: { panels: readonly PanelDecl[] } };
/** Canon's record pages a module's panels show on: a deal's, a company's and a person's. */
export const PANEL_PAGES = ["deal", "company", "person"] as const;
export type PanelPage = (typeof PANEL_PAGES)[number];
/**
 * A panel on Canon's record page (docs/modules.md, "On Canon's pages"): a few of the module's components over its
 * bindings, read as the person who opens the page. The page's record is the URL parameter `record` (`{ "query":
 * "record" }`): a deal's id as `deals.*` reads it, a company's `acc_…`, a person's `con_…`. Canon serves it as a page of
 * the module's own (`panelPages`), so every component, action and read is the one a module page has.
 * `replaces` names a recipe section kind. A supporting host restores that section whenever the panel is unavailable.
 */
export type PanelDecl = { id: string; title: Text; roles?: readonly Role[]; replaces?: string; bind?: Record<string, Binding>; body: readonly Node[]; link?: { label: string; path: string } };
export const PANEL_COMPONENTS = ["detail", "kpis", "table", "banner", "callResult", "actions", "chart", "phone"] as const;
export const MAX_PANELS = 3;
export const MAX_PANEL_BINDS = 4;
/** The path Canon serves a panel at: a page of the module's own, with no tab. */
export const panelPath = (page: PanelPage, id: string) => `panel/${page}/${id}`;
/** Each panel as the page Canon serves it: what the checks, the page query and the renderer read. */
export function panelPages(m: Pick<ModuleManifest, "contributes">): PageDecl[] {
  return PANEL_PAGES.flatMap((page) => (m.contributes?.[`${page}Page`]?.panels ?? []).map((p): PageDecl => ({
    path: panelPath(page, p.id), title: p.title, ...(p.roles ? { roles: p.roles } : {}), ...(p.bind ? { bind: p.bind } : {}), body: p.body,
  })));
}
/** A module's pages and its panels' pages. */
export const pagesOf = (m: Pick<ModuleManifest, "pages" | "contributes">): PageDecl[] => [...m.pages, ...panelPages(m)];
/** Canon's pages a module adds to. */
export const CONTRIBUTED_PAGES = ["deals", "team", "people"] as const;

/** The key a version's `upgrade` job is dirtied at: its declared key, else "*" for every part. */
export const upgradeKey = (m: Pick<ModuleManifest, "upgrade" | "jobs">): string =>
  (m.upgrade?.key ?? (m.jobs?.[m.upgrade?.job ?? ""]?.key ?? []).map(() => ANY)).join("|");

/** A page per role, and the one for the roles it doesn't name. */
export type Landing = Partial<Record<Role, string>> & { default: string };
/** The page a role opens the module on. */
export const landingFor = (m: Pick<ModuleManifest, "nav">, role: Role | "system"): string => {
  const landing = m.nav?.landing ?? "";
  return typeof landing === "string" ? landing : (role !== "system" ? landing[role] : undefined) ?? landing.default;
};

/** `from`: the installed versions it migrates, as `<1.3.0`, `>=1.0.0 <1.3.0` or `1.2.0`. `call`: the bundle's function. */
export type MigrationDecl = { from: string; call: string };

/**
 * Rows as CSV, each column a text over `{$row.<field>}` (formats give plain values: money as 1234.50, dates as
 * YYYY-MM-DD): a list view's docs as the caller reads them, with `join`, or the rows a call returns (`rows`, a field
 * of its value, or the value). The caller gives the view's or the call's arguments.
 */
/**
 * `pdf`: the export also downloads as one PDF of the page `page` (its `:key`) for each doc its rows name at `key` (a row
 * field, `key` a view row's own), each from a new page: every statement picked, as each prints.
 */
export type PeopleExport = { label: string; filename?: string; people: { provide: string; key: { arg: string } }; record?: { op: string; parent?: { op: string; field: string } }; columns?: never; pdf?: never };
export type ExportDecl = PeopleExport | { label: string; filename?: string; columns: readonly { label: string; value: Text }[]; pdf?: { page: string; key: RowPath } } & (
  /**
   * `require`: every row must pass `when` (a payroll file only of statements whose seal still matches), else the
   * export refuses with `message` and the rows that fail, by name.
   */
  | { view: string; join?: readonly string[]; limit?: number; require?: Guard }
  | { call: string; rows?: string });
export function peopleExportProblems(m: ModuleManifest, x: PeopleExport): string[] {
  const provider = m.provides?.[x.people.provide];
  if (!provider?.people) return [`${x.people.provide} is not this module's people-query interface`];
  if (!x.record) return [];
  const op = m.ops[x.record.op];
  const collection = op && m.collections[op.collection];
  const parent = m.views[provider.view]?.collection;
  if (!op || !parent || !collection || op.kind !== "create" || !op.system || op.roles.length || collection?.setOf?.parent !== parent) return ["record.op must be a system-only create on a set under the people provider"];
  const fields = collection.schema.value;
  const required = { target: "string", at: "number", sent: "number", exported: "number", skipped: "number" };
  const errors: string[] = [];
  for (const [name, type] of Object.entries(required)) {
    if (!fields[name] || fields[name].optional || coreOf(fields[name].fieldType).type !== type || !op.fields?.includes(name)) errors.push(`record.op needs the aggregate field ${name} (${type})`);
  }
  const target = fields.target && coreOf(fields.target.fieldType);
  if (target?.type === "string" && target.maxLength !== undefined && target.maxLength < 3) errors.push("record.op target must accept csv");
  for (const [name, spec] of Object.entries(fields)) if (!spec.optional && !(name in required)) errors.push(`record.op cannot fill required field ${name}`);
  if (fields.by && (!fields.by.optional || refOf(fields.by)?.to !== "users" || !op.fields?.includes("by"))) errors.push("record.op by must be an optional user ref");
  if (op.fields?.some((f) => !(f in required) && f !== "by") || Object.keys(op.set ?? {}).length) errors.push("record.op writes only aggregate run fields");
  if (x.record.parent) {
    const touch = m.ops[x.record.parent.op];
    const field = x.record.parent.field;
    const spec = m.collections[parent]?.schema.value[field];
    if (!touch || touch.kind !== "update" || !touch.system || touch.roles.length || touch.collection !== parent || touch.fields?.length !== 1 || touch.fields[0] !== field || Object.keys(touch.set ?? {}).length || !spec || coreOf(spec.fieldType).type !== "number") errors.push("record.parent must update only one numeric field of the people provider with a system-only op");
  }
  return errors;
}
/** The most rows an export reads from a view. */
export const MAX_EXPORT_ROWS = 5000;

export const PACKAGE_ID = /^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,62}$/;
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
/** Comparators joined by spaces, all of which a version must meet: `<1.3.0`, `>=1.0.0 <1.3.0`, `1.2.0`. */
const VERSION_RANGE = /^(?:(?:<|<=|>|>=|=)?\d{1,9}\.\d{1,9}\.\d{1,9})(?: (?:<|<=|>|>=|=)?\d{1,9}\.\d{1,9}\.\d{1,9}){0,3}$/;
const NAME = /^[a-z][a-zA-Z0-9]{0,39}$/;
/** A view's or op's name: dots group them by collection, as "visits.create". */
const DOTTED = /^[a-z][a-zA-Z0-9.]{0,59}$/;
const FIELD = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
/** A path into an AI step's answer: fields joined by dots, a list's items marked `[]` (`drivers[].quotes[].text`). */
const AI_PATH = /^[a-zA-Z][a-zA-Z0-9_]{0,39}(\[\])?(\.[a-zA-Z][a-zA-Z0-9_]{0,39}(\[\])?){0,5}$/;
/** A field, or a path of up to 3 fields into nested objects (a variant's case included): `config.rate`. */
const FIELD_PATH = /^[a-zA-Z][a-zA-Z0-9_]{0,39}(?:\.[a-zA-Z][a-zA-Z0-9_]{0,39}){0,2}$/;
const STATE = /^[a-z][a-zA-Z0-9_-]{0,39}$/;
const SEGMENT = /^(?:[a-z0-9][a-z0-9-]{0,39}|:[a-z][a-zA-Z0-9]{0,39})$/;
/** `{$bind.field}`, `{$row.join.field}` (a joined doc's field), each with an optional `|format`. */
const PLACEHOLDER = /\{\$([a-zA-Z][a-zA-Z0-9]*)\.([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)?)(?:\|([a-zA-Z]+))?\}/g;

/** The URL slug of a module: its name without the scope, which a workspace holds once. */
export const moduleSlug = (id: string) => id.slice(id.indexOf("/") + 1);

// A small checker, as recipes/manifest.ts: each pushes "<path> must be <what>".
type Check = (x: unknown, path: string, errors: string[]) => void;
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const must = (e: string[], p: string, what: string) => { e.push(`${p} must be ${what}`); };
const str = (min: number, max: number, re?: RegExp, what?: string): Check => (x, p, e) => {
  if (typeof x !== "string" || x.length < min || x.length > max || (re && !re.test(x))) must(e, p, what ?? `text of ${min} to ${max} characters`);
};
const oneOf = (values: readonly unknown[]): Check => (x, p, e) => { if (!values.includes(x)) must(e, p, `one of ${values.join(", ")}`); };
const num = (min: number, max: number): Check => (x, p, e) => { if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max) must(e, p, `a whole number from ${min} to ${max}`); };
const scalar: Check = (x, p, e) => { if (x !== null && !["string", "number", "boolean"].includes(typeof x)) must(e, p, "text, a number, true/false or null"); };
const list = (item: Check, max: number, min = 0): Check => (x, p, e) => {
  if (!Array.isArray(x) || x.length < min || x.length > max) return must(e, p, `a list of ${min} to ${max} items`);
  x.forEach((v, i) => item(v, `${p}[${i}]`, e));
};
const obj = (shape: Record<string, Check>, optional: readonly string[] = []): Check => (x, p, e) => {
  if (!isRecord(x)) return must(e, p, "an object");
  for (const k of Object.keys(x)) if (!Object.hasOwn(shape, k)) e.push(`${p}.${k} is not a known key`);
  for (const [k, check] of Object.entries(shape)) {
    if (x[k] === undefined) { if (!optional.includes(k)) e.push(`${p}.${k} is missing`); } else check(x[k], `${p}.${k}`, e);
  }
};
const dict = (value: Check, max: number, key: RegExp = NAME): Check => (x, p, e) => {
  if (!isRecord(x) || Object.keys(x).length > max) return must(e, p, `an object of at most ${max} keys`);
  for (const [k, v] of Object.entries(x)) {
    if (!key.test(k)) e.push(`${p}.${k} is not a name (a-z first, then letters and digits)`);
    else value(v, `${p}.${k}`, e);
  }
};
const either = (...checks: Check[]): Check => (x, p, e) => {
  const tries = checks.map((c) => { const out: string[] = []; c(x, p, out); return out; });
  if (!tries.some((t) => !t.length)) e.push(...tries.reduce((a, b) => (b.length < a.length ? b : a)));
};

const roles = list(oneOf(ROLES), ROLES.length);
const text = (max: number) => str(1, max);
const clockExpr = [obj({ now: oneOf(["ms", "date"]) }), obj({ nowPlusDays: num(-3650, 3650), as: oneOf(["ms", "date"]) }, ["as"])];
const expr = either(scalar, obj({ arg: str(1, 40, NAME, "an argument name") }), obj({ caller: oneOf(["userId"]) }), ...clockExpr);
const pageExpr = either(scalar, obj({ route: str(1, 40, NAME, "a route parameter") }), obj({ caller: oneOf(["userId"]) }), obj({ query: str(1, 40, NAME, "a URL parameter's name"), default: scalar }, ["default"]));
const formExpr = either(pageExpr, obj({ bind: str(1, 40, NAME, "a binding's name"), field: str(1, 40, FIELD, "a field name") }), obj({ row: str(1, 40, FIELD, "a field of the row") }), obj({ today: oneOf([true]) }));
const jsonQueryExpr = obj({ query: str(1, 40, NAME, "a URL parameter name"), json: oneOf([true]) });
const initialExpr = either(formExpr, obj({ text: str(1, 300) }));
const prefill = { fixed: dict(formExpr, 50, FIELD), initial: dict(initialExpr, 50, FIELD) };
/**
 * A row condition. A `ref`'s own `where` reads that doc's fields, and may test a further doc it names (a dispute's
 * statement's plan), up to MAX_REF_CHAIN docs away; a ref past the first names its `collection`.
 */
const rowWhereAt = (depth: number): Check => (x, p, e) => either(
  obj({ field: str(1, 40), in: list(scalar, 50, 1) }), obj({ field: str(1, 40), neq: scalar }), obj({ all: list(rowWhereAt(depth), 10, 1) }),
  ...(depth < MAX_REF_CHAIN ? [obj({ ref: str(1, 40, FIELD, "a field naming a doc"), collection: str(1, 40), where: rowWhereAt(depth + 1) }, depth === 0 ? ["collection"] : [])] : []),
)(x, p, e);
const rowWhere: Check = rowWhereAt(0);
const scopeCheck: Check = either(oneOf(["all", "team", "hier", "own", "ownerOrUnrestricted", "none"]), obj({ scope: oneOf(["all", "team", "hier", "own", "ownerOrUnrestricted"]), where: rowWhere }), obj({ scope: oneOf(["team", "hier", "own"]), or: rowWhere }), obj({ members: str(1, 163), scope: oneOf(["all", "team", "hier", "own", "ownerOrUnrestricted"]) }, ["scope"]));
const workspaceExpr = obj({ workspace: oneOf(["fiscalYearStartMonth"]) });
const callExpr: Check = (x, p, e) => either(
  scalar, obj({ arg: str(1, 40, FIELD, "an argument name") }), obj({ caller: oneOf(["userId"]) }), obj({ read: str(1, 40, NAME, "a read's name"), field: str(1, 40, FIELD, "a field name") }, ["field"]),
  obj({ toMs: callExpr, endOfDay: oneOf([true]) }, ["endOfDay"]), obj({ toDate: callExpr }),
  workspaceExpr, obj({ fiscalYearStart: callExpr, as: oneOf(["ms", "date"]), years: num(-10, 10) }, ["as", "years"]), ...clockExpr,
)(x, p, e);
const range = obj({ gte: expr, gt: expr, lte: expr, lt: expr }, ["gte", "gt", "lte", "lt"]);
const validator: Check = (x, p, e) => { e.push(...validatorProblems(x, p)); };
const inWhen = obj({ field: str(1, 40, FIELD, "a field name"), in: list(scalar, 50, 1) });
const docWhen = either(inWhen, obj({ field: str(1, 40, FIELD, "a field name"), set: oneOf([true, false]) }), obj({ field: str(1, 40, FIELD, "a field name"), me: oneOf([true, false]) }));
const pageValue = either(obj({ query: str(1, 40, NAME, "a URL parameter's name"), default: scalar }, ["default"]), obj({ route: str(1, 40, NAME, "a route parameter") }), obj({ bind: str(1, 40, NAME, "a binding's name"), field: str(1, 40, FIELD, "a field name") }));
const whenValue = either(scalar, obj({ now: oneOf(["year", "month", "date"]) }));
const pageWhen = either(obj({ page: pageValue, in: list(scalar, 50, 1) }), obj({ page: pageValue, set: oneOf([true, false]) }), obj({ page: pageValue, gte: whenValue }), obj({ page: pageValue, lte: whenValue }));
/** What every action takes: `when` on its doc or a page value, its button's `aria` label, and a write's `toast`. */
const actionCommon = { when: either(docWhen, pageWhen), aria: text(200) };
const dialogWords = obj({ title: text(200), description: text(400), submit: text(60), badge: text(60) }, ["title", "description", "submit", "badge"]);
const waitedJob = obj({ job: str(1, 40, NAME, "a job name"), keyPrefix: list(formExpr, MAX_KEY_PARTS) }, ["keyPrefix"]);
const jobWait = obj({ job: str(1, 40, NAME, "a job name"), keyPrefix: list(formExpr, MAX_KEY_PARTS), toast: text(200), follow: list(waitedJob, 4, 1), busy: text(120) }, ["keyPrefix", "follow", "busy"]);
const writeCommon = { ...actionCommon, toast: text(200), dialog: dialogWords, wait: jobWait, blocked: oneOf(["hide"]) };
const fieldName = str(1, 40, FIELD, "a field name");
const rowChoices = obj({ from: str(1, 40), list: str(1, 40, FIELD, "a field of the call's value"), title: text(300), value: str(1, 81), initial: str(1, 81), options: obj({ list: str(1, 81), value: str(1, 81), label: text(200) }, ["value"]) }, ["list", "value", "initial", "options"]);
const fieldOptions = obj({ from: str(1, 40, NAME, "a binding's name"), list: str(1, 81), value: str(1, 81), label: text(200), sub: text(200), badge: text(60), by: obj({ sibling: fieldName, key: fieldName, list: fieldName }) }, ["list", "value", "sub", "badge", "by"]);
const formField = obj({ field: str(1, 40), label: text(MAX_FIELD_LABEL), widget: oneOf(WIDGETS), help: text(300), placeholder: text(120), rows: rowChoices, options: fieldOptions, optionTargets: list(obj({ path: str(1, 200, /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)*$/), options: fieldOptions }), 8, 1), hide: list(scalar, 50, 1) }, ["widget", "help", "placeholder", "rows", "options", "optionTargets", "hide"]);
const reportValues = list(obj({ fn: oneOf(["count", "sum", "avg", "min", "max"]), field: str(1, 40, FIELD, "a field name") }, ["field"]), 5, 1);
const dimKey: Check = (x, p, e) => either(str(1, 81, /^[a-zA-Z][a-zA-Z0-9_]{0,39}(?:\.[a-zA-Z][a-zA-Z0-9_]{0,39})?$/, "a dimension's name"), obj({ field: str(1, 81), bucket: oneOf(REPORT_BUCKET_NAMES) }, ["bucket"]))(x, p, e);
const reportLink = obj({ id: str(1, 40, NAME, "a report's id"), rows: list(dimKey, 2, 1), columns: list(dimKey, 1, 1), values: reportValues, chart: oneOf(REPORT_CHART_KINDS) }, ["rows", "columns", "values", "chart"]);
const COMMON_KEYS = ["when", "aria"];
const WRITE_KEYS = [...COMMON_KEYS, "toast", "dialog", "wait", "blocked"];
const actionRef: Check = (x, p, e) => either(
  obj({ op: str(1, 60, DOTTED, "an op name"), label: text(120), target: str(1, 40), key: formExpr, parent: pageExpr, then: str(1, 200), fields: list(formField, 30, 1), ...prefill, ...writeCommon }, ["label", "target", "key", "parent", "then", "fields", "fixed", "initial", ...WRITE_KEYS]),
  obj({
    transition: str(1, 40, NAME, "a transition name"), machine: str(1, 40, NAME, "a machine name"), label: text(120), target: str(1, 40), key: formExpr,
    fields: list(formField, 20, 1), fixed: dict(formExpr, 20, FIELD), initial: dict(initialExpr, 20, FIELD), ...writeCommon,
    then: either(str(1, 200), obj({ created: either(oneOf([true]), str(1, 40, NAME, "an effect's as")), path: str(1, 200) }, ["path"]), obj({ path: str(1, 200) })),
  }, ["label", "target", "key", "fields", "fixed", "initial", "then", ...WRITE_KEYS]),
  obj({ navigate: str(1, 300), label: text(120), target: str(1, 40), report: reportLink, ...actionCommon }, ["target", "report", ...COMMON_KEYS]),
  obj({ call: str(1, 60, DOTTED, "a call name"), label: text(120), initial: dict(initialExpr, 20, FIELD), args: dict(formExpr, 20, FIELD), confirm: text(300), then: str(1, 200), fields: list(formField, 20, 1), ...writeCommon }, ["label", "initial", "args", "confirm", "then", "fields", ...WRITE_KEYS]),
  obj({ export: str(1, 60, DOTTED, "an export name"), label: text(60), args: dict(formExpr, 20, FIELD), formats: list(oneOf(EXPORT_FORMATS), EXPORT_FORMATS.length, 1), dialog: dialogWords, toast: text(200), members: obj({ arg: str(1, 40, FIELD, "an argument name"), label: text(60), roles }, ["label", "roles"]),
    picks: list(obj({ arg: str(1, 40, FIELD, "an argument name"), label: text(60), options: fieldOptions }, ["label"]), 3, 1),
    count: obj({ from: str(1, 40, NAME, "a binding's name"), label: text(60), member: rowPath, picks: dict(rowPath, 3, FIELD) }, ["member", "picks"]),
    ...actionCommon }, ["label", "args", "formats", "dialog", "toast", "members", "picks", "count", ...COMMON_KEYS]),
  obj({ csvImport: str(1, 60, DOTTED, "a CSV import's name"), label: text(60), ...actionCommon }, ["label", ...COMMON_KEYS]),
  obj({ print: text(60) }),
  obj({ pdf: text(60), filename: str(1, 80, /^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/, "a file name of letters, digits, spaces, . _ and -"), toast: text(200) }, ["filename", "toast"]),
  obj({ canon: oneOf(CANON_PAGES), label: text(60), bind: str(1, 40), ref: str(1, 40, FIELD, "a deal, company or person ref"), query: canonQuery, ...actionCommon }, ["bind", "ref", "query", ...COMMON_KEYS]),
  obj({ menu: text(60), items: list((y, q, f) => {
    if (!isRecord(y)) return actionRef(y, q, f);
    if ("menu" in y) return must(f, q, "an action, not another menu");
    const { line, separator, ...item } = y;
    if (line !== undefined) text(200)(line, `${q}.line`, f);
    if (separator !== undefined) oneOf([true])(separator, `${q}.separator`, f);
    return actionRef(item, q, f);
  }, 10, 1), ...actionCommon }, COMMON_KEYS),
  obj({ viewAs: formExpr, label: text(60), path: str(1, 200), ...actionCommon }, ["path", ...COMMON_KEYS]),
)(x, p, e);
/** A row value: a field, a count, or `<join>.<field>`. */
const rowPath = str(1, 81, /^[a-zA-Z][a-zA-Z0-9_]{0,39}(?:\.[a-zA-Z][a-zA-Z0-9_]{0,39})?$/, "a field, a count or a joined doc's field (join.field)");
/** A row condition (RowWhen): a row value among `in`, set or not, naming the reader or not (`me`), or at least `gte`. */
const rowWhen = either(obj({ field: rowPath, in: list(scalar, 50, 1) }), obj({ field: rowPath, set: oneOf([true, false]) }), obj({ field: rowPath, me: oneOf([true, false]) }), obj({ field: rowPath, gte: num(-1e15, 1e15) }));
const exportPdf = obj({ page: str(1, 200), key: str(1, 81) });
const exportColumns = list(obj({ label: text(60), value: text(300) }), 60, 1);
/** A number, fractions too (an attainment of 1.0 is 100%), from `min` to `max`. */
const real = (min: number, max: number): Check => (x, p, e) => { if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max) must(e, p, `a number from ${min} to ${max}`); };
const toneCase = either(
  obj({ tone: oneOf(TONE_NAMES), in: list(scalar, 50, 1) }), obj({ tone: oneOf(TONE_NAMES), gte: real(-1_000_000_000_000, 1_000_000_000_000) }),
  obj({ tone: oneOf(TONE_NAMES), lte: real(-1_000_000_000_000, 1_000_000_000_000) }), obj({ tone: oneOf(TONE_NAMES) }),
);
/** What a figure may carry besides its value: a tone by a value, a trend arrow and a line under it. */
const kpiExtras = { tone: obj({ by: text(300), cases: list(toneCase, 10, 1) }), trend: text(300), hint: text(300) };
const KPI_EXTRAS = Object.keys(kpiExtras);
/** A row value in an `each` column: `{col}` may stand for the item's key in either part (`byMonth.{col}`). */
const colPath = either(rowPath, str(1, 90, /^[a-zA-Z{][a-zA-Z0-9_{}]*(?:\.[a-zA-Z{][a-zA-Z0-9_{}]*)?$/, "a field, or a field with {col} for the column's key (byMonth.{col})"));
/** A Canon link's URL parameters, each a text over the page and the row (`?title=` on Settings > Team). */
const canonQuery = dict(text(1000), 6, /^[a-zA-Z][a-zA-Z0-9_.]{0,40}$/);
const editorCallKeys = { call: str(1, 60, DOTTED, "a declared call"), args: dict(formExpr, 10, FIELD) };
const editorCall = obj(editorCallKeys, ["args"]);
const inlineEdit = obj({ ...editorCallKeys, field: rowPath, arg: fieldName, version: rowPath, versionArg: fieldName, maxLength: num(1, 100_000), nonempty: oneOf([true]), validate: editorCall, prefix: rowPath, suffix: rowPath }, ["args", "nonempty", "validate", "prefix", "suffix"]);
const definitionEdit = obj({ sentence: rowPath, param: str(1, 40, NAME), query: inlineEdit });
const hierarchy = obj({ parent: rowPath, depth: rowPath, icon: rowPath, muted: rowPath, star: rowPath,
  add: obj({ ...editorCallKeys, choices: rowPath, arg: fieldName }, ["args"]),
  move: obj({ ...editorCallKeys, targets: rowPath, arg: fieldName }, ["args"]),
}, ["add", "move"]);
const tableColumns = list(obj({
  edit: inlineEdit, definition: definitionEdit, label: str(0, 200), value: text(300), align: oneOf(["end"]), sort: colPath, total: obj({ sum: colPath, over: colPath, format: oneOf(FORMATS) }, ["over", "format"]), group: text(200),
  link: either(str(1, 200), obj({ record: str(1, 40, FIELD, "a joined deal ref") }), obj({ canon: oneOf(CANON_PAGES), ref: str(1, 40, FIELD, "a deal, company or person ref"), query: canonQuery }, ["ref", "query"]), obj({ path: rowPath }), obj({ url: rowPath })),
  when: rowWhen, cases: list(obj({ when: rowWhen, value: text(300) }), 10, 1),
  empty: text(80), tone: obj({ by: colPath, cases: list(toneCase, 10, 1), badge: oneOf([true]) }, ["badge"]),
  tooltip: text(300), copy: text(300), avatars: rowPath,
  bar: obj({ value: colPath, tone: obj({ by: colPath, cases: list(toneCase, 10, 1) }) }, ["tone"]),
  popover: obj({ items: rowPath, label: text(200), title: text(120) }, ["title"]),
  expand: obj({
    label: text(80), body: (x, p, e) => nodes(x, p, e),
    bind: dict(obj({ view: str(1, 60), args: dict(formExpr, 10) }, ["args"]), 6, NAME),
  }, ["label", "bind"]),
  each: either(obj({ from: str(1, 40), rows: str(1, 40, FIELD, "a field of the value") }, ["rows"]), obj({ fiscalMonths: either(oneOf([null]), formExpr) })),
  headerLink: str(1, 300),
}, ["edit", "definition", "align", "sort", "total", "group", "link", "when", "cases", "empty", "tone", "tooltip", "copy", "avatars", "bar", "popover", "expand", "each", "headerLink"]), 20, 1);
const dimName = str(1, 81, /^[a-zA-Z][a-zA-Z0-9_]{0,39}(?:\.[a-zA-Z][a-zA-Z0-9_]{0,39})?$/, "a dimension's name");
const reportKey = either(dimName, obj({ field: dimName, bucket: oneOf(REPORT_BUCKET_NAMES) }, ["bucket"]));
const reportShape = {
  collection: str(1, 60), rows: list(reportKey, 2, 1), columns: list(reportKey, 1, 1),
  values: list(obj({ fn: oneOf(["count", "sum", "avg", "min", "max"]), field: str(1, 40, FIELD, "a field name") }, ["field"]), 5, 1),
};
const reportDisplay = obj({ stacked: oneOf([true, false]), axes: list(oneOf(["left", "right"]), 5, 1), types: list(oneOf(["bar", "line"]), 5, 1), shares: list(oneOf([true, false]), 5, 1) }, ["stacked", "axes", "types", "shares"]);
/** The keys a table takes, over a list binding's rows or a call's: links, row actions, sort, filters, search, sections. */
const chipWhen = rowWhen;
const rowFocus = obj({ param: str(1, 40, NAME, "a URL parameter"), aliases: list(str(1, 40, NAME, "a URL parameter"), 4, 1) }, ["aliases"]);
const tableKeys = {
  hierarchy,
  focus: rowFocus,
  rowLink: str(1, 200), rowActions: list(actionRef, MAX_ROW_ACTIONS), id: str(1, 20, NAME, "a name (a-z first)"),
  sort: obj({ by: rowPath, dir: oneOf(["asc", "desc"]) }, ["dir"]), filters: list(obj({ field: rowPath, label: text(40), options: str(1, 40, FIELD, "a field of the call's value") }, ["options"]), 6, 1),
  search: list(rowPath, 8, 1), group: obj({ by: rowPath, collapsed: oneOf([true, false]), link: str(1, 200), pageSize: num(1, 200) }, ["collapsed", "link", "pageSize"]), pageSize: num(5, 200), emptyFiltered: text(200),
  select: obj({ actions: list(actionRef, 6), edit: obj({ op: str(1, 60, DOTTED, "an op name"), label: text(60), fields: list(formField, 8, 1), key: rowPath }, ["label", "key"]), param: str(1, 40, /^[a-zA-Z][a-zA-Z0-9_.]*$/, "a URL parameter") }, ["edit", "param"]),
  chips: list(obj({ label: text(60), when: chipWhen }), 8, 1), attention: chipWhen, summary: oneOf([true]),
  groupBy: list(obj({ by: rowPath, label: text(60) }), 8, 1), totalBar: obj({ label: text(80) }), cards: oneOf([true]),
  reorder: obj({ call: str(1, 60, DOTTED, "a call name"), arg: str(1, 40, FIELD, "an argument name"), args: dict(formExpr, 10, FIELD), by: rowPath }, ["arg", "args", "by"]),
};
const TABLE_KEYS = Object.keys(tableKeys);
const callResult: Check = either(
  obj({ kind: oneOf(["table"]), rows: str(1, 40, FIELD, "a field of the value"), columns: tableColumns, empty: text(300), ...tableKeys }, ["rows", "empty", ...TABLE_KEYS]),
  obj({ kind: oneOf(["kpis"]), items: list(obj({ label: text(60), value: text(300), ...kpiExtras }, KPI_EXTRAS), 12, 1) }),
  obj({ kind: oneOf(["message"]) }),
);
const machineExpr: Check = (x, p, e) => either(
  scalar, obj({ shared: obj({ from: oneOf(["root", "parent"]), field: str(1, 120, FIELD_PATH) }) }), obj({ visitor: oneOf(["email", "name", "label", "verified", "id"]) }), obj({ arg: str(1, 40, FIELD, "an argument name") }), obj({ doc: fieldName }),
  obj({ caller: oneOf(["userId", "role"]) }), obj({ now: oneOf(["ms", "date"]) }),
  obj({ increment: fieldName, by: num(-1_000_000, 1_000_000) }, ["by"]), obj({ nowPlusDays: num(-3650, 3650), as: oneOf(["ms", "date"]) }, ["as"]),
  obj({ copy: fieldName }), obj({ created: str(1, 40, NAME, "an effect's name") }),
  obj({ toMs: machineExpr, endOfDay: oneOf([true]) }, ["endOfDay"]), obj({ toDate: machineExpr }),
  obj({ addDays: machineExpr, days: machineExpr, as: oneOf(["ms", "date"]) }, ["as"]),
  obj({ subtract: list(machineExpr, 2, 2) }),
  obj({ count: obj({ view: str(1, 60, DOTTED, "a view name"), args: dict(machineExpr, 10, FIELD) }, ["args"]) }),
  workspaceExpr, obj({ fiscalYearStart: machineExpr, as: oneOf(["ms", "date"]), years: num(-10, 10) }, ["as", "years"]),
  obj({ lookup: obj({ view: str(1, 60, DOTTED, "a view name"), args: dict(machineExpr, 10, FIELD) }, ["args"]), field: fieldName }),
  obj({ evidence: oneOf(EVIDENCE) }),
)(x, p, e);
const unsetExpr = obj({ unset: oneOf([true]) });
/** A `set` value: a value, or `{ unset: true }`. */
const setExpr: Check = (x, p, e) => (isRecord(x) && "unset" in x ? unsetExpr(x, p, e) : machineExpr(x, p, e));
/** An op's `set`: a machine's values, without arguments or created docs. */
const opExpr: Check = (x, p, e) => {
  if (isRecord(x) && ("arg" in x || "created" in x)) return must(e, p, "a constant, the time, the caller or a value computed from the doc");
  setExpr(x, p, e);
};
const PREDICATE_DEPTH = 6;
const predicate = (depth: number): Check => (x, p, e) => {
  if (depth > PREDICATE_DEPTH) return must(e, p, `a predicate nested at most ${PREDICATE_DEPTH} deep`);
  if (!isRecord(x)) return must(e, p, "a predicate");
  const inner = predicate(depth + 1);
  const field = str(1, 40, FIELD, "a field name");
  const path = str(1, 120, FIELD_PATH, "a field, or a dotted path into nested objects");
  if ("shared" in x) return obj({ shared: obj({ from: oneOf(["root", "parent"]) }), where: inner })(x, p, e);
  if ("field" in x) return either(...(["eq", "ne", "gte", "lte"] as const).map((op) => obj({ field: path, [op]: machineExpr })), obj({ field: path, in: list(scalar, 50, 1) }))(x, p, e);
  if ("truthy" in x) return obj({ truthy: machineExpr })(x, p, e);
  if ("caller" in x) return obj({ caller: oneOf(["isOwner", "isNotOwner", "ownerOnTeam"]) })(x, p, e);
  if ("role" in x) return obj({ role: list(oneOf(ROLES), ROLES.length, 1) })(x, p, e);
  if ("not" in x) return obj({ not: inner })(x, p, e);
  if ("all" in x) return obj({ all: list(inner, 10, 1) })(x, p, e);
  if ("any" in x) return obj({ any: list(inner, 10, 1) })(x, p, e);
  if ("count" in x) {
    obj({ count: obj({ view: str(1, 60, DOTTED, "a view name"), args: dict(machineExpr, 10, FIELD), where: inner }, ["args", "where"]), atLeast: num(0, 1000), atMost: num(0, 1000) }, ["atLeast", "atMost"])(x, p, e);
    if (x.atLeast === undefined && x.atMost === undefined) must(e, p, "a count with atLeast or atMost");
    return;
  }
  if ("ref" in x) return obj({ ref: obj({ collection: str(1, 40), key: machineExpr }), where: inner })(x, p, e);
  if ("fresh" in x) return obj({ fresh: obj({ job: str(1, 40, NAME, "a job name"), keyPrefix: list(machineExpr, MAX_KEY_PARTS) }) })(x, p, e);
  if ("every" in x) return obj({ every: obj({ list: path, where: inner }) })(x, p, e);
  if ("items" in x) {
    obj({ items: obj({ list: path, where: inner }, ["where"]), atLeast: num(0, 1000), atMost: num(0, 1000) }, ["atLeast", "atMost"])(x, p, e);
    if (x.atLeast === undefined && x.atMost === undefined) must(e, p, "an items count with atLeast or atMost");
    return;
  }
  if ("sum" in x) return either(...(["eq", "ne", "gte", "lte"] as const).map((op) => obj({ sum: obj({ list: path, field }, ["field"]), [op]: machineExpr })))(x, p, e);
  if ("length" in x) {
    obj({ length: path, atLeast: num(0, 1_000_000), atMost: num(0, 1_000_000) }, ["atLeast", "atMost"])(x, p, e);
    if (x.atLeast === undefined && x.atMost === undefined) must(e, p, "a length with atLeast or atMost");
    return;
  }
  if ("ordered" in x) return obj({ ordered: obj({ list: path, field: path, strict: oneOf([true]) }, ["strict"]) })(x, p, e);
  if ("disjoint" in x) return obj({ disjoint: obj({ list: path, from: path, to: path }) })(x, p, e);
  if ("unique" in x) return obj({ unique: obj({ list: path, field: path }) })(x, p, e);
  if ("intact" in x) return obj({ intact: oneOf([true]) })(x, p, e);
  must(e, p, "a predicate: field, truthy, caller, role, not, all, any, count, ref, fresh, every, items, sum, length, ordered, disjoint, unique or intact");
};
const guards = list(obj({ when: predicate(0), message: text(200) }), MAX_GUARDS);
const dirties = list(obj({ job: str(1, 40, NAME, "a job name"), key: list(machineExpr, MAX_KEY_PARTS, 1) }), 10);
const effectName = str(1, 40, NAME, "an effect's name");
const fx = { when: predicate(0) };
const recipient: Check = (x, p, e) => (isRecord(x) && "role" in x ? obj({ role: list(oneOf(ROLES), ROLES.length, 1) })(x, p, e) : machineExpr(x, p, e));
const notifyEffect = obj({ notify: list(recipient, 10, 1), message: text(300), link: str(1, 200), subject: text(120), badge: text(30), email: oneOf([true]), ...fx }, ["link", "when", "subject", "badge", "email"]);
const outboundName = str(1, 60, /^[a-z0-9][a-z0-9._-]*$/, "a name of lower-case letters, digits, . _ and -");
const sendEffect = obj({
  send: obj({
    template: str(1, 40, NAME, "a template name"),
    to: either(obj({ slack: outboundName }), obj({ webhook: outboundName }), obj({ members: list(recipient, 10, 1) }), obj({ people: list(machineExpr, 20, 1) })),
    kind: oneOf(SEND_KINDS), approval: oneOf(["person"]), from: obj({ sender: machineExpr }),
  }, ["kind", "approval", "from"]),
  ...fx,
}, ["when"]);
const effect: Check = either(
  obj({ machine: str(1, 40, NAME), transition: str(1, 40, NAME), key: machineExpr, onlyFrom: list(str(1, 40), 20, 1), ...fx }, ["onlyFrom", "when"]),
  obj({ machine: str(1, 40, NAME), transition: str(1, 40, NAME), view: str(1, 60, DOTTED, "a view name"), args: dict(machineExpr, 10, FIELD), onlyFrom: list(str(1, 40), 20, 1), bulk: obj({ then: str(1, 40, NAME, "a transition name") }, ["then"]), ...fx }, ["args", "onlyFrom", "bulk", "when"]),
  obj({ create: str(1, 40), parent: machineExpr, data: dict(machineExpr, 50, FIELD), as: effectName, ...fx }, ["parent", "as", "when"]),
  obj({
    copy: str(1, 40), key: machineExpr, set: dict(machineExpr, 20, FIELD), children: list(str(1, 40), 10, 1),
    related: list(obj({ collection: str(1, 40), field: fieldName }), 10, 1), as: effectName, ...fx,
  }, ["set", "children", "related", "as", "when"]),
  (x, p, e) => (isRecord(x) && "send" in x ? sendEffect(x, p, e) : notifyEffect(x, p, e)),
);
const transitionCheck = obj({
  label: text(60), from: list(str(1, 40), 20, 1),
  to: either(str(1, 40), obj({ restore: str(1, 40, FIELD), fallback: str(1, 40) }), obj({ cases: list(obj({ when: predicate(0), to: str(1, 40) }), 10, 1), else: str(1, 40) })),
  capability: oneOf(Object.keys(CAPABILITIES)), roles: list(oneOf(WRITE_ROLES), WRITE_ROLES.length), share: str(1, 40, NAME, "a share name"), system: oneOf([true]), agent: oneOf(AGENT_MODES), reason: text(300), confirm: text(300),
  guards, args: validator, set: dict(setExpr, 20, FIELD), seal: oneOf([true]), effects: list(effect, 10), dirties, at: fieldName,
  evidence: list(oneOf(EVIDENCE), EVIDENCE.length, 1), ai: str(1, 60, DOTTED, "a call name"), run: str(1, 60, DOTTED, "a call name"),
}, ["capability", "share", "to", "system", "reason", "confirm", "guards", "args", "set", "seal", "effects", "dirties", "at", "evidence", "ai", "run"]);
const machineCheck = obj({
  collection: str(1, 40), field: str(1, 40, FIELD), states: list(str(1, 40, STATE, "a state name (a-z first)"), 20, 1), initial: str(1, 40),
  transitions: dict(transitionCheck, 30),
});
const common = { roles, when: either(obj({ bind: str(1, 40), field: str(1, 40), in: list(scalar, 50, 1) }), obj({ bind: str(1, 40), field: str(1, 40), set: oneOf([true, false]) }), obj({ bind: str(1, 40), empty: oneOf([true, false]) })) };
const commonKeys = ["roles", "when"];
const NODE: Record<ComponentName, Check> = {
  header: obj({ c: oneOf(["header"]), title: text(200), subtitle: text(300), actions: list(actionRef, 10), ...common }, ["subtitle", "actions", ...commonKeys]),
  prose: obj({ c: oneOf(["prose"]), text: text(20000), ...common }, commonKeys),
  recordEditor: obj({ c: oneOf(["recordEditor"]), title: text(200), from: str(1, 40), rows: fieldName, selection: rowFocus, model: rowPath, options: fieldName, version: rowPath, versionArg: fieldName,
    change: obj({ ...editorCallKeys, arg: fieldName }, ["args"]), message: obj({ ...editorCallKeys, fieldArg: fieldName, valueArg: fieldName }, ["args"]), ...common }, ["title", ...commonKeys]),
  setMap: obj({ c: oneOf(["setMap"]), from: str(1, 40), rows: str(1, 40, FIELD), overlaps: str(1, 40, FIELD), selection: rowFocus,
    title: text(200), frameLabel: text(120), empty: text(300), focus: obj({ title: text(200), items: list(obj({ label: text(120), value: text(2000) }), 12, 1), sharedLabel: text(120) }, ["sharedLabel"]), ...common }, ["title", "frameLabel", "empty", "focus", ...commonKeys]),
  table: obj({ c: oneOf(["table"]), from: str(1, 40), columns: tableColumns, rows: str(1, 40, FIELD, "a field of the value"), empty: text(300), ...tableKeys, ...common }, ["rows", "empty", ...TABLE_KEYS, ...commonKeys]),
  form: obj({
    c: oneOf(["form"]), op: str(1, 40), from: str(1, 40), parent: pageExpr, submit: text(60), ...prefill, fixed: dict(either(formExpr, jsonQueryExpr), 50, FIELD),
    fields: list(obj({ field: str(1, 40), label: text(MAX_FIELD_LABEL), widget: oneOf(WIDGETS), help: text(300), placeholder: text(120) }, ["widget", "help", "placeholder"]), 50), ...common,
  }, ["from", "parent", "submit", "fixed", "initial", ...commonKeys]),
  actions: obj({ c: oneOf(["actions"]), items: list(actionRef, 10, 1), machine: str(1, 40), target: str(1, 40), ...common }, ["items", "machine", "target", ...commonKeys]),
  empty: obj({ c: oneOf(["empty"]), text: text(300), action: actionRef, ...common }, ["action", ...commonKeys]),
  tabs: obj({ c: oneOf(["tabs"]), param: str(1, 20, NAME, "a URL parameter's name"), tabs: list(obj({ label: text(120), id: str(1, 40, /^[a-z0-9][a-z0-9-]{0,39}$/, "a tab id of a-z, 0-9 and -"), roles, body: (x, p, e) => nodes(x, p, e) }, ["id", "roles"]), 10, 1), ...common }, ["param", ...commonKeys]),
  banner: obj({ c: oneOf(["banner"]), tone: oneOf(["info", "warn", "success", "danger", "ai"]), text: text(300), actions: list(actionRef, 10), list: obj({ from: str(1, 40), rows: str(1, 40, FIELD, "a field of the value"), label: text(200) }, ["rows"]), ...common }, ["actions", "list", ...commonKeys]),
  statusSteps: obj({ c: oneOf(["statusSteps"]), from: str(1, 40), machine: str(1, 40), steps: list(str(1, 40), 20, 1), ...common }, ["steps", ...commonKeys]),
  timeline: obj({
    c: oneOf(["timeline"]), of: str(1, 40), limit: num(1, 100), ...common,
    hide: obj({ actors: list(oneOf(["system", "agent", "person"]), 3, 1), events: list(str(1, 81), 30, 1), keep: list(str(1, 81), 30, 1), roles }, ["actors", "events", "keep", "roles"]),
  }, ["limit", "hide", ...commonKeys]),
  queue: obj({
    c: oneOf(["queue"]), empty: text(300), search: oneOf([true, false]), ...common,
    filters: oneOf([true, false]), group: oneOf([true, false]),
    sources: list(obj({ from: str(1, 40), label: text(40), title: text(300), subtitle: text(300), date: rowPath, link: str(1, 200), actions: list(actionRef, MAX_ROW_ACTIONS), attention: docWhen }, ["subtitle", "date", "link", "actions", "attention"]), 8, 1),
  }, ["empty", "search", "filters", "group", ...commonKeys]),
  jobStatus: obj({ c: oneOf(["jobStatus"]), job: str(1, 40, NAME, "a job name"), keyPrefix: list(formExpr, MAX_KEY_PARTS), label: text(60), ...common }, ["keyPrefix", "label", ...commonKeys]),
  detail: obj({ c: oneOf(["detail"]), items: list(obj({ label: text(60), value: text(300), span: oneOf([2]) }, ["span"]), 40, 1), columns: oneOf([2, 3, 4]), ...common }, ["columns", ...commonKeys]),
  kpis: obj({
    c: oneOf(["kpis"]), ...common,
    items: list(either(
      obj({ label: text(60), value: text(300), ...kpiExtras }, KPI_EXTRAS),
      obj({ label: text(60), total: obj({ from: str(1, 40), sum: rowPath, format: oneOf(FORMATS) }, ["format"]), ...kpiExtras }, KPI_EXTRAS),
      obj({ label: text(60), count: str(1, 40), ...kpiExtras }, KPI_EXTRAS),
    ), 8, 1),
  }, commonKeys),
  thread: obj({
    c: oneOf(["thread"]), from: str(1, 40), body: rowPath, author: rowPath, at: rowPath, empty: text(300), ...common,
    post: obj({ op: str(1, 60, DOTTED, "an op name"), fixed: dict(formExpr, 20, FIELD), parent: either(pageExpr, obj({ row: rowPath }), obj({ root: oneOf([true]) })), field: fieldName, label: text(60), button: text(60), placeholder: text(120) }, ["label", "button", "placeholder", "fixed"]),
    tags: obj(Object.fromEntries(ROLES.map((r) => [r, text(30)])), ROLES),
  }, ["author", "at", "post", "empty", "tags", ...commonKeys]),
  approvalChain: obj({
    c: oneOf(["approvalChain"]), from: str(1, 40), title: text(300), approver: rowPath, state: rowPath, at: rowPath, order: rowPath, note: text(300),
    progress: obj({ of: str(1, 40), at: fieldName, by: rowPath, complete: inWhen, failed: inWhen }, ["complete", "failed"]),
    done: list(scalar, 20, 1), failed: list(scalar, 20, 1), actions: list(actionRef, MAX_ROW_ACTIONS), empty: text(300), ...common,
  }, ["approver", "state", "progress", "at", "order", "note", "done", "failed", "actions", "empty", ...commonKeys]),
  periodNav: obj({ c: oneOf(["periodNav"]), from: str(1, 40), current: formExpr, label: text(300), link: str(1, 200), sort: rowPath, ...common }, ["sort", ...commonKeys]),
  integrity: obj({ c: oneOf(["integrity"]), from: str(1, 40), ...common }, commonKeys),
  transcript: obj({
    c: oneOf(["transcript"]), call: formExpr, empty: text(300), lineActions: list(actionRef, 3, 1), ...common,
    highlights: list(obj({
      from: str(1, 40), list: rowPath, segment: str(1, 40, FIELD, "a field"), start: str(1, 40, FIELD, "a field"), end: str(1, 40, FIELD, "a field"),
      tone: either(oneOf(TONE_NAMES), obj({ by: str(1, 40, FIELD, "a field"), cases: list(toneCase, 10, 1) })), label: text(300),
    }, ["list", "start", "end", "tone"]), 6, 1),
  }, ["highlights", "lineActions", "empty", ...commonKeys]),
  phone: either(obj({ c: oneOf(["phone"]), record: pageExpr, from: str(1, 40), phone: rowPath, ...common }, commonKeys), obj({
    c: oneOf(["phone"]), from: str(1, 40), person: rowPath, name: rowPath, phone: rowPath, detail: text(300), skip: actionRef,
    since: formExpr, campaign: obj({ id: formExpr, name: text(200) }), empty: text(300), ...common,
  }, ["detail", "skip", "since", "campaign", "empty", ...commonKeys])),
  callResult: obj({ c: oneOf(["callResult"]), from: str(1, 40), label: text(60), ...common }, ["label", ...commonKeys]),
  bulkStatus: obj({ c: oneOf(["bulkStatus"]), from: str(1, 40), link: str(1, 200), label: text(60), ...common }, ["link", "label", ...commonKeys]),
  outbox: obj({ c: oneOf(["outbox"]), from: str(1, 40), states: list(oneOf(OUTBOX_STATES), OUTBOX_STATES.length, 1), actions: list(oneOf(Object.keys(OUTBOX_ACTIONS)), 3, 1), empty: text(300), ...common }, ["states", "actions", "empty", ...commonKeys]),
  pacing: obj({
    c: oneOf(["pacing"]), id: str(1, 40, NAME), title: text(80), target: str(1, 40),
    sources: list(obj({ id: str(1, 40, NAME), label: text(80), collection: str(1, 60), date: str(1, 120), amount: str(1, 120),
      filter: list(obj({ field: str(1, 120), op: oneOf(REPORT_READ_OPS), value: either(scalar, list(scalar, 50)) }, ["value"]), 10), coverage: oneOf([true, false]),
    }, ["filter", "coverage"]), 6, 1), ...common,
  }, ["title", "target", ...commonKeys]),
  dashboards: obj({ c: oneOf(["dashboards"]), title: text(80), ...common }, ["title", ...commonKeys]),
  report: obj({
    c: oneOf(["report"]), id: str(1, 40, NAME, "a name (a-z first)"), title: text(80), chart: oneOf(REPORT_CHART_KINDS), ...reportShape, ...common,
    sources: list(str(1, 60), 6, 1), display: reportDisplay,
  }, ["title", "chart", "rows", "columns", "values", "sources", "display", ...commonKeys]),
  chart: obj({
    c: oneOf(["chart"]), kind: oneOf(["bar", "line", "stacked", "pie", "waterfall"]), title: text(80), from: str(1, 40), rows: str(1, 40, FIELD, "a field of the value"),
    x: rowPath, y: rowPath, series: rowPath, bucket: oneOf(REPORT_BUCKET_NAMES), report: obj(reportShape, ["rows", "columns", "values"]),
    order: oneOf(["value", "label"]), dir: oneOf(["asc", "desc"]), top: num(1, 100), format: oneOf(["number", "money", "percent"]), link: str(1, 200),
    start: str(1, 40, FIELD, "a field of the value"), end: str(1, 40, FIELD, "a field of the value"), startLabel: text(40), endLabel: text(40), ...common,
  }, ["title", "from", "rows", "x", "y", "series", "bucket", "report", "order", "dir", "top", "format", "link", "start", "end", "startLabel", "endLabel", ...commonKeys]),
  stepper: obj({
    c: oneOf(["stepper"]), param: str(1, 40, NAME, "a URL parameter's name"), label: text(60), step: num(1, 1000),
    default: either(oneOf(["thisYear", "thisFiscalYear"]), num(-1_000_000_000, 1_000_000_000)), min: num(-1_000_000_000, 1_000_000_000), max: num(-1_000_000_000, 1_000_000_000), format: oneOf(["fy"]), ...common,
  }, ["label", "step", "min", "max", "format", ...commonKeys]),
  dateRange: obj({
    c: oneOf(["dateRange"]), from: str(1, 40, NAME, "a URL parameter's name"), to: str(1, 40, NAME, "a URL parameter's name"), label: text(60), default: text(60), ...common,
  }, ["label", "default", ...commonKeys]),
  wizard: obj({
    c: oneOf(["wizard"]), op: str(1, 60, DOTTED, "an op name"), call: str(1, 60, DOTTED, "a call name"),
    steps: list(obj({ title: text(80), description: text(300), fields: list(formField, 20, 1) }, ["description"]), 8, 1),
    preview: obj({ title: text(120), items: list(obj({ label: text(60), value: text(300) }), 16, 1) }, ["title"]),
    submit: text(60), then: str(1, 200), toast: text(200), ...prefill, ...common,
  }, ["op", "call", "preview", "submit", "then", "toast", "fixed", "initial", ...commonKeys]),
  grid: obj({
    c: oneOf(["grid"]), from: str(1, 40), op: str(1, 60, DOTTED, "an op name"), field: str(1, 40, FIELD, "a field name"), title: text(300),
    each: either(obj({ from: str(1, 40), rows: str(1, 40, FIELD, "a field of the value") }, ["rows"]), obj({ fiscalMonths: either(oneOf([null]), formExpr) })),
    label: text(120), widget: oneOf(["number", "money", "percent"]), total: oneOf([true]), ...common,
    cells: obj({ from: str(1, 40), row: fieldName, column: fieldName, create: str(1, 60, DOTTED, "an op name"), fixed: dict(formExpr, 10, FIELD) }, ["create", "fixed"]),
  }, ["widget", "total", "cells", ...commonKeys]),
  shareLinks: obj({ c: oneOf(["shareLinks"]), share: str(1, 40, NAME, "a share name"), from: str(1, 40), ...common }, commonKeys),
  tree: obj({
    c: oneOf(["tree"]), from: str(1, 40), rows: str(1, 40, FIELD, "a field of the value"), id: rowPath, parent: rowPath, title: text(300), subtitle: text(300), link: str(1, 200), canonLink: obj({ canon: oneOf(CANON_PAGES), query: canonQuery }, ["query"]), empty: text(300), ...common,
    details: list(obj({ label: text(60), value: text(300) }), 12, 1),
  }, ["rows", "id", "subtitle", "link", "canonLink", "empty", "details", ...commonKeys]),
  flow: obj({
    c: oneOf(["flow"]), from: str(1, 40), rows: str(1, 40, FIELD, "a field of the value"), id: rowPath, parent: rowPath, title: text(300), action: text(120), metric: text(60), card: text(300), tone: text(60), empty: text(300), ...common,
    details: list(obj({ label: text(60), value: text(300) }), 12, 1),
  }, ["rows", "id", "parent", "action", "metric", "card", "tone", "empty", "details", ...commonKeys]),
};
const node: Check = (x, p, e) => {
  if (!isRecord(x) || typeof x.c !== "string" || !(COMPONENTS as readonly string[]).includes(x.c)) return must(e, `${p}.c`, `one of ${COMPONENTS.join(", ")}`);
  NODE[x.c as ComponentName](x, p, e);
};
const nodes = list(node, 40);

const pageBinds = (max: number) => dict(either(obj({
  view: str(1, 60), args: dict(formExpr, 10), join: list(str(1, 40, FIELD, "a ref field"), 8, 1),
  count: dict(obj({ view: str(1, 60, DOTTED, "a view name"), by: str(1, 40, FIELD, "a field, or parentKey"), of: str(1, 40, FIELD, "a field of the row"), collect: str(1, 40, FIELD, "a field of the counted docs") }, ["of", "collect"]), 6, FIELD),
  limit: num(1, MAX_PAGE_ROWS),
}, ["args", "join", "count", "limit"]), obj({ call: str(1, 60, DOTTED, "a call name"), args: dict(formExpr, 20, FIELD), refreshMinutes: num(5, 1440), refreshOn: list(str(1, 40, FIELD), 10, 1) }, ["args", "refreshMinutes", "refreshOn"]),
obj({ canon: oneOf(Object.keys(CANON_READS)), args: dict(formExpr, 10, FIELD), limit: num(1, MAX_PAGE_ROWS) }, ["args", "limit"])), max);

const shareWhere: Check = (x, p, e) => either(
  obj({ field: fieldName, in: list(scalar, 50, 1) }), obj({ field: fieldName, neq: scalar }),
  obj({ all: list(shareWhere, 10, 1) }),
)(x, p, e);
const shareCheck = obj({
  label: text(80), collection: fieldName, when: shareWhere,
  identity: obj({ default: oneOf(["link", "email"]), allow: list(oneOf(["link", "email"]), 2, 1), domains: list(str(1, 253), 10) }, ["domains"]),
  expiresDays: obj({ default: num(1, 120), max: num(1, 120) }),
  read: dict(obj({ fields: list(fieldName, 100, 1), where: shareWhere }, ["where"]), MAX_COLLECTIONS),
  members: list(oneOf(["name", "title"]), 2),
  write: obj({ ops: list(str(1, 60, DOTTED, "an op name"), 30), transitions: list(str(1, 81, DOTTED, "a transition name"), 30) }),
  pages: list(obj({ path: str(1, 200), title: text(200), bind: dict(either(obj({ root: oneOf([true]) }), obj({ rootList: fieldName }), obj({ set: fieldName, key: obj({ route: fieldName }), where: obj({ field: fieldName, eq: obj({ route: fieldName }) }) }, ["key", "where"])), MAX_PAGE_BINDS), body: nodes }, ["bind"]), 20, 1),
  issue: obj({ roles: list(oneOf(ROLES), ROLES.length, 1), agent: oneOf(["human"]), notify: oneOf(["owner"]) }, ["notify"]),
  record: obj({ collection: fieldName }), signals: oneOf([true]),
  limits: obj({ writesPerHour: num(1, 1000), uploadsPerDay: num(0, 1000), uploadBytes: num(0, 104857600) }),
}, ["when", "record", "signals"]);

const MANIFEST = obj({
  kind: oneOf(["module"]),
  visibility: oneOf(["open", "private"]),
  id: str(3, 104, PACKAGE_ID, "a namespaced id like @agency/module-name"),
  version: str(5, 32, SEMVER, "a version like 1.2.0"),
  title: text(80),
  description: text(600),
  author: obj({ org: str(1, 40, /^[a-z0-9][a-z0-9-]*$/, "an org name of a-z, 0-9 and -") }),
  engines: obj({ moduleApi: oneOf([MODULE_API]) }),
  nav: obj({ label: text(40), icon: oneOf(NAV_ICONS), section: oneOf(NAV_SECTIONS), landing: either(str(1, 200), obj({ default: str(1, 200), ...Object.fromEntries(ROLES.map((r) => [r, str(1, 200)])) }, ROLES)), slot: oneOf(Object.keys(NAV_SLOTS)) }, ["slot"]),
  links: list(oneOf(Object.keys(NAV_SLOTS)), Object.keys(NAV_SLOTS).length, 1),
  default: oneOf([true]),
  imports: list(str(3, 200, /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/, "a dotted import name like icps.legacy"), 10),
  reports: dict(obj({ name: text(80), report: str(1, 40, NAME), spec: (x, p, e) => { const problem = mismatch(reportSpec, x, p); if (problem) e.push(problem); } }), 50, /^[a-z0-9][a-z0-9_-]{0,62}$/),
  dashboards: dict(obj({ name: text(80), tiles: list(obj({ report: str(1, 63, /^[a-z0-9][a-z0-9_-]{0,62}$/), wide: oneOf([true, false]) }), 20) }), 20, /^[a-z0-9][a-z0-9_-]{0,62}$/),
  collections: dict(obj({
    schema: validator,
    key: either(oneOf(["auto"]), obj({ from: list(str(1, 40), 4, 1) })),
    max: num(1, MAX_VIEW_LIMIT),
    owner: str(1, 40),
    indexes: dict(list(str(1, 40), MAX_INDEX_FIELDS, 1), MAX_INDEXES),
    access: obj(Object.fromEntries(ROLES.map((r) => [r, scopeCheck])), ROLES),
    retainedEvidence: obj({ deal: fieldName }),
    setOf: obj({ parent: str(1, 40) }),
    title: either(str(1, 40, FIELD, "a field name"), str(1, 200, /\{\$doc\./, "a field name, or a text over {$doc.<field>}")),
    activity: obj({
      kind: str(1, 40, /^[a-z][a-z0-9_-]*$/, "an activity kind"), subject: fieldName, at: fieldName, dueDate: fieldName, status: fieldName, owner: fieldName,
      targets: obj({ companies: fieldName, people: fieldName, deals: fieldName }, ["companies", "people", "deals"]),
      path: str(1, 200, /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\/:key$/, "a local module detail path ending in /:key"),
    }, ["at", "dueDate", "status", "owner"]),
    integrity: obj({ field: fieldName, fields: list(fieldName, 50, 1), children: dict(list(fieldName, 50, 1), 5) }, ["children"]),
    label: text(40),
    report: obj({ dimensions: list(str(1, 81, /^[a-zA-Z][a-zA-Z0-9_]{0,39}(?:\.[a-zA-Z][a-zA-Z0-9_]{0,39})?$/, "a field, or a ref field's record's field (deal.stage)"), MAX_DIMENSIONS, 1), measures: list(fieldName, MAX_MEASURES, 1), members: fieldName,
      memberLatest: obj({ by: fieldName, fields: list(fieldName, 10, 1), upTo: oneOf(["today"]), where: list(obj({ field: fieldName, op: oneOf(REPORT_READ_OPS), value: either(scalar, list(scalar, 50)) }, ["value"]), 5, 1) }, ["upTo", "where"]) }, ["measures", "members", "memberLatest"]),
  }, ["max", "owner", "retainedEvidence", "setOf", "title", "activity", "integrity", "report", "label"]), MAX_COLLECTIONS),
  views: dict(either(
    obj({
      kind: oneOf(["list"]), collection: str(1, 40), args: dict(oneOf(ARG_TYPES), 10), parent: expr,
      index: str(1, 40), eq: list(expr, MAX_INDEX_FIELDS), range, order: oneOf(["asc", "desc"]), limit: num(1, MAX_VIEW_LIMIT), where: rowWhere,
    }, ["args", "parent", "index", "eq", "range", "order", "limit", "where"]),
    obj({ kind: oneOf(["one"]), collection: str(1, 40), args: dict(oneOf(["string", "number", "boolean"]), 10), key: expr }, ["args"]),
  ), MAX_VIEWS, DOTTED),
  ops: dict(obj({
    label: text(60), kind: oneOf(["create", "update", "delete"]), collection: str(1, 40), fields: list(str(1, 40), 100, 1),
    capability: oneOf(Object.keys(CAPABILITIES)), roles: list(oneOf(WRITE_ROLES), WRITE_ROLES.length), share: str(1, 40, NAME, "a share name"), agent: oneOf(["allowed", "propose", "human"]), reason: text(300), set: dict(opExpr, 20, FIELD),
    guards, system: oneOf([true]), dirties, effects: list((x, p, e) => (isRecord(x) && "send" in x ? sendEffect(x, p, e) : notifyEffect(x, p, e)), 5, 1),
  }, ["capability", "share", "fields", "reason", "set", "guards", "system", "dirties", "effects"]), 100, DOTTED),
  machines: dict(machineCheck, 20),
  shares: dict(shareCheck, 20),
  reads: obj({
    ...Object.fromEntries(Object.entries(CANON_FIELDS).map(([o, fields]) => [o, list(oneOf(fields), fields.length, 1)])),
    records: list(str(1, 50, RECORD_GRANT, "a Canon object a report reads (companies, people, custom_<slug>) or *"), 40, 1),
  }, [...Object.keys(CANON_FIELDS), "records"]),
  proposes: list(oneOf(PROPOSAL_OPERATION_NAMES), PROPOSAL_OPERATION_NAMES.length, 1),
  outbound: obj({
    email: obj({ from: list(oneOf(EMAIL_SENDERS), EMAIL_SENDERS.length, 1), kinds: list(oneOf(SEND_KINDS), SEND_KINDS.length, 1) }),
    slack: obj({ channels: list(outboundName, 10, 1) }),
    webhook: obj({ events: list(outboundName, 20, 1) }),
  }, [...OUTBOUND_CHANNELS]),
  templates: dict(either(
    obj({ channel: oneOf(["email"]), subject: text(200), body: text(5000) }),
    obj({ channel: oneOf(["slack"]), text: text(3000) }),
    obj({ channel: oneOf(["webhook"]), data: dict(text(500), 30, FIELD) }),
  ), 30),
  provides: dict(obj({ view: str(1, 60, DOTTED, "a view name"), fields: list(str(1, 40, FIELD, "a field name"), 40, 1),
    people: obj({ filter: str(1, 40, FIELD, "a field name"), added: obj({ set: str(1, 40), field: str(1, 40, FIELD, "a field name") }) }, ["added"]) }, ["people"]), 20, PROVIDE_NAME),
  uses: dict(list(str(1, 50, PROVIDE_NAME, "an interface name, as tallies.v1"), 20, 1), 10, /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/),
  server: str(4, 200, /^(?!.*\.\.)[a-zA-Z0-9_][a-zA-Z0-9_./-]*\.js$/, "a path in the package to a .js file, as dist/module.js"),
  calls: dict(obj({
    capability: oneOf(Object.keys(CAPABILITIES)), label: text(60), args: validator, roles: list(oneOf(ROLES), ROLES.length), agent: oneOf(["allowed", "propose", "human"]), reason: text(300), system: oneOf([true]),
    canon: obj({ operation: oneOf(CANON_OPERATIONS), then: obj({
      machine: str(1, 40, NAME), transition: str(1, 40, NAME), key: str(1, 40, FIELD), expect: str(1, 40, FIELD),
      input: dict(obj({ field: str(1, 40, FIELD) }), 3, FIELD), args: obj({ jobId: obj({ result: oneOf(["jobId"]) }) }),
    }) }, ["then"]),
    proposal: obj({ summary: text(200) }),
    reads: dict(either(
      obj({ view: str(1, 60, DOTTED, "a view name"), args: dict(callExpr, 10, FIELD), limit: num(1, MAX_READ_DOCS) }, ["args", "limit"]),
      obj({ canon: oneOf(Object.keys(CANON_READS)), args: dict(callExpr, 10, FIELD), limit: num(1, MAX_READ_DOCS), custom: oneOf([true]) }, ["args", "limit", "custom"]),
      obj({ module: str(1, 100), provide: str(1, 50, PROVIDE_NAME, "an interface name, as tallies.v1"), args: dict(callExpr, 10, FIELD), limit: num(1, MAX_READ_DOCS) }, ["args", "limit"]),
      obj({ tree: obj({
        nodes: str(1, 40, FIELD, "an earlier read"), query: fieldName, parent: fieldName, order: fieldName,
        named: obj({ read: str(1, 40, FIELD, "an earlier read"), node: fieldName, company: fieldName }),
        owners: oneOf([true, false]), deals: oneOf([true, false]), market: oneOf([true, false]),
        cells: obj({ node: callExpr, by: list(oneOf(["country", "region", "sizeBand", "industry"]), 2, 1) }), place: callExpr,
      }, ["parent", "order", "named", "owners", "deals", "market", "cells", "place"]) }),
      obj({ icpTree: obj({ icps: str(1, 40, FIELD, "an earlier own-doc read"), nodes: str(1, 40, FIELD, "an earlier own-doc read"), market: oneOf([true, false]) }, ["market"]) }),
      obj({ report: obj({ ...reportShape, filter: list(obj({ field: dimName, op: oneOf(REPORT_READ_OPS), value: callExpr }, ["value"]), 8, 1) }, ["rows", "columns", "values", "filter"]) }),
      obj({ aggregate: obj({
        collection: str(1, 40), values: list(obj({ fn: oneOf(["count", "sum", "avg"]), field: str(1, 40, FIELD, "a field name") }, ["field"]), 4, 1),
        filter: list(obj({ field: dimName, op: oneOf(REPORT_READ_OPS), value: callExpr }, ["value"]), 8, 1), minOwners: num(MIN_AGGREGATE_OWNERS, 1000),
      }, ["filter", "minOwners"]) }),
    ), MAX_READS),
    writes: list(str(1, 40), MAX_COLLECTIONS), returns: oneOf(["none", "value"]), result: callResult, confirm: text(300),
    step: obj({ key: str(1, 40, FIELD), machine: str(1, 40, NAME), fail: str(1, 40, NAME), logFailure: obj({ domain: str(1, 40, FIELD), stage: oneOf(["deriving"]) }) }, ["logFailure"]),
    ai: obj({
      sources: dict(obj({ read: str(1, 40), field: str(1, 40, FIELD) }), 10, FIELD),
      credits: oneOf([false]), evidencePolicy: obj({ minimum: num(1, 10), repair: oneOf([true]), exact: oneOf([true]) }),
      prompt: str(1, AI_PROMPT_MAX), output: obj({ op: str(1, 60, DOTTED, "an op name"), key: callExpr, fields: list(str(1, 40, FIELD, "a field name"), 40, 1), set: dict(scalar, 10, AI_PATH), provenance: obj({ model: str(1, 40, FIELD), provider: str(1, 40, FIELD) }), copy: dict(str(1, 40), 10, FIELD) }, ["set", "provenance", "copy"]),
      choices: dict(obj({ read: str(1, 40), field: str(1, 40, FIELD, "a field name") }, ["field"]), 10, AI_PATH),
      evidence: list(obj({
        quote: str(1, 250, AI_PATH, "a path like drivers[].quotes[].text"), source: str(1, 250, AI_PATH, "a path like drivers[].quotes[].source"), in: either(str(1, 40), list(str(1, 40), 10, 1)), onInvalid: oneOf(["hypothesis"]), exact: oneOf([true]), sourceField: str(1, 40, FIELD),
        text: list(str(1, 40, FIELD, "a field name"), 10, 1), minLength: num(1, 500), dropParent: str(1, 250, AI_PATH, "a list's path, as drivers[]"),
      }, ["source", "text", "minLength", "dropParent", "onInvalid", "exact", "sourceField"]), 10, 1),
      budget: obj({ inputChars: num(1, AI_INPUT_MAX), perDay: num(1, AI_PER_DAY_MAX) }, ["inputChars", "perDay"]),
      queue: obj({ machine: str(1, 40, NAME, "a machine name"), then: str(1, 40, NAME, "a transition name"), fail: str(1, 40, NAME, "a transition name"), next: str(1, 60, DOTTED, "a call name"), logFailure: obj({ domain: str(1, 40, FIELD), stage: oneOf(["deriving"]) }) }, ["then", "next", "logFailure"]),
    }, ["choices", "evidence", "budget", "queue", "credits", "evidencePolicy", "sources"]),
  }, ["capability", "args", "reason", "system", "result", "confirm", "ai", "step", "proposal", "canon"]), MAX_CALLS, DOTTED),
  jobs: dict(obj({
    label: text(60), call: str(1, 60, DOTTED, "a call name"), key: list(str(1, 40, NAME, "a key part's name"), MAX_KEY_PARTS, 1),
    batchBy: num(0, MAX_KEY_PARTS), order: str(1, 40, NAME, "a key part's name"), batch: num(1, MAX_JOB_BATCH), attempts: num(1, 10),
    orderBy: obj({ collection: str(1, 40), field: fieldName }),
  }, ["batchBy", "order", "orderBy", "batch", "attempts"]), 20),
  watches: list(obj({ object: oneOf(Object.keys(WATCHED_FIELDS)), call: str(1, 60, DOTTED, "a call name"), fields: list(oneOf(WATCHABLE), WATCHABLE.length, 1) }), 5),
  feeds: dict(obj({ feed: str(3, 100, DOTTED, "a feed name"), call: str(1, 60, DOTTED, "a call name"), fields: list(str(1, 40, FIELD, "a field name"), 20, 1), backfillDays: num(0, 365) }, ["backfillDays"]), 10),
  schedules: dict(obj({ label: text(60), call: str(1, 60, DOTTED, "a call name"), everyMinutes: num(5, 1440), dailyAt: str(5, 5, /^([01]\d|2[0-3]):[0-5]\d$/, "a time of day like 06:30") }, ["everyMinutes", "dailyAt"]), 10),
  exports: dict(either(
    obj({ label: text(60), filename: str(1, 80, /^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/, "a file name"), people: obj({ provide: str(1, 60, DOTTED, "a provided interface"), key: obj({ arg: fieldName }) }), record: obj({ op: str(1, 60, DOTTED, "an op name"), parent: obj({ op: str(1, 60, DOTTED, "an op name"), field: fieldName }) }, ["parent"]) }, ["filename", "record"]),
    obj({ label: text(60), filename: str(1, 80, /^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/, "a file name of letters, digits, spaces, . _ and -"), columns: exportColumns, view: str(1, 60, DOTTED, "a view name"), join: list(str(1, 40, FIELD, "a ref field"), 8, 1), limit: num(1, MAX_EXPORT_ROWS), require: obj({ when: predicate(0), message: text(200) }), pdf: exportPdf }, ["filename", "join", "limit", "require", "pdf"]),
    obj({ label: text(60), filename: str(1, 80, /^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/, "a file name of letters, digits, spaces, . _ and -"), columns: exportColumns, call: str(1, 60, DOTTED, "a call name"), rows: str(1, 40, FIELD, "a field of the value"), pdf: exportPdf }, ["filename", "rows", "pdf"]),
  ), 20, DOTTED),
  csvImports: dict(obj({
    label: text(60), call: str(1, 60, DOTTED, "a call name"), batch: num(1, CSV_IMPORT_BATCH_MAX),
    columns: list(obj({ field: str(1, 40, FIELD, "a field of a row"), label: text(60), synonyms: list(text(60), 10, 1) }, ["label", "synonyms"]), 60, 1),
  }, ["batch"]), 10, DOTTED),
  pages: list(obj({
    path: str(1, 200, /^(?!panel\/)/, "a path that doesn't start panel/ (Canon serves panels there)"), title: text(200), roles, tab: obj({ label: text(40), order: num(0, 100), roles }, ["roles"]),
    bind: pageBinds(MAX_PAGE_BINDS), body: nodes,
    onOpen: obj({ machine: str(1, 40, NAME, "a machine name"), transition: str(1, 40, NAME, "a transition name"), target: str(1, 40) }),
    fallback: obj({ text: text(300), missing: text(300), heading: text(80), actions: list(obj({ label: text(60), path: str(1, 200) }), 3, 1), back: obj({ label: text(60), path: str(1, 200) }) }, ["text", "missing", "heading", "actions"]),
    document: obj({ heading: text(80), wordmark: text(40), footer: text(120) }, ["heading", "wordmark", "footer"]),
    persist: list(str(1, 81, /^[a-zA-Z][a-zA-Z0-9_.]{0,80}$/, "a URL parameter's name"), 12, 1),
  }, ["roles", "tab", "bind", "onOpen", "fallback", "document", "persist"]), 50),
  migrations: dict(list(obj({ from: str(1, 60, VERSION_RANGE, "a version range like <1.3.0 or >=1.0.0 <1.3.0"), call: str(1, 60, NAME, "the name of a function in the bundle's calls") }), 5, 1), MAX_COLLECTIONS),
  upgrade: obj({ job: str(1, 40, NAME, "a job's name"), key: list(str(1, 200), 8, 1) }, ["key"]),
  contributes: obj({
    people: obj({ listActions: list(obj({ id: str(1, 40, NAME, "an action id"), label: text(60), path: str(1, 200, /^[a-z0-9][a-z0-9-]{0,39}(?:\/[a-z0-9][a-z0-9-]{0,39})*$/, "a literal module page path"), param: str(1, 40, NAME, "a URL parameter name"), roles }, ["roles"]), 4, 1) }),
    deals: obj({ badges: list(obj({ view: str(1, 60, DOTTED, "a view name"), deal: fieldName, label: text(60), tone: oneOf(TONE_NAMES), when: rowWhen, join: list(fieldName, 4, 1), count: oneOf([true]) }, ["tone", "when", "join", "count"]), 4, 1) }),
    team: obj({ columns: list(obj({ label: text(40), view: str(1, 60, DOTTED, "a view name"), member: fieldName, value: text(200), filter: oneOf([true, false]), join: list(fieldName, 4, 1), key: fieldName, when: rowWhen }, ["filter", "join", "key", "when"]), 4, 1) }),
    ...Object.fromEntries(PANEL_PAGES.map((page) => [`${page}Page`, obj({ panels: list(obj({
      id: str(1, 40, NAME, "a panel id"), title: text(80), roles, replaces: str(1, 40, FIELD, "a customization section kind"), bind: pageBinds(MAX_PANEL_BINDS), body: nodes,
      link: obj({ label: text(60), path: str(1, 200) }),
    }, ["roles", "replaces", "bind", "link"]), MAX_PANELS, 1) })])),
  }, ["people", "deals", "team", ...PANEL_PAGES.map((p) => `${p}Page`)]),
}, ["visibility", "shares", "nav", "links", "default", "imports", "reports", "dashboards", "machines", "reads", "proposes", "outbound", "templates", "provides", "uses", "server", "calls", "jobs", "watches", "feeds", "schedules", "exports", "csvImports", "migrations", "upgrade", "contributes"]);

const fieldsOf = (c: CollectionDecl) => c.schema.value;

/**
 * What a module adds to Canon's pages: each from a list view with no arguments (the page reads it as its person), the
 * field naming the deal (a deals ref) or the member (a member ref, or `owner`), texts over the doc, refs it joins.
 */
function contributionChecks(m: ModuleManifest, e: string[]) {
  const ids = new Set<string>();
  const forms = peopleFilterForms(m);
  for (const [i, page] of m.pages.entries()) if (forms.filter((f) => f.path === page.path).length > 1) e.push(`pages[${i}]: a page accepts only one JSON People filter handoff`);
  for (const [i, action] of (m.contributes?.people?.listActions ?? []).entries()) {
    const at = `contributes.people.listActions[${i}]`;
    if (ids.has(action.id)) e.push(`${at}.id repeats ${action.id}`);
    ids.add(action.id);
    const page = m.pages.find((p) => p.path === action.path);
    if (!page) { e.push(`${at}.path must name a literal module page`); continue; }
    if (!forms.some((f) => f.path === action.path && f.param === action.param)) e.push(`${at}.param must feed a fixed JSON People filter on that page's form`);
    for (const role of action.roles ?? ROLES) {
      if (!peopleFilterForms(m, role).some((f) => f.path === action.path && f.param === action.param)) e.push(`${at} offers ${role} a form that role cannot use`);
    }
  }
  const each = (at: string, view: string, join: readonly string[] | undefined, texts: ReadonlyArray<[string | undefined, string]>, counted = false) => {
    const v = m.views[view];
    if (!v || v.kind !== "list") { e.push(`${at}.view names ${view}, which is not a list view`); return null; }
    if (Object.keys(v.args ?? {}).length) e.push(`${at}.view names ${view}, which takes arguments: a Canon page gives none`);
    const c = m.collections[v.collection];
    join?.forEach((f, k) => { if (!refOf(c?.schema.value[f])) e.push(`${at}.join[${k}] names ${f}, which is not a ref field of ${v.collection}`); });
    for (const [t, where] of texts) for (const [, b, , fmt] of (t ?? "").matchAll(PLACEHOLDER)) {
      // A counting badge also reads its docs on the deal: `{$docs.count}`.
      if (b !== "row" && !(counted && b === "docs")) e.push(`${at}.${where} names $${b}; a contribution's texts read the doc as $row${counted ? " and the deal's docs as $docs" : ""}`);
      if (fmt && !(FORMATS as readonly string[]).includes(fmt)) e.push(`${at}.${where} formats with ${fmt}, not one of ${FORMATS.join(", ")}`);
    }
    return c ?? null;
  };
  /** A contribution's `when` reads a field of the view's collection, or a field of a ref it joins (`deal.stage`). */
  const whenOk = (c: CollectionDecl, field: string, join: readonly string[] | undefined, at: string) => {
    const [first, second] = field.split(".");
    if (!c.schema.value[first] || (second !== undefined && !join?.includes(first))) e.push(`${at} names ${field}, which is not a field of the view's collection or of a ref it joins`);
  };
  m.contributes?.deals?.badges.forEach((b, i) => {
    const at = `contributes.deals.badges[${i}]`;
    const c = each(at, b.view, b.join, [[b.label, "label"]], b.count === true);
    if (c && refOf(c.schema.value[b.deal])?.to !== "deals") e.push(`${at}.deal names ${b.deal}, which is not a deal ref of the view's collection`);
    if (c && b.when) whenOk(c, b.when.field, b.join, `${at}.when`);
  });
  m.contributes?.team?.columns.forEach((col, i) => {
    const at = `contributes.team.columns[${i}]`;
    const c = each(at, col.view, col.join, [[col.value, "value"]]);
    if (c && !(col.member === "owner" ? c.owner : refOf(c.schema.value[col.member])?.to === "users")) e.push(`${at}.member names ${col.member}, which is not a member ref (or owner) of the view's collection`);
    if (c && col.key !== undefined && !Object.hasOwn(c.schema.value, col.key)) e.push(`${at}.key names ${col.key}, which is not a field of the view's collection`);
    if (c && col.when) whenOk(c, col.when.field, col.join, `${at}.when`);
  });
}
/** The ref a field holds (an optional one's too), or null. */
const refOf = (spec: FieldSpec | undefined): Extract<ValidatorJSON, { type: "ref" }> | null => {
  if (!spec) return null;
  const core = coreOf(spec.fieldType);
  return core.type === "ref" ? core : null;
};
const segmentsOf = (path: string) => path.split("/");
const paramsOf = (path: string) => segmentsOf(path).filter((s) => s.startsWith(":")).map((s) => s.slice(1));
/** Whether `href`, a page-relative path such as "visits/:key" or "visits", names a page of the module. */
const namesPage = (pages: ReadonlyArray<{ path: string }>, href: string) =>
  pages.some((p) => { const a = segmentsOf(p.path), b = segmentsOf(href.split("?")[0]); return a.length === b.length && a.every((s, i) => s.startsWith(":") || b[i].startsWith(":") || s === b[i]); });
/** The `:params` a link fills: its path's and its query's (`tallies?month=:key`). */
const linkParams = (href: string) => [...href.matchAll(/:([a-zA-Z][a-zA-Z0-9]*)/g)].map((x) => x[1]);

/** Every component of a page's body, those inside tabs too. */
const flatNodes = (nodes: readonly Node[]): Node[] => nodes.flatMap((n) => (n.c === "tabs" ? [n, ...n.tabs.flatMap((t) => flatNodes(t.body))] : [n]));

/** The fields of `collection` a machine owns, each with its machine's name. */
export function machineFields(m: Pick<ModuleManifest, "machines">, collection: string): Map<string, string> {
  return new Map(Object.entries(m.machines ?? {}).filter(([, mc]) => mc.collection === collection).map(([name, mc]) => [mc.field, name]));
}

/** What a value or predicate may name where it sits: its doc's collection, the arguments, and the docs effects created so far. */
type ExprScope = { collection: string; args: Record<string, unknown> | null; created: Set<string>; what: string; evidence?: readonly Evidence[] };

/** Checks of the values and predicates guards, `set`, effects and op guards name, against the manifest. */
/**
 * The specs a field path names in an object: `rate`, or `config.rate` through nested objects and the cases of a
 * variant (a field any case has). Empty when it names none.
 */
export function specsAt(schema: ObjectValidator, path: string): FieldSpec[] {
  let at: ObjectValidator[] = [schema];
  const parts = path.split(".");
  let out: FieldSpec[] = [];
  parts.forEach((part, i) => {
    out = at.flatMap((o) => (Object.hasOwn(o.value, part) ? [o.value[part]] : []));
    if (i === parts.length - 1) return;
    at = out.flatMap((sp) => { const core = coreOf(sp.fieldType); return core.type === "object" ? [core] : core.type === "variant" ? Object.values(core.cases) : []; });
  });
  return out;
}

/** What a predicate's `field` names: a collection's docs, or the rows of a list field (a list of values as `value`). */
type Shape = { name: string; schema: ObjectValidator; owner: boolean; set: boolean };

/** Checks of the values and predicates guards, `set`, effects and op guards name, against the manifest. */
function exprChecks(m: ModuleManifest, e: string[]) {
  const shapeOf = (subject: string | Shape): Shape | null => {
    if (typeof subject !== "string") return subject;
    const c = m.collections[subject];
    return c ? { name: subject, schema: c.schema, owner: c.owner !== undefined, set: c.setOf !== undefined } : null;
  };
  const docField = (f: string, subject: string | Shape, where: string, number = false) => {
    const sh = shapeOf(subject);
    if (!sh || f === "key") return;
    if (f === "parentKey") { if (!sh.set) e.push(`${where} names parentKey, but ${sh.name} isn't a set`); return; }
    const specs = specsAt(sh.schema, f);
    if (!specs.length) e.push(`${where} names ${f}, which is not a field of ${sh.name}`);
    else if (number && specs.some((sp) => coreOf(sp.fieldType).type !== "number")) e.push(`${where} names ${f}, which isn't a number`);
  };
  /** The rows of the list field `list` of `subject`, as a shape a row predicate tests. */
  const rowsOf = (list: string, subject: string | Shape, where: string): Shape | null => {
    const sh = shapeOf(subject);
    if (!sh) return null;
    const specs = specsAt(sh.schema, list);
    const item = specs.map((sp) => coreOf(sp.fieldType)).find((t) => t.type === "array");
    if (!item || item.type !== "array") { e.push(`${where} names ${list}, which is not a list field of ${sh.name}`); return null; }
    const row = coreOf(item.value);
    return { name: `${sh.name}.${list}`, schema: row.type === "object" ? row : { type: "object", value: { value: { fieldType: row, optional: false } } }, owner: false, set: false };
  };
  const viewArgs = (view: string, given: Record<string, MachineExpr> | undefined, where: string, sc: ExprScope, collection?: string, listOnly = true) => {
    const v = m.views[view];
    if (!v) return e.push(`${where}.view names ${view}, which is not a view`);
    if (listOnly && v.kind !== "list") e.push(`${where}.view names ${view}, which reads one doc, not a list`);
    if (collection !== undefined && v.collection !== collection) e.push(`${where}.view names ${view}, which reads ${v.collection}, not ${collection}`);
    if (Object.values(v.args ?? {}).some(isListArg)) e.push(`${where}.view names ${view}, which takes a list: only a call's read plan gives one`);
    for (const [k, x] of Object.entries(given ?? {})) { if (!Object.hasOwn(v.args ?? {}, k)) e.push(`${where}.args.${k} is not an argument of ${view}`); expr(x, `${where}.args.${k}`, sc); }
    for (const k of Object.keys(v.args ?? {})) if (!Object.hasOwn(given ?? {}, k)) e.push(`${where}.args.${k} is missing`);
  };
  const expr = (x: MachineExpr, where: string, sc: ExprScope): void => {
    if (x === null || typeof x !== "object") return;
    if ("arg" in x) {
      if (sc.args === null) e.push(`${where} names argument ${x.arg}, but ${sc.what} takes none`);
      else if (!Object.hasOwn(sc.args, x.arg)) e.push(`${where} names argument ${x.arg}, which ${sc.what} doesn't take`);
    } else if ("doc" in x) docField(x.doc, sc.collection, where);
    else if ("increment" in x) docField(x.increment, sc.collection, where, true);
    else if ("copy" in x) docField(x.copy, sc.collection, where);
    else if ("created" in x) { if (!sc.created.has(x.created)) e.push(`${where} names ${x.created}, which no earlier effect of ${sc.what} creates`); }
    else if ("toMs" in x) expr(x.toMs, `${where}.toMs`, sc);
    else if ("toDate" in x) expr(x.toDate, `${where}.toDate`, sc);
    else if ("addDays" in x) { expr(x.addDays, `${where}.addDays`, sc); expr(x.days, `${where}.days`, sc); }
    else if ("subtract" in x) x.subtract.forEach((y, i) => expr(y, `${where}.subtract[${i}]`, sc));
    else if ("count" in x) { if (m.views[x.count.view]?.kind !== "list") e.push(`${where}.count.view names ${x.count.view}, which is not a list view`); else viewArgs(x.count.view, x.count.args, `${where}.count`, sc, undefined, false); }
    else if ("fiscalYearStart" in x) expr(x.fiscalYearStart, `${where}.fiscalYearStart`, sc);
    else if ("evidence" in x) { if (!sc.evidence?.includes(x.evidence)) e.push(`${where} reads evidence ${x.evidence}, which ${sc.what} doesn't declare: only a transition's evidence is read`); }
    else if ("lookup" in x) {
      viewArgs(x.lookup.view, x.lookup.args, `${where}.lookup`, sc, undefined, false);
      const vc = m.views[x.lookup.view]?.collection;
      if (vc) docField(x.field, vc, `${where}.field`);
    }
  };
  /** `subject`: the collection whose doc `field` names (the doc a guard tests, a counted or a related doc), or a list's rows. */
  const pred = (p: Predicate, where: string, subject: string | Shape, sc: ExprScope): void => {
    const sh = shapeOf(subject);
    if ("ordered" in p || "disjoint" in p || "unique" in p) {
      const [key, decl, fields] = "ordered" in p ? ["ordered", p.ordered, [p.ordered.field]] as const : "disjoint" in p ? ["disjoint", p.disjoint, [p.disjoint.from, p.disjoint.to]] as const : ["unique", p.unique, [p.unique.field]] as const;
      const rows = rowsOf(decl.list, subject, `${where}.${key}.list`);
      if (rows) for (const f of fields) docField(f, rows, `${where}.${key}`);
      return;
    }
    if ("length" in p) {
      docField(p.length, subject, `${where}.length`);
      const specs = sh ? specsAt(sh.schema, p.length) : [];
      if (specs.some((sp) => coreOf(sp.fieldType).type !== "string")) e.push(`${where}.length names ${p.length}, which isn't a text field`);
      return;
    }
    if ("every" in p || "items" in p || "sum" in p) {
      const [key, decl] = "every" in p ? ["every", p.every] as const : "items" in p ? ["items", p.items] as const : ["sum", p.sum] as const;
      const rows = rowsOf(decl.list, subject, `${where}.${key}.list`);
      if (rows && "where" in decl && decl.where) pred(decl.where, `${where}.${key}.where`, rows, sc);
      if (rows && "sum" in p) {
        const f = p.sum.field ?? "value";
        if (!rows.schema.value[f] || coreOf(rows.schema.value[f].fieldType).type !== "number") e.push(`${where}.sum names ${f}, which isn't a number field of ${rows.name}`);
        for (const op of ["eq", "ne", "gte", "lte"] as const) if (op in p) expr((p as unknown as Record<string, MachineExpr>)[op], `${where}.${op}`, sc);
      }
      return;
    }
    if ("field" in p) {
      docField(p.field, subject, `${where}.field`);
      for (const op of ["eq", "ne", "gte", "lte"] as const) if (op in p) expr((p as Record<string, MachineExpr>)[op], `${where}.${op}`, sc);
    } else if ("truthy" in p) expr(p.truthy, `${where}.truthy`, sc);
    else if ("caller" in p) { if (sh && !sh.owner) e.push(`${where} needs ${sh.name} to have an owner`); }
    else if ("not" in p) pred(p.not, `${where}.not`, subject, sc);
    else if ("all" in p) p.all.forEach((q, i) => pred(q, `${where}.all[${i}]`, subject, sc));
    else if ("any" in p) p.any.forEach((q, i) => pred(q, `${where}.any[${i}]`, subject, sc));
    else if ("count" in p) {
      viewArgs(p.count.view, p.count.args, `${where}.count`, sc);
      const counted = m.views[p.count.view]?.collection;
      if (p.count.where && counted && m.collections[counted]) pred(p.count.where, `${where}.count.where`, counted, sc);
    } else if ("ref" in p) {
      if (!m.collections[p.ref.collection]) return void e.push(`${where}.ref.collection names ${p.ref.collection}, which is not a collection`);
      expr(p.ref.key, `${where}.ref.key`, sc);
      pred(p.where, `${where}.where`, p.ref.collection, sc);
    } else if ("intact" in p) {
      if (sh && !m.collections[sh.name]?.integrity) e.push(`${where}.intact: ${sh.name} declares no integrity seal`);
    } else if ("fresh" in p) {
      const job = m.jobs?.[p.fresh.job];
      if (!job) return void e.push(`${where}.fresh.job names ${p.fresh.job}, which is not a job`);
      if (p.fresh.keyPrefix.length > job.key.length) e.push(`${where}.fresh.keyPrefix has more parts than ${p.fresh.job}'s key`);
      p.fresh.keyPrefix.forEach((x, i) => { if (x === ANY) e.push(`${where}.fresh.keyPrefix[${i}] is "*": a prefix names values`); expr(x, `${where}.fresh.keyPrefix[${i}]`, sc); });
    }
  };
  /** A write's dirties: each names a job, one value per part of its key, "*" only after the values. */
  const dirtyList = (list: readonly DirtyDecl[] | undefined, where: string, sc: ExprScope) => list?.forEach((d, i) => {
    const at = `${where}[${i}]`;
    const job = m.jobs?.[d.job];
    if (!job) return void e.push(`${at}.job names ${d.job}, which is not a job`);
    if (d.key.length !== job.key.length) e.push(`${at}.key has ${d.key.length} parts; ${d.job}'s key has ${job.key.length} (${job.key.join(", ")})`);
    const first = d.key.indexOf(ANY);
    d.key.forEach((x, k) => {
      if (first >= 0 && k > first && x !== ANY) e.push(`${at}.key[${k}] follows a "*": only the last parts stand for every value`);
      expr(x, `${at}.key[${k}]`, sc);
    });
  });
  /** A notification's recipients, its message's `{$doc...}` and its link: a page, filled from the doc. */
  const notifyOk = (fx: Omit<NotifyEffect, "when">, at: string, collection: string, sc: ExprScope) => {
    const c = m.collections[collection];
    fx.notify.forEach((r, k) => { if (!(isRecord(r) && "role" in r)) expr(r as MachineExpr, `${at}.notify[${k}]`, sc); });
    for (const [key, t] of [["message", fx.message], ["subject", fx.subject ?? ""]] as const) {
      for (const [, b, f, fmt] of t.matchAll(PLACEHOLDER)) {
        if (b !== "doc") e.push(`${at}.${key} names $${b}; a notification's ${key} names $doc`);
        else docField(f, collection, `${at}.${key}`);
        if (fmt && !(FORMATS as readonly string[]).includes(fmt)) e.push(`${at}.${key} formats with ${fmt}, not one of ${FORMATS.join(", ")}`);
      }
    }
    if (fx.link !== undefined) {
      if (!namesPage(m.pages, fx.link)) e.push(`${at}.link names ${fx.link}, which is not a page`);
      for (const param of linkParams(fx.link)) if (param !== "key" && !(param === "parentKey" && c?.setOf) && !c?.schema.value[param]) e.push(`${at}.link fills :${param}, which is not key, parentKey or a field of ${collection}`);
    }
    if (fx.email && !(m.outbound?.email?.from.includes("workspace") && m.outbound.email.kinds.includes("notice"))) e.push(`${at}.email: emailed notices need outbound.email with "workspace" in from and "notice" in kinds`);
  };
  /** A send effect (docs/modules.md, "Outbound"): a declared template on a declared channel, filled from the doc. */
  const sendOk = (fx: Omit<SendEffect, "when">, at: string, collection: string, sc: ExprScope) => {
    const { template, to } = fx.send;
    const t = m.templates?.[template];
    if (!t) return void e.push(`${at}.send.template names ${template}, which is not a template`);
    const channel = "slack" in to ? "slack" : "webhook" in to ? "webhook" : "email";
    if (t.channel !== channel) e.push(`${at}.send.template names ${template}, a ${t.channel} template, but it sends to ${channel === "email" ? "members" : channel}`);
    if ("slack" in to && !m.outbound?.slack?.channels.includes(to.slack)) e.push(`${at}.send.to.slack names ${to.slack}, which outbound.slack.channels doesn't declare`);
    if ("webhook" in to && !m.outbound?.webhook?.events.includes(to.webhook)) e.push(`${at}.send.to.webhook names ${to.webhook}, which outbound.webhook.events doesn't declare`);
    if ("people" in to) {
      if (!fx.send.from) e.push(`${at}.send.from: people email requires an explicit sender reference`);
      else expr(fx.send.from.sender, `${at}.send.from.sender`, sc);
      to.people.forEach((r, k) => expr(r, `${at}.send.to.people[${k}]`, sc));
      const kind = fx.send.kind ?? "automated";
      if (kind === "notice" || !m.outbound?.email?.from.includes("member_mailbox") || !m.outbound.email.kinds.includes(kind)) e.push(`${at}.send: people email requires a declared personal or automated member mailbox`);
      if (fx.send.approval !== undefined) e.push(`${at}.send.approval: mailbox owner consent is decided by Canon`);
    } else if (fx.send.from !== undefined) e.push(`${at}.send.from: only people email accepts a sender reference`);
    if ("members" in to) {
      to.members.forEach((r, k) => { if (!(isRecord(r) && "role" in r)) expr(r as MachineExpr, `${at}.send.to.members[${k}]`, sc); });
      const kind = fx.send.kind ?? "notice";
      if (!m.outbound?.email?.kinds.includes(kind)) e.push(`${at}.send.kind: outbound.email.kinds doesn't declare ${kind}`);
    }
    for (const text of t.channel === "email" ? [t.subject, t.body] : t.channel === "slack" ? [t.text] : Object.values(t.data)) {
      if ("people" in to && (text.includes("{{") || text.replace(/\{\$(?:doc|to|sender)\.[a-zA-Z][a-zA-Z0-9_]*\}/g, "").includes("{$"))) e.push(`${at}.send.template: unsupported mailbox merge syntax`);
      for (const p of placeholders(text)) {
        if (p.bind === "doc") docField(p.field, collection, `${at}.send.template (${template})`);
        if (p.bind === "sender" && !("people" in to)) e.push(`${at}.send.template: sender fields require people email`);
        if ("people" in to && (p.format || !["doc", "to", "sender"].includes(p.bind) || p.bind === "to" && !["name", "firstName", "email"].includes(p.field)
          || p.bind === "doc" && p.field.includes("."))) e.push(`${at}.send.template: mailbox templates accept only closed doc/to/sender fields without formatters`);
      }
    }
  };
  return { expr, pred, viewArgs, dirtyList, docField, notifyOk, sendOk };
}

/** A machine's and its transitions' references, and that no transition's effects lead back to it. */
function machineChecks(m: ModuleManifest, e: string[]) {
  const { expr, pred, viewArgs, dirtyList, notifyOk, sendOk } = exprChecks(m, e);
  const owners = new Map<string, string>();
  for (const [name, mc] of Object.entries(m.machines ?? {})) {
    const at = `machines.${name}`;
    const c = m.collections[mc.collection];
    if (!c) { e.push(`${at}.collection names ${mc.collection}, which is not a collection`); continue; }
    const fields = fieldsOf(c);
    const spec = fields[mc.field];
    if (!spec) { e.push(`${at}.field names ${mc.field}, which is not a field of ${mc.collection}`); continue; }
    const slot = `${mc.collection}.${mc.field}`;
    if (owners.has(slot)) e.push(`${at}.field: machine ${owners.get(slot)} already owns ${slot}`);
    owners.set(slot, name);
    if (c.key !== "auto" && c.key.from.includes(mc.field)) e.push(`${at}.field names ${mc.field}, part of the key, which a transition can't change`);
    mc.states.forEach((s, i) => {
      if (valueProblems(s, spec.fieldType, "", () => false).length) e.push(`${at}.states[${i}] names ${s}, which ${slot} can't hold`);
      if (mc.states.indexOf(s) !== i) e.push(`${at}.states[${i}] names ${s} twice`);
    });
    const state = (s: string, where: string, of: MachineDecl = mc, ofName = name) => { if (!of.states.includes(s)) e.push(`${where} names ${s}, which is not a state of ${ofName}`); };
    state(mc.initial, `${at}.initial`);
    for (const [tn, t] of Object.entries(mc.transitions)) {
      const tat = `${at}.transitions.${tn}`;
      if (t.args && t.args.type !== "object") e.push(`${tat}.args must be an object validator`);
      const sc: ExprScope = { collection: mc.collection, args: t.args?.type === "object" ? t.args.value : {}, created: new Set(), what: tn, evidence: t.evidence ?? [] };
      if (t.evidence && (t.system || t.agent !== "human")) e.push(`${tat}.evidence: where a person ran it is a person's alone, so the transition is agent "human" and not system`);
      if (t.run !== undefined) {
        const c = m.calls?.[t.run];
        if (t.ai || t.system || !c?.step || c.step.machine !== name || !t.capability || c.capability !== t.capability || t.agent !== "allowed") e.push(`${tat}.run requires a member pure step on this machine with the same capability`);
      }
      if (t.ai !== undefined) {
        const c = m.calls?.[t.ai];
        if (t.capability && c?.capability !== t.capability) e.push(`${tat}.ai must retain the starting transition capability on its member call`);
        if (!c?.ai?.queue) e.push(`${tat}.ai names ${t.ai}, which is not a hosted AI call with a queue`);
        else if (c.ai.queue.machine !== name) e.push(`${tat}.ai names ${t.ai}, whose queue moves ${c.ai.queue.machine}, not ${name}`);
      }
      t.from.forEach((s, i) => state(s, `${tat}.from[${i}]`));
      if (typeof t.to === "string") state(t.to, `${tat}.to`);
      else if (t.to && "restore" in t.to) { state(t.to.fallback, `${tat}.to.fallback`); if (!fields[t.to.restore]) e.push(`${tat}.to.restore names ${t.to.restore}, which is not a field of ${mc.collection}`); }
      else if (t.to) { t.to.cases.forEach((k, i) => { state(k.to, `${tat}.to.cases[${i}].to`); pred(k.when, `${tat}.to.cases[${i}].when`, mc.collection, sc); }); state(t.to.else, `${tat}.to.else`); }
      if ((t.agent === "human") !== (t.reason !== undefined)) e.push(t.agent === "human" ? `${tat}.reason is missing: say why an agent can't run it` : `${tat}.reason is only for agent "human"`);
      if (t.system && t.roles.length) e.push(`${tat}.roles must be empty: only Canon runs a system transition`);
      t.guards?.forEach((g, i) => pred(g.when, `${tat}.guards[${i}].when`, mc.collection, sc));
      dirtyList(t.dirties, `${tat}.dirties`, sc);
      if (t.at !== undefined) {
        const type = fields[t.at]?.fieldType.type;
        if (!t.system) e.push(`${tat}.at is only for a system transition: Canon runs it when the time comes`);
        if (type !== "number" && type !== "string") e.push(`${tat}.at names ${t.at}, which isn't a time (ms) or a date field of ${mc.collection}`);
        else if (!Object.values(c.indexes).some((ix) => ix[0] === mc.field && ix[1] === t.at)) e.push(`${tat}.at: ${mc.collection} needs an index that starts with ${mc.field}, ${t.at}`);
        if (t.args?.type === "object" && Object.values(t.args.value).some((a) => !a.optional)) e.push(`${tat}.at: a timed transition takes no arguments`);
      }
      for (const [f, x] of Object.entries(t.set ?? {})) {
        const unset = isUnset(x);
        if (!fields[f]) e.push(`${tat}.set.${f} is not a field of ${mc.collection}`);
        else if (machineFields(m, mc.collection).has(f)) e.push(`${tat}.set.${f} is a machine's field: a transition moves it`);
        else if (c.key !== "auto" && c.key.from.includes(f)) e.push(`${tat}.set.${f} is part of the key, which a transition can't change`);
        else if (unset && !fields[f].optional) e.push(`${tat}.set.${f} unsets a required field`);
        else if (!unset && c.integrity?.field === f) e.push(`${tat}.set.${f} is the integrity seal: Canon writes it (seal), and a set only unsets it`);
        if (!unset) expr(x as MachineExpr, `${tat}.set.${f}`, sc);
      }
      if (t.seal && !c.integrity) e.push(`${tat}.seal: ${mc.collection} declares no integrity seal`);
      if (t.seal && c.integrity && Object.hasOwn(t.set ?? {}, c.integrity.field)) e.push(`${tat}.seal: a transition that seals doesn't set ${c.integrity.field} too`);
      const named = (as: string | undefined, where: string) => {
        if (as === undefined) return;
        if (sc.created.has(as)) e.push(`${where}.as names ${as}, which an earlier effect already does`);
        sc.created.add(as);
      };
      t.effects?.forEach((fx, i) => {
        const fat = `${tat}.effects[${i}]`;
        if (fx.when) pred(fx.when, `${fat}.when`, mc.collection, sc);
        if ("notify" in fx) return notifyOk(fx, fat, mc.collection, sc);
        if ("send" in fx) return sendOk(fx, fat, mc.collection, sc);
        if ("create" in fx) {
          const target = m.collections[fx.create];
          if (!target) return e.push(`${fat}.create names ${fx.create}, which is not a collection`);
          const owned = machineFields(m, fx.create);
          for (const [f, x] of Object.entries(fx.data)) {
            if (!fieldsOf(target)[f]) e.push(`${fat}.data.${f} is not a field of ${fx.create}`);
            else if (owned.has(f)) e.push(`${fat}.data.${f} is machine ${owned.get(f)}'s field: a new doc starts in its initial state`);
            else if (target.integrity?.field === f) e.push(`${fat}.data.${f} is the integrity seal, which only Canon writes`);
            expr(x, `${fat}.data.${f}`, sc);
          }
          if (Boolean(target.setOf) !== (fx.parent !== undefined)) e.push(target.setOf ? `${fat}.parent is missing: ${fx.create} is a set of ${target.setOf.parent}` : `${fat}.parent is only for a set collection`);
          if (fx.parent !== undefined) expr(fx.parent, `${fat}.parent`, sc);
          return named(fx.as, fat);
        }
        if ("copy" in fx) {
          const source = m.collections[fx.copy];
          if (!source) return e.push(`${fat}.copy names ${fx.copy}, which is not a collection`);
          if (source.setOf) e.push(`${fat}.copy names ${fx.copy}, a set: copy its parent with children instead`);
          expr(fx.key, `${fat}.key`, sc);
          const owned = machineFields(m, fx.copy);
          for (const [f, x] of Object.entries(fx.set ?? {})) {
            if (!fieldsOf(source)[f]) e.push(`${fat}.set.${f} is not a field of ${fx.copy}`);
            else if (owned.has(f)) e.push(`${fat}.set.${f} is machine ${owned.get(f)}'s field: a copy starts in its initial state`);
            else if (source.integrity?.field === f) e.push(`${fat}.set.${f} is the integrity seal, which only Canon writes`);
            expr(x, `${fat}.set.${f}`, sc);
          }
          fx.children?.forEach((child, k) => { if (m.collections[child]?.setOf?.parent !== fx.copy) e.push(`${fat}.children[${k}] names ${child}, which is not a set of ${fx.copy}`); });
          fx.related?.forEach((r, k) => {
            const rc = m.collections[r.collection];
            if (!rc) return e.push(`${fat}.related[${k}].collection names ${r.collection}, which is not a collection`);
            if (rc.setOf) e.push(`${fat}.related[${k}].collection names ${r.collection}, a set: list it in children`);
            if (!rc.schema.value[r.field]) e.push(`${fat}.related[${k}].field names ${r.field}, which is not a field of ${r.collection}`);
            else if (machineFields(m, r.collection).has(r.field) || (rc.key !== "auto" && rc.key.from.includes(r.field))) e.push(`${fat}.related[${k}].field names ${r.field}, which a copy can't point elsewhere`);
            else if (!Object.values(rc.indexes).some((ix) => ix[0] === r.field)) e.push(`${fat}.related[${k}].field: ${r.collection} needs an index that starts with ${r.field}`);
          });
          return named(fx.as, fat);
        }
        const tm = m.machines?.[fx.machine];
        if (!tm) return e.push(`${fat}.machine names ${fx.machine}, which is not a machine`);
        const next = tm.transitions[fx.transition];
        if (!next) e.push(`${fat}.transition names ${fx.transition}, which ${fx.machine} doesn't have`);
        else if (next.args?.type === "object" && Object.values(next.args.value).some((a) => !a.optional)) e.push(`${fat}: ${fx.machine}.${fx.transition} takes arguments an effect doesn't pass`);
        fx.onlyFrom?.forEach((s, k) => state(s, `${fat}.onlyFrom[${k}]`, tm, fx.machine));
        if ("key" in fx) expr(fx.key, `${fat}.key`, sc);
        else viewArgs(fx.view, fx.args, fat, sc, tm.collection);
        if ("bulk" in fx && fx.bulk) {
          // A bulk move finishes when the view holds no doc in onlyFrom: each it moves must leave those states.
          if (!fx.onlyFrom) e.push(`${fat}.onlyFrom is missing: a bulk effect moves the docs in those states until none is left`);
          else if (next && (typeof next.to !== "string" || fx.onlyFrom.includes(next.to))) e.push(`${fat}.bulk: ${fx.machine}.${fx.transition} must move each doc to one state outside onlyFrom`);
          // Without `then`, the doc moves on at once and the docs follow in batches (a period reopened, its statements
          // after). Only when no doc can refuse its move: else the doc would show a state its docs never reached.
          if (fx.bulk.then === undefined) {
            if (next?.guards?.length) e.push(`${fat}.bulk: ${fx.machine}.${fx.transition} has guards, so a doc can refuse it; give bulk a then, so ${tn} waits in its state until every doc has moved`);
            return;
          }
          if (typeof t.to !== "string") e.push(`${fat}.bulk: ${tn} waits in one state while the bulk move runs; give it a single to`);
          const then = mc.transitions[fx.bulk.then];
          if (!then) e.push(`${fat}.bulk.then names ${fx.bulk.then}, which ${name} doesn't have`);
          else {
            if (!then.system) e.push(`${fat}.bulk.then names ${fx.bulk.then}, which must be a system transition: Canon runs it`);
            if (typeof t.to === "string" && !then.from.includes(t.to)) e.push(`${fat}.bulk.then names ${fx.bulk.then}, which doesn't start from ${t.to}`);
          }
        }
      });
    }
  }
  // Effects run in the transition's transaction: a transition that leads back to itself would never end.
  const edges = (id: string) => {
    const [mn, tn] = id.split(".");
    return (m.machines?.[mn]?.transitions[tn]?.effects ?? []).flatMap((fx) => ("machine" in fx && m.machines?.[fx.machine]?.transitions[fx.transition] ? [`${fx.machine}.${fx.transition}`] : []));
  };
  const done = new Set<string>();
  const visit = (id: string, path: string[]): string[] | null => {
    if (path.includes(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return null;
    for (const next of edges(id)) { const cycle = visit(next, [...path, id]); if (cycle) return cycle; }
    done.add(id);
    return null;
  };
  for (const id of Object.entries(m.machines ?? {}).flatMap(([mn, mc]) => Object.keys(mc.transitions).map((tn) => `${mn}.${tn}`))) {
    const cycle = visit(id, []);
    if (cycle) return void e.push(`machines.${cycle[0].replace(".", ".transitions.")}.effects lead back to it: ${cycle.join(" → ")}`);
  }
}

/** Whether a `set` value removes its field. */
export const isUnset = (x: unknown): x is { unset: true } => isRecord(x) && x.unset === true && Object.keys(x).length === 1;

/** Whether a read plan value is a date conversion: `toMs`, `toDate` or `fiscalYearStart`. */
const isDated = (x: CallExpr): x is Extract<CallExpr, { toMs: unknown } | { toDate: unknown } | { fiscalYearStart: unknown }> =>
  x !== null && typeof x === "object" && ("toMs" in x || "toDate" in x || "fiscalYearStart" in x);
/** The value inside a read plan's date conversions (`toMs`, `toDate`, `fiscalYearStart`). */
export function unwrapDate(x: CallExpr): CallExpr {
  let at = x;
  while (isDated(at)) at = "toMs" in at ? at.toMs : "toDate" in at ? at.toDate : at.fiscalYearStart;
  return at;
}

/** Each call's arguments, read plan and writes, and that a module with calls ships a server bundle. */
/** A report's shape against its collection's `report` (or a Canon source's fields): its keys dimensions (three at most), its values measures. */
function reportShapeOk(m: ModuleManifest, shape: Pick<ReportShape, "collection" | "rows" | "columns" | "values">, at: string, e: string[]) {
  const c = m.collections[shape.collection];
  const canon = isCanonSource(shape.collection) || recordObjectName(shape.collection) !== null;
  if (!c && !canon) return void e.push(`${at}.collection names ${shape.collection}, which is not a collection`);
  if (c && !c.report) return void e.push(`${at}.collection names ${shape.collection}, which declares no report`);
  if (canon && !grantsSource(m, shape.collection)) return void e.push(`${at}.collection names ${shape.collection}, which the module's reads don't grant`);
  // A custom object's fields are the workspace's own: a declared report over one is checked when it runs.
  const known = sourceFields(m, shape.collection);
  if (!known) return void (([...(shape.rows ?? []), ...(shape.columns ?? [])].length > 3) && e.push(`${at} groups by more than 3 dimensions; a report groups by at most 3`));
  const fields = new Map(known.map((f) => [f.name, f]));
  const dimensions = c ? c.report!.dimensions : [...fields.values()].filter((f) => !isMeasure(f)).map((f) => f.name);
  const measures = c ? c.report!.measures ?? [] : [...fields.values()].filter(isMeasure).map((f) => f.name);
  const keys = [...(shape.rows ?? []), ...(shape.columns ?? [])];
  if (keys.length > 3) e.push(`${at} groups by ${keys.length} dimensions; a report groups by at most 3`);
  keys.forEach((k, j) => {
    const f = typeof k === "string" ? k : k.field;
    if (!dimensions.includes(f) && f !== "createdAt" && f !== "updatedAt") e.push(`${at} groups by ${f}, which is not a dimension of ${shape.collection}`);
    else if (typeof k !== "string" && k.bucket && (fields.get(f)?.join || !["date", "datetime"].includes(fields.get(f)?.type ?? "datetime"))) e.push(`${at} buckets ${f} (key ${j}), which is not a date of the doc's own`);
  });
  shape.values?.forEach((v, j) => {
    if (v.fn === "count") { if (v.field !== undefined) e.push(`${at}.values[${j}]: a count takes no field`); return; }
    if (!v.field || !measures.includes(v.field)) e.push(`${at}.values[${j}] measures ${v.field}, which is not a measure of ${shape.collection}`);
  });
}

/** Whether a read plan value takes anything from the call's arguments. */
const fromArgs = (x: CallExpr): boolean => x !== null && typeof x === "object" && ("arg" in x || (isDated(x) && fromArgs(unwrapDate(x))));

function callChecks(m: ModuleManifest, e: string[]) {
  const calls = Object.entries(m.calls ?? {});
  /** Each collection's team aggregate filter, as the first read over it declares it: every other read over it must match. */
  const aggregateBases = new Map<string, { base: string; at: string }>();
  const migrations = Object.entries(m.migrations ?? {});
  const coded = calls.filter(([, c]) => !c.ai && !c.canon);
  if ((coded.length || migrations.length) && m.server === undefined) e.push("server is missing: a module with calls or migrations ships its code, as dist/module.js");
  if (!coded.length && !migrations.length && m.server !== undefined) e.push("server is only for a module with calls or migrations");
  for (const [collection, list] of migrations) list.forEach((x, i) => {
    if (Object.hasOwn(m.calls ?? {}, x.call)) e.push(`migrations.${collection}[${i}].call names ${x.call}, a declared call: a migration is a function only Canon runs, so give it a name of its own`);
  });
  /**
   * A team aggregate (docs/modules.md, "Team aggregates"), checked so no reader can single out one doc: a reported
   * collection with an owner, not a set; counts, sums and averages only; a value from the call's arguments only tested
   * with `eq`, and every aggregate over the collection with the same filter, so two reads never differ by a few docs.
   */
  const aggregateOk = (a: AggregateRead, at: string, expr: (x: CallExpr, where: string) => void) => {
    const c = m.collections[a.collection];
    if (!c) return void e.push(`${at}.collection names ${a.collection}, which is not a collection`);
    if (!c.report) e.push(`${at}.collection names ${a.collection}, which declares no report: Canon aggregates a reported collection`);
    if (!c.owner) e.push(`${at}.collection names ${a.collection}, which has no owner: an aggregate counts the people its docs belong to`);
    if (c.setOf) e.push(`${at}.collection names ${a.collection}, a set: aggregate its parent's collection`);
    a.values.forEach((v, j) => {
      if (v.fn === "count") { if (v.field !== undefined) e.push(`${at}.values[${j}]: a count takes no field`); return; }
      if (!v.field || !c.report?.measures?.includes(v.field)) e.push(`${at}.values[${j}] ${v.fn}s ${v.field}, which is not a measure of ${a.collection}`);
    });
    a.filter?.forEach((f, i) => {
      const fat = `${at}.filter[${i}]`;
      if (c.report && !c.report.dimensions.includes(f.field) && f.field !== "createdAt" && f.field !== "updatedAt") e.push(`${fat} names ${f.field}, which is not a dimension of ${a.collection}`);
      if (f.field.includes(".")) e.push(`${fat} names ${f.field}: an aggregate filters by the doc's own fields`);
      if ((f.op === "empty" || f.op === "notEmpty") !== (f.value === undefined)) e.push(`${fat}.value ${f.value === undefined ? "is missing" : `is not for ${f.op}`}`);
      if (f.value === undefined) return;
      expr(f.value, `${fat}.value`);
      const inner = unwrapDate(f.value);
      if (inner !== null && typeof inner === "object" && ("read" in inner || "caller" in inner || isClock(inner))) e.push(`${fat}.value: an aggregate's filter takes constants and the call's arguments, not ${"read" in inner ? "a read" : "caller" in inner ? "the caller" : "the clock"}`);
      // Two arguments tested with eq read disjoint sets; with a range, one set could hold the other plus one doc.
      if (fromArgs(f.value) && f.op !== "eq") e.push(`${fat}: a value from the call's arguments is tested with eq, never ${f.op}: two reads must never differ by a few docs`);
    });
    const base = JSON.stringify((a.filter ?? []).map((f) => ({ field: f.field, op: f.op, value: f.value !== undefined && fromArgs(f.value) ? "{arg}" : f.value ?? null })));
    const first = aggregateBases.get(a.collection);
    if (!first) aggregateBases.set(a.collection, { base, at });
    else if (first.base !== base) e.push(`${at}.filter differs from ${first.at}'s: every aggregate over ${a.collection} filters the same way, so no two differ by a few docs`);
  };
  for (const [name, call] of calls) {
    const at = `calls.${name}`;
    if (call.canon) e.push(...canonCallProblems(m, name, call));
    if (call.canon && (call.agent !== "human" || call.system || call.ai || call.step || call.proposal || Object.keys(call.reads).length || (!call.canon.then && call.writes.length) || implicitArgs(m, name))) e.push(`${at}.canon is a human-only write with no reads, module writes, AI, proposals or background execution`);
    if (call.step) { e.push(...stepProblems(m, name, call)); if (implicitArgs(m, name)) e.push(`${at}.step cannot run as a job, watch, feed or schedule`); }
    if (call.ai) e.push(...aiProblems(m, name, call as CallDecl & { ai: AiDecl }));
    else if (Object.values(m.machines ?? {}).some((mc) => Object.values(mc.transitions).some((t) => t.ai === name))) e.push(`${at}: a transition starts it (its "ai"), so it is a hosted AI step: give it "ai"`);
    const implicit = implicitArgs(m, name);
    if (implicit && call.args) e.push(`${at}.args: ${name} is run by Canon (${implicit.by}), which gives it its arguments`);
    if ((call.agent === "human") !== (call.reason !== undefined)) e.push(call.agent === "human" ? `${at}.reason is missing: say why an agent can't run it` : `${at}.reason is only for agent "human"`);
    if (call.proposal && call.agent !== "propose") e.push(`${at}.proposal is only for agent "propose"`);
    if (call.agent === "propose" && (call.system || !call.writes.length)) e.push(`${at}.agent is "propose", which is for a call a person runs that writes`);
    if (Boolean(call.system) === Boolean(call.roles.length)) e.push(call.system ? `${at}.roles must be empty: only Canon runs a system call` : `${at}.roles is empty: name a role, or make it a system call`);
    if (call.args && call.args.type !== "object") e.push(`${at}.args must be an object validator`);
    const args: Record<string, unknown> = implicit?.args ?? (call.args?.type === "object" ? call.args.value : {});
    const expr = (x: CallExpr, where: string): void => {
      if (x !== null && typeof x === "object" && "arg" in x && !Object.hasOwn(args, x.arg)) e.push(`${where} names argument ${x.arg}, which ${name} doesn't take`);
      if (x !== null && typeof x === "object" && "toMs" in x) expr(x.toMs, `${where}.toMs`);
      if (x !== null && typeof x === "object" && "toDate" in x) expr(x.toDate, `${where}.toDate`);
      if (x !== null && typeof x === "object" && "fiscalYearStart" in x) expr(x.fiscalYearStart, `${where}.fiscalYearStart`);
    };
    const earlier = new Map<string, ReadDecl>();
    /** The fields a `{ read, field }` may name in the read `r`: a module doc's metadata and data, a Canon record's id and grants. */
    const readFields = (r: ReadDecl): readonly string[] => {
      if ("report" in r || "aggregate" in r) return [];
      if ("canon" in r && r.canon === "suppression.check") return ["id", "createdAt", "email", "linkedin", "voice"];
      if ("canon" in r) return ["id", "createdAt", ...(m.reads?.[CANON_READS[r.canon].object] ?? [])];
      // Another module's fields aren't known here: the provider's manifest names them, and the read checks them when it runs.
      if ("module" in r || "tree" in r || "icpTree" in r) return [];
      const c = m.collections[m.views[r.view]?.collection];
      return c ? ["key", "owner", ...(c.setOf ? ["parentKey"] : []), ...Object.keys(c.schema.value)] : [];
    };
    for (const [key, r] of Object.entries(call.reads)) {
      const rat = `${at}.reads.${key}`;
      if ("report" in r) {
        if (call.system) e.push(`${rat}: a report reads as a person, so a system call can't read one`);
        reportShapeOk(m, r.report, rat + ".report", e);
        const c = m.collections[r.report.collection];
        const record = recordObjectOf(m, r.report.collection) !== null;
        const canonDims = isCanonSource(r.report.collection) || record ? sourceFields(m, r.report.collection)?.map((f) => f.name) ?? null : null;
        r.report.filter?.forEach((f, i) => {
          if ((canonDims ?? c?.report?.dimensions) && !(canonDims ?? c!.report!.dimensions).includes(f.field) && f.field !== "createdAt" && f.field !== "updatedAt") e.push(`${rat}.report.filter[${i}] names ${f.field}, which is not a dimension of ${r.report.collection}`);
          if (f.field.includes(".") && !record) e.push(`${rat}.report.filter[${i}] names ${f.field}: a report filters by the doc's own fields`);
          if ((f.op === "empty" || f.op === "notEmpty") !== (f.value === undefined)) e.push(`${rat}.report.filter[${i}].value ${f.value === undefined ? "is missing" : `is not for ${f.op}`}`);
          if (f.value !== undefined) expr(f.value, `${rat}.report.filter[${i}].value`);
          const inner = f.value === undefined ? null : unwrapDate(f.value);
          if (inner !== null && typeof inner === "object" && "read" in inner) e.push(`${rat}.report.filter[${i}].value: a report's filter takes the call's values, not a read's`);
        });
        earlier.set(key, r);
        continue;
      }
      if ("aggregate" in r) {
        aggregateOk(r.aggregate, `${rat}.aggregate`, (x, where) => expr(x, where));
        earlier.set(key, r);
        continue;
      }
      if ("icpTree" in r) {
        for (const part of ["icps", "nodes"] as const) {
          const from = earlier.get(r.icpTree[part]);
          const view = from && "view" in from ? m.views[from.view] : null;
          const schema = view && m.collections[view.collection]?.schema;
          if (!view || view.kind !== "list" || !schema || !icpTreeSchemaFits(schema, ICP_TREE_FIELDS[part])) e.push(`${rat}.icpTree.${part} needs an earlier own-doc list read with the typed ${part} fields`);
        }
        if (!m.reads?.companies || !m.reads?.people?.includes("title")) e.push(`${rat}.icpTree needs reads.companies and reads.people title`);
        if (r.icpTree.market && !m.reads?.market?.includes("facets")) e.push(`${rat}.icpTree.market needs reads.market to grant facets`);
        earlier.set(key, r);
        continue;
      }
      if ("tree" in r) {
        const t = r.tree;
        const fieldsOf = (read: string, at: string, fields: ReadonlyArray<string | undefined>) => {
          const from = earlier.get(read);
          if (!from || !("view" in from) || m.views[from.view]?.kind !== "list") return void e.push(`${rat}.tree.${at} names ${read}, which is not an earlier read of a list view`);
          const c = m.collections[m.views[from.view].collection];
          for (const f of fields) if (f !== undefined && f !== "key" && !Object.hasOwn(c?.schema.value ?? {}, f)) e.push(`${rat}.tree names ${f}, which ${m.views[from.view].collection} doesn't have`);
        };
        fieldsOf(t.nodes, "nodes", [t.query, t.parent, t.order]);
        if (t.named) fieldsOf(t.named.read, "named.read", [t.named.node, t.named.company]);
        if (!m.reads?.companies) e.push(`${rat}.tree reads companies, which reads.companies doesn't grant`);
        if ((t.owners || t.cells) && !m.reads?.companies?.includes("ownerId")) e.push(`${rat}.tree names owners, which reads.companies doesn't grant (ownerId)`);
        if (t.market && !m.reads?.market?.includes("facets")) e.push(`${rat}.tree.market needs reads.market to grant facets`);
        if (t.deals && !["amount", "isClosed", "isWon", "closedAt", "companyId"].every((f) => m.reads?.deals?.includes(f as never))) e.push(`${rat}.tree.deals needs reads.deals amount, isClosed, isWon, closedAt and companyId`);
        if (t.cells) expr(t.cells.node, `${rat}.tree.cells.node`);
        if (t.place !== undefined) expr(t.place, `${rat}.tree.place`);
        earlier.set(key, r);
        continue;
      }
      if ("module" in r) {
        if (!(m.uses?.[r.module] ?? []).includes(r.provide)) e.push(`${rat} reads ${r.module}'s ${r.provide}, which uses doesn't name`);
        for (const [k, x] of Object.entries(r.args ?? {})) expr(x, `${rat}.args.${k}`);
        earlier.set(key, r);
        continue;
      }
      if ("view" in r && !m.views[r.view]) { e.push(`${rat}.view names ${r.view}, which is not a view`); continue; }
      const types: Record<string, ArgType> = "view" in r ? (m.views[r.view].args ?? {}) : CANON_READS[r.canon].args;
      const declared = Object.keys(types);
      if ("view" in r && m.views[r.view].kind === "one" && r.limit !== undefined) e.push(`${rat}.limit is only for a list view`);
      if ("canon" in r) {
        const object = CANON_READS[r.canon].object;
        if (r.canon === "match.inbound" && !call.system) e.push(`${rat}.canon match.inbound runs only in a system call`);
        if ((object === "me" || object === "social" || object === "web" || object === "signup" || object === "plan" || r.canon === "market.sample" || r.canon === "deals.latestClosed" || r.canon === "companies.bestFit") && call.system) e.push(`${rat}.canon requires a member`);
        if (object === "me" && !["profile", "posts", "counterparts"].every((f) => m.reads?.me?.includes(f))) e.push(`${rat}.canon needs all reads.me grants`);
        if (object === "social" && !m.reads?.social?.includes("search")) e.push(`${rat}.canon needs reads.social search`);
        if (object === "web" && !(m.reads?.web?.includes("url") && m.reads.web.includes("text"))) e.push(`${rat}.canon needs reads.web url and text`);
        if (r.canon === "web.search" && !m.reads?.web?.includes("search")) e.push(`${rat}.canon needs reads.web search`);
        if (object === "senders" && call.system) e.push(`${rat}.canon reads as a caller, so a system call cannot read senders`);
        if (!m.reads?.[object]) e.push(`${rat}.canon reads ${object}, which reads.${object} doesn't grant`);
        if (r.custom && (object !== "deals" || r.canon === "deals.asOf" || r.canon === "deals.changesBetween")) e.push(`${rat}.custom: only a flat read of deals carries their custom fields`);
        else if (r.custom && !m.reads?.deals?.includes("custom")) e.push(`${rat}.custom needs reads.deals to grant custom`);
        if (r.custom && r.limit !== undefined && r.limit > 500) e.push(`${rat}.limit: a read with custom fields reads at most 500 deals`);
        if (r.canon === "suppression.check" && !m.reads?.people?.includes("suppression")) e.push(`${rat}.canon needs reads.people to grant suppression`);
        if (r.canon === "suppression.check" && call.system) e.push(`${rat}.canon reads as a caller, so a system call can't read suppression.check`);
        if (r.canon === "people.snapshot" || r.canon === "people.count") {
          const named = (k: string) => { const x = r.args?.[k]; return typeof x === "string" ? x : null; };
          const from = named("module"), provide = named("provide");
          if (!provide || (r.args?.module !== undefined && !from)) e.push(`${rat}: ${r.canon} names its module and provide as text, not values`);
          else if (from ? !(m.uses?.[from] ?? []).includes(provide) : !m.provides?.[provide]?.people) e.push(`${rat} reads the people of ${from ? `${from}'s` : "this module's"} ${provide}, which ${from ? "uses doesn't name" : "doesn't name people"}`);
        }
        if (r.canon === "calls.transcript") {
          if (!m.reads?.calls?.includes("transcript")) e.push(`${rat}.canon reads a call's transcript, which reads.calls doesn't grant (transcript)`);
          if (Object.values(call.reads).filter((x) => "canon" in x && x.canon === "calls.transcript").length > 1 && Object.keys(call.reads).find((k) => { const x = call.reads[k]; return "canon" in x && x.canon === "calls.transcript"; }) !== key) e.push(`${rat}: a plan reads one call's transcript, at most`);
        }
      }
      for (const [k, x] of Object.entries(r.args ?? {})) {
        const where = `${rat}.args.${k}`;
        if (!declared.includes(k)) { e.push(`${where} is not an argument of ${"view" in r ? r.view : r.canon}`); continue; }
        expr(x, where);
        const dated = isDated(x) || isClock(x) || (x !== null && typeof x === "object" && "workspace" in x);
        if (dated && isListArg(types[k])) e.push(`${where} takes a list: a date conversion gives one value`);
        const inner = unwrapDate(x);
        const isRead = inner !== null && typeof inner === "object" && "read" in inner;
        if (isListArg(types[k]) && !(isRead || (x !== null && typeof x === "object" && "arg" in x))) e.push(`${where} takes a list: give it { arg } or { read }`);
        if (isRead && inner !== null && typeof inner === "object" && "read" in inner) {
          const x = inner;
          const from = earlier.get(x.read);
          // One value comes from an earlier read of one doc: a field of it (a period's start, its previous period).
          const one = from !== undefined && "view" in from && m.views[from.view]?.kind === "one";
          if (!from) e.push(`${where} names ${x.read}, which is not an earlier read of ${name}`);
          else if ("report" in from || "aggregate" in from) e.push(`${where} names ${x.read}, ${"report" in from ? "a report" : "an aggregate"}: a read takes its values from docs or records`);
          else if ("canon" in from && (isRecordServiceRead(from.canon) || from.canon === "research.answers" || from.canon === "me.context" || from.canon === "social.search" || from.canon === "web.pages" || from.canon === "web.search" || from.canon === "market.facets" || from.canon === "market.sample")) e.push(`${where} names ${x.read}, which Canon reads from the record service after the plan: a read takes its values from deals, members, teams or module docs`);
          else if ("icpTree" in from) e.push(`${where} names an ICP tree counted after the read plan`);
          else if (x.field !== undefined && !("module" in from) && !("tree" in from) && !readFields(from).includes(x.field)) e.push(`${where}.field names ${x.field}, which ${x.read} doesn't read`);
          if (from && !isListArg(types[k]) && !one) e.push(`${where} takes one value: an earlier read gives one only when it reads one doc`);
        }
      }
      const optional: readonly string[] = "canon" in r ? ((CANON_READS[r.canon] as { optional?: readonly string[] }).optional ?? []) : [];
      for (const k of declared) if (!Object.hasOwn(r.args ?? {}, k) && !optional.includes(k)) e.push(`${rat}.args.${k} is missing`);
      earlier.set(key, r);
    }
    if (call.result) {
      if (call.result.kind === "table" && (call.result.hierarchy || call.result.columns.some((c) => c.edit || c.definition))) e.push(`${at}.result editing is declared on a page table`);
      if (call.returns !== "value") e.push(`${at}.result needs returns "value": the page shows the value the call returns`);
      const texts = call.result.kind === "table" ? call.result.columns.map((c, i) => [c.value, `${at}.result.columns[${i}].value`, "row"] as const)
        : call.result.kind === "kpis" ? call.result.items.flatMap((x, i) => ([["value", x.value], ["tone.by", x.tone?.by], ["trend", x.trend], ["hint", x.hint]] as const).flatMap(([k, t]) => (t === undefined ? [] : [[t, `${at}.result.items[${i}].${k}`, "result"] as const]))) : [];
      for (const [t, where, own] of texts) {
        for (const [, b, , fmt] of t.matchAll(PLACEHOLDER)) {
          if (b !== own) e.push(`${where} names $${b}; here it names $${own}`);
          if (fmt && !(FORMATS as readonly string[]).includes(fmt)) e.push(`${where} formats with ${fmt}, not one of ${FORMATS.join(", ")}`);
        }
      }
    }
    call.writes.forEach((c, i) => {
      if (!m.collections[c]) e.push(`${at}.writes[${i}] names ${c}, which is not a collection`);
      if (call.writes.indexOf(c) !== i) e.push(`${at}.writes[${i}] names ${c} twice`);
    });
  }
}

/**
 * The arguments Canon gives a call it runs for a job, a watch or a schedule, or null for a call people run. A job's
 * call gets `keys` and each key part: one value for the parts its batch shares, a list for the rest. A watch's gets
 * `changes`; a feed's `items`; a schedule's nothing.
 */
export function implicitArgs(m: Pick<ModuleManifest, "jobs" | "watches" | "feeds" | "schedules">, call: string): { by: string; args: Record<string, ArgType | "changes" | "items"> } | null {
  for (const [name, j] of Object.entries(m.jobs ?? {})) {
    if (j.call !== call) continue;
    const by = j.batchBy ?? 0;
    return { by: `job ${name}`, args: { keys: "string[]", ...Object.fromEntries(j.key.map((p, i) => [p, i < by ? "string" : "string[]"])) } };
  }
  if (m.watches?.some((w) => w.call === call)) return { by: "a watch", args: { changes: "changes" } };
  for (const [name, f] of Object.entries(m.feeds ?? {})) if (f.call === call) return { by: `feed ${name}`, args: { items: "items" } };
  for (const [name, sc] of Object.entries(m.schedules ?? {})) if (sc.call === call) return { by: `schedule ${name}`, args: {} };
  return null;
}

/** Jobs, watches and schedules: each runs a system call of its own, and a watch reads only granted deal fields. */
function jobChecks(m: ModuleManifest, e: string[]) {
  const users = new Map<string, string>();
  const callFor = (call: string, at: string) => {
    const c = m.calls?.[call];
    if (!c) return void e.push(`${at}.call names ${call}, which is not a call`);
    if (!c.system) e.push(`${at}.call names ${call}, which must be a system call: Canon runs it`);
    if (users.has(call)) e.push(`${at}.call names ${call}, which ${users.get(call)} runs already`);
    users.set(call, at);
  };
  for (const [name, j] of Object.entries(m.jobs ?? {})) {
    const at = `jobs.${name}`;
    callFor(j.call, at);
    j.key.forEach((p, i) => { if (j.key.indexOf(p) !== i) e.push(`${at}.key[${i}] names ${p} twice`); if (p === "keys") e.push(`${at}.key[${i}] can't be named keys`); });
    if ((j.batchBy ?? 0) > j.key.length) e.push(`${at}.batchBy is more than the key's ${j.key.length} parts`);
    if (j.order !== undefined && !j.key.includes(j.order)) e.push(`${at}.order names ${j.order}, which is not a part of the key`);
    if (j.orderBy) {
      const c = m.collections[j.orderBy.collection];
      if (j.order === undefined) e.push(`${at}.orderBy needs order: the key part whose doc it reads`);
      if (!c) e.push(`${at}.orderBy.collection names ${j.orderBy.collection}, which is not a collection`);
      else if (!c.schema.value[j.orderBy.field] || !isScalar(c.schema.value[j.orderBy.field].fieldType)) e.push(`${at}.orderBy.field names ${j.orderBy.field}, which isn't one text or number field of ${j.orderBy.collection}`);
    }
  }
  (m.watches ?? []).forEach((w, i) => {
    const at = `watches[${i}]`;
    callFor(w.call, at);
    const watchable: readonly string[] = WATCHED_FIELDS[w.object];
    w.fields.forEach((f, k) => {
      if (!watchable.includes(f)) e.push(`${at}.fields[${k}] names ${f}, which a watch on ${w.object} can't watch`);
      else if (!(m.reads?.[w.object] as readonly string[] | undefined)?.includes(f)) e.push(`${at}.fields[${k}] names ${f}, which reads.${w.object} doesn't grant`);
    });
  });
  for (const [name, sc] of Object.entries(m.schedules ?? {})) {
    callFor(sc.call, `schedules.${name}`);
    if ((sc.everyMinutes === undefined) === (sc.dailyAt === undefined)) e.push(`schedules.${name} needs everyMinutes or dailyAt, one of them`);
  }
  for (const [name, f] of Object.entries(m.feeds ?? {})) callFor(f.call, `feeds.${name}`);
  if (m.upgrade) {
    const j = m.jobs?.[m.upgrade.job];
    if (!j) e.push(`upgrade.job names ${m.upgrade.job}, which is not a job`);
    else {
      const problem = jobKeyProblem(upgradeKey(m), j.key.length);
      if (problem) e.push(`upgrade.key: ${problem}`);
    }
  }
}

function shareChecks(m: ModuleManifest, e: string[]) {
  const sharedUses = new Set<object>();
  const owned = roomRecordCollections(m);
  const writable = (collection: string, at: string) => { if (owned.has(collection)) e.push(`${at} cannot write Canon visitor records`); };
  Object.entries(m.ops).forEach(([n, op]) => writable(op.collection, `ops.${n}.collection`));
  Object.entries(m.calls ?? {}).forEach(([n, call]) => call.writes.forEach((c) => writable(c, `calls.${n}.writes`)));
  Object.entries(m.machines ?? {}).forEach(([n, mc]) => {
    writable(mc.collection, `machines.${n}.collection`);
    Object.entries(mc.transitions).forEach(([t, move]) => move.effects?.forEach((fx, i) => {
      if ("create" in fx) writable(fx.create, `machines.${n}.transitions.${t}.effects[${i}]`);
      if ("copy" in fx) {
        writable(fx.copy, `machines.${n}.transitions.${t}.effects[${i}]`);
        fx.related?.forEach((r) => writable(r.collection, `machines.${n}.transitions.${t}.effects[${i}].related`));
      }
    }));
  });
  const schemaWalk = (v: ValidatorJSON, at: string, visit: (v: ValidatorJSON, at: string) => void): void => {
    visit(v, at);
    if (v.type === "array") schemaWalk(v.value, `${at}.value`, visit);
    if (v.type === "union") v.value.forEach((x, i) => schemaWalk(x, `${at}.value[${i}]`, visit));
    if (v.type === "object") Object.entries(v.value).forEach(([f, sp]) => schemaWalk(sp.fieldType, `${at}.${f}`, visit));
    if (v.type === "record") { schemaWalk(v.keys, `${at}.keys`, visit); schemaWalk(v.values.fieldType, `${at}.values`, visit); }
    if (v.type === "variant") Object.entries(v.cases).forEach(([f, x]) => schemaWalk(x, `${at}.${f}`, visit));
  };
  const textLimit = (v: ValidatorJSON, at: string, share?: ShareDecl) => schemaWalk(v, at, (x, p) => {
    if (x.type === "string" && (x.maxLength === undefined || x.maxLength > 5000)) e.push(`${p}.maxLength must be at most 5000 for visitor text`);
    if (x.type === "any") e.push(`${p} cannot accept arbitrary visitor data`);
    if (x.type === "ref" && !(share && x === coreOf(v) && x.to === "doc" && !!x.collection && share.read[x.collection] && (x.collection === share.collection || m.collections[x.collection]?.setOf?.parent === share.collection))) e.push(`${p} cannot ask a visitor to pick a ref`);
  });
  const capabilityProblems = (d: { capability?: Capability; system?: true; roles: readonly WriteRole[]; share?: string }, at: string) => {
    if (d.capability && (d.system || d.share || d.roles.length !== ROLES.length || ROLES.some((r) => !d.roles.includes(r)))) e.push(`${at}.capability requires every built-in member role, no share and no system authority`);
  };
  for (const [name, call] of Object.entries(m.calls ?? {})) capabilityProblems(call, `calls.${name}`);
  const declaredWrite = (d: OpDecl | TransitionDecl, name: string, at: string, kind: "ops" | "transitions") => {
    capabilityProblems(d, at);
    const usesVisitor = (x: unknown): boolean => x !== null && typeof x === "object" && (Array.isArray(x) ? x.some(usesVisitor) : "visitor" in x || Object.values(x).some(usesVisitor));
    if (d.roles.includes("visitor") || d.share !== undefined || usesVisitor(d.set) || usesVisitor(d.guards) || usesVisitor(d.effects)) {
      if (!d.share || !m.shares?.[d.share]?.write[kind].includes(name)) e.push(`${at}.share must name a share declaring this visitor write`);
    }
  };
  Object.entries(m.ops).forEach(([name, op]) => declaredWrite(op, name, `ops.${name}`, "ops"));
  Object.entries(m.machines ?? {}).forEach(([machine, mc]) => Object.entries(mc.transitions).forEach(([name, t]) => declaredWrite(t, `${machine}.${name}`, `machines.${machine}.transitions.${name}`, "transitions")));
  for (const [name, s] of Object.entries(m.shares ?? {})) {
    const at = `shares.${name}`;
    const root = m.collections[s.collection];
    if (!root) e.push(`${at}.collection names ${s.collection}, which is not a collection`);
    if (root && s.signals) {
      try { roomSource(m, s, {}); } catch { e.push(`${at}.signals requires at most one direct deal and company ref`); }
    }
    if (s.record) {
      const c = m.collections[s.record.collection], p = `${at}.record.collection`;
      if (!c || c.setOf?.parent !== s.collection || c.key !== "auto" || c.owner || c.integrity || c.report || c.activity) e.push(`${p} must name an unsealed one-level Canon record set with auto keys`);
      const fields = c?.schema.value ?? {};
      if (Object.keys(fields).length !== Object.keys(roomRecordFields).length || Object.entries(roomRecordFields).some(([f, spec]) => fields[f]?.fieldType.type !== spec.type || Object.keys(fields[f]?.fieldType ?? {}).length !== 1 || fields[f]?.optional !== spec.optional)) e.push(`${p} must use the fixed daily visitor record schema`);
      if (s.read[s.record.collection] || Object.values(m.shares ?? {}).some((other) => other.read[s.record!.collection])) e.push(`${p} cannot be shared with visitors`);
      if (Object.values(m.collections).some((c) => c.integrity?.children?.[s.record!.collection])) e.push(`${p} cannot be part of an integrity seal`);
    }
    if (!s.read[s.collection]) e.push(`${at}.read must include the root collection ${s.collection}`);
    if (!s.identity.allow.includes(s.identity.default)) e.push(`${at}.identity.default must be in allow`);
    if (s.identity.domains?.some((domain) => !visitorDomain(domain))) e.push(`${at}.identity.domains must contain exact email domains without wildcards`);
    if (s.expiresDays.default > s.expiresDays.max) e.push(`${at}.expiresDays.default must be at most max`);
    const where = (c: string, w: ShareWhere | undefined, p: string): void => {
      if (!w) return;
      if ("all" in w) return w.all.forEach((x, i) => where(c, x, `${p}.all[${i}]`));
      const spec = m.collections[c]?.schema.value[w.field];
      if (!spec || !isScalar(spec.fieldType)) e.push(`${p}.field must name a scalar field of ${c}`);
    };
    where(s.collection, s.when, `${at}.when`);
    for (const [c, r] of Object.entries(s.read)) {
      const decl = m.collections[c];
      if (!decl || (c !== s.collection && decl.setOf?.parent !== s.collection)) e.push(`${at}.read.${c} must be the root or a one-level set of ${s.collection}`);
      r.fields.forEach((f, i) => {
        const spec = decl?.schema.value[f];
        if (!spec) return void e.push(`${at}.read.${c}.fields[${i}] names ${f}, which is not a field of ${c}`);
        schemaWalk(spec.fieldType, `${at}.read.${c}.${f}`, (x, p) => {
          if (x.type === "ref" && !(x.to === "users" && s.members.length || x === coreOf(spec.fieldType) && x.to === "doc" && !!x.collection && s.read[x.collection] && (x.collection === s.collection || m.collections[x.collection]?.setOf?.parent === s.collection))) e.push(`${p} is a ref outside the declared members`);
          if (x.type === "any") e.push(`${p} cannot expose arbitrary data`);
        });
      });
      where(c, r.where, `${at}.read.${c}.where`);
    }
    const move = (d: OpDecl | TransitionDecl, c: string, p: string) => {
      if (d.share !== name || !d.roles.includes("visitor")) e.push(`${p} must name share ${name} and role visitor`);
      if (!s.read[c]) e.push(`${p} writes outside the share's read tree`);
      if (d.system || ("ai" in d && d.ai) || ("run" in d && d.run) || ("at" in d && d.at) || ("seal" in d && d.seal)) e.push(`${p} cannot be system or bulk`);
      if (d.dirties !== undefined) e.push(`${p}.dirties cannot start visitor system work`);
      d.effects?.forEach((fx, i) => { if (!("notify" in fx)) e.push(`${p}.effects[${i}] may only notify`); });
      for (const f of "fields" in d ? d.fields ?? [] : []) {
        const spec = m.collections[c]?.schema.value[f];
        if (spec) {
          textLimit(spec.fieldType, `${p}.fields.${f}`, s);
          schemaWalk(spec.fieldType, `${p}.fields.${f}`, (x, at) => { if (x.type === "file" && coreOf(spec.fieldType).type !== "file") e.push(`${at} visitor uploads require a top-level file field`); });
        }
      }
      if ("args" in d && d.args) {
        for (const [f, spec] of Object.entries(d.args.value)) textLimit(spec.fieldType, `${p}.args.${f}`, s);
        for (const [f, spec] of Object.entries(d.args.value)) schemaWalk(spec.fieldType, `${p}.args.${f}`, (x, at) => { if (x.type === "file" && coreOf(spec.fieldType).type !== "file") e.push(`${at} visitor uploads require a top-level file argument`); });
      }
      for (const [f, value] of Object.entries(d.set ?? {})) {
        const spec = m.collections[c]?.schema.value[f];
        if (spec && !isUnset(value)) {
          textLimit(spec.fieldType, `${p}.set.${f}`, s);
        }
      }
      const projected = (f: string, path: string, scalar = false) => {
        const specs = root ? specsAt(root.schema, f) : [];
        if (!s.read[s.collection]?.fields.includes(f.split(".")[0]) || !specs.length || scalar && specs.some((sp) => !isScalar(sp.fieldType))) e.push(`${path} must name a projected root field`);
      };
      const comparison = (x: unknown, path: string): void => {
        if (!isRecord(x)) return void e.push(`${path} must be a projected comparison`);
        if (Array.isArray(x.all) || Array.isArray(x.any)) return ((x.all ?? x.any) as unknown[]).forEach((q, i) => comparison(q, `${path}[${i}]`));
        if (x.not) return comparison(x.not, `${path}.not`);
        if (typeof x.field !== "string" || !["eq", "ne", "gte", "lte", "in"].some((k) => k in x)) return void e.push(`${path} must be a projected scalar comparison`);
        projected(x.field, path, true);
      };
      const scan = (x: unknown, path: string, sharedSubject = false): void => {
        if (!x || typeof x !== "object") return;
        if (Array.isArray(x)) return x.forEach((v, i) => scan(v, `${path}[${i}]`, sharedSubject));
        const v = x as Record<string, unknown>;
        if ("shared" in v) {
          sharedUses.add(v);
          if (d.roles.some((r) => r !== "visitor")) e.push(`${path} shared values require an exclusively visitor declaration`);
          const sh = v.shared as { from: string; field?: string };
          if (sh.from === "parent" && c === s.collection) e.push(`${path} root has no shared parent`);
          if (sh.field) projected(sh.field, path);
          else comparison(v.where, `${path}.where`);
        }
        for (const k of ["doc", "copy", "increment", "field", "length"] as const) if (typeof v[k] === "string" && !(k === "field" && "shared" in v)) {
          const f = v[k] as string;
          if (sharedSubject) projected(f, `${path}.${k}`);
          else if (!["key", "parentKey"].includes(f) && !s.read[c]?.fields.includes(f.split(".")[0])) e.push(`${path}.${k} must name a projected field`);
        }
        if ("lookup" in v || "count" in v || "ref" in v || "fresh" in v || "workspace" in v || "fiscalYearStart" in v || "intact" in v || "created" in v) e.push(`${path} cannot read through a member view or start system work`);
        if ("evidence" in v) e.push(`${path} cannot copy visitor evidence into document fields`);
        if (v.visitor === "email" || v.visitor === "name") {
          const requiresVerified = (p: Predicate): boolean => "all" in p ? p.all.some(requiresVerified) : "truthy" in p && typeof p.truthy === "object" && p.truthy !== null && "visitor" in p.truthy && p.truthy.visitor === "verified";
          const verified = (d.guards ?? []).some((g) => requiresVerified(g.when));
          if (!verified) e.push(`${path} requires a verified visitor guard`);
        }
        Object.entries(v).forEach(([k, value]) => { if (k !== "shared") scan(value, `${path}.${k}`, sharedSubject || "shared" in v && k === "where"); });
      };
      const sharedNotify = d.effects?.some((fx) => "notify" in fx && fx.notify.some((r) => isRecord(r) && "shared" in r));
      d.effects?.forEach((fx, i) => {
        if (!("notify" in fx)) return;
        if (sharedNotify && fx.notify.some((r) => !isRecord(r) || !("shared" in r))) e.push(`${p}.effects[${i}].notify cannot mix shared-root recipients with legacy recipients`);
        for (const r of fx.notify) if (isRecord(r) && "shared" in r) {
          const sh = r.shared as { from: string; field: string }, spec = root?.schema.value[sh.field], type = spec && coreOf(spec.fieldType);
          if (sh.from !== "root" || sh.field.includes(".") || !s.read[s.collection]?.fields.includes(sh.field) || type?.type !== "ref" || type.to !== "users") e.push(`${p}.effects[${i}].notify must name a projected root member`);
        }
      });
      scan(d.guards, `${p}.guards`); scan(d.set, `${p}.set`); scan(d.effects, `${p}.effects`); if ("to" in d) scan(d.to, `${p}.to`);
    };
    s.write.ops.forEach((n, i) => {
      const p = `${at}.write.ops[${i}]`, d = m.ops[n];
      if (!d) return void e.push(`${p} names ${n}, which is not an op`);
      if (d.kind === "delete" || (d.kind === "create" && m.collections[d.collection]?.setOf?.parent !== s.collection)) e.push(`${p} must create in a read set or update in the tree`);
      move(d, d.collection, p);
    });
    s.write.transitions.forEach((n, i) => {
      const [mc, t] = n.split("."), machine = m.machines?.[mc], d = machine?.transitions[t];
      const p = `${at}.write.transitions[${i}]`;
      if (n.split(".").length !== 2 || !d) return void e.push(`${p} names ${n}, which is not a transition`);
      move(d, machine!.collection, p);
    });
    const paths = new Set<string>();
    s.pages.forEach((p, i) => {
      const pat = `${at}.pages[${i}]`;
      if (!segmentsOf(p.path).every((x) => SEGMENT.test(x)) || paths.has(p.path)) e.push(`${pat}.path must be a unique page path`);
      paths.add(p.path);
      for (const [b, v] of Object.entries(p.bind ?? {})) {
        if ("rootList" in v) {
          const sp = root?.schema.value[v.rootList], t = sp && coreOf(sp.fieldType);
          if (!s.read[s.collection]?.fields.includes(v.rootList) || t?.type !== "array" || t.value.type !== "object") e.push(`${pat}.bind.${b}.rootList must name a projected object array`);
        }
        if ("set" in v) {
          for (const route of [v.key?.route, v.where?.eq.route]) if (route && !p.path.split("/").includes(`:${route}`)) e.push(`${pat}.bind.${b} requires a declared route parameter`);
          if (v.where) {
            const sp = m.collections[v.set]?.schema.value[v.where.field], t = sp && coreOf(sp.fieldType);
            if (!s.read[v.set]?.fields.includes(v.where.field) || t?.type !== "ref" || t.to !== "doc" || !t.collection || !s.read[t.collection]) e.push(`${pat}.bind.${b}.where requires a projected same-share doc ref`);
          }
        }
        if ("set" in v && (v.set === s.collection || !s.read[v.set])) e.push(`${pat}.bind.${b}.set must name a read set collection`);
      }
      const bindingCollection = (b: string) => {
        const v = p.bind?.[b];
        return v ? "root" in v ? s.collection : "rootList" in v ? `${s.collection}.${v.rootList}` : v.set : undefined;
      };
      const field = (c: string | undefined, f: string, path: string, scalar = false) => {
        if (c?.startsWith(`${s.collection}.`)) {
          const list = c.slice(s.collection.length + 1), sp = root?.schema.value[list], t = sp && coreOf(sp.fieldType);
          if (!s.read[s.collection]?.fields.includes(list) || t?.type !== "array" || t.value.type !== "object" || !specsAt(t.value, f).length || scalar && specsAt(t.value, f).some((sp) => !isScalar(sp.fieldType))) e.push(`${path} must read a projected list field`);
        } else if (!c || !s.read[c]?.fields.includes(f.split(".")[0]) || !m.collections[c] || !specsAt(m.collections[c].schema, f).length) e.push(`${path} must read a projected field`);
        if (scalar && c && !c.includes(".") && m.collections[c] && specsAt(m.collections[c].schema, f).some((sp) => !isScalar(sp.fieldType))) e.push(`${path} must read a projected scalar`);
      };
      const walk = (x: unknown, path: string, rowCollection?: string): void => {
        if (typeof x === "string") {
          for (const [, b, f] of x.matchAll(PLACEHOLDER)) {
            if (b === "row") field(rowCollection, f, path);
            else if (f === "count" && p.bind?.[b] && "set" in p.bind[b]) continue;
            else field(bindingCollection(b), f, path);
          }
          return;
        }
        if (!x || typeof x !== "object") return;
        if (Array.isArray(x)) return x.forEach((v, i) => walk(v, `${path}[${i}]`, rowCollection));
        const v = x as Record<string, unknown>;
        const from = typeof v.from === "string" ? bindingCollection(v.from) : rowCollection;
        if (["ref", "user", "call"].includes(String(v.widget))) e.push(`${path}.widget cannot use a member picker`);
        if (typeof v.c === "string" && !(SHARE_COMPONENTS as readonly string[]).includes(v.c)) e.push(`${path}.c is not allowed on a share page`);
        for (const k of ["join", "count", "call", "canon", "canonLink", "viewAs", "export", "pdf", "print", "expand", "pick", "report", "wait"]) if (k in v && !(k === "count" && typeof v[k] === "string")) e.push(`${path}.${k} is not allowed on a share page`);
        for (const k of ["navigate", "link", "rowLink", "headerLink", "path", "then"]) if (k in v) {
          const href = v[k];
          if (k === "link" && isRecord(href) && typeof href.url === "string") { field(from, href.url, `${path}.link.url`); continue; }
          if (typeof href !== "string" || /^(?:[/\\]|[a-z][a-z0-9+.-]*:)/i.test(href) || /[\x00-\x20]/.test(href) || href.split("?")[0].split("/").some((p) => p === "." || p === "..") || !namesPage(s.pages, href.split("?")[0].replace(PLACEHOLDER, "x"))) e.push(`${path}.${k} must stay within the share's pages`);
        }
        if (typeof v.op === "string" && !s.write.ops.includes(v.op)) e.push(`${path}.op is outside share.write.ops`);
        if (typeof v.transition === "string" && !s.write.transitions.includes(`${v.machine}.${v.transition}`)) e.push(`${path}.transition is outside share.write.transitions`);
        if (typeof v.from === "string" && !bindingCollection(v.from)) e.push(`${path}.from must name a share binding`);
        if (v.c === "statusSteps") {
          const mc = m.machines?.[String(v.machine)];
          if (!mc || mc.collection !== from || !s.read[from!]?.fields.includes(mc.field)) e.push(`${path}.machine must use a projected state field`);
        }
        if (typeof v.bind === "string" && typeof v.field === "string") {
          if (!bindingCollection(v.bind)) e.push(`${path}.bind must name a projected binding`);
          if (v.field !== "key") field(bindingCollection(v.bind), v.field, `${path}.field`);
        }
        if (v.c === "table") {
          if (isRecord(v.group) && typeof v.group.by === "string") field(from, v.group.by, `${path}.group`, true);
          if (isRecord(v.sort) && typeof v.sort.by === "string") field(from, v.sort.by, `${path}.sort`, true);
          if (Array.isArray(v.groupBy)) for (const g of v.groupBy) if (isRecord(g) && typeof g.by === "string") field(from, g.by, `${path}.groupBy`, true);
        }
        if (v.c === "actions" && v.machine && !v.items) e.push(`${path}.items must list visitor actions explicitly`);
        if (v.c === "thread") {
          for (const k of ["body", "author", "at"]) if (typeof v[k] === "string") field(from, v[k] as string, `${path}.${k}`);
          const post = v.post as Extract<Node, { c: "thread" }>["post"];
          if (post) {
            const op = m.ops[post.op];
            if (!op || op.kind !== "create" || op.collection !== from || !op.fields?.includes(post.field)) e.push(`${path}.post must create the thread's read set and write its message field`);
            for (const f of Object.keys(post.fixed ?? {})) if (!op?.fields?.includes(f)) e.push(`${path}.post.fixed.${f} must name an input field`);
            if (!isRecord(post.parent) || !("root" in post.parent) || post.parent.root !== true) e.push(`${path}.post.parent must bind the share root`);
          }
        }
        Object.entries(v).forEach(([k, val]) => walk(val, `${path}.${k}`, from));
      };
      walk(p.title, `${pat}.title`); walk(p.body, `${pat}.body`);
    });
  }
  const outside = (x: unknown): void => {
    if (!x || typeof x !== "object") return;
    if (!Array.isArray(x) && "shared" in x && isRecord(x.shared) && "from" in x.shared && !sharedUses.has(x)) e.push("shared expressions require a declared visitor write");
    Object.values(x).forEach(outside);
  };
  outside(m);
}

/** The checks that need the manifest whole, once each part has its shape. */
/** Each template is on a channel the module declares, and names only the binds a send fills. */
function outboundChecks(m: ModuleManifest, e: string[]) {
  for (const [name, t] of Object.entries(m.templates ?? {})) {
    const at = `templates.${name}`;
    if (!m.outbound?.[t.channel]) e.push(`${at}.channel: outbound doesn't declare ${t.channel}`);
    for (const text of t.channel === "email" ? [t.subject, t.body] : t.channel === "slack" ? [t.text] : Object.values(t.data)) {
      if (text.replace(/\{\$sender\.(?:name|email)\}/g, "").includes("{$sender")) e.push(`${at}: unsupported sender placeholder`);
      for (const p of placeholders(text)) {
        if (p.bind === "sender") {
          if (t.channel !== "email" || !m.outbound?.email?.from.includes("member_mailbox") || !["name", "email"].includes(p.field) || p.format) e.push(`${at}: sender accepts only unformatted name or email on mailbox email templates`);
        } else if (!(TEMPLATE_BINDS as readonly string[]).includes(p.bind)) e.push(`${at} names $${p.bind}; a template names ${TEMPLATE_BINDS.map((b) => `$${b}`).join(", ")}`);
        if (p.format && !(FORMATS as readonly string[]).includes(p.format)) e.push(`${at} formats with ${p.format}, not one of ${FORMATS.join(", ")}`);
      }
    }
  }
}

function crossChecks(declared: ModuleManifest, e: string[]) {
  const builders = (nodes: readonly Node[]): Array<Extract<Node, { c: "report" }>> => nodes.flatMap((n) => n.c === "report" ? [n] : n.c === "tabs" ? n.tabs.flatMap((t) => builders(t.body)) : []);
  for (const [key, r] of Object.entries(declared.reports ?? {})) {
    const node = declared.pages.flatMap((p) => builders(p.body)).find((n) => n.id === r.report);
    if (!node || !reportReads(declared, node, r.spec.object)) e.push(`reports.${key} names no builder over ${r.spec.object}`);
  }
  for (const [key, d] of Object.entries(declared.dashboards ?? {})) for (const tile of d.tiles) {
    if (!declared.reports?.[tile.report]) e.push(`dashboards.${key} names no shipped report ${tile.report}`);
  }
  shareChecks(declared, e);
  outboundChecks(declared, e);
  // A panel is checked as the page Canon serves it, with everything a page is checked for.
  const m: ModuleManifest = { ...declared, pages: pagesOf(declared) };
  for (const page of PANEL_PAGES) {
    const panels = declared.contributes?.[`${page}Page`]?.panels ?? [];
    const ids = new Set<string>();
    panels.forEach((p, i) => {
      const at = `contributes.${page}Page.panels[${i}]`;
      if (ids.has(p.id)) e.push(`${at}.id ${p.id} is used twice`);
      ids.add(p.id);
      const walk = (ns: readonly Node[], where: string): void => ns.forEach((n, k) => {
        if (!(PANEL_COMPONENTS as readonly string[]).includes(n.c)) e.push(`${where}[${k}] is a ${n.c}; a panel draws only ${PANEL_COMPONENTS.join(", ")}`);
        if (n.c === "phone" && !("record" in n)) e.push(`${where}[${k}]: a panel's phone uses record mode`);
      });
      walk(p.body, `${at}.body`);
      if (p.link && !namesPage(m.pages, p.link.path.split("?")[0].replace(PLACEHOLDER, "x"))) e.push(`${at}.link.path names ${p.link.path}, which is not a page`);
    });
  }
  /** A row condition's fields, on `collection`'s docs; a `ref`'s on the docs of the collection its field names. */
  const whereOk = (collection: string, w: RowWhere, at: string): void => {
    const c = m.collections[collection];
    if (!c) return;
    if ("all" in w) return w.all.forEach((x, i) => whereOk(collection, x, `${at}.all[${i}]`));
    if ("ref" in w) {
      const spec = c.schema.value[w.ref];
      const ref = refOf(spec);
      const target = w.collection ?? (ref?.to === "doc" ? ref.collection : undefined);
      if (!spec || (w.collection === undefined ? ref?.to !== "doc" : coreOf(spec.fieldType).type !== "string" && ref?.to !== "doc")) return void e.push(`${at}.ref names ${w.ref}, which is not a field of ${collection} that holds a module doc's key (a doc ref, or text with collection)`);
      if (!m.collections[target ?? ""]) return void e.push(`${at}.collection names ${target}, which is not a collection`);
      return whereOk(target!, w.where, `${at}.where`);
    }
    const spec = c.schema.value[w.field];
    if (!spec) e.push(`${at}.field names ${w.field}, which is not a field of ${collection}`);
    else if (!isScalar(spec.fieldType)) e.push(`${at}.field names ${w.field}, which isn't one text, number, true/false or member`);
  };
  /** Every ref to a module doc names one of the module's collections. */
  const refTargets = (v: ValidatorJSON, at: string): void => {
    switch (v.type) {
      case "ref": if (v.to === "doc" && !m.collections[v.collection ?? ""]) e.push(`${at}.collection names ${v.collection}, which is not a collection`); return;
      case "array": return refTargets(v.value, `${at}.value`);
      case "union": return v.value.forEach((x, i) => refTargets(x, `${at}.value[${i}]`));
      case "record": return refTargets(v.values.fieldType, `${at}.values.fieldType`);
      case "variant": return Object.entries(v.cases).forEach(([k, c]) => refTargets(c, `${at}.cases.${k}`));
      case "object": return Object.entries(v.value).forEach(([k, sp]) => refTargets(sp.fieldType, `${at}.value.${k}.fieldType`));
    }
  };
  /** A ref that sits under a parent (`parent`): to a set collection, its sibling holding a key of the set's parent. */
  const parentRefs = (v: ValidatorJSON, at: string): void => {
    if (v.type === "array") return parentRefs(v.value, `${at}.value`);
    if (v.type === "variant") return Object.entries(v.cases).forEach(([k, c]) => parentRefs(c, `${at}.cases.${k}`));
    if (v.type !== "object") return;
    for (const [f, sp] of Object.entries(v.value)) {
      const core = coreOf(sp.fieldType);
      parentRefs(core, `${at}.value.${f}.fieldType`);
      if (core.type !== "ref" || core.parent === undefined) continue;
      const target = m.collections[core.collection ?? ""];
      if (core.to !== "doc" || !target?.setOf) { e.push(`${at}.value.${f}.fieldType.parent: only a ref to a set collection's doc sits under a parent`); continue; }
      const sib = v.value[core.parent] ? coreOf(v.value[core.parent].fieldType) : null;
      if (!sib || !(sib.type === "string" || (sib.type === "ref" && sib.to === "doc" && sib.collection === target.setOf.parent))) e.push(`${at}.value.${f}.fieldType.parent names ${core.parent}, which must hold the key of a ${target.setOf.parent} doc`);
    }
  };
  for (const [name, c] of Object.entries(m.collections)) parentRefs(c.schema, `collections.${name}.schema`);
  for (const [name, call] of Object.entries(m.calls ?? {})) if (call.args) parentRefs(call.args, `calls.${name}.args`);
  for (const [name, mc] of Object.entries(m.machines ?? {})) for (const [tn, t] of Object.entries(mc.transitions)) if (t.args) parentRefs(t.args, `machines.${name}.transitions.${tn}.args`);
  for (const [name, call] of Object.entries(m.calls ?? {})) if (call.args) refTargets(call.args, `calls.${name}.args`);
  for (const [name, mc] of Object.entries(m.machines ?? {})) for (const [tn, t] of Object.entries(mc.transitions)) if (t.args) refTargets(t.args, `machines.${name}.transitions.${tn}.args`);
  for (const [name, c] of Object.entries(m.collections)) {
    const at = `collections.${name}`;
    const fields = fieldsOf(c);
    if (c.schema.type !== "object") { e.push(`${at}.schema must be an object validator`); continue; }
    const scalarField = (f: string, where: string) => {
      const spec = fields[f];
      if (!spec) return e.push(`${where} names ${f}, which is not a field of ${name}`);
      if (!isScalar(spec.fieldType)) e.push(`${where} names ${f}, which isn't one text, number, true/false or member`);
    };
    if (c.key !== "auto") c.key.from.forEach((f, i) => { scalarField(f, `${at}.key.from[${i}]`); if (fields[f]?.optional) e.push(`${at}.key.from[${i}] names ${f}, which is optional`); });
    if (c.owner !== undefined) {
      const t = fields[c.owner]?.fieldType;
      const users = (x: ValidatorJSON) => x.type === "ref" && x.to === "users";
      if (!t || !(users(t) || (t.type === "union" && t.value.some(users) && t.value.every((x) => users(x) || x.type === "null")))) e.push(`${at}.owner must name a field of type ref users`);
    }
    if (c.retainedEvidence) {
      const f = fields[c.retainedEvidence.deal];
      if (!f || f.optional || f.fieldType.type !== "ref" || f.fieldType.to !== "deals") e.push(`${at}.retainedEvidence.deal must name a required deal ref`);
      if (c.report || c.activity || Object.keys(m.shares ?? {}).length) e.push(`${at}.retainedEvidence does not support reports, activities or visitor shares`);
    }
    if (c.activity) {
      const a = c.activity, where = `${at}.activity`;
      const mapped = (field: string | undefined, part: string, accepts: (s: FieldSpec) => boolean) => {
        if (field !== undefined && (!fields[field] || !accepts(fields[field]))) e.push(`${where}.${part} names ${field}, which has an incompatible field type`);
      };
      const textField = (s: FieldSpec) => {
        const t = coreOf(s.fieldType);
        return t.type === "string" || (literalChoices(t)?.every((v) => typeof v === "string") ?? false);
      };
      mapped(a.subject, "subject", textField);
      mapped(a.status, "status", textField);
      mapped(a.at, "at", (s) => (coreOf(s.fieldType).type === "string" && widgetOf(s) === "date") || (coreOf(s.fieldType).type === "number" && widgetOf(s) === "time"));
      mapped(a.dueDate, "dueDate", (s) => coreOf(s.fieldType).type === "string" && widgetOf(s) === "date");
      mapped(a.owner, "owner", (s) => { const t = coreOf(s.fieldType); return t.type === "ref" && t.to === "users"; });
      if (!Object.keys(a.targets).length) e.push(`${where}.targets must name at least one Canon ref field`);
      for (const [to, field] of Object.entries(a.targets)) mapped(field, `targets.${to}`, (s) => {
        const core = coreOf(s.fieldType), t = core.type === "array" ? coreOf(core.value) : core;
        return t.type === "ref" && t.to === to;
      });
      const page = m.pages.find((p) => p.path === a.path);
      const bindsDoc = page && Object.values(page.bind ?? {}).some((b) => {
        if (b.view === undefined) return false;
        const view = m.views[b.view];
        if (view?.kind !== "one" || view.collection !== name || view.key === null || typeof view.key !== "object" || !("arg" in view.key)) return false;
        const key = b.args?.[view.key.arg];
        return key !== null && typeof key === "object" && "route" in key && key.route === "key";
      });
      if (!bindsDoc) e.push(`${where}.path must name a declared detail page binding this collection by its route key`);
    }
    c.report?.dimensions.forEach((f, k) => {
      if (f.includes(".")) { const j = joinedDimension(m, c, f); if (typeof j === "string") e.push(`${at}.report.dimensions[${k}] names ${f}: ${j}`); return; }
      if (!fields[f]) e.push(`${at}.report.dimensions[${k}] names ${f}, which is not a field of ${name}`); else {
        const t = reportType(fields[f]);
        // A report groups by a value, a day or an instant: a plain number (or money) is a measure, never a key.
        if (!t) e.push(`${at}.report.dimensions[${k}] names ${f}, which a report can't group by (a list or an object)`);
        else if (t.type === "number" || t.type === "currency") e.push(`${at}.report.dimensions[${k}] names ${f}, a number a report can't group by: keep it a measure, give a timestamp widget "time", or group by a text copy`);
      }
    });
    c.report?.measures?.forEach((f, k) => { const t = fields[f] ? reportType(fields[f]) : null; if (!t || !isMeasure(t)) e.push(`${at}.report.measures[${k}] names ${f}, which is not a number field of ${name}`); });
    if (c.report?.members !== undefined && (refOf(fields[c.report.members])?.to !== "users" || !c.report.dimensions.includes(c.report.members))) e.push(`${at}.report.members names ${c.report.members}, which is not a member ref among ${name}'s report dimensions`);
    if (c.report?.members !== undefined && !m.reads?.users) e.push(`${at}.report.members rolls onto Canon's members, which the module reads only with reads.users`);
    const latest = c.report?.memberLatest;
    if (latest) {
      const dims = new Set(c.report!.dimensions);
      if (c.report!.members === undefined) e.push(`${at}.report.memberLatest puts values on members, which needs report.members`);
      const byType = fields[latest.by] ? reportType(fields[latest.by])?.type : undefined;
      if (!dims.has(latest.by) || !["date", "datetime", "text", "picklist"].includes(byType ?? "")) e.push(`${at}.report.memberLatest.by names ${latest.by}, which is not a date, time or text dimension of ${name}`);
      latest.fields.forEach((f, k) => { if (!dims.has(f) || f.includes(".") || reportType(fields[f])?.ref) e.push(`${at}.report.memberLatest.fields[${k}] names ${f}, which is not one of ${name}'s own dimensions`); });
      latest.where?.forEach((w, k) => { if (!dims.has(w.field) || w.field.includes(".")) e.push(`${at}.report.memberLatest.where[${k}] names ${w.field}, which is not one of ${name}'s own dimensions`); });
    }
    if (c.title?.includes("{$")) {
      // A title over several fields (a line item's rule and deal): `{$doc.<field>}`, each with an optional format.
      for (const [, b, f, fmt] of c.title.matchAll(PLACEHOLDER)) {
        if (b !== "doc") e.push(`${at}.title names $${b}; a title names $doc`);
        else if (!fields[f] && !["key", "parentKey"].includes(f)) e.push(`${at}.title names ${f}, which is not a field of ${name}`);
        if (fmt && !["money", "date", "time", "number", "percent"].includes(fmt)) e.push(`${at}.title formats with ${fmt}: a title takes money, date, time, number or percent`);
      }
    } else if (c.title !== undefined && fields[c.title] && coreOf(fields[c.title].fieldType).type !== "string") e.push(`${at}.title names ${c.title}, which isn't a text field`);
    else if (c.title !== undefined && !fields[c.title]) e.push(`${at}.title names ${c.title}, which is not a field of ${name}`);
    refTargets(c.schema, `${at}.schema`);
    const parent = c.setOf && m.collections[c.setOf.parent];
    if (c.max !== undefined && (!Number.isInteger(c.max) || c.setOf)) e.push(`${at}.max requires a top-level collection and an integer limit`);
    if (c.setOf && !parent) e.push(`${at}.setOf.parent names ${c.setOf.parent}, which is not a collection`);
    if (parent?.setOf) e.push(`${at}.setOf.parent names ${c.setOf!.parent}, which is itself a set; sets nest one level`);
    for (const [index, list] of Object.entries(c.indexes)) {
      if (c.setOf && list.length > MAX_SET_INDEX_FIELDS) e.push(`${at}.indexes.${index} has ${list.length} fields; a set collection's index has at most ${MAX_SET_INDEX_FIELDS}, after its parent and generation`);
      list.forEach((f, i) => scalarField(f, `${at}.indexes.${index}[${i}]`));
    }
    for (const [role, scope] of Object.entries(c.access)) {
      const s = typeof scope === "string" ? scope : scope!.scope;
      if ((s === "own" || s === "team" || s === "hier" || s === "ownerOrUnrestricted") && !c.owner) e.push(`${at}.access.${role} is ${s}, which needs an owner field`);
      if (typeof scope === "object" && "members" in scope && !memberPathValid(c.schema, scope.members)) e.push(`${at}.access.${role}.members must name a user ref path, at most four fields deep`);
      if (typeof scope === "object" && "where" in scope) whereOk(name, scope.where, `${at}.access.${role}.where`);
      if (typeof scope === "object" && "or" in scope) {
        whereOk(name, scope.or, `${at}.access.${role}.or`);
        if (c.report) e.push(`${at}.access.${role}.or widens what ${role} reads, which a collection with a report can't apply yet`);
      }
    }
    if (c.integrity) {
      const g = c.integrity, gat = `${at}.integrity`;
      const spec = fields[g.field];
      if (!spec) e.push(`${gat}.field names ${g.field}, which is not a field of ${name}`);
      else if (!spec.optional || coreOf(spec.fieldType).type !== "string") e.push(`${gat}.field names ${g.field}, which must be an optional text field: a doc is sealed or not`);
      else if (machineFields(m, name).has(g.field) || (c.key !== "auto" && c.key.from.includes(g.field)) || c.owner === g.field) e.push(`${gat}.field names ${g.field}, which a machine, the key or the owner holds`);
      g.fields.forEach((f, i) => { if (!fields[f]) e.push(`${gat}.fields[${i}] names ${f}, which is not a field of ${name}`); else if (f === g.field) e.push(`${gat}.fields[${i}] names the seal itself`); });
      for (const [child, list] of Object.entries(g.children ?? {})) {
        const cc = m.collections[child];
        if (cc?.setOf?.parent !== name) { e.push(`${gat}.children.${child} is not a set of ${name}`); continue; }
        list.forEach((f, i) => { if (!cc.schema.value[f]) e.push(`${gat}.children.${child}[${i}] names ${f}, which is not a field of ${child}`); });
      }
    }
  }
  const exprProblems = (x: Expr, args: Record<string, ArgType> | undefined, at: string) => {
    if (x !== null && typeof x === "object" && "arg" in x && !Object.hasOwn(args ?? {}, x.arg)) e.push(`${at} names argument ${x.arg}, which the view doesn't declare`);
  };
  for (const [name, v] of Object.entries(m.views)) {
    const at = `views.${name}`;
    const c = m.collections[v.collection];
    if (!c) { e.push(`${at}.collection names ${v.collection}, which is not a collection`); continue; }
    const listArgs = (x: Expr | undefined) => (x !== null && typeof x === "object" && "arg" in x && isListArg(v.args?.[x.arg]) ? 1 : 0);
    if (v.kind === "one") { exprProblems(v.key, v.args, `${at}.key`); if (listArgs(v.key)) e.push(`${at}.key names a list; a one view reads one key`); continue; }
    if (listArgs(v.parent) + (v.eq ?? []).reduce((n: number, x) => n + listArgs(x), 0) > 1) e.push(`${at} names two list arguments; a view reads by one list`);
    for (const [b, x] of Object.entries(v.range ?? {})) { exprProblems(x, v.args, `${at}.range.${b}`); if (listArgs(x)) e.push(`${at}.range.${b} names a list; a bound is one value`); }
    if (v.range && (("gte" in v.range && "gt" in v.range) || ("lte" in v.range && "lt" in v.range) || !Object.keys(v.range).length)) e.push(`${at}.range must have one or two bounds: gte or gt, and lte or lt`);
    if (v.where) whereOk(v.collection, v.where, `${at}.where`);
    if (Boolean(c.setOf) !== (v.parent !== undefined)) e.push(c.setOf ? `${at}.parent is missing: ${v.collection} is a set of ${c.setOf.parent}` : `${at}.parent is only for a set collection`);
    if (v.parent !== undefined) exprProblems(v.parent, v.args, `${at}.parent`);
    if (v.index === undefined) { if (v.eq?.length) e.push(`${at}.eq needs an index`); if (v.range) e.push(`${at}.range needs an index`); continue; }
    const fields = c.indexes[v.index];
    if (!fields) { e.push(`${at}.index names ${v.index}, which ${v.collection} doesn't declare`); continue; }
    if ((v.eq?.length ?? 0) > fields.length) e.push(`${at}.eq has more values than ${v.index} has fields`);
    else if (v.range && (v.eq?.length ?? 0) >= fields.length) e.push(`${at}.range needs a field of ${v.index} after eq's`);
    v.eq?.forEach((x, i) => exprProblems(x, v.args, `${at}.eq[${i}]`));
  }
  machineChecks(m, e);
  const { expr, pred, dirtyList, notifyOk, sendOk } = exprChecks(m, e);
  for (const [name, op] of Object.entries(m.ops)) {
    const at = `ops.${name}`;
    const c = m.collections[op.collection];
    if (!c) { e.push(`${at}.collection names ${op.collection}, which is not a collection`); continue; }
    if (Boolean(op.system) === Boolean(op.roles.length)) e.push(op.system ? `${at}.roles must be empty: only Canon runs a system op` : `${at}.roles is empty: name a role, or make it a system op`);
    const sc: ExprScope = { collection: op.collection, args: null, created: new Set(), what: name };
    op.guards?.forEach((g, i) => pred(g.when, `${at}.guards[${i}].when`, op.collection, sc));
    dirtyList(op.dirties, `${at}.dirties`, sc);
    op.effects?.forEach((fx, i) => {
      if (fx.when) pred(fx.when, `${at}.effects[${i}].when`, op.collection, sc);
      if ("send" in fx) sendOk(fx, `${at}.effects[${i}]`, op.collection, sc);
      else notifyOk(fx, `${at}.effects[${i}]`, op.collection, sc);
    });
    for (const [f, x] of Object.entries(op.set ?? {})) {
      if (isUnset(x)) { if (op.kind !== "update") e.push(`${at}.set.${f}: only an update unsets a field`); else if (fieldsOf(c)[f] && !fieldsOf(c)[f].optional) e.push(`${at}.set.${f} unsets a required field`); }
      else expr(x as MachineExpr, `${at}.set.${f}`, sc);
      if (c.integrity?.field === f) e.push(`${at}.set.${f} is the integrity seal, which only Canon writes`);
    }
    const owned = machineFields(m, op.collection);
    op.fields?.forEach((f, i) => { if (owned.has(f)) e.push(`${at}.fields[${i}] names ${f}, which machine ${owned.get(f)} owns: only its transitions change it`); });
    op.fields?.forEach((f, i) => { if (c.integrity?.field === f) e.push(`${at}.fields[${i}] names ${f}, the integrity seal, which only Canon writes`); });
    if (op.kind === "delete" ? op.fields !== undefined : !op.fields?.length) e.push(op.kind === "delete" ? `${at}.fields is not for a delete` : `${at}.fields is missing`);
    op.fields?.forEach((f, i) => { if (!fieldsOf(c)[f]) e.push(`${at}.fields[${i}] names ${f}, which is not a field of ${op.collection}`); });
    if (op.kind === "update" && c.key !== "auto") op.fields?.forEach((f, i) => { if ((c.key as { from: readonly string[] }).from.includes(f)) e.push(`${at}.fields[${i}] names ${f}, part of the key, which an update can't change`); });
    if ((op.agent === "human") !== (op.reason !== undefined)) e.push(op.agent === "human" ? `${at}.reason is missing: say why an agent can't run it` : `${at}.reason is only for agent "human"`);
    if (op.set && op.kind === "delete") e.push(`${at}.set is not for a delete`);
    for (const f of Object.keys(op.set ?? {})) {
      if (!fieldsOf(c)[f]) e.push(`${at}.set.${f} is not a field of ${op.collection}`);
      else if (owned.has(f)) e.push(`${at}.set.${f} is machine ${owned.get(f)}'s field: a new doc starts in its initial state`);
      else if (op.fields?.includes(f)) e.push(`${at}.set.${f} is in fields too: a field comes from the form or from set, not both`);
      else if (op.kind === "update" && c.key !== "auto" && c.key.from.includes(f)) e.push(`${at}.set.${f} is part of the key, which an update can't change`);
    }
  }
  callChecks(m, e);
  contributionChecks(m, e);
  for (const [name, p] of Object.entries(m.provides ?? {})) {
    const v = m.views[p.view];
    if (!v) { e.push(`provides.${name}.view names ${p.view}, which is not a view`); continue; }
    const c = m.collections[v.collection];
    const bad = p.fields.filter((f) => !c || !Object.hasOwn(c.schema.value, f));
    if (bad.length) e.push(`provides.${name}.fields names ${bad.join(", ")}, which ${v.collection} doesn't have`);
    if (p.people && c) {
      const f = c.schema.value[p.people.filter];
      const array = f ? coreOf(f.fieldType) : null;
      const item = array?.type === "array" ? coreOf(array.value) : null;
      if (item?.type !== "object" || ["field", "op"].some((k) => !item.value[k] || item.value[k].optional || coreOf(item.value[k].fieldType).type !== "string")) e.push(`provides.${name}.people.filter must name an array of contacts list filters in ${v.collection}`);
      const set = p.people.added && m.collections[p.people.added.set];
      if (p.people.added && (set?.setOf?.parent !== v.collection || !Object.hasOwn(set.schema.value, p.people.added.field))) e.push(`provides.${name}.people.added names ${p.people.added.set}.${p.people.added.field}, which is not a field of a set under ${v.collection}`);
      const field = p.people.added && set?.schema.value[p.people.added.field];
      if (p.people.added && (!field || coreOf(field.fieldType).type !== "string")) e.push(`provides.${name}.people.added.field must name a string field of ${p.people.added.set}`);
    }
  }
  if (m.uses?.[m.id]) e.push(`uses names ${m.id}, this module itself: read its own views`);
  jobChecks(m, e);
  for (const [name, x] of Object.entries(m.exports ?? {})) {
    const at = `exports.${name}`;
    if ("people" in x) {
      e.push(...peopleExportProblems(m, x).map((problem) => `${at}: ${problem}`));
      continue;
    }
    if (x.pdf && !namesPage(m.pages, x.pdf.page)) e.push(`${at}.pdf.page names ${x.pdf.page}, which is not a page`);
    x.columns.forEach((col, i) => {
      for (const [, b, , fmt] of col.value.matchAll(PLACEHOLDER)) {
        if (b !== "row") e.push(`${at}.columns[${i}].value names $${b}; an export's columns name $row`);
        if (fmt && !(FORMATS as readonly string[]).includes(fmt)) e.push(`${at}.columns[${i}].value formats with ${fmt}, not one of ${FORMATS.join(", ")}`);
      }
    });
    if ("view" in x) {
      const v = m.views[x.view];
      if (!v || v.kind !== "list") { e.push(`${at}.view names ${x.view}, which is not a list view`); continue; }
      if (Object.values(v.args ?? {}).some(isListArg)) e.push(`${at}.view names ${x.view}, which takes a list: only a call's read plan gives one`);
      const fields = m.collections[v.collection]?.schema.value ?? {};
      x.join?.forEach((f, k) => { if (!refOf(fields[f])) e.push(`${at}.join[${k}] names ${f}, which is not a ref field of ${v.collection}`); });
      if (x.require) pred(x.require.when, `${at}.require.when`, v.collection, { collection: v.collection, args: null, created: new Set(), what: name });
    } else {
      const call = m.calls?.[x.call];
      if (!call) e.push(`${at}.call names ${x.call}, which is not a call`);
      else if (call.canon || call.system || call.returns !== "value") e.push(`${at}.call names ${x.call}, which must be a person's call that returns its value`);
    }
  }
  for (const [name, x] of Object.entries(m.csvImports ?? {})) e.push(...csvImportProblems(x, m.calls?.[x.call]).map((problem) => `csvImports.${name}.${problem}`));

  const paths = new Set<string>();
  /** Report ids name saved reports: one component per id in the module. */
  const reports = new Set<string>();
  const pacings = new Set<string>();
  m.pages.forEach((p, i) => {
    const at = `pages[${i}]`;
    if (!segmentsOf(p.path).every((s) => SEGMENT.test(s))) e.push(`${at}.path must be segments of a-z, 0-9 and -, or :param`);
    const shape = segmentsOf(p.path).map((s) => (s.startsWith(":") ? ":" : s)).join("/");
    if (paths.has(shape)) e.push(`${at}.path ${p.path} is there twice`);
    paths.add(shape);
    const params = paramsOf(p.path);
    // A column's `expand` reads views of its own per row (its args may name the row): the page's checks see them too.
    const rowBinds: Record<string, Binding> = {};
    const collect = (list: readonly Node[]) => list.forEach((n) => {
      if (n.c === "tabs") n.tabs.forEach((t) => collect(t.body));
      if (n.c === "table") for (const col of n.columns) if (col.expand) { Object.assign(rowBinds, col.expand.bind ?? {}); collect(col.expand.body); }
    });
    collect(p.body);
    for (const b of Object.keys(rowBinds)) if (Object.hasOwn(p.bind ?? {}, b)) e.push(`${at}: a column's expand binds ${b}, which the page binds too`);
    const binds: Record<string, Binding> = { ...(p.bind ?? {}), ...rowBinds };
    /** While the checker is inside a column's `expand`, its texts read the row. */
    let inRow = false;
    const pageExprOk = (x: PageExpr | undefined, where: string) => {
      if (x !== null && typeof x === "object" && "route" in x && !params.includes(x.route)) e.push(`${where} names :${x.route}, which ${p.path} doesn't have`);
    };
    /** A form's or an action's value: a bound doc's field names a binding of the page; a page value, its route. */
    const formValueOk = (x: FormExpr, where: string) => {
      if (x !== null && typeof x === "object" && "bind" in x) { if (!Object.hasOwn(binds, x.bind)) e.push(`${where} names ${x.bind}, which the page doesn't bind`); }
      else if (!(x !== null && typeof x === "object" && ("row" in x || "today" in x))) pageExprOk(x as PageExpr, where);
    };
    /** A row's field or today's date, where neither is: a binding's argument, a job's prefix, a period's current. */
    const rowOrToday = (x: FormExpr | undefined, where: string) => {
      if (x === null || typeof x !== "object" || !("row" in x || "today" in x)) return false;
      e.push(`${where} names ${"row" in x ? "a row's field" : "today"}, which only a form's or an action's values take`);
      return true;
    };
    if (p.fallback) {
      if (!namesPage(m.pages, p.fallback.back.path)) e.push(`${at}.fallback.back.path names ${p.fallback.back.path}, which is not a page`);
      for (const param of linkParams(p.fallback.back.path)) if (!params.includes(param)) e.push(`${at}.fallback.back.path fills :${param}, which ${p.path} doesn't have`);
      p.fallback.actions?.forEach((x, k) => {
        if (!namesPage(m.pages, x.path)) e.push(`${at}.fallback.actions[${k}].path names ${x.path}, which is not a page`);
        for (const param of linkParams(x.path)) if (!params.includes(param)) e.push(`${at}.fallback.actions[${k}].path fills :${param}, which ${p.path} doesn't have`);
      });
    }
    /** A binding's `{ bind, field }` argument: a field of the one doc another view binding reads. */
    const bindArgOk = (x: FormExpr, where: string) => {
      if (rowOrToday(x, where)) return;
      if (x === null || typeof x !== "object" || !("bind" in x)) return pageExprOk(x as PageExpr, where);
      const from = binds[x.bind];
      if (!from) return e.push(`${where} names ${x.bind}, which the page doesn't bind`);
      if (from.view === undefined || m.views[from.view]?.kind !== "one") return e.push(`${where} names ${x.bind}, which must bind one doc: an argument is a field of it`);
      const c = m.collections[m.views[from.view].collection];
      if (c && x.field !== "key" && !c.schema.value[x.field]) e.push(`${where}.field names ${x.field}, which is not key or a field of ${m.views[from.view].collection}`);
    };
    // A binding read from another's doc reads after it: no binding may wait on itself.
    const waits = (b: string) => Object.values(binds[b]?.args ?? {}).flatMap((x) => (x !== null && typeof x === "object" && "bind" in x ? [x.bind] : []));
    const cycle = (b: string, path: string[]): boolean => path.includes(b) || waits(b).some((n) => cycle(n, [...path, b]));
    for (const b of Object.keys(binds)) if (cycle(b, [])) { e.push(`${at}.bind.${b} reads from a binding that reads from it`); break; }
    for (const [b, binding] of Object.entries(binds)) {
      if (["row", "query", "notifications", "objects"].includes(b)) e.push(`${at}.bind.${b}: ${b} is reserved for Canon's text values; name the binding something else`);
      if (binding.call !== undefined) {
        const call = m.calls?.[binding.call];
        if (!call) { e.push(`${at}.bind.${b}.call names ${binding.call}, which is not a call`); continue; }
        if (Object.values(call.reads).some((r) => "canon" in r && (r.canon === "me.context" || r.canon === "social.search" || r.canon === "web.pages" || r.canon === "web.search" || r.canon === "market.sample"))) e.push(`${at}.bind.${b}.call cannot fetch websites or free samples implicitly`);
        if (call.canon || call.system || call.returns !== "value" || call.writes.length) e.push(`${at}.bind.${b}.call names ${binding.call}: a page loads only a person's call that writes nothing and returns its value`);
        for (const from of binding.refreshOn ?? []) if (binds[from]?.view === undefined) e.push(`${at}.bind.${b}.refreshOn names ${from}, which must bind an own-doc view`);
        const takes = call.args?.value ?? {};
        for (const [arg, x] of Object.entries(binding.args ?? {})) {
          if (!Object.hasOwn(takes, arg)) e.push(`${at}.bind.${b}.args.${arg} is not an argument of ${binding.call}`);
          bindArgOk(x, `${at}.bind.${b}.args.${arg}`);
          if (x !== null && typeof x === "object" && "bind" in x && binds[x.bind]?.call !== undefined) e.push(`${at}.bind.${b}.args.${arg} names ${x.bind}, a call's value: an argument comes from a doc`);
        }
        for (const [arg, spec] of Object.entries(takes)) if (!spec.optional && !Object.hasOwn(binding.args ?? {}, arg)) e.push(`${at}.bind.${b}.args.${arg} is missing`);
        continue;
      }
      if (binding.canon !== undefined) {
        const read = CANON_READS[binding.canon] as { object: CanonObject; args: Record<string, ArgType>; optional?: readonly string[] };
        if (!m.reads?.[read.object]) e.push(`${at}.bind.${b}.canon reads ${read.object}, which reads.${read.object} doesn't grant`);
        if (!pageReadable(binding.canon, m)) e.push(`${at}.bind.${b}.canon names ${binding.canon}, which a page can't read live: only a call's read plan reads it`);
        for (const [arg, x] of Object.entries(binding.args ?? {})) {
          if (!Object.hasOwn(read.args, arg)) e.push(`${at}.bind.${b}.args.${arg} is not an argument of ${binding.canon}`);
          bindArgOk(x, `${at}.bind.${b}.args.${arg}`);
        }
        for (const arg of Object.keys(read.args)) if (!Object.hasOwn(binding.args ?? {}, arg) && !read.optional?.includes(arg)) e.push(`${at}.bind.${b}.args.${arg} is missing`);
        continue;
      }
      const view = m.views[binding.view];
      if (!view) { e.push(`${at}.bind.${b}.view names ${binding.view}, which is not a view`); continue; }
      if (Object.values(view.args ?? {}).some(isListArg)) e.push(`${at}.bind.${b}.view names ${binding.view}, which takes a list: only a call's read plan gives one`);
      const fields = m.collections[view.collection]?.schema.value ?? {};
      binding.join?.forEach((f, k) => { if (!refOf(fields[f])) e.push(`${at}.bind.${b}.join[${k}] names ${f}, which is not a ref field of ${view.collection}`); });
      if (binding.limit !== undefined && view.kind !== "list") e.push(`${at}.bind.${b}.limit is only for a list view`);
      for (const [name, cd] of Object.entries(binding.count ?? {})) {
        const cat = `${at}.bind.${b}.count.${name}`;
        if (Object.hasOwn(fields, name)) e.push(`${cat} is a field of ${view.collection} too: give the count its own name`);
        const cv = m.views[cd.view];
        if (!cv || cv.kind !== "list") { e.push(`${cat}.view names ${cd.view}, which is not a list view`); continue; }
        const listArgs = Object.entries(cv.args ?? {});
        if (listArgs.length !== 1 || !isListArg(listArgs[0][1])) e.push(`${cat}.view names ${cd.view}, which must take one list argument and nothing else: the rows' values`);
        const cc = m.collections[cv.collection];
        if (cd.by === "parentKey" ? !cc?.setOf : !cc?.schema.value[cd.by]) e.push(`${cat}.by names ${cd.by}, which is not a field of ${cv.collection}`);
        if (cd.collect !== undefined && !cc?.schema.value[cd.collect]) e.push(`${cat}.collect names ${cd.collect}, which is not a field of ${cv.collection}`);
        if (cd.of !== undefined && !Object.hasOwn(fields, cd.of)) e.push(`${cat}.of names ${cd.of}, which is not a field of ${view.collection}`);
      }
      for (const [arg, x] of Object.entries(binding.args ?? {})) {
        if (!Object.hasOwn(view.args ?? {}, arg)) e.push(`${at}.bind.${b}.args.${arg} is not an argument of ${binding.view}`);
        if (Object.hasOwn(rowBinds, b) && x !== null && typeof x === "object" && "row" in x) continue;
        bindArgOk(x, `${at}.bind.${b}.args.${arg}`);
      }
      for (const arg of Object.keys(view.args ?? {})) if (!Object.hasOwn(binding.args ?? {}, arg)) e.push(`${at}.bind.${b}.args.${arg} is missing`);
    }
    if (p.onOpen) {
      const mc = m.machines?.[p.onOpen.machine];
      const t = mc?.transitions[p.onOpen.transition];
      const b = binds[p.onOpen.target];
      if (!mc || !t) e.push(`${at}.onOpen names ${p.onOpen.machine}.${p.onOpen.transition}, which is not a transition`);
      else if (!b || b.call !== undefined || m.views[b.view!]?.kind !== "one") e.push(`${at}.onOpen.target names ${p.onOpen.target}, which must bind one doc`);
      else if (m.views[b.view!].collection !== mc.collection) e.push(`${at}.onOpen: ${p.onOpen.machine} moves ${mc.collection} docs, not ${m.views[b.view!].collection}`);
      else if (t.system || t.args?.value && Object.values(t.args.value).some((sp) => !sp.optional) || t.confirm || t.evidence) e.push(`${at}.onOpen names ${p.onOpen.transition}, which a page can't run by itself: it is system, asks for arguments or a confirmation, or records evidence`);
    }
    const textOk = (t: string | undefined, where: string, row: boolean, also?: string) => {
      for (const [, b, field, fmt] of (t ?? "").matchAll(PLACEHOLDER)) {
        if (!((row || inRow) && b === "row") && b !== "query" && b !== "notifications" && b !== "objects" && !also?.split(",").includes(b) && !Object.hasOwn(binds, b)) e.push(`${where} names $${b}, which the page doesn't bind`);
        if (b === "objects" && !/^[a-z][a-zA-Z0-9_]*\.(label|pluralLabel)$/.test(field)) e.push(`${where} reads an object's label or pluralLabel`);
        if (fmt && !(FORMATS as readonly string[]).includes(fmt)) e.push(`${where} formats with ${fmt}, not one of ${FORMATS.join(", ")}`);
      }
    };
    const bindCollection = (b: string) => m.views[binds[b]?.view ?? ""]?.collection;
    /** A field's options: a binding the page reads, and a label over `{$item...}`. */
    const optionsOk = (o: FieldOptions | undefined, where: string, row: boolean) => {
      if (!o) return;
      if (!Object.hasOwn(binds, o.from)) e.push(`${where}.from names ${o.from}, which the page doesn't bind`);
      textOk(o.label, `${where}.label`, row, "item");
      if (o.sub !== undefined) textOk(o.sub, `${where}.sub`, row, "item");
      if (o.badge !== undefined) textOk(o.badge, `${where}.badge`, row, "item");
    };
    const fieldOptionsOk = (f: FormField, spec: FieldSpec | undefined, where: string, row: boolean, siblings?: ObjectValidator) => {
      optionsOk(f.options, `${where}.options`, row);
      const scalarChoice = (s: FieldSpec) => {
        const core = coreOf(s.fieldType);
        const leaf = core.type === "array" ? coreOf(core.value) : core;
        return leaf.type === "string" || leaf.type === "number" || leaf.type === "literal" || !!literalChoices(leaf);
      };
      if (f.options?.by && !siblings?.value[f.options.by.sibling]) e.push(`${where}.options.by.sibling must name a declared sibling`);
      for (const [i, target] of (f.optionTargets ?? []).entries()) {
        const at = `${where}.optionTargets[${i}]`;
        optionsOk(target.options, `${at}.options`, row);
        const path = target.path.split(".");
        const containing = spec ? fieldParentsAt(spec, path) : [];
        const valid = spec && mapFieldSpecAt(spec, path, (s) => { if (!scalarChoice(s)) e.push(`${at}.path must name a scalar choice or array of choices`); return s; });
        if (!valid) e.push(`${at}.path must name a field in the declared object schema`);
        if (target.options.by && (!containing.length || containing.some((c) => !c.value[target.options.by!.sibling]))) e.push(`${at}.options.by.sibling must name a declared sibling`);
      }
    };
    const canonFields = (read: CanonRead): string[] => ["key", "id", "createdAt", ...(read === "me.status" ? ["name", "status", "intakeStatus", "url"] : []), ...(m.reads?.[CANON_READS[read].object] ?? [])];
    /** Whether `path` names a value of a row of bind `b`: a field, `key`, a count, or a joined doc's field. */
    const rowPathOk = (path: string, b: string, where: string) => {
      const canon = binds[b]?.canon;
      if (canon !== undefined && !canonFields(canon).includes(path.split(".")[0])) e.push(`${where} names ${path}, which ${b}'s records don't have, or reads doesn't grant`);
      const c = m.collections[bindCollection(b) ?? ""];
      if (!c) return;
      const [first, second] = path.split(".");
      const binding = binds[b];
      if (second === undefined) {
        if (first !== "key" && !Object.hasOwn(c.schema.value, first) && !Object.hasOwn(binding.count ?? {}, first)) e.push(`${where} names ${path}, which is not a field or a count of ${b}'s rows`);
        return;
      }
      if (!binding.join?.includes(first)) {
        const spec = c.schema.value[first];
        if (!spec || coreOf(spec.fieldType).type !== "object") e.push(`${where} names ${path}: ${b} doesn't join ${first}`);
        return;
      }
      const ref = refOf(c.schema.value[first]);
      const target = ref?.to === "doc" ? m.collections[ref.collection ?? ""] : null;
      const ok = ref?.to === "senders" ? !!m.reads?.senders && ["id", "createdAt", ...m.reads.senders].includes(second)
        : ref?.to === "doc" ? second === "key" || Boolean(target?.schema.value[second])
        : ref?.to === "deals" || ref?.to === "users" || ref?.to === "companies" || ref?.to === "people" ? second === "name" || ((m.reads?.[ref.to] ?? []) as readonly string[]).includes(second)
        : second === "name";
      if (!ok) e.push(`${where} names ${path}, which the joined ${ref?.to === "doc" ? ref.collection : ref?.to} doesn't have${ref?.to !== "doc" && ref?.to !== "teams" ? " (or reads doesn't grant)" : ""}`);
    };
    /** Whether a binding reads a call's value: its rows are what the call returns, whose fields the manifest doesn't know. */
    const callBind = (b: string | undefined) => b !== undefined && binds[b]?.call !== undefined;
    const canonBind = (b: string | undefined) => b !== undefined && binds[b]?.canon !== undefined;
    const CANON_ROWS = "binds a Canon read, whose rows only a table shows";
    /** A row link's `:params`: `key`, a field of the row, or the page's own route parameters. A call's row may have any field. */
    const linkOk = (href: string, b: string | undefined, where: string) => {
      if (!namesPage(m.pages, href)) return e.push(`${where} names ${href}, which is not a page`);
      if (callBind(b)) return;
      const c = b ? m.collections[bindCollection(b) ?? ""] : undefined;
      const canon = b === undefined ? undefined : binds[b]?.canon;
      for (const param of linkParams(href)) if (param !== "key" && !params.includes(param) && !(c && Object.hasOwn(c.schema.value, param)) && !(canon && canonFields(canon).includes(param))) e.push(`${where} fills :${param}, which is not key, a field of the row or a route parameter`);
    };
    /** A list binding a component reads: whether it is one. */
    const listBind = (b: string, where: string): boolean => {
      if (!Object.hasOwn(binds, b)) { e.push(`${where} names ${b}, which the page doesn't bind`); return false; }
      if (binds[b].call !== undefined) { e.push(`${where} names ${b}, which binds a call's value, not docs`); return false; }
      if (canonBind(b)) { e.push(`${where} names ${b}, which ${CANON_ROWS}`); return false; }
      if (m.views[binds[b].view!]?.kind !== "list") { e.push(`${where} names ${b}, which binds one doc, not a list`); return false; }
      return true;
    };
    const oneBind = (b: string, where: string) => {
      if (!Object.hasOwn(binds, b)) return e.push(`${where} names ${b}, which the page doesn't bind`);
      if (binds[b].call !== undefined) return e.push(`${where} names ${b}, which binds a call's value, not a doc`);
      if (canonBind(b)) return e.push(`${where} names ${b}, which ${CANON_ROWS}`);
      if (m.views[binds[b].view!]?.kind === "list") e.push(`${where} names ${b}, which binds a list, not one doc`);
    };
    const machineOn = (name: string, where: string, collection: string | undefined) => {
      const mc = m.machines?.[name];
      if (!mc) return e.push(`${where} names ${name}, which is not a machine`);
      if (collection !== undefined && mc.collection !== collection) e.push(`${where}: ${name} moves ${mc.collection} docs, not ${collection}`);
    };
    /**
     * An action on the page: on a table's row (`row`), the doc's collection (`rowCollection`) or, on a call's row
     * (`callRows`), fields the manifest doesn't know.
     */
    const action = (a: ActionRef, where: string, row: boolean, rowCollection?: string, callRows = false) => {
      if ("label" in a && typeof a.label === "string") textOk(a.label, `${where}.label`, row);
      if ("aria" in a && a.aria !== undefined) textOk(a.aria, `${where}.aria`, row);
      // A call's toast may say what it returned: `{$result.<field>}`.
      // A transition's may say what the move left on its doc: `{$doc.<field>}`.
      if ("toast" in a && a.toast !== undefined && !("pdf" in a)) textOk(a.toast, `${where}.toast`, row, "call" in a || "export" in a ? "result" : "transition" in a || "op" in a ? "doc" : undefined);
      if ("dialog" in a && a.dialog) for (const k of ["title", "description", "submit", "badge"] as const) textOk(a.dialog[k], `${where}.dialog.${k}`, row);
      if ("wait" in a && a.wait) {
        for (const [w, at] of [[a.wait, `${where}.wait`] as const, ...(a.wait.follow ?? []).map((f, k) => [f, `${where}.wait.follow[${k}]`] as const)]) {
          const job = m.jobs?.[w.job];
          if (!job) e.push(`${at}.job names ${w.job}, which is not a job`);
          else if ((w.keyPrefix?.length ?? 0) > job.key.length) e.push(`${at}.keyPrefix has more parts than ${w.job}'s key`);
          w.keyPrefix?.forEach((x, k) => formValueOk(x, `${at}.keyPrefix[${k}]`));
        }
        // The toast reads the module's page open when the job is done: this one, or the one `then` opens.
        const then = "then" in a ? (typeof a.then === "string" ? a.then : (a.then as { path?: string } | undefined)?.path) : undefined;
        const opened = then === undefined ? undefined : m.pages.find((pg) => { const x = segmentsOf(pg.path), y = segmentsOf(then.split("?")[0]); return x.length === y.length && x.every((sg, i) => sg.startsWith(":") || y[i].startsWith(":") || sg === y[i]); });
        textOk(a.wait.toast, `${where}.wait.toast`, row, ["call" in a ? "result,job" : "job", ...Object.keys(opened?.bind ?? {})].join(","));
        if (a.wait.busy !== undefined) textOk(a.wait.busy, `${where}.wait.busy`, row);
      }
      if ("menu" in a) {
        if (row) e.push(`${where}: a menu sits in a page's actions, not on a row`);
        a.items.forEach((x, k) => { action(x, `${where}.items[${k}]`, false); textOk(x.line, `${where}.items[${k}].line`, false); });
        return;
      }
      if ("viewAs" in a) {
        textOk(a.label, `${where}.label`, row);
        formValueOk(a.viewAs, `${where}.viewAs`);
        if (a.viewAs !== null && typeof a.viewAs === "object" && "row" in a.viewAs && !row) e.push(`${where}.viewAs names the row's ${a.viewAs.row}, but the action isn't on a table's row`);
        if (a.path !== undefined) {
          textOk(a.path, `${where}.path`, row);
          if (!namesPage(m.pages, a.path.replace(PLACEHOLDER, "x"))) e.push(`${where}.path names ${a.path}, which is not a page`);
        }
        return;
      }
      if (a.when && "page" in a.when) {
        // A page value's `when`: a URL parameter, a route parameter, or a bound doc's field.
        const pv = a.when.page;
        if ("route" in pv && !params.includes(pv.route)) e.push(`${where}.when.page names :${pv.route}, which ${p.path} doesn't have`);
        if ("bind" in pv) oneBind(pv.bind, `${where}.when.page.bind`);
      } else if (a.when && !callRows) {
        const c = m.collections[("target" in a && a.target ? bindCollection(a.target) : rowCollection) ?? ""];
        if (!c) e.push(`${where}.when needs a doc: a table's row or a target`);
        else if (!c.schema.value[a.when.field]) e.push(`${where}.when.field names ${a.when.field}, which is not a field of the doc`);
      }
      // A row's field: only on a row, and on a doc's row, one of its fields.
      const values: Array<[string, FormExpr | undefined]> = [
        ...("key" in a ? [[`${where}.key`, a.key] as [string, FormExpr | undefined]] : []),
        ...Object.entries(("fixed" in a ? a.fixed : undefined) ?? {}).map(([k, x]) => [`${where}.fixed.${k}`, x] as [string, FormExpr]),
        ...Object.entries(("initial" in a ? a.initial : undefined) ?? {}).map(([k, x]) => [`${where}.initial.${k}`, x] as [string, FormExpr]),
        ...Object.entries(("args" in a ? a.args : undefined) ?? {}).map(([k, x]) => [`${where}.args.${k}`, x] as [string, FormExpr]),
      ];
      for (const [at2, x] of values) {
        if (x === null || typeof x !== "object" || !("row" in x)) continue;
        if (!row) e.push(`${at2} names the row's ${x.row}, but the action isn't on a table's row`);
        else if (!callRows && rowCollection && !["key", "version", "owner", "parentKey"].includes(x.row) && !m.collections[rowCollection]?.schema.value[x.row]) e.push(`${at2} names ${x.row}, which is not metadata or a field of the row`);
      }
      if ("key" in a && a.key !== undefined) {
        if (!row) e.push(`${where}.key is for an action on a table's row: elsewhere it names its doc by target`);
        if ("target" in a && a.target !== undefined) e.push(`${where} names its doc by target or by key, not both`);
        if (a.key !== null && typeof a.key === "object" && "today" in a.key) e.push(`${where}.key names today, not a doc`);
      }
      if ("navigate" in a) {
        textOk(a.navigate, `${where}.navigate`, row);
        if (!namesPage(m.pages, a.navigate.replace(PLACEHOLDER, "x"))) e.push(`${where}.navigate names ${a.navigate}, which is not a page`);
        if (a.report) {
          const target = m.pages.find((pg) => { const x = segmentsOf(pg.path), y = segmentsOf(a.navigate.split("?")[0]); return x.length === y.length && x.every((sg, i) => sg.startsWith(":") || y[i].startsWith(":") || y[i].includes("{$") || sg === y[i]); });
          const rn = target ? flatNodes(target.body).find((x): x is Extract<Node, { c: "report" }> => x.c === "report" && x.id === a.report!.id) : undefined;
          if (!rn) e.push(`${where}.report.id names ${a.report.id}, which is not a report on ${a.navigate}`);
          else reportShapeOk(m, { collection: rn.collection, ...a.report }, `${where}.report`, e);
        }
        if (a.target !== undefined) oneBind(a.target, `${where}.target`);
        if (callRows) return;
        const fields = new Set([...Object.keys(m.collections[rowCollection ?? ""]?.schema.value ?? {}), ...Object.keys(m.collections[a.target ? bindCollection(a.target) ?? "" : ""]?.schema.value ?? {})]);
        for (const param of linkParams(a.navigate)) if (param !== "key" && !params.includes(param) && !fields.has(param)) e.push(`${where}.navigate fills :${param}, which is not key, a field of the row or of its target, or a route parameter`);
        return;
      }
      if ("print" in a || "pdf" in a) { if (row) e.push(`${where}: a page prints whole, not from a row`); if ("pdf" in a) textOk(a.toast, `${where}.toast`, false); return; }
      if ("canon" in a) {
        for (const [k, t] of Object.entries(a.query ?? {})) textOk(t, `${where}.query.${k}`, row);
        const to = RECORD_PAGES[a.canon];
        if (!to) { if (a.bind !== undefined || a.ref !== undefined) e.push(`${where}: only a deal, company or person link names a bind and a ref`); return; }
        if (a.bind === undefined || a.ref === undefined) return e.push(`${where}: a ${a.canon} link names the doc (bind) and its ${to} ref (ref)`);
        oneBind(a.bind, `${where}.bind`);
        const c = m.collections[bindCollection(a.bind) ?? ""];
        // A deal's record page is named by its ledger stream, which only a join reads; a company's or person's by the ref.
        if ((to === "deals" && !binds[a.bind]?.join?.includes(a.ref)) || refOf(c?.schema.value[a.ref])?.to !== to) e.push(`${where}.ref names ${a.ref}, which is not a ${to === "deals" ? "joined deal" : to} ref of ${a.bind}`);
        return;
      }
      if ("csvImport" in a) {
        if (!m.csvImports?.[a.csvImport]) e.push(`${where}.csvImport names ${a.csvImport}, which is not a CSV import`);
        if (row) e.push(`${where}: a CSV import sits in a page's actions, not on a row`);
        return;
      }
      if ("export" in a) {
        const x = m.exports?.[a.export];
        if (!x) return e.push(`${where}.export names ${a.export}, which is not an export`);
        const takes = "people" in x ? { [x.people.key.arg]: "string" } : "view" in x ? m.views[x.view]?.args ?? {} : m.calls?.[x.call]?.args?.value ?? {};
        for (const [k, v] of Object.entries(a.args ?? {})) { if (!Object.hasOwn(takes, k)) e.push(`${where}.args.${k} is not an argument of ${a.export}`); formValueOk(v, `${where}.args.${k}`); }
        if ("people" in x && a.formats?.some((format) => format !== "csv")) e.push(`${where}: a people export supports only CSV`);
        if (a.members) {
          const spec = (takes as Record<string, FieldSpec | string>)[a.members.arg];
          if (!("call" in x) || !spec || typeof spec === "string" || coreOf(spec.fieldType).type !== "array") e.push(`${where}.members.arg: ${a.export}'s call must take ${a.members.arg}, a list of member ids`);
          if (Object.hasOwn(a.args ?? {}, a.members.arg)) e.push(`${where}.members.arg is fixed in args too`);
          textOk(a.members.label, `${where}.members.label`, row);
        }
        a.picks?.forEach((pk, k) => {
          const spec = (takes as Record<string, FieldSpec | string>)[pk.arg];
          if (!("call" in x) || !spec || typeof spec === "string" || coreOf(spec.fieldType).type !== "array") e.push(`${where}.picks[${k}].arg: ${a.export}'s call must take ${pk.arg}, a list`);
          if (Object.hasOwn(a.args ?? {}, pk.arg) || pk.arg === a.members?.arg) e.push(`${where}.picks[${k}].arg is given another way too`);
          textOk(pk.label, `${where}.picks[${k}].label`, row); optionsOk(pk.options, `${where}.picks[${k}].options`, row);
          if (pk.options.by) e.push(`${where}.picks[${k}].options.by is for a form field with declared siblings`);
        });
        if (a.count) {
          if (!a.members && !a.picks?.length) e.push(`${where}.count counts per member or pick: give members or picks`);
          if (listBind(a.count.from, `${where}.count.from`)) {
            if (a.count.member) rowPathOk(a.count.member, a.count.from, `${where}.count.member`);
            for (const [arg, path] of Object.entries(a.count.picks ?? {})) {
              if (!a.picks?.some((pk) => pk.arg === arg)) e.push(`${where}.count.picks.${arg} names no pick`);
              rowPathOk(path, a.count.from, `${where}.count.picks.${arg}`);
            }
          }
          textOk(a.count.label, `${where}.count.label`, row);
        }
        if (a.formats?.includes("pdf") && !x.pdf) e.push(`${where}.formats offers a PDF, but ${a.export} declares no pdf page`);
        return;
      }
      if ("call" in a) {
        const call = m.calls?.[a.call];
        if (!call) return e.push(`${where}.call names ${a.call}, which is not a call`);
        for (const [k, x] of Object.entries(a.args ?? {})) {
          if (!Object.hasOwn(call.args?.value ?? {}, k)) e.push(`${where}.args.${k} is not an argument of ${a.call}`);
          formValueOk(x, `${where}.args.${k}`);
        }
        for (const [k, x] of Object.entries(a.initial ?? {})) {
          if (!Object.hasOwn(call.args?.value ?? {}, k) || Object.hasOwn(a.args ?? {}, k)) e.push(`${where}.initial.${k} must name an editable call argument`);
          if (x && typeof x === "object" && "text" in x) textOk(x.text, `${where}.initial.${k}`, row);
          else formValueOk(x as FormExpr, `${where}.initial.${k}`);
        }
        // Its dialog's own words per argument, and options from a binding (Test a deal: the plan's reps).
        a.fields?.forEach((f, k) => {
          if (f.rows) e.push(`${where}.fields[${k}].rows is for a transition's per-row choice`);
          textOk(f.label, `${where}.fields[${k}].label`, row); textOk(f.help, `${where}.fields[${k}].help`, row); textOk(f.placeholder, `${where}.fields[${k}].placeholder`, row);
          fieldOptionsOk(f, call.args?.value[f.field], `${where}.fields[${k}]`, row, call.args);
          if (!Object.hasOwn(call.args?.value ?? {}, f.field)) e.push(`${where}.fields[${k}] names ${f.field}, which ${a.call} doesn't take`);
          if (Object.hasOwn(a.args ?? {}, f.field)) e.push(`${where}.fields[${k}] names ${f.field}, which args gives`);
        });
        if (a.then !== undefined) {
          // It opens a page its value names: `:key` and the other `:params` from the value's fields.
          if (call.returns !== "value") e.push(`${where}.then opens a page from ${a.call}'s value, but it returns none`);
          if (!namesPage(m.pages, a.then)) e.push(`${where}.then names ${a.then}, which is not a page`);
        }
        return;
      }
      if ("transition" in a) {
        if (a.target !== undefined) oneBind(a.target, `${where}.target`);
        else if (!row) e.push(`${where}: a transition needs a target`);
        else if (callRows && a.key === undefined) e.push(`${where}.key is missing: a call's row names the doc the transition moves`);
        // A row action with `key` moves the doc a row field names, of any collection: Hold on another collection's doc.
        machineOn(a.machine, `${where}.machine`, a.target !== undefined ? bindCollection(a.target) : callRows || a.key !== undefined ? undefined : rowCollection);
        const t = m.machines?.[a.machine]?.transitions[a.transition];
        if (m.machines?.[a.machine] && !t) e.push(`${where}.transition names ${a.transition}, which ${a.machine} doesn't have`);
        const takes = t?.args?.type === "object" ? t.args.value : {};
        a.fields?.forEach((f, k) => {
          if (f.rows) {
            const fat = `${where}.fields[${k}].rows`;
            const spec = takes[f.field];
            const rec = spec ? coreOf(spec.fieldType) : null;
            if (spec && (rec?.type !== "record" || coreOf(rec.keys).type !== "string" || !literalChoices(coreOf(rec.values.fieldType)))) e.push(`${fat}: ${f.field} must be a record of text keys to a choice, one per row`);
            if (callBind(f.rows.from) || listBind(f.rows.from, `${fat}.from`)) {
              if (f.rows.list !== undefined && !callBind(f.rows.from)) e.push(`${fat}.list is for a call's value, not a list of docs`);
              textOk(f.rows.title, `${fat}.title`, true);
              for (const x of [f.rows.value, f.rows.initial]) if (x !== undefined) rowPathOk(x, f.rows.from, `${fat}`);
              if (f.rows.options) {
                rowPathOk(f.rows.options.list, f.rows.from, `${fat}.options.list`);
                textOk(f.rows.options.label, `${fat}.options.label`, true, "item");
              }
            }
            if (f.rows && f.options) e.push(`${where}.fields[${k}]: use rows.options for choices belonging to each row`);
            if (f.widget) e.push(`${where}.fields[${k}]: a per-row choice picks its own widget`);
          }
          textOk(f.help, `${where}.fields[${k}].help`, row); textOk(f.placeholder, `${where}.fields[${k}].placeholder`, row);
          fieldOptionsOk(f, takes[f.field], `${where}.fields[${k}]`, row, t?.args);
          if (!Object.hasOwn(takes, f.field)) e.push(`${where}.fields[${k}] names ${f.field}, which ${a.transition} doesn't take`);
          else if (f.widget && !f.rows && !widgetFits(f.widget, takes[f.field])) e.push(`${where}.fields[${k}]: a ${f.widget} widget can't edit ${f.field}`);
          if (Object.hasOwn(a.fixed ?? {}, f.field)) e.push(`${where}.fields[${k}] names ${f.field}, which fixed gives`);
        });
        for (const [k, v] of Object.entries(a.initial ?? {})) {
          if (!Object.hasOwn(takes, k)) e.push(`${where}.initial.${k} names ${k}, which ${a.transition} doesn't take`);
          if (Object.hasOwn(a.fixed ?? {}, k)) e.push(`${where}.initial.${k} is fixed too: an argument is fixed or starts from a value, not both`);
          initialOk(v, `${where}.initial.${k}`, row);
        }
        for (const [k, v] of Object.entries(a.fixed ?? {})) {
          if (!Object.hasOwn(takes, k)) e.push(`${where}.fixed.${k} names ${k}, which ${a.transition} doesn't take`);
          if (v !== null && typeof v === "object" && "bind" in v) { if (!Object.hasOwn(binds, v.bind)) e.push(`${where}.fixed.${k} names ${v.bind}, which the page doesn't bind`); }
          else pageExprOk(v as PageExpr, `${where}.fixed.${k}`);
        }
        if (a.fields) for (const [k, spec] of Object.entries(takes)) if (!spec.optional && !a.fields.some((f) => f.field === k) && !Object.hasOwn(a.fixed ?? {}, k)) e.push(`${where}.fields leaves out ${k}, which ${a.transition} needs: list it or fix it`);
        if (a.then !== undefined && typeof a.then === "object" && a.then.created === undefined) {
          // It opens a page once it has run: My plan after a plan is accepted.
          if (!namesPage(m.pages, a.then.path)) e.push(`${where}.then names ${a.then.path}, which is not a page`);
        } else if (a.then !== undefined && t) {
          // It opens a doc the transition's own effects create (or copy).
          const made = (t.effects ?? []).filter((fx) => "create" in fx || "copy" in fx) as Array<{ as?: string }>;
          const named = typeof a.then === "string" || a.then.created === true ? null : a.then.created!;
          const path = typeof a.then === "string" ? a.then : a.then.path;
          if (!made.length) e.push(`${where}.then opens the doc ${a.transition} creates, but its effects create none`);
          else if (named !== null && !made.some((fx) => fx.as === named)) e.push(`${where}.then.created names ${named}, which no create or copy effect of ${a.transition} is \`as\``);
          // Canon returns the docs a transition created by their `as`: one without it can't be opened.
          else if (named === null && !made.some((fx) => fx.as !== undefined)) e.push(`${where}.then opens the doc ${a.transition} creates, but none of its create or copy effects is named: give one an \`as\``);
          if (path !== undefined && !namesPage(m.pages, path)) e.push(`${where}.then names ${path}, which is not a page`);
          if (path === undefined && !row && !params.includes("key")) e.push(`${where}.then needs a path: the action is on no table's row and this page has no :key`);
        }
        return;
      }
      const op = m.ops[a.op];
      if (!op) return e.push(`${where}.op names ${a.op}, which is not an op`);
      if (a.target !== undefined && !Object.hasOwn(binds, a.target)) e.push(`${where}.target names ${a.target}, which the page doesn't bind`);
      if (op.kind !== "create" && a.target === undefined && !row) e.push(`${where}: ${a.op} ${op.kind}s a doc, so it needs a target`);
      if (op.kind !== "create" && callRows && a.key === undefined) e.push(`${where}.key is missing: a call's row names the doc ${a.op} ${op.kind}s`);
      if (op.kind === "create" && a.key !== undefined) e.push(`${where}.key is for an update or a delete`);
      if (op.kind === "create" && m.collections[op.collection]?.setOf && a.parent === undefined) e.push(`${where}.parent is missing: ${a.op} creates a doc in a set`);
      pageExprOk(a.parent, `${where}.parent`);
      if (a.then !== undefined && !namesPage(m.pages, a.then)) e.push(`${where}.then names ${a.then}, which is not a page`);
      if (a.fields && op.kind === "delete") e.push(`${where}.fields: a delete asks nothing`);
      a.fields?.forEach((f, k) => {
        if (f.rows) e.push(`${where}.fields[${k}].rows is for a transition's per-row choice`);
        textOk(f.label, `${where}.fields[${k}].label`, row); textOk(f.help, `${where}.fields[${k}].help`, row); textOk(f.placeholder, `${where}.fields[${k}].placeholder`, row);
        fieldOptionsOk(f, m.collections[op.collection]?.schema.value[f.field], `${where}.fields[${k}]`, row, m.collections[op.collection]?.schema);
        if (!op.fields?.includes(f.field)) e.push(`${where}.fields[${k}] names ${f.field}, which ${a.op} doesn't write`);
        if (Object.hasOwn(a.fixed ?? {}, f.field)) e.push(`${where}.fields[${k}] names ${f.field}, which fixed gives`);
      });
      prefillOk(a, a.op, where);
    };
    /** A dialog's starting value: a page value, a bound doc's or the row's field, today, or a text over them. */
    const initialOk = (x: InitialExpr, where: string, row: boolean) => {
      if (x !== null && typeof x === "object" && "text" in x) return textOk(x.text, `${where}.text`, row);
      if (x !== null && typeof x === "object" && "row" in x && !row) return void e.push(`${where} names the row's ${x.row}, but the action isn't on a table's row`);
      formValueOk(x, where);
    };
    /** A form's or an op action's `fixed` and `initial`: fields its op writes, from the route, the caller or a bound doc. */
    const prefillOk = (x: FormPrefill, opName: string, where: string) => {
      const op = m.ops[opName];
      if (!op) return;
      for (const kind of ["fixed", "initial"] as const) {
        for (const [f, v] of Object.entries(x[kind] ?? {})) {
          if (op.kind === "delete") { e.push(`${where}.${kind} is not for a delete`); break; }
          if (!op.fields?.includes(f)) e.push(`${where}.${kind}.${f} names ${f}, which ${opName} doesn't write`);
          if (v !== null && typeof v === "object" && "json" in v) {
            const field = m.collections[op.collection]?.schema.value[f];
            if (kind !== "fixed" || !field || !isPeopleFilterField(field)) e.push(`${where}.${kind}.${f}: JSON query prefills currently take a fixed People filter`);
          }
          else if (v !== null && typeof v === "object" && "text" in v) { if (kind === "fixed") e.push(`${where}.fixed.${f}: a text is for initial`); else textOk(v.text, `${where}.initial.${f}.text`, true); }
          else if (v !== null && typeof v === "object" && "bind" in v) { if (!Object.hasOwn(binds, v.bind)) e.push(`${where}.${kind}.${f} names ${v.bind}, which the page doesn't bind`); }
          else pageExprOk(v as PageExpr, `${where}.${kind}.${f}`);
        }
      }
      for (const f of Object.keys(x.fixed ?? {})) if (Object.hasOwn(x.initial ?? {}, f)) e.push(`${where}.initial.${f} is fixed too: a field is fixed or starts from a value, not both`);
    };
    const editorCallOk = (ref: EditorCall, inputs: string[], where: string, readOnly: boolean) => {
      action(ref, where, true, undefined, true);
      const call = m.calls?.[ref.call];
      if (!call) return;
      if (call.confirm || call.canon || call.ai || call.step || call.system) e.push(`${where}.call needs a direct member call without a confirmation, hosted step or Canon operation`);
      if (call.returns !== "value") e.push(`${where}.call must return its value`);
      if ((call.writes.length === 0) !== readOnly) e.push(`${where}.call must be ${readOnly ? "read-only" : "a writing call"}`);
      for (const input of inputs) {
        if (!Object.hasOwn(call.args?.value ?? {}, input) || Object.hasOwn(ref.args ?? {}, input)) e.push(`${where} must name an unfixed argument ${input}`);
      }
      for (const [key, spec] of Object.entries(call.args?.value ?? {})) if (!spec.optional && !inputs.includes(key) && !Object.hasOwn(ref.args ?? {}, key)) e.push(`${where} does not supply required argument ${key}`);
    };
    const inlineEditOk = (edit: InlineEdit, where: string) => {
      editorCallOk(edit, [edit.arg], where, false);
      if (edit.versionArg === edit.arg || !Object.hasOwn(edit.args ?? {}, edit.versionArg)) e.push(`${where}.versionArg must name a fixed version argument`);
      const boundVersion = (ref: EditorCall) => { const bound = ref.args?.[edit.versionArg]; return bound !== null && typeof bound === "object" && "row" in bound && bound.row === edit.version; };
      if (!boundVersion(edit) || edit.validate && !boundVersion(edit.validate)) e.push(`${where}.versionArg must bind the declared version row value`);
      const takes = m.calls?.[edit.call]?.args?.value;
      if (takes && (coreOf(takes[edit.arg]?.fieldType ?? { type: "null" }).type !== "string" || coreOf(takes[edit.versionArg]?.fieldType ?? { type: "null" }).type !== "number")) e.push(`${where} needs text and numeric version arguments`);
      if (edit.validate) {
        editorCallOk(edit.validate, [edit.arg], `${where}.validate`, true);
        if (coreOf(m.calls?.[edit.validate.call]?.args?.value[edit.arg]?.fieldType ?? { type: "null" }).type !== "string") e.push(`${where}.validate must take the edited text argument`);
        if (!Object.hasOwn(edit.validate.args ?? {}, edit.versionArg)) e.push(`${where}.validate must bind its version argument`);
      }
    };
    const walk = (list: readonly Node[], where: string) => list.forEach((n, j) => {
      const nat = `${where}[${j}]`;
      if (n.when && !Object.hasOwn(binds, n.when.bind) && n.when.bind !== "notifications") e.push(`${nat}.when.bind names ${n.when.bind}, which the page doesn't bind`);
      // `empty` on a one-doc binding: whether there is no such doc (no queue loaded yet).
      else if (n.when && "empty" in n.when && !canonBind(n.when.bind) && !(binds[n.when.bind]?.view && m.views[binds[n.when.bind].view!]?.kind === "one")) listBind(n.when.bind, `${nat}.when.bind`);
      switch (n.c) {
        case "pacing": {
          if (pacings.has(n.id)) e.push(`${nat}.id is a pacing component of another page`);
          pacings.add(n.id);
          if (n.target !== undefined && (binds[n.target]?.canon !== "targets.forYear" || Object.keys(binds[n.target]?.args ?? {}).length)) e.push(`${nat}.target needs a targets.forYear binding without arguments; pacing selects its fiscal years`);
          if (n.target !== undefined) for (const field of ["year", "fyStart", "total", "teamMonths", "repMonths", "coverage"] as const) if (!m.reads?.targets?.includes(field)) e.push(`${nat}.target needs reads.targets.${field}`);
          n.sources.forEach((src, i) => {
            const at = `${nat}.sources[${i}]`;
            if (n.sources.findIndex((x) => x.id === src.id) !== i) e.push(`${at}.id is duplicated`);
            if (!src.collection.startsWith("canon.") || !grantsSource(m, src.collection) || src.collection === "canon.members") e.push(`${at}.collection needs a Canon record source the module reads`);
            const fields = sourceFields(m, src.collection);
            if (fields) {
              const date = fields.find((f) => f.name === src.date);
              const amount = fields.find((f) => f.name === src.amount);
              if (!date || date.join || date.related || !["date", "datetime"].includes(date.type)) e.push(`${at}.date needs a date or datetime of the source`);
              if (!amount || amount.join || amount.related || amount.type !== "currency") e.push(`${at}.amount needs a money field of the source`);
              for (const f of src.filter ?? []) if (!fields.some((x) => x.name === f.field && !x.join && !x.related)) e.push(`${at}.filter names a field the source does not read`);
            }
            if (src.filter?.some((f) => f.field === src.date)) e.push(`${at}.filter must leave the pacing date to the component`);
          });
          break;
        }
        case "dashboards":
          if (p.path.includes(":")) e.push(`${nat} needs a static page path so a report can link to its dashboards`);
          break;
        case "header": textOk(n.title, `${nat}.title`, false); textOk(n.subtitle, `${nat}.subtitle`, false); n.actions?.forEach((a, k) => action(a, `${nat}.actions[${k}]`, false)); break;
        case "prose": textOk(n.text, `${nat}.text`, false); break;
        case "empty": textOk(n.text, `${nat}.text`, false); if (n.action) action(n.action, `${nat}.action`, false); break;
        case "actions":
          if ((n.items === undefined) === (n.machine === undefined)) e.push(`${nat} needs items or a machine, not both`);
          n.items?.forEach((a, k) => action(a, `${nat}.items[${k}]`, false));
          if (n.machine !== undefined) {
            if (n.target === undefined) e.push(`${nat}.target is missing: the doc the machine's transitions move`);
            else oneBind(n.target, `${nat}.target`);
            machineOn(n.machine, `${nat}.machine`, n.target !== undefined ? bindCollection(n.target) : undefined);
          } else if (n.target !== undefined) e.push(`${nat}.target is only for a machine`);
          break;
        case "banner":
          textOk(n.text, `${nat}.text`, false); n.actions?.forEach((a, k) => action(a, `${nat}.actions[${k}]`, false));
          if (n.list) { if (!Object.hasOwn(binds, n.list.from)) e.push(`${nat}.list.from names ${n.list.from}, which the page doesn't bind`); textOk(n.list.label, `${nat}.list.label`, true); }
          break;
        case "statusSteps": {
          oneBind(n.from, `${nat}.from`);
          machineOn(n.machine, `${nat}.machine`, bindCollection(n.from));
          const states = m.machines?.[n.machine]?.states ?? [];
          n.steps?.forEach((s, k) => { if (!states.includes(s)) e.push(`${nat}.steps[${k}] names ${s}, which is not a state of ${n.machine}`); });
          break;
        }
        case "timeline": {
          oneBind(n.of, `${nat}.of`);
          const h = n.hide;
          if (h && !h.actors && !h.events) e.push(`${nat}.hide needs actors or events: what it hides`);
          const c = bindCollection(n.of);
          // An event is named by its kind or its verb: a transition of a machine over the doc's collection, or an op on it.
          const verbs = new Set(["create", "update", "delete", "event", "transition", "propose",
            ...Object.entries(m.machines ?? {}).filter(([, mc]) => mc.collection === c).flatMap(([mn, mc]) => Object.keys(mc.transitions).map((t) => `${mn}.${t}`)),
            ...Object.entries(m.ops).filter(([, op]) => op.collection === c).map(([name]) => name)]);
          for (const k of ["events", "keep"] as const) h?.[k]?.forEach((v, j) => { if (c && !verbs.has(v)) e.push(`${nat}.hide.${k}[${j}] names ${v}, which is no kind of event, transition or op of ${c}`); });
          break;
        }
        case "tabs":
          if (n.param !== undefined && n.tabs.some((t) => t.id === undefined)) e.push(`${nat}.param needs an id on every tab: the URL names the open tab by it`);
          n.tabs.forEach((t, k) => { if (t.id !== undefined && n.tabs.findIndex((x) => x.id === t.id) !== k) e.push(`${nat}.tabs[${k}].id ${t.id} is there twice`); });
          n.tabs.forEach((t, k) => { textOk(t.label, `${nat}.tabs[${k}].label`, false); walk(t.body, `${nat}.tabs[${k}].body`); });
          break;
        case "queue":
          n.sources.forEach((src, k) => {
            const sat = `${nat}.sources[${k}]`;
            const view = m.views[binds[src.from]?.view ?? ""];
            if (!binds[src.from]) return e.push(`${sat}.from names ${src.from}, which the page doesn't bind`);
            if (binds[src.from].call !== undefined) return e.push(`${sat}.from names ${src.from}, which binds a call's value, not docs`);
            if (canonBind(src.from)) return e.push(`${sat}.from names ${src.from}, which ${CANON_ROWS}`);
            if (view && view.kind !== "list") e.push(`${sat}.from names ${src.from}, which binds one doc, not a list`);
            textOk(src.title, `${sat}.title`, true); textOk(src.subtitle, `${sat}.subtitle`, true);
            if (src.date !== undefined) rowPathOk(src.date, src.from, `${sat}.date`);
            if (src.link !== undefined) linkOk(src.link, src.from, `${sat}.link`);
            src.actions?.forEach((a, j) => action(a, `${sat}.actions[${j}]`, true, view?.collection));
            if (src.attention && view && !m.collections[view.collection]?.schema.value[src.attention.field]) e.push(`${sat}.attention.field names ${src.attention.field}, which is not a field of ${view.collection}`);
          });
          if (n.filters && !n.sources.some((x) => x.attention) && n.sources.length < 2) e.push(`${nat}.filters needs two sources or a source's attention to filter by`);
          textOk(n.empty, `${nat}.empty`, false);
          break;
        case "jobStatus": {
          const job = m.jobs?.[n.job];
          if (!job) { e.push(`${nat}.job names ${n.job}, which is not a job`); break; }
          if ((n.keyPrefix?.length ?? 0) > job.key.length) e.push(`${nat}.keyPrefix has more parts than ${n.job}'s key`);
          n.keyPrefix?.forEach((x, k) => {
            if (rowOrToday(x, `${nat}.keyPrefix[${k}]`)) return;
            if (x !== null && typeof x === "object" && "bind" in x) { if (!Object.hasOwn(binds, x.bind)) e.push(`${nat}.keyPrefix[${k}] names ${x.bind}, which the page doesn't bind`); }
            else pageExprOk(x as PageExpr, `${nat}.keyPrefix[${k}]`);
          });
          break;
        }
        case "detail": n.items.forEach((x, k) => textOk(x.value, `${nat}.items[${k}].value`, false)); break;
        case "kpis":
          n.items.forEach((x, k) => {
            const kat = `${nat}.items[${k}]`;
            textOk(x.tone?.by, `${kat}.tone.by`, false); textOk(x.trend, `${kat}.trend`, false); textOk(x.hint, `${kat}.hint`, false);
            if ("value" in x) textOk(x.value, `${kat}.value`, false);
            else if ("total" in x) { if (listBind(x.total.from, `${kat}.total.from`)) rowPathOk(x.total.sum, x.total.from, `${kat}.total.sum`); }
            else listBind(x.count, `${kat}.count`);
          });
          break;
        case "transcript": {
          if (!rowOrToday(n.call, `${nat}.call`)) {
            const x = n.call;
            if (x !== null && typeof x === "object" && "bind" in x) {
              oneBind(x.bind, `${nat}.call`);
              const c = m.collections[bindCollection(x.bind) ?? ""];
              if (c && x.field !== "key" && !c.schema.value[x.field]) e.push(`${nat}.call.field names ${x.field}, which is not a field of ${bindCollection(x.bind)}`);
            } else pageExprOk(x as PageExpr, `${nat}.call`);
          }
          textOk(n.empty, `${nat}.empty`, false);
          n.highlights?.forEach((h, k) => {
            const hat = `${nat}.highlights[${k}]`;
            if (!listBind(h.from, `${hat}.from`)) return;
            textOk(h.label, `${hat}.label`, true);
            const by = h.tone !== undefined && typeof h.tone === "object" ? h.tone.by : undefined;
            if (h.list !== undefined) {
              rowPathOk(h.list, h.from, `${hat}.list`);
              const spec = m.collections[bindCollection(h.from) ?? ""]?.schema.value[h.list];
              if (spec && coreOf(spec.fieldType).type !== "array") e.push(`${hat}.list names ${h.list}, which is not a list field of ${h.from}'s rows`);
            } else for (const [kk, path] of [["segment", h.segment], ["start", h.start], ["end", h.end], ["tone.by", by]] as const) if (path !== undefined) rowPathOk(path, h.from, `${hat}.${kk}`);
          });
          n.lineActions?.forEach((a, k) => {
            const aat = `${nat}.lineActions[${k}]`;
            if (!("op" in a) || m.ops[a.op]?.kind !== "create") return e.push(`${aat}: a line's action is an op that creates a doc`);
            action(a, aat, true, undefined, true);
            for (const [f, x] of Object.entries({ ...(a.fixed ?? {}), ...(a.initial ?? {}) })) {
              if (x !== null && typeof x === "object" && "row" in x && !(TRANSCRIPT_LINE_FIELDS as readonly string[]).includes(x.row)) e.push(`${aat}.${f} names the line's ${x.row}, which is not one of ${TRANSCRIPT_LINE_FIELDS.join(", ")}`);
            }
          });
          break;
        }
        case "phone": {
          if ("record" in n) {
            pageExprOk(n.record, `${nat}.record`);
            if (!callBind(n.from)) e.push(`${nat}.from must bind a read-only call's value`);
            if (!m.reads?.people?.includes("phone")) e.push(`${nat} requires reads.people to grant phone`);
            break;
          }
          if (!listBind(n.from, `${nat}.from`)) break;
          for (const k of ["person", "name", "phone"] as const) rowPathOk(n[k], n.from, `${nat}.${k}`);
          if (n.detail !== undefined) textOk(n.detail, `${nat}.detail`, true);
          if (n.empty !== undefined) textOk(n.empty, `${nat}.empty`, false);
          if (n.skip) action(n.skip, `${nat}.skip`, true, bindCollection(n.from));
          for (const [x, where] of [[n.campaign?.id, `${nat}.campaign.id`], [n.since, `${nat}.since`]] as const) {
            if (x === undefined || rowOrToday(x, where)) continue;
            if (x !== null && typeof x === "object" && "bind" in x) oneBind(x.bind, where);
            else pageExprOk(x as PageExpr, where);
          }
          if (n.campaign) textOk(n.campaign.name, `${nat}.campaign.name`, false);
          break;
        }
        case "thread": {
          if (!listBind(n.from, `${nat}.from`)) break;
          rowPathOk(n.body, n.from, `${nat}.body`);
          for (const k of ["author", "at"] as const) if (n[k] !== undefined && n[k] !== "createdAt" && n[k] !== "updatedAt") rowPathOk(n[k]!, n.from, `${nat}.${k}`);
          textOk(n.empty, `${nat}.empty`, false);
          if (n.post) {
            textOk(n.post.placeholder, `${nat}.post.placeholder`, false);
            const op = m.ops[n.post.op];
            if (!op) { e.push(`${nat}.post.op names ${n.post.op}, which is not an op`); break; }
            if (op.kind !== "create" || op.collection !== bindCollection(n.from)) e.push(`${nat}.post.op names ${n.post.op}, which doesn't create ${bindCollection(n.from)} docs`);
            if (!op.fields?.includes(n.post.field)) e.push(`${nat}.post.field names ${n.post.field}, which ${n.post.op} doesn't write`);
            // In a row's expansion the thread posts under the doc the row names (`{ "row": "key" }`).
            const pp = n.post.parent;
            if (pp !== null && typeof pp === "object" && "row" in pp) { if (!inRow) e.push(`${nat}.post.parent names the row, but the thread isn't in a row's expansion`); }
            else if (pp !== null && typeof pp === "object" && "root" in pp) e.push(`${nat}.post.parent.root is only for a share thread`);
            else pageExprOk(pp, `${nat}.post.parent`);
          }
          break;
        }
        case "approvalChain": {
          if (!listBind(n.from, `${nat}.from`)) break;
          textOk(n.title, `${nat}.title`, true); textOk(n.note, `${nat}.note`, true); textOk(n.empty, `${nat}.empty`, false);
          for (const k of ["approver", "state", "at", "order"] as const) if (n[k] !== undefined && n[k] !== "createdAt" && n[k] !== "updatedAt") rowPathOk(n[k]!, n.from, `${nat}.${k}`);
          if ((n.state === undefined) === (n.progress === undefined)) e.push(`${nat} needs state (each step's field) or progress (where its doc stands), one of them`);
          if (n.progress) {
            oneBind(n.progress.of, `${nat}.progress.of`);
            const pc = m.collections[bindCollection(n.progress.of) ?? ""];
            for (const [k, f] of [["at", n.progress.at], ["complete", n.progress.complete?.field], ["failed", n.progress.failed?.field]] as const) if (pc && f !== undefined && !pc.schema.value[f]) e.push(`${nat}.progress.${k} names ${f}, which is not a field of ${bindCollection(n.progress.of)}`);
            rowPathOk(n.progress.by, n.from, `${nat}.progress.by`);
          }
          n.actions?.forEach((a, k) => action(a, `${nat}.actions[${k}]`, true, bindCollection(n.from)));
          break;
        }
        case "periodNav": {
          if (!listBind(n.from, `${nat}.from`)) break;
          textOk(n.label, `${nat}.label`, true);
          linkOk(n.link, n.from, `${nat}.link`);
          if (n.sort !== undefined) rowPathOk(n.sort, n.from, `${nat}.sort`);
          const cur = n.current;
          if (rowOrToday(cur, `${nat}.current`)) break;
          if (cur !== null && typeof cur === "object" && "bind" in cur) { if (!Object.hasOwn(binds, cur.bind)) e.push(`${nat}.current names ${cur.bind}, which the page doesn't bind`); }
          else pageExprOk(cur as PageExpr, `${nat}.current`);
          break;
        }
        case "callResult": {
          const b = binds[n.from];
          if (!b) e.push(`${nat}.from names ${n.from}, which the page doesn't bind`);
          else if (b.call === undefined) e.push(`${nat}.from names ${n.from}, which binds a view: a callResult shows a call's value`);
          else if (m.calls?.[b.call] && !m.calls[b.call].result) e.push(`${nat}.from names ${n.from}, whose call ${b.call} declares no result to draw`);
          break;
        }
        case "outbox": {
          if (n.from !== "module") oneBind(n.from, `${nat}.from`);
          if (!m.outbound) e.push(`${nat}: the module declares no outbound channels`);
          break;
        }
        case "bulkStatus": {
          oneBind(n.from, `${nat}.from`);
          const c = bindCollection(n.from);
          const waits = Object.values(m.machines ?? {}).some((mc) => mc.collection === c && Object.values(mc.transitions).some((t) => t.effects?.some((fx) => "bulk" in fx && fx.bulk)));
          if (c && !waits) e.push(`${nat}.from binds ${c}, which no transition moves in bulk`);
          if (n.link !== undefined && !namesPage(m.pages, n.link)) e.push(`${nat}.link names ${n.link}, which is not a page`);
          break;
        }
        case "shareLinks": {
          oneBind(n.from, `${nat}.from`);
          const share = m.shares?.[n.share];
          if (!share) e.push(`${nat}.share names ${n.share}, which is not a share`);
          else if (bindCollection(n.from) !== share.collection) e.push(`${nat}.from must bind one ${share.collection} doc`);
          break;
        }
        case "integrity": {
          oneBind(n.from, `${nat}.from`);
          const c = bindCollection(n.from);
          if (c && !m.collections[c]?.integrity) e.push(`${nat}.from binds ${c}, which declares no integrity seal`);
          break;
        }
        case "report": case "chart": {
          const shape = n.c === "report" ? n : n.report;
          if (n.c === "report") {
            if (reports.has(n.id)) e.push(`${nat}.id ${n.id} is a report of another component; report ids name saved reports, once per module`);
            reports.add(n.id);
            n.sources?.forEach((src, k) => {
              // `canon.*`: every Canon object the module may report on, which reads.records grants.
              if (src === EVERY_CANON_SOURCE) { if (!m.reads?.records) e.push(`${nat}.sources[${k}] names ${src}, every Canon object the module reports on, which needs reads.records`); }
              else if (src.startsWith("canon.") ? !grantsSource(m, src) : !m.collections[src]?.report) e.push(`${nat}.sources[${k}] names ${src}, which is not a collection with a report, nor a Canon source the module's reads grant`);
              else if (src === n.collection) e.push(`${nat}.sources[${k}] names the report's own collection`);
            });
          }
          if (n.c === "chart") {
            textOk(n.title, `${nat}.title`, false);
            if (n.link !== undefined) {
              if (n.from === undefined) e.push(`${nat}.link is for a chart of a binding's rows`);
              textOk(n.link, `${nat}.link`, false, "point");
              if (!namesPage(m.pages, n.link.replace(PLACEHOLDER, "x"))) e.push(`${nat}.link names ${n.link}, which is not a page`);
            }
            if (n.kind === "waterfall") {
              // A waterfall walks a call's start through its steps: one signed value per row, in the call's order.
              const b = n.from === undefined ? undefined : binds[n.from];
              if (!b || b.call === undefined) e.push(`${nat}: a waterfall draws a call's value: from names a call binding, rows its steps`);
              if (n.y === undefined) e.push(`${nat}.y is missing: each step's signed change`);
              if (n.start === undefined) e.push(`${nat}.start is missing: the value's field the waterfall starts from`);
              for (const k of ["series", "bucket", "order", "dir", "top", "report"] as const) if (n[k] !== undefined) e.push(`${nat}.${k} isn't for a waterfall: its steps keep the call's order`);
              textOk(n.startLabel, `${nat}.startLabel`, false);
              textOk(n.endLabel, `${nat}.endLabel`, false);
            } else for (const k of ["start", "end", "startLabel", "endLabel"] as const) if (n[k] !== undefined) e.push(`${nat}.${k} is for a waterfall`);
            if ((n.from === undefined) === (n.report === undefined)) { e.push(`${nat} needs from (a binding's rows) or report, one of them`); break; }
            if (n.from !== undefined) {
              const b = binds[n.from];
              if (!b) { e.push(`${nat}.from names ${n.from}, which the page doesn't bind`); break; }
              if (b.call === undefined && m.views[b.view!]?.kind !== "list") e.push(`${nat}.from names ${n.from}, which binds one doc, not rows`);
              if (n.x === undefined) e.push(`${nat}.x is missing: the row value each bar or point is`);
              if (b.call === undefined) for (const k of ["x", "y", "series"] as const) if (n[k] !== undefined) rowPathOk(n[k]!, n.from, `${nat}.${k}`);
              if (n.rows !== undefined && b.call === undefined) e.push(`${nat}.rows is only for a call's value`);
              break;
            }
            if (n.x !== undefined || n.y !== undefined || n.series !== undefined || n.rows !== undefined) e.push(`${nat}: a report chart draws its report; x, y, series and rows are for a binding's rows`);
          }
          if (!shape) break;
          reportShapeOk(m, shape, nat, e);
          break;
        }
        case "recordEditor": {
          textOk(n.title, `${nat}.title`, true);
          if (!callBind(n.from)) e.push(`${nat}.from needs a call binding`);
          if (n.selection.aliases?.includes(n.selection.param)) e.push(`${nat}.selection.aliases repeats its primary parameter`);
          editorCallOk(n.change, [n.change.arg], `${nat}.change`, false);
          editorCallOk(n.message, [n.message.fieldArg, n.message.valueArg], `${nat}.message`, false);
          if (coreOf(m.calls?.[n.change.call]?.args?.value[n.change.arg]?.fieldType ?? { type: "null" }).type !== "object" || coreOf(m.calls?.[n.message.call]?.args?.value[n.message.valueArg]?.fieldType ?? { type: "null" }).type !== "string") e.push(`${nat} needs an object change and text message argument`);
          if (n.message.fieldArg === n.message.valueArg) e.push(`${nat}.message arguments must differ`);
          for (const ref of [n.change, n.message]) if (JSON.stringify(ref.args?.[n.versionArg]) !== JSON.stringify({ row: n.version }) || coreOf(m.calls?.[ref.call]?.args?.value[n.versionArg]?.fieldType ?? { type: "null" }).type !== "number") e.push(`${nat}.versionArg must name a fixed numeric version argument`);
          break;
        }
        case "setMap": {
          if (!callBind(n.from)) e.push(`${nat}.from needs a call binding with canonical set rows and shared counts`);
          if (n.rows === n.overlaps) e.push(`${nat}.overlaps must name a different field from rows`);
          if (n.selection.aliases?.includes(n.selection.param)) e.push(`${nat}.selection.aliases repeats its primary parameter`);
          textOk(n.title, `${nat}.title`, false); textOk(n.frameLabel, `${nat}.frameLabel`, false); textOk(n.empty, `${nat}.empty`, false);
          if (n.focus) {
            textOk(n.focus.title, `${nat}.focus.title`, true);
            textOk(n.focus.sharedLabel, `${nat}.focus.sharedLabel`, false);
            n.focus.items.forEach((item, k) => { textOk(item.label, `${nat}.focus.items[${k}].label`, true); textOk(item.value, `${nat}.focus.items[${k}].value`, true); });
          }
          break;
        }
        case "flow": {
          const b = binds[n.from];
          if (!b) { e.push(`${nat}.from names ${n.from}, which the page doesn't bind`); break; }
          if (b.call === undefined) {
            if (!listBind(n.from, `${nat}.from`)) break;
            if (n.rows !== undefined) e.push(`${nat}.rows is only for a call's value`);
            if (n.parent !== undefined) rowPathOk(n.parent, n.from, `${nat}.parent`);
            if (n.id !== undefined) rowPathOk(n.id, n.from, `${nat}.id`);
          }
          for (const k of ["title", "action", "metric", "card", "tone"] as const) textOk(n[k], `${nat}.${k}`, true);
          textOk(n.empty, `${nat}.empty`, false);
          n.details?.forEach((d, k) => textOk(d.value, `${nat}.details[${k}].value`, true));
          break;
        }
        case "tree": {
          const b = binds[n.from];
          if (!b) { e.push(`${nat}.from names ${n.from}, which the page doesn't bind`); break; }
          if (b.call === undefined) {
            if (!listBind(n.from, `${nat}.from`)) break;
            if (n.rows !== undefined) e.push(`${nat}.rows is only for a call's value`);
            rowPathOk(n.parent, n.from, `${nat}.parent`);
            if (n.id !== undefined) rowPathOk(n.id, n.from, `${nat}.id`);
            if (n.link !== undefined) linkOk(n.link, n.from, `${nat}.link`);
          } else if (n.link !== undefined && !namesPage(m.pages, n.link)) e.push(`${nat}.link names ${n.link}, which is not a page`);
          textOk(n.title, `${nat}.title`, true); textOk(n.subtitle, `${nat}.subtitle`, true); textOk(n.empty, `${nat}.empty`, false);
          n.details?.forEach((d, k) => textOk(d.value, `${nat}.details[${k}].value`, true));
          break;
        }
        case "table": {
          const view = m.views[binds[n.from]?.view ?? ""];
          const calls = callBind(n.from);
          if (!binds[n.from]) e.push(`${nat}.from names ${n.from}, which the page doesn't bind`);
          else if (!calls && view && view.kind !== "list") e.push(`${nat}.from names ${n.from}, which binds one doc, not a list`);
          if (n.rows !== undefined && !calls) e.push(`${nat}.rows is only for a call's value`);
          if (n.focus?.aliases?.includes(n.focus.param)) e.push(`${nat}.focus.aliases repeats its primary parameter`);
          if (n.focus && n.rowLink) e.push(`${nat}.focus cannot also navigate with rowLink`);
          if (canonBind(n.from) && (n.rowActions?.length || n.select || n.reorder)) e.push(`${nat}: a Canon read's rows take no actions, picks or reordering`);
          if (n.hierarchy) {
            if (!calls) e.push(`${nat}.hierarchy needs module call rows`);
            if (n.reorder || n.group || n.sort || n.search || n.filters || n.groupBy || n.chips || n.cards) e.push(`${nat}.hierarchy cannot reorder, group, sort, filter or use cards`);
            if (n.hierarchy.add) editorCallOk(n.hierarchy.add, [n.hierarchy.add.arg], `${nat}.hierarchy.add`, false);
            if (n.hierarchy.move) editorCallOk(n.hierarchy.move, [n.hierarchy.move.arg], `${nat}.hierarchy.move`, false);
          }
          n.columns.forEach((col, k) => {
            const cat = `${nat}.columns[${k}]`;
            if (col.edit && col.definition) e.push(`${cat} chooses edit or definition`);
            if (col.edit || col.definition) {
              if (!calls) e.push(`${cat} editing needs module call rows`);
              inlineEditOk(col.edit ?? col.definition!.query, cat);
            }
            // An `each` column's texts read its item as `{$col...}` and its key as `{col}`; no other column does.
            const each = col.each !== undefined ? "col" : undefined;
            if (col.each !== undefined && "from" in col.each && !Object.hasOwn(binds, col.each.from)) e.push(`${cat}.each.from names ${col.each.from}, which the page doesn't bind`);
            if (col.each !== undefined && "from" in col.each && col.each.rows !== undefined && !callBind(col.each.from)) e.push(`${cat}.each.rows is only for a call's value`);
            if (col.each !== undefined && "fiscalMonths" in col.each && col.each.fiscalMonths !== null) formValueOk(col.each.fiscalMonths, `${cat}.each.fiscalMonths`);
            if (!each && JSON.stringify(col).includes("{col}")) e.push(`${cat} names {col}, which only an each column has`);
            const colRow = (path: string, where: string) => { if (!path.includes("{col}")) rowPathOk(path, n.from, where); };
            textOk(col.label, `${cat}.label`, false, each);
            textOk(col.headerLink, `${cat}.headerLink`, false, each);
            if (col.headerLink !== undefined && !namesPage(m.pages, col.headerLink.replace(/\{col\}|\{\$[^}]*\}/g, "x"))) e.push(`${cat}.headerLink names ${col.headerLink}, which is not a page`);
            textOk(col.value, `${cat}.value`, true, each);
            textOk(col.empty, `${cat}.empty`, true, each);
            textOk(col.tooltip, `${cat}.tooltip`, true, each); textOk(col.copy, `${cat}.copy`, true, each);
            textOk(col.group, `${cat}.group`, true, each);
            if (col.group !== undefined && !n.group && !n.groupBy?.length) e.push(`${cat}.group is what a section's header says, but the table has no sections (group or groupBy)`);
            if (col.when) rowPathOk(col.when.field, n.from, `${cat}.when.field`);
            col.cases?.forEach((x, j) => { rowPathOk(x.when.field, n.from, `${cat}.cases[${j}].when.field`); textOk(x.value, `${cat}.cases[${j}].value`, true, each); });
            if (col.bar) { colRow(col.bar.value, `${cat}.bar.value`); if (col.bar.tone) colRow(col.bar.tone.by, `${cat}.bar.tone.by`); }
            if (col.popover) { colRow(col.popover.items, `${cat}.popover.items`); textOk(col.popover.label, `${cat}.popover.label`, true, "item"); textOk(col.popover.title, `${cat}.popover.title`, true); }
            if (col.expand) {
              textOk(col.expand.label, `${cat}.expand.label`, true);
              const was = inRow; inRow = true;
              walk(col.expand.body, `${cat}.expand.body`);
              inRow = was;
            }
            if (col.avatars !== undefined) {
              // A list of rows' member field (`attendees.person`) draws each row's member, as a member field does.
              const [list, inner] = col.avatars.split(".");
              const lc = inner !== undefined ? coreOf(m.collections[bindCollection(n.from) ?? ""]?.schema.value[list]?.fieldType ?? { type: "null" }) : null;
              const item = lc?.type === "array" ? coreOf(lc.value) : null;
              if (item?.type === "object" && refOf(item.value[inner!])?.to === "users") { /* a list's member field */ }
              else rowPathOk(col.avatars, n.from, `${cat}.avatars`);
            }
            if (col.tone !== undefined) colRow(col.tone.by, `${cat}.tone.by`);
            if (col.sort !== undefined) colRow(col.sort, `${cat}.sort`);
            if (col.total !== undefined) { colRow(col.total.sum, `${cat}.total.sum`); if (col.total.over) colRow(col.total.over, `${cat}.total.over`); }
            if (typeof col.link === "string") linkOk(col.link, n.from, `${cat}.link`);
            else if (col.link && "path" in col.link) colRow(col.link.path, `${cat}.link.path`);
            else if (col.link && "url" in col.link) colRow(col.link.url, `${cat}.link.url`);
            else if (calls && col.link && !("canon" in col.link && col.link.canon !== "deal")) e.push(`${cat}.link: a call's row links to a page, Settings, Settings > Team or Workspace, the deals list, or a company or person its row names; a deal's record needs a joined deal`);
            else if (col.link && "canon" in col.link) {
              for (const [qk, t] of Object.entries(col.link.query ?? {})) textOk(t, `${cat}.link.query.${qk}`, true);
              const c = m.collections[view?.collection ?? ""];
              const to = RECORD_PAGES[col.link.canon];
              if ((to !== undefined) !== (col.link.ref !== undefined)) e.push(`${cat}.link: a deal, company or person link names its ref (ref), and only such a link does`);
              // A call's row may hold any field: its company or person id is the module's to give.
              else if (to === "deals" && col.link.ref !== undefined && (!binds[n.from]?.join?.includes(col.link.ref) || refOf(c?.schema.value[col.link.ref])?.to !== "deals")) e.push(`${cat}.link.ref names ${col.link.ref}, which is not a joined deal ref of ${n.from}`);
              else if (to !== undefined && to !== "deals" && !calls && refOf(c?.schema.value[col.link.ref!])?.to !== to) e.push(`${cat}.link.ref names ${col.link.ref}, which is not a ${to} ref of ${n.from}`);
            } else if (col.link) {
              const c = m.collections[view?.collection ?? ""];
              if (!binds[n.from]?.join?.includes(col.link.record) || refOf(c?.schema.value[col.link.record])?.to !== "deals") e.push(`${cat}.link.record names ${col.link.record}, which is not a joined deal ref of ${n.from}`);
            }
          });
          textOk(n.empty, `${nat}.empty`, false); textOk(n.emptyFiltered, `${nat}.emptyFiltered`, false);
          if (n.rowLink !== undefined) linkOk(n.rowLink, n.from, `${nat}.rowLink`);
          n.rowActions?.forEach((a, k) => action(a, `${nat}.rowActions[${k}]`, true, calls ? undefined : view?.collection, calls));
          if (n.select?.edit) {
            const eop = m.ops[n.select.edit.op];
            if (!eop || eop.kind !== "update") e.push(`${nat}.select.edit.op names ${n.select.edit.op}, which is not an update`);
            else if (!calls && view && eop.collection !== view.collection) e.push(`${nat}.select.edit.op updates ${eop.collection}, not the table's rows`);
            if (!calls && n.select.edit.key !== undefined) e.push(`${nat}.select.edit.key is for a call's rows: a list's rows are the docs`);
            n.select.edit.fields.forEach((f, k) => { fieldOptionsOk(f, eop ? m.collections[eop.collection]?.schema.value[f.field] : undefined, `${nat}.select.edit.fields[${k}]`, true, eop ? m.collections[eop.collection]?.schema : undefined); if (!eop?.fields?.includes(f.field)) e.push(`${nat}.select.edit.fields[${k}] names ${f.field}, which ${n.select!.edit!.op} doesn't write`); textOk(f.placeholder, `${nat}.select.edit.fields[${k}].placeholder`, true); });
            textOk(n.select.edit.label, `${nat}.select.edit.label`, false);
          }
          if (n.select && !n.select.actions.length && !n.select.edit && !n.select.param) e.push(`${nat}.select needs actions, an edit or a param`);
          n.select?.actions.forEach((a, k) => {
            const sat = `${nat}.select.actions[${k}]`;
            if (!("transition" in a || "call" in a || ("op" in a && m.ops[a.op]?.kind === "delete"))) e.push(`${sat}: rows picked together run a transition, a delete or a call, one row at a time`);
            if ("target" in a && a.target !== undefined) e.push(`${sat}.target: an action on picked rows runs on each row`);
            action(a, sat, true, calls ? undefined : view?.collection, calls);
          });
          if (n.sort) rowPathOk(n.sort.by, n.from, `${nat}.sort.by`);
          n.filters?.forEach((f, k) => { rowPathOk(f.field, n.from, `${nat}.filters[${k}].field`); if (f.options !== undefined && !calls) e.push(`${nat}.filters[${k}].options is for a call's rows: a list's choice field offers its schema's values`); });
          n.search?.forEach((f, k) => rowPathOk(f, n.from, `${nat}.search[${k}]`));
          if (n.group) rowPathOk(n.group.by, n.from, `${nat}.group.by`);
          n.chips?.forEach((c, k) => { textOk(c.label, `${nat}.chips[${k}].label`, false); rowPathOk(c.when.field, n.from, `${nat}.chips[${k}].when.field`); });
          if (n.attention) rowPathOk(n.attention.field, n.from, `${nat}.attention.field`);
          if (n.summary && !n.attention) e.push(`${nat}.summary counts the rows that need attention: give the table an attention`);
          n.groupBy?.forEach((g, k) => { textOk(g.label, `${nat}.groupBy[${k}].label`, false); rowPathOk(g.by, n.from, `${nat}.groupBy[${k}].by`); });
          if (n.reorder) {
            if (n.reorder.by) rowPathOk(n.reorder.by, n.from, `${nat}.reorder.by`);
            const rc = m.calls?.[n.reorder.call];
            if (!rc) e.push(`${nat}.reorder.call names ${n.reorder.call}, which is not a call`);
            else {
              const takes = rc.args?.value ?? {};
              const arg = n.reorder.arg ?? "keys";
              if (!takes[arg] || coreOf(takes[arg].fieldType).type !== "array") e.push(`${nat}.reorder: ${n.reorder.call} must take ${arg}, a list of the rows' keys`);
              for (const [k, x] of Object.entries(n.reorder.args ?? {})) { if (!Object.hasOwn(takes, k)) e.push(`${nat}.reorder.args.${k} is not an argument of ${n.reorder.call}`); formValueOk(x, `${nat}.reorder.args.${k}`); }
            }
          }
          if (n.totalBar) { textOk(n.totalBar.label, `${nat}.totalBar.label`, false); if (!n.columns.some((c) => c.total)) e.push(`${nat}.totalBar shows the columns' totals, but no column has a total`); }
          if (n.group?.link !== undefined) linkOk(n.group.link, n.from, `${nat}.group.link`);
          break;
        }
        case "stepper":
          if (n.min !== undefined && n.max !== undefined && n.min > n.max) e.push(`${nat}.min is more than max`);
          break;
        case "wizard": {
          if ((n.op === undefined) === (n.call === undefined)) { e.push(`${nat} needs an op or a call, not both`); break; }
          const wop = n.op !== undefined ? m.ops[n.op] : undefined;
          const wcall = n.call !== undefined ? m.calls?.[n.call] : undefined;
          if (n.op !== undefined && (!wop || wop.kind !== "create")) e.push(`${nat}.op names ${n.op}, which is not a create`);
          if (n.call !== undefined && !wcall) e.push(`${nat}.call names ${n.call}, which is not a call`);
          textOk(n.toast, `${nat}.toast`, false, "draft,result");
          const takes = wop ? wop.fields ?? [] : Object.keys(wcall?.args?.value ?? {});
          const seen = new Set<string>();
          n.steps.forEach((st, k) => {
            textOk(st.title, `${nat}.steps[${k}].title`, false); textOk(st.description, `${nat}.steps[${k}].description`, false);
            st.fields.forEach((f, j) => {
              const fat = `${nat}.steps[${k}].fields[${j}]`;
              if (!takes.includes(f.field)) e.push(`${fat} names ${f.field}, which ${n.op ?? n.call} doesn't take`);
              if (seen.has(f.field)) e.push(`${fat} names ${f.field}, which an earlier step asks`);
              seen.add(f.field);
              textOk(f.label, `${fat}.label`, false); textOk(f.help, `${fat}.help`, false); textOk(f.placeholder, `${fat}.placeholder`, false);
              fieldOptionsOk(f, (wcall?.args ?? (wop ? m.collections[wop.collection]?.schema : undefined))?.value[f.field], fat, false, wcall?.args ?? (wop ? m.collections[wop.collection]?.schema : undefined));
            });
          });
          n.preview?.items.forEach((x, k) => { textOk(x.label, `${nat}.preview.items[${k}].label`, false); textOk(x.value, `${nat}.preview.items[${k}].value`, false, "draft"); });
          textOk(n.preview?.title, `${nat}.preview.title`, false, "draft");
          if (n.then !== undefined && !namesPage(m.pages, n.then)) e.push(`${nat}.then names ${n.then}, which is not a page`);
          if (wop) prefillOk(n, n.op!, nat);
          break;
        }
        case "grid": {
          listBind(n.from, `${nat}.from`);
          const gop = m.ops[n.op];
          // With `cells`, the op updates the cell docs, each holding one number; else the row docs, each a record by column.
          const cellsAt = n.cells ? bindCollection(n.cells.from) : undefined;
          if (n.cells && listBind(n.cells.from, `${nat}.cells.from`)) {
            const cs = m.collections[cellsAt ?? ""]?.schema.value ?? {};
            for (const f of [n.cells.row, n.cells.column]) if (!Object.hasOwn(cs, f)) e.push(`${nat}.cells names ${f}, which is not a field of ${cellsAt}`);
            const cop = n.cells.create ? m.ops[n.cells.create] : undefined;
            if (n.cells.create && (!cop || cop.kind !== "create" || cop.collection !== cellsAt)) e.push(`${nat}.cells.create names ${n.cells.create}, which doesn't create ${cellsAt} docs`);
            else if (cop) for (const f of [n.cells.row, n.cells.column, n.field, ...Object.keys(n.cells.fixed ?? {})]) if (!cop.fields?.includes(f)) e.push(`${nat}.cells.create doesn't write ${f}`);
            for (const [k, x] of Object.entries(n.cells.fixed ?? {})) formValueOk(x, `${nat}.cells.fixed.${k}`);
          }
          if (!gop || gop.kind !== "update") e.push(`${nat}.op names ${n.op}, which is not an update`);
          else if (gop.collection !== (n.cells ? cellsAt : bindCollection(n.from))) e.push(`${nat}.op updates ${gop.collection}, not the grid's ${n.cells ? "cells" : "rows"}`);
          else if (!gop.fields?.includes(n.field)) e.push(`${nat}.field names ${n.field}, which ${n.op} doesn't write`);
          else if (!n.cells && coreOf(m.collections[gop.collection]?.schema.value[n.field]?.fieldType ?? { type: "null" }).type !== "record") e.push(`${nat}.field names ${n.field}, which must be a record of numbers by the column's key`);
          else if (n.cells && coreOf(m.collections[gop.collection]?.schema.value[n.field]?.fieldType ?? { type: "null" }).type !== "number") e.push(`${nat}.field names ${n.field}, which must be a number`);
          if ("from" in n.each && !Object.hasOwn(binds, n.each.from)) e.push(`${nat}.each.from names ${n.each.from}, which the page doesn't bind`);
          if ("fiscalMonths" in n.each && n.each.fiscalMonths !== null) formValueOk(n.each.fiscalMonths, `${nat}.each.fiscalMonths`);
          textOk(n.title, `${nat}.title`, true); textOk(n.label, `${nat}.label`, false, "col");
          break;
        }
        case "dateRange":
          if (n.from === n.to) e.push(`${nat}: from and to name two URL parameters`);
          if (n.default !== undefined && !parseDateRange(n.default, "2026-01-15")) e.push(`${nat}.default "${n.default}" is not a date range Canon reads (This month, last 2 quarters, Q3 2026)`);
          break;
        case "form": {
          const op = m.ops[n.op];
          if (!op) { e.push(`${nat}.op names ${n.op}, which is not an op`); break; }
          if (op.kind === "delete") e.push(`${nat}.op names ${n.op}, a delete, which has no form`);
          if ((op.kind === "update") !== (n.from !== undefined)) e.push(op.kind === "update" ? `${nat}.from is missing: ${n.op} updates the doc it binds` : `${nat}.from is only for an update`);
          if (n.from !== undefined && !Object.hasOwn(binds, n.from)) e.push(`${nat}.from names ${n.from}, which the page doesn't bind`);
          if (op.kind === "create" && m.collections[op.collection]?.setOf && n.parent === undefined) e.push(`${nat}.parent is missing: ${n.op} creates a doc in a set`);
          pageExprOk(n.parent, `${nat}.parent`);
          const c = m.collections[op.collection];
          n.fields.forEach((f, k) => {
            textOk(f.help, `${nat}.fields[${k}].help`, false); textOk(f.placeholder, `${nat}.fields[${k}].placeholder`, false);
            if (!op.fields?.includes(f.field)) return e.push(`${nat}.fields[${k}] names ${f.field}, which ${n.op} doesn't write`);
            const spec = c && fieldsOf(c)[f.field];
            if (spec && (f.widget ? !widgetFits(f.widget, spec) : widgetOf(spec) === null)) e.push(`${nat}.fields[${k}]: ${f.widget ? `a ${f.widget} widget can't edit` : "no widget edits"} ${f.field}`);
            if (Object.hasOwn(n.fixed ?? {}, f.field)) e.push(`${nat}.fields[${k}] names ${f.field}, which fixed gives: the form doesn't show it`);
          });
          prefillOk(n, n.op, nat);
          break;
        }
      }
    });
    walk(p.body, `${at}.body`);
    textOk(p.document?.heading, `${at}.document.heading`, false); textOk(p.document?.wordmark, `${at}.document.wordmark`, false); textOk(p.document?.footer, `${at}.document.footer`, false);
  });
  if (!m.nav && !m.links) e.push("manifest needs a nav entry, or links to Canon pages");
  if (!m.nav && m.pages.length) e.push("pages: a module with pages needs a nav entry that opens them");
  if (m.nav && !m.pages.length) e.push("nav: a nav entry opens one of the module's pages, and it has none");
  if (m.links && new Set(m.links).size !== m.links.length) e.push("links: each place once");
  if (m.nav?.slot && m.links?.includes(m.nav.slot)) e.push(`links: ${m.nav.slot} is the place the module's own entry takes`);
  if (m.nav?.slot && NAV_SLOTS[m.nav.slot].section !== m.nav.section) e.push(`nav.section: ${m.nav.slot} is in ${NAV_SLOTS[m.nav.slot].section}`);
  if (m.imports && new Set(m.imports).size !== m.imports.length) e.push("imports: each name must be unique");
  const landings = !m.nav ? [] : typeof m.nav.landing === "string" ? [["", m.nav.landing] as const] : Object.entries(m.nav.landing).map(([r, path]) => [`.${r}`, path] as const);
  for (const [at, path] of landings) {
    const page = m.pages.find((p) => p.path === path);
    if (!page) e.push(`nav.landing${at} names ${path}, which is not a page`);
    else if (paramsOf(path).length) e.push(`nav.landing${at} must be a page without parameters`);
    else if (at && at !== ".default" && page.roles && !page.roles.includes(at.slice(1) as Role)) e.push(`nav.landing${at} names ${path}, a page ${at.slice(1)} doesn't see`);
  }
}

/** The manifest, checked, or every reason it isn't one. */
export function parseModuleManifest(raw: unknown): { ok: true; manifest: ModuleManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  MANIFEST(raw, "manifest", errors);
  // Only a manifest whose shape is right is cross-checked, and only its errors can name a panel's page.
  const shaped = !errors.length;
  if (shaped) crossChecks(raw as ModuleManifest, errors);
  // A panel's page is checked after the module's own pages: its errors say which panel.
  const declared = shaped && errors.length ? (raw as ModuleManifest).pages.length : 0;
  const panels = shaped && errors.length ? PANEL_PAGES.flatMap((page) => ((raw as ModuleManifest).contributes?.[`${page}Page`]?.panels ?? []).map((_, i) => `contributes.${page}Page.panels[${i}]`)) : [];
  const named = (x: string) => x.replace(/^manifest\./, "").replace(/^pages\[(\d+)\]/, (all, n) => (Number(n) >= declared && panels[Number(n) - declared] ? panels[Number(n) - declared] : all));
  return errors.length ? { ok: false, errors: errors.map(named) } : { ok: true, manifest: raw as ModuleManifest };
}

/** The scope `role` reads `collection` with. Admins read every doc; a role the collection doesn't list reads none. */
export function readScope(c: CollectionDecl, role: Role): ReadScope {
  return role === "admin" ? "all" : c.access[role] ?? "none";
}

/**
 * The route segments of `page` (a declared path such as `statements/:key`) for one doc: the raw key fills `:key`. A
 * segment is never URL-encoded here, because `matchPage` binds params from decoded segments (a key holding `|` or `/`).
 */
export function pdfPagePath(page: string, key: string): string[] {
  return segmentsOf(page).filter(Boolean).map((s) => (s === ":key" ? key : s));
}

/** The page whose path matches `segments`, with its parameters, or null. */
export function matchPage(pages: readonly PageDecl[], segments: readonly string[]): { page: PageDecl; params: Record<string, string> } | null {
  for (const page of pages) {
    const shape = segmentsOf(page.path);
    if (shape.length !== segments.length) continue;
    const params: Record<string, string> = {};
    if (shape.every((s, i) => (s.startsWith(":") ? ((params[s.slice(1)] = segments[i]), segments[i].length > 0) : s === segments[i]))) return { page, params };
  }
  return null;
}

export type { ObjectValidator, Scalar, ValidatorJSON, Widget };
