/**
 * The one way in to module data (docs/modules.md, "The choke point"). Every caller read and semantic write of
 * moduleDocs and moduleEvents goes through a scope built here. The activity publisher reads pinned physical state.
 * tests/moduleSurfaces.test.ts enforces those owners. A scope:
 *
 * - belongs to the caller's workspace and one module installed and on there, so every read and write carries the
 *   org and the module, and another workspace's docs are never in reach;
 * - reads as the caller's access (convex/permissions.ts accessFor), so an admin's "view as" reads as the member
 *   and writes nothing; or, for Canon itself (`systemScope`, a job), reads every doc and runs only what the manifest
 *   marks `system`;
 * - admits a doc by its collection's read scope for the caller's role (all, team, own, none, narrowed by a field),
 *   and a set collection's doc only while its parent doc is admitted too;
 * - writes only through a declared op, transition or call: the caller's role is one it names, an agent only as its
 *   agent mode allows (`propose` makes a patch plan a person approves), its guards hold, the doc checked against the
 *   collection's schema, and one moduleEvents row per write. A field a machine owns changes only through that
 *   machine's transitions. A call's read plan is read here as the caller, and the writes its code returns are
 *   applied here, each checked as the caller's own would be, all or none;
 * - while a newer version installs, fills its index slots on every write and checks each write against its schema
 *   too, so the version serves complete once its backfill (`upgradeBatch`, here too) is done.
 */
import { withModulePublication, moduleSource, ordinaryBackfillSource, scopeModuleSource, associateModuleSource, continuationSource, capturePackageState, rememberModuleRow, moduleRowBefore, writeModuleState, markModuleSemanticWriteAttempt, type ModuleSourceState } from "./activityCapture";
import { canonCallProblems } from "../../../modules/kernel/canonOperations.ts";
import { marketSampleRequest } from "../../../modules/kernel/freePopulation.ts";
import { socialSearchRequest, SOCIAL_MAX_QUERIES, type SocialSearch } from "../../../modules/kernel/social.ts";
import { webSearchRequest, type WebSearchRequest } from "../../../modules/kernel/webSearch.ts";
import { webPagesRequest, type WebPagesRequest } from "../../../modules/kernel/webPages.ts";
import { assertModuleDefinitionWrite, assertOwnedPackageChange, interfaceOwner, assertIcpProvider, ICPS_CUTOVER } from "./interfaceOwnership";
import { senderFields, senderReader } from "./senders";
import type { CanonOperation } from "../../../modules/kernel/canonOperations.ts";
import { planMarketRead, type MarketReadSpec } from "../marketSize.ts";
import { importsOf, importSetKey, type ImportDoc } from "./imports";
import { providedCollectionChanged, providedCollectionsReset } from "./providedChanges";
import { superseded } from "./revision";
import { can } from "../capabilities";
import type { Capability } from "../../../modules/kernel/capabilities.ts";
import { baseRole } from "../roles";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { agentClientOf, getCurrentUser, userBelongsToOrg, withRole } from "../../lib";
import { accessFor, dealVisible, principalAccess, roleBasesOf, roleIn, workspaceMembers } from "../../permissions";
import { accessOf, fieldLevel, isRestricted, narrowsReads, ownerScope, permissionOf, type Access, type Role } from "../access";
import { CANON_READS, isRecordServiceRead, pageReadable, clockValue, isClock, MAX_INDEX_FIELDS, MIN_AGGREGATE_OWNERS, MAX_IN_VALUES, MAX_VIEW_LIMIT, isListArg, isUnset, machineFields, moduleSlug, readScope, rowWhereHolds, unwrapDate, upgradeKey, type ArgType, type CallDecl, type CallExpr, type CanonRead, type CollectionDecl, type DirtyDecl, type EffectDecl, type SendEffect, type MachineExpr, type NotifyEffect, type Expr, type Guard, type ModuleManifest, type ObjectValidator, type OpDecl, type Predicate, type RowWhere, type ShareDecl, type SetExpr, type ViewDecl } from "../../../modules/kernel/manifest.ts";
import { canonicalJson, sealOf } from "../../../modules/kernel/integrity.ts";
import { roomRecordCollections } from "../../../modules/kernel/room.ts";
import { memberNamed } from "../../../modules/kernel/memberAccess.ts";
import { callReader } from "./transcripts";
import { fillPath, moneyDecimals, renderText } from "../../../modules/kernel/text.ts";
import { notifyMembers, MESSAGE_MAX, NOTIFY_MAX } from "../notifications";
import { asDoc, renderTemplate, type Rendered } from "../../../modules/kernel/outbound.ts";
import { enqueueModuleMailboxEmail, previewModuleMailboxEmail, mailboxPeople } from "../outbound/moduleMailbox";
import { outputProblems } from "../../../modules/kernel/calls.ts";
import { digestAt, enqueue, noticeMode, type Enqueue } from "../outbound/queue";
import { appUrl } from "../operatorConfig";
import { migrationProblems, patched, type Expect, type Intent, type MigrationDoc, type MigrationResult, type ReadValue, type Workspace } from "../../../modules/kernel/calls.ts";
import type { RecordReadSpec } from "./recordReads";
import type { ListFilter } from "../objects/listSpec";
import { canonRead, planRecordRead, dealFieldsOf, dealValues, memberFieldsOf, memberReportRows, DEAL_API_NAME, type PeopleQuery } from "./canonReads";
import { BULK_JOB, REPORT_JOB, ensureActivityBaselines, invalidateActivatedJobLeases, bulkRow, dropKey, isFresh, markDirty, orderPartOf, retryFailed, sortText } from "./jobs";
import { canonSourceFields, DEAL_ACCOUNT, isCanonSource, projectedCollections, recordObjectOf, reportFields, WEIGHTED_AMOUNT, type AggregateSpec, type ReportField } from "../../../modules/kernel/reports.ts";
import { recordSourcePlan } from "./recordSources";
import type { ModuleDocRow, ModuleDocScope, ModuleWhere } from "../objects/moduleReport";
import type { ReportSpec } from "../../../modules/kernel/reportValidators";
import { agentModeOf, dateToMs, dirtyKey, fiscalYearStart, holds, msToDate, namesArgs, namesArgsBeyond, namesFields, targetState, valueOf, type Env, type Subject } from "../../../modules/kernel/machines.ts";
import { defaultSlots, holdsWrites, migrates, type SlotMap } from "../../../modules/kernel/upgrade.ts";
import { outputSchema, type AiDecl } from "../../../modules/kernel/ai.ts";
import { coreOf, fileFits, filesIn, holdsFile, isRecordRef, parentRefsIn, plainProblem, refsIn, valueProblems, type FieldSpec, type FileValidator, type RecordRefTo, type RefValidator, type Scalar } from "../../../modules/kernel/schema.ts";
import { installedModule, isEnabled, manifestOf, pendingManifestOf, pendingManifestText, storePendingManifest, type ModuleBundle } from "./packages";
import { initializeProjection } from "./projection";
import { insertProposal, type ProposalArgs, type ProposalRow } from "./proposals";
import { canonicalMeetingArgs, insertRecordProposal, meetingProposalRow, outcomeProblem, stampedMeetingPlan } from "./recordProposals";
import { proposeModuleFacts, type FactProposalReceipt } from "./factProposals";
import { factsProposeProblem, type FactsProposeArgs } from "../../../modules/kernel/facts.ts";
import { approveUnderModuleGrant, grantCovering } from "./grants";
import { treeSpecOf, TREE_DEALS_SCANNED, type TreeSpec } from "./territories";
import { icpTreeGranted, icpTreeMarkets, icpTreeRequest, type IcpTreeSpec } from "./icpTrees";
import { modelSettings } from "../recipes";
import { inShareTree, projectShare, shareInputRefs, shareWhereHolds } from "./shares";
import { visitorValueFits, type VisitorIdentity, type VisitorWrite, type VisitorUploadTarget } from "../../../modules/kernel/visit.ts";
import { VISITOR_TICKET_MS, visitorFileFits, type VisitorFileMetadata } from "../../../modules/kernel/visitorFiles.ts";
import { bridgedIcpsRead, ICPS_MODULE } from "../icpsInterface";
import { MAX_ASSIGN } from "../../../services/record-service/src/territoryTree.ts";
import { FACTS_PROPOSE, proposalArgsProblem, type MeetingLogArgs, type ProposalOperation, type ProposalRow as RecordRow } from "../../../modules/kernel/proposals.ts";
import { readSequenceVariablePlan, requireVariableReview } from "../sequences/preflight";
import { assertSq1ProjectionChange, assertSq1Copy, assertSq1PackageUpgrade, sq1ProjectionBindings } from "../sequences/bindings";

export async function assertCollectionLimits(ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">, moduleId: string, m: ModuleManifest, adding?: string) {
  for (const [collection, c] of Object.entries(m.collections)) {
    if (c.max === undefined) continue;
    const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection)).take(c.max + 1);
    if (c.setOf || rows.length + Number(adding === collection) > c.max) throw new ConvexError(`${m.title} keeps at most ${c.max} ${collection} definitions. Delete one first.`);
  }
}
async function assertInsertLimit(ctx: Pick<QueryCtx, "db">, row: { orgId: Id<"organizations">; moduleId: string; collection: string }) {
  const pkg = await installedModule(ctx, row.orgId, row.moduleId);
  if (!pkg) return;
  await assertCollectionLimits(ctx, row.orgId, row.moduleId, manifestOf(pkg), row.collection);
  const next = await pendingManifestOf(ctx, pkg);
  if (next) await assertCollectionLimits(ctx, row.orgId, row.moduleId, next, row.collection);
}
const TRUSTED_MAINTENANCE = Symbol("trusted module maintenance");
type StoredModuleDoc = Doc<"moduleDocs">;
type ModuleDocInsert = Omit<StoredModuleDoc, "_id" | "_creationTime">;
async function insertModuleDoc(ctx: MutationCtx, source: ModuleSourceState, value: ModuleDocInsert, maintenance?: typeof TRUSTED_MAINTENANCE) {
  const db = ctx.db;
  if (maintenance !== TRUSTED_MAINTENANCE) await assertModuleDefinitionWrite({ db }, value);
  await assertInsertLimit({ db }, value);
  if ((await sq1ProjectionBindings({ db }, value)).length) throw new ConvexError("A retained canonical projection cannot be recreated as a new module record.");
  await assertSq1ProjectionChange({ db }, value, value);
  return writeModuleState(ctx, source, { kind: "doc", before: null, value }, () => db.insert("moduleDocs", value));
}
async function patchModuleDoc(ctx: MutationCtx, source: ModuleSourceState, id: Id<"moduleDocs">, patch: Partial<ModuleDocInsert>, maintenance?: typeof TRUSTED_MAINTENANCE) {
  const db = ctx.db;
  const row = await moduleRowBefore(ctx, id);
  if (!row) throw new ConvexError("The module record no longer exists.");
  if (maintenance !== TRUSTED_MAINTENANCE) await assertModuleDefinitionWrite({ db }, row);
  const after = { ...row, ...patch };
  if (after.collection !== row.collection) await assertInsertLimit({ db }, after);
  if (after.orgId !== row.orgId || after.moduleId !== row.moduleId || after.collection !== row.collection || after.key !== row.key) {
    await assertModuleDefinitionWrite({ db }, after);
    await assertSq1ProjectionChange({ db }, row, null);
    await assertSq1ProjectionChange({ db }, after, after);
  }
  await assertSq1ProjectionChange({ db }, row, after);
  if (patch.next) await assertSq1ProjectionChange({ db }, row, patch.next.drop ? null : { ...after, data: patch.next.data as Record<string, unknown> });
  return writeModuleState(ctx, source, { kind: "doc", before: row, value: after }, () => db.patch(id, patch));
}
async function deleteModuleDoc(ctx: MutationCtx, source: ModuleSourceState, id: Id<"moduleDocs">, maintenance?: typeof TRUSTED_MAINTENANCE) {
  const db = ctx.db;
  const row = await moduleRowBefore(ctx, id);
  if (row) { if (maintenance !== TRUSTED_MAINTENANCE) await assertModuleDefinitionWrite({ db }, row); await assertSq1ProjectionChange({ db }, row, null); }
  if (!row) return writeModuleState(ctx, source, { kind: "metadata" }, () => db.delete(id));
  return writeModuleState(ctx, source, { kind: "doc", before: row, value: null }, () => db.delete(id));
}

export async function sq1ProjectionDoc(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, moduleId: string, collection: string, key: string) {
  return ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection).eq("key", key)).unique();
}

export async function projectSq1Lifecycle(ctx: MutationCtx, pkg: Doc<"modulePackages">, collection: string, key: string, actor: ModuleEvent["actor"], optional = false): Promise<void> {
  return withModulePublication(ctx, async () => {
    const source = moduleSource(pkg);
    const bindings = await sq1ProjectionBindings(ctx, { orgId: pkg.orgId, moduleId: pkg.moduleId, collection, key });
    if (!bindings.length) throw new ConvexError("The sequence projection has no canonical binding.");
    const row = await sq1ProjectionDoc(ctx, pkg.orgId, pkg.moduleId, collection, key);
    if (!row) { if (optional) return; throw new ConvexError("The canonical sequence projection is missing."); }
    const manifest = manifestOf(pkg), c = manifest.collections[collection];
    if (!c || pkg.pending) throw new ConvexError("The canonical projection cannot change during a module upgrade.");
    const data = { ...row.data, ...Object.assign({}, ...bindings.map((p) => p.fields)) };
    for (const binding of bindings) for (const field of binding.absent) delete data[field];
    const problems = await fitProblems(c.schema, data, upgradeResolver(ctx, pkg, upgradeHeldRefs(c.schema, row.data)), new Map(), upgradeFiles(ctx, pkg));
    if (problems.length) throw new ConvexError("The canonical sequence projection does not fit its installed schema.");
    const owner = c.owner && typeof data[c.owner] === "string" ? data[c.owner] as Id<"users"> : undefined;
    await patchModuleDoc(writeCtx(ctx), source, row._id, { data, version: row.version + 1, ownerUserId: owner, ...slotColumns(c, (pkg.slots ?? defaultSlots(manifest))[collection] ?? {}, data, row.parentKey, row.gen ?? 0), updatedAt: Date.now() });
    await ctx.db.insert("moduleEvents", { orgId: pkg.orgId, moduleId: pkg.moduleId, collection, key, actor, verb: "sq1.lifecycle", kind: "update", fields: [...new Set(bindings.flatMap((p) => Object.keys(p.fields)))], fromVersion: row.version, toVersion: row.version + 1, at: Date.now() });
    await providedCollectionChanged(ctx, pkg.orgId, manifest, collection, row.data, data);
    if (projectedCollections(manifest).has(collection)) await markDirty(ctx, pkg.orgId, pkg.moduleId, manifest, REPORT_JOB, `${collection}|${key}`);
  });
}

/** A module doc as a view returns it: its data and Canon's metadata, never the stored row. */
export type ModuleDoc = { key: string; version: number; data: Record<string, unknown>; owner: string | null; parentKey: string | null; createdAt: number; updatedAt: number; gen?: number; gens?: Record<string, number> };
/** `unset`: optional fields an update removes. */
export type OpInput = { key?: string; parentKey?: string; expect?: number; data?: Record<string, unknown>; unset?: string[] };
export type Proposed = { proposed: Id<"patchPlans"> };
export type OpResult = { key: string; version: number } | { key: string; deleted: true } | Proposed;
/** `evidence`: where the person ran it, as Canon's web server signed it (evidence.ts); only a transition that declares it keeps it. */
export type TransitionInput = { key: string; expect: number; args?: Record<string, unknown>; reason?: string; evidence?: { ip?: string; userAgent?: string } };
/** `created`: the keys of the docs its effects created, by their `as`. */
export type TransitionResult = { key: string; version: number; state: string; created?: Record<string, string>; data?: Record<string, unknown> } | Proposed;
/**
 * The spec a dotted path names in a schema: each step a field of an object, of a list's row or of any case of a variant.
 * Null when there is none.
 */
function nestedSpec(o: ObjectValidator, path: readonly string[]): FieldSpec | null {
  let objects: ObjectValidator[] = [o];
  let spec: FieldSpec | null = null;
  for (const seg of path) {
    spec = objects.map((x) => x.value[seg]).find((x) => x !== undefined) ?? null;
    if (!spec) return null;
    let core = coreOf(spec.fieldType);
    if (core.type === "array") core = coreOf(core.value);
    objects = core.type === "object" ? [core] : core.type === "variant" ? Object.values(core.cases) : [];
  }
  return spec;
}
/** An approved patch plan being applied: its approval stands in for an agent mode of `propose`, and nothing else. */
export type Approval = { proposal: Id<"patchPlans"> };
/** One row of a doc's audit trail, as the timeline shows it. */
export type ModuleEvent = Pick<Doc<"moduleEvents">, "verb" | "kind" | "actor" | "fields" | "fromVersion" | "toVersion" | "from" | "to" | "args" | "reason" | "proposal" | "cause" | "evidence" | "at">;

export type CanonCallAuthorization = { orgId: Id<"organizations">; packageId: Id<"modulePackages">; call: string; input: string; operation: CanonOperation; userId: Id<"users">; moduleId: string; epoch: number; revision?: string };

/** What a report over one source reads, as the caller (ModuleScope.reportPlan). */
export type ReportPlanOf =
  | { fields: ReportField[]; docScope: ModuleDocScope | null; object?: string; title?: string }
  | { none: true; object?: string; title?: string };
export type ModuleScope = {
  shareDocs(share: ShareDecl, rootKey: string): Promise<Record<string, ModuleDoc[]>>;
  shareEvent(share: ShareDecl, key: string, verb: "share.issued" | "share.revoked" | "share.extended", publicId: string): Promise<void>;
  readonly orgId: Id<"organizations">;
  /** Whether the caller reads one of Canon's call records, transcript included (lib/modules/transcripts.ts). */
  readonly callSeen: (call: Doc<"callRecordings">) => Promise<boolean>;
  readonly moduleId: string;
  readonly slug: string;
  readonly manifest: ModuleManifest;
  /** The version installed over the last; a proposal made under another doesn't apply. */
  readonly epoch: number;
  readonly revision: string;
  /** The version an upgrade is installing while migrations or an owner backfill hold writes; else null. */
  readonly migrating: string | null;
  /** The member whose access reads: in an admin's "view as" preview, the member previewed. Null for Canon. */
  readonly userId: string | null;
  /** Whom an admin's "view as" preview reads as, by name: reads (views, pages, read-only calls) are theirs; no write runs. Null otherwise. */
  readonly preview: string | null;
  readonly role: Role;
  readonly agent: string | null;
  readonly system: boolean;
  admission(decl: { roles: readonly string[]; capability?: Capability; system?: true; agent: string; label: string; reason?: string }, write?: boolean): string | null;
  /** Canon-owned imports insert missing keys with the serving schema and system audit trail. */
  importDocs(name: string, docs: readonly ImportDoc[]): Promise<void>;
  copyCutover(name: string, docs: readonly ImportDoc[]): Promise<void>;
  view(name: string, args: Record<string, unknown>): Promise<ModuleDoc[] | ModuleDoc | null>;
  op(name: string, input: OpInput, approval?: Approval): Promise<OpResult>;
  sequenceVariables(key: string): ReturnType<typeof readSequenceVariablePlan>;
  transition(machine: string, name: string, input: TransitionInput, approval?: Approval): Promise<TransitionResult>;
  /** The doc's audit trail, newest first, or null when the caller can't read the doc. */
  events(collection: string, key: string, limit?: number): Promise<ModuleEvent[] | null>;
  /** The states a doc has been in on `machine`, from its trail, its initial and current one included. */
  visited(machine: string, key: string): Promise<string[]>;
  /**
   * Why the caller can't run a transition on a doc now (its state, else a guard that needs no arguments beyond `args`,
   * the ones its action fixes), or null.
   */
  blocked(machine: string, name: string, key: string, args?: Record<string, unknown>): Promise<string | null>;
  /**
   * What a transition's send effects would send (docs/modules.md, "Outbound"), rendered on the doc as the move would
   * leave it, for the dialog that asks first. Null when the caller can't read the doc.
   */
  sendPreview(machine: string, name: string, key: string, args?: Record<string, unknown>): Promise<SendPreview[] | null>;
  /** What a ref picker offers, as the caller may read it. A company or person picker reads the record service (api.modules.records). */
  pick(ref: RefValidator, search: string, max?: number, parentKey?: string): Promise<Array<{ id: string; label: string }>>;
  /** The company and person refs a write asked to admit (Admit "ask") found new: what its action admits before it runs again. */
  unadmitted(): AdmitAsk["admitRecords"];
  /** The values a `suggest` text field already holds in the docs the caller reads, most used first. */
  suggest(collection: string, field: string, search: string, dealField?: string): Promise<string[]>;
  /** What deal, team and doc refs show as, by `<to>:<collection>:<id>`, for those the caller may read. */
  refLabels(refs: ReadonlyArray<{ ref: RefValidator; id: string }>): Promise<Record<string, string>>;
  /** Why the caller can't run an op on a doc (an update's or delete's `key`, a set create's `parentKey`, a create's `data`) now, or null. */
  opBlocked(name: string, at: { key?: string; parentKey?: string; data?: Record<string, unknown> }, asks?: readonly string[]): Promise<string | null>;
  /** A doc of `collection` the caller reads: its version and data; null when there is none they read. */
  peek(collection: string, key: string): Promise<{ version: number; createdAt: number; data: Record<string, unknown> } | null>;
  authorizeCanonCall(call: string, args: Record<string, unknown>): Promise<CanonCallAuthorization>;
  canonInput(call: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  finishCanonCall(call: string, args: Record<string, unknown>, result: unknown): Promise<TransitionResult | null>;
  /**
   * A call's read plan, read as the caller in this one query, once the caller may run it with `args`. `canon`: Canon
   * runs it for a job, watch or schedule, and gave it its arguments itself.
   */
  snapshot(call: string, args: Record<string, unknown>, canon?: boolean): Promise<Snapshot>;
  completionSnapshot(aiCall: string, key: string): Promise<Snapshot>;
  complete(aiCall: string, intents: AppliedIntent[]): ReturnType<ModuleScope["apply"]>;
  /** Write a replaceSet's new docs under a generation no reader sees until `apply` publishes it. */
  stage(call: string, collection: string, parentKey: string, gen: number, docs: Array<Record<string, unknown>>, offset?: number): Promise<number>;
  /** One of this module's published interfaces (`provides`), read as the caller under this module's own scopes. */
  provide(name: string, args: Record<string, unknown>, limit: number): Promise<ReadValue>;
  /** The people one doc of an interface names (`provides.<name>.people`), the doc read as the caller: what people.snapshot freezes. */
  peopleQuery(name: string, key: string): Promise<PeopleQuery>;
  /** As Canon: one page of the values `field` holds across a doc's live set, oldest first. */
  systemSetValues(collection: string, parentKey: string, field: string, cursor: string | null, n: number): Promise<{ values: string[]; next: string | null }>;
  /** A call's writes, each checked, all or none. Returns the generations a replaceSet left behind, to drop. */
  apply(call: string, intents: AppliedIntent[]): Promise<{ writes: number; proposed: Array<Id<"patchPlans">>; retired: Retired[] }>;
  /** An agent's call whose agent mode is `propose`: its writes, checked already by a dry apply, wait as one patch plan. */
  proposeCall(call: string, args: Record<string, unknown>, intents: AppliedIntent[], summary: string): Promise<Proposed>;
  /** Delete up to `max` docs of a set generation that isn't its parent's live one: a retired or a failed staging. */
  dropGeneration(call: string, collection: string, parentKey: string, gen: number, max: number): Promise<number>;
  /**
   * One batch of a bulk move (Canon only): up to its batch of docs moved, each judged first so a doc that refuses is
   * named and the rest still move; then, once every doc has moved, its `then`.
   */
  bulkStep(move: BulkMove): Promise<BulkStep>;
  /** The bulk moves the doc waits on, as the caller may see them: null when they can't read it. */
  bulks(machine: string, key: string): Promise<BulkInfo[] | null>;
  /** Run a stopped bulk move again, as a person who may run the transition that started it. */
  retryBulk(machine: string, via: string, key: string): Promise<{ retried: true }>;
  /** The docs of `collection` among `docs` that fail `when`, as an export's `require` judges its rows: by key and title. */
  failingRows(collection: string, docs: readonly ModuleDoc[], when: Predicate): Promise<Array<{ key: string; title: string }>>;
  /** The docs a timed transition is due on now (Canon only), at most `max`. */
  timedDue(now: number, max: number): Promise<Array<{ machine: string; name: string; key: string; version: number }>>;
  /** Mark a job key stale (Canon's own: a watch's keys), at the sort value its job's `orderBy` reads. */
  dirty(job: string, key: string): Promise<void>;
  /** A list view's docs for a page, at most `limit`, and whether that is all of them; with each row's joins and counts. */
  pageRows(name: string, args: Record<string, unknown>, limit: number): Promise<{ docs: ModuleDoc[]; complete: boolean }>;
  canonRows(read: CanonRead, args: Record<string, unknown>, limit: number): Promise<ModuleDoc[]>;
  /** Each doc's joined refs and counts, as the caller may read them (docs/modules.md, "Pages"). */
  enrich(collection: string, docs: ModuleDoc[], join: readonly string[], counts: Record<string, { view: string; by: string; of?: string; collect?: string }>): Promise<{ docs: PageDoc[]; countError: string | null }>;
  /** A list view's docs for an export, every one the caller reads, at most `max`; refused when there are more. */
  exportRows(name: string, args: Record<string, unknown>, max: number): Promise<ModuleDoc[]>;
  /** Whether a doc the caller reads is sealed and still matches its seal; null when they can't read it or it has none. */
  verify(collection: string, key: string): Promise<Verified | null>;
  /**
   * What a report over `collection` reads (docs/modules.md, "Reports and charts"): its fields, and the caller's read
   * scope as the record service applies it (null: every doc), or `none` when the caller reads none of it. The one place
   * a report's scope is made: every report surface runs through it. A Canon object the module reads through
   * `reads.records` names its `object` and `title`: Canon's report engine counts it as the caller's role sees it.
   */
  reportPlan(collection: string): Promise<ReportPlanOf>;
  /** The existing report scope for an activity collection, including its detail page's role gate. */
  activityPlan(collection: string): ModuleDocScope | "none";
  /** The docs of a reported collection the caller reads, at most `max`, refused past it: the fake record client's report. */
  reportDocs(collection: string, max: number): Promise<ModuleDoc[]>;
  /** Live, readable activity docs. Refuses beyond the scan budget, including unreadable rows. */
  activityDocs(collection: string, max: number): Promise<{ docs: ModuleDoc[]; scanned: number }>;
  /** The members a report over Canon's members (`canon.members`) counts, as the caller's role-derived owner scope admits them. */
  memberRows(): Promise<Array<{ id: string; createdAt: number; data: Record<string, unknown> }>>;
  /**
   * Every doc of a collection a call the caller runs aggregates (a team aggregate), at most `max`: the fake record
   * client's aggregate, which convex/modules.ts folds by owner (reports.ts teamAggregate). Never handed to a caller.
   */
  aggregateDocs(call: string, read: string, max: number): Promise<ModuleDoc[]>;
  /** Canon only: each projected doc `keys` name (`<collection>|<key>`) as the record service keeps it; null when it's gone. */
  projectRows(keys: readonly string[]): Promise<Array<{ collection: string; key: string; row: ModuleDocRow | null }>>;
  /** Canon only: a reported collection's docs after `after`, in key order, for a rebuild. */
  projectPage(collection: string, after: string | null, max: number): Promise<{ rows: ModuleDocRow[]; more: boolean }>;
  /**
   * Where the caller uploads a file for one of the module's file fields (a person whose role writes one): the upload
   * route on the Convex site with a ticket for them, good for 30 minutes and once (uploadRoute.ts).
   */
  uploadUrl(): Promise<{ url: string }>;
  /** A file a doc the caller reads holds, with a link to download it; null when they can't read the doc or it doesn't hold it. */
  fileUrl(collection: string, key: string, file: string): Promise<(FileInfo & { url: string }) | null>;
  /** What the files of docs the caller already read are: name, type and size, by id. */
  fileInfo(ids: readonly string[]): Promise<Record<string, FileInfo>>;
  /**
   * A field of each deal, member, team or doc `ids` name, as the caller may read it (a report's joined dimension):
   * null for one they can't see, or a field their role doesn't read. A member's `team` is the first team, by name, they
   * are on or manage.
   */
  joinedValues(ref: RefValidator, field: string, ids: readonly string[]): Promise<Record<string, Scalar>>;
};
/** A send a transition would make, as its dialog previews it: where it goes, and its text or what it leaves empty. */
export type SendPreview = { channel: "email" | "slack" | "webhook"; to: string; subject?: string; text?: string; missing?: string[]; approval: boolean; sender?: string; informational?: true; refused?: string };
/** A stored file as a page shows it. */
export type FileInfo = { name: string; type: string; bytes: number; buyer?: { label: string; verified: boolean; scanned: false } };
/** A doc's seal, recomputed: `intact` (it matches), `changed` (something it covers changed since), or `unsealed`. */
export type Verified = { state: "intact" | "changed" | "unsealed"; seal: string | null };
/** A doc as a page shows it: joined docs by ref field (null when the caller can't read it), counts by name. */
export type PageDoc = ModuleDoc & { joined?: Record<string, Record<string, unknown> | null>; counts?: Record<string, number | Array<string | number | boolean>> };

/**
 * A bulk effect waiting to run (docs/modules.md, "Jobs, watches and schedules"): what it moves, and the doc that
 * waits. `via`: the transition whose effect it is; `waitIn`: the state the doc waits in until every doc has moved (a
 * move with `then`). `stopped`: the docs that refused their move when it last ran, by key with why.
 */
export type BulkMove = {
  machine: string; transition: string; view: string; args: Record<string, unknown>; onlyFrom: string[];
  parent: { machine: string; key: string; then?: string; via?: string; waitIn?: string }; cause: string;
  stopped?: { refused: Array<{ key: string; message: string }>; count: number };
};
/** One batch of a bulk move: more to move, done, or stopped on docs that refused (at most 20 named, of `count`). */
export type BulkStep = { state: "more" | "done" } | { state: "stopped"; refused: Array<{ key: string; message: string }>; count: number };
/** A doc's bulk move as its page shows it: moving, or stopped with the docs that refused, named; and who may retry. */
export type BulkInfo = { via: string; label: string; state: "moving" | "stopped"; refused: Array<{ key: string; title: string; message: string }>; count: number; error: string | null; canRetry: boolean };
/** The job key of the bulk move transition `name` of `machine` starts on the doc `key`. */
export const bulkKey = (machine: string, name: string, key: string) => `${machine}.${name}~${key.replace(/[^A-Za-z0-9_.:@~-]/g, "_")}`;

/** What a call's code receives: its context and its read plan's results. */
export type Snapshot = {
  /** The module's server code: null only for a hosted AI step, which has none. */
  label: string; returns: CallDecl["returns"]; caller: { userId: string; role: Role | "system" }; reads: Record<string, ReadValue>; bundle: ModuleBundle | null; isolate: string; epoch: number; workspace: Workspace;
  /** The plan's report reads, as specs the call's action runs as the caller (convex/modules.ts runCall). */
  reports: Record<string, ReportSpec>;
  /** The plan's team aggregates, as specs the call's action runs over every doc and folds (reports.ts teamAggregate). */
  aggregates: Record<string, AggregateSpec>;
  /** The Canon deal reads whose deals carry `companyName`, which the call's action fills from the record service. */
  companyNames: string[];
  /** An agent ran a call whose agent mode is `propose`: its writes wait for a person, with this summary (docs/modules.md, "Agents"). */
  propose?: { summary: string };
  /** A hosted AI step (docs/modules.md, "Hosted AI steps"): what it asks for, and the doc its answer fills. */
  ai?: AiRun;
  /** The plan's companies, people and activities reads, which the call's action reads from the record service (recordReads.ts). */
  records?: Record<string, RecordReadSpec>;
  researchAnswers?: Record<string, { slug: string; limit: number; fields: string[] }>;
  markets?: Record<string, MarketReadSpec>;
  /** The plan's territory trees (docs/modules.md, "Territories"), which the call's action counts in the record service. */
  trees?: Record<string, TreeSpec>;
  icpTrees?: Record<string, IcpTreeSpec>;
  meContexts?: Record<string, { orgId: string; userId: string; section: string }>;
  socialSearches?: Record<string, SocialSearch & { orgId: string; userId: string }>;
  webSearches?: Record<string, WebSearchRequest & { orgId: string; userId: string }>;
  webPages?: Record<string, WebPagesRequest & { orgId: string; userId: string }>;
  revision: string;
  canonFence?: Record<string, ReadValue>;
  principalFence?: string;
  marketSamples?: Record<string, { queries: string[]; orgId: string; userId: string }>;
  dealCompanies?: Record<string, string[]>;
};
/**
 * What the call's action needs to run a hosted AI step: its declaration, the answer's shape, the doc it fills (its
 * key, and the version the plan read, which the write expects) and the module's name.
 */
export type AiRun = { decl: AiDecl; schema: ObjectValidator; key: string; collection: string; expect: Expect; module: string; orgId: string; moduleId: string };
/** An intent as apply takes it: a replaceSet's docs are already staged under `gen`. */
export type AppliedIntent = Exclude<Intent, { op: "replaceSet" | "propose" }> | (Omit<Extract<Intent, { op: "replaceSet" }>, "docs"> & { gen: number; count: number })
  /** A proposed write to Canon's records with the records it would change, as the call's action listed them. */
  | (Extract<Intent, { op: "propose" }> & { rows: RecordRow[]; /** facts.propose: the companies and people the action admitted. */ admitted?: string[] });
export type Retired = { collection: string; parentKey: string; gen: number };

const DATA_MAX_BYTES = 256 * 1024;
/** Rows a list reads past the ones it returns, when a read scope filters some out. */
const SCAN_MAX = 1000;
const CHILDREN_MAX = 1000;
/** What a picker offers, and the records it looks through for them; the refs a page labels. */
const PICK_MAX = 20;
const PICK_SCAN = 200;
const LABELS_MAX = 500;
/** The most docs a guard's count reads, an effect moves, and one transition writes with its effects. */
const COUNT_MAX = 1000;
const EFFECT_DOCS_MAX = 100;
const WRITES_MAX = 200;
const EVENTS_MAX = 100;
/** How many rows a read plan's scoped list reads looking for the docs the caller may see, before it refuses. */
const READ_SCAN_MAX = 8000;
const READ_DEFAULT = 1000;
/** A call's writes in one transaction, its staged set docs aside. */
const CALL_WRITES_MAX = 4000;
/** Docs one batch of a bulk move moves, and rows it looks through for them. */
const BULK_BATCH = 100;
const BULK_SCAN = 4000;
/** The docs a stopped bulk move names. */
const BULK_REFUSED_SHOWN = 20;
const SLOT_COLUMNS = ["a", "b", "c", "d"] as const;
/** Rows a page's list looks through for the ones the caller may see; refs one join reads; docs a page's counts read. */
const PAGE_SCAN_MAX = 4000;
const JOIN_MAX = 1000;
const COUNT_PAGE_MAX = 5000;
const NO_ARGS: ObjectValidator = { type: "object", value: {} };
/** How long an upload ticket waits for its file (uploadRoute.ts). */
const UPLOAD_TICKET_MS = 30 * 60 * 1000;

type Row = Doc<"moduleDocs">;
type ListView = Extract<ViewDecl, { kind: "list" }>;
/** A moduleDocs index read with any slot index: this file builds slot names, which Convex's types can't follow. */
type Range = { eq(field: string, value: unknown): Range; gte(field: string, value: unknown): Range; gt(field: string, value: unknown): Range; lte(field: string, value: unknown): Range; lt(field: string, value: unknown): Range };
/** The write a notification or a send comes from: its doc (none for a call's), its verb, its cause and which effect. */
type Cause = { collection: string; key: string; verb: string; cause: string; index: number };
type Loose = { withIndex(name: string, fn: (q: Range) => Range): { order(o: "asc" | "desc"): AsyncIterable<Row> & { take(n: number): Promise<Row[]> } } };
type Db = QueryCtx["db"];

/** Refuse a computation when the installed package no longer matches its read plan. */
export function expectEpoch(scope: ModuleScope, epoch: number): ModuleScope {
  if (scope.epoch !== epoch) throw superseded();
  return scope;
}

const refuse = (message: string): never => { throw new ConvexError(message); };
/** The generation of a parent's `collection` set that readers see: its replaceSet's, else the parent's own. */
const liveGen = (parent: Row, collection: string) => parent.gens?.[collection] ?? parent.gen ?? 0;
const writeCtx = (ctx: QueryCtx | MutationCtx): MutationCtx => { if (!isMutation(ctx)) throw new ConvexError("Module state writes require a mutation."); return ctx; };
const isMutation = (ctx: QueryCtx | MutationCtx): ctx is MutationCtx => typeof (ctx.db as Partial<MutationCtx["db"]>).insert === "function";
const slotIndexName = (i: number) => `by_orgId_moduleId_collection_${SLOT_COLUMNS.map((c) => `s${i}${c}`).join("_")}`;
const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);
const SYSTEM_ONLY = (label: string) => `${label} runs only as Canon, in a job: no person or agent runs it.`;
const NOT_SYSTEM = (label: string) => `Canon runs only what a module marks system, and ${lower(label)} isn't.`;
const subjectOf = (row: Row): Subject => ({ key: row.key, data: row.data, owner: row.ownerUserId ?? null, parentKey: row.parentKey ?? null, collection: row.collection });
/** A `set`'s removal: its field goes from the doc. */
const UNSET = Symbol("unset");
/** `data` with `set` written over it: a value replaces a field, an unset removes it. */
const withSet = (data: Record<string, unknown>, set: Record<string, unknown>) => {
  const out = { ...data };
  for (const [k, v] of Object.entries(set)) { if (v === UNSET) delete out[k]; else out[k] = v; }
  return out;
};

/** The slot columns `slots` gives a doc of `c`: each index's field values, after a set's parent and gen. */
function slotColumns(c: CollectionDecl, slots: Record<string, number>, data: Record<string, unknown>, parentKey: string | undefined, gen: number) {
  const out: Record<string, Scalar> = {};
  for (const [ix, fields] of Object.entries(c.indexes)) {
    const i = slots[ix];
    if (i === undefined) continue;
    const values: Scalar[] = [...(c.setOf ? [parentKey ?? null, gen] : []), ...fields.map((f) => (data[f] ?? null) as Scalar)];
    values.slice(0, MAX_INDEX_FIELDS).forEach((v, j) => { out[`s${i}${SLOT_COLUMNS[j]}`] = v; });
  }
  return out;
}

/** Whether a ref's id names what it may: a member of the workspace, its deal or team, a company or person, or a module doc. */
type RefResolver = (ref: RefValidator, id: string) => Promise<boolean>;
export const refKey = (ref: Pick<RefValidator, "to" | "collection">, id: string) => `${ref.to}:${ref.collection ?? ""}:${id}`;
const recordKeys = (schema: ObjectValidator, data: Record<string, unknown>) =>
  new Set(refsIn(data, schema).filter((r) => isRecordRef(r.ref.to)).map((r) => refKey(r.ref, r.id)));
const upgradeHeldRefs = (schema: ObjectValidator, data: Record<string, unknown>) =>
  new Set(refsIn(data, schema).filter((r) => isRecordRef(r.ref.to) || r.ref.to === "senders").map((r) => refKey(r.ref, r.id)));

/**
 * How a write judges the company and person refs it holds (docs/modules.md, "Refs"). They are the record service's,
 * which a mutation can't read, so the action in front of the write admits them (convex/modules.ts admitRecords):
 * - absent: no action admits any, so only a ref the doc already held passes;
 * - "ask": the action's first run, which writes nothing: every new ref passes and is listed (`unadmitted`), and the
 *   run throws them for the action to admit;
 * - the refKeys the action admitted, through the writer's record client (Canon's: any live record of the workspace).
 */
export type Admit = "ask" | string[];
/** Why a write's run threw, when it was asked to list the company and person refs to admit. */
export type AdmitAsk = { admitRecords: Array<{ to: RecordRefTo; id: string }> };

/**
 * A ref's id checked in the workspace: a member, a deal (not archived; one `access` sees, when given), a team, a
 * company or person (`record`), or a doc of the module's collection (one `readable` admits, when given).
 */
function refResolver(db: Db, orgId: Id<"organizations">, doc: (collection: string, key: string) => Promise<boolean>, access: Access | null, record: (ref: RefValidator, id: string) => boolean): RefResolver {
  const senders = senderReader({ db } as QueryCtx, orgId, access);
  return async (ref, id) => {
    if (isRecordRef(ref.to)) return record(ref, id);
    if (ref.to === "senders") return (await senders.byId(id)) !== null;
    if (ref.to === "users") {
      const u = db.normalizeId("users", id);
      const row = u ? await db.get(u) : null;
      return !!row && (await userBelongsToOrg({ db } as QueryCtx, row, orgId));
    }
    if (ref.to === "deals") {
      const d = db.normalizeId("deals", id);
      const row = d ? await db.get(d) : null;
      return !!row && row.orgId === orgId && row.archivedAt === undefined && (access === null || (permissionOf(access, "deal").read && dealVisible(access, row)));
    }
    if (ref.to === "teams") {
      const t = db.normalizeId("teamGroups", id);
      const row = t ? await db.get(t) : null;
      return !!row && row.orgId === orgId;
    }
    return doc(ref.collection ?? "", id);
  };
}

/** A stored file as a write may use it: what it is, or why the writer can't put it in a doc. */
export type FileRow = { name: string; type: string; bytes: number } | { refused: string };
/** A file id looked up for a write: the file, or why it can't go in a doc (not this module's, or not the writer's). */
type FileResolver = (id: string) => Promise<FileRow>;

/** Why `value` doesn't fit `schema`, every ref it holds checked once per `memo`, every file by `files`. */
async function fitProblems(schema: ObjectValidator, value: Record<string, unknown>, resolve: RefResolver, memo: Map<string, boolean>, files?: FileResolver, fileMemo = new Map<string, FileRow>()): Promise<string[]> {
  if (JSON.stringify(value).length > DATA_MAX_BYTES) return [`a doc is at most ${DATA_MAX_BYTES / 1024} KB`];
  for (const { ref, id } of refsIn(value, schema)) {
    const k = refKey(ref, id);
    if (!memo.has(k)) memo.set(k, await resolve(ref, id));
  }
  for (const { id } of filesIn(value, schema)) if (!fileMemo.has(id)) fileMemo.set(id, files ? await files(id) : { refused: "isn't a file" });
  const fileOk = (v: FileValidator, id: string) => {
    const f = fileMemo.get(id) ?? { refused: "isn't a file" };
    return "refused" in f ? f.refused : fileFits(v, f);
  };
  return valueProblems(value, schema, "data", (ref, id) => memo.get(refKey(ref, id)) === true, fileOk);
}

/**
 * A write's schema problems as its refusal: each in plain words ("Signature is required", plainProblem), and only
 * those when every one names a field the person filled; else what the write isn't, then why.
 */
function plainRefusal(problems: readonly string[], schema: ObjectValidator, what: string): string {
  const plain = problems.slice(0, 5).map((x) => plainProblem(x, schema));
  if (plain.every((x) => x !== null)) return `${plain.join("; ")}.`;
  return `That isn't ${what}: ${plain.map((x, i) => x ?? problems[i]).join("; ")}.`;
}

/** Why a write refuses while an admin views as a member. */
export const PREVIEW_OFF = (name: string) => `You are viewing as ${name}: changes are off until you exit the preview`;
export const readsOnly = (call: Pick<CallDecl, "writes" | "canon">) => !call.canon && call.writes.length === 0;

/** Whether an upgrade's cutover is swapping migrated docs in: nothing reads or writes the module for those seconds. */
export const cuttingOver = (pkg: Pick<Doc<"modulePackages">, "pending">) => pkg.pending?.phase === "cutover" && !pkg.pending.error;

export async function shareDocs(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, moduleId: string, manifest: ModuleManifest, share: ShareDecl, rootKey: string, rootOnly = false): Promise<Record<string, ModuleDoc[]> | null> {
  const root = rememberModuleRow(ctx, await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", share.collection).eq("key", rootKey)).unique());
  if (!root) return null;
  const doc = (r: Doc<"moduleDocs">): ModuleDoc => ({ key: r.key, version: r.version, data: r.data, owner: r.ownerUserId ?? null, parentKey: r.parentKey ?? null, createdAt: r.sourceCreatedAt ?? r._creationTime, updatedAt: r.updatedAt, gen: r.gen ?? 0, gens: r.gens ?? {} });
  const out: Record<string, ModuleDoc[]> = { [share.collection]: [doc(root)] };
  if (rootOnly) return out;
  for (const collection of Object.keys(share.read)) {
    if (collection === share.collection) continue;
    if (manifest.collections[collection]?.setOf?.parent !== share.collection) return null;
    const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection).eq("parentKey", rootKey).eq("gen", liveGen(root, collection))).take(MAX_VIEW_LIMIT + 1);
    if (rows.length > MAX_VIEW_LIMIT) return null;
    out[collection] = rows.map((row) => doc(rememberModuleRow(ctx, row)!));
  }
  return out;
}

export async function shareFileInfo(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, moduleId: string, ids: readonly string[]): Promise<Record<string, FileInfo>> {
  const out: Record<string, FileInfo> = {};
  for (const id of ids.slice(0, LABELS_MAX)) {
    const fid = ctx.db.normalizeId("moduleFiles", id), f = fid ? await ctx.db.get(fid) : null;
    if (f && f.orgId === orgId && f.moduleId === moduleId && f.storageId) out[id] = fileMetadata(f);
  }
  return out;
}

export async function recordVisitEvent(ctx: MutationCtx, at: { orgId: Id<"organizations">; moduleId: string; collection: string; key: string }, actor: Extract<ModuleEvent["actor"], { kind: "visitor" }>, verb: "visit.opened" | "visit.page", path?: string): Promise<void> {
  await ctx.db.insert("moduleEvents", { ...at, actor, verb, kind: "event", fields: [], ...(path === undefined ? {} : { args: { path } }), at: Date.now() });
}

function moduleWritable(manifest: ModuleManifest, collection: string): void {
  if (roomRecordCollections(manifest).has(collection)) refuse("Only Canon visitor logging writes this collection.");
}

export async function recordVisitorDay(ctx: MutationCtx, pkg: Doc<"modulePackages">, manifest: ModuleManifest, share: ShareDecl, root: ModuleDoc, visitor: { id: string; name?: string; email?: string; verified: boolean }, kind: "opened" | "acted", now: number): Promise<void> {
  return withModulePublication(ctx, async () => {
    const source = moduleSource(pkg);
    if (!share.record) return;
    const collection = share.record.collection, c = manifest.collections[collection];
    const day = new Date(now).toISOString().slice(0, 10), gen = root.gens?.[collection] ?? root.gen ?? 0;
    const key = `${visitor.id}|${day}|${gen}`;
    const row = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("collection", collection).eq("key", key)).unique();
    const prior = row?.data ?? {};
    const data = { visitor: visitor.id, ...(visitor.name ? { name: visitor.name } : {}), ...(visitor.email ? { email: visitor.email } : {}), verified: visitor.verified, day,
      views: Number(prior.views ?? 0) + (kind === "opened" ? 1 : 0), actions: Number(prior.actions ?? 0) + (kind === "acted" ? 1 : 0), lastAt: now };
    const slots = slotColumns(c, pkg.slots?.[collection] ?? defaultSlots(manifest)[collection] ?? {}, data, root.key, gen);
    const pending = pkg.pending && !pkg.pending.error ? await pendingManifestOf(ctx, pkg) : null;
    if (pending && !pending.collections[collection]) refuse("This visitor record collection is being removed by an upgrade.");
    const nextSlots = pending ? slotColumns(pending.collections[collection], pkg.pending!.slots[collection] ?? {}, data, root.key, gen) : {};
    if (row) await patchModuleDoc(writeCtx(ctx), source, row._id, { data, version: row.version + 1, ...slots, ...nextSlots, updatedAt: now });
    else await insertModuleDoc(writeCtx(ctx), source, { orgId: pkg.orgId, moduleId: pkg.moduleId, collection, key, parentKey: root.key, gen, data, version: 1, ...slots, ...nextSlots, updatedAt: now });
  });
}

type VisitorUploadOwner = NonNullable<Doc<"moduleFiles">["visitorUpload"]>;

type ShareWriteBound = {
  pkg: Doc<"modulePackages">; manifest: ModuleManifest; share: ShareDecl; shareName: string; rootKey: string;
  tree: Record<string, ModuleDoc[]>; visitor: VisitorIdentity;
  actor: Extract<ModuleEvent["actor"], { kind: "visitor" }>; evidence: { ip: string; userAgent: string };
  uploadOwner: { grantId: VisitorUploadOwner["grantId"]; sessionHash: string; policyHash: string; rootCreatedAt: number };
};

export function shareUploadField(bound: Pick<ShareWriteBound, "pkg" | "manifest" | "share" | "shareName" | "rootKey" | "tree">, target: VisitorUploadTarget): { collection: string; file: FileValidator; generation: number } | null {
  const { manifest, share, tree } = bound;
  const projected = projectShare(manifest, share, bound.rootKey, tree);
  if (bound.pkg.pending && !bound.pkg.pending.error && holdsWrites(bound.pkg.pending.work)) return null;
  const op = target.kind === "op" ? manifest.ops[target.op] : undefined;
  const machine = target.kind === "transition" ? manifest.machines?.[target.machine] : undefined;
  const move = target.kind === "transition" ? machine?.transitions[target.transition] : undefined;
  const decl = op ?? move, verb = target.kind === "op" ? target.op : `${target.machine}.${target.transition}`;
  if (!decl || !(target.kind === "op" ? share.write.ops : share.write.transitions).includes(verb) || decl.share !== bound.shareName || !decl.roles.includes("visitor") || decl.system || decl.dirties !== undefined || decl.effects?.some((fx) => !("notify" in fx)) || move?.ai || move?.run || move?.at || move?.seal) return null;
  const collection = op?.collection ?? machine!.collection, c = manifest.collections[collection], read = share.read[collection];
  moduleWritable(manifest, collection);
  if (!c || !read || op?.kind === "delete") return null;
  const creating = op?.kind === "create";
  const before = tree[collection]?.find((d) => d.key === target.key && inShareTree(manifest, share, collection, d, bound.rootKey) && shareWhereHolds(read.where, d.data));
  if (creating ? c.setOf?.parent !== share.collection || target.key !== undefined || target.expect !== undefined || (tree[collection]?.length ?? 0) >= MAX_VIEW_LIMIT : !before || before.version !== target.expect) return null;
  const root = tree[share.collection]?.[0], integrity = manifest.collections[share.collection].integrity;
  if (!root || !projected[share.collection]?.length || !creating && !projected[collection]?.some((d) => d.key === target.key) || c.integrity && before?.data[c.integrity.field] || collection !== share.collection && integrity?.children?.[collection] && root.data[integrity.field]) return null;
  if (move && !move.from.includes(String(before!.data[machine!.field] ?? ""))) return null;
  const spec = target.kind === "op" ? op?.fields?.includes(target.field) && !Object.hasOwn(op.set ?? {}, target.field) ? c.schema.value[target.field] : undefined : move?.args?.value[target.field];
  if (!spec || coreOf(spec.fieldType).type !== "file" || machineFields(manifest, collection).has(target.field) || c.integrity?.field === target.field || typeof c.key === "object" && !creating && c.key.from.includes(target.field)) return null;
  return { collection, file: coreOf(spec.fieldType) as FileValidator, generation: root.gens?.[collection] ?? root.gen ?? 0 };
}

export async function writeShareDoc(ctx: MutationCtx, bound: ShareWriteBound, input: VisitorWrite) {
  return withModulePublication(ctx, async () => {
    const source = moduleSource(bound.pkg);
    const deny = (): never => refuse("This change could not be saved. Refresh the shared page and try again.");
    const { pkg, manifest, share, rootKey } = bound;
    const tree = await shareDocs(ctx, pkg.orgId, pkg.moduleId, manifest, share, rootKey);
    if (!tree) return deny();
    const projected = projectShare(manifest, share, rootKey, tree);
    if (pkg.pending && !pkg.pending.error && holdsWrites(pkg.pending.work)) return deny();
    const root = tree[share.collection]?.[0];
    if (!root || root.createdAt !== bound.uploadOwner.rootCreatedAt || !projected[share.collection]?.length) return deny();
    const op = input.kind === "op" ? manifest.ops[input.op] : undefined;
    const machine = input.kind === "transition" ? manifest.machines?.[input.machine] : undefined;
    const move = input.kind === "transition" ? machine?.transitions[input.transition] : undefined;
    const decl = op ?? move;
    const verb = input.kind === "op" ? input.op : `${input.machine}.${input.transition}`;
    const allowed = input.kind === "op" ? share.write.ops : share.write.transitions;
    if (!decl || !allowed.includes(verb) || decl.share !== bound.shareName || !decl.roles.includes("visitor") || decl.system || decl.dirties !== undefined || decl.effects?.some((fx) => !("notify" in fx)) || move?.ai || move?.run || move?.at || move?.seal) return deny();
    const collection = op?.collection ?? machine!.collection, c = manifest.collections[collection];
    moduleWritable(manifest, collection);
    const read = share.read[collection];
    if (!read || !c || op?.kind === "delete") return deny();
    const creating = op?.kind === "create";
    if (creating && (tree[collection]?.length ?? 0) >= MAX_VIEW_LIMIT) return deny();
    if (creating && (c.setOf?.parent !== share.collection || input.key !== undefined || input.expect !== undefined || input.kind !== "op" || input.unset?.length)) return deny();
    const before = creating ? undefined : tree[collection]?.find((d) => d.key === input.key && inShareTree(manifest, share, collection, d, rootKey) && shareWhereHolds(read.where, d.data));
    if (!creating && (!before || !projected[collection]?.some((d) => d.key === before.key) || input.expect !== before.version)) return deny();
    const raw = before ? await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("collection", collection).eq("key", before.key)).unique() : null;
    if (!creating && (!raw || raw.version !== before!.version || collection !== share.collection && (raw.parentKey !== rootKey || (raw.gen ?? 0) !== (root.gens?.[collection] ?? root.gen ?? 0)))) return deny();
    const docIsSealed = c.integrity && before?.data[c.integrity.field];
    const rootIntegrity = manifest.collections[share.collection].integrity;
    const rootSealBlocksChild = collection !== share.collection && rootIntegrity?.children?.[collection] && root.data[rootIntegrity.field];
    if (docIsSealed || rootSealBlocksChild) return deny();
    const parentKey = creating ? rootKey : before!.parentKey;
    const given = input.kind === "op" ? input.data ?? {} : {};
    const unset = input.kind === "op" ? input.unset ?? [] : [];
    const protectedFields = new Set([...machineFields(manifest, collection).keys(), ...(c.integrity ? [c.integrity.field] : []), ...(typeof c.key === "object" && !creating ? c.key.from : [])]);
    if (Object.keys(given).some((f) => !op?.fields?.includes(f) || protectedFields.has(f)) || unset.some((f) => !op?.fields?.includes(f) || !c.schema.value[f]?.optional || protectedFields.has(f) || Object.hasOwn(given, f))) return deny();
    const args = input.kind === "transition" ? input.args ?? {} : {};
    if (valueProblems(args, move?.args ?? NO_ARGS, "args", (ref, id) => ref.to === "doc" && !!ref.collection && !!projected[ref.collection]?.some((d) => d.key === id), () => null).length || !shareInputRefs(manifest, share, projected, move?.args?.value ?? {}, args) || !shareInputRefs(manifest, share, projected, c.schema.value, given)) return deny();
    const noAuthority = async (): Promise<never> => deny();
    const visible = before ? projected[collection]?.find((d) => d.key === before.key)?.data ?? {} : {};
    const subject: Subject = { key: before?.key ?? "", data: { ...visible, ...given }, owner: before?.owner ?? null, parentKey, collection };
    const env: Env = { doc: before ? { ...subject, data: visible } : subject, args,
      shared: { root: { key: rootKey, data: projected[share.collection][0].data, owner: null, collection: share.collection }, ...(collection !== share.collection ? { parent: { key: rootKey, data: projected[share.collection][0].data, owner: null, collection: share.collection } } : {}) }, caller: { userId: null, role: "visitor", teamOwners: [] }, visitor: bound.visitor, now: Date.now(),
      count: noAuthority, first: noAuthority, get: noAuthority, fresh: noAuthority, intact: noAuthority, fiscalYearStartMonth: noAuthority };
    if (!visitorValueFits(given) || !visitorValueFits(args)) return deny();
    const data = { ...(before?.data ?? {}), ...given };
    if (move) {
      const from = String(before!.data[machine!.field] ?? "");
      if (!move.from.includes(from)) return deny();
      for (const guard of move.guards ?? []) if (!await holds(guard.when, subject, env)) return deny();
      data[machine!.field] = move.to === undefined ? from : await targetState(machine!, move, subject, env);
    }
    for (const [field, expr] of Object.entries(decl.set ?? {})) {
      if (protectedFields.has(field)) return deny();
      if (isUnset(expr)) delete data[field];
      else {
        const value = await valueOf(expr, env);
        if (value !== null && value !== undefined) data[field] = value;
      }
    }
    for (const f of unset) delete data[f];
    if (creating) for (const [field, name] of machineFields(manifest, collection)) data[field] = manifest.machines![name].initial;
    const after = { ...subject, data: Object.fromEntries(Object.entries(data).filter(([f]) => read.fields.includes(f))) };
    if (op) for (const guard of op.guards ?? []) if (!await holds(guard.when, after, { ...env, doc: after })) return deny();
    if (!shareWhereHolds(read.where, data) || !visitorValueFits(Object.fromEntries(Object.keys(data).filter((f) => creating || canonicalJson(data[f]) !== canonicalJson(before?.data[f] ?? null)).map((f) => [f, data[f]])))) return deny();
    const refAlreadyOnDoc = (ref: RefValidator, id: string) => !!before && refsIn(before.data, c.schema).some((r) => canonicalJson(r.ref) === canonicalJson(ref) && r.id === id);
    const allowedRef = (ref: RefValidator, id: string) => ref.to === "doc" && !!ref.collection && !!share.read[ref.collection] ? !!projected[ref.collection]?.some((d) => d.key === id) : refAlreadyOnDoc(ref, id);
    const newFiles = new Map<string, Doc<"moduleFiles">>();
    for (const [field, value] of Object.entries(input.kind === "op" ? given : args)) {
      const target: VisitorUploadTarget = input.kind === "op" ? { kind: "op", op: input.op, ...(input.key === undefined ? {} : { key: input.key }), ...(input.expect === undefined ? {} : { expect: input.expect }), field } : { kind: "transition", machine: input.machine, transition: input.transition, key: input.key, expect: input.expect, field };
      const declared = shareUploadField({ ...bound, tree }, target);
      if (!declared || typeof value !== "string") continue;
      if (before && filesIn(before.data, c.schema).some((f) => f.id === value)) continue;
      const file = await visitorUploadRow(ctx, value), upload = file?.visitorUpload, owner = bound.uploadOwner;
      if (!file || !upload || !owner || upload.state !== "stored" || upload.expiresAt <= env.now || !file.storageId || file.orgId !== pkg.orgId || file.moduleId !== pkg.moduleId || upload.grantId !== owner.grantId || upload.visitorId !== bound.visitor.id || upload.sessionHash !== owner.sessionHash || upload.policyHash !== owner.policyHash || upload.rootCreatedAt !== owner.rootCreatedAt || upload.target !== canonicalJson(target) || upload.collection !== collection || upload.generation !== declared.generation || !visitorFileFits(declared.file, { ...file, digest: upload.digest })) return deny();
      newFiles.set(value, file);
    }
    const heldFile: FileResolver = async (id) => {
      const added = newFiles.get(id);
      if (added) return fileMetadata(added);
      if (!before || !filesIn(before.data, c.schema).some((f) => f.id === id)) return { refused: "cannot attach files" };
      const fid = ctx.db.normalizeId("moduleFiles", id), file = fid ? await ctx.db.get(fid) : null;
      return file && file.orgId === pkg.orgId && file.moduleId === pkg.moduleId && file.storageId ? { name: file.name, type: file.type, bytes: file.bytes } : { refused: "isn't a file" };
    };
    if (move && (await fitProblems(move.args ?? NO_ARGS, args, async (ref, id) => allowedRef(ref, id), new Map(), heldFile)).length) return deny();
    for (const f of new Set([...Object.keys(given), ...Object.keys(decl.set ?? {})])) {
      const sp = c.schema.value[f];
      if (!sp) return deny();
      if (!isUnset(decl.set?.[f]) && !shareInputRefs(manifest, share, projected, { [f]: sp }, { [f]: data[f] })) return deny();
    }
    if ((await fitProblems(c.schema, data, async (ref, id) => allowedRef(ref, id), new Map(), heldFile)).length) return deny();
    const pending = pkg.pending && !pkg.pending.error ? await pendingManifestOf(ctx, pkg) : null;
    if (pending) {
      const next = pending.collections[collection];
      if (!next || (await fitProblems(next.schema, data, async (ref, id) => allowedRef(ref, id), new Map(), heldFile)).length) return deny();
    }
    let key = before?.key;
    if (!key) key = c.key === "auto" ? crypto.randomUUID() : c.key.from.map((f) => String(data[f] ?? "")).join("|");
    if (!key) return deny();
    const resultingFiles = new Set(filesIn(data, c.schema).map((f) => f.id));
    if ([...newFiles.keys()].some((id) => !resultingFiles.has(id))) return deny();
    const parent = creating ? await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("collection", share.collection).eq("key", rootKey)).unique() : null;
    const gen = raw?.gen ?? (parent ? liveGen(parent, collection) : 0);
    const slots = slotColumns(c, pkg.slots?.[collection] ?? defaultSlots(manifest)[collection] ?? {}, data, parentKey ?? undefined, gen);
    const nextSlots = pending?.collections[collection] ? slotColumns(pending.collections[collection], pkg.pending!.slots[collection] ?? {}, data, parentKey ?? undefined, gen) : {};
    const version = (before?.version ?? 0) + 1;
    const owner = c.owner && typeof data[c.owner] === "string" ? data[c.owner] as Id<"users"> : undefined;
    if (raw) await patchModuleDoc(writeCtx(ctx), source, raw._id, { data, version, ownerUserId: owner, ...slots, ...nextSlots, updatedAt: env.now });
    else {
      if (await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("collection", collection).eq("key", key!)).unique()) return deny();
      await insertModuleDoc(writeCtx(ctx), source, { orgId: pkg.orgId, moduleId: pkg.moduleId, collection, key, data, version, ...(owner ? { ownerUserId: owner } : {}), parentKey: rootKey, gen, ...slots, ...nextSlots, updatedAt: env.now });
    }
    for (const file of newFiles.values()) await ctx.db.patch(file._id, { attachedTo: { collection, key }, visitorUpload: { ...file.visitorUpload!, state: "attached" } });
    const eventId = await ctx.db.insert("moduleEvents", { orgId: pkg.orgId, moduleId: pkg.moduleId, collection, key, actor: bound.actor, verb, kind: move ? "transition" : creating ? "create" : "update", fields: [...new Set([...Object.keys(given), ...unset, ...Object.keys(decl.set ?? {}), ...(move ? [machine!.field] : [])])], ...(before ? { fromVersion: before.version } : {}), toVersion: version, ...(move ? { from: String(before!.data[machine!.field]), to: String(data[machine!.field]), ...(Object.keys(args).length ? { args } : {}) } : {}), evidence: bound.evidence, at: env.now });
    return { eventId, env: { ...env, doc: { ...after, key } }, effects: (decl.effects ?? []).filter((fx): fx is NotifyEffect => "notify" in fx) };
  });
}

type Principal =
  | { kind: "user"; user: Doc<"users">; access: Access; role: Role; agent: string | null; hierOwners: readonly string[]; capabilities?: readonly string[]; session?: true }
  | { kind: "system"; orgId: Id<"organizations"> };

/**
 * The caller's scope on `module` (its slug or id), or null when the caller is signed out or the module isn't
 * installed and on in their workspace.
 */
export async function moduleScope(ctx: QueryCtx | MutationCtx, module: string, admit?: Admit): Promise<ModuleScope | null> {
  const caller = await moduleScopeCaller(ctx);
  if (!caller) return null;
  const pkg = await installedModule(ctx, caller.user.orgId, module);
  if (!pkg || !(await isEnabled(ctx, caller.user.orgId, pkg.moduleId))) return null;
  return caller.enabledScope(pkg, admit);
}

/** A transaction's caller context, shared by scopes for packages already read by enabledModules. */
export async function moduleScopeCaller(ctx: QueryCtx | MutationCtx) {
  const user = await getCurrentUser(ctx);
  if (!user) return null;
  let principal: Promise<Extract<Principal, { kind: "user" }>> | undefined;
  let hierOwners: Promise<string[]> | undefined;
  let icpsOwner: ReturnType<typeof interfaceOwner> | undefined;
  const principalOf = () => principal ??= (async () => {
    const access = await accessFor(ctx, user);
    // All session module writes, including those using shared scopes, refuse a view-as preview.
    if (access.preview && isMutation(ctx)) refuse(PREVIEW_OFF(access.preview.asName));
    const role = baseRole(access.role, await roleBasesOf(ctx, user.orgId)) as Role;
    return { kind: "user", session: true, user, access, role, agent: await agentClientOf(ctx), hierOwners: [access.userId], capabilities: (await withRole(ctx, { ...user, orgId: user.orgId, role: access.role }))?.capabilities };
  })();
  return {
    user,
    enabledScope: async (pkg: Doc<"modulePackages">, admit?: Admit): Promise<ModuleScope | null> => {
      if (pkg.orgId !== user.orgId || pkg.status !== "installed") return null;
      if (cuttingOver(pkg)) refuse(`${manifestOf(pkg).title} is finishing its upgrade to v${pkg.pending!.version}. Try again in a moment.`);
      const caller = await principalOf();
      const owners = usesHier(manifestOf(pkg)) ? await (hierOwners ??= managerChainOwners(ctx, user.orgId, caller.access.userId)) : caller.hierOwners;
      const ownsIcps = pkg.moduleId !== ICPS_MODULE || (await (icpsOwner ??= interfaceOwner(ctx, user.orgId)))?.packageId === pkg._id;
      return scopeOf(ctx, { ...caller, hierOwners: owners }, pkg, await pendingManifestOf(ctx, pkg), admit, ownsIcps, true);
    },
  };
}

/**
 * A member's scope on `module`, from no session: for a hosted AI step a move started in the background, which runs as
 * the person who moved the doc, or its owner (docs/modules.md, "Hosted AI steps"). Their role and scopes, never an
 * admin's preview; internal functions only.
 */
export async function personScope(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, userId: Id<"users">, module: string, admit?: Admit, agent: string | null = null): Promise<ModuleScope | null> {
  const pkg = await installedModule(ctx, orgId, module);
  if (!pkg || !(await isEnabled(ctx, orgId, pkg.moduleId)) || cuttingOver(pkg)) return null;
  const [access] = (await principalAccess(ctx, orgId, [userId])) ?? [];
  const user = await ctx.db.get(userId);
  if (!access || !user) return null;
  const role = baseRole(access.role, await roleBasesOf(ctx, orgId)) as Role;
  const hierOwners = usesHier(manifestOf(pkg)) ? await managerChainOwners(ctx, orgId, access.userId) : [access.userId];
  return scopeOf(ctx, { kind: "user", user: { ...user, orgId }, access, role, agent, hierOwners, capabilities: (await withRole(ctx, { ...user, orgId, role: access.role }))?.capabilities }, pkg, await pendingManifestOf(ctx, pkg), admit, pkg.moduleId !== ICPS_MODULE || (await interfaceOwner(ctx, pkg.orgId))?.packageId === pkg._id, true);
}

/** Read as an exact internal Access snapshot, including previews and intersected background principals. */
export async function accessScope(ctx: QueryCtx, orgId: Id<"organizations">, access: Access, module: string): Promise<ModuleScope | null> {
  const pkg = await installedModule(ctx, orgId, module);
  if (!pkg || !(await isEnabled(ctx, orgId, pkg.moduleId))) return null;
  if (cuttingOver(pkg)) refuse(`${manifestOf(pkg).title} is finishing its upgrade. Try again shortly.`);
  const id = ctx.db.normalizeId("users", access.userId);
  const user = id ? await ctx.db.get(id) : null;
  if (!user || !await roleIn(ctx, user, orgId)) return refuse("An activity report principal is no longer a workspace member.");
  const role = baseRole(access.role, await roleBasesOf(ctx, orgId)) as Role;
  const hierOwners = usesHier(manifestOf(pkg)) ? await managerChainOwners(ctx, orgId, access.userId) : [access.userId];
  return scopeOf(ctx, { kind: "user", user: { ...user, orgId, role: access.role }, access, role, agent: null, hierOwners }, pkg, await pendingManifestOf(ctx, pkg), undefined, pkg.moduleId !== ICPS_MODULE || (await interfaceOwner(ctx, pkg.orgId))?.packageId === pkg._id, true);
}

/**
 * Canon's own scope on `module` in a workspace: for jobs (M4b) and the internal functions that stand in for them. It
 * reads every doc and runs only the transitions, ops and calls the manifest marks `system`, as "System".
 */
export async function systemScope(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, module: string, includeDisabled = false, admit?: Admit): Promise<ModuleScope | null> {
  const pkg = await installedModule(ctx, orgId, module);
  if (!pkg || (!includeDisabled && !(await isEnabled(ctx, orgId, pkg.moduleId))) || cuttingOver(pkg)) return null;
  return scopeOf(ctx, { kind: "system", orgId }, pkg, await pendingManifestOf(ctx, pkg), admit, pkg.moduleId !== ICPS_MODULE || (await interfaceOwner(ctx, pkg.orgId))?.packageId === pkg._id, includeDisabled ? null : true);
}

/**
 * Apply an approved module proposal (convex/patchPlans.ts apply): the proposed op or transition, run again as the
 * person applying it, with every check but the `propose` one its approval answers. A proposal made before the module
 * was upgraded doesn't apply: what it was checked against has changed.
 */
export async function applyModuleProposal(ctx: MutationCtx, plan: Pick<Doc<"patchPlans">, "_id" | "args"> & Partial<Pick<Doc<"patchPlans">, "approvedOperationIds" | "totalOperationCount">>) {
  const a = plan.args as ProposalArgs;
  const scope = (await moduleScope(ctx, a.module)) ?? refuse(`This workspace has no module ${a.module} turned on.`);
  if ((a.epoch ?? 1) !== scope.epoch) refuse(`${scope.manifest.title} was upgraded since this was proposed. Propose it again.`);
  const approval = { proposal: plan._id };
  if (a.kind === "call") {
    // A proposed call applies whole, all or none: a reviewer who left any of its writes out hasn't approved the call.
    const approved = new Set(plan.approvedOperationIds ?? []);
    const total = plan.totalOperationCount ?? 1;
    if (Array.from({ length: total }, (_, i) => String(i + 1)).some((id) => !approved.has(id))) refuse("This proposal applies whole: approve every write in it, or reject it.");
    return scope.apply(a.call, a.intents as AppliedIntent[]);
  }
  if (a.kind === "transition") return scope.transition(a.machine, a.name, { key: a.key, expect: a.expect, args: a.args, reason: a.reason }, approval);
  return scope.op(a.op, { key: a.key, parentKey: a.parentKey, expect: a.expect, data: a.data, unset: a.unset }, approval);
}

/** `nextManifest`: the manifest of a newer version installing (pendingManifestOf), or null. */
/** Whether any collection gives a role the `hier` scope (docs/modules.md, "Collections"). */
const usesHier = (m: ModuleManifest) => Object.values(m.collections).some((c) => Object.values(c.access).some((s) => (typeof s === "string" ? s : s.scope) === "hier"));
/** The most members one manager chain admits; past it the scope refuses rather than read part of the tree. */
const HIER_MAX = 2000;
/** How deep a manager chain reads. */
const HIER_DEPTH = 10;
/**
 * The caller and everyone under them by `managerId`, to HIER_DEPTH levels: whom a VP's `hier` scope admits. Read by
 * the users' manager index, a level at a time; a member who reports in a loop is read once.
 */
async function managerChainOwners(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, userId: string): Promise<string[]> {
  const out = new Set<string>([userId]);
  let level = [userId];
  for (let depth = 0; depth < HIER_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const managerId of level) {
      const id = ctx.db.normalizeId("users", managerId);
      if (!id) continue;
      for (const u of await ctx.db.query("users").withIndex("by_managerId", (q) => q.eq("managerId", id)).take(HIER_MAX + 1)) {
        if (u.orgId !== orgId || out.has(u._id)) continue;
        out.add(u._id);
        next.push(u._id);
        if (out.size > HIER_MAX) return refuse(`More than ${HIER_MAX} people report to you; a manager-chain scope reads at most ${HIER_MAX}.`);
      }
    }
    level = next;
  }
  return [...out];
}

function scopeOf(ctx: QueryCtx | MutationCtx, principal: Principal, pkg: Doc<"modulePackages">, nextManifest: ModuleManifest | null, admit?: Admit, definitionsOwned = true, enabled: boolean | null = null): ModuleScope {
  const system = principal.kind === "system";
  const orgId = system ? principal.orgId : principal.user.orgId;
  const moduleId = pkg.moduleId;
  const manifest = manifestOf(pkg);
  let source = moduleSource(pkg, enabled);
  const epoch = pkg.epoch ?? 1;
  const revision = `${pkg._id}:${epoch}:${pkg.manifestHash}:${pkg.bundleHash ?? ""}`;
  const bundle: ModuleBundle | null = pkg.bundleHash && pkg.bundleStorageId ? { hash: pkg.bundleHash, storageId: pkg.bundleStorageId } : null;
  // Canon reads as an admin would, and is no one: it owns nothing and no team.
  const access: Access = system ? accessOf({ userId: "system", role: "admin" }) : principal.access;
  /** The owners a `team` or a `hier` scope admits. */
  const groupOwners = (base: string): readonly string[] => (base === "hier" && !system ? principal.hierOwners : access.teamOwners);
  const isGroup = (base: string) => base === "team" || base === "hier";
  const role: Role = system ? "admin" : principal.role;
  const agent = system ? null : principal.agent;
  function admission(decl: { roles: readonly string[]; capability?: Capability; system?: true; agent: string; label: string; reason?: string }, write = true, authority: { role: string; capabilities?: readonly string[] } | null = principal.kind === "user" ? { role: access.role, capabilities: principal.capabilities } : null): string | null {
    if (write && !system && !definitionsOwned) return "ICPs remain Canon-owned. This module is read-only until the explicit cutover.";
    if (write && access.preview) return PREVIEW_OFF(access.preview.asName);
    if (decl.capability && (decl.system || decl.roles.includes("visitor"))) return "A capability requires member authority.";
    if (decl.system) return system ? null : SYSTEM_ONLY(decl.label);
    if (system) return NOT_SYSTEM(decl.label);
    if (!decl.roles.length) return `${decl.label} runs only as part of another transition.`;
    if (!decl.roles.includes(role) || (decl.capability && (!authority || !can(authority, decl.capability)))) return `Your role can't ${lower(decl.label)} in ${manifest.title}.`;
    if (agent && decl.agent === "human") return `An agent can't ${lower(decl.label)}: ${decl.reason}`;
    return null;
  }
  const callerRole = system ? ("system" as const) : role;
  const actor = system ? { kind: "system" as const } : { kind: agent ? ("agent" as const) : ("user" as const), userId: principal.user._id, ...(agent ? { client: agent } : {}) };
  const slots: SlotMap = pkg.slots ?? defaultSlots(manifest);
  // A newer version installing. One that stopped on a doc is waiting to be replaced, so writes no longer fit it too.
  // Migrations and owner backfills hold writes until the new version serves.
  const live = pkg.pending && !pkg.pending.error ? pkg.pending : null;
  const migrating = live && holdsWrites(live.work) ? live.version : null;
  const next = live && !migrating ? nextManifest : null;
  const pending = next && live ? { manifest: next, slots: live.slots, version: live.version } : null;
  /** Refuses writes while the upgrade cannot preserve them under the installed declaration. */
  const notMigrating = () => { if (migrating) refuse(`${manifest.title} is upgrading to v${migrating}: its data is read only until the upgrade is done, in a moment.`); };
  const docs = () => ctx.db.query("moduleDocs") as unknown as Loose;

  const collectionOf = (name: string): CollectionDecl => manifest.collections[name] ?? refuse(`${manifest.title} has no collection ${name}.`);
  const getRow = async (collection: string, key: string) =>
    rememberModuleRow(ctx, await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection).eq("key", key)).unique());

  /**
   * The doc a row condition's `ref` names, read as Canon (the condition says only whether it holds): its data, or
   * null. A query reads each once; a mutation reads it fresh, as a write before may have changed it.
   */
  const relatedMemo = new Map<string, Record<string, unknown> | null>();
  /**
   * `c`: the collection of the doc under test. A chain's later refs name their collection (the parser says so), and
   * read the field from the related doc `from` they reached.
   */
  const relatedOf = (c: CollectionDecl) => async (field: string, named: string | undefined, from: Record<string, unknown>) => {
    const spec = c.schema.value[field];
    const t = spec ? (spec.fieldType.type === "union" ? spec.fieldType.value.find((x) => x.type === "ref") : spec.fieldType) : undefined;
    const collection = named ?? (t?.type === "ref" && t.to === "doc" ? t.collection : undefined);
    const key = from[field];
    if (!collection || !manifest.collections[collection] || typeof key !== "string") return null;
    const id = `${collection}/${key}`;
    if (!isMutation(ctx) && relatedMemo.has(id)) return relatedMemo.get(id)!;
    const got = (await getRow(collection, key))?.data ?? null;
    if (!isMutation(ctx)) relatedMemo.set(id, got);
    return got;
  };
  const whereHolds = (c: CollectionDecl, w: RowWhere, data: Record<string, unknown>) => rowWhereHolds(w, data, relatedOf(c));
  const effectiveOwnerScope = narrowsReads(access) ? "own" : "all";
  const collectionReadAllowed = (c: CollectionDecl) => system || !c.retainedEvidence || !isRestricted(access);
  const evidenceReadAllowed = async (c: CollectionDecl, data: Record<string, unknown>): Promise<boolean> => {
    if (!collectionReadAllowed(c)) return false;
    if (system || !c.retainedEvidence) return true;
    const raw = data[c.retainedEvidence.deal];
    const id = typeof raw === "string" ? ctx.db.normalizeId("deals", raw) : null;
    const deal = id ? await ctx.db.get(id) : null;
    return !!deal && deal.orgId === orgId && deal.archivedAt === undefined && permissionOf(access, "deal").read && dealVisible(access, deal);
  };
  const normalizedReadScope = (c: CollectionDecl): ReturnType<typeof readScope> => {
    if (!collectionReadAllowed(c)) return "none";
    const scope = readScope(c, role);
    if (typeof scope === "string") return scope === "ownerOrUnrestricted" ? effectiveOwnerScope : scope;
    if ("members" in scope && scope.scope === "ownerOrUnrestricted") return { ...scope, scope: effectiveOwnerScope };
    if ("where" in scope && scope.scope === "ownerOrUnrestricted") return { scope: effectiveOwnerScope, where: scope.where };
    return scope;
  };
  /**
   * Whether the caller's read scope on the doc's own collection admits it; a set's parent is checked apart. Every
   * read and write surface asks this, so a scope's `where` (a related doc's state included) holds on all of them.
   */
  const scopeAdmits = async (c: CollectionDecl, owner: string | null, data: Record<string, unknown>): Promise<boolean> => {
    if (!(await evidenceReadAllowed(c, data))) return false;
    if (system) return true;
    if (c.setOf && !Object.keys(c.access).length) return true;
    const scope = normalizedReadScope(c);
    const base = typeof scope === "string" ? scope : scope.scope ?? "none";
    if (base === "none") return false;
    const inBase = !(base === "own" && owner !== access.userId) && !(isGroup(base) && (owner === null || !groupOwners(base).includes(owner)));
    if (typeof scope === "object" && "or" in scope) return inBase || whereHolds(c, scope.or, data);
    if (!inBase) return false;
    return typeof scope === "string" || "members" in scope || whereHolds(c, scope.where, data);
  };
  const memberPath = (c: CollectionDecl): string | null => {
    const scope = normalizedReadScope(c);
    return typeof scope === "object" && "members" in scope ? scope.members : null;
  };
  const memberSets = (parent: string) => Object.entries(manifest.collections).filter(([, c]) => c.setOf?.parent === parent && memberPath(c) !== null);
  /** A members grant reads a doc and, from a live set doc, its parent. It never grants a write. */
  async function memberAdmits(row: Row): Promise<boolean> {
    const path = memberPath(collectionOf(row.collection));
    if (path !== null && memberNamed(row.data, path, access.userId)) return true;
    for (const [child, c] of memberSets(row.collection)) {
      const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", child).eq("parentKey", row.key).eq("gen", liveGen(row, child))).take(CHILDREN_MAX + 1);
      if (rows.length > CHILDREN_MAX) refuse(`Reading members of ${row.key} needs more than ${CHILDREN_MAX} ${child} docs.`);
      if (rows.some((r) => memberNamed(r.data, memberPath(c)!, access.userId))) return true;
    }
    return false;
  }
  const ownerOf = (c: CollectionDecl, data: Record<string, unknown>) => (c.owner && typeof data[c.owner] === "string" ? (data[c.owner] as string) : null);
  /** The doc a set doc belongs to, when the caller may read it; null otherwise. */
  const readableParent = async (c: CollectionDecl, parentKey: string | undefined, writing = false): Promise<Row | null> => {
    if (!c.setOf || parentKey === undefined) return null;
    const parent = await getRow(c.setOf.parent, parentKey);
    return parent && (await readable(parent, writing)) ? parent : null;
  };
  async function readable(row: Row, writing = false): Promise<boolean> {
    const c = collectionOf(row.collection);
    if (!(await evidenceReadAllowed(c, row.data))) return false;
    if (!(await scopeAdmits(c, row.ownerUserId ?? null, row.data)) && (writing || !(await memberAdmits(row)))) return false;
    if (!c.setOf) return true;
    const parent = await readableParent(c, row.parentKey, writing);
    return parent !== null && liveGen(parent, row.collection) === (row.gen ?? 0);
  }
  const toDoc = (row: Row): ModuleDoc => ({ key: row.key, version: row.version, data: row.data, owner: row.ownerUserId ?? null, parentKey: row.parentKey ?? null, createdAt: row.sourceCreatedAt ?? row._creationTime, updatedAt: row.updatedAt });
  /** The collections the record service keeps for reports: this version's, and a newer installing one's. */
  const projected = new Set([...projectedCollections(manifest), ...(nextManifest ? projectedCollections(nextManifest) : [])]);
  /** A write of a projected doc sends it to the record service after this transaction (jobs.ts REPORT_JOB). */
  const project = async (collection: string, key: string, change?: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) => {
    if (projected.has(collection)) await markDirty(ctx as MutationCtx, orgId, moduleId, manifest, REPORT_JOB, `${collection}|${key}`);
    if (change) await providedCollectionChanged(ctx as MutationCtx, orgId, manifest, collection, change.before, change.after);
  };

  /** The slot columns for a doc: this version's, and while a newer one installs, its new slots too. */
  const slotsOf = (collection: string, data: Record<string, unknown>, parentKey: string | undefined, gen: number) => {
    const out = slotColumns(collectionOf(collection), slots[collection] ?? {}, data, parentKey, gen);
    const nc = pending?.manifest.collections[collection];
    return nc ? { ...out, ...slotColumns(nc, pending!.slots[collection] ?? {}, data, parentKey, gen) } : out;
  };
  /** The index a view reads by: the slot this version gave it. */
  const slotIndex = (collection: string, index: string) => {
    const i = slots[collection]?.[index];
    return i === undefined ? refuse(`${manifest.title} has no index ${index} on ${collection}.`) : i;
  };

  const argValue = (args: Record<string, unknown>, x: Expr): Scalar => {
    if (x === null || typeof x !== "object") return x;
    if ("caller" in x) return access.userId;
    if (isClock(x)) return clockValue(x, Date.now());
    return (args[x.arg] ?? null) as Scalar;
  };
  const checkArgs = (name: string, view: ViewDecl, args: Record<string, unknown>) => {
    const declared = view.args ?? {};
    for (const [k, value] of Object.entries(args)) {
      if (!Object.hasOwn(declared, k)) refuse(`View ${name} takes no argument ${k}.`);
      const type = declared[k];
      if (!isListArg(type)) { if (typeof value !== type) refuse(`View ${name}'s argument ${k} must be a ${type}.`); continue; }
      const item = type.slice(0, -2);
      if (!Array.isArray(value) || !value.every((x) => typeof x === item)) refuse(`View ${name}'s argument ${k} must be a list of ${item}s.`);
      if (new Set(value as unknown[]).size > MAX_IN_VALUES) refuse(`View ${name}'s argument ${k} has ${new Set(value as unknown[]).size} values; a view reads at most ${MAX_IN_VALUES} in one list.`);
    }
    for (const k of Object.keys(declared)) if (args[k] === undefined) refuse(`View ${name} needs argument ${k}.`);
  };

  /**
   * The rows a list view reads, at most `max`. `scoped`: only those the caller's scope admits. Unscoped reads are
   * Canon's own, for a guard's count and an effect's targets: they never reach the caller as docs.
   */
  async function scan(view: ListView, args: Record<string, unknown>, scoped: boolean, max: number, scanMax = SCAN_MAX): Promise<Row[] & { complete?: boolean }> {
    const c = collectionOf(view.collection);
    const out: Row[] & { complete?: boolean } = [];
    out.complete = true;
    // A list argument in `parent` or `eq` reads one range per distinct value, in the list's order (an `in`).
    const values = (x: Expr): Scalar[] => {
      const v = x !== null && typeof x === "object" && "arg" in x ? args[x.arg] : undefined;
      return Array.isArray(v) ? [...new Set(v as Scalar[])] : [argValue(args, x)];
    };
    const eqs: Scalar[][] = [[]];
    for (const x of view.eq ?? []) { const vs = values(x); eqs.splice(0, eqs.length, ...eqs.flatMap((prefix) => vs.map((v) => [...prefix, v]))); }
    const parents = c.setOf ? values(view.parent!) : [undefined];
    const fields = view.index !== undefined ? c.indexes[view.index] : [];
    const scope = normalizedReadScope(c);
    // An `own` reader's view by an index that leads with the owner reads only the caller's docs.
    // Not when a range bounds the owner field itself (no `eq`): pinning would move the range to the next field.
    // A scope widened by `or` reads docs past its owners, so neither shortcut below applies to it.
    const base = memberSets(view.collection).length ? "all" : typeof scope === "string" ? scope : "or" in scope || "members" in scope ? "all" : scope.scope;
    const pinOwner = scoped && !system && view.index !== undefined && base === "own" && fields[0] === c.owner && (Boolean(view.eq?.length) || !view.range);
    // A `team` reader's view by such an index reads one range per owner the scope admits, in the index's order, so a
    // wide workspace never leaves the page short of the team's docs.
    if (scoped && !system && view.index !== undefined && isGroup(base) && fields[0] === c.owner && c.owner !== undefined && !view.eq?.length && !view.range) {
      const owners = [...groupOwners(base)].sort();
      if (owners.length > MAX_IN_VALUES) return refuse(`Your team has more than ${MAX_IN_VALUES} members to read ${view.collection} by.`);
      eqs.splice(0, eqs.length, ...(view.order === "desc" ? owners.reverse() : owners).map((o) => [o as Scalar]));
    }
    const bound = (x: Expr | undefined) => (x === undefined ? null : argValue(args, x));
    const lower = view.range?.gte !== undefined ? ["gte", bound(view.range.gte)] as const : ["gt", bound(view.range?.gt)] as const;
    const upper = view.range?.lte !== undefined ? ["lte", bound(view.range.lte)] as const : ["lt", bound(view.range?.lt)] as const;
    let scanned = 0;
    for (const key of parents) {
      let parentKey: string | undefined, gen = 0;
      if (c.setOf) {
        const parent = typeof key !== "string" ? null : scoped ? await readableParent(c, key) : await getRow(c.setOf.parent, key);
        if (!parent) continue;
        parentKey = key as string; gen = liveGen(parent, view.collection);
      }
      for (const given of eqs) {
        let query;
        if (view.index !== undefined) {
          const i = slotIndex(view.collection, view.index);
          const eq = [...given];
          if (pinOwner) {
            if (eq.length && eq[0] !== access.userId) continue;
            eq[0] = access.userId;
          } else if (scoped && !system && isGroup(base) && fields[0] === c.owner && eq.length && !groupOwners(base).includes(eq[0] as string)) continue;
          const prefix: Scalar[] = [...(c.setOf ? [parentKey!, gen] : []), ...eq];
          const col = (j: number) => `s${i}${SLOT_COLUMNS[j]}`;
          query = docs().withIndex(slotIndexName(i), (q) => {
            let r = prefix.reduce((r, v, j) => r.eq(col(j), v), q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", view.collection));
            if (lower[1] !== null) r = r[lower[0]](col(prefix.length), lower[1]);
            if (upper[1] !== null) r = r[upper[0]](col(prefix.length), upper[1]);
            return r;
          });
        } else if (c.setOf) {
          query = docs().withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", view.collection).eq("parentKey", parentKey!).eq("gen", gen));
        } else {
          query = docs().withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", view.collection));
        }
        for await (const row of query.order(view.order ?? "asc")) {
          if (out.length >= max || scanned >= (scoped ? scanMax : max)) { out.complete = false; return out; }
          scanned++;
          // A set's parent was admitted above; its docs answer to their own collection's scope.
          if ((!scoped || (await readable(row))) && (!view.where || (await whereHolds(c, view.where, row.data)))) out.push(row);
        }
      }
    }
    return out;
  }

  async function view(name: string, args: Record<string, unknown>) {
    const v = manifest.views[name] ?? refuse(`${manifest.title} has no view ${name}.`);
    checkArgs(name, v, args);
    if (v.kind === "list") return (await scan(v, args, true, Math.min(v.limit ?? 50, MAX_VIEW_LIMIT))).map(toDoc);
    const key = argValue(args, v.key);
    if (typeof key !== "string") return null;
    const row = await getRow(v.collection, key);
    return row && (await readable(row)) ? toDoc(row) : null;
  }

  /** Whether each ref names what it may, looked up once per scope (so once per mutation). */
  const refMemo = new Map<string, boolean>();
  /** A doc ref: a doc of the collection the caller can read (Canon: any). */
  const docExists = async (collection: string, key: string) => {
    if (!manifest.collections[collection]) return false;
    const row = await getRow(collection, key);
    return !!row && (system || (await readable(row)));
  };
  /** The company and person refs this write admits (Admit), and those it found new while asking. */
  const admittedRecords = new Set(Array.isArray(admit) ? admit : []);
  const unadmitted = new Map<string, { to: RecordRefTo; id: string }>();
  const recordAdmits = (ref: RefValidator, id: string) => {
    const k = refKey(ref, id);
    if (admittedRecords.has(k)) return true;
    if (admit === "ask") unadmitted.set(k, { to: ref.to as RecordRefTo, id });
    return admit === "ask";
  };
  const senders = senderReader(ctx, orgId, system ? null : access);
  const resolveRef = refResolver(ctx.db, orgId, docExists, system ? null : access, recordAdmits);
  /** The company and person refs a doc holds now: an update keeps them without admitting them again. */
  const heldRecords = (collection: string, data: Record<string, unknown>) =>
    recordKeys(collectionOf(collection).schema, data);
  /** The ref resolver and memo for a write over `held` (heldRecords): its held refs pass, and only for this write. */
  const resolverFor = (held: ReadonlySet<string>): [RefResolver, Map<string, boolean>] => held.size
    ? [async (ref, id) => (isRecordRef(ref.to) && held.has(refKey(ref, id))) || resolveRef(ref, id), new Map(refMemo)]
    : [resolveRef, refMemo];
  /**
   * A file id a write may put in a doc: one of this module's files in the workspace that the writer uploaded, or that
   * is already in a doc they read (a copy). Canon's own writes take any of the module's files.
   */
  const fileMemo = new Map<string, FileRow>();
  const fileRow = async (id: string) => {
    const fid = ctx.db.normalizeId("moduleFiles", id);
    const row = fid ? await ctx.db.get(fid) : null;
    return row && row.orgId === orgId && row.moduleId === moduleId && row.storageId !== undefined ? row : null;
  };
  const resolveFile: FileResolver = async (id) => {
    const row = await fileRow(id);
    if (!row) return { refused: "isn't a file of this module" };
    const mine = system || row.uploadedBy === access.userId;
    const seen = !mine && row.attachedTo ? await docExists(row.attachedTo.collection, row.attachedTo.key) : false;
    return mine || seen ? { name: row.name, type: row.type, bytes: row.bytes } : { refused: "is a file someone else uploaded" };
  };
  /**
   * Refuses `value` unless it fits `schema`, every ref it holds naming what it may and every file one it may use.
   * `held`: the company and person refs the doc held before this write, which pass as they are.
   */
  async function checkValue(schema: ObjectValidator, value: Record<string, unknown>, what: string, held: ReadonlySet<string> = new Set()) {
    const problems = await fitProblems(schema, value, ...resolverFor(held), resolveFile, fileMemo);
    // A ref that sits under a parent names a live doc of that parent's set: a dispute's line is one of its statement's.
    for (const r of problems.length ? [] : parentRefsIn(value, schema)) {
      const row = await getRow(r.collection, r.id);
      const parent = row?.parentKey && r.parentKey === row.parentKey ? await getRow(collectionOf(r.collection).setOf!.parent, row.parentKey) : null;
      if (!parent || liveGen(parent, r.collection) !== (row!.gen ?? 0)) problems.push(`data.${r.field} must be a ${r.collection} doc of ${r.parentKey === null ? "the doc its parent field names (none is named)" : `${r.parentKey}`}`);
    }
    if (problems.length) refuse(plainRefusal(problems, schema, what));
  }
  /** The files a written doc holds that went into no doc before: they belong to it now, so its readers download them. */
  async function attachFiles(collection: string, key: string, data: Record<string, unknown>) {
    if (!isMutation(ctx)) return;
    for (const { id } of filesIn(data, collectionOf(collection).schema)) {
      const row = await fileRow(id);
      if (row && !row.attachedTo) await ctx.db.patch(row._id, { attachedTo: { collection, key } });
    }
  }
  /** A doc of `collection` as written over `prior` (an update's), checked: this version's schema, and a newer installing version's too. */
  async function checkData(collection: string, data: Record<string, unknown>, prior?: Record<string, unknown>) {
    moduleWritable(manifest, collection);
    const held = prior ? heldRecords(collection, prior) : new Set<string>();
    await checkValue(collectionOf(collection).schema, data, `a valid ${manifest.title} doc`, held);
    if (!pending) return;
    const nc = pending.manifest.collections[collection];
    if (!nc) refuse(`${manifest.title} is upgrading to v${pending.version}, which removes ${collection}: it doesn't change until the upgrade is done.`);
    const problems = await fitProblems(nc!.schema, data, ...resolverFor(held), resolveFile, fileMemo);
    if (problems.length) refuse(`${manifest.title} is upgrading to v${pending.version}, and this doesn't fit it: ${problems.slice(0, 5).join("; ")}.`);
  }

  async function audit(db: MutationCtx["db"], collection: string, key: string, row: Omit<ModuleEvent, "actor" | "at">) {
    return db.insert("moduleEvents", { orgId, moduleId, collection, key, actor, at: Date.now(), ...row });
  }

  /**
   * Insert a new doc: a create op's, or a transition effect's. Machine fields start in their machine's initial state.
   * `checked`: the caller already checked the data, with those fields.
   */
  async function insertDoc(db: MutationCtx["db"], collection: string, given: Record<string, unknown>, parentKey: string | undefined, gen: number, event: Pick<ModuleEvent, "verb" | "proposal" | "cause">, checked = false, chosenKey?: string, initialize = true, qualifiedSetImport = false, sourceCreatedAt?: number) {
    moduleWritable(manifest, collection);
    const c = collectionOf(collection);
    const data: Record<string, unknown> = { ...given };
    if (initialize) for (const [field, name] of machineFields(manifest, collection)) data[field] = manifest.machines![name].initial;
    if (c.owner && data[c.owner] === undefined && !system) data[c.owner] = access.userId;
    if (!checked) await checkData(collection, data);
    const owner = ownerOf(c, data);
    const now = Date.now();
    const key = c.key === "auto" || (qualifiedSetImport && c.setOf) ? chosenKey ?? `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}` : c.key.from.map((f) => String(data[f])).join("|");
    if (chosenKey !== undefined && key !== chosenKey) refuse(`${collection}'s key is ${key} from its fields, not ${chosenKey}.`);
    if (await getRow(collection, key)) refuse(`${collection} already has ${key}.`);
    await insertModuleDoc(writeCtx(ctx), source, {
      orgId, moduleId, collection, key, data, version: 1, ...(sourceCreatedAt !== undefined ? { sourceCreatedAt } : {}), ...(owner ? { ownerUserId: owner as Id<"users"> } : {}),
      ...(c.setOf ? { parentKey, gen } : {}), ...slotsOf(collection, data, parentKey, gen), updatedAt: now,
    });
    const eventId = await audit(db, collection, key, { kind: "create", fields: Object.keys(data), toVersion: 1, ...event });
    await project(collection, key, { before: null, after: data });
    await attachFiles(collection, key, data);
    return { key, data, owner, eventId };
  }

  /** Write a proposal: the patch plan a person decides, and a row on the doc's trail saying it waits. */
  async function propose(db: MutationCtx["db"], args: ProposalArgs, row: ProposalRow | ProposalRow[], summary: string, event?: Omit<ModuleEvent, "actor" | "at" | "kind" | "proposal">): Promise<Proposed> {
    if (principal.kind !== "user") return refuse("Canon doesn't propose.");
    const proposal = await insertProposal(db, { orgId, userId: principal.user._id, agent: agent! }, { ...args, epoch }, row, summary);
    if (!Array.isArray(row) && row.key && event) await audit(db, row.collection, row.key, { ...event, kind: "propose", proposal });
    return { proposed: proposal };
  }

  // ── Values, guards and the reads they make: Canon's own, whoever can see the docs ──

  /** The workspace's settings a module reads (docs/modules.md, "Fiscal year"), read once per scope. */
  let workspaceRead: Promise<Workspace> | null = null;
  const workspace = () => (workspaceRead ??= ctx.db.get(orgId).then((o) => ({ fiscalYearStartMonth: o?.fiscalYearStartMonth ?? 1, currency: o?.defaultCurrency ?? "USD" })));
  /** The environment guards and computed values read: the doc, the args, the caller, the time and Canon's reads. */
  const envFor = (doc: Subject, args: Record<string, unknown>, now: number, created?: Record<string, string>): Env => {
    const env: Env = {
      fiscalYearStartMonth: async () => (await workspace()).fiscalYearStartMonth,
      doc, args, now, created, caller: { userId: system ? null : access.userId, role: callerRole, teamOwners: system ? [] : access.teamOwners },
      async count(name, viewArgs, where?: Predicate) {
        const v = manifest.views[name];
        if (!v || v.kind !== "list") return refuse(`${manifest.title} has no list view ${name}.`);
        const rows = await scan(v, viewArgs, false, COUNT_MAX + 1);
        if (rows.length > COUNT_MAX) refuse(`A guard counts at most ${COUNT_MAX} docs, and ${name} has more.`);
        let n = 0;
        for (const r of rows) if (!where || (await holds(where, subjectOf(r), env))) n++;
        return n;
      },
      async first(name, viewArgs) {
        const v = manifest.views[name] ?? refuse(`${manifest.title} has no view ${name}.`);
        if (v.kind === "one") { const key = argValue(viewArgs, v.key); const row = typeof key === "string" ? await getRow(v.collection, key) : null; return row ? subjectOf(row) : null; }
        const [row] = await scan(v, viewArgs, false, 1);
        return row ? subjectOf(row) : null;
      },
      async get(collection, key) { collectionOf(collection); const row = await getRow(collection, key); return row ? subjectOf(row) : null; },
      fresh: (job, prefix) => isFresh(ctx.db, orgId, moduleId, manifest, job, prefix),
      async intact(subject) {
        const c = subject.collection ? manifest.collections[subject.collection] : undefined;
        const stored = c?.integrity ? subject.data[c.integrity.field] : undefined;
        if (!c?.integrity || typeof stored !== "string") return false;
        const row = await getRow(subject.collection!, subject.key);
        return row !== null && stored === (await sealFor(row, subject.data));
      },
    };
    return env;
  };
  /** A doc's seal as its collection's `integrity` declares it: its fields in `data`, its sets' live docs (at most 1,000 each). */
  async function sealFor(row: Row, data: Record<string, unknown>): Promise<string> {
    const decl = collectionOf(row.collection).integrity ?? refuse(`${row.collection} declares no integrity seal.`);
    const children: Record<string, Array<Record<string, unknown>>> = {};
    for (const child of Object.keys(decl.children ?? {})) {
      const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", child).eq("parentKey", row.key).eq("gen", liveGen(row, child))).take(CHILDREN_MAX + 1);
      if (rows.length > CHILDREN_MAX) refuse(`${row.key} has more than ${CHILDREN_MAX} ${child} docs, more than a seal covers.`);
      children[child] = rows.map((r) => r.data);
    }
    return sealOf(decl, data, children);
  }
  /** Dirty the keys `specs` compute on each doc a write touched, in the write's transaction. */
  async function dirtyFrom(specs: readonly DirtyDecl[] | undefined, subjects: readonly Subject[], args: Record<string, unknown>, now: number) {
    if (!specs?.length || !isMutation(ctx)) return;
    const keys = new Map<string, [string, string]>();
    for (const subject of subjects) {
      for (const d of specs) {
        const key = await dirtyKey(d.key, envFor(subject, args, now));
        if (key !== null) keys.set(`${d.job}\n${key}`, [d.job, key]);
      }
    }
    for (const [job, key] of keys.values()) await dirtyKeyOf(job, key);
  }
  /** The sort value a job's `orderBy` reads for a key: the order part's doc's field, as sortable text. */
  async function orderFor(job: string, key: string): Promise<string | undefined> {
    const part = orderPartOf(manifest, job, key);
    const by = manifest.jobs?.[job]?.orderBy;
    if (part === null || !by) return undefined;
    const row = await getRow(by.collection, part);
    return sortText(row?.data[by.field], part);
  }
  async function dirtyKeyOf(job: string, key: string) {
    if (!isMutation(ctx)) return refuse("Job keys are marked in a mutation.");
    await markDirty(ctx, orgId, moduleId, manifest, job, key, undefined, await orderFor(job, key));
  }
  /** Field values from expressions; null leaves a field out, and `{ unset: true }` removes it (UNSET, for withSet). */
  async function valuesOf(exprs: Record<string, SetExpr>, env: Env) {
    const out: Record<string, unknown> = {};
    for (const [f, x] of Object.entries(exprs)) {
      if (isUnset(x)) { out[f] = UNSET; continue; }
      const v = await valueOf(x, env);
      if (v !== null && v !== undefined) out[f] = v;
    }
    return out;
  }
  /**
   * The message of the first guard that fails on `subject`, or null. `skipArgs`: pass a guard that reads arguments;
   * `asks`: one that reads a field a form asks for (judged on submit, with the values given).
   */
  async function failing(guards: readonly Guard[] | undefined, subject: Subject, env: Env, skipArgs = false, asks: readonly string[] = []): Promise<string | null> {
    for (const g of guards ?? []) if (!(skipArgs && namesArgs(g.when)) && !namesFields(g.when, asks) && !(await holds(g.when, subject, env))) return g.message;
    return null;
  }

  // ── Ops ──

  const opOf = (name: string): OpDecl => manifest.ops[name] ?? refuse(`${manifest.title} has no op ${name}.`);
  /** Who may run an op: its roles for a person, Canon for a system op; an agent as its mode allows. */
  function mailboxEffects(effects: readonly EffectDecl[] | undefined, seen = new Set<string>()): boolean {
    return (effects ?? []).some((fx) => {
      if ("send" in fx) return "people" in fx.send.to;
      if (!("machine" in fx)) return false;
      const key = `${fx.machine}.${fx.transition}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return mailboxEffects(manifest.machines?.[fx.machine]?.transitions[fx.transition]?.effects, seen);
    });
  }
  const mailboxPerson = () => principal.kind === "user" && principal.session === true && !agent;
  function mailboxKind(kind: unknown): "personal" | "automated" {
    if (kind === "personal") return kind;
    if (kind === undefined || kind === "automated") return "automated";
    return refuse("People email requires personal or automated kind.");
  }
  function mailboxCaller(effects: readonly EffectDecl[] | undefined) {
    if (!mailboxPerson() && mailboxEffects(effects)) refuse("Mailbox effects require a person's module action. An agent proposal cannot faithfully review the final email here; propose the source edit separately.");
  }
  function checkOpCaller(decl: OpDecl) {
    mailboxCaller(decl.effects);
    moduleWritable(manifest, decl.collection);
    const blocked = admission(decl);
    if (blocked) refuse(blocked);
  }
  /** The doc an op would write, as its guards see it: a create's data as given (its set and initial states in), or the doc before. */
  async function opSubject(decl: OpDecl, input: { key?: string; parentKey?: string; data?: Record<string, unknown> }): Promise<{ row: Row | null; subject: Subject; gen: number }> {
    const c = collectionOf(decl.collection);
    if (decl.kind !== "create") {
      const row = typeof input.key === "string" ? await getRow(decl.collection, input.key) : null;
      if (!row || !(await readable(row, true))) return refuse(`${decl.collection} has no ${input.key ?? "doc"} you can see.`);
      return { row, subject: subjectOf(row), gen: row.gen ?? 0 };
    }
    let gen = 0;
    if (c.setOf) {
      const parent = typeof input.parentKey === "string" ? await readableParent(c, input.parentKey, true) : null;
      if (!parent) refuse(`${decl.label} needs a ${c.setOf.parent} doc you can see.`);
      gen = liveGen(parent!, decl.collection);
    } else if (input.parentKey !== undefined) refuse(`${decl.collection} docs belong to no parent.`);
    const data: Record<string, unknown> = { ...(input.data ?? {}) };
    for (const [f, m] of machineFields(manifest, decl.collection)) data[f] = manifest.machines![m].initial;
    if (c.owner && data[c.owner] === undefined && !system) data[c.owner] = access.userId;
    return { row: null, subject: { key: "", data, owner: ownerOf(c, data), parentKey: input.parentKey ?? null }, gen };
  }

  async function op(name: string, input: OpInput, approval?: Approval, aiOutput?: CallDecl): Promise<OpResult> {
    if (!isMutation(ctx)) return refuse("Module ops run in a mutation.");
    notMigrating();
    const db = ctx.db;
    const decl = opOf(name);
    // Hosted AI may fill its declared system output op, under the starter's authority and doc visibility.
    checkOpCaller(aiOutput && decl.system ? { ...decl, system: undefined, roles: aiOutput.roles, capability: aiOutput.capability, agent: aiOutput.agent } : decl);
    const c = collectionOf(decl.collection);
    const given = input.data ?? {};
    const unset = input.unset ?? [];
    const owned = machineFields(manifest, decl.collection);
    const touched = [...Object.keys(given), ...unset];
    const notWritten = touched.filter((k) => !decl.fields?.includes(k) || owned.has(k));
    if (notWritten.length) refuse(`${decl.label} doesn't write ${notWritten.join(", ")}.`);
    if (unset.length && decl.kind !== "update") refuse(`Only an update removes fields.`);
    for (const f of unset) {
      if (!c.schema.value[f]?.optional) refuse(`${f} is required, so ${decl.label} can't remove it.`);
      if (Object.hasOwn(given, f)) refuse(`${decl.label} can't both set and remove ${f}.`);
    }
    const proposing = agent !== null && decl.agent === "propose" && !approval;
    const summary = `${decl.label} in ${manifest.title}`;
    const now = Date.now();
    const at = await opSubject(decl, { key: input.key, parentKey: input.parentKey, data: given });
    if (at.row && input.expect !== undefined && input.expect !== at.row.version) refuse("This doc changed since you loaded it. Reload and try again.");
    // `set` reads the doc as it is (an update's before it changes), then the guards read it as it would be.
    const set = await valuesOf(decl.set ?? {}, envFor(at.subject, {}, now));

    if (decl.kind === "create") {
      const data: Record<string, unknown> = { ...withSet(at.subject.data, set), ...Object.fromEntries([...owned].map(([f, m]) => [f, manifest.machines![m].initial])) };
      const subject = { ...at.subject, data, owner: ownerOf(c, data) };
      const blocked = await failing(decl.guards, subject, envFor(subject, {}, now));
      if (blocked) refuse(blocked);
      await checkData(decl.collection, data);
      if (!(await scopeAdmits(c, ownerOf(c, data), data))) refuse(`You can't ${lower(decl.label)} a doc you wouldn't be able to see.`);
      if (proposing) {
        markModuleSemanticWriteAttempt(ctx);
        return propose(db, { kind: "op", module: moduleId, op: name, parentKey: input.parentKey, data: given }, { collection: decl.collection, action: decl.label, before: null, after: given }, summary);
      }
      // Canon may name the key it creates: an import keeps the id a record had before it moved into a module.
      const made = await insertDoc(db, decl.collection, data, input.parentKey, at.gen, { verb: name, ...(approval ? { proposal: approval.proposal } : {}) }, true, system ? input.key : undefined);
      const written = { key: made.key, data: made.data, owner: made.owner, parentKey: input.parentKey ?? null };
      await dirtyFrom(decl.dirties, [written], {}, now);
      await opEffects(db, name, decl, written, made.eventId, now);
      return { key: made.key, version: 1 };
    }

    const row = at.row!;
    // An update's guards judge the doc as it would be after the write (its `set` included); a delete's, the doc as it is.
    const after = withSet({ ...row.data, ...given }, set);
    for (const f of unset) delete after[f];
    const judged: Subject = decl.kind === "update" ? { ...at.subject, data: after, owner: ownerOf(c, after) } : at.subject;
    const blocked = await failing(decl.guards, judged, envFor(judged, {}, now));
    if (blocked) refuse(blocked);
    if (decl.kind === "update") await checkData(decl.collection, after, row.data);
    if (proposing) {
      const before = Object.fromEntries(touched.map((k) => [k, row.data[k] ?? null]));
      markModuleSemanticWriteAttempt(ctx);
      return propose(db, { kind: "op", module: moduleId, op: name, key: row.key, expect: row.version, data: given, ...(unset.length ? { unset } : {}) },
        { collection: decl.collection, key: row.key, action: decl.label, before, after: decl.kind === "delete" ? null : { ...given, ...Object.fromEntries(unset.map((k) => [k, null])) } },
        summary, { verb: name, fields: touched, fromVersion: row.version });
    }
    const proposal = approval ? { proposal: approval.proposal } : {};

    if (decl.kind === "delete") {
      if (pending && !pending.manifest.collections[decl.collection]) refuse(`${manifest.title} is upgrading to v${pending.version}, which removes ${decl.collection}: it doesn't change until the upgrade is done.`);
      const children = Object.entries(manifest.collections).filter(([, x]) => x.setOf?.parent === decl.collection).map(([n]) => n);
      for (const child of children) {
        const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", child).eq("parentKey", row.key)).take(CHILDREN_MAX + 1);
        if (rows.length > CHILDREN_MAX) refuse(`${row.key} has more than ${CHILDREN_MAX} ${child} docs; delete some first.`);
        for (const r of rows) { rememberModuleRow(ctx, r); await deleteModuleDoc(writeCtx(ctx), source, r._id); await project(child, r.key, { before: r.data, after: null }); }
      }
      await deleteModuleDoc(writeCtx(ctx), source, row._id);
      await project(decl.collection, row.key, { before: row.data, after: null });
      const eventId = await audit(db, decl.collection, row.key, { verb: name, kind: "delete", fields: [], fromVersion: row.version, ...proposal });
      await dirtyFrom(decl.dirties, [at.subject], {}, now);
      await opEffects(db, name, decl, at.subject, eventId, now);
      return { key: row.key, deleted: true };
    }

    const data = after;
    const owner = ownerOf(c, data);
    if (!(await scopeAdmits(c, owner, data))) refuse(`You can't ${lower(decl.label)} so that you'd no longer see it.`);
    const from = row.version, version = from + 1;
    const previousData = row.data;
    await patchModuleDoc(writeCtx(ctx), source, row._id, { data, version, ownerUserId: owner ? (owner as Id<"users">) : undefined, ...slotsOf(decl.collection, data, row.parentKey, row.gen ?? 0), updatedAt: Date.now() });
    await project(decl.collection, row.key, { before: previousData, after: data });
    await attachFiles(decl.collection, row.key, data);
    const eventId = await audit(db, decl.collection, row.key, { verb: name, kind: "update", fields: [...touched, ...Object.keys(set)], fromVersion: from, toVersion: version, ...proposal });
    // A key the doc fed before the change and the one it feeds after: a moved assignment dirties both plans.
    await dirtyFrom(decl.dirties, [at.subject, { ...at.subject, data, owner }], {}, now);
    await opEffects(db, name, decl, { ...at.subject, data, owner }, eventId, now);
    return { key: row.key, version };
  }

  /** An op's notifications and sends (docs/modules.md, "Notifications", "Outbound"), from the doc as the write left it; `when` skips one. */
  async function opEffects(db: MutationCtx["db"], name: string, decl: OpDecl, subject: Subject, eventId: string, now: number) {
    const env = envFor(subject, {}, now);
    for (const [index, fx] of (decl.effects ?? []).entries()) {
      if (fx.when && !(await holds(fx.when, subject, env))) continue;
      const about = { collection: decl.collection, key: subject.key, verb: name, cause: eventId, index };
      if ("send" in fx) await send(db, fx, env, about);
      else await notify(db, fx, env, about);
    }
  }

  /**
   * Why an op can't run now, before its form is filled: its guards on the doc an update or a delete names, or on a
   * create's values given so far (`input.data`). A guard that reads a field the form asks for (`asks`; by default
   * the op's fields `data` doesn't give, none for a delete) waits for the submit, which judges the values given.
   */
  async function opBlocked(name: string, input: { key?: string; parentKey?: string; data?: Record<string, unknown> }, asks?: readonly string[]): Promise<string | null> {
    const decl = manifest.ops[name];
    if (decl && input.key !== undefined) {
      const row = await getRow(decl.collection, input.key);
      if (row && (await readable(row)) && !(await readable(row, true))) return "This doc is read only for you.";
    }
    if (decl?.kind === "create" && input.parentKey !== undefined) {
      const c = collectionOf(decl.collection);
      if ((await readableParent(c, input.parentKey)) && !(await readableParent(c, input.parentKey, true))) return "This parent doc is read only for you.";
    }
    if (!decl?.guards?.length) return null;
    const asked = asks ?? (decl.kind === "delete" ? [] : (decl.fields ?? []).filter((f) => !Object.hasOwn(input.data ?? {}, f)));
    try {
      const at = await opSubject(decl, input);
      return await failing(decl.guards, at.subject, envFor(at.subject, {}, Date.now()), false, asked);
    } catch { return null; }
  }
  /**
   * The values a text field marked `suggest` already holds in the docs of `collection` the caller reads, most used
   * first, matching `search`: what its input offers (an activity's kind). At most PICK_MAX, from SCAN_MAX docs.
   */
  async function suggest(collection: string, field: string, search: string, dealField?: string): Promise<string[]> {
    const c = collectionOf(collection);
    // A dotted path reaches a text field nested in an object, a list's rows or a variant's case (a rule's config).
    const path = field.split(".").slice(0, 4);
    const how = nestedSpec(c.schema, path)?.suggest;
    // A Canon deal field's values: the one the field names, or the one its sibling names (sent as `dealField`).
    if (how !== undefined && how !== true) {
      const named = typeof how.deals === "string" ? how.deals : dealField;
      if (!named) return [];
      return dealValues(ctx, orgId, access, manifest, named, search, PICK_MAX);
    }
    if (how !== true) return refuse(`${collection}.${field} doesn't offer suggestions.`);
    const needle = search.trim().toLowerCase();
    const seen = new Map<string, number>();
    let scanned = 0;
    for await (const row of ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection))) {
      if (++scanned > SCAN_MAX) break;
      const values = path.reduce<unknown[]>((at, seg) => at.flatMap((x) => (x !== null && typeof x === "object" && !Array.isArray(x) ? [(x as Record<string, unknown>)[seg]] : [])).flat(), [row.data]);
      const fresh = [...new Set(values.filter((v): v is string => typeof v === "string" && v.trim().length > 0 && (!needle || v.toLowerCase().includes(needle))))];
      if (!fresh.length || (!fresh.every((v) => seen.has(v)) && !(await readable(row)))) continue;
      for (const v of fresh) seen.set(v, (seen.get(v) ?? 0) + 1);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, PICK_MAX).map(([v]) => v);
  }
  async function peek(collection: string, key: string) {
    const row = manifest.collections[collection] ? await getRow(collection, key) : null;
    return row && (await readable(row)) ? { version: row.version, createdAt: row.sourceCreatedAt ?? row._creationTime, data: row.data } : null;
  }

  // ── References: what a picker offers and what a ref shows as ──

  /** The workspace's currency once read, for a title that shows money. */
  let titleCurrency = "USD";
  const titlesReady = async () => { titleCurrency = (await workspace()).currency; };
  /**
   * The text a doc shows as: its collection's `title` (a field, or a text over `{$doc.<field>}`: a line item's rule and
   * deal), else its first required text field, else its key.
   */
  const titleOf = (c: CollectionDecl, row: Row) => {
    if (c.title?.includes("{$")) {
      const t = renderText(c.title, { binds: { doc: { key: row.key, version: row.version, owner: row.ownerUserId ?? null, parentKey: row.parentKey ?? null, data: row.data } }, members: new Map(), currency: titleCurrency }).trim();
      return t || row.key;
    }
    const f = c.title ?? Object.entries(c.schema.value).find(([, sp]) => !sp.optional && sp.fieldType.type === "string")?.[0];
    const t = f ? row.data[f] : undefined;
    return typeof t === "string" && t ? t : row.key;
  };
  /** What a doc is named by in a message: its collection's declared `title`, else its key (a tally's key names its month and rep). */
  const namedBy = (row: Row) => (collectionOf(row.collection).title ? titleOf(collectionOf(row.collection), row) : row.key);
  const dealSeen = (d: Doc<"deals">) => d.archivedAt === undefined && (system || (permissionOf(access, "deal").read && dealVisible(access, d)));

  /**
   * What a ref picker offers for `ref`, matching `search` (a part of the name, any case): members, deals and teams of
   * the workspace and module docs, each only as the caller may read them, at most `max`.
   */
  async function pick(ref: RefValidator, search: string, max = PICK_MAX, parentKey?: string): Promise<Array<{ id: string; label: string }>> {
    if (isRecordRef(ref.to)) return refuse("Companies and people are picked from the record service: api.modules.records.");
    await titlesReady();
    const needle = search.trim().toLowerCase();
    const hit = (label: string) => !needle || label.toLowerCase().includes(needle);
    if (ref.to === "senders") return manifest.reads?.senders?.includes("name") ? senders.pick(search, max, manifest.reads.senders.includes("address")) : [];
    if (ref.to === "users") {
      return (await workspaceMembers(ctx, orgId)).filter((u) => hit(u.name) || hit(u.email)).slice(0, max).map((u) => ({ id: u.id as string, label: u.name }));
    }
    if (ref.to === "teams") {
      const teams = await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(PICK_SCAN);
      return teams.filter((t) => hit(t.name)).slice(0, max).map((t) => ({ id: t._id as string, label: t.name }));
    }
    if (ref.to === "deals") {
      const rows = needle
        ? await ctx.db.query("deals").withSearchIndex("search_name", (q) => q.search("name", search.trim()).eq("orgId", orgId)).take(PICK_SCAN)
        : await ctx.db.query("deals").withIndex("by_orgId_updatedAt", (q) => q.eq("orgId", orgId)).order("desc").take(PICK_SCAN);
      return rows.filter(dealSeen).slice(0, max).map((d) => ({ id: d._id as string, label: d.name }));
    }
    const c = collectionOf(ref.collection ?? "");
    const out: Array<{ id: string; label: string }> = [];
    let scanned = 0;
    // A ref that sits under a parent offers only that parent's live set (one statement's lines), when the caller reads it.
    if (ref.parent !== undefined || parentKey !== undefined) {
      const parent = c.setOf && parentKey ? await readableParent(c, parentKey) : null;
      if (!parent) return [];
      for await (const row of ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", ref.collection!).eq("parentKey", parentKey!).eq("gen", liveGen(parent, ref.collection!)))) {
        if (out.length >= max || ++scanned > SCAN_MAX) break;
        const label = titleOf(c, row);
        if (hit(label) && (await readable(row))) out.push({ id: row.key, label });
      }
      return out;
    }
    for await (const row of ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", ref.collection!))) {
      if (out.length >= max || ++scanned > SCAN_MAX) break;
      const label = titleOf(c, row);
      if (hit(label) && (await readable(row))) out.push({ id: row.key, label });
    }
    return out;
  }

  /** What each ref shows as, by `<to>:<collection>:<id>`: only the ones the caller may read. */
  async function refLabels(refs: ReadonlyArray<{ ref: RefValidator; id: string }>): Promise<Record<string, string>> {
    await titlesReady();
    const out: Record<string, string> = {};
    for (const { ref, id } of refs.slice(0, LABELS_MAX)) {
      const k = refKey(ref, id);
      // A company or person is named by the page, which reads the record service as the caller (api.modules.records).
      if (Object.hasOwn(out, k) || ref.to === "users" || isRecordRef(ref.to)) continue;
      if (ref.to === "senders") { const row = manifest.reads?.senders?.includes("name") ? await senders.byId(id) : null; if (row) out[k] = row.name; }
      else if (ref.to === "deals") { const d = ctx.db.normalizeId("deals", id); const row = d ? await ctx.db.get(d) : null; if (row && row.orgId === orgId && dealSeen(row)) out[k] = row.name; }
      else if (ref.to === "teams") { const t = ctx.db.normalizeId("teamGroups", id); const row = t ? await ctx.db.get(t) : null; if (row && row.orgId === orgId) out[k] = row.name; }
      else { const c = manifest.collections[ref.collection ?? ""]; const row = c ? await getRow(ref.collection!, id) : null; if (c && row && (await readable(row))) out[k] = titleOf(c, row); }
    }
    return out;
  }

  // ── Transitions ──

  const machineOf = (name: string) => manifest.machines?.[name] ?? refuse(`${manifest.title} has no machine ${name}.`);
  const transitionOf = (machine: string, name: string) => machineOf(machine).transitions[name] ?? refuse(`${machine} has no transition ${name}.`);

  type Run = { approval?: Approval; cause?: string; writes: { n: number }; dryRun?: boolean; variableReview?: string; evidence?: { ip?: string; userAgent?: string } };
  const countWrite = (run: Run, label: string, n = 1) => { if ((run.writes.n += n) > WRITES_MAX) refuse(`${label} would write more than ${WRITES_MAX} docs. Bulk writes come with jobs.`); };

  /**
   * Copy a doc with its sets and related docs: one new doc, then its children under it and the related docs pointing
   * at it. Refused whole when the copies would pass the transition's write cap.
   */
  async function copyDoc(db: MutationCtx["db"], fx: Extract<EffectDecl, { copy: string }>, env: Env, label: string, run: Run, event: Pick<ModuleEvent, "verb" | "proposal" | "cause">) {
    const key = await valueOf(fx.key, env);
    const src = typeof key === "string" ? await getRow(fx.copy, key) : null;
    if (!src) return refuse(`${label}: ${fx.copy} has no ${String(key)} to copy.`);
    await assertSq1Copy(ctx, src);
    const owned = (collection: string) => machineFields(manifest, collection);
    // A copy starts unsealed, its machine fields at their initial states.
    const strip = (collection: string, data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([f]) => !owned(collection).has(f) && f !== collectionOf(collection).integrity?.field));
    const children: Array<[string, Row[]]> = [];
    for (const child of fx.children ?? []) {
      if (roomRecordCollections(manifest).has(child)) continue;
      const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", child).eq("parentKey", src.key).eq("gen", liveGen(src, child))).take(WRITES_MAX + 1);
      children.push([child, rows]);
    }
    const related: Array<[{ collection: string; field: string }, Row[]]> = [];
    for (const r of fx.related ?? []) {
      const rc = collectionOf(r.collection);
      const ix = Object.entries(rc.indexes).find(([, fields]) => fields[0] === r.field)![0];
      const i = slotIndex(r.collection, ix);
      const rows = await docs().withIndex(slotIndexName(i), (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", r.collection).eq(`s${i}a`, src.key)).order("asc").take(WRITES_MAX + 1);
      related.push([r, rows]);
    }
    const total = 1 + [...children, ...related].reduce((n, [, rows]) => n + rows.length, 0);
    if (run.writes.n + total > WRITES_MAX) refuse(`${label} would copy ${total} docs, more than one transition writes (${WRITES_MAX}). Bulk copies come with jobs.`);
    countWrite(run, label, total);
    const made = await insertDoc(db, fx.copy, { ...strip(fx.copy, src.data), ...(await valuesOf(fx.set ?? {}, env)) }, undefined, 0, event);
    for (const [child, rows] of children) for (const r of rows) await insertDoc(db, child, strip(child, r.data), made.key, 0, event);
    for (const [r, rows] of related) for (const row of rows) await insertDoc(db, r.collection, { ...strip(r.collection, row.data), [r.field]: made.key }, undefined, 0, event);
    return made.key;
  }

  /**
   * Move `row` through one transition: its state and guards, then (unless a dry run) its `set`, the new state, an
   * event, and its effects, each effect's transition checked against its own state and guards. Roles are the entry
   * transition's alone: an effect's transition may name none, so it runs only as an effect.
   */
  let canonMove: { machine: string; name: string; key: string; expect: number } | null = null;
  async function move(db: MutationCtx["db"], machine: string, name: string, row: Row, args: Record<string, unknown>, reason: string | undefined, run: Run): Promise<{ key: string; version: number; state: string; created: Record<string, string> }> {
    const mc = machineOf(machine), t = transitionOf(machine, name);
    const bound = Object.values(manifest.calls ?? {}).some((call) => call.canon?.then?.machine === machine && call.canon.then.transition === name);
    if (bound && (!canonMove || canonMove.machine !== machine || canonMove.name !== name || canonMove.key !== row.key || canonMove.expect !== row.version)) refuse("This transition runs only with its atomic Canon operation.");
    mailboxCaller(t.effects);
    moduleWritable(manifest, mc.collection);
    if (t.capability) { const blocked = admission(t); if (blocked) refuse(blocked); }
    const from = typeof row.data[mc.field] === "string" ? (row.data[mc.field] as string) : "";
    if (!t.from.includes(from)) refuse(`${t.label} needs ${mc.collection} ${row.key} to be ${t.from.join(" or ")}; it is ${from || "in no state"}.`);
    const now = Date.now();
    const env = { ...envFor(subjectOf(row), args, now), ...(run.evidence ? { evidence: run.evidence } : {}) };
    if (moduleId === "@canon/sequences" && machine === "sequence" && name === "launch") {
      await requireVariableReview(await sequenceVariables(row.key), run.variableReview);
    }
    const blocked = await failing(t.guards, env.doc, env);
    if (blocked) refuse(blocked);
    const to = await targetState(mc, t, env.doc, env);
    const set = await valuesOf(t.set ?? {}, env);
    const data: Record<string, unknown> = { ...withSet(row.data, set), [mc.field]: to };
    const integrity = collectionOf(mc.collection).integrity;
    await checkData(mc.collection, data, row.data);
    const created: Record<string, string> = {};
    if (run.dryRun) return { key: row.key, version: row.version, state: to, created };
    countWrite(run, t.label);
    const c = collectionOf(mc.collection);
    const owner = ownerOf(c, data);
    const version = row.version + 1;
    const previousData = row.data;
    await patchModuleDoc(writeCtx(ctx), source, row._id, { data, version, ownerUserId: owner ? (owner as Id<"users">) : undefined, ...slotsOf(mc.collection, data, row.parentKey, row.gen ?? 0), updatedAt: now });
    await project(mc.collection, row.key, { before: previousData, after: data });
    await attachFiles(mc.collection, row.key, data);
    // A doc leaving the state a bulk move held it in (its `then`, or a person stopping it) ends that move.
    if (from !== to) {
      for (const [tn, other] of Object.entries(mc.transitions)) {
        if (other.to === from && other.effects?.some((fx) => "bulk" in fx && fx.bulk?.then !== undefined)) await dropKey(ctx as MutationCtx, orgId, moduleId, BULK_JOB, bulkKey(machine, tn, row.key));
      }
    }
    const eventId = await audit(db, mc.collection, row.key, {
      verb: `${machine}.${name}`, kind: "transition", fields: [mc.field, ...Object.keys(set), ...(t.seal && integrity ? [integrity.field] : [])], fromVersion: row.version, toVersion: version, from, to,
      ...(Object.keys(args).length ? { args } : {}), ...(reason ? { reason } : {}), ...(run.approval ? { proposal: run.approval.proposal } : {}), ...(run.cause ? { cause: run.cause } : {}),
      ...(run.evidence && Object.keys(run.evidence).length ? { evidence: run.evidence } : {}),
    });
    // Effects read the doc as it is now, and the docs earlier effects created.
    const after = { ...envFor({ key: row.key, data, owner, parentKey: row.parentKey ?? null }, args, now, created), ...(run.evidence ? { evidence: run.evidence } : {}) };
    const cause = `${machine}.${name} ${mc.collection}/${row.key}`;
    await dirtyFrom(t.dirties, [after.doc], args, now);
    const event = { verb: `${machine}.${name}`, cause, ...(run.approval ? { proposal: run.approval.proposal } : {}) };
    for (const [index, fx] of (t.effects ?? []).entries()) {
      if (fx.when && !(await holds(fx.when, after.doc, after))) continue;
      const about = { collection: mc.collection, key: row.key, verb: `${machine}.${name}`, cause: eventId, index };
      if ("notify" in fx) {
        await notify(db, fx, after, about);
        continue;
      }
      if ("send" in fx) {
        await send(db, fx, after, about);
        continue;
      }
      if ("create" in fx) {
        const tc = collectionOf(fx.create);
        let parentKey: string | undefined, gen = 0;
        if (tc.setOf) {
          parentKey = String(await valueOf(fx.parent!, after));
          const parent = await getRow(tc.setOf.parent, parentKey);
          if (!parent) refuse(`${t.label}: ${tc.setOf.parent} has no ${parentKey}.`);
          gen = liveGen(parent!, fx.create);
        }
        countWrite(run, t.label);
        const made = await insertDoc(db, fx.create, await valuesOf(fx.data, after), parentKey, gen, event);
        if (fx.as) created[fx.as] = made.key;
        continue;
      }
      if ("copy" in fx) {
        const key = await copyDoc(db, fx, after, t.label, run, event);
        if (fx.as) created[fx.as] = key;
        continue;
      }
      const tm = machineOf(fx.machine);
      let targets: Row[];
      if ("key" in fx) {
        const key = String(await valueOf(fx.key, after));
        const target = await getRow(tm.collection, key);
        targets = target ? [target] : refuse(`${t.label}: ${tm.collection} has no ${key}.`);
      } else {
        const viewArgs: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(fx.args ?? {})) viewArgs[k] = await valueOf(x, after);
        if (fx.bulk) {
          // Past one transaction's cap: the doc waits in its new state while Canon moves the docs in batches.
          const parent = { machine, key: row.key, via: name, ...(fx.bulk.then !== undefined ? { then: fx.bulk.then, waitIn: to } : {}) };
          const move: BulkMove = { machine: fx.machine, transition: fx.transition, view: fx.view, args: viewArgs, onlyFrom: [...fx.onlyFrom!], parent, cause };
          await markDirty(ctx as MutationCtx, orgId, moduleId, manifest, BULK_JOB, bulkKey(machine, name, row.key), move);
          continue;
        }
        targets = await scan(manifest.views[fx.view] as ListView, viewArgs, false, EFFECT_DOCS_MAX + 1);
        if (targets.length > EFFECT_DOCS_MAX) refuse(`${t.label} would move more than ${EFFECT_DOCS_MAX} ${tm.collection} docs.`);
      }
      for (const target of targets) {
        // An earlier effect may have moved it: read it again.
        const fresh = (await getRow(target.collection, target.key))!;
        if (fx.onlyFrom && !fx.onlyFrom.includes(String(fresh.data[tm.field]))) continue;
        await move(db, fx.machine, fx.transition, fresh, {}, undefined, { ...run, cause, evidence: undefined });
      }
    }
    // A seal covers the doc as this transition leaves it, and its sets as its effects left them (a lock's last note).
    if (t.seal && integrity) {
      const sealed = (await getRow(mc.collection, row.key))!;
      const beforeSeal = sealed.data;
      const sealedData = { ...sealed.data, [integrity.field]: await sealFor(sealed, sealed.data) };
      await patchModuleDoc(writeCtx(ctx), source, sealed._id, { data: sealedData });
      await project(mc.collection, row.key, { before: beforeSeal, after: sealedData });
    }
    // A hosted AI step this move starts (docs/modules.md, "Hosted AI steps"): run once the move commits, in the
    // background, as the person who moved the doc; a system move runs it as the doc's owner. Only a person's own move
    // may spend Canon's model on credits.
    const queuedCall = t.run ?? t.ai;
    if (queuedCall && isMutation(ctx)) {
      const retained = Boolean(manifest.calls?.[queuedCall]?.step || manifest.calls?.[queuedCall]?.ai?.queue?.next);
      if (system && retained) refuse("A retained-member continuation must be started by its initiating member.");
      const starter = system ? ((await getRow(mc.collection, row.key))?.ownerUserId ?? null) : access.userId as Id<"users">;
      await ctx.scheduler.runAfter(0, internal.modules.aiRun, { orgId, module: moduleId, call: queuedCall, key: row.key, ...(starter ? { userId: starter } : {}), credits: !system, ...(retained ? { revision, expect: version, ...(agent ? { agent } : {}) } : {}) });
    }

    return { key: row.key, version, state: to, created };
  }

  /**
   * A transition's notification (docs/modules.md, "Notifications"): to the members its recipients name (a doc's
   * member field, a list of them, or everyone of a role), never to the person who caused it, with its message filled
   * from the doc after the move and its link to a page of the module.
   */
  async function notify(db: MutationCtx["db"], fx: Omit<NotifyEffect, "when">, env: Env, about: Cause) {
    const to = await recipientsOf(fx.notify, env, NOTIFY_MAX, "A notification");
    if (!to.length) return;
    const text = await textScope({ doc: { key: env.doc.key, version: 0, data: env.doc.data, owner: env.doc.owner } });
    const message = renderText(fx.message, text).slice(0, MESSAGE_MAX);
    const subject = fx.subject === undefined ? undefined : renderText(fx.subject, text);
    const values = { ...Object.fromEntries(Object.entries(env.doc.data).flatMap(([k, v]) => (typeof v === "string" || typeof v === "number" ? [[k, String(v)]] : []))), key: env.doc.key, ...(env.doc.parentKey ? { parentKey: env.doc.parentKey } : {}) };
    const link = fx.link === undefined ? undefined : `/dashboard/m/${moduleSlug(moduleId)}/${fillPath(fx.link, values)}`;
    await notifyMembers({ ...ctx, db } as MutationCtx, orgId, to, { source: { kind: "module", moduleId, collection: about.collection, key: about.key }, message, ...(link ? { link } : {}), ...(subject ? { subject } : {}), ...(fx.badge ? { badge: fx.badge } : {}) });
    if (fx.email) await emailNotices(db, to, { subject, message, link }, about);
  }

  // ── Outbound (docs/modules.md, "Outbound"): a send queues in the outbox in the write's own transaction ──

  /** The members a notification or a notice names: member values and roles, never the person who caused it. */
  async function recipientsOf(list: readonly unknown[], env: Env | null, max: number, what: string): Promise<string[]> {
    const members = await workspaceMembers(ctx, orgId);
    const ids: string[] = [];
    for (const r of list) {
      if (r !== null && typeof r === "object" && "role" in r) { ids.push(...members.filter((u) => ((r as { role: readonly string[] }).role).includes(u.role)).map((u) => u.id as string)); continue; }
      const v = env ? await valueOf(r as never, env) : r;
      for (const id of [v].flat()) if (typeof id === "string") ids.push(id);
    }
    const in_ = new Set(members.map((u) => u.id as string));
    const to = [...new Set(ids)].filter((id) => in_.has(id) && id !== (system ? null : access.userId));
    if (to.length > max) refuse(`${what} goes to at most ${max} members; this one names ${to.length}.`);
    return to;
  }

  /** A text scope with the workspace's members and money: what a notification or a template fills from. */
  async function textScope(binds: Record<string, unknown>) {
    const members = await workspaceMembers(ctx, orgId);
    const org = await ctx.db.get(orgId);
    return { binds, members: new Map(members.map((u) => [u.id as string, u.name])), currency: org?.defaultCurrency ?? "USD", decimals: moneyDecimals(org?.currencyDecimals) };
  }

  /** Queue one outbox row, and say so on the doc that caused it (a call's send has no doc). A rerun finds its row and writes nothing. */
  async function queue(db: MutationCtx["db"], about: Cause, q: Omit<Enqueue, "orgId" | "module" | "cause" | "index" | "about" | "fromUserId">, words: string) {
    const out = await enqueue(ctx as MutationCtx, {
      ...q, orgId, module: { id: moduleId, title: manifest.title, outbound: manifest.outbound }, cause: about.cause, index: about.index,
      ...(about.collection ? { about: `${about.collection}/${about.key}` } : {}), ...(system ? {} : { fromUserId: access.userId as Id<"users"> }),
    });
    if (out.created && about.collection) await audit(db, about.collection, about.key, { verb: about.verb, kind: "event", fields: [], reason: `${words}: ${out.state.replace("_", " ")}`, args: { outbound: out.id }, cause: about.cause });
    return out;
  }

  /** A notice to members by email, each as they chose for this module: as it happens, in the day's digest, or not. */
  async function emailNotices(db: MutationCtx["db"], to: readonly string[], n: { subject?: string; message: string; link?: string }, about: Cause) {
    const base = appUrl();
    const text = n.link && base ? `${n.message}\n\n${base.replace(/\/$/, "")}${n.link}` : n.message;
    const rendered: Rendered = { subject: (n.subject ?? `${manifest.title}: ${n.message}`).replace(/\s+/g, " ").slice(0, 200), text };
    for (const id of to) {
      const mode = await noticeMode(ctx, orgId, id as Id<"users">, moduleId);
      if (mode === "off") continue;
      const at = digestAt(Date.now());
      const digest = { key: `${orgId}|${id}|${new Date(at).toISOString().slice(0, 10)}`, at };
      await queue(db, about, { channel: "email", kind: "notice", from: "workspace", to: { member: id as Id<"users"> }, target: `member:${id}`, rendered: { ok: true, rendered }, digest }, "Emailed notice");
    }
  }

  async function mailboxValue(x: MachineExpr, env: Env): Promise<unknown> {
    if (!x || typeof x !== "object" || !("lookup" in x)) return valueOf(x, env);
    const args = Object.fromEntries(await Promise.all(Object.entries(x.lookup.args ?? {}).map(async ([key, expression]) => [key, await mailboxValue(expression, env)])));
    const result = await view(x.lookup.view, args), first = Array.isArray(result) ? result[0] : result;
    if (!first) return null;
    if (x.field === "key") return first.key;
    return x.field.split(".").reduce<unknown>((at, part) => at && typeof at === "object" && !Array.isArray(at) ? (at as Record<string, unknown>)[part] : null, first.data);
  }

  /** A send effect or intent: its template rendered for each recipient, queued as the gate decides. */
  async function send(db: MutationCtx["db"], fx: Pick<SendEffect, "send">, env: Env | { vars: Record<string, unknown> }, about: Cause, source?: { collection: string; key: string; version: number }) {
    const { template, to, approval } = fx.send;
    const t = manifest.templates?.[template] ?? refuse(`${manifest.title} has no template ${template}.`);
    const channel = "slack" in to ? "slack" : "webhook" in to ? "webhook" : "email";
    if (t.channel !== channel) refuse(`Template ${template} is for ${t.channel}, not ${channel}.`);
    if ("people" in to) {
      if (!mailboxPerson() || !fx.send.from || approval !== undefined || about.cause.startsWith("canon:sq1.email.v1:")) refuse("People email requires a real causal person, explicit sender and closed owner/grant authorization.");
      const kind = mailboxKind(fx.send.kind);
      const saved = source ? await getRow(source.collection, source.key) : await getRow(about.collection, about.key);
      if (!saved || !(await readable(saved)) || source && saved.version !== source.version) refuse("The mailbox email source changed or is not visible.");
      const actual = saved!, current = "doc" in env ? envFor(subjectOf(actual), env.args, env.now, env.created) : null;
      const resolve = (x: MachineExpr) => current ? mailboxValue(x, current) : Promise.resolve(x);
      const ids = mailboxPeople(await Promise.all(to.people.map(resolve)));
      const rawSender = await resolve(fx.send.from!.sender), senderId = typeof rawSender === "string" ? ctx.db.normalizeId("emailAccounts", rawSender) : null;
      const preparedBy = ctx.db.normalizeId("users", access.userId);
      if (!ids || !senderId || !preparedBy) refuse("People email requires 1 to 20 canonical contacts and one explicit visible sender reference.");
      const savedSource = { collection: actual.collection, key: actual.key, version: actual.version };
      for (const contactId of ids!) {
        const out = await enqueueModuleMailboxEmail(ctx as MutationCtx, { orgId, moduleId, preparedBy: preparedBy!, contactId, senderId: senderId!,
          template, source: savedSource, requestedNotBefore: Date.now() }, kind, { cause: about.cause, index: about.index, about: `${actual.collection}/${actual.key}` });
        if (!("id" in out)) refuse(out.text);
        if ("id" in out && out.created) await audit(db, actual.collection, actual.key, { verb: about.verb, kind: "event", fields: [],
          reason: `Mailbox email: ${out.state.replace("_", " ")}`, args: { outbound: out.id }, cause: about.cause });
      }
      return;
    }
    if (fx.send.from !== undefined) refuse("Only people email accepts a sender reference.");
    if ((t.channel === "email" ? [t.subject, t.body] : t.channel === "slack" ? [t.text] : Object.values(t.data)).some((text) => text.includes("{$sender"))) refuse("Sender merge fields require the actual mailbox path.");
    const binds = "doc" in env ? { doc: { key: env.doc.key, version: 0, data: env.doc.data, owner: env.doc.owner } } : { vars: asDoc(env.vars) };
    const text = await textScope(binds);
    const common = { template, ...(approval ? { approval } : {}) };
    if ("slack" in to) {
      return void (await queue(db, about, { ...common, channel: "slack", kind: fx.send.kind ?? "automated", from: "workspace", to: { slack: to.slack }, target: `slack:${to.slack}`, name: to.slack, rendered: renderTemplate(t, text) }, `Slack post to ${to.slack}`));
    }
    if ("webhook" in to) {
      const endpoints = (await ctx.db.query("outboundTargets").withIndex("by_orgId_and_channel_and_name", (q) => q.eq("orgId", orgId).eq("channel", "webhook")).take(50)).filter((e) => e.events?.includes(to.webhook));
      const rendered = renderTemplate(t, text);
      for (const e of endpoints.length ? endpoints : [null]) {
        await queue(db, about, { ...common, channel: "webhook", kind: fx.send.kind ?? "automated", from: "workspace", to: { event: to.webhook, ...(e ? { endpoint: e._id } : {}) }, target: e ? `webhook:${e._id}` : `webhook:none:${to.webhook}`, name: to.webhook, rendered }, `Webhook ${to.webhook}${e ? ` to ${e.name}` : ""}`);
      }
      return;
    }
    const members = await workspaceMembers(ctx, orgId);
    for (const id of await recipientsOf(to.members, "doc" in env ? env : null, 20, "A notice")) {
      const m = members.find((u) => u.id === id)!;
      const rendered = renderTemplate(t, { ...text, binds: { ...binds, to: asDoc({ name: m.name, firstName: m.name.split(/\s+/)[0], email: m.email }, id) } });
      await queue(db, about, { ...common, channel: "email", kind: fx.send.kind ?? "notice", from: "workspace", to: { member: id as Id<"users"> }, target: `member:${id}`, rendered }, `Email to ${m.name}`);
    }
  }

  /** Who may start a transition: its roles for a person, Canon for a system one; an agent as its mode allows. */
  function checkTransitionCaller(machine: string, name: string) {
    moduleWritable(manifest, machineOf(machine).collection);
    const t = transitionOf(machine, name);
    mailboxCaller(t.effects);
    const blocked = admission(t);
    if (blocked) refuse(blocked);
    const mode = agentModeOf(manifest, machine, name);
    if (agent && mode.mode === "human") refuse(`An agent can't ${lower(mode.label)}: ${mode.reason}`);
    return mode;
  }

  async function sequenceVariables(key: string) {
    const sequence = await peek("sequences", key);
    const senders = [];
    const reader = senderReader(ctx, orgId, access);
    for (const s of Array.isArray(sequence?.data.senders) ? sequence.data.senders : []) {
      const id = ctx.db.normalizeId("emailAccounts", String(s.sender));
      const sender = id ? await reader.byId(id) : null;
      if (sender?.status === "ok") senders.push({ name: sender.name, address: sender.address });
    }
    const index = slotIndex("enrollments", "bySequenceState");
    const all = await docs().withIndex(slotIndexName(index), (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", "enrollments").eq(`s${index}a`, key)).order("asc").take(1001);
    const plan = await readSequenceVariablePlan({ orgId, moduleId, userId: system ? null : access.userId, peek, view }, key, senders);
    if (all.length > 1000 || all.filter((e) => e.data.sequence === key && e.data.state !== "finished").length !== plan.recipients.length) refuse("Every sequence recipient must be visible for approval.");
    return plan;
  }

  async function transition(machine: string, name: string, input: TransitionInput, approval?: Approval): Promise<TransitionResult> {
    if (!isMutation(ctx)) return refuse("Module transitions run in a mutation.");
    notMigrating();
    const db = ctx.db;
    const mc = machineOf(machine), t = transitionOf(machine, name);
    const mode = checkTransitionCaller(machine, name);
    const row = typeof input.key === "string" ? await getRow(mc.collection, input.key) : null;
    if (!row || !(await readable(row, true))) return refuse(`${mc.collection} has no ${input.key ?? "doc"} you can see.`);
    if (input.expect !== row.version) refuse("This doc changed since you loaded it. Reload and try again.");
    const { __variableReview, ...rest } = input.args ?? {};
    const sequenceLaunch = moduleId === "@canon/sequences" && machine === "sequence" && name === "launch";
    const args = sequenceLaunch ? rest : input.args ?? {};
    const variableReview = sequenceLaunch && typeof __variableReview === "string" ? __variableReview : undefined;
    await checkValue(t.args ?? NO_ARGS, args, `what ${t.label} takes`);
    const reason = input.reason?.trim().slice(0, 500) || undefined;
    // Where the person ran it: only what the transition declares, and only as Canon's web server signed it.
    if (t.evidence?.length && (!input.evidence || system)) refuse(`${t.label} records where you run it: run it from Canon's web app.`);
    const evidence = t.evidence?.length && input.evidence ? Object.fromEntries(t.evidence.flatMap((k) => (input.evidence![k] ? [[k, input.evidence![k]!]] : []))) : undefined;
    if (agent && mode.mode === "propose" && !approval) {
      // A proposal a person could apply now: its state and guards hold, and its result fits the schema.
      const out = await move(db, machine, name, row, args, reason, { writes: { n: 0 }, dryRun: true });
      const from = String(row.data[mc.field] ?? "");
      markModuleSemanticWriteAttempt(ctx);
      return propose(db, { kind: "transition", module: moduleId, machine, name, key: row.key, expect: row.version, ...(Object.keys(args).length ? { args } : {}), ...(reason ? { reason } : {}) },
        { collection: mc.collection, key: row.key, action: t.label, before: { [mc.field]: from }, after: { [mc.field]: out.state, ...args } },
        `${t.label} ${mc.collection} ${row.key} in ${manifest.title}`,
        { verb: `${machine}.${name}`, fields: [mc.field], fromVersion: row.version, from, to: out.state, ...(Object.keys(args).length ? { args } : {}), ...(reason ? { reason } : {}) });
    }
    const out = await move(db, machine, name, row, args, reason, { writes: { n: 0 }, ...(approval ? { approval } : {}), ...(evidence ? { evidence } : {}), variableReview });
    // The doc as the move and its effects left it, while the caller still reads it: what a page's toast says of it.
    const after = await getRow(mc.collection, out.key);
    const data = after && (await readable(after)) ? after.data : undefined;
    return { key: out.key, version: out.version, state: out.state, ...(Object.keys(out.created).length ? { created: out.created } : {}), ...(data ? { data } : {}) };
  }

  async function blocked(machine: string, name: string, key: string, args: Record<string, unknown> = {}): Promise<string | null> {
    const mc = manifest.machines?.[machine], t = mc?.transitions[name];
    if (!mc || !t) return null;
    const row = await getRow(mc.collection, key);
    if (!row || !(await readable(row))) return null;
    if (!(await readable(row, true))) return "This doc is read only for you.";
    const from = String(row.data[mc.field] ?? "");
    if (!t.from.includes(from)) return `${t.label} needs it to be ${t.from.join(" or ")}.`;
    // A guard over the arguments the action fixes (the step a chain's row names) is judged with them; one that reads
    // an argument the dialog asks for waits for the submit.
    const env = envFor(subjectOf(row), args, Date.now());
    const given = Object.keys(args);
    try {
      for (const g of t.guards ?? []) if (!namesArgsBeyond(g.when, given) && !(await holds(g.when, env.doc, env))) return g.message;
      return null;
    } catch (e) { return e instanceof ConvexError ? String(e.data) : null; }
  }

  async function sendPreview(machine: string, name: string, key: string, args: Record<string, unknown> = {}): Promise<SendPreview[] | null> {
    const mc = manifest.machines?.[machine], t = mc?.transitions[name];
    if (!mc || !t) return null;
    const row = await getRow(mc.collection, key);
    if (!row || !(await readable(row))) return null;
    const now = Date.now();
    const env = envFor(subjectOf(row), args, now);
    let setUnavailable = false;
    const set = await valuesOf(t.set ?? {}, env).catch(() => { setUnavailable = true; return {}; });
    const data: Record<string, unknown> = { ...withSet(row.data, set), [mc.field]: typeof t.to === "string" ? t.to : row.data[mc.field] };
    const after = envFor({ ...subjectOf(row), data }, args, now);
    const out: SendPreview[] = [];
    for (const fx of t.effects ?? []) {
      if (!("send" in fx) || (fx.when && !(await holds(fx.when, after.doc, after).catch(() => false)))) continue;
      const tpl = manifest.templates?.[fx.send.template];
      if (!tpl) continue;
      const to = fx.send.to;
      if ("people" in to) {
        const missing = (text: string) => out.push({ channel: "email", to: "Canonical contacts", approval: true, informational: true, refused: text });
        if (!mailboxPerson() || !fx.send.from) { missing("A real person's mailbox action and explicit sender are required."); continue; }
        if (setUnavailable || typeof t.to !== "string" || JSON.stringify(data) !== JSON.stringify(row.data)) { missing("The source changes in this transition. Canon renders the actual saved document afterward; this preview cannot freeze or approve that email."); continue; }
        try {
          const ids = mailboxPeople(await Promise.all(to.people.map((x) => mailboxValue(x, after))));
          const rawSender = await mailboxValue(fx.send.from.sender, after), senderId = typeof rawSender === "string" ? ctx.db.normalizeId("emailAccounts", rawSender) : null;
          const preparedBy = ctx.db.normalizeId("users", access.userId);
          if (!ids || !senderId || !preparedBy) { missing("Resolve 1 to 20 canonical contacts and an explicit visible sender first."); continue; }
          for (const contactId of ids) {
            const result = await previewModuleMailboxEmail(ctx, { orgId, moduleId, preparedBy, contactId, senderId, template: fx.send.template,
              source: { collection: row.collection, key: row.key, version: row.version }, requestedNotBefore: now }, mailboxKind(fx.send.kind));
            if (result.state === "refused") missing(result.text);
            else out.push({ channel: "email", to: result.to, sender: result.sender, subject: result.subject, text: result.text, approval: result.approval, informational: true });
          }
        } catch (error) {
          if (!(error instanceof ConvexError)) throw error;
          missing("The canonical mailbox preview could not be resolved in your current scope.");
        }
        continue;
      }
      const r = renderTemplate(tpl, await textScope({ doc: { key: row.key, version: 0, data, owner: after.doc.owner } }));
      out.push({
        channel: tpl.channel, to: "slack" in to ? `#${to.slack}` : "webhook" in to ? `the ${to.webhook} webhook` : "members", approval: fx.send.approval === "person",
        ...(r.ok ? { ...(r.rendered.subject ? { subject: r.rendered.subject } : {}), text: r.rendered.text } : { missing: r.missing }),
      });
    }
    return out;
  }

  async function events(collection: string, key: string, limit = 50): Promise<ModuleEvent[] | null> {
    const row = await getRow(collection, key);
    if (!row || !(await readable(row))) return null;
    const rows = await ctx.db.query("moduleEvents").withIndex("by_orgId_moduleId_collection_key_at", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection).eq("key", key)).order("desc").take(Math.min(limit, EVENTS_MAX));
    // Where someone ran a transition is theirs and an admin's to read, not every reader's of the doc.
    const sees = (e: ModuleEvent) => system || role === "admin" || ("userId" in e.actor && e.actor.userId === access.userId);
    return rows.map(({ _id, _creationTime, orgId: _o, moduleId: _m, collection: _c, key: _k, ...event }) => (event.evidence && !sees(event) ? { ...event, evidence: undefined } : event));
  }

  async function visited(machine: string, key: string): Promise<string[]> {
    const mc = machineOf(machine);
    const trail = await events(mc.collection, key, EVENTS_MAX);
    if (!trail) return [];
    const row = await getRow(mc.collection, key);
    const out = new Set<string>([mc.initial, String(row?.data[mc.field] ?? mc.initial)]);
    for (const e of trail) if (e.kind === "transition" && e.verb.startsWith(`${machine}.`)) { if (e.from) out.add(e.from); if (e.to) out.add(e.to); }
    return mc.states.filter((s) => out.has(s));
  }

  // ── Calls: read plan, then (in the action) the module's code, then apply ──

  const callOf = (name: string, canon = false): CallDecl => {
    const call = manifest.calls?.[name] ?? refuse(`${manifest.title} has no call ${name}.`);
    if (call.canon && !canon) refuse("Canon operations run only as direct human calls, never in module code, read plans or intents.");
    return call;
  };
  /** The call, once the caller may run it: their role (Canon for a system call), and an agent only when its mode allows. */
  function checkCall(name: string, canon = false, completionOf?: string): CallDecl {
    const call = callOf(name, canon);
    const queues = Object.entries(manifest.calls ?? {}).filter(([n, c]) => c.ai?.queue?.next === name || (n === name && c.step));
    if (queues.length && !queues.some(([aiCall]) => aiCall === completionOf)) refuse(`${call.label} runs only as its initiating member's queued completion.`);
    // A preview runs a call that writes nothing, as the member it previews; their scope reads. The rest refuse.
    const blocked = admission(call, !readsOnly(call));
    if (blocked) refuse(blocked);
    return call;
  }
  async function authorizeCanonCall(name: string, args: Record<string, unknown>) {
    const call = checkCall(name, true);
    if (!call.canon || system || principal.kind !== "user" || !principal.session || access.preview || agent) return refuse("Canon operations require a signed-in person outside preview.");
    if (call.agent !== "human" || call.system || call.ai || call.step || call.proposal || (!call.canon.then && call.writes.length) || Object.keys(call.reads).length) return refuse("Invalid Canon operation declaration.");
    notMigrating();
    const user = await ctx.db.get(principal.user._id);
    const actualRole = user && await roleIn(ctx, user, orgId);
    if (!actualRole || !call.roles.includes(baseRole(actualRole, await roleBasesOf(ctx, orgId)) as Role)) return refuse("Your current workspace role cannot run this Canon operation.");
    const freshAdmission = admission(call, true, await withRole(ctx, { ...user!, orgId, role: actualRole! }));
    if (freshAdmission) refuse(freshAdmission);
    await checkValue(call.args ?? NO_ARGS, args, `what ${call.label} takes`);
    if (call.canon.then) await canonTarget(name, args);
    return { orgId, packageId: pkg._id, call: name, input: canonicalJson(args), operation: call.canon.operation, userId: principal.user._id, moduleId, epoch, ...(call.canon.then ? { revision } : {}) };
  }
  const canonBindings = new Map<string, string>();
  async function canonTarget(name: string, args: Record<string, unknown>) {
    const call = callOf(name, true), then = call.canon?.then;
    if (!then || canonCallProblems(manifest, name, call).length) return refuse("Unsupported atomic Canon binding.");
    const mc = machineOf(then.machine), t = transitionOf(then.machine, then.transition);
    moduleWritable(manifest, mc.collection);
    checkTransitionCaller(then.machine, then.transition);
    const key = args[then.key], expect = args[then.expect];
    if (typeof key !== "string" || !key || key.length > 200 || typeof expect !== "number" || !Number.isSafeInteger(expect) || expect < 1) return refuse("Atomic Canon calls need a document key and finite integer expected version.");
    const row = await getRow(mc.collection, key);
    if (!row || !(await readable(row, true)) || row.version !== expect) return refuse("This document changed or is not writable. Reload before starting a fill.");
    if (!t.from.includes(String(row.data[mc.field]))) return refuse("This document is already decided or no longer accepts this operation.");
    const guard = await blocked(then.machine, then.transition, key);
    if (guard) return refuse(guard);
    const input: Record<string, unknown> = {};
    for (const [argument, source] of Object.entries(then.input)) {
      if (!Object.hasOwn(row.data, source.field) || typeof row.data[source.field] !== "string") return refuse("The Canon input is not a declared document data field.");
      input[argument] = row.data[source.field];
    }
    return { call, then, row, input, key, expect };
  }
  async function canonInput(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!callOf(name, true).canon?.then) return args;
    const authorization = await authorizeCanonCall(name, args);
    const target = await canonTarget(name, args);
    canonBindings.set(name, canonicalJson({ authorization, revision, row: target.row, input: target.input }));
    return target.input;
  }
  async function finishCanonCall(name: string, args: Record<string, unknown>, result: unknown): Promise<TransitionResult | null> {
    if (!callOf(name, true).canon?.then) return null;
    const authorization = await authorizeCanonCall(name, args);
    const target = await canonTarget(name, args);
    if (!canonBindings.has(name) || canonBindings.get(name) !== canonicalJson({ authorization, revision, row: target.row, input: target.input })) return refuse("The atomic Canon document binding changed.");
    if (!isMutation(ctx) || !result || typeof result !== "object" || Object.keys(result).join() !== "jobId" || !Object.hasOwn(result, "jobId")) return refuse("Population did not return its direct jobId result.");
    const raw = (result as { jobId: unknown }).jobId;
    const jobId = typeof raw === "string" ? ctx.db.normalizeId("backgroundJobs", raw) : null;
    const job = jobId ? await ctx.db.get(jobId) : null;
    if (!job || job.orgId !== orgId) return refuse("Population returned no job in this workspace.");
    canonBindings.delete(name);
    canonMove = { machine: target.then.machine, name: target.then.transition, key: target.key, expect: target.expect };
    try { return await transition(target.then.machine, target.then.transition, { key: target.key, expect: target.expect, args: { jobId } }); }
    finally { canonMove = null; }
  }
  const writable = (call: CallDecl, collection: string) => {
    moduleWritable(manifest, collection);
    if (!call.writes.includes(collection)) refuse(`${call.label} doesn't write ${collection}: a call writes only the collections its manifest lists.`);
    return collectionOf(collection);
  };

  /**
   * Another module's interface as this caller reads it (docs/modules.md, "Reading another module"): that module's own
   * scope for the same principal (a person's access and role, or Canon), so its read scopes hold; or why there is
   * none: not installed, off, or not providing that interface (a version it dropped, or never had).
   */
  async function providerOf(module: string, provide: string): Promise<{ missing: "not_installed" | "off" | "not_provided" } | { scope: ModuleScope; types: Record<string, ArgType>; one: boolean } | { bridged: ModuleDoc[]; types: Record<string, ArgType>; one: false }> {
    if (!(manifest.uses?.[module] ?? []).includes(provide)) return refuse(`${manifest.title} doesn't declare that it uses ${module}'s ${provide}.`);
    if (module === ICPS_MODULE) {
      const bridged = await bridgedIcpsRead(ctx, orgId, provide);
      if (bridged !== null) return { bridged, types: {}, one: false };
    }
    const pkg = await installedModule(ctx, orgId, module);
    if (module === ICPS_MODULE && await interfaceOwner(ctx, orgId)) {
      if (!pkg || pkg.pending || !(await isEnabled(ctx, orgId, module))) refuse("The owning ICP provider is unavailable or upgrading.");
      assertIcpProvider(pkg!, manifestOf(pkg!));
    }
    if (!pkg) return { missing: "not_installed" };
    if (!(await isEnabled(ctx, orgId, pkg.moduleId))) return { missing: "off" };
    if (cuttingOver(pkg)) refuse(`${manifestOf(pkg).title} is finishing its upgrade. Try again in a moment.`);
    const decl = manifestOf(pkg).provides?.[provide];
    const v = decl ? manifestOf(pkg).views[decl.view] : undefined;
    if (!decl || !v) return { missing: "not_provided" };
    return { scope: scopeOf(ctx, principal, pkg, await pendingManifestOf(ctx, pkg), undefined, pkg.moduleId !== ICPS_MODULE || (await interfaceOwner(ctx, pkg.orgId))?.packageId === pkg._id, true), types: v.args ?? {}, one: v.kind === "one" };
  }

  /** One of this module's published interfaces, as the caller reads it: its view's docs with only the fields it hands over. */
  async function provide(name: string, given: Record<string, unknown>, limit: number): Promise<ReadValue> {
    const decl = manifest.provides?.[name] ?? refuse(`${manifest.title} doesn't provide ${name}.`);
    const v = manifest.views[decl.view];
    const out = (d: ModuleDoc): ModuleDoc => ({ ...d, data: Object.fromEntries(decl.fields.filter((f) => d.data[f] !== undefined).map((f) => [f, d.data[f]])) });
    if (v.kind === "one") { const d = (await view(decl.view, given)) as ModuleDoc | null; return d ? out(d) : null; }
    checkArgs(decl.view, v, given);
    const rows = await scan(v, given, true, limit, Math.max(READ_SCAN_MAX, limit));
    if (!rows.complete) refuse(`${manifest.title}'s ${name} has more than ${limit} docs for you (or more than ${READ_SCAN_MAX} to look through). Raise the read's limit or narrow it.`);
    return rows.map(toDoc).map(out);
  }

  async function peopleQuery(name: string, key: string): Promise<PeopleQuery> {
    const decl = manifest.provides?.[name];
    if (!decl?.people) return refuse(`${name} in ${manifest.title} names no people.`);
    const collection = manifest.views[decl.view].collection;
    const row = await getRow(collection, key);
    if (!row || !(await readable(row))) return refuse(`${manifest.title} has no ${key} you can see.`);
    const filter = row.data[decl.people.filter] ?? [];
    if (!Array.isArray(filter)) return refuse(`${key} in ${manifest.title} holds no filter.`);
    const added = decl.people.added && { module: moduleId, set: decl.people.added.set, parentKey: key, field: decl.people.added.field };
    return { key, source: `${moduleId}/${name}/${key}`, filter: filter as ListFilter[], ...(added ? { added } : {}) };
  }

  async function systemSetValues(collection: string, parentKey: string, field: string, cursor: string | null, n: number): Promise<{ values: string[]; next: string | null }> {
    if (!system) return refuse("A set's values are read page by page as Canon.");
    const c = collectionOf(collection);
    const parent = c.setOf ? await getRow(c.setOf.parent, parentKey) : null;
    if (!parent) return { values: [], next: null };
    const gen = liveGen(parent, collection);
    const page = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection).eq("parentKey", parentKey).eq("gen", gen)).paginate({ numItems: n, cursor });
    return { values: page.page.flatMap((r) => (typeof r.data[field] === "string" ? [r.data[field] as string] : [])), next: page.isDone ? null : page.continueCursor };
  }

  async function snapshot(name: string, args: Record<string, unknown>, canon = false, completionOf?: string): Promise<Snapshot> {
    const call = checkCall(name, false, completionOf);
    if (!bundle && !call.ai) return refuse(`${manifest.title} has no server code installed.`);
    // Canon gives a job's, a watch's or a schedule's call its arguments itself; a person's are checked.
    if (canon && !system) refuse(`${call.label} runs only as Canon.`);
    if (!canon) await checkValue(call.args ?? NO_ARGS, args, `what ${call.label} takes`);
    const reads: Record<string, ReadValue> = {};
    const reports: Record<string, ReportSpec> = {};
    const aggregates: Record<string, AggregateSpec> = {};
    const companyNames: string[] = [];
    const records: Record<string, RecordReadSpec> = {};
    const researchAnswers: NonNullable<Snapshot["researchAnswers"]> = {};
    const markets: Record<string, MarketReadSpec> = {};
    const trees: Record<string, TreeSpec> = {};
    const icpTrees: Record<string, IcpTreeSpec> = {};
    const meContexts: NonNullable<Snapshot["meContexts"]> = {};
    const socialSearches: NonNullable<Snapshot["socialSearches"]> = {};
    const webPages: NonNullable<Snapshot["webPages"]> = {};
    const webSearches: NonNullable<Snapshot["webSearches"]> = {};
    const marketSamples: NonNullable<Snapshot["marketSamples"]> = {};
    const dealCompanies: NonNullable<Snapshot["dealCompanies"]> = {};
    /**
     * Each company's open pipeline and its bookings over the last 365 days, from the deals the caller sees (Canon's
     * own: every one): what a territory's pipeline and bookings sum.
     */
    const dealsByCompany = async (): Promise<Record<string, { pipeline: number; bookings12m: number }>> => {
      // Sums of deal fields the caller's role hides would reveal them: a role that hides one reads no territory deals.
      const hidden = system ? [] : ["amount", "isClosed", "isWon", "closedAt", "companyId"].filter((f) => fieldLevel(access, "deal", f) === "hidden");
      if (!system && !permissionOf(access, "deal").read) refuse(`${call.label} sums deals, which your role doesn't read.`);
      if (hidden.length) refuse(`${call.label} sums deals' ${hidden.join(", ")}, which your role doesn't see.`);
      const since = Date.now() - 365 * 86_400_000;
      const out: Record<string, { pipeline: number; bookings12m: number }> = {};
      const crm = new Map<string, string | null>();
      const crmCompanyOf = async (id: Id<"crmAccounts">) => {
        if (!crm.has(id)) { const a = await ctx.db.get(id); crm.set(id, a && a.orgId === orgId && a.domain ? `domain:${a.domain.toLowerCase()}` : null); }
        return crm.get(id)!;
      };
      let scanned = 0;
      for await (const d of ctx.db.query("deals").withIndex("by_orgId", (q) => q.eq("orgId", orgId))) {
        if (++scanned > TREE_DEALS_SCANNED) refuse(`${call.label} reads more than ${TREE_DEALS_SCANNED} deals for its territories.`);
        if (d.archivedAt !== undefined || !(system || (permissionOf(access, "deal").read && dealVisible(access, d)))) continue;
        // A deal synced from a CRM that no person linked to a company counts at its CRM account's company (by domain).
        const companyId = d.companyId ?? (d.accountId ? await crmCompanyOf(d.accountId) : null);
        if (!companyId) continue;
        const open = !d.isClosed ? d.amount ?? 0 : 0;
        // A deal closed won without a close time (an import's) counts from its close date.
        const closed = d.closedAt ?? (d.closeDate ? Date.parse(`${d.closeDate}T00:00:00Z`) : 0);
        const won = d.isWon && closed >= since ? d.amount ?? 0 : 0;
        if (!open && !won) continue;
        const c = (out[companyId] ??= { pipeline: 0, bookings12m: 0 });
        c.pipeline += open; c.bookings12m += won;
      }
      if (Object.keys(out).length > MAX_ASSIGN) refuse(`${call.label} has deals at more than ${MAX_ASSIGN} companies to place in territories.`);
      return out;
    };
    /** An earlier read's values of `field`, distinct and without nulls, lists spread: a list argument's values. */
    const valuesOf = (key: string, read: string, from: string, field: string | undefined): Scalar[] => {
      const got = reads[from];
      const items = (Array.isArray(got) ? got : got === null || got === undefined ? [] : [got]) as Array<Record<string, unknown>>;
      const pick = (x: Record<string, unknown>): unknown => {
        if (!("data" in x && "version" in x)) return x[field ?? "id"];
        const f = field ?? "key";
        return f === "key" || f === "owner" || f === "parentKey" ? x[f] : (x.data as Record<string, unknown>)[f];
      };
      const out = new Set<Scalar>();
      for (const v of items.flatMap((x) => [pick(x)].flat())) if (v !== null && v !== undefined && typeof v !== "object") out.add(v as Scalar);
      if (out.size > MAX_IN_VALUES) refuse(`${call.label} reads ${key} by ${out.size} values from ${from}; one read takes at most ${MAX_IN_VALUES} (${read}).`);
      return [...out];
    };
    /** One value from an earlier read of one doc: its field (`key` by default), null when there is no doc. */
    const fieldOfOne = (from: string, field: string | undefined): Scalar => {
      const doc = reads[from] as { key: string; owner: string | null; parentKey: string | null; data: Record<string, unknown> } | null;
      if (!doc) return null;
      const f = field ?? "key";
      const v = f === "key" || f === "owner" || f === "parentKey" ? doc[f] : doc.data[f];
      return v === undefined || (typeof v === "object" && v !== null) ? null : (v as Scalar);
    };
    const ws = await workspace();
    for (const [key, r] of Object.entries(call.reads)) {
      // Another module's interface: its provider's scope as the same principal, or why there is none to read.
      const other = "module" in r ? await providerOf(r.module, r.provide) : null;
      if (other && "missing" in other) { reads[key] = { missing: other.missing }; continue; }
      if ("icpTree" in r) {
        try {
          const request = icpTreeRequest(r.icpTree, reads, await modelSettings(ctx, orgId, "scoring.fit"));
          for (const slug of new Set(request.nodes.flatMap((n) => (n.account?.custom ?? []).map((c) => c.key.slice("custom.".length))))) {
            const field = await ctx.db.query("researchAgents").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", slug)).unique();
            if (!field || field.entityType !== "account") refuse(`field.${slug} is not one of this workspace's account AI fields`);
          }
          icpTrees[key] = { orgId, userId: system ? "system" : access.userId, granted: icpTreeGranted(manifest.reads, r.icpTree.market), request, ...(r.icpTree.market ? { market: icpTreeMarkets(r.icpTree, reads) } : {}) };
        } catch (error) { refuse(`${call.label}: ${error instanceof Error ? error.message : String(error)}`); }
        reads[key] = null;
        continue;
      }
      if ("tree" in r) {
        // A territory tree: its nodes from an earlier read, counted in the call's action (convex/modules.ts runCall).
        const t = r.tree;
        const cellNode = t.cells ? (t.cells.node !== null && typeof t.cells.node === "object" && "arg" in t.cells.node ? args[t.cells.node.arg] : t.cells.node) : null;
        const place = t.place === undefined ? null : t.place !== null && typeof t.place === "object" && "arg" in t.place ? args[t.place.arg] : t.place;
        trees[key] = { ...treeSpecOf(t, reads, typeof cellNode === "string" ? cellNode : null, t.deals ? await dealsByCompany() : null), ...(typeof place === "string" && place ? { place } : {}) };
        reads[key] = null;
        continue;
      }
      const name = "view" in r ? r.view : "report" in r ? r.report.collection : "aggregate" in r ? r.aggregate.collection : "module" in r ? `${r.module} ${r.provide}` : r.canon;
      const types: Record<string, ArgType> = "view" in r ? (manifest.views[r.view]?.args ?? {}) : "canon" in r ? CANON_READS[r.canon].args : other ? other.types : {};
      const value = (k: string, x: CallExpr): unknown =>
        x === null || typeof x !== "object" ? x : "arg" in x ? (args[x.arg] ?? null) : isClock(x) ? clockValue(x, Date.now())
          : "toMs" in x ? dateToMs(value(k, x.toMs), x.endOfDay === true) : "toDate" in x ? msToDate(value(k, x.toDate))
          : "workspace" in x ? ws.fiscalYearStartMonth : "fiscalYearStart" in x ? fiscalYearStart(value(k, x.fiscalYearStart), ws.fiscalYearStartMonth, x.as, x.years)
          : "read" in x ? (isListArg(types[k]) ? valuesOf(key, name, x.read, x.field) : fieldOfOne(x.read, x.field)) : access.userId;
      if ("report" in r) {
        // A report read is the record service's, run as the caller in the call's action (convex/modules.ts runCall):
        // here its spec, its filter's values computed from the call.
        if (system) refuse(`${call.label} reads a report, which reads as a person.`);
        const sh = r.report;
        reports[key] = {
          object: sh.collection, chart: "table", groupBy: [...(sh.rows ?? []), ...(sh.columns ?? [])].map((k) => (typeof k === "string" ? { field: k } : { field: k.field, ...(k.bucket ? { bucket: k.bucket } : {}) })),
          measures: (sh.values ?? [{ fn: "count" as const }]).map((v) => ({ fn: v.fn, ...(v.field ? { field: v.field } : {}) })),
          filter: (sh.filter ?? []).map((f) => {
            const v = f.value === undefined ? null : value(f.field, f.value);
            return { field: f.field, op: f.op, ...(v !== null && v !== undefined ? { value: v as string | number | boolean | Array<string | number | boolean> } : {}) };
          }),
        };
        continue;
      }
      if ("aggregate" in r) {
        // A team aggregate: every doc, run and folded in the call's action (convex/modules.ts runAggregate), never
        // handed to the code but as its figures. Here its spec, its filter's values computed from the call.
        const a = r.aggregate;
        aggregates[key] = {
          collection: a.collection, owner: collectionOf(a.collection).owner!, values: a.values, minOwners: a.minOwners ?? MIN_AGGREGATE_OWNERS,
          filter: (a.filter ?? []).map((f) => {
            const v = f.value === undefined ? null : value(f.field, f.value);
            return { field: f.field, op: f.op, ...(v !== null && v !== undefined ? { value: v as string | number | boolean | Array<string | number | boolean> } : {}) };
          }),
        };
        continue;
      }
      const given = Object.fromEntries(Object.entries(r.args ?? {}).map(([k, x]) => [k, value(k, x)]));
      const limit = r.limit ?? READ_DEFAULT;
      // An argument from an earlier read of no doc (a period that isn't there) names nothing: the read reads nothing.
      const missing = Object.entries(r.args ?? {}).some(([k, x]) => { if ("canon" in r && r.canon === "match.inbound" && k === "companyName") return false; const inner = unwrapDate(x); return inner !== null && typeof inner === "object" && "read" in inner && !isListArg(types[k]) && given[k] === null; });
      if (missing) { reads[key] = ("view" in r && manifest.views[r.view]?.kind === "one") || other?.one ? null : []; continue; }
      if ("module" in r && other && "bridged" in other) {
        if (other.bridged.length > limit) refuse(`${r.module}'s ${r.provide} has more than ${limit} docs. Raise the read's limit.`);
        reads[key] = other.bridged;
        continue;
      }
      if ("module" in r) { reads[key] = await (other as { scope: ModuleScope }).scope.provide(r.provide, given, limit); continue; }
      if ("canon" in r && (r.canon === "me.context" || r.canon === "me.status" || r.canon === "social.search" || r.canon === "web.pages" || r.canon === "web.search" || r.canon === "research.signup" || r.canon === "market.sample" || r.canon === "ai.plan" || r.canon === "deals.latestClosed") && system) return refuse("This research read requires a member.");
      if ("canon" in r && (r.canon === "me.context" || r.canon === "me.status") && !["profile", "posts", "counterparts"].every((f) => manifest.reads?.me?.includes(f))) return refuse(`${r.canon} requires its install grants.`);
      if ("canon" in r && r.canon === "me.context") {
        const section = given.section ?? "all";
        if (!["all", "words", "counterparts", "sources"].includes(String(section)) || Object.keys(given).some((k) => k !== "section")) return refuse("Unknown me.context section.");
        meContexts[key] = { orgId, userId: access.userId, section: String(section) };
        reads[key] = [];
        continue;
      }
      if ("canon" in r && r.canon === "social.search") {
        if (!manifest.reads?.social?.includes("search")) return refuse("social.search requires its install grant.");
        if (Object.keys(socialSearches).length >= SOCIAL_MAX_QUERIES) return refuse("A call reads at most 12 social queries.");
        socialSearches[key] = { ...socialSearchRequest(given), orgId, userId: access.userId };
        reads[key] = [];
        continue;
      }
      if ("canon" in r && r.canon === "market.sample") {
        if (!manifest.reads?.market?.includes("sample")) return refuse("market.sample requires its install grant.");
        marketSamples[key] = { queries: marketSampleRequest(given), orgId, userId: access.userId };
        reads[key] = [];
        continue;
      }
      if ("canon" in r && r.canon === "web.search") {
        if (!["search", "url", "text"].every((f) => manifest.reads?.web?.includes(f))) return refuse("web.search requires the search, url and text install grants.");
        webSearches[key] = { ...webSearchRequest(given), orgId, userId: access.userId };
        reads[key] = [];
        continue;
      }
      if ("canon" in r && r.canon === "web.pages") {
        if (!(manifest.reads?.web?.includes("url") && manifest.reads.web.includes("text"))) return refuse("web.pages requires the url and text install grants.");
        webPages[key] = { ...webPagesRequest(given), orgId, userId: access.userId };
        reads[key] = [];
        continue;
      }
      if ("canon" in r && r.canon === "research.answers") {
        if (system || typeof given.slug !== "string") return refuse("research.answers needs a person and a field slug.");
        researchAnswers[key] = { slug: given.slug, limit: Math.min(limit, 200), fields: [...(manifest.reads?.researchAnswers ?? [])] };
        reads[key] = [];
        continue;
      }
      if ("canon" in r && r.canon === "market.facets") {
        markets[key] = planMarketRead(given);
        reads[key] = null;
        continue;
      }
      if ("canon" in r && (r.canon === "people.snapshot" || r.canon === "people.count")) {
        const name = String(given.provide), doc = String(given.key);
        const from = typeof given.module === "string" && given.module !== manifest.id ? await providerOf(given.module, name) : null;
        if (from && "missing" in from) return refuse(`${given.module}'s ${name} is ${from.missing.replaceAll("_", " ")}.`);
        if (from && "bridged" in from) return refuse(`${given.module}'s ${name} names no people.`);
        const query = await (from ? from.scope.peopleQuery(name, doc) : peopleQuery(name, doc));
        records[key] = await planRecordRead(ctx, orgId, system ? null : access, manifest, r.canon, given, limit, moduleId, query);
        reads[key] = [];
        continue;
      }
      if ("canon" in r && isRecordServiceRead(r.canon)) {
        // Ids from an earlier read of companies or people come in the action, once that read is read (recordReads.ts withIdsFrom).
        const from = Object.values(r.args ?? {}).map(unwrapDate).find((x): x is { read: string; field?: string } => x !== null && typeof x === "object" && "read" in x && Object.hasOwn(records, x.read));
        records[key] = { ...await planRecordRead(ctx, orgId, system ? null : access, manifest, r.canon, given, limit, moduleId), ...(from ? { idsFrom: { read: from.read, ...(from.field ? { field: from.field } : {}) } } : {}) };
        reads[key] = [];
        continue;
      }
      if ("canon" in r) {
        // A read with custom fields reads at most 500 deals (each is a read of its ledger stream).
        reads[key] = await canonRead(ctx, orgId, access, manifest, r.canon, given, r.custom ? Math.min(limit, 500) : limit, r.custom === true);
        if (r.canon === "deals.latestClosed") dealCompanies[key] = [...(manifest.reads?.companies ?? [])];
        if (r.canon !== "deals.latestClosed" && CANON_READS[r.canon].object === "deals" && r.canon !== "deals.changesBetween" && manifest.reads?.deals?.includes("companyName")) companyNames.push(key);
        continue;
      }
      const v = manifest.views[r.view];
      if (v.kind === "one") { reads[key] = (await view(r.view, given)) as ReadValue; continue; }
      checkArgs(r.view, v, given);
      const rows = await scan(v, given, true, limit, Math.max(READ_SCAN_MAX, limit));
      if (!rows.complete) refuse(`${call.label} reads ${key} from ${r.view}, which has more than ${limit} docs for you (or more than ${READ_SCAN_MAX} to look through). Raise the read's limit or narrow its view.`);
      reads[key] = rows.map(toDoc);
    }
    return {
      label: call.label, returns: call.returns, caller: { userId: system ? "system" : access.userId, role: callerRole }, reads, reports, aggregates, companyNames, records, researchAnswers, markets, trees, icpTrees, meContexts, socialSearches, webPages, webSearches, marketSamples, dealCompanies, principalFence: canonicalJson({ access, agent, capabilities: principal.kind === "user" ? principal.capabilities ?? [] : [] }), revision, ...(agent && call.agent === "propose" ? { propose: { summary: call.proposal?.summary ?? call.label } } : {}), bundle,
      canonFence: Object.fromEntries(Object.entries(call.reads).filter(([, r]) => "canon" in r && r.canon === "research.signup").map(([key]) => [key, reads[key]])),
      isolate: system ? `${orgId}:system` : `${orgId}:user:${access.userId}`, epoch, workspace: ws,
      ...(call.ai ? { ai: await aiRunOf(call, args, reads) } : {}),
    };
  }

  /**
   * A hosted AI step's run: the doc its answer fills (from the call's arguments or a read of one doc), which the caller
   * must read now, before any model runs, and whose version the write expects.
   */
  async function aiRunOf(call: CallDecl, args: Record<string, unknown>, reads: Record<string, ReadValue>): Promise<AiRun> {
    const ai = call.ai!;
    // The manifest's check allows only these two: an argument, or a field (its key by default) of a read of one doc.
    const k = ai.output.key as { arg: string } | { read: string; field?: string };
    let key: unknown = null;
    if ("arg" in k) key = args[k.arg];
    else {
      const one = reads[k.read] as { key: string; data: Record<string, unknown> } | null;
      key = one && (k.field === undefined || k.field === "key" ? one.key : one.data[k.field]);
    }
    if (typeof key !== "string") return refuse(`${call.label} names no doc to fill.`);
    const collection = opOf(ai.output.op).collection;
    const row = await getRow(collection, key);
    if (!row || !(await readable(row, true))) return refuse(`${collection} has no ${key} you can see.`);
    // The answer is written only over the version the plan read.
    return { decl: ai, schema: outputSchema(manifest, ai)!, key, collection, expect: { collection, key, version: row.version }, module: manifest.title, orgId, moduleId };
  }

  /** A set collection a call's replaceSet may write: listed in its writes, keyed "auto". */
  const setFor = (call: CallDecl, collection: string) => {
    const c = writable(call, collection);
    if (!c.setOf) refuse(`${collection} isn't a set: replaceSet replaces a set's docs.`);
    if (c.key !== "auto") refuse(`${collection}'s keys come from its fields; replaceSet writes a set whose key is "auto".`);
    return c;
  };

  async function stage(name: string, collection: string, parentKey: string, gen: number, docs: Array<Record<string, unknown>>, offset = 0): Promise<number> {
    if (!isMutation(ctx)) return refuse("A call's writes run in a mutation.");
    notMigrating();
    const call = checkCall(name);
    const c = setFor(call, collection);
    const parent = await getRow(c.setOf!.parent, parentKey);
    if (parent && !(await readable(parent, true))) refuse(`${call.label} needs a parent doc you can change.`);
    const owned = machineFields(manifest, collection);
    const now = Date.now();
    for (const [i, given] of docs.entries()) {
      const bad = Object.keys(given).filter((f) => owned.has(f) || f === c.integrity?.field);
      if (bad.length) refuse(`${call.label} writes ${bad.join(", ")} of ${collection}, which only a machine's transitions or Canon's seal change.`);
      const data: Record<string, unknown> = { ...given, ...Object.fromEntries([...owned].map(([f, m]) => [f, manifest.machines![m].initial])) };
      if (c.owner && data[c.owner] === undefined && !system) data[c.owner] = access.userId;
      await checkData(collection, data);
      const owner = ownerOf(c, data);
      if (!(await scopeAdmits(c, owner, data))) refuse(`${call.label} would write a ${collection} doc you couldn't see.`);
      await insertModuleDoc(writeCtx(ctx), source, {
        orgId, moduleId, collection, key: `${parentKey}~${gen.toString(36)}~${offset + i}`, data, version: 1, ...(owner ? { ownerUserId: owner as Id<"users"> } : {}),
        parentKey, gen, ...slotsOf(collection, data, parentKey, gen), updatedAt: now,
      });
      await project(collection, `${parentKey}~${gen.toString(36)}~${offset + i}`);
      await attachFiles(collection, `${parentKey}~${gen.toString(36)}~${offset + i}`, data);
    }
    return docs.length;
  }

  async function dropGeneration(name: string, collection: string, parentKey: string, gen: number, max: number): Promise<number> {
    if (!isMutation(ctx)) return refuse("A call's writes run in a mutation.");
    const c = setFor(callOf(name), collection);
    const parent = await getRow(c.setOf!.parent, parentKey);
    if (parent && !(await readable(parent, true))) refuse("Retiring a set needs a parent doc you can change.");
    if (parent && liveGen(parent, collection) === gen) refuse(`${collection} generation ${gen} of ${parentKey} is live.`);
    const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection).eq("parentKey", parentKey).eq("gen", gen)).take(max);
    for (const r of rows) { rememberModuleRow(ctx, r); await deleteModuleDoc(writeCtx(ctx), source, r._id); await project(collection, r.key); }
    return rows.length;
  }

  /**
   * An agent's `propose` call (docs/modules.md, "Agents"): its writes as one patch plan, a row a reviewer reads per
   * write. The action ran them first in a dry apply that wrote nothing; approving applies them again as the approver.
   */
  async function proposeCall(name: string, args: Record<string, unknown>, intents: AppliedIntent[], summary: string): Promise<Proposed> {
    if (!isMutation(ctx)) return refuse("A proposal is written in a mutation.");
    const call = checkCall(name);
    if (!agent || call.agent !== "propose") return refuse(`${call.label} isn't proposed: run it.`);
    for (const intent of intents) {
      if (intent.op === "send") {
        const errors = outputProblems({ intents: [intent] });
        if (errors.length) refuse(`${call.label}: ${errors.join("; ")}`);
        if ("people" in intent.to) refuse("An agent cannot propose an unrendered mailbox send; propose its source edit separately.");
      }
      if (intent.op === "transition") mailboxCaller(manifest.machines?.[intent.machine]?.transitions[intent.name]?.effects);
      if (intent.op === "op") mailboxCaller(manifest.ops[intent.name]?.effects);
    }
    if (intents.some((i) => i.op === "replaceSet")) refuse(`${call.label} replaces a set, which an approval can't apply; an agent can't propose it.`);
    if (intents.some((i) => i.op === "propose")) refuse(`${call.label} proposes Canon record writes of its own; an agent can't propose it as a call.`);
    const rows: ProposalRow[] = intents.filter((i) => i.op !== "dirty" && i.op !== "notify").map((i) => ({
      collection: "collection" in i ? String(i.collection) : i.op === "transition" ? `${i.machine}.${i.name}` : i.op === "op" ? i.name : "",
      ...("key" in i && typeof i.key === "string" ? { key: i.key } : {}),
      action: i.op === "transition" ? `${i.machine}.${i.name}` : i.op === "op" ? i.name : i.op,
      before: null, after: "data" in i ? (i.data ?? null) : "args" in i ? (i.args ?? null) : null,
    }));
    return propose(ctx.db, { kind: "call", module: moduleId, call: name, args, intents }, rows.length ? rows : [{ collection: name, action: name, before: null, after: null }], summary);
  }

  async function apply(name: string, intents: AppliedIntent[], completionOf?: string) {
    if (!isMutation(ctx)) return refuse("A call's writes run in a mutation.");
    if (intents.length) notMigrating();
    const db = ctx.db;
    const call = checkCall(name, false, completionOf);
    const cause = `call ${name}`;
    const event = { verb: name, cause };
    let writes = 0;
    const proposed: Array<Id<"patchPlans">> = [];
    const factProposals: FactProposalReceipt[] = [];
    const retired: Retired[] = [];
    const count = () => { if (++writes > CALL_WRITES_MAX) refuse(`${call.label} returned more than ${CALL_WRITES_MAX} writes.`); };
    const visible = async (collection: string, key: string) => {
      const row = await getRow(collection, key);
      return row && (await readable(row, true)) ? row : refuse(`${call.label}: ${collection} has no ${key} you can see.`);
    };
    const requireOn = async (p: Predicate | undefined, row: Row) => {
      if (p && !(await holds(p, subjectOf(row), envFor(subjectOf(row), {}, Date.now())))) refuse(`${call.label}: ${row.collection} ${row.key} isn't as the call requires; it changed since the call read it. Run it again.`);
    };
    const noMachineFields = (collection: string, fields: string[]) => {
      const owned = machineFields(manifest, collection);
      const bad = fields.filter((f) => owned.has(f));
      if (bad.length) refuse(`${call.label} writes ${bad.join(", ")} of ${collection}, which only a machine's transitions change.`);
      const seal = collectionOf(collection).integrity?.field;
      if (seal && fields.includes(seal)) refuse(`${call.label} writes ${seal} of ${collection}, its integrity seal, which only Canon writes.`);
    };
    const save = async (c: CollectionDecl, row: Row, data: Record<string, unknown>, fields: string[]) => {
      await checkData(row.collection, data, row.data);
      const owner = ownerOf(c, data);
      if (!(await scopeAdmits(c, owner, data))) refuse(`${call.label} would leave ${row.collection} ${row.key} where you couldn't see it.`);
      const version = row.version + 1;
      const previousData = row.data;
      await patchModuleDoc(writeCtx(ctx), source, row._id, { data, version, ownerUserId: owner ? (owner as Id<"users">) : undefined, ...slotsOf(row.collection, data, row.parentKey, row.gen ?? 0), updatedAt: Date.now() });
      await project(row.collection, row.key, { before: previousData, after: data });
      await attachFiles(row.collection, row.key, data);
      await audit(db, row.collection, row.key, { ...event, kind: "update", fields, fromVersion: row.version, toVersion: version });
    };

    for (const intent of intents) {
      if (intent.op !== "send") continue;
      const errors = outputProblems({ intents: [intent] });
      if (errors.length) refuse(`${call.label}: ${errors.join("; ")}`);
      if (!("people" in intent.to)) continue;
      if (!mailboxPerson() || !intent.source) refuse("A mailbox send requires a real person's current source document.");
      const row = await visible(intent.source!.collection, intent.source!.key);
      if (row.version !== intent.source!.version) refuse("The mailbox email source changed since the call read it.");
      await requireOn(intent.require, row);
    }

    // Every version the call read, checked before anything is written: the writes were derived from that snapshot.
    const counts = new Map<string, number>();
    for (const x of intents.flatMap((i) => i.expectCount ?? [])) {
      const c = collectionOf(x.collection);
      if (c.max === undefined || c.setOf || !Number.isInteger(x.count) || x.count < 0 || x.count > c.max) refuse("Snapshot counts require a capped top-level collection.");
      if (counts.has(x.collection) && counts.get(x.collection) !== x.count) refuse("Conflicting snapshot counts.");
      if (counts.has(x.collection)) continue;
      const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", x.collection)).take(c.max! + 1);
      if (rows.length !== x.count) refuse(`${call.label}: definitions changed since this snapshot. Reload and try again.`);
      counts.set(x.collection, x.count);
    }
    const expected = new Map<string, Expect>();
    for (const x of intents.flatMap((i) => i.expect ?? [])) {
      const id = `${x.collection}/${x.key}`;
      if (expected.has(id)) { if (expected.get(id)!.version !== x.version) refuse(`${call.label} expects two versions of ${id}.`); continue; }
      expected.set(id, x);
      collectionOf(x.collection);
      const row = await getRow(x.collection, x.key);
      const version = row && (await readable(row)) ? row.version : null;
      if (version !== x.version) refuse(`${call.label}: ${x.collection} ${x.key} changed since the call read it (it read ${x.version === null ? "no doc" : `version ${x.version}`}, it is ${version === null ? "gone" : `version ${version}`}). Run it again.`);
    }

    for (const it of intents) {
      switch (it.op) {
        case "put": {
          const c = writable(call, it.collection);
          noMachineFields(it.collection, Object.keys(it.data));
          const key = it.key ?? (c.key === "auto" ? undefined : c.key.from.map((f) => String(it.data[f])).join("|"));
          const row = key === undefined ? null : await getRow(it.collection, key);
          if (row) {
            if (!(await readable(row, true))) refuse(`${call.label}: ${it.collection} has no ${key} you can see.`);
            await requireOn(it.require, row);
            if (it.ifAbsent) break;
            if (c.key !== "auto" && c.key.from.map((f) => String(it.data[f])).join("|") !== row.key) refuse(`${call.label} can't change ${it.collection} ${row.key}'s key fields.`);
            const kept = Object.fromEntries([...machineFields(manifest, it.collection).keys(), ...(c.owner && it.data[c.owner] === undefined ? [c.owner] : []), ...(c.integrity ? [c.integrity.field] : [])].filter((f) => row.data[f] !== undefined).map((f) => [f, row.data[f]]));
            await save(c, row, { ...it.data, ...kept }, Object.keys(it.data));
          } else {
            if (it.require) refuse(`${call.label}: ${it.collection} ${key} doesn't exist, and the write requires it.`);
            let gen = 0;
            if (c.setOf) gen = liveGen((await readableParent(c, it.parentKey, true)) ?? refuse(`${call.label} puts a ${it.collection} doc under a ${c.setOf.parent} you can't see.`), it.collection);
            else if (it.parentKey !== undefined) refuse(`${it.collection} docs belong to no parent.`);
            const made = await insertDoc(db, it.collection, it.data, it.parentKey, gen, event, false, it.key);
            if (!(await scopeAdmits(c, made.owner, made.data))) refuse(`${call.label} would write a ${it.collection} doc you couldn't see.`);
          }
          count();
          break;
        }
        case "patch": {
          const c = writable(call, it.collection);
          const touched = [...Object.keys(it.data), ...(it.unset ?? [])];
          noMachineFields(it.collection, touched);
          if (c.key !== "auto" && touched.some((f) => (c.key as { from: readonly string[] }).from.includes(f))) refuse(`${call.label} can't change ${it.collection}'s key fields.`);
          const row = await visible(it.collection, it.key);
          await requireOn(it.require, row);
          const data = { ...row.data, ...it.data };
          for (const f of it.unset ?? []) { if (!c.schema.value[f]?.optional) refuse(`${f} is required, so ${call.label} can't remove it.`); delete data[f]; }
          await save(c, row, data, touched);
          count();
          break;
        }
        case "delete": {
          writable(call, it.collection);
          if (pending && !pending.manifest.collections[it.collection]) refuse(`${manifest.title} is upgrading to v${pending.version}, which removes ${it.collection}: it doesn't change until the upgrade is done.`);
          if (it.ifPresent && !(await getRow(it.collection, it.key))) break;
          const row = await visible(it.collection, it.key);
          await requireOn(it.require, row);
          for (const [child] of Object.entries(manifest.collections).filter(([, x]) => x.setOf?.parent === it.collection)) {
            const rows = await db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", child).eq("parentKey", row.key)).take(CHILDREN_MAX + 1);
            if (rows.length > CHILDREN_MAX) refuse(`${row.key} has more than ${CHILDREN_MAX} ${child} docs; ${call.label} can't delete it.`);
            for (const r of rows) { rememberModuleRow(ctx, r); await deleteModuleDoc(writeCtx(ctx), source, r._id); await project(child, r.key, { before: r.data, after: null }); }
          }
          await deleteModuleDoc(writeCtx(ctx), source, row._id);
          await project(it.collection, row.key, { before: row.data, after: null });
          await audit(db, it.collection, row.key, { ...event, kind: "delete", fields: [], fromVersion: row.version });
          count();
          break;
        }
        case "replaceSet": {
          const c = setFor(call, it.collection);
          const parent = (await readableParent(c, it.parentKey, true)) ?? refuse(`${call.label} replaces the ${it.collection} of a ${c.setOf!.parent} you can't see.`);
          await requireOn(it.require, parent);
          const from = liveGen(parent, it.collection);
          if (it.gen === from) refuse(`${call.label} replaces ${it.collection} with the generation it already has.`);
          // The new generation, staged by the action, becomes the live one in this write: readers see the old set or the new.
          const version = parent.version + 1;
          await patchModuleDoc(writeCtx(ctx), source, parent._id, { gens: { ...(parent.gens ?? {}), [it.collection]: it.gen }, version, updatedAt: Date.now() });
          await project(parent.collection, parent.key);
          await providedCollectionsReset(ctx as MutationCtx, orgId, [manifest], it.collection);
          await audit(db, parent.collection, parent.key, { ...event, kind: "update", fields: [it.collection], fromVersion: parent.version, toVersion: version, args: { replaced: it.collection, docs: it.count } });
          retired.push({ collection: it.collection, parentKey: it.parentKey, gen: from });
          count();
          break;
        }
        case "transition": {
          const mc = machineOf(it.machine);
          writable(call, mc.collection);
          const row = await visible(mc.collection, it.key);
          await requireOn(it.require, row);
          // As the caller: the transition's roles, guards and its own agent mode, so a call never reaches past them.
          const out = await transition(it.machine, it.name, { key: it.key, expect: row.version, args: it.args, reason: it.reason });
          if ("proposed" in out) proposed.push(out.proposed);
          count();
          break;
        }
        case "op": {
          // A declared op as the caller: its roles, agent mode and guards, as if they ran it themselves.
          writable(call, opOf(it.name).collection);
          if (it.require && it.key !== undefined) await requireOn(it.require, await visible(opOf(it.name).collection, it.key));
          const out = await op(it.name, { key: it.key, parentKey: it.parentKey, data: it.data, unset: it.unset }, undefined, call.ai?.output.op === it.name ? call : undefined);
          if ("proposed" in out) proposed.push(out.proposed);
          count();
          break;
        }
        case "event": {
          writable(call, it.collection);
          await visible(it.collection, it.key);
          markModuleSemanticWriteAttempt(ctx);
          await audit(db, it.collection, it.key, { ...event, kind: "event", fields: [], reason: it.note.slice(0, 500) });
          break;
        }
        case "dirty": {
          // Dependencies: what a job wrote makes another key stale (a rep's next period). Only Canon's own runs say so.
          if (!system) refuse(`${call.label} can't mark job keys: only Canon's own calls (jobs, watches, schedules) do.`);
          markModuleSemanticWriteAttempt(ctx);
          await dirtyKeyOf(it.job, it.key);
          break;
        }
        case "propose": {
          // The stamp is checked the same way whichever way the proposal goes: a text field the call writes, never a
          // machine's field or a seal, on a doc that exists before the proposal does (an earlier intent's put).
          const stampOf = async (st: { collection: string; key: string; field: string }) => {
            const c = writable(call, st.collection);
            const spec = c.schema.value[st.field];
            if (!spec || coreOf(spec.fieldType).type !== "string") refuse(`${call.label} stamps ${st.collection}.${st.field}, which isn't a text field.`);
            noMachineFields(st.collection, [st.field]);
            if (!(await getRow(st.collection, st.key))) refuse(`${call.label} stamps ${st.collection} ${st.key}, which doesn't exist yet: put it in an intent before the propose.`);
            await visible(st.collection, st.key);
            return async (value: string) => { const row = await visible(st.collection, st.key); await save(c, row, { ...row.data, [st.field]: value }, [st.field]); };
          };
          if (it.operation === FACTS_PROPOSE) {
            // Facts for a member with facts.review to decide on the fact review queue (docs/modules.md, "Proposing
            // facts"), as the member who ran the call. No grant covers them, so Canon's own calls can't propose them.
            if (system) refuse(`${call.label} can't propose facts: a fact proposal is a person's, and Canon's own calls have none.`);
            const problem = factsProposeProblem(it.args, manifest.facts);
            if (problem) refuse(`${call.label}: ${problem}.`);
            if (it.outcome || it.optional) refuse(`${call.label}: a fact proposal takes no outcome or optional; read its facts back with facts.forRecords or proposals.byIds.`);
            const stamp = it.stamp ? await stampOf(it.stamp) : null;
            markModuleSemanticWriteAttempt(ctx);
            const receipt = await proposeModuleFacts(ctx as MutationCtx, {
              orgId, userId: (actor as { userId: Id<"users"> }).userId, module: { id: moduleId, title: manifest.title },
              args: it.args as FactsProposeArgs, reason: it.reason, admitted: it.admitted ?? [],
            });
            proposed.push(receipt.id);
            factProposals.push(receipt);
            if (stamp) await stamp(receipt.id);
            count();
            break;
          }
          // A write to Canon's own records, held for a person (docs/modules.md, "Writes to Canon records"): a patch plan
          // whose rows the call's action listed as the caller reads them. Never applied here, whoever runs the call.
          // Canon's own calls (jobs, schedules) propose only under an admin's standing grant that covers every row
          // ("Standing grants"): approved as that admin and applied after.
          if (!manifest.proposes?.includes(it.operation as ProposalOperation)) refuse(`${call.label} proposes ${it.operation}, which ${manifest.title} doesn't declare in proposes.`);
          const problem = proposalArgsProblem(it.operation, it.args) ?? (it.outcome ? outcomeProblem(manifest, it.outcome) : null);
          if (problem) refuse(`${call.label}: ${problem}.`);
          const meeting = it.operation === "meetings.log";
          if (meeting && (system || agent || !it.stamp || it.optional)) refuse("Meetings require a person's approval-only proposal with a writable document stamp");
          // A grant covers Canon's own calls only: a person's or an agent's proposal always waits for a person.
          const grant = system && it.rows.length && isMutation(ctx) ? await grantCovering(db, orgId, moduleId, manifest, it.operation, it.rows, Date.now()) : null;
          if (system && !grant && !it.optional) refuse(`${call.label} can't propose: a proposal is a person's, and Canon's own calls propose only under an admin's standing grant that covers it.`);
          const principal = grant ? { userId: grant.createdBy } : actor as { userId: Id<"users"> };
          const stamp = it.stamp ? await stampOf(it.stamp) : null;
          let rows = it.rows;
          let proposedArgs = it.args;
          if (meeting) {
            const st = it.stamp!;
            const doc = await visible(st.collection, st.key);
            proposedArgs = canonicalMeetingArgs(it.args as MeetingLogArgs);
            rows = [await meetingProposalRow(ctx, orgId, access, proposedArgs as MeetingLogArgs)];
            if (doc.data[st.field] !== undefined && doc.data[st.field] !== null && doc.data[st.field] !== "") {
              if (typeof doc.data[st.field] !== "string") refuse("The meeting stamp must contain a proposal id");
              proposed.push(await stampedMeetingPlan(ctx, orgId, moduleId, doc.data[st.field] as string, proposedArgs as MeetingLogArgs, st));
              break;
            }
          }
          // An optional proposal with nothing to change makes no plan; its doc says "none" and its job still hears it.
          if (it.optional && (!it.rows.length || (system && !grant))) {
            if (stamp) await stamp("none");
            if (it.outcome) await dirtyKeyOf(it.outcome.job, it.outcome.key);
            count();
            break;
          }
          markModuleSemanticWriteAttempt(ctx);
          const planId = await insertRecordProposal(db, { orgId, userId: principal.userId, agent }, { id: moduleId, title: manifest.title },
            { operation: it.operation as ProposalOperation, args: proposedArgs, reason: it.reason, ...(meeting ? { stamp: it.stamp } : {}), ...(it.outcome ? { outcome: it.outcome } : {}) }, rows);
          proposed.push(planId);
          // The plan's id on a doc the call writes, so the module finds its proposal again (proposals.byIds).
          if (stamp) await stamp(planId);
          if (grant) await approveUnderModuleGrant(ctx as MutationCtx, grant, planId, (patchPlanId, grantId) => (ctx as MutationCtx).scheduler.runAfter(0, internal.moduleGrants.applyGranted, { patchPlanId, grantId }));
          count();
          break;
        }
        case "notify": {
          if (!system) refuse(`${call.label} can't notify members: only Canon's own calls (jobs, watches, schedules) do.`);
          const link = it.link === undefined ? undefined : `/dashboard/m/${moduleSlug(moduleId)}/${it.link}`;
          markModuleSemanticWriteAttempt(ctx);
          const sent = await notifyMembers(ctx as MutationCtx, orgId, it.to, { source: { kind: "module", moduleId }, message: it.message, ...(link ? { link } : {}), ...(it.subject ? { subject: it.subject } : {}), ...(it.badge ? { badge: it.badge } : {}) });
          if (it.email && sent) {
            if (!manifest.outbound?.email?.from.includes("workspace")) refuse(`${call.label} emails a notice, but ${manifest.title} declares no workspace email in outbound.`);
            const cause = `call:${name}:notify:${[it.subject ?? "", it.message, it.link ?? ""].join("|")}`.slice(0, 400);
            await emailNotices(db, await recipientsOf(it.to, null, NOTIFY_MAX, "A notification"), { subject: it.subject, message: it.message, link }, { collection: "", key: "", verb: name, cause, index: 0 });
          }
          break;
        }
        case "send": {
          if ("people" in it.to) {
            if (!it.from || !it.source) refuse("Mailbox intents require an explicit sender, current source and personal or automated kind.");
            const kind = mailboxKind(it.kind);
            const row = await visible(it.source!.collection, it.source!.key);
            if (row.version !== it.source!.version) refuse("The mailbox email source changed before preparation.");
            await requireOn(it.require, row);
            markModuleSemanticWriteAttempt(ctx);
            await send(db, { send: { template: it.template, to: { people: it.to.people }, from: { sender: it.from!.sender }, kind } }, { vars: {} },
              { collection: row.collection, key: row.key, verb: name, cause: `call:${name}:${it.key}`, index: 0 }, it.source);
          } else {
            markModuleSemanticWriteAttempt(ctx);
            await send(db, { send: { template: it.template, to: it.to, ...(it.kind ? { kind: it.kind } : {}) } }, { vars: it.vars ?? {} }, { collection: "", key: "", verb: name, cause: `call:${name}:${it.key}`, index: 0 });
          }
          break;
        }
      }
    }
    return { writes, proposed, retired, ...(factProposals.length ? { factProposals } : {}) };
  }

  async function bulkStep(m: BulkMove): Promise<BulkStep> {
    if (!isMutation(ctx) || !system) return refuse("A bulk move runs only as Canon, in a mutation.");
    notMigrating();
    const view = manifest.views[m.view];
    if (!view || view.kind !== "list") return refuse(`${manifest.title} has no list view ${m.view}.`);
    const pm = machineOf(m.parent.machine);
    const parent = await getRow(pm.collection, m.parent.key);
    // The doc that waited moved on (a person stopped the move): the move ends with it.
    if (m.parent.waitIn !== undefined && (!parent || parent.data[pm.field] !== m.parent.waitIn)) return { state: "done" };
    const field = machineOf(m.machine).field;
    const rows = (await scan(view, m.args, false, BULK_SCAN)).filter((r) => m.onlyFrom.includes(String(r.data[field])));
    const refused: Array<{ key: string; message: string }> = [];
    let moved = 0, count = 0;
    for (const row of rows) {
      if (moved >= BULK_BATCH) return { state: "more" };
      // Each doc is judged first, as its own move would be: one that refuses is named, and the others still move.
      let why: string | null = null;
      try { await move(ctx.db, m.machine, m.transition, row, {}, undefined, { writes: { n: 0 }, dryRun: true }); }
      catch (e) { if (!(e instanceof ConvexError)) throw e; why = String(e.data); }
      if (why !== null) { count++; if (refused.length < BULK_REFUSED_SHOWN) refused.push({ key: row.key, message: why }); continue; }
      await move(ctx.db, m.machine, m.transition, row, {}, undefined, { writes: { n: 0 }, cause: m.cause });
      moved++;
    }
    if (count) {
      // The doc stays where it waits, its history saying which docs held it there.
      if (parent) {
        const named = refused.slice(0, 3).map((r) => `${r.key} (${r.message})`).join("; ");
        await audit(ctx.db, pm.collection, parent.key, { verb: m.cause.split(" ")[0], kind: "event", fields: [], reason: `Stopped: ${count} ${count === 1 ? "doc" : "docs"} refused to move: ${named}${count > 3 ? "; …" : ""}`.slice(0, 500), cause: m.cause });
      }
      return { state: "stopped", refused, count };
    }
    // Every doc has moved: the doc that waited moves on.
    if (m.parent.then === undefined) return { state: "done" };
    if (parent) await transition(m.parent.machine, m.parent.then, { key: parent.key, expect: parent.version, reason: `${m.cause}: moved every doc` });
    return { state: "done" };
  }

  /** Bulk moves that start on a doc of `machine`: each transition with a bulk effect, by name. */
  const bulkTransitions = (machine: string) => Object.entries(machineOf(machine).transitions).filter(([, t]) => t.effects?.some((fx) => "bulk" in fx && fx.bulk));
  async function bulks(machine: string, key: string): Promise<BulkInfo[] | null> {
    await titlesReady();
    const mc = machineOf(machine);
    const row = await getRow(mc.collection, key);
    if (!row || !(await readable(row))) return null;
    const out: BulkInfo[] = [];
    for (const [tn, t] of bulkTransitions(machine)) {
      const job = await bulkRow(ctx.db, orgId, moduleId, bulkKey(machine, tn, key));
      if (!job) continue;
      const m = job.payload as BulkMove | undefined;
      const titled: BulkInfo["refused"] = [];
      for (const r of m?.stopped?.refused ?? []) {
        const doc = m ? await getRow(machineOf(m.machine).collection, r.key) : null;
        if (doc && (await readable(doc))) titled.push({ key: r.key, title: namedBy(doc), message: r.message });
      }
      const may = !system && !access.preview && admission(t) === null && !(agent && agentModeOf(manifest, machine, tn).mode !== "allowed");
      // Errors and refusals can quote the module's data: they show to those who see the docs they name.
      out.push({ via: tn, label: t.label, state: job.stopped ? "stopped" : "moving", refused: titled, count: m?.stopped?.count ?? 0, error: job.stopped && !m?.stopped ? (role === "admin" ? job.error : "") : null, canRetry: job.stopped && may });
    }
    return out;
  }

  async function retryBulk(machine: string, via: string, key: string): Promise<{ retried: true }> {
    if (!isMutation(ctx)) return refuse("A bulk move is retried in a mutation.");
    notMigrating();
    const t = transitionOf(machine, via);
    checkTransitionCaller(machine, via);
    if (agent && agentModeOf(manifest, machine, via).mode !== "allowed") refuse(`An agent can't retry ${lower(t.label)}: a person does.`);
    const row = await getRow(machineOf(machine).collection, key);
    if (!row || !(await readable(row, true))) return refuse(`${machineOf(machine).collection} has no ${key} you can see.`);
    const job = await bulkRow(ctx.db, orgId, moduleId, bulkKey(machine, via, key));
    if (!job?.stopped) return refuse(`${t.label} isn't stopped on ${key}: there is nothing to retry.`);
    const { stopped: _stopped, ...move } = job.payload as BulkMove;
    await markDirty(ctx, orgId, moduleId, manifest, BULK_JOB, bulkKey(machine, via, key), move);
    await audit(ctx.db, row.collection, key, { verb: `${machine}.${via}`, kind: "event", fields: [], reason: "Retried the docs that refused to move" });
    return { retried: true };
  }

  async function failingRows(collection: string, list: readonly ModuleDoc[], when: Predicate) {
    await titlesReady();
    const out: Array<{ key: string; title: string }> = [];
    const now = Date.now();
    for (const d of list) {
      const subject: Subject = { key: d.key, data: d.data, owner: d.owner, parentKey: d.parentKey, collection };
      if (!(await holds(when, subject, envFor(subject, {}, now)))) {
        const row = await getRow(collection, d.key);
        out.push({ key: d.key, title: row ? namedBy(row) : d.key });
      }
    }
    return out;
  }

  async function timedDue(now: number, max: number) {
    if (!system) return refuse("Timed transitions run only as Canon.");
    const out: Array<{ machine: string; name: string; key: string; version: number }> = [];
    // Due again once the upgrade releases writes.
    if (migrating) return out;
    for (const [mn, mc] of Object.entries(manifest.machines ?? {})) {
      const c = collectionOf(mc.collection);
      for (const [tn, t] of Object.entries(mc.transitions)) {
        if (t.at === undefined || c.setOf) continue;
        const ix = Object.entries(c.indexes).find(([, f]) => f[0] === mc.field && f[1] === t.at);
        if (!ix) continue;
        const i = slotIndex(mc.collection, ix[0]);
        // A time in ms, or a date: due once it is now or past. The lower bound leaves out docs without one.
        const ms = c.schema.value[t.at]?.fieldType.type === "number";
        const [low, high] = ms ? [0, now] : ["", new Date(now).toISOString().slice(0, 10)];
        for (const from of t.from) {
          const rows = await docs().withIndex(slotIndexName(i), (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", mc.collection).eq(`s${i}a`, from).gte(`s${i}b`, low).lte(`s${i}b`, high)).order("asc").take(max - out.length);
          for (const r of rows) out.push({ machine: mn, name: tn, key: r.key, version: r.version });
          if (out.length >= max) return out;
        }
      }
    }
    return out;
  }

  async function pageRows(name: string, args: Record<string, unknown>, limit: number) {
    const v = manifest.views[name] ?? refuse(`${manifest.title} has no view ${name}.`);
    if (v.kind !== "list") return refuse(`${name} reads one doc, not a list.`);
    checkArgs(name, v, args);
    const rows = await scan(v, args, true, limit + 1, Math.max(PAGE_SCAN_MAX, limit + 1));
    return { docs: rows.slice(0, limit).map(toDoc), complete: rows.complete !== false && rows.length <= limit };
  }

  async function canonRows(read: CanonRead, args: Record<string, unknown>, limit: number): Promise<ModuleDoc[]> {
    if (system || !pageReadable(read, manifest) || !manifest.reads?.[CANON_READS[read].object]) return refuse(`${manifest.title} can't read ${read} on a page.`);
    const rows = await canonRead(ctx, orgId, access, manifest, read, args, limit);
    return rows.map((row) => {
      const { id, createdAt, ...data }: Record<string, unknown> = row;
      return { key: String(id), version: 0, data: { id, ...data }, owner: null, parentKey: null, createdAt: createdAt as number, updatedAt: createdAt as number };
    });
  }

  async function exportRows(name: string, args: Record<string, unknown>, max: number) {
    const v = manifest.views[name] ?? refuse(`${manifest.title} has no view ${name}.`);
    if (v.kind !== "list") return refuse(`${name} reads one doc, not a list.`);
    checkArgs(name, v, args);
    const rows = await scan(v, args, true, max + 1, Math.max(READ_SCAN_MAX, max + 1));
    if (rows.length > max || rows.complete === false) refuse(`This export has more than ${max} rows for you (or more than ${READ_SCAN_MAX} to look through). Narrow it first.`);
    return rows.map(toDoc);
  }

  async function verify(collection: string, key: string): Promise<Verified | null> {
    const c = collectionOf(collection);
    if (!c.integrity) return null;
    const row = await getRow(collection, key);
    if (!row || !(await readable(row))) return null;
    const seal = row.data[c.integrity.field];
    if (typeof seal !== "string") return { state: "unsealed", seal: null };
    return { state: seal === (await sealFor(row, row.data)) ? "intact" : "changed", seal };
  }

  // ── Reports (docs/modules.md, "Reports and charts") ──

  /** A row condition with every ref naming its collection, as the record service reads it; a ref to no collection never holds. */
  const reportWhere = (collection: string, w: RowWhere): ModuleWhere => {
    if ("all" in w) return { all: w.all.map((x) => reportWhere(collection, x)) };
    if (!("ref" in w)) return w;
    const spec = manifest.collections[collection]?.schema.value[w.ref];
    const t = spec ? (spec.fieldType.type === "union" ? spec.fieldType.value.find((x) => x.type === "ref") : spec.fieldType) : undefined;
    const target = w.collection ?? (t?.type === "ref" && t.to === "doc" ? t.collection : undefined);
    if (!target || !manifest.collections[target]) return { ref: w.ref, collection: "#none", where: w.where as ModuleWhere };
    return { ref: w.ref, collection: target, where: reportWhere(target, w.where) };
  };
  /** The caller's read scope on a collection as the record service applies it (scopeAdmits and readable, as data). */
  const docScopeOf = (collection: string): ModuleDocScope | "none" => {
    const c = collectionOf(collection);
    if (!system && c.retainedEvidence) return refuse("Retained evidence collections do not support aggregate reads.");
    let own: Pick<ModuleDocScope, "owners" | "where"> = { owners: null, where: null };
    if (!system && !(c.setOf && !Object.keys(c.access).length)) {
      const scope = normalizedReadScope(c);
      const base = typeof scope === "string" ? scope : scope.scope ?? "none";
      const unrestricted = scope === "all" || (typeof scope === "object" && "members" in scope && scope.scope === "all");
      if (!unrestricted && ((typeof scope === "object" && "members" in scope) || memberSets(collection).length)) return refuse(`${collection} grants member reads which reports can't apply yet.`);
      if (base === "none") return "none";
      // The manifest refuses `or` on a collection with a report: the record service applies owners and where together.
      if (typeof scope === "object" && "or" in scope) return refuse(`${collection} widens a role's reads with or, which a report can't apply yet.`);
      own = {
        owners: base === "own" ? [access.userId] : isGroup(base) ? [...groupOwners(base)] : null,
        where: typeof scope === "string" || "members" in scope ? null : reportWhere(collection, scope.where),
      };
    }
    if (!c.setOf) return { ...own, setOf: null };
    const parent = docScopeOf(c.setOf.parent);
    return parent === "none" ? "none" : { ...own, setOf: { parent: c.setOf.parent, scope: parent } };
  };
  function activityPlan(collection: string): ModuleDocScope | "none" {
    const declaration = collectionOf(collection).activity;
    if (!declaration) return refuse(`${manifest.title} has no activities in ${collection}.`);
    const page = manifest.pages.find((p) => p.path === declaration.path);
    if (!system && page?.roles && !page.roles.includes(role)) return "none";
    return docScopeOf(collection);
  }
  async function reportPlan(collection: string): Promise<ReportPlanOf> {
    // A Canon object the module reads through reads.records: its fields as the workspace defines it and the caller's role shows it.
    const object = recordObjectOf(manifest, collection);
    if (object) {
      if (system) refuse("A report over Canon's records reads as a person.");
      const plan = await recordSourcePlan(ctx, orgId, access, object);
      return "none" in plan ? { none: true, object, title: plan.title } : { fields: plan.fields, docScope: null, object, title: plan.title };
    }
    if (collection === "canon.stageHistory") {
      const fields = canonSourceFields(manifest, collection);
      if (!fields.length) refuse(`${manifest.title} has no report over ${collection}.`);
      if (system) refuse("A report over Canon's records reads as a person.");
      if (!permissionOf(access, "deal").read || fieldLevel(access, "deal", "stage") === "hidden") return { none: true };
      return { fields: fields.filter((f) => fieldLevel(access, "deal", f.name === "deal" ? "name" : f.name === "ownerId" ? "ownerId" : "stage") !== "hidden"), docScope: null };
    }
    if (isCanonSource(collection)) {
      // Canon's deals or members, as the caller reads them: a field their role hides is not offered (nor what it weighs).
      const fields = canonSourceFields(manifest, collection);
      if (!fields.length) refuse(`${manifest.title} has no report over ${collection}.`);
      if (system) refuse("A report over Canon's records reads as a person.");
      if (collection === "canon.deals" && !permissionOf(access, "deal").read) return { none: true as const };
      const shown = (f: string) => collection !== "canon.deals" || fieldLevel(access, "deal", f) !== "hidden";
      return { fields: fields.filter((f) => (f.name === WEIGHTED_AMOUNT ? shown("amount") && shown("probability") : shown(f.join?.via ?? (f.name === DEAL_ACCOUNT ? "companyId" : f.name)))), docScope: null };
    }
    const c = collectionOf(collection);
    if (!c.report) refuse(`${manifest.title} has no report over ${collection}.`);
    const docScope = docScopeOf(collection);
    if (docScope === "none") return { none: true as const };
    const all = docScope.owners === null && docScope.where === null && docScope.setOf === null;
    return { fields: reportFields(c, manifest), docScope: all ? null : docScope };
  }
  /** The members a report over Canon's members counts: those the caller's role-derived owner scope admits, as their deals. */
  async function memberRows(): Promise<Array<{ id: string; createdAt: number; data: Record<string, unknown> }>> {
    const fields = canonSourceFields(manifest, "canon.members");
    if (!fields.length || system) refuse(`${manifest.title} has no report over canon.members.`);
    return memberReportRows(ctx, orgId, manifest.reads?.users ?? [], ownerScope(access, "deal", true)?.owners ?? null);
  }
  async function reportDocs(collection: string, max: number): Promise<ModuleDoc[]> {
    if (!collectionOf(collection).report) refuse(`${manifest.title} has no report over ${collection}.`);
    const out: ModuleDoc[] = [];
    let seen = 0;
    for await (const row of docs().withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection)).order("asc")) {
      if (++seen > max) refuse(`${collection} has more than ${max} docs: run the record service to report on it.`);
      if (await readable(row)) out.push(toDoc(row));
    }
    return out;
  }
  async function activityDocs(collection: string, max: number): Promise<{ docs: ModuleDoc[]; scanned: number }> {
    if (!collectionOf(collection).activity) refuse(`${manifest.title} has no activities in ${collection}.`);
    const out: ModuleDoc[] = [];
    let scanned = 0;
    for await (const row of docs().withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection)).order("asc")) {
      if (++scanned > max) throw new ConvexError({ kind: "module_activity_limit", message: "Module activities exceed the live read scan budget." });
      if (await readable(row)) out.push(toDoc(row));
    }
    return { docs: out, scanned };
  }
  async function aggregateDocs(name: string, read: string, max: number): Promise<ModuleDoc[]> {
    const call = checkCall(name);
    const r = call.reads[read];
    if (!r || !("aggregate" in r)) return refuse(`${call.label} has no aggregate ${read}.`);
    const out: ModuleDoc[] = [];
    for await (const row of docs().withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", r.aggregate.collection)).order("asc")) {
      if (out.length >= max) refuse(`${r.aggregate.collection} has more than ${max} docs: run the record service to aggregate it.`);
      out.push(toDoc(row));
    }
    return out;
  }
  const projectRow = (row: Row): ModuleDocRow => ({
    collection: row.collection, key: row.key, parentKey: row.parentKey ?? null, gen: row.gen ?? null, gens: row.gens ?? null, owner: row.ownerUserId ?? null,
    data: row.data, version: row.version, createdAt: row.sourceCreatedAt ?? row._creationTime, updatedAt: row.updatedAt,
  });
  async function projectRows(keys: readonly string[]) {
    if (!system) refuse("Only Canon projects a module's docs.");
    return Promise.all(keys.map(async (k) => {
      const at = k.indexOf("|");
      const collection = k.slice(0, at), key = k.slice(at + 1);
      const row = manifest.collections[collection] ? await getRow(collection, key) : null;
      return { collection, key, row: row ? projectRow(row) : null };
    }));
  }
  async function projectPage(collection: string, after: string | null, max: number) {
    if (!system) refuse("Only Canon projects a module's docs.");
    const rows = await docs().withIndex("by_orgId_moduleId_collection_key", (q) => {
      const r = q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection);
      return after === null ? r : r.gt("key", after);
    }).order("asc").take(max + 1);
    return { rows: rows.slice(0, max).map(projectRow), more: rows.length > max };
  }

  /**
   * A joined deal's fields: the ones the install granted and its role doesn't hide, and its name. A CRM account's name
   * reads here as its `companyName`; a register company's is the record service's, which a query can't read, so the
   * join carries its id as `companyRef` and the page reads its name as the caller (module-page.tsx).
   */
  const grantedDeal = async (d: Doc<"deals">): Promise<Record<string, unknown>> => {
    const fields = (manifest.reads?.deals ?? []).filter((f) => system || fieldLevel(access, "deal", DEAL_API_NAME[f] ?? f) !== "hidden");
    const out: Record<string, unknown> = { id: d._id as string, name: d.name, ...dealFieldsOf(d, fields, access) };
    if (!fields.includes("companyName")) return out;
    if (d.companyId) return { ...out, companyName: null, companyRef: d.companyId };
    const account = d.accountId ? await ctx.db.get(d.accountId) : null;
    return { ...out, companyName: account && account.orgId === orgId ? account.name : null };
  };
  async function enrich(collection: string, list: ModuleDoc[], join: readonly string[], counts: Record<string, { view: string; by: string; of?: string; collect?: string }>) {
    const c = collectionOf(collection);
    const out: PageDoc[] = list.map((d) => ({ ...d }));
    for (const field of join) {
      const spec = c.schema.value[field];
      const core = spec ? (spec.fieldType.type === "union" ? spec.fieldType.value.find((x) => x.type === "ref") : spec.fieldType) : undefined;
      if (!core || core.type !== "ref") continue;
      const ref = core as RefValidator;
      const ids = [...new Set(out.map((d) => d.data[field]).filter((x): x is string => typeof x === "string"))].slice(0, JOIN_MAX);
      const found = new Map<string, Record<string, unknown> | null>();
      for (const id of ids) {
        let got: Record<string, unknown> | null = null;
        if (ref.to === "doc") {
          const tc = manifest.collections[ref.collection ?? ""];
          const row = tc ? await getRow(ref.collection!, id) : null;
          if (row && (await readable(row))) got = { key: row.key, ...row.data };
        } else if (ref.to === "deals") {
          const did = ctx.db.normalizeId("deals", id);
          const d = did ? await ctx.db.get(did) : null;
          if (d && d.orgId === orgId && dealSeen(d)) {
            const entity = await ctx.db.query("canonEntities").withIndex("by_orgId_projectionId", (q) => q.eq("orgId", orgId).eq("projectionId", d._id)).first();
            got = { ...(await grantedDeal(d)), ...(entity ? { recordId: entity._id as string } : {}) };
          }
        } else if (ref.to === "users") {
          const uid = ctx.db.normalizeId("users", id);
          const u = uid ? await ctx.db.get(uid) : null;
          if (u && (await userBelongsToOrg({ db: ctx.db } as QueryCtx, u, orgId))) got = { id: u._id as string, ...memberFieldsOf(u, ["name", ...(manifest.reads?.users ?? [])]) };
        } else if (ref.to === "senders") {
          const sender = manifest.reads?.senders ? await senders.byId(id) : null;
          if (sender) got = { id: sender.id, createdAt: sender.createdAt, ...senderFields(sender, manifest.reads?.senders ?? []) };
        } else if (isRecordRef(ref.to)) {
          // The record service's, which a query can't read: the page reads its granted fields as the caller (module-page.tsx).
          got = { id, recordRef: ref.to };
        } else {
          const tid = ctx.db.normalizeId("teamGroups", id);
          const t = tid ? await ctx.db.get(tid) : null;
          if (t && t.orgId === orgId) got = { id: t._id as string, name: t.name };
        }
        found.set(id, got);
      }
      for (const d of out) { const id = d.data[field]; (d.joined ??= {})[field] = typeof id === "string" ? found.get(id) ?? null : null; }
    }
    let countError: string | null = null;
    for (const [name, cd] of Object.entries(counts)) {
      const cv = manifest.views[cd.view];
      if (!cv || cv.kind !== "list") continue;
      const [argName, type] = Object.entries(cv.args ?? {})[0] ?? [];
      if (!argName) continue;
      const item = type === "number[]" ? "number" : "string";
      const valueOf = (d: ModuleDoc) => (cd.of === undefined ? d.key : d.data[cd.of]);
      const values = [...new Set(out.map(valueOf).filter((x) => typeof x === item))] as Scalar[];
      const tally = new Map<string, number>();
      // `collect`: each row's distinct values of that field among the docs counted, in place of their number.
      const kept = new Map<string, Array<string | number | boolean>>();
      let read = 0;
      for (let i = 0; i < values.length && countError === null; i += MAX_IN_VALUES) {
        const rows = await scan(cv, { [argName]: values.slice(i, i + MAX_IN_VALUES) }, true, COUNT_PAGE_MAX + 1 - read, PAGE_SCAN_MAX);
        read += rows.length;
        if (read > COUNT_PAGE_MAX || rows.complete === false) countError = `${name} counts more than ${COUNT_PAGE_MAX} docs for these rows; narrow the list.`;
        for (const r of rows) {
          const k = String(cd.by === "parentKey" ? r.parentKey : r.data[cd.by]);
          tally.set(k, (tally.get(k) ?? 0) + 1);
          const v = cd.collect ? r.data[cd.collect] : undefined;
          if ((typeof v === "string" || typeof v === "number" || typeof v === "boolean") && !(kept.get(k) ?? []).includes(v)) kept.set(k, [...(kept.get(k) ?? []), v]);
        }
      }
      if (countError !== null) break;
      for (const d of out) (d.counts ??= {})[name] = cd.collect ? kept.get(String(valueOf(d))) ?? [] : tally.get(String(valueOf(d))) ?? 0;
    }
    return { docs: out, countError };
  }

  async function joinedValues(ref: RefValidator, field: string, ids: readonly string[]): Promise<Record<string, Scalar>> {
    const out: Record<string, Scalar> = {};
    const scalar = (v: unknown): Scalar => (v === undefined || v === null || typeof v === "object" ? null : (v as Scalar));
    let teams: Array<Doc<"teamGroups">> | null = null;
    for (const id of ids.slice(0, 2000)) {
      let v: unknown = null;
      if (ref.to === "deals") {
        const did = ctx.db.normalizeId("deals", id);
        const d = did ? await ctx.db.get(did) : null;
        if (d && d.orgId === orgId && dealSeen(d)) v = (await grantedDeal(d))[field];
      } else if (ref.to === "users") {
        const uid = ctx.db.normalizeId("users", id);
        const u = uid ? await ctx.db.get(uid) : null;
        if (u && (await userBelongsToOrg({ db: ctx.db } as QueryCtx, u, orgId))) {
          if (field === "team") {
            teams ??= (await ctx.db.query("teamGroups").withIndex("by_orgId", (q) => q.eq("orgId", orgId)).take(PICK_SCAN)).sort((a, b) => a.name.localeCompare(b.name));
            v = teams.find((t) => t.managerId === u._id || t.memberIds.includes(u._id))?.name ?? null;
          } else v = memberFieldsOf(u, ["name", ...(manifest.reads?.users ?? [])])[field];
        }
      } else if (ref.to === "teams") {
        const tid = ctx.db.normalizeId("teamGroups", id);
        const t = tid ? await ctx.db.get(tid) : null;
        if (t && t.orgId === orgId) v = field === "name" ? t.name : field === "managerId" ? t.managerId ?? null : null;
      } else if (ref.to === "senders") {
        const sender = manifest.reads?.senders ? await senders.byId(id) : null;
        if (sender) v = field === "id" ? sender.id : field === "createdAt" ? sender.createdAt : senderFields(sender, manifest.reads?.senders ?? [])[field];
      } else if (isRecordRef(ref.to)) {
        // The record service's: a report reads it in its action (convex/modules.ts runReport); a form's placeholder shows none.
      } else {
        const row = manifest.collections[ref.collection ?? ""] ? await getRow(ref.collection!, id) : null;
        // A doc's field, or a field of an object it holds (`config.rate`).
        if (row && (await readable(row))) v = field.split(".").reduce<unknown>((x, k) => (x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>)[k] : undefined), row.data);
      }
      out[id] = scalar(v);
    }
    return out;
  }

  // ── Files (docs/modules.md, "Files") ──

  /** Whether the caller's role writes a file field: an op's, a transition's arguments or a call's. */
  const writesFiles = () => {
    const has = (o: ObjectValidator, names?: readonly string[]) => (names ?? Object.keys(o.value)).some((f) => o.value[f] && holdsFile(o.value[f].fieldType));
    return Object.values(manifest.ops).some((op) => admission(op) === null && has(collectionOf(op.collection).schema, op.fields))
      || Object.values(manifest.machines ?? {}).some((mc) => Object.values(mc.transitions).some((t) => admission(t) === null && t.args && has(t.args)))
      || Object.values(manifest.calls ?? {}).some((c) => admission(c) === null && c.args && has(c.args));
  };
  async function uploadUrl(): Promise<{ url: string }> {
    if (!isMutation(ctx)) return refuse("An upload starts in a mutation.");
    if (system) return refuse("Canon doesn't upload files.");
    if (access.preview) refuse("You are viewing as another member: changes are off until you exit the preview");
    if (agent) refuse(`An agent can't upload files to ${manifest.title}: a person attaches them in Canon.`);
    if (!writesFiles()) refuse(`Your role writes no file in ${manifest.title}.`);
    const site = process.env.CONVEX_SITE_URL ?? refuse("This deployment has no site URL to upload to.");
    // A ticket: whoever holds its secret uploads one file as this person, within the half hour.
    const secret = crypto.randomUUID();
    const ticket = await ctx.db.insert("moduleFiles", { orgId, moduleId, name: "", type: "", bytes: 0, uploadedBy: access.userId as Id<"users">, secret, at: Date.now() });
    return { url: `${site}/modules/upload?ticket=${encodeURIComponent(ticket)}&secret=${encodeURIComponent(secret)}` };
  }
  async function fileUrl(collection: string, key: string, file: string) {
    const c = collectionOf(collection);
    const row = await getRow(collection, key);
    if (!row || !(await readable(row)) || !filesIn(row.data, c.schema).some((f) => f.id === file)) return null;
    const f = await fileRow(file);
    const url = f?.storageId ? await ctx.storage.getUrl(f.storageId) : null;
    return f && url ? { name: f.name, type: f.type, bytes: f.bytes, url } : null;
  }
  async function shareDocs(share: ShareDecl, rootKey: string): Promise<Record<string, ModuleDoc[]>> {
    const root = await getRow(share.collection, rootKey);
    if (!root || !(await readable(root))) refuse("This shared doc is not yours to read.");
    const out: Record<string, ModuleDoc[]> = { [share.collection]: [toDoc(root!)] };
    for (const collection of Object.keys(share.read)) {
      if (collection === share.collection) continue;
      if (collectionOf(collection).setOf?.parent !== share.collection) refuse("A share reads only one level of sets.");
      const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_parentKey_gen_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection).eq("parentKey", rootKey).eq("gen", liveGen(root!, collection))).take(MAX_VIEW_LIMIT + 1);
      if (rows.length > MAX_VIEW_LIMIT) refuse(`A share reads at most ${MAX_VIEW_LIMIT} ${collection} docs.`);
      out[collection] = [];
      for (const row of rows) if (await readable(row)) out[collection].push(toDoc(row));
    }
    return out;
  }
  async function shareEvent(share: ShareDecl, key: string, verb: "share.issued" | "share.revoked" | "share.extended", publicId: string) {
    const row = await getRow(share.collection, key);
    if (!isMutation(ctx) || !row || !(await readable(row, true))) refuse("This shared doc is not yours to change.");
    await audit((ctx as MutationCtx).db, share.collection, key, { verb, kind: "event", fields: [], args: { publicId } });
  }

  async function fileInfo(ids: readonly string[]) {
    const out: Record<string, FileInfo> = {};
    for (const id of [...new Set(ids)].slice(0, LABELS_MAX)) { const f = await fileRow(id); if (f) out[id] = fileMetadata(f); }
    return out;
  }

  async function importDocs(name: string, docs: readonly ImportDoc[]): Promise<void> {
    if (!system || !isMutation(ctx) || !importsOf(manifest).some((entry) => entry.name === name)) refuse("Only Canon runs a declared import.");
    await importRows(name, docs);
  }
  async function copyCutover(name: string, docs: readonly ImportDoc[]): Promise<void> {
    const owner = await interfaceOwner(ctx, orgId);
    if (!system || !isMutation(ctx) || name !== ICPS_CUTOVER || moduleId !== ICPS_MODULE || owner?.packageId !== pkg._id || owner.cutover !== name || pkg.pending) refuse("Only the trusted atomic cutover copies owned definitions.");
    await importRows(name, docs);
  }
  async function importRows(name: string, docs: readonly ImportDoc[]): Promise<void> {
    notMigrating();
    for (const d of docs) {
      moduleWritable(manifest, d.collection);
      const c = collectionOf(d.collection);
      let gen = 0;
      let qualifiedSetImport = false;
      if (c.setOf) {
        const parent = await readableParent(c, d.parentKey);
        if (!parent) refuse(`${d.collection} needs an existing ${c.setOf.parent} parent.`);
        gen = liveGen(parent!, d.collection);
        if (c.key !== "auto") {
          const derived = c.key.from.map((f) => String(d.data[f])).join("|");
          qualifiedSetImport = d.key === importSetKey(d.parentKey!, derived);
          if (!qualifiedSetImport && d.key !== derived) refuse(`${d.collection}'s import key must be its derived key or its parent-qualified form.`);
          const existingDerivedCopy = await getRow(d.collection, derived);
          if (existingDerivedCopy && existingDerivedCopy.parentKey === d.parentKey && (existingDerivedCopy.gen ?? 0) === gen) continue;
        }
      } else if (d.parentKey !== undefined) refuse(`${d.collection} docs belong to no parent.`);
      const existing = await getRow(d.collection, d.key);
      if (existing) {
        if (c.setOf && existing.parentKey !== d.parentKey) refuse(`${d.collection}'s import key belongs to another parent.`);
        continue;
      }
      await insertDoc((ctx as MutationCtx).db, d.collection, d.data, d.parentKey, gen, { verb: `import ${name}` }, false, d.key, false, qualifiedSetImport, d.createdAt);
    }
  }

  const completionOf = (name: string) => {
    const call = manifest.calls?.[name];
    if (call?.step) return { name, arg: call.step.key };
    const ai = call?.ai;
    const key = ai?.output.key;
    if (!ai?.queue?.next || !key || typeof key !== "object" || !("arg" in key)) return refuse("This call declares no initiating-member completion.");
    return { name: ai.queue.next, arg: key.arg };
  };
  const completionSnapshot = (name: string, key: string) => {
    const next = completionOf(name);
    return snapshot(next.name, { [next.arg]: key }, false, name);
  };
  const complete = (name: string, intents: AppliedIntent[]) => apply(completionOf(name).name, intents, name);

  const captured = <A extends unknown[], T>(fn: (...args: A) => Promise<T>) => (...args: A) => withModulePublication(writeCtx(ctx), () => fn(...args));
  const memberCaptured = <A extends unknown[], T>(fn: (...args: A) => Promise<T>) => (...args: A) => withModulePublication(writeCtx(ctx), async () => {
    const ordinary = source;
    if (principal.kind === "user" && principal.session && pkg.pending && pkg.activityPublication) source = ordinaryBackfillSource(pkg, enabled);
    try { return await fn(...args); }
    finally { source = ordinary; }
  });
  const scope: ModuleScope = {
    orgId, moduleId, slug: moduleSlug(moduleId), manifest, epoch, revision, userId: system ? null : access.userId, preview: access.preview?.asName ?? null, role, agent, system, migrating, admission, importDocs: captured(importDocs), copyCutover: captured(copyCutover),
    // Which of Canon's call records the caller reads (lib/modules/transcripts.ts): a system scope reads every one.
    callSeen: system ? async () => true : callReader(ctx, orgId, access).callSeen,
    sequenceVariables,
    shareDocs, shareEvent, view, op: memberCaptured(op), transition: memberCaptured(transition), events, visited, blocked, sendPreview, opBlocked, peek, authorizeCanonCall, canonInput, finishCanonCall: captured(finishCanonCall), snapshot, completionSnapshot, complete: captured(complete), provide, peopleQuery, systemSetValues, stage: captured(stage), apply: memberCaptured(apply), proposeCall, dropGeneration: captured(dropGeneration), bulkStep: captured(bulkStep), bulks, retryBulk, failingRows, timedDue, pick, suggest, refLabels,
    unadmitted: () => [...unadmitted.values()],
    dirty: dirtyKeyOf, pageRows, canonRows, enrich, exportRows, verify, reportPlan, activityPlan, reportDocs, activityDocs, memberRows, aggregateDocs, projectRows, projectPage, uploadUrl, fileUrl, fileInfo, joinedValues,
  };
  associateModuleSource(scope, source);
  return scope;
}
// ── Upgrades: a newer version's backfill (docs/modules.md, "Upgrades") ──

/** Whether a module has any doc in `collection` in the workspace: an upgrade that drops it needs a person's yes. */
export async function hasDocs(ctx: QueryCtx, orgId: Id<"organizations">, moduleId: string, collection: string): Promise<boolean> {
  return (await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId).eq("collection", collection)).first()) !== null;
}

/**
 * One batch of a pending upgrade's backfill: up to `batch` docs of its current work item rewritten (the new
 * version's slots filled, the doc checked against its schema) or deleted, its place saved. A doc that doesn't fit
 * stops the upgrade with the reason; the installed version keeps serving. "migrate": the work item is a migration,
 * which runs in the recipe runtime (migrationBatch, then applyMigration). When the last item is done the new version
 * serves, after a cutover (cutoverBatch) when its docs were migrated.
 */
export async function upgradeBatch(ctx: MutationCtx, pkg: Doc<"modulePackages">, batch: number): Promise<"more" | "done" | "failed" | "migrate"> {
  return withModulePublication(ctx, async () => {
    await assertSq1PackageUpgrade(ctx, pkg.orgId, pkg.moduleId);
    const p = pkg.pending;
    if (!p || p.error) return "failed";
    const source = await continuationSource(ctx, pkg);
    if (p.phase === "cutover") return cutoverBatch(ctx, pkg, batch);
    const next = (await pendingManifestOf(ctx, pkg))!;
    const item = p.work[p.step];
    if (item?.mode === "migrate") return "migrate";
    if (item) {
      const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => {
        const r = q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("collection", item.collection);
        return p.cursor === undefined ? r : r.gt("key", p.cursor);
      }).take(batch);
      const nc = next.collections[item.collection];
      for (const row of rows) {
        rememberModuleRow(ctx, row);
        if (item.mode === "drop") {
          await deleteModuleDoc(writeCtx(ctx), source, row._id);
          await providedCollectionChanged(ctx, pkg.orgId, manifestOf(pkg), item.collection, row.data, null);
          continue;
        }
        const held = upgradeHeldRefs(manifestOf(pkg).collections[row.collection].schema, row.data);
        const problems = await fitProblems(nc.schema, row.data, upgradeResolver(ctx, pkg, held), new Map(), upgradeFiles(ctx, pkg));
        if (problems.length) {
          await capturePackageState(ctx, source, () => ctx.db.patch(pkg._id, { pending: { ...p, error: `${item.collection} ${row.key} doesn't fit v${p.version}: ${problems.slice(0, 3).join("; ")}. Fix the doc, or cancel the upgrade.` } }));
          return "failed";
        }
        // An owner field added by this version is stored per doc here (modules/kernel/upgrade.ts).
        const ownerUserId = nc.owner && typeof row.data[nc.owner] === "string" ? (row.data[nc.owner] as Id<"users">) : undefined;
        const columns = { ...slotColumns(nc, p.slots[item.collection] ?? {}, row.data, row.parentKey, row.gen ?? 0), ownerUserId };
        if (Object.entries(columns).some(([k, v]) => (row as Record<string, unknown>)[k] !== v)) await patchModuleDoc(writeCtx(ctx), source, row._id, columns, TRUSTED_MAINTENANCE);
      }
      const finished = rows.length < batch;
      await capturePackageState(ctx, source, () => ctx.db.patch(pkg._id, { pending: { ...p, step: finished ? p.step + 1 : p.step, cursor: finished ? undefined : rows[rows.length - 1].key, done: p.done + rows.length } }));
      if (!finished || p.step + 1 < p.work.length) return "more";
    }
    if (migrates(p.work)) {
      // Every doc is migrated into `next`: the cutover swaps them in, from the first staged collection.
      await capturePackageState(ctx, source, () => ctx.db.patch(pkg._id, { pending: { ...p, phase: "cutover", step: 0, cursor: undefined } }));
      return "more";
    }
    await activate(ctx, pkg);
    return "done";
  });
}

/**
 * A ref checked as Canon during an upgrade: what it names exists in the workspace (whoever wrote it could see it then).
 * A company or person ref passes only if this row already held it. A migration cannot admit new record refs.
 */
function upgradeResolver(ctx: QueryCtx, pkg: Doc<"modulePackages">, held: ReadonlySet<string>): RefResolver {
  const docExists = async (collection: string, key: string) => !!(await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("collection", collection).eq("key", key)).unique());
  const recordHeld = (ref: RefValidator, id: string) => held.has(refKey(ref, id));
  const resolve = refResolver(ctx.db, pkg.orgId, docExists, null, recordHeld);
  return (ref, id) => ref.to === "senders" ? Promise.resolve(recordHeld(ref, id)) : resolve(ref, id);
}

/** A file checked as Canon during an upgrade: one of the module's files in the workspace. */
function upgradeFiles(ctx: QueryCtx, pkg: Doc<"modulePackages">): FileResolver {
  return async (id) => {
    const fid = ctx.db.normalizeId("moduleFiles", id);
    const row = fid ? await ctx.db.get(fid) : null;
    return row && row.orgId === pkg.orgId && row.moduleId === pkg.moduleId ? { name: row.name, type: row.type, bytes: row.bytes } : { refused: "isn't a file of this module" };
  };
}

/** The pending version serves from now on. */
async function activate(ctx: MutationCtx, pkg: Doc<"modulePackages">) {
  const source = await continuationSource(ctx, (await ctx.db.get(pkg._id))!);
  const p = pkg.pending!;
  const text = await pendingManifestText(ctx, pkg);
  if (text === null) throw new ConvexError(`v${p.version}'s manifest is missing: cancel the upgrade and install it again.`);
  const next = JSON.parse(text) as ModuleManifest;
  await assertOwnedPackageChange(ctx, pkg.orgId, pkg.moduleId, { source: p.source, manifest: next });
  await assertCollectionLimits(ctx, pkg.orgId, pkg.moduleId, next);
  const previousManifest = manifestOf(pkg);
  if (pkg.bundleStorageId && pkg.bundleStorageId !== p.bundleStorageId) await ctx.storage.delete(pkg.bundleStorageId);
  await capturePackageState(ctx, source, () => ctx.db.patch(pkg._id, {
    version: p.version, source: p.source, manifest: text, manifestHash: p.manifestHash, bundleHash: p.bundleHash, bundleStorageId: p.bundleStorageId,
    epoch: p.epoch, slots: p.slots, installedBy: p.by, installedAt: Date.now(), status: "installed", pending: undefined,
  }));
  await storePendingManifest(ctx, pkg, null);
  await providedCollectionsReset(ctx, pkg.orgId, [previousManifest, JSON.parse(text) as ModuleManifest]);
  await servesNewVersion(ctx, pkg.orgId, pkg.moduleId, JSON.parse(text) as ModuleManifest, previousManifest);
}

/**
 * A version installed over an earlier one serves from now on: its docs (migrated, or its reports' collections) go to
 * the record service again, whole, and its `upgrade` job, if it declares one, is dirtied once (docs/modules.md,
 * "Upgrades"), the backfill a new version needs run once rather than on a schedule; and its jobs' failed keys run again.
 */
export async function servesNewVersion(ctx: MutationCtx, orgId: Id<"organizations">, moduleId: string, m: ModuleManifest, previousManifest: ModuleManifest | null) {
  await ensureActivityBaselines(ctx, orgId, moduleId, m, previousManifest);
  await invalidateActivatedJobLeases(ctx, orgId, moduleId, previousManifest);
  await rebuildProjection(ctx, orgId, moduleId, m);
  if (m.upgrade) await markDirty(ctx, orgId, moduleId, m, m.upgrade.job, upgradeKey(m));
  // Keys that failed under the old version run again under this one.
  await retryFailed(ctx, orgId, moduleId, m);
  await startImports(ctx, orgId, moduleId, m);
}

/** Start imports only once the manifest that names them serves. Progress survives later versions. */
export async function startImports(ctx: MutationCtx, orgId: Id<"organizations">, moduleId: string, m: ModuleManifest) {
  // Rows a workspace import held for this module, until it was installed here (convex/workspaceImport.ts).
  if (await ctx.db.query("moduleHeldRows").withIndex("by_orgId_and_moduleId", (q) => q.eq("orgId", orgId).eq("moduleId", moduleId)).first()) {
    await ctx.scheduler.runAfter(0, internal.workspaceImport.restoreHeld, { orgId, moduleId, cursor: null });
  }
  const names = importsOf(m);
  if (m.reports || m.dashboards) await ctx.scheduler.runAfter(0, internal.modules.installShipped, { orgId, moduleId });
  if (!names.length) return;
  const pkg = await installedModule(ctx, orgId, moduleId);
  if (!pkg) return;
  const progress = { ...pkg.imports };
  for (const { name } of names) {
    const state = progress[name];
    if (state?.done || state?.error) continue;
    progress[name] = state ?? { cursor: null, done: false };
    await ctx.scheduler.runAfter(0, internal.modules.importStep, { orgId, moduleId, name, cursor: progress[name].cursor });
  }
  await ctx.db.patch(pkg._id, { imports: progress });
}

/**
 * Send every projected doc of the module to the record service again (jobs.ts REPORT_JOB, one `*` key per
 * collection): when it is turned on, and when a new version serves.
 */
export async function rebuildProjection(ctx: MutationCtx, orgId: Id<"organizations">, moduleId: string, m: ModuleManifest) {
  const pkg = await installedModule(ctx, orgId, moduleId);
  if (pkg) await initializeProjection(ctx, pkg, m, true);
}

/** A migration's next batch, as its function receives it: the docs after the saved place, in the installed shape. */
export type MigrationBatch = { epoch: number; step: number; cursor: string | null; collection: string; call: string; from: string; to: string; docs: MigrationDoc[] };

/** The next batch of the migration a pending upgrade is on, read as Canon; null when it isn't on one. */
export async function migrationBatch(ctx: QueryCtx, pkg: Doc<"modulePackages">, batch: number): Promise<MigrationBatch | null> {
  const p = pkg.pending;
  const item = p && !p.error && p.phase !== "cutover" ? p.work[p.step] : undefined;
  if (!p || item?.mode !== "migrate") return null;
  const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => {
    const r = q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("collection", item.collection);
    return p.cursor === undefined ? r : r.gt("key", p.cursor);
  }).take(batch);
  return {
    epoch: p.epoch, step: p.step, cursor: p.cursor ?? null, collection: item.collection, call: item.call, from: pkg.version, to: p.version,
    docs: rows.map((r) => ({ key: r.key, parentKey: r.parentKey ?? null, data: r.data as Record<string, unknown> })),
  };
}

/** Stop a pending upgrade on `error`, unless it has moved on from `at`. */
export async function stopUpgrade(ctx: MutationCtx, pkg: Doc<"modulePackages">, at: { epoch: number; step: number; cursor: string | null }, error: string) {
  return withModulePublication(ctx, async () => {
    const p = pkg.pending;
    if (!p || p.error || p.epoch !== at.epoch || p.step !== at.step || (p.cursor ?? null) !== at.cursor) return;
    const source = await continuationSource(ctx, pkg);
    await capturePackageState(ctx, source, () => ctx.db.patch(pkg._id, { pending: { ...p, error } }));
  });
}

/**
 * A migration batch's results, applied as Canon: each doc's new data (checked against the new version's schema) or
 * its drop, kept in `next` for the cutover, and the patches it makes to other docs, laid over their new shape. All of
 * the batch or none of it: a doc that fails stops the upgrade, named, and the installed version keeps serving. A
 * batch applies once, at the place it was read from ("stale" otherwise).
 */
export async function applyMigration(ctx: MutationCtx, pkg: Doc<"modulePackages">, b: { epoch: number; step: number; cursor: string | null; keys: string[]; batch: number }, raw: unknown): Promise<"more" | "failed" | "stale"> {
  return withModulePublication(ctx, async () => {
    await assertSq1PackageUpgrade(ctx, pkg.orgId, pkg.moduleId);
    const p = pkg.pending;
    const item = p?.work[p.step];
    if (!p || p.error || p.phase === "cutover" || p.epoch !== b.epoch || p.step !== b.step || (p.cursor ?? null) !== b.cursor || item?.mode !== "migrate") return "stale";
    const source = await continuationSource(ctx, pkg);
    const at = { epoch: b.epoch, step: b.step, cursor: b.cursor };
    const stop = async (error: string) => { await stopUpgrade(ctx, pkg, at, `${error}. Ship a fixed version and upgrade to it, or cancel the upgrade.`); return "failed" as const; };
    const shape = migrationProblems(raw, b.keys);
    if (shape.length) return stop(`The migration ${item.call} of ${item.collection} returned what Canon can't apply: ${shape.slice(0, 3).join("; ")}`);
    const results = (raw as { value: { results: MigrationResult[] } }).value.results;
    const next = (await pendingManifestOf(ctx, pkg))!;
    const ownedRecords = new Set([...roomRecordCollections(manifestOf(pkg)), ...roomRecordCollections(next)]);
    if (ownedRecords.has(item.collection)) return stop("Module migrations cannot rewrite Canon visitor records");
    const later = new Set(p.work.slice(p.step + 1).filter((w) => w.mode === "migrate").map((w) => w.collection));
    // Each doc this batch changes, by collection/key: its row and its data in the new shape (null: it drops).
    const out = new Map<string, { collection: string; row: Doc<"moduleDocs">; data: Record<string, unknown> | null; by: string }>();
    const rowOf = (collection: string, key: string) => ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("collection", collection).eq("key", key)).unique();
    for (const r of results) {
      const row = await rowOf(item.collection, r.key);
      if (!row) continue;
      if ("error" in r) return stop(`${item.collection} ${r.key} failed its migration (${item.call}): ${r.error.slice(0, 300)}`);
      if ("drop" in r) out.set(`${item.collection}/${r.key}`, { collection: item.collection, row, data: null, by: r.key });
      else {
        if (!next.collections[item.collection]) return stop(`${item.collection} ${r.key} kept its data, but v${p.version} has no ${item.collection}: its migration drops each doc`);
        out.set(`${item.collection}/${r.key}`, { collection: item.collection, row, data: r.data, by: r.key });
      }
      for (const patch of r.patches ?? []) {
        if (ownedRecords.has(patch.collection)) return stop("Module migrations cannot patch Canon visitor records");
        const where = `${item.collection} ${r.key}'s migration patches ${patch.collection} ${patch.key}`;
        if (!next.collections[patch.collection]) return stop(`${where}, but v${p.version} has no ${patch.collection}`);
        const id = `${patch.collection}/${patch.key}`;
        let target = out.get(id);
        if (!target) {
          const t = await rowOf(patch.collection, patch.key);
          if (!t) return stop(`${where}, which doesn't exist`);
          const staged = t.next?.epoch === p.epoch;
          // A doc still to migrate would lose the patch when it migrates: patch only what is in the new shape.
          if (!staged && (later.has(patch.collection) || (patch.collection === item.collection))) return stop(`${where}, which hasn't migrated yet: a migration patches docs migrated before it`);
          target = { collection: patch.collection, row: t, data: staged ? (t.next!.drop ? null : (t.next!.data as Record<string, unknown>)) : (t.data as Record<string, unknown>), by: r.key };
          out.set(id, target);
        }
        if (target.data === null) return stop(`${where}, which its migration drops`);
        target.data = patched(target.data, patch);
        target.by = r.key;
      }
    }
    for (const [, t] of out) {
      if (t.data === null) continue;
      const held = upgradeHeldRefs(manifestOf(pkg).collections[t.collection].schema, t.row.data);
      if (t.row.next?.epoch === p.epoch && !t.row.next.drop) {
        for (const key of upgradeHeldRefs(next.collections[t.collection].schema, t.row.next.data as Record<string, unknown>)) held.add(key);
      }
      const problems = await fitProblems(next.collections[t.collection].schema, t.data, upgradeResolver(ctx, pkg, held), new Map(), upgradeFiles(ctx, pkg));
      if (problems.length) return stop(`${t.collection} ${t.row.key} doesn't fit v${p.version} after ${t.by === t.row.key ? "its migration" : `the migration of ${item.collection} ${t.by}`}: ${problems.slice(0, 3).join("; ")}`);
    }
    const staged = new Set(p.staged ?? []);
    for (const [, t] of out) {
      await patchModuleDoc(writeCtx(ctx), source, t.row._id, { next: t.data === null ? { epoch: p.epoch, drop: true } : { epoch: p.epoch, data: t.data } });
      staged.add(t.collection);
    }
    const finished = b.keys.length < b.batch;
    await capturePackageState(ctx, source, () => ctx.db.patch(pkg._id, { pending: { ...p, staged: [...staged], step: finished ? p.step + 1 : p.step, cursor: finished ? undefined : b.keys[b.keys.length - 1], done: p.done + b.keys.length } }));
    return "more";
  });
}

/**
 * One batch of an upgrade's cutover: the migrated docs of its staged collections swapped in (their new data, owner
 * and slots, a new version) or deleted. Nothing reads or writes the module meanwhile, so the version that serves
 * next finds every doc in its shape. The new version serves after the last batch.
 */
async function cutoverBatch(ctx: MutationCtx, pkg: Doc<"modulePackages">, batch: number): Promise<"more" | "done"> {
  await assertSq1PackageUpgrade(ctx, pkg.orgId, pkg.moduleId);
  const p = pkg.pending!;
  const source = await continuationSource(ctx, pkg);
  const staged = p.staged ?? [];
  const collection = staged[p.step];
  if (collection !== undefined) {
    const nc = (await pendingManifestOf(ctx, pkg))!.collections[collection];
    const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => {
      const r = q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("collection", collection);
      return p.cursor === undefined ? r : r.gt("key", p.cursor);
    }).take(batch);
    const now = Date.now();
    for (const row of rows) {
      rememberModuleRow(ctx, row);
      if (row.next?.epoch !== p.epoch) continue;
      if (row.next.drop || !nc) {
        await deleteModuleDoc(writeCtx(ctx), source, row._id);
        await providedCollectionChanged(ctx, pkg.orgId, manifestOf(pkg), collection, row.data, null);
        continue;
      }
      const data = row.next.data as Record<string, unknown>;
      const previousData = row.data;
      const owner = nc.owner && typeof data[nc.owner] === "string" ? (data[nc.owner] as Id<"users">) : undefined;
      await patchModuleDoc(writeCtx(ctx), source, row._id, { data, next: undefined, version: row.version + 1, ownerUserId: owner, ...slotColumns(nc, p.slots[collection] ?? {}, data, row.parentKey, row.gen ?? 0), updatedAt: now });
      await providedCollectionChanged(ctx, pkg.orgId, manifestOf(pkg), collection, previousData, data);
    }
    const finished = rows.length < batch;
    await capturePackageState(ctx, source, () => ctx.db.patch(pkg._id, { pending: { ...p, step: finished ? p.step + 1 : p.step, cursor: finished ? undefined : rows[rows.length - 1].key } }));
    if (!finished || p.step + 1 < staged.length) return "more";
  }
  await activate(ctx, pkg);
  return "done";
}

/**
 * A doc's fields changed with no check and no history row, as a bug or a direct database edit would: for showing a
 * seal catch it on a local stack (modules.devTamper, which refuses anywhere else). Returns the doc's new version.
 */
/**
 * Synthetic docs for a local stack's load test (modules.devSeedDocs): each inserted as Canon, its slots filled and
 * sent to the record service like any write, with no op, schema check or audit row.
 */
export async function seedDocs(ctx: MutationCtx, scope: ModuleScope, collection: string, docs: ReadonlyArray<{ key: string; data: Record<string, unknown> }>, slots: SlotMap): Promise<number> {
  return withModulePublication(ctx, async () => {
    const source = scopeModuleSource(scope);
    moduleWritable(scope.manifest, collection);
    if (await interfaceOwner(ctx, scope.orgId, scope.moduleId)) refuse("Synthetic seeding cannot change an owning package. Use its declared editing calls.");
    const c = scope.manifest.collections[collection];
    if (!c || c.setOf) throw new ConvexError(`${collection} is not a top-level collection of ${scope.manifest.title}.`);
    const now = Date.now();
    for (const d of docs) {
      const owner = c.owner && typeof d.data[c.owner] === "string" ? (d.data[c.owner] as Id<"users">) : undefined;
      await insertModuleDoc(writeCtx(ctx), source, { orgId: scope.orgId, moduleId: scope.moduleId, collection, key: d.key, data: d.data, version: 1, ...(owner ? { ownerUserId: owner } : {}), ...slotColumns(c, slots[collection] ?? {}, d.data, undefined, 0), updatedAt: now }, TRUSTED_MAINTENANCE);
      await providedCollectionChanged(ctx, scope.orgId, scope.manifest, collection, null, d.data);
      if (projectedCollections(scope.manifest).has(collection)) await markDirty(ctx, scope.orgId, scope.moduleId, scope.manifest, REPORT_JOB, `${collection}|${d.key}`);
    }
    return docs.length;
  });
}

/**
 * A module's docs and their history from a workspace import (convex/workspaceImport.ts), ids already this
 * workspace's, restored as Canon: each doc keeps its version, owner, set place and creation time, takes this
 * install's index slots and must fit this version's schema; a doc with the same key replaces the one here (a default
 * the module made). It marks only the report projection and tells no provided-collection consumer (an ICP fill check
 * would start), so nothing runs on what arrived; the module is off while it takes them (workspaceImport.ts). Returns
 * per row its id here, or why it stays held.
 */
export async function restoreImportedDocs(ctx: MutationCtx, pkg: Doc<"modulePackages">, rows: ReadonlyArray<{ table: string; row: Record<string, unknown> }>): Promise<Array<{ id: string } | { why: string }>> {
  return withModulePublication(ctx, async () => {
    const manifest = manifestOf(pkg);
    const slots: SlotMap = pkg.slots ?? defaultSlots(manifest);
    const source = moduleSource(pkg);
    const at = { orgId: pkg.orgId, moduleId: pkg.moduleId };
    const out: Array<{ id: string } | { why: string }> = [];
    for (const { table, row } of rows) {
      const collection = String(row.collection), key = String(row.key);
      const c = manifest.collections[collection];
      if (!c) { out.push({ why: `v${pkg.version} has no ${collection} collection` }); continue; }
      if (table === "moduleEvents") {
        out.push({ id: await ctx.db.insert("moduleEvents", { ...(row as Omit<Doc<"moduleEvents">, "_id" | "_creationTime">), ...at }) });
        continue;
      }
      if (table !== "moduleDocs") { out.push({ why: `${table} is not a module's docs` }); continue; }
      const data = row.data as Record<string, unknown>;
      const problems = valueProblems(data, c.schema, collection, () => true, () => null);
      if (problems.length) { out.push({ why: `doesn't fit v${pkg.version}: ${problems.slice(0, 3).join("; ")}` }); continue; }
      const parentKey = typeof row.parentKey === "string" ? row.parentKey : undefined;
      const gen = typeof row.gen === "number" ? row.gen : undefined;
      const value: ModuleDocInsert = {
        ...at, collection, key, data, version: Number(row.version),
        ...(typeof row.ownerUserId === "string" ? { ownerUserId: row.ownerUserId as Id<"users"> } : {}),
        ...(parentKey !== undefined ? { parentKey } : {}), ...(gen !== undefined ? { gen } : {}),
        ...(row.gens ? { gens: row.gens as Record<string, number> } : {}),
        sourceCreatedAt: Number(row.sourceCreatedAt),
        ...slotColumns(c, slots[collection] ?? {}, data, parentKey, gen ?? 0), updatedAt: Number(row.updatedAt),
      };
      const held = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", pkg.orgId).eq("moduleId", pkg.moduleId).eq("collection", collection).eq("key", key)).unique();
      if (held) await patchModuleDoc(writeCtx(ctx), source, held._id, value, TRUSTED_MAINTENANCE);
      const id = held?._id ?? await insertModuleDoc(writeCtx(ctx), source, value, TRUSTED_MAINTENANCE);
      if (projectedCollections(manifest).has(collection)) await markDirty(ctx, pkg.orgId, pkg.moduleId, manifest, REPORT_JOB, `${collection}|${key}`);
      out.push({ id });
    }
    return out;
  });
}

/**
 * A local stack's synthetic docs removed again (modules.devUnseedDocs): up to `max` top-level docs of `collection`
 * whose key starts with `prefix`, each also removed from the record service's copy. No op or audit row, as seeding.
 */
export async function unseedDocs(ctx: MutationCtx, scope: ModuleScope, collection: string, prefix: string, max: number): Promise<number> {
  return withModulePublication(ctx, async () => {
    const source = scopeModuleSource(scope);
    moduleWritable(scope.manifest, collection);
    if (await interfaceOwner(ctx, scope.orgId, scope.moduleId)) refuse("Synthetic cleanup cannot change an owning package. Use its declared editing calls.");
    const rows = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", scope.orgId).eq("moduleId", scope.moduleId).eq("collection", collection).gte("key", prefix).lt("key", `${prefix}\uffff`)).take(max);
    for (const r of rows) {
      await deleteModuleDoc(writeCtx(ctx), source, r._id, TRUSTED_MAINTENANCE);
      await providedCollectionChanged(ctx, scope.orgId, scope.manifest, collection, r.data, null);
      if (projectedCollections(scope.manifest).has(collection)) await markDirty(ctx, scope.orgId, scope.moduleId, scope.manifest, REPORT_JOB, `${collection}|${r.key}`);
    }
    return rows.length;
  });
}

/** Why an upload ticket can't take a file now (unknown, used, expired), or null when it can. */
async function ticketProblem(db: QueryCtx["db"], ticket: string, secret: string, now: number) {
  const tid = db.normalizeId("moduleFiles", ticket);
  const row = tid ? await db.get(tid) : null;
  if (!row || row.visitorUpload || !row.uploadedBy || !row.secret || row.secret !== secret || row.storageId !== undefined) return { row: null, why: "That upload ticket isn't valid, or it is used. Upload the file again." };
  if (now - row.at > UPLOAD_TICKET_MS) return { row: null, why: "That upload ticket expired. Upload the file again." };
  return { row, why: null };
}

function fileMetadata(row: Doc<"moduleFiles">): FileInfo {
  return { name: row.name, type: row.type, bytes: row.bytes, ...(row.visitorUpload ? { buyer: { label: row.visitorUpload.label, verified: row.visitorUpload.verified, scanned: false as const } } : {}) };
}

export async function visitorUploadRow(ctx: QueryCtx | MutationCtx, id: string): Promise<Doc<"moduleFiles"> | null> {
  const fid = ctx.db.normalizeId("moduleFiles", id);
  const row = fid ? await ctx.db.get(fid) : null;
  return row?.visitorUpload && !row.uploadedBy ? row : null;
}

export async function expiredVisitorUploads(ctx: MutationCtx): Promise<Doc<"moduleFiles">[]> {
  return ctx.db.query("moduleFiles").withIndex("by_visitorUpload_state_expiresAt", (q) => q.eq("visitorUpload.state", "reserved").lt("visitorUpload.expiresAt", Date.now())).take(20);
}

export async function reserveVisitorUpload(ctx: MutationCtx, bound: {
  orgId: Id<"organizations">; moduleId: string; grantId: VisitorUploadOwner["grantId"]; visitorId: VisitorUploadOwner["visitorId"];
  sessionHash: string; policyHash: string; rootCreatedAt: number; generation: number; target: VisitorUploadTarget; collection: string;
  label: string; verified: boolean; budgets: Array<{ key: string; amount: number; windowStart: number }>;
}, file: VisitorFileMetadata) {
  const secret = crypto.randomUUID(), at = Date.now();
  const { orgId, moduleId, target, ...owner } = bound;
  const ticket = await ctx.db.insert("moduleFiles", { orgId, moduleId, name: file.name, type: file.type, bytes: file.bytes, secret, at,
    visitorUpload: { ...owner, target: canonicalJson(target), digest: file.digest, state: "reserved", expiresAt: at + VISITOR_TICKET_MS } });
  return { ticket: String(ticket), secret };
}

export async function releaseVisitorUpload(ctx: MutationCtx, row: Doc<"moduleFiles">): Promise<void> {
  if (row.visitorUpload?.state !== "reserved" || row.storageId) return;
  await ctx.db.patch(row._id, { secret: undefined, visitorUpload: { ...row.visitorUpload, state: "released" } });
}

export async function storeVisitorUpload(ctx: MutationCtx, row: Doc<"moduleFiles">, storageId: Id<"_storage">): Promise<FileInfo & { id: string }> {
  const upload = row.visitorUpload;
  if (!upload || upload.state !== "reserved" || upload.expiresAt <= Date.now() || row.storageId) refuse("This upload expired.");
  await ctx.db.patch(row._id, { storageId, visitorUpload: { ...upload!, state: "stored" } });
  return { id: String(row._id), ...fileMetadata(row) };
}

export async function shareFileDownload(ctx: MutationCtx, orgId: Id<"organizations">, moduleId: string, file: string): Promise<(FileInfo & { url: string }) | null> {
  const fid = ctx.db.normalizeId("moduleFiles", file), row = fid ? await ctx.db.get(fid) : null;
  if (!row || row.orgId !== orgId || row.moduleId !== moduleId || !row.storageId || !row.attachedTo || row.visitorUpload && row.visitorUpload.state !== "attached") return null;
  const url = await ctx.storage.getUrl(row.storageId);
  return url ? { ...fileMetadata(row), url } : null;
}
/** Whether an upload ticket still takes its file: null, or why not (uploadRoute.ts, before it stores anything). */
export async function ticketOpen(ctx: QueryCtx, ticket: string, secret: string): Promise<string | null> {
  return (await ticketProblem(ctx.db, ticket, secret, Date.now())).why;
}
/**
 * A file the upload route stored, recorded on its ticket: it is the ticket person's from now on, and the ticket is
 * spent. The size and type are what the route measured of the body.
 */
export async function recordUpload(ctx: MutationCtx, a: { ticket: string; secret: string; storageId: Id<"_storage">; name: string; type: string; bytes: number }): Promise<FileInfo & { id: string }> {
  const { row, why } = await ticketProblem(ctx.db, a.ticket, a.secret, Date.now());
  if (!row) throw new ConvexError(why);
  const name = a.name.replace(/[\u0000-\u001f\\/]/g, "_").trim().slice(0, 200) || "file";
  const info = { name, type: a.type.slice(0, 100), bytes: a.bytes };
  await ctx.db.patch(row._id, { storageId: a.storageId, secret: undefined, ...info, at: Date.now() });
  return { id: row._id as string, ...info };
}

export async function tamperDoc(ctx: MutationCtx, scope: ModuleScope, collection: string, key: string, patch: Record<string, unknown>): Promise<number> {
  return withModulePublication(ctx, async () => {
    const source = scopeModuleSource(scope);
    moduleWritable(scope.manifest, collection);
    const row = await ctx.db.query("moduleDocs").withIndex("by_orgId_moduleId_collection_key", (q) => q.eq("orgId", scope.orgId).eq("moduleId", scope.moduleId).eq("collection", collection).eq("key", key)).unique();
    if (!row) throw new ConvexError(`${collection} has no ${key}.`);
    const before = row.data, after = { ...row.data, ...patch };
    await patchModuleDoc(writeCtx(ctx), source, row._id, { data: after });
    await providedCollectionChanged(ctx, scope.orgId, scope.manifest, collection, before, after);
    if (projectedCollections(scope.manifest).has(collection)) await markDirty(ctx, scope.orgId, scope.moduleId, scope.manifest, REPORT_JOB, `${collection}|${key}`);
    return row.version;
  });
}
