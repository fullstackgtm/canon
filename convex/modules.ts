import { captureInstalledPackage, capturePackageState, moduleSource, continuationSource, withModulePublication, retainedSourcePublication } from "./lib/modules/activityCapture";
/**
 * Installable modules (docs/modules.md). An admin or manager installs a module from a GitHub package pinned to a
 * commit, as a recipe package installs, and turns it on for the workspace. A module on gives the workspace one nav
 * entry and pages Canon renders from the manifest, over the module's own collections.
 *
 * The dashboard reads and writes module data only through `page`, `view`, `op`, `transition` and `call`, which
 * canon_module (/mcp and the canon CLI) calls too; each builds its scope with moduleScope, the one way in to module
 * data. A write's company and person refs are admitted from the record service by its action (admitRecords). `call` runs the module's server code in the recipe runtime: its read plan read in one query, the code's
 * writes applied in one mutation, all or none. Installing, turning on and off and uninstalling are a person's, like
 * a recipe's.
 */
import { moduleRuntimeAvailable } from "./lib/integrationsAvailable.ts";

import { reportsTakeover } from "../modules/kernel/reports.ts";
import { stageHistoryReport } from "./lib/objects/stageHistory";
import { readStageHistory } from "./stageHistory";
import { logResearchFailure } from "./researchSessions";
import { webPagesRequest } from "../modules/kernel/webPages.ts";
import { ConvexError, v } from "convex/values";
import { providedCollectionsReset } from "./lib/modules/providedChanges";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { executeCanonOperation } from "./lib/modules/canonOperations";
import { encryptToken } from "./lib/encryption";
import type { CanonCallAuthorization } from "./lib/modules/scope";
import { agentClientOf, isDevAuthBypassEnabled, requireUser, withRole } from "./lib";
import { callerOf, mayDecide, requireDecider } from "./recipes";
import { accessFor, roleBasesOf, workspaceMembers } from "./permissions";
import { baseRole } from "./lib/roles";
import { openSource, parseSource, resolveSource, sameRepo, sourceText, type Connection, type PinnedSource, type SourceBases } from "./lib/recipeSources";
import { orgConnections } from "./lib/recipes";
import { enabledModules, enablementRow, installedModule, isEnabled, manifestOf, packageRow, storePendingManifest, MODULE_CONTRIBUTION, MODULE_POINT } from "./lib/modules/packages";
import { assertOwnedPackageChange } from "./lib/modules/interfaceOwnership";
import { assertCollectionLimits, startImports, expectEpoch, refKey, personScope, applyMigration, rebuildProjection, servesNewVersion, seedDocs, unseedDocs, ticketOpen, recordUpload as recordUploadOf, cuttingOver, hasDocs, migrationBatch, moduleScope, moduleScopeCaller, readsOnly, stopUpgrade, systemScope, tamperDoc, upgradeBatch, type AppliedIntent, type ModuleDoc, type ModuleEvent, type ModuleScope, type Retired, type Snapshot, type Verified, type BulkInfo, type Admit, type AdmitAsk } from "./lib/modules/scope";
import { assertSq1PackageUpgrade } from "./lib/sequences/bindings";
import { pauseSq1Package } from "./lib/sequences/lifecycle";
import { superseded, isSuperseded, moduleErrorMessage } from "./lib/modules/revision";
import { isMissingBundle, runModuleCall } from "./lib/recipeRuntime";
import { verifyEvidence } from "./lib/modules/evidence";
import { actionReadFence, readActionSources } from "./lib/modules/actionReads";
import { runAiStep } from "./lib/modules/ai";
import { readRecordsOf, readTreesOf, addedTo } from "./lib/modules/recordReadAction";
import { resolvePeopleRows } from "./lib/modules/recordReads";
import { peopleContacts, type PeopleExportSource } from "./lib/modules/peopleExport";
import { csvOf } from "./lib/outbound/audience";
import { objectNames } from "./lib/objects/orgDefs";
import { expandProposal, meetingProposalRow } from "./lib/modules/recordProposals";
import { grantableLabel, PROPOSAL_OPERATIONS, type MeetingLogArgs, type ProposalRow } from "../modules/kernel/proposals.ts";
import { CANON_LABELS, CANON_READS, NAV_SLOTS, MAX_EXPORT_ROWS, MAX_PAGE_ROWS, MIN_AGGREGATE_OWNERS, MODULE_FILE, MODULE_MAX_BYTES, MODULE_STORED_MAX_BYTES, landingFor, matchPage, peopleFilterForms, moduleSlug, pagesOf, panelPath, pdfPagePath, parseModuleManifest, peopleExportProblems, type PeopleListAction, type PeopleFilterForm, type ActionRef, type Binding, type FormExpr, type ModuleManifest, type Node, type ObjectValidator, type PageDecl, type PageExpr, type Role, type NavIcon } from "../modules/kernel/manifest.ts";
import { dealBadges, fillPath, moneyDecimals, renderText, rowWhenHolds, toCsv, valueAt, type Doc as TextDoc } from "../modules/kernel/text.ts";
import { base64, xlsx, type CellKind } from "../modules/kernel/xlsx.ts";
import { joinDocs, pdf, type PdfDoc } from "../modules/kernel/pdf.ts";
import { blockedId, printDoc, timelineHides, type PrintView } from "../modules/kernel/document.ts";
import { compareVersions, defaultSlots, holdsWrites, migrates, planUpgrade, type UpgradePlan } from "../modules/kernel/upgrade.ts";
import { agentModeOf } from "../modules/kernel/machines.ts";
import { chunked, outputProblems, type AggregateReadValue, type CallOutput, type Intent, type ReadValue, type ReportReadValue } from "../modules/kernel/calls.ts";
import { feedOf } from "./lib/connectors/registry";
import { ensureActivityBaselines, ensureCursors, jobStatus, prefixStatus, type PrefixStatus } from "./lib/modules/jobs";
import { csvImportShape } from "../modules/kernel/csvImport.ts";
import { choiceDescriptions, choiceLabels, coreOf, filesIn, humanName, isRecordRef, jsonSchema, RECORD_REFS, literalChoices, refsIn, widgetOf, REF_TARGETS, type FieldSpec, type RecordRefTo, type RefTo, type Scalar, type ValidatorJSON, type Widget } from "../modules/kernel/schema.ts";
import { MODULE_EXAMPLES } from "../modules/examples/_examples.generated.ts";
import { installShippedReports } from "./lib/modules/shippedReports";
import { MODULE_IMPORTS, importsOf } from "./lib/modules/imports";
import { examplesForOrg, neverHad } from "./moduleDefaults";
import { bundleHash } from "../services/recipe-runtime/src/protocol.ts";
import { callerClient, clientFor, requireCaller } from "./records";
import { accountNamesFor, type RecordClient } from "./lib/recordClient";
import { visibleIds } from "./lib/scopedRecordClient";
import { readRecord, type RecordReadPorts } from "./lib/modules/recordReads";
import { checkSpec, cleanName, REPORTS_MAX } from "./reports";
import { scopeOwners } from "./lib/reportScope";
import { checkTiles, cleanDashboardName, DASHBOARDS_MAX, tile as dashboardTile } from "./lib/dashboardRules";
import { can } from "./lib/capabilities";
import { reportSpec, type ReportSpec } from "./lib/objects/validators";
import { aggregateRowsInMemory, bucketStart, compileAggregateRequest, MEASURES_MAX, type AggregateResponse } from "./lib/objects/reportSpec";
import { joinParts, needsSplit, plainMeasures, plainSpec, splitReport } from "./lib/objects/metricSplit";
import { ListRequestError } from "./lib/objects/listSpec";
import { moduleListRow, moduleReportDef, type ModuleDocScope, type ModuleReportField, type ModuleProjection } from "./lib/objects/moduleReport";
import { projectionOf, sameProjection } from "./lib/modules/projection";
import { aggregateMeasures, CANON_SOURCES, canonReportRequest, canonSourceFields, DEAL_ACCOUNT, EVERY_CANON_SOURCE, grantsSource, isCanonSource, latestByMember, recordObjectOf, reportFields, reportReads, teamAggregate, WEIGHTED_AMOUNT, type AggregateSpec, type CanonReportRequest, type ReportField } from "../modules/kernel/reports.ts";
import { everyRecordSource } from "./lib/modules/recordSources";
import { listedDef } from "./savedViews";
import { reportsBehind, retryFailed, REPORT_JOB } from "./lib/modules/jobs";
import { rosterOf, fyStartOf } from "./targets";
import { fiscalMonth, PACING_COMPARE_MAX } from "./lib/reports/pacing";
import { runPacing, type PacingResult, type PacingPlan, type PacingSource as RunPacingSource } from "./lib/reports/runPacing";
import { listFilter } from "./lib/objects/validators";
import { pickCalls, transcriptOf, type Transcript } from "./lib/modules/transcripts";

import { issueShareLink, planShareLink, shareLinks, changeShareLink, previewSharePage, type IssueSharePlan } from "./lib/modules/visitors";
import { resolveRoomAttribution } from "./lib/modules/roomAttribution";
import { canonicalJson } from "../modules/kernel/integrity.ts";
import { sha256 } from "./lib/modules/shares";

const ERRORS_SHOWN = 8;
/** A module's server bundle: one ESM file, as scripts/module-build.ts writes it. */
const BUNDLE_MAX_BYTES = 1024 * 1024;
/** A replaceSet's docs reach Convex in chunks below its 8,192-element and 8 MiB argument limits. */
const STAGE_CHUNK = 1000;
const STAGE_BYTES = 2_000_000;
const APPLY_BYTES = 6_000_000;
const DROP_CHUNK = 2000;
const AGENT_REFUSED = "An agent can't install, turn on or uninstall modules. An admin or manager does that on the Customization page.";
const repoFields = { owner: v.string(), repo: v.string(), path: v.optional(v.string()), ref: v.string(), sha: v.string() };
const pinnedSource = v.union(
  v.object({ kind: v.literal("github-public"), ...repoFields }), v.object({ kind: v.literal("github-app"), installationId: v.number(), ...repoFields }),
  v.object({ kind: v.literal("canon"), id: v.string(), ref: v.string(), sha: v.string() }),
);
/** A first-party example Canon ships (modules/examples/): `id` its slug, `ref` its version, `sha` the hash of its files. */
type CanonSource = { kind: "canon"; id: string; ref: string; sha: string };
type ModuleSource = PinnedSource | CanonSource;
const CANON_PREFIX = "canon:";
/** How a source reads: `github:owner/repo/path@ref`, or `canon:<example>` for one Canon ships. */
const moduleSourceText = (s: ModuleSource) => (s.kind === "canon" ? `${CANON_PREFIX}${s.id}` : sourceText(s));
/** Whether two sources are the same package: one repo and path, or one example of Canon's. */
const sameSource = (a: ModuleSource, b: ModuleSource) => (a.kind === "canon" || b.kind === "canon" ? a.kind === b.kind && (a as CanonSource).id === (b as CanonSource).id : sameRepo(a, b));
const scalar = v.union(v.string(), v.number(), v.boolean(), v.null());

const notOn = (module: string) => new ConvexError(`This workspace has no module ${module} turned on.`);
/**
 * The caller's scope, or Canon's in workspace `system`, or a member's (`as`) for a background AI step (internal
 * functions only: jobs, AI steps and the local stack's stand-ins).
 */
async function scopeOrRefuse(ctx: Parameters<typeof moduleScope>[0], module: string, system?: Id<"organizations">, as?: Person, epoch?: number, admit?: Admit): Promise<ModuleScope> {
  const scope = (await (system ? systemScope(ctx, system, module, false, admit) : as ? personScope(ctx, as.orgId, as.userId, module, admit, as.agent ?? null) : moduleScope(ctx, module, admit))) ?? (() => { throw notOn(module); })();
  return epoch === undefined ? scope : expectEpoch(scope, epoch);
}
/** How an internal write judges its company and person refs: what its action asks or admitted (admitRecords). */
export const admitV = v.optional(v.union(v.literal("ask"), v.array(v.string())));

/**
 * A write's result. Run asking (Admit "ask"), one that found company or person refs to admit throws them instead, so
 * nothing it wrote stays and its action (admitRecords) runs it again with them admitted.
 */
export async function written<T>(scope: ModuleScope, out: Promise<T>): Promise<T> {
  const value = await out;
  const ask = scope.unadmitted();
  if (ask.length) throw new ConvexError({ admitRecords: ask } satisfies AdmitAsk);
  return value;
}

/** Who an action reads the record service as: Canon in a workspace (every live record), a member with no session (a background AI step), or the signed-in caller. */
async function recordReader(ctx: ActionCtx, system?: Id<"organizations">, person?: Person): Promise<{ client: RecordClient; ws: string }> {
  if (system) return { client: clientFor(ctx), ws: system as string };
  if (person) return { client: callerClient(ctx, { orgId: person.orgId, access: await ctx.runQuery(internal.moduleAi.accessOf, { orgId: person.orgId, userId: person.userId }) }), ws: person.orgId as string };
  // A read: in a "view as" preview the write it admits for is refused anyway (lib/modules/scope.ts moduleScope).
  const caller = await requireCaller(ctx, { read: true });
  return { client: callerClient(ctx, caller), ws: caller.orgId };
}

/**
 * A module write with the company and person refs its writer may name (docs/modules.md, "Refs"): run once asking;
 * when it names refs its docs don't hold already, those the writer's record client sees (Canon's: every live record of
 * the workspace) are admitted and it runs again, where any other refuses. The one way a write admits them
 * (tests/moduleSurfaces.test.ts).
 */
async function admitRecords<T>(ctx: ActionCtx, write: (admit: Admit) => Promise<T>, system?: Id<"organizations">, person?: Person): Promise<T> {
  let asked: AdmitAsk["admitRecords"];
  try { return await write("ask"); } catch (e) {
    const data = e instanceof ConvexError ? (e.data as Partial<AdmitAsk> | null) : null;
    if (!data || typeof data !== "object" || !Array.isArray(data.admitRecords)) throw e;
    asked = data.admitRecords;
  }
  const { client, ws } = await recordReader(ctx, system, person);
  const seen = async (to: RecordRefTo, object: "account" | "contact") =>
    [...await visibleIds(client, ws, object, asked.filter((r) => r.to === to).map((r) => r.id))].map((id) => refKey({ to }, id));
  return write([...await seen("companies", "account"), ...await seen("people", "contact")]);
}
/** A member a background AI step runs as (docs/modules.md, "Hosted AI steps"): no session, their own scopes. */
type Person = { orgId: Id<"organizations">; userId: Id<"users">; agent?: string };
const personV = v.object({ orgId: v.id("organizations"), userId: v.id("users"), agent: v.optional(v.string()) });
/** Upgrade backfill batches: docs per mutation, and docs per migration call (each doc goes to the runtime and back). */
const UPGRADE_BATCH = 200;
const MIGRATE_BATCH = 100;

/**
 * The module's nav entry, if it has pages. With a landing page per role, it opens the module's root, which lands each
 * on theirs. One that takes a place in the nav (NAV_SLOTS) carries its id, and the old URL that now opens the module.
 */
const navOf = (m: ModuleManifest) => (m.nav ? {
  label: m.nav.label, icon: m.nav.icon, section: m.nav.section, href: `/dashboard/m/${moduleSlug(m.id)}${typeof m.nav.landing === "string" ? `/${m.nav.landing}` : ""}`,
  ...(m.nav.slot ? { id: m.nav.slot as string, legacy: NAV_SLOTS[m.nav.slot].href as string } : {}),
} : null);
/** The places in the nav where the module shows Canon's own page, each with the id workspace.nav hides it by. */
const linksOf = (m: ModuleManifest) => (m.links ?? []).map((slot) => ({ id: slot as string, ...(NAV_SLOTS[slot] as { section: string; label: string; icon: NavIcon; href: string; badge?: "dueTasks" }) }));
/** A pending upgrade as the Recipes row and canon_module show it: how far it is, or the doc that stopped it. */
const upgradeOf = (pkg: Doc<"modulePackages">) => {
  const p = pkg.pending;
  if (!p) return null;
  const cutover = p.phase === "cutover";
  return {
    version: p.version, done: p.done, step: p.step, steps: cutover ? (p.staged ?? []).length : p.work.length, error: p.error ?? null,
    phase: cutover ? ("cutover" as const) : migrates(p.work) ? ("migrate" as const) : ("rebuild" as const),
    collection: (cutover ? p.staged?.[p.step] : p.work[p.step]?.collection) ?? null,
  };
};

const autoUpgradeOf = (pkg: Doc<"modulePackages">) => pkg.autoUpgrade?.version === pkg.version ? pkg.autoUpgrade : null;

/** The modules on in the caller's workspace, for the nav and canon_module list. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const caller = await callerOf(ctx);
    if (!caller) return [];
    const on = (await enabledModules(ctx, caller.user.orgId)).filter(({ manifest }) => moduleRuntimeAvailable(manifest)).map(({ pkg, manifest: m }) => ({ moduleId: m.id, slug: moduleSlug(m.id), title: m.title, description: m.description, version: m.version, nav: navOf(m), links: linksOf(m), upgrade: upgradeOf(pkg), reportsTakeover: reportsTakeover(pkg), autoUpgrade: autoUpgradeOf(pkg) }));
    const waiting = [];
    for (const { manifest: m } of await examplesForOrg(ctx, caller.user.orgId)) {
      if (!moduleRuntimeAvailable(m)) continue;
      if (!on.some((x) => x.moduleId === m.id) && (await neverHad(ctx, caller.user.orgId, m.id))) {
        waiting.push({ moduleId: m.id, slug: moduleSlug(m.id), title: m.title, description: m.description, version: m.version, nav: navOf(m), links: linksOf(m), upgrade: null, reportsTakeover: false, autoUpgrade: null });
      }
    }
    return [...on, ...waiting];
  },
});

/**
 * The modules Canon ships (modules/examples/), as the Recipes page offers them: each with the version installed here,
 * if any, and whether Canon has shipped a newer build of it since.
 */
export const examples = query({
  args: {},
  handler: async (ctx) => {
    const caller = await callerOf(ctx);
    if (!caller) return null;
    const rows = await ctx.db.query("modulePackages").withIndex("by_orgId_and_status", (q) => q.eq("orgId", caller.user.orgId).eq("status", "installed")).take(50);
    return {
      canEdit: mayDecide(caller),
      examples: Object.entries(MODULE_EXAMPLES).map(([slug, ex]) => {
        const m = JSON.parse(ex.manifest) as ModuleManifest;
        const row = rows.find((r) => r.moduleId === m.id);
        return {
          slug, source: `${CANON_PREFIX}${slug}`, moduleId: m.id, title: m.title, description: m.description, version: m.version, nav: navOf(m), links: linksOf(m), default: m.default === true,
          installed: row ? { version: row.version, fromCanon: row.source.kind === "canon", current: row.source.sha === ex.sha || (row.pending?.source.sha === ex.sha && !row.pending.error) } : null,
        };
      }),
    };
  },
});

/** Every module the workspace installed, on or off, as the Recipes page lists them. */
export const installed = query({
  args: {},
  handler: async (ctx) => {
    const caller = await callerOf(ctx);
    if (!caller) return null;
    const rows = await ctx.db.query("modulePackages").withIndex("by_orgId_and_status", (q) => q.eq("orgId", caller.user.orgId).eq("status", "installed")).take(50);
    const modules = await Promise.all(rows.map(async (pkg) => {
      const m = manifestOf(pkg);
      return {
        moduleId: m.id, slug: pkg.slug, title: m.title, description: m.description, version: pkg.version, author: m.author.org,
        source: moduleSourceText(pkg.source), sha: pkg.source.sha, enabled: await isEnabled(ctx, caller.user.orgId, m.id), nav: navOf(m), links: linksOf(m),
        collections: Object.keys(m.collections), pages: m.pages.length,
        imports: Object.entries(pkg.imports ?? {}).map(([name, state]) => ({ name, label: MODULE_IMPORTS[name]?.label ?? name, ...state })),
        // Its background work: keys waiting, running and failed, and how far its deal feed is behind the ledger.
        jobs: await jobStatus(ctx.db, caller.user.orgId, m.id, m, Date.now()),
        // A newer version installing: how far its backfill is, or why it stopped.
        upgrade: upgradeOf(pkg), autoUpgrade: autoUpgradeOf(pkg),
      };
    }));
    return { canEdit: mayDecide(caller), modules };
  },
});

/**
 * A field spec with each object's field order spelled out as `order`: Convex hands objects back with their keys
 * sorted, and a nested editor shows fields in the order the module declared them.
 */
function ordered(spec: FieldSpec): FieldSpec {
  const walk = (v: ValidatorJSON): ValidatorJSON => {
    switch (v.type) {
      case "object": return { ...v, value: Object.fromEntries(Object.entries(v.value).map(([k, sp]) => [k, ordered(sp)])), order: Object.keys(v.value) } as ValidatorJSON;
      case "array": return { ...v, value: walk(v.value) };
      case "union": return { ...v, value: v.value.map(walk) };
      case "variant": return { ...v, cases: Object.fromEntries(Object.entries(v.cases).map(([k, c]) => [k, walk(c)])) } as ValidatorJSON;
      default: return v;
    }
  };
  return { ...spec, fieldType: walk(spec.fieldType) };
}

/**
 * A transition's, op's or call's arguments as a form shows them: each field's widget, whether it's required, its
 * choices, and its spec, from which a nested editor draws a list's rows, an object's fields or a variant's case. A
 * variant's sibling comes with it, so the form shows the case it picks.
 */
const formFields = (schema: ObjectValidator, names: readonly string[], hint: (f: string) => { label: string; widget?: Widget } | undefined = () => undefined) =>
  names.map((f) => {
    const spec = schema.value[f];
    return {
      field: f, label: hint(f)?.label ?? spec?.label ?? null, widget: hint(f)?.widget ?? (spec ? widgetOf(spec) : null), help: spec?.help ?? null, placeholder: spec?.placeholder ?? null,
      descriptions: spec ? choiceDescriptions(coreOf(spec.fieldType)) : null,
      required: spec ? !spec.optional : false, choices: spec ? literalChoices(spec.fieldType) : null, labels: spec ? choiceLabels(spec.fieldType) : null,
      spec: spec ? ordered(spec) : null, variantOf: spec?.fieldType.type === "variant" ? spec.fieldType.variantOf : null,
    };
  });

/** Each field's value labels in a collection (a union's `labels`), for tables, steps and forms. */
const labelsOf = (m: ModuleManifest, collection: string | undefined) =>
  Object.fromEntries(Object.entries(m.collections[collection ?? ""]?.schema.value ?? {}).flatMap(([f, spec]) => { const l = choiceLabels(spec.fieldType); return l ? [[f, l]] : []; }));

/** Each field's own format in a collection, when text gives none: a number with a `time` hint shows as a date and time. */
const formatsOf = (m: ModuleManifest, collection: string | undefined) =>
  Object.fromEntries(Object.entries(m.collections[collection ?? ""]?.schema.value ?? {}).flatMap(([f, spec]) => (spec.widget === "time" ? [[f, "time"]] : coreOf(spec.fieldType).type === "file" ? [[f, "file"]] : [])));

/** What an agent can do with a module: its views with their arguments, its ops and its machines' transitions, each with its agent mode. */
export const describe = query({
  args: { module: v.string() },
  handler: async (ctx, args) => {
    const scope = await scopeOrRefuse(ctx, args.module);
    const m = scope.manifest;
    return {
      moduleId: m.id, title: m.title, description: m.description, version: m.version, role: scope.role, recordRefs: true,
      collections: Object.fromEntries(Object.entries(m.collections).map(([name, c]) => [name, {
        schema: jsonSchema(c.schema), owner: c.owner ?? null, setOf: c.setOf?.parent ?? null,
        ...(c.report ? { report: { dimensions: c.report.dimensions, measures: c.report.measures ?? [] } } : {}),
      }])),
      reports: Object.fromEntries(m.pages.flatMap((p) => reportNodes(p.body)).map((n) => [n.id, { collection: n.collection, sources: n.sources ?? [], title: n.title ?? null, rows: n.rows ?? [], columns: n.columns ?? [], values: n.values ?? [{ fn: "count" }] }])),
      views: Object.fromEntries(Object.entries(m.views).map(([name, x]) => [name, { kind: x.kind, collection: x.collection, args: x.args ?? {} }])),
      ops: Object.fromEntries(Object.entries(m.ops).map(([name, op]) => [name, {
        label: op.label, kind: op.kind, collection: op.collection, fields: op.fields ?? [], roles: op.roles, capability: op.capability ?? null, allowed: scope.admission(op) === null, agent: op.agent, ...(op.reason ? { reason: op.reason } : {}),
        guards: (op.guards ?? []).map((g) => g.message), ...(op.system ? { system: true } : {}),
        needs: op.kind === "create" ? (m.collections[op.collection]?.setOf ? ["parentKey", "data"] : ["data"]) : op.kind === "update" ? ["key", "data", "expect?", "unset?"] : ["key", "expect?"],
      }])),
      calls: Object.fromEntries(Object.entries(m.calls ?? {}).map(([name, c]) => [name, {
        ...(c.canon ? { canon: c.canon, readOnly: false } : {}),
        label: c.label, args: jsonSchema(c.args ?? { type: "object", value: {} }), roles: c.roles, capability: c.capability ?? null, allowed: scope.admission(c, !readsOnly(c)) === null, agent: c.agent, ...(c.reason ? { reason: c.reason } : {}), ...(c.system ? { system: true } : {}),
        reads: Object.fromEntries(Object.entries(c.reads).map(([k, r]) => [k, "view" in r ? r.view : "report" in r ? `report.${r.report.collection}` : "aggregate" in r ? `aggregate.${r.aggregate.collection}` : "module" in r ? `${r.module} ${r.provide}` : "tree" in r ? `tree.${r.tree.nodes}` : "icpTree" in r ? `icpTree.${r.icpTree.icps}` : `canon.${r.canon}`])), writes: c.writes, returns: c.returns,
        ...(c.result ? { shownAs: c.result.kind } : {}),
      }])),
      exports: Object.fromEntries(Object.entries(m.exports ?? {}).map(([name, x]) => [name, {
        label: x.label, columns: x.columns?.map((c) => c.label) ?? [],
        ...("people" in x ? { people: x.people, dynamicColumns: true, args: { [x.people.key.arg]: "string" } } : "view" in x ? { view: x.view, args: m.views[x.view]?.args ?? {} } : { call: x.call, args: jsonSchema(m.calls?.[x.call]?.args ?? { type: "object", value: {} }) }),
      }])),
      // An agent imports by running the call with the rows itself; a person through the page's import flow.
      csvImports: Object.fromEntries(Object.entries(m.csvImports ?? {}).flatMap(([name, x]) => (m.calls?.[x.call] ? [[name, csvImportShape(x, m.calls[x.call])]] : []))),
      machines: Object.fromEntries(Object.entries(m.machines ?? {}).map(([name, mc]) => [name, {
        collection: mc.collection, field: mc.field, states: mc.states, initial: mc.initial,
        transitions: Object.fromEntries(Object.entries(mc.transitions).map(([tn, t]) => {
          const mode = agentModeOf(m, name, tn);
          return [tn, {
            label: t.label, from: t.from, roles: t.roles, capability: t.capability ?? null, allowed: scope.admission(t) === null, ...(t.system ? { system: true } : {}),
            to: t.to === undefined ? "the state it is in" : typeof t.to === "string" ? t.to : "restore" in t.to ? `the saved ${t.to.restore}, else ${t.to.fallback}` : `${t.to.cases.map((c) => c.to).join(" or ")} by case, else ${t.to.else}`,
            agent: mode.mode, ...(mode.reason ? { reason: mode.reason } : {}), guards: (t.guards ?? []).map((g) => g.message), args: jsonSchema(t.args ?? { type: "object", value: {} }),
          }];
        })),
      }])),
    };
  },
});

/** Run one of the module's views as the caller. */
export const view = query({
  args: { module: v.string(), view: v.string(), args: v.optional(v.record(v.string(), v.union(scalar, v.array(v.union(v.string(), v.number()))))) },
  handler: async (ctx, args) => (await scopeOrRefuse(ctx, args.module)).view(args.view, args.args ?? {}),
});

/** The docs a contribution reads per Canon page: past them, it says it shows only some. */
const CONTRIBUTION_ROWS = 1000;
/**
 * What the modules on in the caller's workspace add to one of Canon's own pages (docs/modules.md, "On Canon's pages"):
 * on the deals list, badges by deal id; on Settings > Team, columns of texts by member id. The one way a Canon page
 * reads module data (tests/moduleSurfaces.test.ts): each module's docs are read through its scope as the caller (the
 * member an admin views as, in a preview), so a contribution shows only the docs they read.
 */
export const contributions = query({
  args: { page: v.union(v.literal("deals"), v.literal("team"), v.literal("deal"), v.literal("company"), v.literal("person"), v.literal("people")), record: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const caller = await moduleScopeCaller(ctx);
    if (!caller) return [];
    type Panel = { id: string; title: string; path: string; replaces?: string; link: { label: string; path: string } | null };
    type Out = { module: string; title: string; partial: boolean; badges?: Record<string, Array<{ label: string; tone: string | null }>>; columns?: Array<{ label: string; filter: boolean; values: Record<string, string[]>; keys: Record<string, string> }>; panels?: Panel[]; record?: string; listActions?: readonly PeopleListAction[]; filterForms?: PeopleFilterForm[] };
    const out: Out[] = [];
    let members: Map<string, string> | null = null;
    const panelPage = a.page === "deal" || a.page === "company" || a.page === "person" ? a.page : null;
    // A deal's record page names it by its ledger stream; a module names a deal by its id, as `deals.*` read it.
    let record = a.record ?? "";
    if (panelPage === "deal" && record) {
      const stream = ctx.db.normalizeId("canonEntities", record);
      const entity = stream ? await ctx.db.get(stream) : null;
      if (entity && entity.orgId === caller.user.orgId && entity.projectionTable === "deals") record = entity.projectionId;
    }
    for (const { pkg, manifest } of await enabledModules(ctx, caller.user.orgId)) {
      if (!moduleRuntimeAvailable(manifest)) continue;
      const decl = panelPage ? manifest.contributes?.[`${panelPage}Page`] : manifest.contributes?.[a.page as "deals" | "team" | "people"];
      if (!decl && a.page !== "people") continue;
      const scope = await caller.enabledScope(pkg);
      if (!scope) continue;
      if (a.page === "people") {
        const filterForms = peopleFilterForms(manifest, scope.role);
        const listActions = (manifest.contributes?.people?.listActions ?? []).filter((x) => (!x.roles || x.roles.includes(scope.role)) && filterForms.some((f) => f.path === x.path && f.param === x.param));
        if (listActions.length || filterForms.length) out.push({ module: scope.slug, title: manifest.title, partial: false, listActions, filterForms });
        continue;
      }
      if (panelPage) {
        // A record page's panels: each served as the module's own page (panelPath), read there as the caller.
        const panels = (manifest.contributes?.[`${panelPage}Page`]?.panels ?? []).filter((p) => !p.roles || p.roles.includes(scope.role));
        if (panels.length && record) out.push({ module: scope.slug, title: manifest.title, partial: false, record, panels: panels.map((p) => ({ id: p.id, title: p.title, path: panelPath(panelPage, p.id), ...(p.replaces ? { replaces: p.replaces } : {}), link: p.link ?? null })) });
        continue;
      }
      const org = await ctx.db.get(scope.orgId);
      members ??= new Map((await workspaceMembers(ctx, scope.orgId)).map((u) => [u.id as string, u.name]));
      const textOf = (collection: string) => ({ binds: {}, members: members!, currency: org?.defaultCurrency ?? "USD", decimals: moneyDecimals(org?.currencyDecimals), rowLabels: labelsOf(manifest, collection), rowFormats: formatsOf(manifest, collection) });
      /** A view's docs as the caller reads them, with the refs its texts join; none when their role reads none. */
      const read = async (view: string, join: readonly string[] | undefined) => {
        const collection = manifest.views[view]?.collection ?? "";
        try {
          const rows = await scope.pageRows(view, {}, CONTRIBUTION_ROWS);
          const docs = join?.length ? (await scope.enrich(collection, rows.docs, join, {})).docs : rows.docs;
          return { docs: docs as TextDoc[], complete: rows.complete, collection };
        } catch { return { docs: [] as TextDoc[], complete: true, collection }; }
      };
      const entry: Out = { module: scope.slug, title: manifest.title, partial: false };
      if (a.page === "deals") {
        const badges: Record<string, Array<{ label: string; tone: string | null }>> = {};
        const reads = await Promise.all((manifest.contributes?.deals?.badges ?? []).map(async (b) => ({ b, r: await read(b.view, b.join) })));
        for (const { b, r } of reads) {
          if (!r.complete) entry.partial = true;
          for (const [deal, labels] of dealBadges(b, r.docs, { ...textOf(r.collection), ...(r.complete ? {} : { short: new Set(["docs"]) }) }, scope.userId)) {
            for (const label of labels) if (!(badges[deal] ??= []).some((x) => x.label === label)) badges[deal].push({ label, tone: b.tone ?? null });
          }
        }
        entry.badges = badges;
      } else {
        entry.columns = [];
        const reads = await Promise.all((manifest.contributes?.team?.columns ?? []).map(async (col) => ({ col, r: await read(col.view, col.join) })));
        for (const { col, r } of reads) {
          if (!r.complete) entry.partial = true;
          const values: Record<string, string[]> = {};
          // Each value's doc key (or `key` field), so a link may name it by key: ?plan=<plan key>.
          const keys: Record<string, string> = {};
          for (const d of r.docs) {
            const who = col.member === "owner" ? d.owner : d.data[col.member];
            if (typeof who !== "string" || (col.when && !rowWhenHolds(col.when, d, scope.userId))) continue;
            const text = renderText(col.value, { ...textOf(r.collection), row: d }).trim();
            if (text && !(values[who] ??= []).includes(text)) values[who].push(text);
            const k = col.key ? d.data[col.key] : d.key;
            if (text && typeof k === "string") keys[text] ??= k;
          }
          entry.columns.push({ label: col.label, filter: col.filter === true, values, keys });
        }
      }
      out.push(entry);
    }
    return out;
  },
});

/**
 * What a ref picker offers: members, deals or teams of the workspace, or docs of one of the module's collections,
 * matching `search`, each only as the caller may read it.
 */
export const pick = query({
  args: { module: v.string(), to: v.string(), collection: v.optional(v.string()), search: v.optional(v.string()), parent: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const scope = await scopeOrRefuse(ctx, args.module);
    if (!(REF_TARGETS as readonly string[]).includes(args.to)) throw new ConvexError(`A ref names ${REF_TARGETS.join(", ")}, not ${args.to}.`);
    if (args.to === "doc" && !scope.manifest.collections[args.collection ?? ""]) throw new ConvexError(`${scope.manifest.title} has no collection ${args.collection}.`);
    // `parent`: a ref that sits under a parent offers only that parent's set (docs/modules.md, "Collections").
    return scope.pick({ type: "ref", to: args.to as RefTo, ...(args.to === "doc" ? { collection: args.collection } : {}) }, (args.search ?? "").slice(0, 100), undefined, args.to === "doc" ? args.parent : undefined);
  },
});

/**
 * The field (a dotted path into an object: `config.rate`) of each doc, deal, member or team the asks name, as the caller
 * may read it, else null: a form's placeholder over a related doc ("Plan: 5%" on a rule's override).
 */
export const refValues = query({
  args: { module: v.string(), asks: v.array(v.object({ to: v.string(), collection: v.optional(v.string()), key: v.string(), field: v.string() })) },
  handler: async (ctx, a): Promise<Scalar[]> => {
    const scope = await scopeOrRefuse(ctx, a.module);
    if (a.asks.length > 20) throw new ConvexError("Ask for at most 20 values at once.");
    const out: Scalar[] = [];
    for (const x of a.asks) {
      if (!(REF_TARGETS as readonly string[]).includes(x.to)) throw new ConvexError(`A ref names ${REF_TARGETS.join(", ")}, not ${x.to}.`);
      if (x.to === "doc" && !scope.manifest.collections[x.collection ?? ""]) throw new ConvexError(`${scope.manifest.title} has no collection ${x.collection}.`);
      const got = await scope.joinedValues({ type: "ref", to: x.to as RefTo, ...(x.to === "doc" ? { collection: x.collection } : {}) }, x.field.slice(0, 81), [x.key]);
      out.push(got[x.key] ?? null);
    }
    return out;
  },
});

/** The fields of a company or person the module's install grants (`reads`), when it is on for the caller. */
export const recordGrants = internalQuery({
  args: { module: v.string(), to: v.union(v.literal("companies"), v.literal("people")) },
  handler: async (ctx, a): Promise<string[]> => [...((await scopeOrRefuse(ctx, a.module)).manifest.reads?.[a.to] ?? [])],
});

/** The most companies or people one `records` ask reads, and the most a picker offers. */
const RECORDS_MAX = 500;
const RECORD_PICKS = 20;
/** A record read with no ports: `records` reads companies and people by id, never activities or audiences. */
const NO_PORTS: RecordReadPorts = { edgesTo: async () => [], dealsOf: async () => ({}), addedTo: async () => [], snapshot: async () => { throw new ConvexError("No snapshot here."); } };

/**
 * Companies or people of the record service, as the caller reads them (docs/modules.md, "Refs"): those `ids` name,
 * with their name and the fields the install grants (what a page shows of a ref, its joins and its labels); or a
 * picker's options matching `search`, a company's people first when `company` names one. Only records the caller sees.
 */
export const records = action({
  args: { module: v.string(), to: v.union(v.literal("companies"), v.literal("people")), ids: v.optional(v.array(v.string())), search: v.optional(v.string()), company: v.optional(v.string()) },
  handler: async (ctx, a): Promise<Array<Record<string, unknown> & { id: string; label: string }>> => {
    const grants: string[] = await ctx.runQuery(internal.modules.recordGrants, { module: a.module, to: a.to });
    const { client, ws } = await recordReader(ctx);
    const withSuppression = a.to === "people" && grants.includes("suppression");
    const ports: RecordReadPorts = { ...NO_PORTS, suppressionCheck: (identifiers, purpose) => ctx.runQuery(internal.suppressions.checkIdentifiers, { orgId: ws as Id<"organizations">, identifiers, purpose }) };
    const fields = [...new Set(["name", ...grants.filter((f) => f !== "suppression")])];
    const people = async (options: Array<{ id: string; label: string }>) => {
      if (!withSuppression || !options.length) return options;
      const statuses = await readRecord(client, ws, ports, { read: "suppression.check", ids: options.map((r) => r.id), fields: [], since: null, limit: RECORD_PICKS, withSuppression: true });
      const byId = new Map(statuses.map((r) => [String(r.id), r]));
      return options.filter((r) => byId.has(r.id)).map((r) => {
        const status = byId.get(r.id)!;
        return { ...r, doNotContact: [status.email, status.linkedin, status.voice].some((c) => (c as { blocked: boolean }).blocked) };
      });
    };
    const object = a.to === "companies" ? "account" : "contact";
    if (a.ids) {
      if (a.ids.length > RECORDS_MAX) throw new ConvexError(`Ask for at most ${RECORDS_MAX} records at once.`);
      const read = a.to === "companies" ? "companies.byIds" : "people.byIds";
      const rows = await readRecord(client, ws, ports, { read, ids: [...new Set(a.ids)], fields, since: null, limit: RECORDS_MAX, withSuppression });
      return rows.map((r) => ({ ...r, id: String(r.id), label: String(r.name ?? "") }));
    }
    const q = (a.search ?? "").trim().slice(0, 100);
    if (a.to === "people" && a.company) {
      const page = await client.listContacts(ws, { filter: { accountId: a.company, ...(q ? { q } : {}) }, limit: RECORD_PICKS });
      return people(page.rows.map((r) => ({ id: r.id, label: r.fullName })));
    }
    if (!q) return people((await client.listRegister(ws, object, { limit: RECORD_PICKS })).rows.map((r) => ({ id: r.id, label: r.title })));
    return people((await client.searchObjects(ws, { q, objects: [object], limit: RECORD_PICKS })).hits.map((h) => ({ id: h.id, label: h.title })));
  },
});

/** A call widget's options: the Canon calls the caller reads, by title, the one it holds (`current`) first. */
export const pickCall = query({
  args: { module: v.string(), search: v.optional(v.string()), current: v.optional(v.string()) },
  handler: async (ctx, a) => pickCalls(ctx, await scopeOrRefuse(ctx, a.module), (a.search ?? "").slice(0, 100), a.current),
});

/** The values a text field marked `suggest` already holds in the docs the caller reads, most used first: its input's suggestions. */
export const suggest = query({
  // `dealField`: for a field whose suggestions are a deal field its sibling names, the deal field the sibling holds now.
  args: { module: v.string(), collection: v.string(), field: v.string(), search: v.optional(v.string()), dealField: v.optional(v.string()) },
  handler: async (ctx, a) => (await scopeOrRefuse(ctx, a.module)).suggest(a.collection, a.field, (a.search ?? "").slice(0, 100), a.dealField),
});

const opArgs = {
  module: v.string(), op: v.string(), key: v.optional(v.string()), parentKey: v.optional(v.string()), expect: v.optional(v.number()),
  data: v.optional(v.record(v.string(), v.any())), unset: v.optional(v.array(v.string())),
};
/** Run one of the module's ops as the caller: a create, an update of a doc's fields or a delete. */
export const op = mutation({
  args: opArgs,
  handler: async (ctx, args) => (await scopeOrRefuse(ctx, args.module)).op(args.op, { key: args.key, parentKey: args.parentKey, expect: args.expect, data: args.data, unset: args.unset }),
});

/** Admit new record refs through the record service; the original op mutation stays callable by older clients. */
export const writeOp = action({
  args: opArgs,
  handler: (ctx, a): Promise<OpResult> => admitRecords(ctx, (admit) => ctx.runMutation(internal.modules.applyOp, { ...a, admit })),
});
type OpResult = Awaited<ReturnType<ModuleScope["op"]>>;

/** An op as the caller, with the company and person refs its action admitted. */
export const applyOp = internalMutation({
  args: { ...opArgs, admit: admitV },
  handler: async (ctx, { admit, ...args }) => {
    const scope = await scopeOrRefuse(ctx, args.module, undefined, undefined, undefined, admit);
    return written(scope, scope.op(args.op, { key: args.key, parentKey: args.parentKey, expect: args.expect, data: args.data, unset: args.unset }));
  },
});

/**
 * Move a doc through one of the module's machines as the caller: the transition's roles, the doc's state, its
 * guards, then its writes and effects in this transaction. An agent's `propose` transition becomes a patch plan.
 */
export const transition = mutation({
  args: {
    module: v.string(), machine: v.string(), name: v.string(), key: v.string(), expect: v.number(),
    args: v.optional(v.record(v.string(), v.any())), reason: v.optional(v.string()),
    // Where the person ran it, signed by Canon's web server (lib/modules/evidence.ts): only its route sends one.
    evidence: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scope = await scopeOrRefuse(ctx, args.module);
    const evidence = args.evidence === undefined ? undefined
      : await verifyEvidence(args.evidence, { module: args.module, machine: args.machine, name: args.name, key: args.key, expect: args.expect }, (await ctx.auth.getUserIdentity())?.subject ?? null);
    return scope.transition(args.machine, args.name, { key: args.key, expect: args.expect, args: args.args, reason: args.reason, evidence });
  },
});

// ── Files (docs/modules.md, "Files") ──

/** Where the caller uploads a file for a file field: a person whose role writes one, never an agent. */
export const uploadUrl = mutation({
  args: { module: v.string() },
  handler: async (ctx, a): Promise<{ url: string }> => (await scopeOrRefuse(ctx, a.module)).uploadUrl(),
});

/** Whether an upload ticket still takes its file (lib/modules/uploadRoute.ts, before it stores the body). */
export const uploadTicket = internalQuery({
  args: { ticket: v.string(), secret: v.string() },
  handler: async (ctx, a): Promise<string | null> => ticketOpen(ctx, a.ticket, a.secret),
});

/** The file the upload route stored, recorded on its ticket as its person's. */
export const recordUpload = internalMutation({
  args: { ticket: v.string(), secret: v.string(), storageId: v.id("_storage"), name: v.string(), type: v.string(), bytes: v.number() },
  handler: async (ctx, a) => recordUploadOf(ctx, a),
});

/** A file a doc holds, with a link to download it, for a reader of the doc (canon_module file, a page's file link). */
export const fileUrl = query({
  args: { module: v.string(), collection: v.string(), key: v.string(), file: v.string() },
  handler: async (ctx, a) => (await scopeOrRefuse(ctx, a.module)).fileUrl(a.collection, a.key, a.file),
});

// ── Calls: the module's server code (docs/modules.md, "Server code") ──

/** A call's read plan, read as the caller in one query: one consistent snapshot, each doc with its version. */
export const callPlan = internalQuery({
  args: { module: v.string(), call: v.string(), args: v.record(v.string(), v.any()), system: v.optional(v.id("organizations")), as: v.optional(personV), canon: v.optional(v.boolean()), epoch: v.optional(v.number()) },
  handler: async (ctx, args): Promise<Snapshot> => (await scopeOrRefuse(ctx, args.module, args.system, args.as, args.epoch)).snapshot(args.call, args.args, args.canon ?? false),
});

/** Validate a completed computation without reading its plan again. */
export const callEpoch = internalQuery({
  args: { module: v.string(), epoch: v.number(), system: v.optional(v.id("organizations")), as: v.optional(personV) },
  handler: async (ctx, a): Promise<null> => {
    await scopeOrRefuse(ctx, a.module, a.system, a.as, a.epoch);
    return null;
  },
});

/**
 * A proposed call's writes checked as the agent's person, then rolled back: the mutation always throws, with
 * `{ dryRun: true }` once every write passed. Nothing it wrote survives.
 */
export const dryApply = internalMutation({
  args: { module: v.string(), call: v.string(), epoch: v.number(), intents: v.array(v.any()), admit: admitV },
  handler: async (ctx, a) => {
    const scope = await scopeOrRefuse(ctx, a.module, undefined, undefined, a.epoch, a.admit);
    await written(scope, scope.apply(a.call, a.intents as AppliedIntent[]));
    throw new ConvexError({ dryRun: true });
  },
});

/** A proposed call's writes as one patch plan, pending a person's approval. */
export const proposeCall = internalMutation({
  args: { module: v.string(), call: v.string(), epoch: v.number(), args: v.record(v.string(), v.any()), intents: v.array(v.any()), summary: v.string() },
  handler: async (ctx, a) => (await scopeOrRefuse(ctx, a.module, undefined, undefined, a.epoch)).proposeCall(a.call, a.args, a.intents as AppliedIntent[], a.summary),
});

/** A proposal's summary: `{$args.<field>}` and `{$value.<field>}` filled from the call's arguments and value. */
function proposalText(text: string, from: { args: Record<string, unknown>; value: unknown }) {
  return text.replace(/\{\$(args|value)\.([a-zA-Z0-9_.]+)(?:\|([a-z]+))?\}/g, (_, root: "args" | "value", path: string, format?: string) => {
    const v = path.split(".").reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), from[root]);
    if (typeof v === "number" && format === "money") return `$${(v / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    return v === undefined || v === null ? "" : String(v);
  });
}

/** One chunk of a replaceSet's new docs, under a generation readers don't see until applyCall publishes it. */
export const stageSet = internalMutation({
  args: { module: v.string(), call: v.string(), epoch: v.number(), collection: v.string(), parentKey: v.string(), gen: v.number(), offset: v.number(), docs: v.array(v.record(v.string(), v.any())), system: v.optional(v.id("organizations")), as: v.optional(personV), admit: admitV },
  handler: async (ctx, args) => {
    const scope = await scopeOrRefuse(ctx, args.module, args.system, args.as, args.epoch, args.admit);
    return written(scope, scope.stage(args.call, args.collection, args.parentKey, args.gen, args.docs, args.offset));
  },
});

/** A call's writes, each checked as the caller's own would be, in one transaction: all or none. */
const readAdmissionV = v.optional(v.object({ args: v.record(v.string(), v.any()), revision: v.string(), webPages: v.any(), canonFence: v.any(), fence: v.optional(v.string()) }));
export const applyCall = internalMutation({
  args: { module: v.string(), call: v.string(), epoch: v.number(), intents: v.array(v.any()), system: v.optional(v.id("organizations")), as: v.optional(personV), admit: admitV, readAdmission: readAdmissionV },
  handler: async (ctx, args) => {
    const scope = await scopeOrRefuse(ctx, args.module, args.system, args.as, args.epoch, args.admit);
    if (args.readAdmission) {
      const fresh = await scope.snapshot(args.call, args.readAdmission.args);
      if ((args.readAdmission.fence !== undefined && actionReadFence(fresh) !== args.readAdmission.fence) || fresh.revision !== args.readAdmission.revision || canonicalJson(fresh.webPages ?? {}) !== canonicalJson(args.readAdmission.webPages) || canonicalJson(fresh.canonFence ?? {}) !== canonicalJson(args.readAdmission.canonFence)) throw superseded();
    }
    return written(scope, scope.apply(args.call, args.intents as AppliedIntent[]));
  },
});

/** Delete a set generation no parent holds: the one a replaceSet retired, or one staged for a call that failed. */
export const dropGeneration = internalMutation({
  args: { module: v.string(), call: v.string(), epoch: v.number(), collection: v.string(), parentKey: v.string(), gen: v.number(), system: v.optional(v.id("organizations")), as: v.optional(personV) },
  handler: async (ctx, args) => (await scopeOrRefuse(ctx, args.module, args.system, args.as, args.epoch)).dropGeneration(args.call, args.collection, args.parentKey, args.gen, DROP_CHUNK),
});

type CallArgs = { module: string; call: string; args?: Record<string, unknown> };
type Applied = { writes: number; proposed: string[]; retired: Retired[] };

/**
 * A call's writes, applied by `apply`: a replaceSet's docs staged first, in chunks below Convex's argument limits, and
 * published by `apply` with the rest, so a reader sees the old set or the new one. The generations it retired, or
 * the staged ones when it failed or published nothing (null: a job key's run that came too late), are dropped only while the original epoch still serves.
 */
export async function stageAndApply(ctx: ActionCtx, a: { module: string; call: string; label: string; epoch: number }, system: Id<"organizations"> | undefined, intents: ReadonlyArray<Intent | AppliedIntent>, apply: (intents: AppliedIntent[], admit: Admit) => Promise<Applied | null>, person?: Person, stage?: (chunk: Retired & { offset: number; docs: Array<Record<string, unknown>> }, admit: Admit) => Promise<number>): Promise<Applied | null> {
  const as = system ? { system } : person ? { as: person } : {};
  const drop = (g: Retired) => ctx.runMutation(internal.modules.dropGeneration, { module: a.module, call: a.call, epoch: a.epoch, ...g, ...as });
  const dropAll = async (gens: readonly Retired[]) => { for (const g of gens) { try { while ((await drop(g)) === DROP_CHUNK); } catch { /* Leave rows when cleanup cannot prove they are retired. */ } } };
  const staged: Retired[] = [];
  const applied: AppliedIntent[] = [];
  let out: Applied | null;
  try {
    for (const it of intents) {
      if (it.op !== "replaceSet") { applied.push(it as AppliedIntent); continue; }
      if (!("docs" in it)) continue;
      const g = { collection: it.collection, parentKey: it.parentKey, gen: Date.now() * 1000 + Math.floor(Math.random() * 1000) };
      staged.push(g);
      let offset = 0;
      for (const docs of chunked(it.docs, STAGE_CHUNK, STAGE_BYTES)) {
        await admitRecords(ctx, (admit) => stage ? stage({ ...g, offset, docs }, admit) : ctx.runMutation(internal.modules.stageSet, { module: a.module, call: a.call, epoch: a.epoch, ...g, offset, docs, ...as, admit }), system, person);
        offset += docs.length;
      }
      const { docs: _docs, ...rest } = it;
      applied.push({ ...rest, gen: g.gen, count: it.docs.length });
    }
    if (JSON.stringify(applied).length > APPLY_BYTES) throw new ConvexError(`${a.label} returned more than ${APPLY_BYTES / 1e6} MB of writes besides its sets.`);
    out = await admitRecords(ctx, (admit) => apply(applied, admit), system, person);
  } catch (e) {
    // Nothing was published: the staged generations are no parent's, so they go.
    await dropAll(staged);
    throw e;
  }
  await dropAll(out ? out.retired : staged);
  return out;
}
/**
 * A call's three steps (docs/modules.md, "Server code"): its read plan (callPlan), the module's code in the recipe
 * runtime, in an isolate of its own for this workspace and principal, then its writes (applyCall). A replaceSet's
 * docs are staged first, in chunks, and published by applyCall with the rest, so a reader sees the old set or the
 * new one. `system`: as Canon in that workspace.
 */
async function runCall(ctx: ActionCtx, a: CallArgs, system?: Id<"organizations">, person?: Person & { credits: boolean }, epoch?: number, actionReads = true): Promise<{ writes: number; proposed: string[]; value?: unknown }> {
  const given = a.args ?? {};
  const who = person ? { orgId: person.orgId, userId: person.userId, ...(person.agent ? { agent: person.agent } : {}) } : undefined;
  const as = system ? { system } : who ? { as: who } : {};
  const snap: Snapshot = await ctx.runQuery(internal.modules.callPlan, { module: a.module, call: a.call, args: given, ...(epoch === undefined ? {} : { epoch }), ...as });
  // A background step reads as its member with no session: report reads and team aggregates read as a signed-in person.
  if (who && (Object.keys(snap.reports ?? {}).length || Object.keys(snap.aggregates ?? {}).length)) throw new ConvexError(`${snap.label} reads a report or a team aggregate, which runs only for a signed-in person.`);
  // A report read: an aggregate over every doc the caller reads, from the record service, as any report runs.
  const readAdmission = Object.keys(snap.meContexts ?? {}).length || Object.keys(snap.socialSearches ?? {}).length || Object.keys(snap.webPages ?? {}).length || Object.keys(snap.webSearches ?? {}).length || Object.keys(snap.marketSamples ?? {}).length || Object.keys(snap.canonFence ?? {}).length || Object.keys(snap.dealCompanies ?? {}).length ? { args: given, revision: snap.revision, webPages: snap.webPages ?? {}, canonFence: snap.canonFence ?? {}, fence: actionReadFence(snap) } : undefined;
  const reads = structuredClone(snap.reads);
  for (const [name, spec] of Object.entries(snap.reports ?? {})) {
    const run = await runReport(ctx, { module: a.module, spec });
    reads[name] = { groups: run.groups.map((g) => ({ keys: g.keys, values: g.values })), total: run.total, rows: run.rows, behind: run.behind } satisfies ReportReadValue;
  }
  for (const [name, spec] of Object.entries(snap.aggregates ?? {})) reads[name] = await runAggregate(ctx, { module: a.module, call: a.call, read: name, spec }, system);
  await readRecordsOf(ctx, snap, reads, system, who);
  // A territory tree (docs/modules.md, "Territories"): counted in the record service as the caller sees companies.
  await readTreesOf(ctx, snap, reads, system, who);
  if (snap.companyNames?.length) await fillCompanyNames(ctx, snap.companyNames.map((k) => reads[k] as Array<Record<string, unknown>>), system, who);
  await fillDealCompanies(ctx, snap, reads, who);
  await readActionSources(ctx, a.module, snap, reads, () => ctx.runQuery(internal.modules.callPlan, { module: a.module, call: a.call, args: given, epoch: snap.epoch, ...as }), actionReads && !system);
  // A hosted AI step: no code; the caller's model fills one doc, gated and written as the caller (lib/modules/ai.ts).
  if (snap.ai) {
    return runAiStep(ctx, { call: a.call, label: snap.label, run: snap.ai, reads, userId: snap.caller.userId, returns: snap.returns, credits: person ? person.credits : true },
      (intents) => stageAndApply(ctx, { ...a, label: snap.label, epoch: snap.epoch }, system, intents, (applied, admit) => ctx.runMutation(internal.modules.applyCall, { module: a.module, call: a.call, epoch: snap.epoch, intents: applied, ...as, admit, ...(readAdmission ? { readAdmission } : {}) }), who));
  }
  if (!snap.bundle) throw new ConvexError(`${snap.label}: the module has no server code installed.`);
  const result = await runModuleCall(ctx, snap.bundle, { isolate: snap.isolate, call: a.call, ctx: { now: Date.now(), caller: snap.caller, args: given, workspace: snap.workspace }, reads }).catch(async (error: unknown) => {
    if (isMissingBundle(error)) await ctx.runQuery(internal.modules.callEpoch, { module: a.module, epoch: snap.epoch, ...as }).catch((check: unknown) => { if (isSuperseded(check)) throw check; });
    throw error;
  });
  // A module that refuses on purpose (it threw its own sentence: "Pick the rep first") says it in its own words.
  if (!result.ok) throw new ConvexError(result.error.kind === "threw" ? `${snap.label}: ${result.error.message}` : `${snap.label} failed in the module's code (${result.error.kind}): ${result.error.message}`);
  const problems = outputProblems(result.value);
  if (problems.length) throw new ConvexError(`${snap.label} returned writes Canon can't apply: ${problems.slice(0, ERRORS_SHOWN).join("; ")}.`);
  const out = result.value as CallOutput;
  if (out.byKey) throw new ConvexError(`${snap.label} returned writes by job key; only a job's call does.`);
  // An agent's `propose` call (docs/modules.md, "Agents"): its writes are checked in a dry apply that writes nothing,
  // then wait as one patch plan; approving it applies them again as the approver.
  if (snap.propose && out.intents?.length) {
    const intents = out.intents as AppliedIntent[];
    if (intents.some((i) => i.op === "replaceSet")) throw new ConvexError(`${snap.label} replaces a set, which an approval can't apply; an agent can't propose it.`);
    if (intents.some((i) => i.op === "propose")) throw new ConvexError(`${snap.label} proposes Canon record writes of its own; an agent can't propose it as a call.`);
    try { await admitRecords(ctx, (admit) => ctx.runMutation(internal.modules.dryApply, { module: a.module, call: a.call, epoch: snap.epoch, intents, admit })); }
    catch (e) { if (!(e instanceof ConvexError && (e.data as { dryRun?: boolean } | null)?.dryRun === true)) throw e; }
    const summary = proposalText(snap.propose.summary, { args: given, value: out.value });
    const { proposed } = await ctx.runMutation(internal.modules.proposeCall, { module: a.module, call: a.call, epoch: snap.epoch, args: given, intents, summary });
    return { writes: 0, proposed: [proposed], ...(snap.returns === "value" && out.value !== undefined ? { value: out.value } : {}) };
  }
  if (!out.intents?.length) await ctx.runQuery(internal.modules.callEpoch, { module: a.module, epoch: snap.epoch, ...as });
  // A call that returned no writes doesn't open a mutation: a read-only call runs in a "view as" preview, which none passes.
  const applied = !out.intents?.length ? { writes: 0, proposed: [] }
    : (await stageAndApply(ctx, { ...a, label: snap.label, epoch: snap.epoch }, system, await withProposedRows(ctx, a.module, snap.label, system, out.intents), (intents, admit) => ctx.runMutation(internal.modules.applyCall, { module: a.module, call: a.call, epoch: snap.epoch, intents, ...as, admit, ...(readAdmission ? { readAdmission } : {}) }), who));
  if (!applied) throw superseded();
  return { writes: applied.writes, proposed: applied.proposed, ...(snap.returns === "value" && out.value !== undefined ? { value: out.value } : {}) };
}

/** The most proposals one call makes. */
const PROPOSALS_PER_CALL = 5;

export const meetingProposalRows = internalQuery({
  args: { module: v.string(), args: v.any() },
  handler: async (ctx, args): Promise<ProposalRow[]> => {
    const scope = await scopeOrRefuse(ctx, args.module);
    if (!scope.manifest.proposes?.includes("meetings.log")) throw new ConvexError("The module does not declare meetings.log");
    const user = await requireUser(ctx);
    if (await agentClientOf(ctx)) throw new ConvexError("Only a person can propose a meeting");
    return [await meetingProposalRow(ctx, user.orgId, await accessFor(ctx, user), args.args as MeetingLogArgs)];
  },
});
/**
 * A call's intents with each `propose` given the records it would change (docs/modules.md, "Writes to Canon records"),
 * listed here, in the action, from the record service as the caller reads them. Canon's own calls (jobs, schedules)
 * list them as the admin whose standing grant covers the operation, or none without one: the apply then refuses the
 * proposal, which is a person's, or drops an optional one.
 */
export async function withProposedRows(ctx: ActionCtx, module: string, label: string, system: Id<"organizations"> | undefined, intents: readonly Intent[]): Promise<Array<Intent | AppliedIntent>> {
  const proposals = intents.filter((it) => it.op === "propose");
  if (!proposals.length) return [...intents];
  if (proposals.length > PROPOSALS_PER_CALL) throw new ConvexError(`${label} proposes ${proposals.length} writes; a call proposes at most ${PROPOSALS_PER_CALL}.`);
  const caller = system ? null : await requireCaller(ctx);
  return Promise.all(intents.map(async (it) => {
    if (it.op !== "propose") return it;
    if (it.operation === "meetings.log") {
      if (system) throw new ConvexError("Canon's background calls cannot propose meetings");
      return { ...it, rows: await ctx.runQuery(internal.modules.meetingProposalRows, { module, args: it.args }) };
    }
    // Canon's own call lists the records as the admin whose standing grant would approve it, if one is live.
    const who = caller ?? await (async () => {
      const userId = await ctx.runQuery(internal.moduleGrants.grantorFor, { orgId: system!, module, operation: it.operation });
      return userId ? { orgId: system as string, userId, access: await ctx.runQuery(internal.moduleAi.accessOf, { orgId: system!, userId }) } : null;
    })();
    return { ...it, rows: who ? await expandProposal(callerClient(ctx, who), who.orgId, it.operation, it.args, label,
      (year) => ctx.runQuery(internal.targets.planOf, { orgId: who.orgId as Id<"organizations">, year })) : [] };
  }));
}

/**
 * A team aggregate (docs/modules.md, "Team aggregates"): every doc of its collection that passes its filter, grouped by
 * owner in the record service (or folded in Convex by the fake), then folded by `teamAggregate`, which withholds it
 * below its owners. The one way an aggregate is made: the module's code gets only what `teamAggregate` returns.
 */
async function runAggregate(ctx: ActionCtx, a: { module: string; call: string; read: string; spec: AggregateSpec }, system?: Id<"organizations">): Promise<AggregateReadValue> {
  const args = { module: a.module, call: a.call, read: a.read, ...(system ? { system } : {}) };
  let plan = await ctx.runQuery(internal.modules.aggregatePlan, args);
  const request = { filter: a.spec.filter, groupBy: [{ field: a.spec.owner }], measures: aggregateMeasures(a.spec) };
  const client = clientFor(ctx);
  if (client.mode === "http") {
    await ctx.runMutation(internal.moduleJobs.initializeReports, { orgId: plan.orgId as Id<"organizations">, moduleId: plan.moduleId });
    plan = await ctx.runQuery(internal.modules.aggregatePlan, args);
    requireReportReady(plan);
  }
  const res: AggregateResponse = client.mode === "http"
    ? await client.moduleAggregate(plan.orgId, { module: plan.moduleId, collection: a.spec.collection, fields: plan.fields, docScope: null, projection: plan.projection!, ...request })
    : await ctx.runQuery(internal.modules.aggregateInMemory, { module: a.module, call: a.call, read: a.read, fields: plan.fields, request, ...(system ? { system } : {}) });
  if (client.mode === "http") {
    const after = await ctx.runQuery(internal.modules.aggregatePlan, args);
    requireReportReady(after);
    if (!sameProjection(plan.projection, after.projection)) reportSyncing();
  }
  return teamAggregate(a.spec, res.groups);
}

/** What a team aggregate reads: its collection's report fields with its owner field, checked as the caller's call. */
export const aggregatePlan = internalQuery({
  args: { module: v.string(), call: v.string(), read: v.string(), system: v.optional(v.id("organizations")) },
  handler: async (ctx, a) => {
    const scope = await scopeOrRefuse(ctx, a.module, a.system);
    const r = scope.manifest.calls?.[a.call]?.reads[a.read];
    if (!r || !("aggregate" in r)) throw new ConvexError(`${a.call} has no aggregate ${a.read}.`);
    const c = scope.manifest.collections[r.aggregate.collection];
    const own = reportFields(c, scope.manifest).filter((f) => !f.join).map(({ ref: _r, join: _j, ...f }) => f);
    const fields = own.some((f) => f.name === c.owner) ? own : [...own, { name: c.owner!, label: c.owner!, type: "user" as const }];
    return { orgId: scope.orgId as string, moduleId: scope.moduleId, fields, ...await reportProjection(ctx, scope) };
  },
});

/** A team aggregate folded in Convex: the fake record client's, over every doc of the collection (at most 5,000). */
export const aggregateInMemory = internalQuery({
  args: { module: v.string(), call: v.string(), read: v.string(), fields: v.array(v.any()), request: v.any(), system: v.optional(v.id("organizations")) },
  handler: async (ctx, a): Promise<AggregateResponse> => {
    const scope = await scopeOrRefuse(ctx, a.module, a.system);
    const r = scope.manifest.calls?.[a.call]?.reads[a.read];
    if (!r || !("aggregate" in r)) throw new ConvexError(`${a.call} has no aggregate ${a.read}.`);
    const object = r.aggregate.collection;
    const fields = a.fields as ModuleReportField[];
    const q = compileAggregateRequest(object, moduleReportDef(object, fields), a.request as Parameters<typeof compileAggregateRequest>[2], () => undefined);
    const docs = await scope.aggregateDocs(a.call, a.read, FAKE_REPORT_DOCS);
    return aggregateRowsInMemory(q, docs.map((d) => moduleListRow(object, fields, d)), () => new Map(), {});
  },
});

/**
 * Each deal of the reads named with its company's name in place of its id (canonReads.ts `companyName`): the
 * register's, as the caller may read the company (Canon's own calls: any), else null.
 */
async function fillCompanyNames(ctx: ActionCtx, lists: ReadonlyArray<Array<Record<string, unknown>> | null | undefined>, system?: Id<"organizations">, person?: Person) {
  const deals = lists.flatMap((l) => (Array.isArray(l) ? l : []));
  // A CRM account's name came with the read (canonReads.ts `{ crm }`); a register company's id is read here.
  const ids = [...new Set(deals.map((d) => d.companyName).filter((x): x is string => typeof x === "string" && x.length > 0))];
  let names: Record<string, string> = {};
  if (ids.length) {
    const { client, ws } = await recordReader(ctx, system, person);
    names = await accountNamesFor(client, ws, ids);
  }
  for (const d of deals) {
    const v = d.companyName;
    d.companyName = typeof v === "string" ? names[v] ?? null : v !== null && typeof v === "object" && typeof (v as { crm?: unknown }).crm === "string" ? (v as { crm: string }).crm : null;
  }
}

async function fillDealCompanies(ctx: ActionCtx, snap: Snapshot, reads: Record<string, ReadValue>, person?: Person) {
  for (const [name, fields] of Object.entries(snap.dealCompanies ?? {})) {
    const deals = reads[name] as Array<Record<string, unknown>>;
    const ids = [...new Set(deals.flatMap((d) => typeof d.companyId === "string" ? [d.companyId] : []))];
    if (!ids.length || !fields.length) continue;
    const { client, ws } = await recordReader(ctx, undefined, person);
    const companies = await readRecord(client, ws, NO_PORTS, { read: "companies.byIds", ids, fields, since: null, limit: 30 });
    const byId = new Map(companies.map((c) => [c.id, c]));
    for (const deal of deals) deal.company = byId.get(deal.companyId) ?? null;
  }
}

const canonAuthorizationV = v.object({ orgId: v.id("organizations"), packageId: v.id("modulePackages"), call: v.string(), input: v.string(), operation: v.string(), userId: v.id("users"), moduleId: v.string(), epoch: v.number(), revision: v.optional(v.string()) });

export const callDispatch = internalQuery({
  args: { module: v.string(), call: v.string(), args: v.record(v.string(), v.any()) },
  handler: async (ctx, a): Promise<CanonCallAuthorization | null> => {
    const scope = await scopeOrRefuse(ctx, a.module);
    return scope.manifest.calls?.[a.call]?.canon ? scope.authorizeCanonCall(a.call, a.args) : null;
  },
});

export const executeCanonCall = internalMutation({
  args: { module: v.string(), call: v.string(), args: v.record(v.string(), v.any()), authorization: canonAuthorizationV, encryptedSecret: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ writes: number; proposed: string[]; value?: unknown }> => {
    const scope = await scopeOrRefuse(ctx, a.module, undefined, undefined, a.authorization.epoch);
    const fresh = await scope.authorizeCanonCall(a.call, a.args);
    if (fresh.orgId !== a.authorization.orgId || fresh.packageId !== a.authorization.packageId || fresh.call !== a.authorization.call || fresh.input !== a.authorization.input || fresh.userId !== a.authorization.userId || fresh.moduleId !== a.authorization.moduleId || fresh.operation !== a.authorization.operation || fresh.revision !== a.authorization.revision) throw superseded();
    if (a.encryptedSecret !== undefined && fresh.operation !== "agents.rotateSecret") throw new ConvexError("Unexpected Canon preparation.");
    const input = await scope.canonInput(a.call, a.args);
    const value = await executeCanonOperation(ctx, fresh.operation, input, a.encryptedSecret === undefined ? undefined : { operation: "agents.rotateSecret", encryptedSecret: a.encryptedSecret });
    const transition = await written(scope, scope.finishCanonCall(a.call, a.args, value));
    return { writes: transition ? 2 : 1, proposed: [], ...(scope.manifest.calls![a.call].returns === "value" ? { value: transition ? { ...(value as { jobId: string }), transition } : value } : {}) };
  },
});

export const prepareCanonSecret = internalAction({
  args: { module: v.string(), call: v.string(), args: v.record(v.string(), v.any()), authorization: canonAuthorizationV },
  handler: async (ctx, a): Promise<{ writes: number; proposed: string[]; value?: unknown }> => {
    if (a.authorization.operation !== "agents.rotateSecret") throw new ConvexError("Unsupported Canon preparation.");
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    const encryptedSecret = await encryptToken(secret);
    const out = await ctx.runMutation(internal.modules.executeCanonCall, { ...a, encryptedSecret });
    return { ...out, ...(out.value !== undefined ? { value: [{ ...(out.value as { url: string }), secret }] } : {}) };
  },
});

/** Run one of the module's calls as the caller. */
export const call = action({
  args: { module: v.string(), call: v.string(), args: v.optional(v.record(v.string(), v.any())) },
  handler: async (ctx, a): Promise<{ writes: number; proposed: string[]; value?: unknown }> => {
    const authorization: CanonCallAuthorization | null = await ctx.runQuery(internal.modules.callDispatch, { ...a, args: a.args ?? {} });
    if (!authorization) return runCall(ctx, a);
    const input = { ...a, args: a.args ?? {}, authorization };
    return authorization.operation === "agents.rotateSecret"
      ? ctx.runAction(internal.modules.prepareCanonSecret, input)
      : ctx.runMutation(internal.modules.executeCanonCall, input);
  },
});

// ── Hosted AI steps a move starts (docs/modules.md, "Hosted AI steps"): in the background, as a member ──

/** What a queued AI call needs: the argument its doc's key goes in, and its label. */
export const aiQueue = internalQuery({
  args: { orgId: v.id("organizations"), module: v.string(), call: v.string(), key: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ arg: string; label: string; epoch: number; migrating: string | null; revision: string; next?: string; pure?: boolean; retained?: boolean; version?: number } | null> => {
    const scope = await scopeOrRefuse(ctx, a.module, a.orgId);
    const call = scope.manifest.calls?.[a.call];
    const key = call?.step ? { arg: call.step.key } : call?.ai?.output.key;
    const queue = call?.step ?? call?.ai?.queue;
    const doc = queue && a.key ? await scope.peek(scope.manifest.machines![queue.machine].collection, a.key) : null;
    return queue && key !== null && typeof key === "object" && "arg" in key ? { arg: key.arg, label: call!.label, epoch: scope.epoch, migrating: scope.migrating, revision: scope.revision, ...(call?.step ? { next: a.call, pure: true, retained: true } : call?.ai?.queue?.next ? { next: call.ai.queue.next, retained: true } : {}), ...(doc ? { version: doc.version } : {}) } : null;
  },
});

/** Fresh transactional completion reads as the retained starter, bound to this answer and package. */
export const aiCompletionPlan = internalQuery({
  args: { module: v.string(), call: v.string(), key: v.string(), as: personV, epoch: v.number(), revision: v.string(), expect: v.number() },
  handler: async (ctx, a): Promise<Snapshot> => {
    const scope = await scopeOrRefuse(ctx, a.module, undefined, a.as, a.epoch);
    if (scope.revision !== a.revision) throw superseded();
    const queued = scope.manifest.calls?.[a.call];
    const queue = queued?.step ?? queued?.ai?.queue;
    const doc = queue ? await scope.peek(scope.manifest.machines![queue.machine].collection, a.key) : null;
    if (!doc || doc.version !== a.expect) throw superseded();
    return scope.completionSnapshot(a.call, a.key);
  },
});

export const aiRun = internalAction({
  args: { orgId: v.id("organizations"), module: v.string(), call: v.string(), key: v.string(), userId: v.optional(v.id("users")), credits: v.boolean(), agent: v.optional(v.string()), revision: v.optional(v.string()), expect: v.optional(v.number()) },
  handler: async (ctx, a): Promise<null> => {
    const q = await ctx.runQuery(internal.modules.aiQueue, { orgId: a.orgId, module: a.module, call: a.call, key: a.key });
    if (!q) return null;
    if (q.next && (a.revision !== q.revision || a.expect !== q.version)) return null;
    if (q.migrating) { await ctx.scheduler.runAfter(60_000, internal.modules.aiRun, a); return null; }
    let error: string | undefined;
    let expect = q.version;
    let completion: { intents: Intent[]; revision: string; fence: string } | undefined;
    try {
      if (!a.userId) throw new ConvexError(`${q.label} runs as the doc's owner, and it has none.`);
      if (!q.pure) await runCall(ctx, { module: a.module, call: a.call, args: { [q.arg]: a.key } }, undefined, { orgId: a.orgId, userId: a.userId, ...(a.agent ? { agent: a.agent } : {}), credits: a.credits }, q.epoch);
      if (q.next) {
        expect = q.version! + (q.pure ? 0 : 1);
        const snap: Snapshot = await ctx.runQuery(internal.modules.aiCompletionPlan, { module: a.module, call: a.call, key: a.key, expect: expect!, revision: q.revision, epoch: q.epoch, as: { orgId: a.orgId, userId: a.userId, ...(a.agent ? { agent: a.agent } : {}) } });
        if (snap.revision !== q.revision) throw superseded();
        if (!snap.bundle) throw new ConvexError("The completion has no server code.");
        if (Object.values({ ...snap.reports, ...snap.aggregates, ...snap.records, ...snap.researchAnswers, ...snap.markets, ...snap.trees, ...snap.icpTrees }).length || snap.companyNames.length) throw new ConvexError("A completion requires own views and declared bounded action reads.");
        const fence = actionReadFence(snap);
        const reads = structuredClone(snap.reads);
        await readActionSources(ctx, a.module, snap, reads, () => ctx.runQuery(internal.modules.aiCompletionPlan, { module: a.module, call: a.call, key: a.key, expect: expect!, revision: q.revision, epoch: q.epoch, as: { orgId: a.orgId, userId: a.userId!, ...(a.agent ? { agent: a.agent } : {}) } }));
        const result = await runModuleCall(ctx, snap.bundle, { isolate: snap.isolate, call: q.next, ctx: { now: Date.now(), caller: snap.caller, args: { [q.arg]: a.key }, workspace: snap.workspace }, reads });
        if (!result.ok) throw new ConvexError(`Completion refused: ${result.error.message}`);
        if (outputProblems(result.value).length) throw new ConvexError("Completion returned invalid writes.");
        const out = result.value as CallOutput;
        if (out.byKey || !out.intents?.length || out.intents.some((it) => ["replaceSet", "propose", "dirty", "notify", "send"].includes(it.op))) throw new ConvexError("Completion requires ordinary module writes.");
        completion = { intents: out.intents, revision: snap.revision, fence };
      }
    } catch (e) { error = moduleErrorMessage(e).slice(0, 500); }
    const finish = (reason?: string) => admitRecords(ctx, (admit) => ctx.runMutation(internal.modules.aiFinish, {
      orgId: a.orgId, module: a.module, call: a.call, key: a.key, epoch: q.epoch,
      ...(a.userId ? { userId: a.userId } : {}), ...(a.agent ? { agent: a.agent } : {}), ...(q.next ? { revision: q.revision, expect } : {}),
      ...(reason ? { error: reason } : completion ? { completion } : {}), admit,
    }), undefined, a.userId ? { orgId: a.orgId, userId: a.userId } : undefined);
    let finished: boolean;
    try { finished = await finish(error); }
    catch (e) {
      // The refused completion and success move rolled back together. Record failure in a fresh transaction.
      if (error) throw e;
      finished = await finish(moduleErrorMessage(e).slice(0, 500));
    }
    if (!finished && !q.next) await ctx.scheduler.runAfter(0, internal.modules.aiRun, a);
    return null;
  },
});

/** Semantic completion writes run as the starter. Only the terminal machine move runs as Canon. */
export const aiFinish = internalMutation({
  args: { orgId: v.id("organizations"), module: v.string(), call: v.string(), key: v.string(), epoch: v.number(), userId: v.optional(v.id("users")), agent: v.optional(v.string()), error: v.optional(v.string()), revision: v.optional(v.string()), expect: v.optional(v.number()), completion: v.optional(v.object({ intents: v.array(v.any()), revision: v.string(), fence: v.string() })), admit: admitV },
  handler: async (ctx, a): Promise<boolean> => {
    const scope = await scopeOrRefuse(ctx, a.module, a.orgId);
    const call = scope.manifest.calls?.[a.call];
    const queue = call?.step ?? call?.ai?.queue;
    const retained = Boolean(call?.step || call?.ai?.queue?.next);
    if (!queue) return true;
    if (scope.epoch !== a.epoch || scope.migrating || (retained && scope.revision !== a.revision)) return false;
    const mc = scope.manifest.machines![queue.machine];
    const doc = await scope.peek(mc.collection, a.key);
    if (!doc || (retained && doc.version !== a.expect)) return true;
    const failed = mc.transitions[queue.fail];
    if (!failed.from.includes(String(doc.data[mc.field]))) return true;
    let error = a.error;
    const person = a.userId ? await personScope(ctx, a.orgId, a.userId, a.module, a.admit, a.agent ?? null) : null;
    if (call?.capability || retained) {
      const blocked = person ? person.admission(call!, retained) : "The member who started this AI step is no longer authorized.";
      if (blocked) error = blocked;
    }
    if (!error && retained) {
      if (!person || !a.completion || a.completion.revision !== scope.revision) throw new ConvexError("The initiating member completion is missing or superseded.");
      const snap = await person.completionSnapshot(a.call, a.key);
      if (actionReadFence(snap) !== a.completion.fence) throw superseded();
      const intents = a.completion.intents as Intent[];
      if (!intents.length || intents.some((it) => ["replaceSet", "propose", "dirty", "notify", "send"].includes(it.op))) throw new ConvexError("Invalid completion intents.");
      await written(person, person.complete(a.call, intents as AppliedIntent[]));
    }
    // Re-read after the member writes. The transition may itself refuse, rolling back every completion write.
    const fresh = await scope.peek(mc.collection, a.key);
    if (!fresh) throw new ConvexError("The completion removed its waiting document.");
    const then = call?.ai?.queue?.then;
    if (!error && !then && String(fresh.data[mc.field]) === String(doc.data[mc.field])) throw new ConvexError("The member completion did not advance its waiting state.");
    if (error || then) await scope.transition(queue.machine, error ? queue.fail : then!, { key: a.key, expect: fresh.version, ...(error ? { reason: error, ...(failed.args ? { args: { error } } : {}) } : {}) });
    const logFailure = call?.step?.logFailure ?? call?.ai?.queue?.logFailure;
    if (error && logFailure) {
      const raw = String(doc.data[logFailure.domain] ?? "");
      const domain = raw ? webPagesRequest({ domain: raw }).domain! : "";
      await logResearchFailure(ctx, { orgId: scope.orgId, domain, stage: logFailure.stage, message: error, detail: `${a.module} ${a.call}: ${error}`.slice(0, 2000) });
    }
    return true;
  },
});

// ── Canon as itself: what a manifest marks `system`, for jobs (M4b). Internal only: no person or agent reaches these. ──

/** Run a system call as Canon in a workspace, in its system isolate, reading every doc. */
export const systemCall = internalAction({
  args: { orgId: v.id("organizations"), module: v.string(), call: v.string(), args: v.optional(v.record(v.string(), v.any())) },
  handler: async (ctx, a): Promise<{ writes: number; proposed: string[]; value?: unknown }> => runCall(ctx, a, a.orgId),
});

/** Run a system transition as Canon: its state, guards, writes and effects, as "System" in the doc's history. */
export const systemTransition = internalMutation({
  args: { orgId: v.id("organizations"), module: v.string(), machine: v.string(), name: v.string(), key: v.string(), expect: v.number(), args: v.optional(v.record(v.string(), v.any())), reason: v.optional(v.string()) },
  handler: async (ctx, a) => (await scopeOrRefuse(ctx, a.module, a.orgId)).transition(a.machine, a.name, { key: a.key, expect: a.expect, args: a.args, reason: a.reason }),
});

/** Run a system op as Canon. */
export const systemOp = internalMutation({
  args: { orgId: v.id("organizations"), module: v.string(), op: v.string(), key: v.optional(v.string()), parentKey: v.optional(v.string()), expect: v.optional(v.number()), data: v.optional(v.record(v.string(), v.any())), unset: v.optional(v.array(v.string())) },
  handler: async (ctx, a) => (await scopeOrRefuse(ctx, a.module, a.orgId)).op(a.op, { key: a.key, parentKey: a.parentKey, expect: a.expect, data: a.data, unset: a.unset }),
});

const shareArgs = { module: v.string(), share: v.string(), key: v.string() };
const issueArgs = { ...shareArgs, to: v.object({ name: v.optional(v.string()), email: v.optional(v.string()), contactId: v.optional(v.string()) }), emails: v.optional(v.array(v.string())), identity: v.optional(v.union(v.literal("link"), v.literal("email"))), expiresDays: v.optional(v.number()) };
const roomSourceV = v.object({ deal: v.union(v.string(), v.null()), company: v.union(v.string(), v.null()) });
const roomDealV = v.object({ id: v.string(), streamId: v.string(), companyId: v.string() });
const roomTargetV = v.union(v.null(), v.object({ source: roomSourceV, deal: v.union(v.null(), roomDealV) }));
const issuePlanV = v.object({ orgId: v.id("organizations"), userId: v.string(), accessHash: v.string(), epoch: v.number(), version: v.number(), createdAt: v.number(), policyHash: v.string(), target: roomTargetV });
const roomAttributionV = v.union(v.null(), v.object({ accountId: v.string(), domain: v.string(), source: roomSourceV, deal: v.optional(roomDealV), contact: v.optional(v.object({ id: v.string(), email: v.string() })) }));
export const issueLinkPlan = internalQuery({
  args: issueArgs,
  handler: async (ctx, a): Promise<IssueSharePlan> => {
    const scope = await moduleScope(ctx, a.module);
    if (!scope) throw notOn(a.module);
    return planShareLink(ctx, scope, a);
  },
});
export const issueLinkCommit = internalMutation({
  args: { ...issueArgs, plan: issuePlanV, attribution: roomAttributionV },
  handler: async (ctx, a) => {
    const scope = await moduleScope(ctx, a.module);
    if (!scope) throw notOn(a.module);
    return issueShareLink(ctx, scope, a, a.plan, a.attribution);
  },
});
export const issueLink = action({
  args: issueArgs,
  handler: async (ctx, a): Promise<{ url: string; publicId: string; expiresAt: number }> => {
    const caller = await requireCaller(ctx);
    const plan: IssueSharePlan = await ctx.runQuery(internal.modules.issueLinkPlan, a);
    if (caller.orgId !== plan.orgId || caller.userId !== plan.userId || await sha256(canonicalJson(caller.access)) !== plan.accessHash) throw new ConvexError("The issuing member changed. Refresh and try again.");
    const attribution = await resolveRoomAttribution(callerClient(ctx, caller), caller.orgId, plan.target, a.to);
    return ctx.runMutation(internal.modules.issueLinkCommit, { ...a, plan, attribution });
  },
});
export const links = query({
  args: shareArgs,
  handler: async (ctx, a) => {
    const scope = await moduleScope(ctx, a.module);
    if (!scope) throw notOn(a.module);
    return shareLinks(ctx, scope, a);
  },
});
export const revokeLink = mutation({
  args: { ...shareArgs, publicId: v.string() },
  handler: async (ctx, a) => {
    const scope = await moduleScope(ctx, a.module);
    if (!scope) throw notOn(a.module);
    return changeShareLink(ctx, scope, a, "revoke");
  },
});
export const extendLink = mutation({
  args: { ...shareArgs, publicId: v.string(), days: v.number() },
  handler: async (ctx, a) => {
    const scope = await moduleScope(ctx, a.module);
    if (!scope) throw notOn(a.module);
    return changeShareLink(ctx, scope, a, "extend");
  },
});
export const previewShare = query({
  args: { ...shareArgs, path: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const scope = await moduleScope(ctx, a.module);
    if (!scope) throw notOn(a.module);
    return previewSharePage(ctx, scope, a);
  },
});

/**
 * One page of a module as the caller sees it: the page's nodes their role sees, the docs its bindings read, each
 * op's fields with the widget the form shows, the tabs under the module's nav entry and the workspace's members (for
 * owner names and member pickers). Null when the module isn't on; `page` null when the path names no page for them.
 */
export const page = query({
  args: {
    module: v.string(), path: v.array(v.string()),
    // The URL's parameters (`?period=`), which bindings and job status lines may read, and "Show more" per binding.
    query: v.optional(v.record(v.string(), v.string())), limits: v.optional(v.record(v.string(), v.number())),
  },
  handler: async (ctx, args) => {
    // For the seconds an upgrade's cutover swaps its migrated docs in, the page says so rather than failing.
    const caller = await callerOf(ctx);
    const pkg = caller ? await installedModule(ctx, caller.user.orgId, args.module) : null;
    if (pkg && cuttingOver(pkg)) return { upgrading: { title: manifestOf(pkg).title, version: pkg.pending!.version } };
    const scope = await moduleScope(ctx, args.module);
    if (!scope) return null;
    const m = scope.manifest;
    const sees = (roles: readonly Role[] | undefined) => !roles || roles.includes(scope.role);
    // The role's tab set: the tabs of the pages it sees, each narrowed by its own roles.
    const tabs = m.pages.filter((p) => p.tab && sees(p.roles) && sees(p.tab.roles)).sort((a, b) => a.tab!.order - b.tab!.order).map((p) => ({ label: p.tab!.label, path: p.path }));
    const org = await ctx.db.get(scope.orgId);
    // Each member's role as a module names roles (a workspace's own role reads as its base): a thread's author tags.
    const bases = await roleBasesOf(ctx, scope.orgId);
    const base = {
      runtimeAvailable: moduleRuntimeAvailable(m),
      module: { id: m.id, slug: scope.slug, title: m.title, nav: navOf(m) }, dashboards: dashboardPage(m, scope.role)?.path ?? null, role: scope.role, userId: scope.userId, orgId: scope.orgId as string, tabs,
      // In an admin's "view as" preview: why every write on the page shows disabled (the server refuses them anyway).
      preview: scope.preview === null ? null : `Viewing as ${scope.preview}: actions are off`,
      currency: org?.defaultCurrency ?? "USD", decimals: moneyDecimals(org?.currencyDecimals), members: (await workspaceMembers(ctx, scope.orgId)).map((u) => ({ id: u.id as string, name: u.name, role: baseRole(u.role, bases) })),
      // Members who have left the workspace: a member picker lists them under Inactive (a plan's past reps).
      inactive: (await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", scope.orgId)).take(500)).filter((u) => !u.isActive && !u.isHidden).map((u) => ({ id: u._id as string, name: u.name })),
      // The month the workspace's fiscal year starts in: a stepper over this fiscal year, FY labels, fiscal month columns.
      fiscalYearStartMonth: org?.fiscalYearStartMonth ?? 1,
    };
    // The module's root lands each role on its own page, else on the first tab it sees.
    const landing = landingFor(m, scope.role);
    const home = m.pages.find((p) => p.path === landing && sees(p.roles)) ? landing : tabs[0]?.path ?? landing;
    const hit = matchPage(pagesOf(m), args.path.length ? args.path : home.split("/"));
    if (!hit || !sees(hit.page.roles)) return { ...base, page: null };
    try {
      const given = args.query ?? {};
      const value = (x: PageExpr): Scalar => (x === null || typeof x !== "object" ? x : "route" in x ? hit.params[x.route] ?? null
        : "query" in x ? (Object.hasOwn(given, x.query) && given[x.query] !== "" ? given[x.query] : x.default ?? null) : scope.userId);
      const data: Record<string, unknown> = {};
      if (JSON.stringify(hit.page).includes("{$objects.")) data.objects = {
        key: "objects", version: 0, owner: null, data: Object.fromEntries((await objectNames(ctx, scope.orgId)).map(({ apiName, label, pluralLabel }) => [apiName, { label, pluralLabel }])),
      };
      // Per list binding: whether it read every row its view holds, how many it read, and why its counts are missing.
      const lists: Record<string, { complete: boolean; limit: number; countError: string | null }> = {};
      // The calls the page loads on open, each with its arguments here (null: one it needs has no value): the page runs
      // them itself, as the caller (api.modules.call), and keeps each value per arguments.
      const loads: Record<string, { call: string; args: Record<string, unknown> | null; refreshMinutes?: number; revision?: string }> = {};
      const binds = hit.page.bind ?? {};
      /** A binding's argument: a page value, or a field of the doc another binding read (null when it read none). */
      const argOf = (x: FormExpr): Scalar => {
        if (x === null || typeof x !== "object" || !("bind" in x)) return value(x as PageExpr);
        const d = data[x.bind] as ModuleDoc | null | undefined;
        const got = !d ? null : x.field === "key" ? d.key : d.data[x.field];
        return got === undefined || (typeof got === "object" && got !== null) ? null : (got as Scalar);
      };
      // Each binding reads after the bindings its arguments name (the parser refuses a cycle).
      const order: string[] = [];
      const visit = (b: string, path: readonly string[]) => {
        if (order.includes(b) || path.includes(b) || !binds[b]) return;
        for (const x of Object.values(binds[b].args ?? {})) if (x !== null && typeof x === "object" && "bind" in x) visit(x.bind, [...path, b]);
        order.push(b);
      };
      for (const b of Object.keys(binds)) visit(b, []);
      for (const name of order) {
        const b = binds[name];
        // A URL parameter is text: a view's number or true/false argument reads it as one (refused when it isn't).
        // A call's arguments read as its schema types them: a `?year=` a number, a `?reps=a,b` (rows a table picked) a list.
        const callTypes = (c: string) => Object.fromEntries(Object.entries(m.calls?.[c]?.args?.value ?? {}).flatMap(([k, sp]) => { const t = coreOf(sp.fieldType).type; return t === "number" || t === "boolean" || t === "array" ? [[k, t]] : []; }));
        const types: Record<string, string> = b.view !== undefined ? m.views[b.view]?.args ?? {} : b.canon !== undefined ? CANON_READS[b.canon].args : callTypes(b.call);
        const typed = (k: string, v: Scalar, x: FormExpr): Scalar | string[] => {
          if (typeof v !== "string" || x === null || typeof x !== "object" || !("query" in x)) return v;
          if ((types[k] === "array" || types[k]?.endsWith("[]"))) return v.split(",").filter(Boolean);
          if (types[k] === "number" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
          if (types[k] === "boolean" && (v === "true" || v === "false")) return v === "true";
          return v;
        };
        const given = Object.entries(b.args ?? {}).map(([k, x]) => [k, typed(k, argOf(x), x), x] as const);
        const bargs = Object.fromEntries(given.map(([k, v]) => [k, v]));
        // A URL parameter the link didn't give (and that has no default), or a field of a doc another binding didn't
        // read, reads nothing rather than failing the page.
        const unset = given.some(([, v, x]) => v === null && x !== null && typeof x === "object" && ("query" in x || "bind" in x));
        if (b.call !== undefined) {
          // Only a call the caller's role may run loads: the call checks again when the page runs it.
          if (m.calls?.[b.call]?.canon) throw new ConvexError("Canon operations cannot load with a page.");
          if (m.calls?.[b.call] && scope.admission(m.calls[b.call], !readsOnly(m.calls[b.call])) === null) loads[name] = { call: b.call, ...(b.refreshMinutes ? { refreshMinutes: b.refreshMinutes } : {}), args: unset ? null : Object.fromEntries(given.flatMap(([k, v]) => (v === null ? [] : [[k, v]]))) };
          continue;
        }
        if (b.canon !== undefined) {
          const limit = Math.max(1, Math.min(MAX_PAGE_ROWS, Math.round(args.limits?.[name] ?? b.limit ?? 50)));
          data[name] = unset ? [] : await scope.canonRows(b.canon, bargs, limit);
          lists[name] = { complete: true, limit, countError: null };
          continue;
        }
        const v = m.views[b.view];
        if (v?.kind === "list") {
          const limit = Math.max(1, Math.min(MAX_PAGE_ROWS, Math.round(args.limits?.[name] ?? b.limit ?? v.limit ?? 50)));
          const rows = unset ? { docs: [], complete: true } : await scope.pageRows(b.view, bargs, limit);
          const enriched = await scope.enrich(v.collection, rows.docs, b.join ?? [], b.count ?? {});
          data[name] = enriched.docs;
          lists[name] = { complete: rows.complete, limit, countError: enriched.countError };
        } else {
          const doc = unset ? null : ((await scope.view(b.view, bargs)) as ModuleDoc | null);
          data[name] = doc && v ? (await scope.enrich(v.collection, [doc], b.join ?? [], b.count ?? {})).docs[0] : doc;
        }
      }
      for (const [name, binding] of Object.entries(binds)) {
        if (!binding.call || !binding.refreshOn?.length || !loads[name]) continue;
        loads[name].revision = canonicalJson(binding.refreshOn.map((from) => {
          const bound = data[from];
          const docs = Array.isArray(bound) ? bound : bound ? [bound] : [];
          return [from, docs.map((doc) => [doc.key, doc.version, doc.updatedAt])];
        }));
      }
      // A doc the route names (a `one` binding read by a `:param`) that isn't there, or isn't the caller's to read: the
      // page says so, with its way back, rather than draw an empty record.
      const gone = Object.entries(binds).find(([name, b]) => b.view !== undefined && m.views[b.view]?.kind === "one" && data[name] === null
        && Object.values(b.args ?? {}).some((x) => x !== null && typeof x === "object" && "route" in x));
      if (gone) {
        const fb = hit.page.fallback;
        const back = fb ? { label: fb.back.label, href: `/dashboard/m/${scope.slug}/${fillPath(fb.back.path, hit.params)}` } : { label: `Back to ${m.title}`, href: navOf(m)?.href ?? "/dashboard" };
        return { ...base, page: null, missing: { text: fb?.missing ?? null, heading: fb?.heading ?? null, actions: fallbackActions(scope.slug, fb, hit.params), back } };
      }
      const prune = (nodes: readonly Node[]): Node[] => nodes.filter((n) => sees(n.roles)).map((n) => (n.c === "tabs" ? { ...n, tabs: n.tabs.filter((t) => sees(t.roles)).map((t) => ({ ...t, body: prune(t.body) })) } : n)).filter((n) => n.c !== "tabs" || n.tabs.length > 0);
      // A field shows as the module's forms show it, on any page: its label and widget belong to the collection.
      const hints = new Map<string, { label: string; widget?: Widget }>();
      const walk = (nodes: readonly Node[]) => nodes.forEach((n) => {
        if (n.c === "tabs") n.tabs.forEach((t) => walk(t.body));
        if (n.c === "form") for (const f of n.fields) if (!hints.has(`${m.ops[n.op]?.collection}.${f.field}`)) hints.set(`${m.ops[n.op]?.collection}.${f.field}`, { label: f.label, ...(f.widget ? { widget: f.widget } : {}) });
      });
      m.pages.forEach((p) => walk(p.body));
      const ops = Object.fromEntries(Object.entries(m.ops).map(([name, op]) => {
        const schema = m.collections[op.collection]?.schema ?? { type: "object" as const, value: {} };
        return [name, {
          label: op.label, kind: op.kind, collection: op.collection, allowed: scope.admission(op) === null, setOf: m.collections[op.collection]?.setOf?.parent ?? null,
          fields: formFields(schema, op.fields ?? [], (f) => hints.get(`${op.collection}.${f}`)),
        }];
      }));
      // Each machine's transitions as buttons: shown on a doc in one of its `from` states, to a role it names.
      const machines = Object.fromEntries(Object.entries(m.machines ?? {}).map(([name, mc]) => [name, {
        field: mc.field, states: mc.states, stateLabels: labelsOf(m, mc.collection)[mc.field] ?? null,
        transitions: Object.fromEntries(Object.entries(mc.transitions).map(([tn, t]) => [tn, {
          label: t.label, from: t.from, allowed: scope.admission(t) === null, confirm: t.confirm ?? null, evidence: t.evidence ?? null,
          sends: (t.effects ?? []).filter((fx) => "send" in fx).length,
          fields: t.args ? formFields(t.args, Object.keys(t.args.value)) : [],
        }])),
      }]));
      const calls = Object.fromEntries(Object.entries(m.calls ?? {}).map(([name, c]) => [name, {
        label: c.label, allowed: scope.admission(c, !readsOnly(c)) === null, readOnly: readsOnly(c), returns: c.returns, fields: c.args ? formFields(c.args, Object.keys(c.args.value)) : [], result: c.result ?? null, confirm: c.confirm ?? null,
      }]));
      // Each binding's value labels, by field, from its view's collection; a joined doc's as `<join>.<field>`.
      const viewOf = (binding: Binding | undefined) => (binding?.view === undefined ? undefined : m.views[binding.view]);
      const labels = Object.fromEntries(Object.entries(hit.page.bind ?? {}).map(([b, binding]) => {
        if (binding.canon !== undefined) return [b, { ...CANON_LABELS[CANON_READS[binding.canon].object] }];
        const collection = viewOf(binding)?.collection;
        const own = labelsOf(m, collection);
        for (const f of binding.join ?? []) {
          const ref = refsOf(m, collection, f);
          if (ref?.to === "doc") for (const [k, l] of Object.entries(labelsOf(m, ref.collection))) own[`${f}.${k}`] = l;
        }
        return [b, own];
      }));
      // Each binding's fields' own formats (a time), a joined doc's as `<join>.<field>`.
      const formats = Object.fromEntries(Object.entries(hit.page.bind ?? {}).map(([b, binding]) => {
        const collection = viewOf(binding)?.collection;
        const own: Record<string, string> = formatsOf(m, collection);
        for (const f of binding.join ?? []) {
          const ref = refsOf(m, collection, f);
          if (ref?.to === "doc") for (const [k, x] of Object.entries(formatsOf(m, ref.collection))) own[`${f}.${k}`] = x;
        }
        return [b, own];
      }));
      // Every value each binding's choice fields may hold, so a table's filter offers them all, not only those its rows hold.
      const choices = Object.fromEntries(Object.entries(hit.page.bind ?? {}).map(([b, binding]) => [b, Object.fromEntries(Object.entries(m.collections[viewOf(binding)?.collection ?? ""]?.schema.value ?? {})
        .flatMap(([f, spec]) => { const all = literalChoices(coreOf(spec.fieldType)); return all ? [[f, all.map(String)]] : []; }))]));
      // What each binding's row values are, for a table's filters: a choice, a member, a ref, true/false, a number or text.
      const kinds = Object.fromEntries(Object.entries(hit.page.bind ?? {}).map(([b, binding]) => [b, fieldKinds(m, viewOf(binding)?.collection, binding.join ?? [], Object.keys(binding.count ?? {}))]));
      // The audit trail of each doc a timeline shows.
      const body = prune(hit.page.body);
      const events: Record<string, ModuleEvent[] | null> = {};
      const flat = (nodes: readonly Node[]): Node[] => nodes.flatMap((n) => (n.c === "tabs" ? [n, ...n.tabs.flatMap((t) => flat(t.body))] : [n]));
      const shown = flat(body);
      for (const n of shown) {
        if (n.c !== "timeline") continue;
        const doc = data[n.of] as { key: string } | null;
        const collection = viewOf(hit.page.bind?.[n.of])?.collection;
        if (doc && collection && !events[n.of]) events[n.of] = await scope.events(collection, doc.key, n.limit);
        // A timeline's `hide`: events by those actors aren't sent to the roles it names (System's backfills, from reps).
        const hide = n.hide;
        if (hide && events[n.of] && (!hide.roles || hide.roles.includes(scope.role))) events[n.of] = events[n.of]!.filter((e) => !timelineHides(hide, e));
      }
      // The states a statusSteps doc has actually been in, so a machine that skips a state doesn't show it done.
      const visited: Record<string, string[]> = {};
      for (const n of shown) {
        const doc = n.c === "statusSteps" ? (data[n.from] as { key: string } | null) : null;
        if (n.c === "statusSteps" && doc && !visited[n.from]) visited[n.from] = await scope.visited(n.machine, doc.key);
      }
      const blocked = await blockedActions(scope, shown, data, value);
      // Whether each sealed doc an integrity badge shows still matches its seal, recomputed here.
      const integrity: Record<string, Verified | null> = {};
      for (const n of shown) {
        if (n.c !== "integrity" || Object.hasOwn(integrity, n.from)) continue;
        const doc = data[n.from] as ModuleDoc | null;
        const collection = viewOf(hit.page.bind?.[n.from])?.collection;
        integrity[n.from] = doc && collection ? await scope.verify(collection, doc.key) : null;
      }
      // Each transcript's call, read by Canon as the caller (lib/modules/transcripts.ts), by the call's id.
      const transcripts: Record<string, Transcript> = {};
      for (const n of shown) {
        if (n.c !== "transcript") continue;
        const x = n.call;
        const doc = x !== null && typeof x === "object" && "bind" in x ? (data[x.bind] as ModuleDoc | null | undefined) : undefined;
        const id = doc !== undefined ? (doc ? (x as { field: string }).field === "key" ? doc.key : doc.data[(x as { field: string }).field] : null) : value(x as PageExpr);
        if (typeof id === "string" && id && !Object.hasOwn(transcripts, id)) transcripts[id] = await transcriptOf(ctx, scope, id);
      }
      // The bulk moves each bulkStatus doc waits on: moving, or stopped with the docs that refused named.
      const bulks: Record<string, Array<BulkInfo & { machine: string }>> = {};
      for (const n of shown) {
        if (n.c !== "bulkStatus" || Object.hasOwn(bulks, n.from)) continue;
        const doc = data[n.from] as ModuleDoc | null;
        const collection = viewOf(hit.page.bind?.[n.from])?.collection;
        bulks[n.from] = [];
        if (!doc || !collection) continue;
        for (const [mn, mc] of Object.entries(m.machines ?? {})) {
          if (mc.collection === collection) bulks[n.from].push(...((await scope.bulks(mn, doc.key)) ?? []).map((x) => ({ ...x, machine: mn })));
        }
      }
      // Each job status line's keys, by its job and prefix as the page computes it.
      const statuses: Record<string, Omit<PrefixStatus, "busy">> = {};
      for (const n of shown) {
        if (n.c !== "jobStatus" || !m.jobs?.[n.job]) continue;
        const prefix = (n.keyPrefix ?? []).map((x) => {
          if (x !== null && typeof x === "object" && "bind" in x) { const d = data[x.bind] as ModuleDoc | null | undefined; return d ? (x.field === "key" ? d.key : d.data[x.field]) ?? null : null; }
          return value(x as PageExpr);
        });
        const id = statusId(n.job, prefix);
        if (statuses[id] || prefix.some((x) => x === null || x === undefined)) continue;
        const st = await prefixStatus(ctx.db, scope.orgId, scope.moduleId, m, n.job, prefix.map(String), Date.now());
        // Errors can quote the module's data: only an admin reads them.
        const { busy: _busy, ...line } = st;
        statuses[id] = scope.role === "admin" ? line : { ...line, failed: line.failed.map((f) => ({ ...f, error: "" })) };
      }
      // What the deal, team and doc refs of the bound docs show as (members come with `members`).
      const refs: Array<{ ref: { type: "ref"; to: RefTo; collection?: string }; id: string }> = [];
      for (const [name, b] of Object.entries(hit.page.bind ?? {})) {
        const c = m.collections[viewOf(b)?.collection ?? ""];
        const docs = data[name] === null || data[name] === undefined ? [] : Array.isArray(data[name]) ? (data[name] as Array<{ data: Record<string, unknown> }>) : [data[name] as { data: Record<string, unknown> }];
        if (c) for (const d of docs) refs.push(...refsIn(d.data, c.schema).filter((r) => r.ref.to !== "users"));
      }
      const refLabels = Object.fromEntries(Object.entries(await scope.refLabels(refs)).map(([k, label]) => [k.slice(k.indexOf(":", k.indexOf(":") + 1) + 1), label]));
      // The companies and people they name: the page reads their names as the caller (api.modules.records).
      const recordRefs = Object.fromEntries(RECORD_REFS.map((to) => [to, [...new Set(refs.filter((r) => r.ref.to === to).map((r) => r.id))].slice(0, RECORDS_MAX)])) as Record<RecordRefTo, string[]>;
      // What the files the bound docs hold are (each doc's own, so the page links them to its doc).
      const fileIds: string[] = [];
      for (const [name, b] of Object.entries(hit.page.bind ?? {})) {
        const c = m.collections[viewOf(b)?.collection ?? ""];
        const docs = data[name] === null || data[name] === undefined ? [] : Array.isArray(data[name]) ? (data[name] as Array<{ data: Record<string, unknown> }>) : [data[name] as { data: Record<string, unknown> }];
        if (c) for (const d of docs) fileIds.push(...filesIn(d.data, c.schema).map((f) => f.id));
      }
      const files = fileIds.length ? await scope.fileInfo(fileIds) : {};
      // Each reported collection a report or a chart on the page reads: its palette, or none when the caller reads none of it.
      const reportsOf: Record<string, { fields: ReportField[]; none: boolean; title: string }> = {};
      // `canon.*`: every Canon object the module may report on in this workspace, its custom objects too.
      const every = shown.some((n) => n.c === "report" && n.sources?.includes(EVERY_CANON_SOURCE))
        ? [...await everyRecordSource(ctx, scope.orgId, m), ...Object.keys(CANON_SOURCES).filter((s) => grantsSource(m, s))] : [];
      for (const n of shown) {
        // A report builder's other sources have their palettes too.
        const collections = n.c === "report" ? [n.collection, ...(n.sources ?? []).flatMap((s) => (s === EVERY_CANON_SOURCE ? every : [s]))] : n.c === "pacing" ? n.sources.map((s) => s.collection) : n.c === "chart" && n.report ? [n.report.collection] : [];
        for (const collection of collections) {
          if (reportsOf[collection]) continue;
          if (recordObjectOf(m, collection)) {
            // A Canon object the workspace doesn't have (a custom object it never made, or archived) has no palette.
            const plan = await scope.reportPlan(collection).catch((e) => { if (e instanceof ConvexError) return null; throw e; });
            if (plan) reportsOf[collection] = { fields: "none" in plan ? [] : plan.fields, none: "none" in plan, title: plan.title ?? collection };
            continue;
          }
          if (isCanonSource(collection)) {
            const plan = await scope.reportPlan(collection);
            reportsOf[collection] = { fields: await withDealOptions(ctx, scope.orgId, collection, "none" in plan ? [] : plan.fields), none: "none" in plan, title: CANON_SOURCES[collection] };
            continue;
          }
          if (!m.collections[collection]?.report) continue;
          const plan = await scope.reportPlan(collection);
          // A source reads as its collection's name ("Visits", "Notes"), or what one doc of it is called.
          const title = m.collections[collection].label ?? collection.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
          reportsOf[collection] = { fields: reportFields(m.collections[collection], m), none: "none" in plan, title };
        }
      }
      return {
        ...base,
        page: { path: hit.page.path, title: hit.page.title, body, onOpen: await openReady(scope, hit.page.onOpen, data), fallback: hit.page.fallback ?? null, document: hit.page.document ?? null, persist: hit.page.persist ?? null }, reports: reportsOf,
        collections: Object.fromEntries(Object.entries(hit.page.bind ?? {}).flatMap(([b, binding]) => (viewOf(binding)?.collection ? [[b, viewOf(binding)!.collection]] : []))),
        // Per binding, the refs it joins that name Canon deals: their stage and type read as the workspace names them.
        dealJoins: Object.fromEntries(Object.entries(hit.page.bind ?? {}).map(([b, binding]) => [b, (binding.join ?? []).filter((f) => refsOf(m, viewOf(binding)?.collection, f)?.to === "deals")])),
        params: hit.params, query: given, data, lists, kinds, choices, formats, statuses, ops, machines, calls, labels, events, visited, blocked, refLabels, recordRefs, files, integrity, loads, bulks, transcripts,
        // The caller's unread notifications from this module, which text reads as `{$notifications.unread}`.
        notifications: await unreadOf(ctx, scope),
        // What one doc of each collection is called, for a picker's "Pick a team group".
        collectionLabels: Object.fromEntries(Object.entries(m.collections).map(([name, c]) => [name, c.label ?? humanName(name.replace(/s$/, ""))])),
        csvImports: Object.fromEntries(Object.entries(m.csvImports ?? {}).flatMap(([name, x]) => (m.calls?.[x.call] ? [[name, csvImportShape(x, m.calls[x.call])]] : []))),
        exports: Object.fromEntries(Object.entries(m.exports ?? {}).map(([name, x]) => [name, { label: x.label, fields: "people" in x ? formFields({ type: "object", value: { [x.people.key.arg]: { fieldType: { type: "string" }, optional: false } } }, [x.people.key.arg]) : "call" in x && m.calls?.[x.call]?.args ? formFields(m.calls[x.call].args!, Object.keys(m.calls[x.call].args!.value)) : [] }])),
      };
    } catch (e) {
      // A read the page makes refused (a URL parameter that isn't a number, a scope past its cap): the page's fallback
      // says why and links back, rather than fail the whole view.
      if (!(e instanceof ConvexError)) throw e;
      const fb = hit.page.fallback;
      const back = fb ? { label: fb.back.label, href: `/dashboard/m/${scope.slug}/${fillPath(fb.back.path, hit.params)}` } : { label: `Back to ${m.title}`, href: navOf(m)?.href ?? "/dashboard" };
      return { ...base, page: null, failed: { message: typeof e.data === "string" ? e.data : "This page couldn't be read.", text: fb?.text ?? null, heading: fb?.heading ?? null, actions: fallbackActions(scope.slug, fb, hit.params), back } };
    }
  },
});

/** The most unread notifications a page counts: past it, "99+" reads as 99. */
const UNREAD_COUNTED = 99;
/**
 * The caller's unread notifications from this module (docs/modules.md, "Notifications"): `unread`, counted to 99, and
 * `hasUnread`. In an admin's "view as" preview, the member's, as the bell lists them.
 */
async function unreadOf(ctx: QueryCtx, scope: ModuleScope): Promise<{ unread: number; hasUnread: boolean }> {
  const userId = scope.userId as Id<"users"> | null;
  if (!userId) return { unread: 0, hasUnread: false };
  let unread = 0;
  for await (const n of ctx.db.query("notifications").withIndex("by_orgId_userId_readAt", (q) => q.eq("orgId", scope.orgId).eq("userId", userId).eq("readAt", undefined))) {
    if (n.source.moduleId === scope.manifest.id && ++unread >= UNREAD_COUNTED) break;
  }
  return { unread, hasUnread: unread > 0 };
}

/** A fallback's other ways out: each a page of the module, its `:params` from the route. */
const fallbackActions = (slug: string, fb: PageDecl["fallback"], params: Record<string, string>) =>
  (fb?.actions ?? []).map((x) => ({ label: x.label, href: `/dashboard/m/${slug}/${fillPath(x.path, params)}` }));

/**
 * The transition a page runs when it opens, and whether it may run now: the doc it names is in one of its `from`
 * states, the caller's role runs it and no guard refuses it. Once it has run (a statement marked viewed), it isn't.
 */
async function openReady(scope: ModuleScope, onOpen: PageDecl["onOpen"], data: Record<string, unknown>) {
  if (!onOpen) return null;
  const mc = scope.manifest.machines?.[onOpen.machine], t = mc?.transitions[onOpen.transition];
  const doc = data[onOpen.target] as ModuleDoc | null | undefined;
  const ready = !!doc && !!mc && !!t && !scope.agent && scope.preview === null && scope.admission(t) === null && t.from.includes(String(doc.data[mc.field])) && (await scope.blocked(onOpen.machine, onOpen.transition, doc.key)) === null;
  return { ...onOpen, ready };
}

/** How many rows of a table a page judges its row actions for. */
const ROWS_JUDGED = 200;
/** A job status line's id: its job and its prefix's values. */
const statusId = (job: string, prefix: readonly unknown[]) => `${job}:${JSON.stringify(prefix)}`;
/** The ref a collection's field holds (an optional one's too), or null. */
function refsOf(m: ModuleManifest, collection: string | undefined, field: string): { to: RefTo; collection?: string } | null {
  const spec = m.collections[collection ?? ""]?.schema.value[field];
  if (!spec) return null;
  const t = spec.fieldType.type === "union" ? spec.fieldType.value.find((x) => x.type === "ref") : spec.fieldType;
  return t?.type === "ref" ? (t as { to: RefTo; collection?: string }) : null;
}
type Kind = "choice" | "user" | "ref" | "bool" | "number" | "date" | "text" | "file";
/** What a field's values are, for a filter: a date is a text field whose widget is a date. */
function kindOf(spec: FieldSpec | undefined): Kind {
  if (!spec) return "text";
  if (literalChoices(spec.fieldType)) return "choice";
  const t = spec.fieldType.type === "union" ? spec.fieldType.value.find((x) => x.type !== "null") ?? spec.fieldType : spec.fieldType;
  if (t.type === "ref") return t.to === "users" ? "user" : "ref";
  if (t.type === "file") return "file";
  if (t.type === "boolean") return "bool";
  if (t.type === "number") return spec.widget === "time" ? "date" : "number";
  if (t.type === "string" && (spec.widget === "date" || widgetOf(spec) === "date")) return "date";
  return "text";
}
/** Each row value's kind for a binding: its fields, its counts (numbers) and its joined docs' fields. */
/**
 * The kinds of the fields a joined Canon record carries (what `reads` grants, and its name): a member's manager and a
 * deal's owner are members, so a table groups, filters and searches them by name, and dates filter as dates.
 */
const CANON_KINDS: Record<Exclude<RefTo, "doc">, Record<string, Kind>> = {
  users: { managerId: "user", startDate: "date", endDate: "date", isActive: "bool" },
  deals: { ownerId: "user", amount: "number", arr: "number", mrr: "number", probability: "number", closeDate: "date", closedAt: "date", isClosed: "bool", isWon: "bool", createdAt: "date", updatedAt: "date" },
  teams: { managerId: "user" },
  senders: { ownerId: "user", createdAt: "date" },
  companies: { ownerId: "user", employees: "number", annualRevenue: "number" },
  people: { ownerId: "user" },
};
function fieldKinds(m: ModuleManifest, collection: string | undefined, join: readonly string[], counts: readonly string[]): Record<string, Kind> {
  const out: Record<string, Kind> = { owner: "user" };
  for (const [f, spec] of Object.entries(m.collections[collection ?? ""]?.schema.value ?? {})) out[f] = kindOf(spec);
  for (const c of counts) out[c] = "number";
  for (const f of join) {
    const ref = refsOf(m, collection, f);
    if (ref?.to === "doc") {
      const into = m.collections[ref.collection ?? ""];
      for (const [k, spec] of Object.entries(into?.schema.value ?? {})) out[`${f}.${k}`] = kindOf(spec);
      if (into?.owner) out[`${f}.owner`] = "user";
    } else if (ref) {
      for (const [k, kind] of Object.entries(CANON_KINDS[ref.to])) out[`${f}.${k}`] = kind;
    }
  }
  return out;
}
type DocLike = { key: string; data: Record<string, unknown> };
/**
 * Why each action the page offers can't run now, so its button shows disabled with the reason: a transition's guard
 * (one that needs no arguments), an update's or delete's guard on its doc (an action's or a form's), a set create's
 * guard on its parent. By the doc's key (a parent's as "parent:<key>"), then "t:<machine>.<transition>" or
 * "op:<name>". The server checks again.
 */
async function blockedActions(scope: ModuleScope, nodes: readonly Node[], data: Record<string, unknown>, value: (x: PageExpr) => Scalar) {
  const m = scope.manifest;
  const out: Record<string, Record<string, string>> = {};
  const note = (key: string, ref: string, why: string | null) => { if (why) (out[key] ??= {})[ref] = why; };
  const bound = (b: string | undefined) => (b === undefined ? null : ((data[b] as DocLike | null | undefined) ?? null));
  /** The values an action fixes that the page knows here: a page value, a bound doc's field, a row's, today. */
  const fixedOf = (fixed: Record<string, FormExpr> | undefined, row: DocLike | null) => {
    const out: Record<string, unknown> = {};
    for (const [f, x] of Object.entries(fixed ?? {})) {
      const v = x !== null && typeof x === "object" && "bind" in x ? (x.field === "key" ? bound(x.bind)?.key : bound(x.bind)?.data[x.field])
        : x !== null && typeof x === "object" && "row" in x ? (x.row === "key" ? row?.key : row?.data[x.row])
        : x !== null && typeof x === "object" && "today" in x ? new Date().toISOString().slice(0, 10) : value(x);
      if (v !== undefined && v !== null) out[f] = v;
    }
    return out;
  };
  /**
   * An op action opens a form (a delete asks nothing): its guards that read a field the form asks for wait for the
   * submit, so the button is off only for a guard that fails whatever the form holds (the doc's state, the role).
   */
  const judge = async (a: ActionRef, doc: DocLike | null, form?: readonly string[]) => {
    if ("transition" in a) {
      const mc = m.machines?.[a.machine], t = mc?.transitions[a.transition];
      if (!doc || !mc || !t || t.system || scope.admission(t) !== null || !t.from.includes(String(doc.data[mc.field]))) return;
      note(doc.key, blockedId("t", `${a.machine}.${a.transition}`, a.fixed), await scope.blocked(a.machine, a.transition, doc.key, fixedOf(a.fixed, doc)));
    } else if ("op" in a) {
      const op = m.ops[a.op];
      if (!op?.guards?.length || scope.admission(op) !== null) return;
      const fixed = "fixed" in a ? fixedOf(a.fixed, doc) : {};
      const asks = op.kind === "delete" ? [] : (form ?? op.fields ?? []).filter((f) => !Object.hasOwn(fixed, f));
      if (op.kind !== "create" && doc) note(doc.key, blockedId("op", a.op, "fixed" in a ? a.fixed : undefined), await scope.opBlocked(a.op, { key: doc.key }, asks));
      const parent = a.parent === undefined ? null : value(a.parent);
      if (op.kind === "create" && typeof parent === "string") note(`parent:${parent}`, blockedId("op", a.op, "fixed" in a ? a.fixed : undefined), await scope.opBlocked(a.op, { parentKey: parent, data: fixed }, asks));
    }
  };
  for (const n of nodes) {
    const items: readonly ActionRef[] = n.c === "header" || n.c === "banner" ? n.actions ?? [] : n.c === "empty" ? (n.action ? [n.action] : []) : n.c === "actions"
      ? n.items ?? Object.keys(m.machines?.[n.machine!]?.transitions ?? {}).map((t) => ({ transition: t, machine: n.machine!, target: n.target }))
      : [];
    // A menu's items are judged as the page's own actions.
    for (const a of items.flatMap((x) => ("menu" in x ? x.items : [x]))) await judge(a, "target" in a ? bound(a.target) : null);
    if (n.c === "form") {
      const fixed: Record<string, FormExpr> = {};
      for (const [field, x] of Object.entries(n.fixed ?? {})) if (!(x !== null && typeof x === "object" && "json" in x)) fixed[field] = x;
      await judge({ op: n.op, ...(n.from !== undefined ? { target: n.from } : n.parent !== undefined ? { parent: n.parent } : {}), fixed }, bound(n.from), n.fields.map((f) => f.field));
    }
    if (n.c === "table" && n.rowActions?.length) {
      for (const row of ((data[n.from] as DocLike[] | undefined) ?? []).slice(0, ROWS_JUDGED)) for (const a of n.rowActions) await judge(a, row);
    }
    if (n.c === "queue") {
      for (const src of n.sources) for (const row of ((data[src.from] as DocLike[] | undefined) ?? []).slice(0, ROWS_JUDGED)) for (const a of src.actions ?? []) await judge(a, row);
    }
    if (n.c === "approvalChain" && n.actions?.length) {
      for (const row of ((data[n.from] as DocLike[] | undefined) ?? []).slice(0, ROWS_JUDGED)) for (const a of n.actions) await judge(a, row);
    }
    // A thread in a row's expansion posts under the row's doc: its op is checked when it runs.
    if (n.c === "thread" && n.post && !("row" in Object(n.post.parent))) await judge({ op: n.post.op, parent: n.post.parent as PageExpr }, null, [n.post.field]);
  }
  return out;
}

/**
 * What a transition's sends would send, rendered on the doc as the move would leave it (docs/modules.md, "Outbound"):
 * its dialog shows it before the person moves the doc. Null when they can't read the doc.
 */
export const sendPreview = query({
  args: { module: v.string(), machine: v.string(), transition: v.string(), key: v.string(), args: v.optional(v.record(v.string(), v.any())) },
  handler: async (ctx, a) => {
    const scope = await moduleScope(ctx, a.module);
    return scope ? scope.sendPreview(a.machine, a.transition, a.key, a.args ?? {}) : null;
  },
});

/** The most actions a page judges on a call's rows at once. */
const JUDGED_MAX = 400;
/**
 * Whether the actions on a call's rows can run now (docs/modules.md, "Tables, queues and status"): a transition on
 * the doc a row names (its state and the guards that need no arguments) and an op (its guards on the doc an update
 * or a delete names, or on a create's values from the row). With each doc's version, which the action's write
 * expects, and its state. A row naming a doc the caller can't read reads as missing. The server checks again on
 * every write.
 */
export const judge = query({
  args: {
    module: v.string(),
    checks: v.array(v.object({
      id: v.string(),
      transition: v.optional(v.object({ machine: v.string(), name: v.string(), key: v.string(), args: v.optional(v.record(v.string(), v.any())) })),
      op: v.optional(v.object({ name: v.string(), key: v.optional(v.string()), parentKey: v.optional(v.string()), data: v.optional(v.record(v.string(), v.any())) })),
    })),
  },
  handler: async (ctx, a) => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const m = scope.manifest;
    if (a.checks.length > JUDGED_MAX) throw new ConvexError(`A page judges at most ${JUDGED_MAX} row actions at once.`);
    const out: Record<string, { reason: string | null; version: number | null; state: string | null; missing: boolean; data?: Record<string, unknown> }> = {};
    for (const c of a.checks) {
      if (c.transition) {
        const mc = m.machines?.[c.transition.machine];
        const doc = mc ? await scope.peek(mc.collection, c.transition.key) : null;
        out[c.id] = doc && mc
          ? { reason: await scope.blocked(c.transition.machine, c.transition.name, c.transition.key, c.transition.args), version: doc.version, state: String(doc.data[mc.field] ?? ""), missing: false }
          : { reason: null, version: null, state: null, missing: true };
      } else if (c.op) {
        const op = m.ops[c.op.name];
        if (!op) { out[c.id] = { reason: null, version: null, state: null, missing: true }; continue; }
        const doc = op.kind === "create" || c.op.key === undefined ? null : await scope.peek(op.collection, c.op.key);
        if (op.kind !== "create" && !doc) { out[c.id] = { reason: null, version: null, state: null, missing: true }; continue; }
        // An update's dialog starts from the doc as the caller reads it (Edit on a call's row).
        out[c.id] = { reason: await scope.opBlocked(c.op.name, { key: c.op.key, parentKey: c.op.parentKey, data: c.op.data }), version: doc?.version ?? null, state: null, missing: false, ...(op.kind === "update" && doc ? { data: doc.data } : {}) };
      }
    }
    return out;
  },
});

// ── Reports (docs/modules.md, "Reports and charts") ──

/** The docs the fake record client's report reads in Convex: past them, run the record service. */
const FAKE_REPORT_DOCS = 5000;
/** `canon`: a report over a Canon object (`reads.records`): the object, its name, and the request Canon's report engine runs. */
type ReportPlan = (
  | { none: true; orgId: string; moduleId: string; spec: ReportSpec; fields: ReportField[]; behind: boolean; canon?: { object: string; title: string } }
  | { none?: undefined; orgId: string; moduleId: string; spec: ReportSpec; fields: ReportField[]; docScope: ModuleDocScope | null; behind: boolean; canon?: { object: string; title: string; request: CanonReportRequest } }) & { projection?: ModuleProjection | null };

async function reportProjection(ctx: QueryCtx, scope: ModuleScope) {
  const pkg = (await installedModule(ctx, scope.orgId, scope.moduleId))!;
  const projection = projectionOf(pkg, scope.manifest);
  const behind = !projection || !!scope.migrating || !projection.collections.every((c) => pkg.projection!.completed.includes(c)) || await reportsBehind(ctx.db, scope.orgId, scope.moduleId);
  return { projection, behind };
}

const reportSyncing = (): never => { throw new ConvexError({ projectionSyncing: true, message: "This module's report projection is syncing or unavailable. Try again shortly." }); };
function requireReportReady(plan: { projection?: ModuleProjection | null; behind: boolean }) {
  if (!plan.projection || plan.behind) reportSyncing();
}

/**
 * What the record service answers for a spec: a joined dimension (`deal.stage`) grouped by its ref (`deal`) instead,
 * which runReport then regroups by the field of what each ref names; and the fields it reads, the refs among them.
 */
function baseOf(spec: ReportSpec, fields: readonly ReportField[]): { spec: ReportSpec; fields: ReportField[]; joins: Array<{ at: number; field: ReportField & { join: NonNullable<ReportField["join"]> } }> } {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const joins = spec.groupBy.flatMap((g, at) => { const f = byName.get(g.field); return f?.join ? [{ at, field: f as ReportField & { join: NonNullable<ReportField["join"]> } }] : []; });
  // The record service reads the doc's own fields, and the refs the joined ones go through.
  const own = fields.filter((f) => !f.join);
  const vias = [...new Set(fields.flatMap((f) => (f.join ? [f.join.via] : [])))].filter((v) => !own.some((f) => f.name === v)).map((v): ReportField => ({ name: v, label: v, type: "text" }));
  if (!joins.length) return { spec, fields: [...own, ...vias], joins };
  if (spec.filter.some((x) => byName.get(x.field)?.join)) throw new ConvexError("A report filters by its docs' own fields: group by a joined field, but don't filter on it.");
  if (spec.measures.some((x) => x.fn === "avg")) throw new ConvexError("A report grouped by a joined field counts, sums, mins and maxes; it doesn't average yet.");
  // A joined date (a deal's close date) groups by its day, week, month, quarter or year: runReport buckets each ref's date.
  if (joins.some((j) => spec.groupBy[j.at].bucket && !["date", "datetime"].includes(j.field.type))) throw new ConvexError("Only a date is grouped by day, week, month, quarter or year.");
  return { spec: { ...spec, groupBy: spec.groupBy.map((g) => { const f = byName.get(g.field); return f?.join ? { field: f.join.via } : g; }) }, fields: [...own, ...vias], joins };
}

/** A spec checked against its collection's report, as the record service will read it. */
function checkReport(spec: ReportSpec, fields: ReportField[]) {
  if (spec.filter.some((f) => f.field === WEIGHTED_AMOUNT)) throw new ConvexError("Weighted amount is a value to sum, not a filter: filter by Amount or Probability.");
  if (spec.filter.some((f) => f.field === DEAL_ACCOUNT) && spec.object === "canon.deals") throw new ConvexError("Account groups deals, it doesn't filter them: group by Account instead.");
  const base = baseOf(spec, fields);
  try {
    return compileAggregateRequest(spec.object, moduleReportDef(spec.object, base.fields), { filter: base.spec.filter, groupBy: base.spec.groupBy, measures: plainMeasures(base.spec.measures) }, () => undefined);
  } catch (e) {
    if (e instanceof ListRequestError) throw new ConvexError(`That report doesn't fit ${spec.object}: ${e.message}.`);
    throw e;
  }
}

/**
 * Groups keyed by a ref regrouped by the field of what each ref names (`deal` → its stage): each group's key at a
 * joined position replaced by that value (null when the caller can't see what it names), and groups that now share
 * their keys merged, their counts and sums added, their mins and maxes kept. Subtotals come again from the groups.
 */
export function regroup(res: AggregateResponse, measures: ReportSpec["measures"], positions: readonly number[], valueOf: (at: number, id: string) => string | number | boolean | null): AggregateResponse {
  const merge = (groups: AggregateResponse["groups"], width: number, remap: boolean) => {
    const out = new Map<string, { keys: (string | number | boolean | null)[]; values: (number | null)[] }>();
    for (const g of groups) {
      const keys = g.keys.slice(0, width).map((k, i) => (remap && positions.includes(i) ? (typeof k === "string" ? valueOf(i, k) : null) : k));
      const id = JSON.stringify(keys);
      const at = out.get(id);
      if (!at) { out.set(id, { keys, values: [...g.values] }); continue; }
      at.values = at.values.map((v, i) => {
        const w = g.values[i];
        if (v === null || w === null) return v ?? w;
        const fn = measures[i]?.fn;
        return fn === "min" ? Math.min(v, w) : fn === "max" ? Math.max(v, w) : v + w;
      });
    }
    return [...out.values()];
  };
  // Groups in key order, as the record service answers them (a joined date's months run in date order), empty keys last.
  const order = (a: { keys: unknown[] }, b: { keys: unknown[] }) => {
    for (let i = 0; i < a.keys.length; i++) {
      const x = a.keys[i], y = b.keys[i];
      if (x === y) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      return typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    }
    return 0;
  };
  const groups = merge(res.groups, res.groups[0]?.keys.length ?? 0, true).sort(order);
  return { ...res, groups, subtotals: res.subtotals.length ? merge(groups, (groups[0]?.keys.length ?? 1) - 1, false).sort(order) : [] };
}

/** A saved report of the module the caller may read: theirs, or one shared with the workspace. */
async function savedReport(ctx: Parameters<typeof moduleScope>[0], scope: ModuleScope, reportId: Id<"reports">) {
  const r = await ctx.db.get(reportId);
  const user = await withRole(ctx, await ctx.db.get(scope.userId as Id<"users">));
  if (!r || !user || r.orgId !== scope.orgId || r.module?.moduleId !== scope.moduleId || !(r.shared || r.createdBy === user._id)) throw new ConvexError("Report not found");
  return { report: r, user };
}

async function scopedSavedReportSpec(ctx: QueryCtx, scope: ModuleScope, reportId: Id<"reports">): Promise<ReportSpec> {
  const { report: r, user } = await savedReport(ctx, scope, reportId);
  if (r.spec.whose) {
    const plan = await scope.reportPlan(r.spec.object);
    if (!("none" in plan) && plan.fields.some((f) => f.name === "ownerId" && f.type === "user")) {
      const users = await ctx.db.query("users").withIndex("by_orgId", (q) => q.eq("orgId", scope.orgId)).take(200);
      const owners = scopeOwners(r.spec.whose, user._id, users);
      return { ...r.spec, filter: [...r.spec.filter, { field: "ownerId", op: "in", value: owners }] };
    }
  }
  return r.spec;
}

/**
 * What a report reads, as the caller (scope.ts reportPlan): the spec given, or a saved report's, checked against its
 * collection's report; its fields; and the caller's scope as the record service applies it, or `none`.
 */
export const reportPlan = internalQuery({
  args: { module: v.string(), spec: v.optional(reportSpec), reportId: v.optional(v.id("reports")) },
  handler: async (ctx, a): Promise<ReportPlan> => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const spec = a.reportId ? await scopedSavedReportSpec(ctx, scope, a.reportId) : a.spec;
    if (!spec) throw new ConvexError("Give a spec or a reportId.");
    const plan = await scope.reportPlan(spec.object);
    if (plan.object) {
      // A Canon object: counted by Canon's own report engine, as Canon's report builder counts it (convex/reports.ts run).
      const title = plan.title ?? spec.object;
      const at = { orgId: scope.orgId as string, moduleId: scope.moduleId, spec, behind: false };
      if ("none" in plan) return { none: true, ...at, fields: [], canon: { object: plan.object, title } };
      return { ...at, fields: plan.fields, docScope: null, canon: { object: plan.object, title, request: await checkRecordReport(ctx, scope.orgId, plan.object, title, spec, plan.fields) } };
    }
    const canon = isCanonSource(spec.object);
    const base = { orgId: scope.orgId as string, moduleId: scope.moduleId, spec, ...(canon ? { behind: false } : await reportProjection(ctx, scope)) };
    const fields = canon ? ("none" in plan ? canonSourceFields(scope.manifest, spec.object as "canon.deals") : plan.fields) : reportFields(scope.manifest.collections[spec.object], scope.manifest);
    checkReport(spec, fields);
    if (canon) return "none" in plan ? { none: true, ...base, fields } : { ...base, fields: await withDealOptions(ctx, scope.orgId, spec.object, plan.fields), docScope: null };
    return "none" in plan ? { none: true, ...base, fields } : { ...base, fields: plan.fields, docScope: plan.docScope };
  },
});

/** A deals source's picklists with the labels the workspace gives their values. */
async function withDealOptions(ctx: QueryCtx, orgId: Id<"organizations">, source: string, fields: ReportField[]): Promise<ReportField[]> {
  if (!["canon.deals", "canon.stageHistory"].includes(source) || !fields.some((f) => f.type === "picklist")) return fields;
  const def = await listedDef(ctx, orgId, "deal");
  return fields.map((f) => {
    const d = f.type === "picklist" ? def.byApiName.get(source === "canon.stageHistory" ? "stage" : f.name) : undefined;
    return d && "options" in d && d.options ? { ...f, options: d.options.map((o) => ({ value: o.value, label: o.label })) } : f;
  });
}

/**
 * A module report's spec over a Canon object, checked as Canon's report builder checks one: each field one the caller's
 * role shows (`fields`), then Canon's own check (convex/reports.ts checkSpec). The request Canon's report engine runs.
 */
async function checkRecordReport(ctx: QueryCtx, orgId: Id<"organizations">, object: string, title: string, spec: ReportSpec, fields: readonly ReportField[]): Promise<CanonReportRequest<ReportSpec["filter"][number]>> {
  let request: CanonReportRequest<ReportSpec["filter"][number]>;
  try {
    request = canonReportRequest(plainSpec(spec), fields, title);
  } catch (e) {
    if (e instanceof ListRequestError) throw new ConvexError(`That report doesn't fit ${title}: ${e.message}.`);
    throw e;
  }
  await checkSpec(ctx, orgId, { object, chart: "table", ...request });
  return request;
}

/**
 * A report over Canon's records: Canon's own report (convex/reports.ts run), through the caller's record client, so it
 * counts only the records their role sees (CP14) and refuses a field it hides.
 */
async function canonAggregate(ctx: ActionCtx, orgId: string, object: string, title: string, request: CanonReportRequest): Promise<AggregateResponse> {
  const caller = await requireCaller(ctx, { read: true });
  if (caller.orgId !== orgId) throw new ConvexError("You can't read that.");
  try {
    return await callerClient(ctx, caller).aggregate(orgId, object, request);
  } catch (e) {
    if (e instanceof ListRequestError) throw new ConvexError(`That report doesn't fit ${title}: ${e.message}.`);
    throw e;
  }
}

async function stageHistoryAggregate(ctx: ActionCtx, orgId: string, spec: ReportSpec, fields: ReportField[]): Promise<AggregateResponse> {
  const q = checkReport(spec, fields);
  const history = await readStageHistory(ctx, orgId);
  const rows = history.deals.flatMap((d) => d.visits.map((v, i) => moduleListRow(spec.object, fields, {
    key: `${d.id}:${i}`, version: 0, createdAt: v.enteredAt, updatedAt: v.leftAt ?? v.enteredAt,
    data: {
      deal: d.name, ownerId: d.ownerId, stage: v.stage, fromStage: d.visits[i - 1]?.stage ?? null,
      changedAt: v.enteredAt, leftAt: v.leftAt, current: v.leftAt === null,
      daysInStage: v.leftAt === null ? null : (v.leftAt - v.enteredAt) / 86_400_000,
      daysSoFar: v.leftAt === null ? (history.now - v.enteredAt) / 86_400_000 : null,
    },
  })));
  const result = aggregateRowsInMemory(q, rows, () => new Map(), {});
  return { ...result, truncated: result.truncated || history.partial };
}

/** A report over the fixed deal palette (`reads.deals`): an account through the deal's company, a weighted amount as the amount by its probability. */
function dealsRequest(spec: ReportSpec): CanonReportRequest {
  const measures = plainMeasures(spec.measures).map((m) => (m.field === WEIGHTED_AMOUNT ? { fn: m.fn, field: "amount", weight: "probability" } : m));
  // Account: the name of the company the deal's `companyId` names, which the record service joins.
  const groupBy = spec.groupBy.map((g) => (g.field === DEAL_ACCOUNT ? { field: "name", via: "companyId" } : g));
  return { filter: spec.filter, groupBy, measures };
}

/**
 * The module figures a members report sums onto each member (`report.members`): per rollup field it reads, the sum of
 * that field over the collection's docs by member, from the collection's own report run as the caller, so a member's
 * row adds only the docs the caller may read.
 */
type RolledValue = string | number | boolean | null;
async function memberRollups(ctx: ActionCtx, module: string, spec: ReportSpec, fields: ReportField[]): Promise<Record<string, Record<string, RolledValue>>> {
  const used = new Set([...spec.measures.map((x) => x.field), ...spec.filter.map((x) => x.field), ...spec.groupBy.map((x) => x.field)]);
  const rollups = fields.filter((f) => f.rollup && used.has(f.name));
  const out: Record<string, Record<string, RolledValue>> = {};
  // A member's latest value of a dimension: groups by member, the doc's `by` (by day) and the dimension, counted.
  for (const f of rollups.filter((x) => x.rollup!.latest)) {
    const { collection, field, member, latest } = f.rollup!;
    const plan: ReportPlan = await ctx.runQuery(internal.modules.reportPlan, { module, spec: { object: collection, chart: "table", filter: [], groupBy: [], measures: [{ fn: "count" }] } });
    const byType = plan.fields.find((x) => x.name === latest!.by)?.type;
    const now = Date.now();
    const upTo = latest!.upTo === "today" ? [{ field: latest!.by, op: "lte" as const, value: byType === "datetime" ? now : new Date(now).toISOString().slice(0, 10) }] : [];
    const filter = [...(latest!.where ?? []).map((w) => ({ field: w.field, op: w.op, ...(w.value !== undefined ? { value: w.value as string | number | boolean | Array<string | number | boolean> } : {}) })), ...upTo];
    const run = await runReport(ctx, { module, spec: { object: collection, chart: "table", filter, groupBy: [{ field: member }, { field: latest!.by, ...(byType === "date" || byType === "datetime" ? { bucket: "day" as const } : {}) }, { field }], measures: [{ fn: "count" }] } });
    if (run.truncated) throw new ConvexError(`${f.label} reads more than one report's groups (a member's docs by ${latest!.by}). Narrow the module's memberLatest with where.`);
    out[f.name] = latestByMember(run.groups);
  }
  for (const collection of new Set(rollups.filter((x) => !x.rollup!.latest).map((f) => f.rollup!.collection))) {
    const mine = rollups.filter((f) => f.rollup!.collection === collection && !f.rollup!.latest);
    const member = mine[0].rollup!.member;
    const run = await runReport(ctx, { module, spec: { object: collection, chart: "table", filter: [], groupBy: [{ field: member }], measures: mine.map((f) => ({ fn: "sum" as const, field: f.rollup!.field })) } });
    mine.forEach((f, i) => { out[f.name] = Object.fromEntries(run.groups.flatMap((g) => (typeof g.keys[0] === "string" && typeof g.values[i] === "number" ? [[g.keys[0], g.values[i] as number]] : []))); });
  }
  return out;
}

/** A report over the workspace's members the caller's role sees, folded in Convex: a workspace has hundreds at most. */
export const reportMembers = internalQuery({
  // `rollups`: per rollup field, each member's sum of it, from the module's own report as the caller (runReport).
  args: { module: v.string(), spec: reportSpec, rollups: v.optional(v.record(v.string(), v.record(v.string(), v.union(v.number(), v.string(), v.boolean(), v.null())))) },
  handler: async (ctx, a): Promise<AggregateResponse> => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const plan = await scope.reportPlan("canon.members");
    if ("none" in plan) throw new ConvexError("You can't read that.");
    const q = checkReport(a.spec, plan.fields);
    const own = baseOf(a.spec, plan.fields).fields;
    const rows = await scope.memberRows();
    // A sum a member has no docs for is 0; a latest value they have none of is none.
    const latest = new Set(plan.fields.filter((f) => f.rollup?.latest).map((f) => f.name));
    const rolled = (id: string) => Object.fromEntries(Object.entries(a.rollups ?? {}).map(([f, by]) => [f, by[id] ?? (latest.has(f) ? null : 0)]));
    return aggregateRowsInMemory(q, rows.map((r) => moduleListRow("canon.members", own, { key: r.id, data: { ...r.data, ...rolled(r.id) }, version: 0, createdAt: r.createdAt, updatedAt: r.createdAt })), () => new Map(), {});
  },
});

/** A report over the docs the caller reads, folded in Convex: the fake record client's. */
export const reportInMemory = internalQuery({
  args: { module: v.string(), spec: reportSpec },
  handler: async (ctx, a): Promise<AggregateResponse> => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const plan = await scope.reportPlan(a.spec.object);
    if ("none" in plan) throw new ConvexError("You can't read that.");
    // The spec runReport sends: its joined dimensions already grouped by their refs.
    const q = checkReport(a.spec, plan.fields);
    const own = baseOf(a.spec, plan.fields).fields;
    const docs = await scope.reportDocs(a.spec.object, FAKE_REPORT_DOCS);
    return aggregateRowsInMemory(q, docs.map((d) => moduleListRow(a.spec.object, own, d)), () => new Map(), {});
  },
});

/** The field of each deal, member, team or doc a joined dimension's keys name, as the caller may read them; null otherwise. */
export const reportJoins = internalQuery({
  args: { module: v.string(), joins: v.array(v.object({ via: v.string(), field: v.string(), to: v.union(...REF_TARGETS.map((t) => v.literal(t))), collection: v.optional(v.string()), ids: v.array(v.string()) })) },
  handler: async (ctx, a) => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const out: Array<Record<string, string | number | boolean | null>> = [];
    for (const j of a.joins) out.push(await scope.joinedValues({ type: "ref", to: j.to, ...(j.collection ? { collection: j.collection } : {}) }, j.field, j.ids));
    return out;
  },
});

/** What the deal, team and doc keys of a report show as, for the ones the caller may read. */
export const reportLabels = internalQuery({
  args: { module: v.string(), refs: v.array(v.object({ ref: v.object({ type: v.literal("ref"), to: v.union(...REF_TARGETS.map((t) => v.literal(t))), collection: v.optional(v.string()) }), id: v.string() })) },
  handler: async (ctx, a) => (await scopeOrRefuse(ctx, a.module)).refLabels(a.refs),
});

/** One field of each company or person `ids` names, as the caller reads them (a report's joined dimension, a ref's label); none for one they can't see. */
async function recordValues(ctx: ActionCtx, to: RecordRefTo, ids: readonly string[], field: string): Promise<Record<string, string | number | boolean | null>> {
  const { client, ws } = await recordReader(ctx);
  const rows = await readRecord(client, ws, NO_PORTS, { read: to === "companies" ? "companies.byIds" : "people.byIds", ids: [...ids], fields: [field], since: null, limit: 2000 });
  return Object.fromEntries(rows.map((r) => { const x = r[field]; return [String(r.id), typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? x : null]; }));
}

/** A report answered: its spec, its fields (a ref's keys with the labels the caller may read), and whether docs are still on their way. */
export type ReportRun = AggregateResponse & { spec: ReportSpec; fields: ReportField[]; behind: boolean; ms: number };

/**
 * Run a report as the caller: the one way a module report reads (tests/moduleSurfaces.test.ts). Its scope comes
 * only from reportPlan; the record service counts only what that scope admits, and the fake reads through the scope.
 */
async function runReport(ctx: ActionCtx, a: { module: string; spec?: ReportSpec; reportId?: Id<"reports"> }): Promise<ReportRun> {
  const started = Date.now();
  let plan: ReportPlan = await ctx.runQuery(internal.modules.reportPlan, a);
  const client = clientFor(ctx);
  const projected = client.mode === "http" && !plan.none && !plan.canon && !isCanonSource(plan.spec.object);
  if (projected) {
    await ctx.runMutation(internal.moduleJobs.initializeReports, { orgId: plan.orgId as Id<"organizations">, moduleId: plan.moduleId });
    plan = await ctx.runQuery(internal.modules.reportPlan, a);
    requireReportReady(plan);
  }
  const { spec, fields } = plan;
  // A joined dimension is asked for by its ref, then regrouped by what each ref names.
  const base = baseOf(spec, fields);
  const empty: AggregateResponse = { groups: [], subtotals: [], total: spec.measures.map((m) => (m.fn === "count" ? 0 : null)), rows: 0, truncated: false, projectedThrough: {} };
  let res = plan.none ? empty
    : plan.canon ? await canonAggregate(ctx, plan.orgId, plan.canon.object, plan.canon.title, plan.canon.request)
    : spec.object === "canon.deals" ? await canonAggregate(ctx, plan.orgId, "deal", "Deals", dealsRequest(base.spec))
    : spec.object === "canon.stageHistory" ? await stageHistoryAggregate(ctx, plan.orgId, base.spec, fields)
    : spec.object === "canon.members" ? await ctx.runQuery(internal.modules.reportMembers, { module: a.module, spec: base.spec, rollups: await memberRollups(ctx, a.module, base.spec, fields) })
    : client.mode === "http"
      ? await client.moduleAggregate(plan.orgId, { module: plan.moduleId, collection: spec.object, fields: base.fields.map(({ ref: _, join: _j, ...f }) => f), docScope: plan.docScope, projection: plan.projection!, filter: base.spec.filter, groupBy: base.spec.groupBy, measures: plainMeasures(base.spec.measures) })
      : await ctx.runQuery(internal.modules.reportInMemory, { module: a.module, spec: base.spec });
  if (base.joins.length && !plan.none) {
    const asks = base.joins.map(({ at, field: f }) => ({ ...f.join, ids: [...new Set([...res.groups, ...res.subtotals].map((g) => g.keys[at]).filter((k): k is string => typeof k === "string"))].slice(0, 2000) }));
    // A company's or person's field is the record service's, read here as the caller; the rest in Convex.
    const inConvex = asks.filter((j) => !isRecordRef(j.to));
    const convexValues: Array<Record<string, string | number | boolean | null>> = inConvex.length ? await ctx.runQuery(internal.modules.reportJoins, { module: a.module, joins: inConvex }) : [];
    const values = await Promise.all(asks.map((j) => (isRecordRef(j.to) ? recordValues(ctx, j.to, j.ids, j.field) : convexValues[inConvex.indexOf(j)])));
    // A joined date with a grain reads as the first day of its day, week, month or quarter, as the doc's own dates do.
    const grain = (at: number, v: string | number | boolean | null) => {
      const bucket = spec.groupBy[at]?.bucket ?? (["date", "datetime"].includes(base.joins.find((j) => j.at === at)?.field.type ?? "") ? "month" : undefined);
      if (!bucket || v === null || typeof v === "boolean") return v;
      const day = typeof v === "number" ? new Date(v).toISOString().slice(0, 10) : /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
      return day ? bucketStart(day, bucket) : v;
    };
    res = regroup(res, spec.measures, base.joins.map((j) => j.at), (at, id) => grain(at, values[base.joins.findIndex((j) => j.at === at)]?.[id] ?? null));
  }
  // A deal, team or doc key reads as what it names, as the caller may see it.
  const refs: Array<{ ref: { type: "ref"; to: RefTo; collection?: string }; id: string }> = [];
  spec.groupBy.forEach((g, i) => {
    const f = fields.find((x) => x.name === g.field);
    if (!f?.ref) return;
    for (const grp of [...res.groups, ...res.subtotals]) { const k = grp.keys[i]; if (typeof k === "string") refs.push({ ref: { type: "ref", ...f.ref }, id: k }); }
  });
  const labels: Record<string, string> = refs.length ? await ctx.runQuery(internal.modules.reportLabels, { module: a.module, refs: refs.slice(0, 500) }) : {};
  for (const to of RECORD_REFS) {
    const ids = [...new Set(refs.filter((r) => r.ref.to === to).map((r) => r.id))].slice(0, 500);
    for (const [id, name] of Object.entries(ids.length ? await recordValues(ctx, to, ids, "name") : {})) if (typeof name === "string") labels[refKey({ to }, id)] = name;
  }
  const shown = fields.map((f) => {
    if (!f.ref) return f;
    const ids = [...new Set(refs.filter((r) => r.ref.to === f.ref!.to && r.ref.collection === f.ref!.collection).map((r) => r.id))];
    return { ...f, type: "picklist" as const, options: ids.map((id) => ({ value: id, label: labels[`${f.ref!.to}:${f.ref!.collection ?? ""}:${id}`] ?? "Not visible to you" })) };
  });
  if (projected) {
    const after: ReportPlan = await ctx.runQuery(internal.modules.reportPlan, a);
    requireReportReady(after);
    if (!sameProjection(plan.projection, after.projection)) reportSyncing();
  }
  return { ...res, spec, fields: shown, behind: client.mode === "fake" ? false : plan.behind, ms: Date.now() - started };
}

export const stageHistory = action({
  args: { module: v.string() },
  handler: async (ctx, a) => {
    const plan: ReportPlan = await ctx.runQuery(internal.modules.reportPlan, { module: a.module, spec: { object: "canon.stageHistory", filter: [], groupBy: [ { field: "stage" } ], measures: [{ fn: "count" }], chart: "table" } });
    if ("none" in plan || ["deal", "stage", "changedAt", "leftAt", "daysInStage", "daysSoFar", "current"].some((name) => !plan.fields.some((f) => f.name === name))) throw new ConvexError("This module does not read stage history summaries.");
    const { deals, now, partial } = await readStageHistory(ctx, plan.orgId);
    return stageHistoryReport(deals.map((d) => d.visits), now, partial);
  },
});

export const pacingContext = query({
  args: { module: v.string(), id: v.string(), source: v.optional(v.string()), filter: v.optional(v.array(listFilter)), split: v.optional(v.string()), teamIds: v.optional(v.array(v.string())) },
  handler: async (ctx, a) => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const nodes = (body: readonly Node[]): Array<Extract<Node, { c: "pacing" }>> => body.flatMap((n) => n.roles && !n.roles.includes(scope.role) ? [] : n.c === "pacing" ? [n] : n.c === "tabs" ? n.tabs.filter((t) => !t.roles || t.roles.includes(scope.role)).flatMap((t) => nodes(t.body)) : []);
    const component = scope.manifest.pages.filter((p) => !p.roles || p.roles.includes(scope.role)).flatMap((p) => nodes(p.body)).find((n) => n.id === a.id);
    if (!component) throw new ConvexError("This pacing component is not available to you.");
    const sources = [];
    for (const source of component.sources) {
      const plan = await scope.reportPlan(source.collection);
      if ("none" in plan) continue;
      const date = plan.fields.find((f) => f.name === source.date && !f.join && !f.related);
      const amount = plan.fields.find((f) => f.name === source.amount && !f.join && !f.related);
      if (!date || !["date", "datetime"].includes(date.type) || amount?.type !== "currency" || (source.filter ?? []).some((f) => !plan.fields.some((x) => x.name === f.field && !x.join && !x.related))) continue;
      sources.push({ ...source, object: plan.object ?? "deal", recordSource: !!plan.object, dateType: date.type as "date" | "datetime", fields: await withDealOptions(ctx, scope.orgId, source.collection, plan.fields) });
    }
    if (a.source !== undefined) {
      const source = sources.find((s) => s.id === a.source);
      if (!source) throw new ConvexError("This pacing source is not available to you.");
      const split = a.split === "team" ? "ownerId" : a.split;
      const fields = source.fields.filter((f) => !f.join && !f.related);
      if (a.teamIds?.length && !fields.some((f) => f.name === "ownerId")) throw new ConvexError("This source has no owner for a team filter.");
      const spec: ReportSpec = { object: source.collection, filter: [...(source.filter ?? []), ...(a.filter ?? [])], groupBy: [{ field: source.date }, ...(split ? [{ field: split }] : [])], measures: [{ fn: "sum", field: source.amount }], chart: "line" };
      if (source.recordSource) await checkRecordReport(ctx, scope.orgId, source.object, source.label, spec, fields);
      else checkReport(spec, fields);
    }
    const fyStart = await fyStartOf(ctx, scope.orgId);
    const year = fiscalMonth(new Date().toISOString().slice(0, 10), fyStart).fy;
    const plans: Record<number, PacingPlan | null> = {};
    if (component.target) {
      for (let y = year; y >= year - PACING_COMPARE_MAX; y--) {
        const rows = await scope.canonRows("targets.forYear", { year: y }, 1);
        plans[y] = rows[0]?.data as PacingPlan | undefined ?? null;
      }
    }
    return { sources, plans, fyStart, roster: await rosterOf(ctx, scope.orgId), userId: scope.userId, role: scope.role };
  },
});

export const pacing = action({
  args: { module: v.string(), id: v.string(), source: v.string(), grain: v.union(v.literal("month"), v.literal("quarter"), v.literal("year")), compare: v.union(v.number(), v.literal("yoy")), split: v.optional(v.string()), filter: v.array(listFilter), teamIds: v.optional(v.array(v.string())) },
  handler: async (ctx, a): Promise<PacingResult> => {
    const context = await ctx.runQuery(api.modules.pacingContext, { module: a.module, id: a.id, source: a.source, filter: a.filter, split: a.split, teamIds: a.teamIds });
    const source = context.sources.find((s) => s.id === a.source);
    if (!source) throw new ConvexError("This pacing source is not available to you.");
    const caller = await requireCaller(ctx, { read: true });
    const spec: RunPacingSource = { object: source.object, date: source.date, dateType: source.dateType, amount: source.amount, filter: [...(source.filter ?? [])] };
    return runPacing(callerClient(ctx, caller), caller.orgId, spec, a, context.fyStart, context.roster);
  },
});

/**
 * Run a report (docs/modules.md, "Reports and charts"): `spec` as a builder edits it (`object` the collection), or a
 * saved `reportId`. Answers the groups, subtotals and total over every doc of the collection the caller reads.
 */
export const report = action({
  args: { module: v.string(), spec: v.optional(reportSpec), reportId: v.optional(v.id("reports")) },
  handler: (ctx, a): Promise<ReportRun> => runMetrics(ctx, a),
});

/** A saved report's spec, as the caller may read it, for a report run that splits it into parts. */
export const savedReportSpec = internalQuery({
  args: { module: v.string(), reportId: v.id("reports") },
  handler: async (ctx, a): Promise<ReportSpec> => scopedSavedReportSpec(ctx, await scopeOrRefuse(ctx, a.module), a.reportId),
});

/** A spec's metric filters and rates split into parts (metricSplit.ts), or a ConvexError naming what doesn't fit. */
function partsOf(spec: ReportSpec) {
  let split;
  try {
    split = splitReport(spec);
  } catch (e) {
    throw new ConvexError(`That report doesn't fit ${spec.object}: ${e instanceof Error ? e.message : String(e)}.`);
  }
  if (split.parts.length > MEASURES_MAX) throw new ConvexError(`A report's metrics read at most ${MEASURES_MAX} different sets of rows.`);
  return split;
}

/**
 * Run a report whose metrics have their own filters or are rates (Pipeline, Won revenue, Win rate): each part a
 * plain report run as the caller (so each is checked and scoped as any run is), joined group by group.
 */
async function runMetrics(ctx: ActionCtx, a: { module: string; spec?: ReportSpec; reportId?: Id<"reports"> }): Promise<ReportRun> {
  const spec = a.spec ?? (a.reportId ? await ctx.runQuery(internal.modules.savedReportSpec, { module: a.module, reportId: a.reportId }) : undefined);
  if (!spec || !needsSplit(spec)) return runReport(ctx, a);
  const { parts, refs } = partsOf(spec);
  const runs = await Promise.all(parts.map((p) => runReport(ctx, { module: a.module, spec: p })));
  return { ...joinParts(spec, refs, runs), spec, fields: runs[0].fields, behind: runs.some((r) => r.behind), ms: Math.max(...runs.map((r) => r.ms)) };
}

/** The saved versions of a report component: the caller's, and the ones shared with the workspace, by name. */
export const savedReports = query({
  args: { module: v.string(), report: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const scope = await moduleScope(ctx, a.module);
    const user = scope ? await ctx.db.get(scope.userId as Id<"users">) : null;
    if (!scope || !user) return [];
    const mine = await ctx.db.query("reports").withIndex("by_orgId_createdBy", (q) => q.eq("orgId", scope.orgId).eq("createdBy", user._id)).take(REPORTS_MAX);
    const shared = await ctx.db.query("reports").withIndex("by_orgId_shared", (q) => q.eq("orgId", scope.orgId).eq("shared", true)).take(REPORTS_MAX);
    const byId = new Map([...mine, ...shared].map((r) => [r._id, r]));
    return [...byId.values()]
      .filter((r) => r.module?.moduleId === scope.moduleId && (a.report === undefined || r.module.report === a.report))
      .map((r) => ({ _id: r._id, name: r.name, shared: r.shared, spec: r.spec, report: r.module!.report, path: scope.manifest.pages.find((p) => (!p.roles || p.roles.includes(scope.role)) && !p.path.includes(":") && reportNodes(p.body, scope.role).some((n) => n.id === r.module!.report))?.path ?? null, mine: r.createdBy === user._id, updatedAt: r.updatedAt, recipe: r.recipe ?? null }))
      .sort((x, y) => x.name.localeCompare(y.name));
  },
});

/** Retry stopped projection delivery without changing source docs or marking a receipt complete. */
export const retryReports = mutation({
  args: { module: v.string(), collection: v.string() },
  handler: async (ctx, a) => {
    const scope = await scopeOrRefuse(ctx, a.module);
    if (!scope.manifest.collections[a.collection]?.report || "none" in await scope.reportPlan(a.collection)) throw new ConvexError("You do not read this module report.");
    await retryFailed(ctx, scope.orgId, scope.moduleId, scope.manifest, [REPORT_JOB]);
    return null;
  },
});

async function validateSavedReport(ctx: QueryCtx, scope: ModuleScope, spec: ReportSpec): Promise<void> {
  const plan = await scope.reportPlan(spec.object);
  if (plan.object && "none" in plan) throw new ConvexError(`You don't read any ${(plan.title ?? spec.object).toLowerCase()}.`);
  for (const part of needsSplit(spec) ? partsOf(spec).parts : [spec]) {
    if (plan.object) await checkRecordReport(ctx, scope.orgId, plan.object, plan.title ?? spec.object, part, "none" in plan ? [] : plan.fields);
    else checkReport(part, "none" in plan ? [] : plan.fields);
  }
}

/** Save a report: a new one (the caller's, shared or not), or a change to one the caller made (an admin's moderation aside). */
export const saveReport = mutation({
  args: { module: v.string(), report: v.string(), reportId: v.optional(v.id("reports")), name: v.optional(v.string()), shared: v.optional(v.boolean()), spec: v.optional(reportSpec) },
  handler: async (ctx, a): Promise<Id<"reports">> => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const caller = (await callerOf(ctx)) ?? (() => { throw new ConvexError("Not authenticated"); })();
    if (a.spec) await validateSavedReport(ctx, scope, a.spec);
    const sharedCount = async () => (await ctx.db.query("reports").withIndex("by_orgId_shared", (q) => q.eq("orgId", scope.orgId).eq("shared", true)).take(REPORTS_MAX)).length;
    if (a.reportId) {
      const { report: r, user } = await savedReport(ctx, scope, a.reportId);
      if (r.createdBy !== user._id && !can(user, "shared.moderate")) throw new ConvexError("Only its creator or an admin changes a shared report.");
      if (a.shared && !r.shared && (await sharedCount()) >= REPORTS_MAX) throw new ConvexError(`Your team already shares ${REPORTS_MAX} reports; unshare one first`);
      await ctx.db.patch(r._id, { ...(a.name !== undefined ? { name: cleanName(a.name) } : {}), ...(a.shared !== undefined ? { shared: a.shared } : {}), ...(a.spec ? { spec: a.spec } : {}), updatedAt: Date.now() });
      return r._id;
    }
    if (!a.spec || a.name === undefined) throw new ConvexError("A new report needs a name and a spec.");
    // A report reads its collection or one of its other sources.
    if (!scope.manifest.pages.some((p) => reportNodes(p.body).some((n) => n.id === a.report && reportReads(scope.manifest, n, a.spec!.object)))) throw new ConvexError(`${scope.manifest.title} has no report ${a.report} over ${a.spec.object}.`);
    const mine = await ctx.db.query("reports").withIndex("by_orgId_createdBy", (q) => q.eq("orgId", scope.orgId).eq("createdBy", caller.user._id)).take(REPORTS_MAX);
    if (mine.length >= REPORTS_MAX) throw new ConvexError(`At most ${REPORTS_MAX} saved reports`);
    if (a.shared && (await sharedCount()) >= REPORTS_MAX) throw new ConvexError(`Your team already shares ${REPORTS_MAX} reports; unshare one first`);
    return ctx.db.insert("reports", { orgId: scope.orgId, name: cleanName(a.name), createdBy: caller.user._id, shared: a.shared ?? false, spec: a.spec, updatedAt: Date.now(), module: { moduleId: scope.moduleId, report: a.report } });
  },
});

export const removeReport = mutation({
  args: { module: v.string(), reportId: v.id("reports") },
  handler: async (ctx, a) => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const { report: r, user } = await savedReport(ctx, scope, a.reportId);
    if (r.createdBy !== user._id && !can(user, "shared.moderate")) throw new ConvexError("Only its creator or an admin deletes a shared report.");
    await ctx.db.delete(r._id);
    return null;
  },
});

/** A dashboard is available only through a page and component visible to this role. */
function dashboardPage(m: ModuleScope["manifest"], role: Role) {
  const sees = (roles?: readonly Role[]) => !roles || roles.includes(role);
  const contains = (nodes: readonly Node[]): boolean => nodes.some((n) => sees(n.roles) && (n.c === "dashboards" || (n.c === "tabs" && n.tabs.some((t) => sees(t.roles) && contains(t.body)))));
  return m.pages.find((p) => !p.path.includes(":") && sees(p.roles) && contains(p.body));
}

async function dashboardUser(ctx: QueryCtx, scope: ModuleScope) {
  if (!dashboardPage(scope.manifest, scope.role)) throw new ConvexError("This module has no dashboards page for your role.");
  const user = await withRole(ctx, await ctx.db.get(scope.userId as Id<"users">));
  if (!user || user.orgId !== scope.orgId) throw new ConvexError("Not authenticated");
  return user;
}

async function editableDashboard(ctx: QueryCtx, scope: ModuleScope, id: Id<"dashboards">) {
  const user = await dashboardUser(ctx, scope);
  const d = await ctx.db.get(id);
  if (!d || d.orgId !== scope.orgId || d.module !== scope.moduleId || !(d.shared || d.createdBy === user._id)) throw new ConvexError("Dashboard not found");
  if (d.createdBy !== user._id && !can(user, "shared.moderate")) throw new ConvexError("Only its creator or an admin changes a shared dashboard.");
  return { user, dashboard: d };
}

async function dashboardRoom(ctx: QueryCtx, scope: ModuleScope, userId: Id<"users">) {
  const mine = await ctx.db.query("dashboards").withIndex("by_orgId_module_createdBy", (q) => q.eq("orgId", scope.orgId).eq("module", scope.moduleId).eq("createdBy", userId)).take(DASHBOARDS_MAX);
  if (mine.length >= DASHBOARDS_MAX) throw new ConvexError(`At most ${DASHBOARDS_MAX} dashboards`);
}

export const dashboards = query({
  args: { module: v.string() },
  handler: async (ctx, a) => {
    const scope = await moduleScope(ctx, a.module);
    if (!scope || !dashboardPage(scope.manifest, scope.role)) return [];
    const user = await dashboardUser(ctx, scope);
    const mine = await ctx.db.query("dashboards").withIndex("by_orgId_module_createdBy", (q) => q.eq("orgId", scope.orgId).eq("module", scope.moduleId).eq("createdBy", user._id)).take(DASHBOARDS_MAX);
    const shared = await ctx.db.query("dashboards").withIndex("by_orgId_module_shared", (q) => q.eq("orgId", scope.orgId).eq("module", scope.moduleId).eq("shared", true)).take(DASHBOARDS_MAX);
    return [...new Map([...mine, ...shared].map((d) => [d._id, d])).values()].map((d) => ({
      _id: d._id, name: d.name, shared: d.shared, tiles: d.tiles, mine: d.createdBy === user._id, builtIn: d.builtIn ?? null, updatedAt: d.updatedAt,
      canChange: d.createdBy === user._id || can(user, "shared.moderate"),
    })).sort((x, y) => x.name.localeCompare(y.name));
  },
});

export const saveDashboard = mutation({
  args: { module: v.string(), dashboardId: v.optional(v.id("dashboards")), name: v.optional(v.string()), shared: v.optional(v.boolean()), tiles: v.optional(v.array(dashboardTile)) },
  handler: async (ctx, a): Promise<Id<"dashboards">> => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const user = await dashboardUser(ctx, scope);
    const d = a.dashboardId ? (await editableDashboard(ctx, scope, a.dashboardId)).dashboard : null;
    const tiles = a.tiles ?? d?.tiles ?? [];
    const shared = a.shared ?? d?.shared ?? false;
    await checkTiles(ctx, user, tiles, shared, scope.moduleId);
    const name = cleanDashboardName(a.name ?? d?.name ?? "");
    if (d) {
      await ctx.db.patch(d._id, { name, shared, tiles, updatedAt: Date.now() });
      return d._id;
    }
    await dashboardRoom(ctx, scope, user._id);
    return ctx.db.insert("dashboards", { orgId: scope.orgId, module: scope.moduleId, createdBy: user._id, name, shared, tiles, updatedAt: Date.now() });
  },
});

export const removeDashboard = mutation({
  args: { module: v.string(), dashboardId: v.id("dashboards") },
  handler: async (ctx, a) => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const { dashboard } = await editableDashboard(ctx, scope, a.dashboardId);
    await ctx.db.delete(dashboard._id);
    return null;
  },
});

export const pinReport = mutation({
  args: { module: v.string(), reportId: v.id("reports"), dashboardId: v.optional(v.id("dashboards")), name: v.optional(v.string()) },
  handler: async (ctx, a): Promise<Id<"dashboards">> => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const user = await dashboardUser(ctx, scope);
    const d = a.dashboardId ? (await editableDashboard(ctx, scope, a.dashboardId)).dashboard : null;
    const tiles = [...(d?.tiles ?? []), { reportId: a.reportId, wide: false }];
    await checkTiles(ctx, user, tiles, d?.shared ?? false, scope.moduleId);
    if (d) {
      await ctx.db.patch(d._id, { tiles, updatedAt: Date.now() });
      return d._id;
    }
    await dashboardRoom(ctx, scope, user._id);
    return ctx.db.insert("dashboards", { orgId: scope.orgId, module: scope.moduleId, createdBy: user._id, name: cleanDashboardName(a.name ?? ""), shared: false, tiles, updatedAt: Date.now() });
  },
});

/** The report components of a page's body, in its tabs too. */
function reportNodes(nodes: readonly Node[], role?: Role): Array<Extract<Node, { c: "report" }>> {
  const sees = (roles?: readonly Role[]) => !role || !roles || roles.includes(role);
  return nodes.flatMap((n) => !sees(n.roles) ? [] : n.c === "report" ? [n] : n.c === "tabs" ? n.tabs.filter((t) => sees(t.roles)).flatMap((t) => reportNodes(t.body, role)) : []);
}

// ── Exports and seals (docs/modules.md, "Exports" and "Integrity") ──

/**
 * An export's CSV, as the caller reads its rows: a list view's docs (with its joins), or `rows`, what the caller's own
 * call returned. Each column's text filled with plain values: money as 1234.50, dates as YYYY-MM-DD.
 */
export const exportPlan = internalQuery({
  args: { module: v.string(), export: v.string(), args: v.record(v.string(), v.any()), rows: v.optional(v.array(v.any())) },
  handler: async (ctx, a): Promise<ExportTable> => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const m = scope.manifest;
    const x = m.exports?.[a.export] ?? (() => { throw new ConvexError(`${m.title} has no export ${a.export}.`); })();
    if ("people" in x) throw new ConvexError("People CSV is resolved in the export action.");
    const org = await ctx.db.get(scope.orgId);
    const members = new Map((await workspaceMembers(ctx, scope.orgId)).map((u) => [u.id as string, u.name]));
    let docs: TextDoc[];
    let labels: Record<string, Record<string, string>> = {}, formats: Record<string, string> = {}, refs: Record<string, string> = {};
    if ("view" in x) {
      if (a.rows) throw new ConvexError(`${x.label} reads its rows from ${x.view}.`);
      const collection = m.views[x.view]!.collection;
      const read = await scope.exportRows(x.view, a.args, Math.min(x.limit ?? MAX_EXPORT_ROWS, MAX_EXPORT_ROWS));
      // Every row must pass the export's `require` (a payroll file only of statements whose seal still matches).
      if (x.require) {
        const bad = await scope.failingRows(collection, read, x.require.when);
        if (bad.length) throw new ConvexError(`${x.label} refused: ${x.require.message} ${bad.length} ${bad.length === 1 ? "row doesn't" : "rows don't"}: ${bad.slice(0, 5).map((b) => b.title === b.key ? b.key : `${b.title} (${b.key})`).join(", ")}${bad.length > 5 ? ", …" : ""}.`);
      }
      docs = (await scope.enrich(collection, read, x.join ?? [], {})).docs;
      labels = labelsOf(m, collection); formats = formatsOf(m, collection);
      for (const f of x.join ?? []) {
        const ref = refsOf(m, collection, f);
        if (ref?.to === "doc") { for (const [k, l] of Object.entries(labelsOf(m, ref.collection))) labels[`${f}.${k}`] = l; for (const [k, l] of Object.entries(formatsOf(m, ref.collection))) formats[`${f}.${k}`] = l; }
      }
      const c = m.collections[collection]!;
      const found = await scope.refLabels(docs.flatMap((d) => refsIn(d.data, c.schema).filter((r) => r.ref.to !== "users")));
      refs = Object.fromEntries(Object.entries(found).map(([k, label]) => [k.slice(k.indexOf(":", k.indexOf(":") + 1) + 1), label]));
    } else {
      if (!a.rows) throw new ConvexError(`${x.label} exports what ${x.call} returns: run it with exportCsv.`);
      docs = a.rows.map((row, i) => ({ key: String(i), version: 0, owner: null, data: (typeof row === "object" && row !== null ? row : { value: row }) as Record<string, unknown> }));
    }
    const c = "view" in x ? m.collections[m.views[x.view]!.collection] : undefined;
    const files = c ? await scope.fileInfo(docs.flatMap((d) => filesIn(d.data, c.schema).map((f) => f.id))) : {};
    const scopeText = { binds: {}, members, currency: org?.defaultCurrency ?? "USD", rowLabels: labels, rowFormats: formats, refs, files, plain: true };
    return {
      filename: (x.filename ?? a.export).replace(/\.(csv|xlsx)$/i, ""), label: x.label, header: x.columns.map((c) => c.label),
      rows: docs.map((row) => x.columns.map((c) => renderText(c.value, { ...scopeText, row }))), kinds: x.columns.map((c) => cellKind(c.value, formats)),
      // The docs a PDF export prints, each once, in the rows' order: the value each row holds at `pdf.key`.
      ...(x.pdf ? { pages: [...new Set(docs.map((row) => { const k = "view" in x && x.pdf!.key === "key" ? row.key : x.pdf!.key in row.data ? row.data[x.pdf!.key] : valueAt(row, x.pdf!.key); return typeof k === "string" ? k : ""; }).filter(Boolean))] } : {}),
    };
  },
});

/** An export's rows as text, each column's cells typed for a spreadsheet. */
type ExportTable = { filename: string; label: string; header: string[]; rows: string[][]; kinds: CellKind[]; pages?: string[] };
/** How a spreadsheet types a column: by the one value its text shows and that value's format (money, a number, a date). */
function cellKind(text: string, formats: Record<string, string>): CellKind {
  const one = /^\{\$row\.([a-zA-Z][a-zA-Z0-9_.]*)(?:\|([a-zA-Z]+))?\}$/.exec(text.trim());
  const format = one ? one[2] ?? formats[one[1]] : undefined;
  return format === "money" ? "money" : format === "number" || format === "percent" ? "number" : format === "date" ? "date" : "text";
}

/** The rows an export downloads, as the caller reads them: a view's, or what the caller's own run of its call returns. */
type ExportSource = { call: string | null; rows: string | null; source?: PeopleExportSource };

async function exportTable(ctx: ActionCtx, a: { module: string; export: string; args?: Record<string, unknown> }, info: ExportSource): Promise<ExportTable> {
  const given = a.args ?? {};
  if (info.call === null) return ctx.runQuery(internal.modules.exportPlan, { module: a.module, export: a.export, args: given });
  const out = await runCall(ctx, { module: a.module, call: info.call, args: given }, undefined, undefined, undefined, false);
  const raw = info.rows ? (out.value as Record<string, unknown> | null)?.[info.rows] : out.value;
  if (!Array.isArray(raw)) throw new ConvexError(`${info.call} returned no list of rows to export.`);
  return ctx.runQuery(internal.modules.exportPlan, { module: a.module, export: a.export, args: given, rows: raw });
}

async function exportPeopleCsv(ctx: ActionCtx, a: { module: string; export: string; args?: Record<string, unknown> }, source: PeopleExportSource): Promise<{ filename: string; csv: string; rows: number }> {
  const caller = await requireCaller(ctx, { read: true });
  if (caller.orgId !== source.orgId || caller.access.userId !== source.userId) throw new ConvexError("The export's caller changed. Try again.");
  if (source.recorded && caller.access.preview) throw new ConvexError("Recorded exports are off while viewing as another member.");
  const client = callerClient(ctx, caller);
  const rows = await resolvePeopleRows(client, caller.orgId, (added) => addedTo(ctx, caller.orgId as Id<"organizations">, added), source.people);
  const csv = csvOf(await peopleContacts(client, caller.orgId, rows));
  if (source.recorded) await ctx.runMutation(internal.moduleExports.recordRun, { module: a.module, export: a.export, args: a.args ?? {}, epoch: source.epoch, orgId: caller.orgId as Id<"organizations">, actor: caller.userId as Id<"users">, count: rows.length });
  return { filename: `${source.filename}.csv`, csv, rows: rows.length };
}

/** Download an export as CSV, as the caller: a view's rows, or the rows the caller's own run of a call returns. */
export const exportCsv = action({
  args: { module: v.string(), export: v.string(), args: v.optional(v.record(v.string(), v.any())) },
  handler: async (ctx, a): Promise<{ filename: string; csv: string; rows: number }> => {
    const info: ExportSource = await ctx.runQuery(internal.modules.exportSource, { module: a.module, export: a.export, args: a.args ?? {} });
    if (info.source) return exportPeopleCsv(ctx, a, info.source);
    const t = await exportTable(ctx, a, info);
    return { filename: `${t.filename}.csv`, csv: toCsv(t.header, t.rows), rows: t.rows.length };
  },
});

/**
 * Download an export as a file: CSV, or an Excel workbook whose money, numbers and dates are typed cells. The file
 * comes back as base64 (a page saves it; canon_module export hands it to the agent).
 */
export const exportFile = action({
  args: { module: v.string(), export: v.string(), args: v.optional(v.record(v.string(), v.any())), format: v.union(v.literal("csv"), v.literal("xlsx"), v.literal("pdf")), timeZone: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ filename: string; contentType: string; base64: string; rows: number }> => {
    const info: ExportSource = await ctx.runQuery(internal.modules.exportSource, { module: a.module, export: a.export, args: a.args ?? {} });
    if (info.source) {
      if (a.format !== "csv") throw new ConvexError("A people export supports only CSV.");
      const file = await exportPeopleCsv(ctx, a, info.source);
      return { filename: file.filename, contentType: "text/csv;charset=utf-8", base64: base64(new TextEncoder().encode(file.csv)), rows: file.rows };
    }
    const t = await exportTable(ctx, a, info);
    if (a.format === "pdf") {
      // One PDF of the page each doc the rows name prints (`pdf`): a statement per rep and period, each from a new page.
      const page: { page: string } | null = await ctx.runQuery(internal.modules.exportPdfPage, { module: a.module, export: a.export });
      if (!page || !t.pages) throw new ConvexError(`${t.label} has no PDF.`);
      if (t.pages.length > EXPORT_PDF_DOCS) throw new ConvexError(`${t.label}: ${t.pages.length} documents is more than one PDF holds (${EXPORT_PDF_DOCS}). Pick fewer.`);
      if (!t.pages.length) throw new ConvexError(`${t.label}: nothing to print.`);
      const docs: PdfDoc[] = [];
      for (const key of t.pages) docs.push(await printedPage(ctx, { module: a.module, path: pdfPagePath(page.page, key), timeZone: a.timeZone }));
      const bytes = pdf(joinDocs(docs));
      return { filename: `${t.filename}.pdf`, contentType: "application/pdf", base64: base64(bytes), rows: docs.length };
    }
    if (a.format === "csv") return { filename: `${t.filename}.csv`, contentType: "text/csv;charset=utf-8", base64: base64(new TextEncoder().encode(toCsv(t.header, t.rows))), rows: t.rows.length };
    return { filename: `${t.filename}.xlsx`, contentType: XLSX_TYPE, base64: base64(xlsx(t.label, t.header, t.rows, t.kinds)), rows: t.rows.length };
  },
});
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * A page as a PDF (docs/modules.md, "Records, exports and print"): the page read as the caller (api.modules.page), the
 * calls it loads run as the caller, then laid out as its print stylesheet prints it. Base64, for the page to save or
 * canon_module to hand an agent.
 */
export const pagePdf = action({
  args: { module: v.string(), path: v.array(v.string()), query: v.optional(v.record(v.string(), v.string())), filename: v.optional(v.string()), timeZone: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ filename: string; contentType: string; base64: string; pages: number }> => {
    const doc = await printedPage(ctx, a);
    const bytes = pdf(doc);
    const name = (a.filename ?? doc.title).replace(/[^a-zA-Z0-9 ._-]+/g, " ").trim().slice(0, 80) || "page";
    return { filename: `${name.replace(/\.pdf$/i, "")}.pdf`, contentType: "application/pdf", base64: base64(bytes), pages: (new TextDecoder().decode(bytes).match(/\/Type \/Page\b/g) ?? []).length };
  },
});

/** The most docs one PDF export prints. */
const EXPORT_PDF_DOCS = 100;
/** The page a PDF export prints per doc, its `:key` the doc's. */
export const exportPdfPage = internalQuery({
  args: { module: v.string(), export: v.string() },
  handler: async (ctx, a): Promise<{ page: string } | null> => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const x = scope.manifest.exports?.[a.export];
    return x?.pdf ? { page: x.pdf.page } : null;
  },
});

/** A page as the document its PDF prints: read as the caller, the calls it loads run as the caller. */
async function printedPage(ctx: ActionCtx, a: { module: string; path: string[]; query?: Record<string, string>; timeZone?: string }): Promise<PdfDoc> {
  const view = await ctx.runQuery(api.modules.page, { module: a.module, path: a.path, query: a.query ?? {} });
  if (!view || "upgrading" in view) throw new ConvexError(`This workspace has no module ${a.module} to print now.`);
  if ("failed" in view && view.failed) throw new ConvexError(view.failed.message);
  if (!view.page) throw new ConvexError(`${view.module.title} has no such page for you.`);
  const loaded: Record<string, unknown> = {};
  for (const [bind, l] of Object.entries(view.loads)) {
    if (l.args) loaded[bind] = (await runCall(ctx, { module: a.module, call: l.call, args: l.args }, undefined, undefined, undefined, false)).value;
  }
  // Times show in the reader's zone; one the runtime doesn't know shows in UTC.
  let timeZone: string | undefined;
  try { if (a.timeZone) { new Intl.DateTimeFormat(undefined, { timeZone: a.timeZone }); timeZone = a.timeZone; } } catch { timeZone = undefined; }
  const printed = new Date().toISOString().slice(0, 10);
  return printDoc({ ...view, page: { title: view.page.title, body: view.page.body, document: view.page.document }, machines: view.machines, loaded, ...(timeZone ? { timeZone } : {}) } as unknown as PrintView, `${view.module.title} · printed ${printed}`);
}

/** Where an export's rows come from: a call (and its value's field), or a view (call null). */
export const exportSource = internalQuery({
  args: { module: v.string(), export: v.string(), args: v.optional(v.record(v.string(), v.any())) },
  handler: async (ctx, a): Promise<ExportSource> => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const x = scope.manifest.exports?.[a.export] ?? (() => { throw new ConvexError(`${scope.manifest.title} has no export ${a.export}.`); })();
    if ("people" in x) {
      const problems = peopleExportProblems(scope.manifest, x);
      if (problems.length) throw new ConvexError(problems.join("; "));
      if (x.record && scope.preview) throw new ConvexError("Recorded exports are off while viewing as another member.");
      const key = a.args?.[x.people.key.arg];
      if (typeof key !== "string" || !key || Object.keys(a.args ?? {}).some((k) => k !== x.people.key.arg)) throw new ConvexError("A people export needs only its declared audience key.");
      return { call: null, rows: null, source: { people: await scope.peopleQuery(x.people.provide, key), filename: (x.filename ?? a.export).replace(/\.csv$/i, ""), recorded: !!x.record, epoch: scope.epoch, orgId: scope.orgId, userId: scope.userId } };
    }
    return "call" in x ? { call: x.call, rows: x.rows ?? null } : { call: null, rows: null };
  },
});

/**
 * How far a job's keys under a prefix are (docs/modules.md, "Actions", `wait`): how many wait, run or retry, and how many
 * stopped. A page that ran a write with `wait` watches it until none is left, then says so.
 */
export const jobProgress = query({
  // `follow`: the jobs its runs dirty in turn, each under its own prefix (docs/modules.md, "Actions": `wait.follow`).
  args: { module: v.string(), job: v.string(), prefix: v.array(v.string()), follow: v.optional(v.array(v.object({ job: v.string(), prefix: v.array(v.string()) }))) },
  handler: async (ctx, a) => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const out = { busy: 0, failed: 0, more: false, keys: {} as Record<string, string[]> };
    for (const w of [{ job: a.job, prefix: a.prefix }, ...(a.follow ?? []).slice(0, 4)]) {
      if (!scope.manifest.jobs?.[w.job]) throw new ConvexError(`${scope.manifest.title} has no job ${w.job}.`);
      const st = await prefixStatus(ctx.db, scope.orgId, scope.moduleId, scope.manifest, w.job, w.prefix.slice(0, 4), Date.now());
      out.busy += st.waiting + st.running + st.retrying;
      out.failed += st.failed.length;
      out.more ||= st.more;
      // The keys that wait or run now, by job: a wait counts the distinct keys it saw ("12 statements").
      (out.keys[w.job] ??= []).push(...st.busy);
    }
    return out;
  },
});

/** The bulk moves a doc waits on (a period paying its statements): moving, or stopped with the docs that refused named. */
export const bulkStatus = query({
  args: { module: v.string(), machine: v.string(), key: v.string() },
  handler: async (ctx, a) => (await scopeOrRefuse(ctx, a.module)).bulks(a.machine, a.key),
});

/** Run a stopped bulk move again (once the docs that refused are fixed), as a person who may run the move. */
export const retryBulk = mutation({
  args: { module: v.string(), machine: v.string(), transition: v.string(), key: v.string() },
  handler: async (ctx, a) => (await scopeOrRefuse(ctx, a.module)).retryBulk(a.machine, a.transition, a.key),
});

/** Whether a sealed doc the caller reads still matches its seal: intact, changed, or unsealed. Null when it isn't readable. */
export const verify = query({
  args: { module: v.string(), collection: v.string(), key: v.string() },
  handler: async (ctx, a) => (await scopeOrRefuse(ctx, a.module)).verify(a.collection, a.key),
});

/**
 * Local stack only: change a doc's fields with no checks, as a bug or a direct database edit might, to show a seal
 * catching it. `convex run modules:devTamper '{"orgId": ..., "module": ..., "collection": ..., "key": ..., "data": {...}}'`
 */
export const devTamper = internalMutation({
  args: { orgId: v.id("organizations"), module: v.string(), collection: v.string(), key: v.string(), data: v.record(v.string(), v.any()) },
  handler: async (ctx, a) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Tampering is for a local stack");
    const scope = await scopeOrRefuse(ctx, a.module, a.orgId);
    return tamperDoc(ctx, scope, a.collection, a.key, a.data);
  },
});

/** A local stack's synthetic docs for a load test (docs/modules.md, "Reports and charts"): inserted as Canon, at most 500 a call. */
export const devSeedDocs = internalMutation({
  args: { orgId: v.id("organizations"), module: v.string(), collection: v.string(), docs: v.array(v.object({ key: v.string(), data: v.record(v.string(), v.any()) })) },
  handler: async (ctx, a) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Seeding is for a local stack");
    if (a.docs.length > 500) throw new ConvexError("At most 500 docs a call");
    const scope = await scopeOrRefuse(ctx, a.module, a.orgId);
    const pkg = (await installedModule(ctx, a.orgId, a.module))!;
    return seedDocs(ctx, scope, a.collection, a.docs, pkg.slots ?? defaultSlots(scope.manifest));
  },
});

/** A local stack's synthetic docs removed again, by key prefix, at most 500 a call. */
export const devUnseedDocs = internalMutation({
  args: { orgId: v.id("organizations"), module: v.string(), collection: v.string(), prefix: v.string() },
  handler: async (ctx, a) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Unseeding is for a local stack");
    if (a.prefix.length < 2) throw new ConvexError("Name a key prefix of at least 2 characters");
    return unseedDocs(ctx, await scopeOrRefuse(ctx, a.module, a.orgId), a.collection, a.prefix, 500);
  },
});

// ── Install, turn on, uninstall: a person's, never an agent's ──

function checkFeeds(m: ModuleManifest) {
  for (const [name, f] of Object.entries(m.feeds ?? {})) {
    const owner = feedOf(f.feed);
    if (!owner) throw new ConvexError(`feeds.${name}.feed names unknown feed ${f.feed}.`);
    f.fields.forEach((field, i) => {
      if (!Object.hasOwn(owner.decl.fields, field)) throw new ConvexError(`feeds.${name}.fields[${i}] names unknown field ${field} of ${f.feed}.`);
    });
  }
}

type Checked = { manifest: ModuleManifest; text: string; hash: string };

/** module.json as fetched, checked: the manifest, its text and its hash. */
export async function checkModule(text: string): Promise<Checked> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ConvexError(`${MODULE_FILE} isn't JSON.`); }
  const parsed = parseModuleManifest(raw);
  if (!parsed.ok) throw new ConvexError(`${MODULE_FILE} isn't a module Canon can install: ${parsed.errors.slice(0, ERRORS_SHOWN).join("; ")}${parsed.errors.length > ERRORS_SHOWN ? ` (and ${parsed.errors.length - ERRORS_SHOWN} more)` : ""}.`);
  checkFeeds(parsed.manifest);
  importsOf(parsed.manifest);
  // Stored minified: what serves is the manifest, not its layout. The hash is of the file as fetched, which a preview pins.
  const stored = JSON.stringify(raw);
  const bytes = new TextEncoder().encode(stored).length;
  if (bytes > MODULE_STORED_MAX_BYTES) throw new ConvexError(`${MODULE_FILE} is ${Math.ceil(bytes / 1024)} KB without its spacing; a module is at most ${MODULE_STORED_MAX_BYTES / 1024} KB.`);
  return { manifest: parsed.manifest, text: stored, hash: await bundleHash(text) };
}

type InstallState = {
  canDecide: boolean;
  installed: Array<{ moduleId: string; source: ModuleSource; version: string; manifest: string; slots: Record<string, Record<string, number>> | null; upgrading: string | null }>;
  /** Uninstalled modules whose data was kept: installing again upgrades that data in place. */
  kept: Array<{ moduleId: string; version: string; manifest: string; slots: Record<string, Record<string, number>> | null }>;
  connections: Connection[];
};

export const installState = internalQuery({
  args: {},
  handler: async (ctx): Promise<InstallState> => {
    const caller = await callerOf(ctx);
    if (!caller) throw new ConvexError("Not authenticated");
    const rows = await ctx.db.query("modulePackages").withIndex("by_orgId_and_status", (q) => q.eq("orgId", caller.user.orgId).eq("status", "installed")).take(50);
    return {
      canDecide: mayDecide(caller),
      installed: rows.map((r) => ({ moduleId: r.moduleId, source: r.source, version: r.version, manifest: r.manifest, slots: r.slots ?? null, upgrading: r.pending && !r.pending.error ? r.pending.version : null })),
      kept: (await ctx.db.query("modulePackages").withIndex("by_orgId_and_status", (q) => q.eq("orgId", caller.user.orgId).eq("status", "uninstalled")).take(50))
        .map((r) => ({ moduleId: r.moduleId, version: r.version, manifest: r.manifest, slots: r.slots ?? null })),
      connections: await orgConnections(ctx, caller.user.orgId),
    };
  },
});

/** The example Canon ships as `canon:<slug>`: its files as built (modules/examples/_examples.generated.ts), and their hash. */
async function canonExample(source: string) {
  const id = source.slice(CANON_PREFIX.length);
  const ex = Object.hasOwn(MODULE_EXAMPLES, id) ? MODULE_EXAMPLES[id] : null;
  if (!ex) throw new ConvexError(`Canon ships no module ${id}.`);
  return { ex, checked: await checkModule(ex.manifest), sha: ex.sha };
}

async function fetchModule(ctx: ActionCtx, source: string, sha: string | null, bases?: SourceBases) {
  const state: InstallState = await ctx.runQuery(internal.modules.installState, {});
  if (source.startsWith(CANON_PREFIX)) {
    // An example Canon ships: no GitHub. What it is now is what installs; a sha from a preview that differs refuses.
    const { ex, checked, sha: now } = await canonExample(source);
    if (sha !== null && sha !== now) throw new ConvexError("Canon has shipped a newer build of this module since you previewed it. Preview it again.");
    const code = checked.manifest.server ? ex.bundle : null;
    if (checked.manifest.server && code === null) throw new ConvexError(`${source} declares server code that Canon didn't build.`);
    const codeHash = code === null ? null : await bundleHash(code);
    const previewHash = codeHash === null ? checked.hash : await bundleHash(`${checked.hash}:${codeHash}`);
    const pinned: CanonSource = { kind: "canon", id: source.slice(CANON_PREFIX.length), ref: checked.manifest.version, sha: now };
    return { state, checked, code, codeHash, previewHash, pinned: pinned as ModuleSource, source };
  }
  const resolved = await resolveSource(parseSource(source), bases ? [] : state.connections);
  const reader = await openSource(resolved, bases ? [] : state.connections, bases);
  const pinned = sha ?? await reader.resolveSha();
  const checked = await checkModule(await reader.fetchFile(pinned, MODULE_FILE, MODULE_MAX_BYTES));
  // A module with calls ships its server bundle beside module.json, at the same commit.
  const code = checked.manifest.server ? await reader.fetchFile(pinned, checked.manifest.server, BUNDLE_MAX_BYTES) : null;
  const codeHash = code === null ? null : await bundleHash(code);
  // What the install screen showed: the manifest, and the code with it.
  const previewHash = codeHash === null ? checked.hash : await bundleHash(`${checked.hash}:${codeHash}`);
  return { state, checked, code, codeHash, previewHash, pinned: { ...resolved, sha: pinned } as ModuleSource, source: sourceText(resolved) };
}

/** What installing `source` would add: the module at the commit its ref names now. Stores nothing. */
export const previewInstall = action({
  args: { source: v.string() },
  handler: async (ctx, args) => {
    const { state, checked: { manifest: m }, code, codeHash, previewHash, pinned, source } = await fetchModule(ctx, args.source, null);
    const existing = state.installed.find((p) => p.moduleId === m.id) ?? null;
    // Installing over an installed version upgrades it in place: what that does to its data, and what it newly reads.
    let upgrade: (Omit<UpgradePlan, "slots" | "work"> & { from: string; older: boolean; sameCommit: boolean; running: string | null; kept: boolean }) | null = null;
    // Installing again over the data an uninstall kept also upgrades it in place, as install plans it (installAt).
    const kept = existing ? null : state.kept.find((p) => p.moduleId === m.id) ?? null;
    const base = existing ?? kept;
    if (base) {
      const from = JSON.parse(base.manifest) as ModuleManifest;
      const { slots: _s, work: _w, ...plan } = planUpgrade(from, base.slots ?? defaultSlots(from), m, base.version);
      upgrade = existing
        ? { ...plan, from: existing.version, older: compareVersions(m.version, existing.version) < 0, sameCommit: existing.source.sha === pinned.sha, running: existing.upgrading, kept: false }
        : { ...plan, from: base.version, older: false, sameCommit: false, running: null, kept: true };
    }
    return {
      upgrade,
      imports: importsOf(m),
      source, pinned, manifestHash: previewHash,
      // What the module reads of Canon's records, which installing grants, and its server code.
      feeds: Object.entries(m.feeds ?? {}).map(([name, f]) => {
        const owner = feedOf(f.feed)!;
        return { name, label: owner.decl.label, fields: f.fields.map((field) => owner.decl.fields[field].label), perMember: owner.connector.scope === "member" };
      }),
      reads: Object.entries(m.reads ?? {}).map(([object, fields]) => ({ object, fields: object === "records" ? [...fields] : ["id", ...fields] })),
      // The writes to Canon's records it may propose, each held for a person's approval unless an admin's standing grant
      // covers it (docs/modules.md, "Writes to Canon records", "Standing grants").
      proposes: (m.proposes ?? []).map((operation) => ({ operation, label: PROPOSAL_OPERATIONS[operation].label, grantable: grantableLabel(operation) })),
      // What it may send (docs/modules.md, "Outbound"): each channel stays off until an admin turns it on.
      outbound: [
        ...(m.outbound?.email ? [{ channel: "email", what: `Email: ${m.outbound.email.kinds.join(", ")} from ${m.outbound.email.from.map((f) => (f === "workspace" ? "the workspace" : "a member's mailbox")).join(" or ")}` }] : []),
        ...(m.outbound?.slack ? [{ channel: "slack", what: `Slack: ${m.outbound.slack.channels.map((c) => `#${c}`).join(", ")}` }] : []),
        ...(m.outbound?.webhook ? [{ channel: "webhook", what: `Webhooks: ${m.outbound.webhook.events.join(", ")}` }] : []),
      ],
      // Other modules' interfaces it reads, and the ones it publishes (docs/modules.md, "Reading another module").
      uses: Object.entries(m.uses ?? {}).flatMap(([module, names]) => names.map((name) => ({ module, name }))),
      provides: Object.entries(m.provides ?? {}).map(([name, p]) => ({ name, fields: [...p.fields] })),
      server: code === null ? null : { path: m.server!, hash: codeHash!, bytes: code.length },
      calls: Object.entries(m.calls ?? {}).map(([name, c]) => ({ name, label: c.label, agent: c.agent, writes: c.writes, ...(c.canon ? { canon: c.canon } : {}) })),
      // Team aggregates read every doc of a collection as figures (docs/modules.md, "Team aggregates"): the install says so.
      aggregates: Object.values(m.calls ?? {}).flatMap((c) => Object.values(c.reads).flatMap((r) => ("aggregate" in r ? [{ call: c.label, collection: r.aggregate.collection, minOwners: r.aggregate.minOwners ?? MIN_AGGREGATE_OWNERS }] : []))),
      id: m.id, version: m.version, title: m.title, description: m.description, author: m.author.org, nav: navOf(m), links: linksOf(m),
      collections: Object.entries(m.collections).map(([name, c]) => ({ name, fields: Object.keys(c.schema.value), setOf: c.setOf?.parent ?? null, access: c.access })),
      pages: m.pages.map((p) => ({ path: p.path, title: p.title })),
      ops: [
        ...Object.entries(m.ops).map(([name, op]) => ({ name, label: op.label, agent: op.agent })),
        ...Object.entries(m.machines ?? {}).flatMap(([mn, mc]) => Object.entries(mc.transitions).map(([tn, t]) => ({ name: `${mn}.${tn}`, label: t.label, agent: agentModeOf(m, mn, tn).mode }))),
        ...Object.entries(m.calls ?? {}).map(([name, c]) => ({ name: `call ${name}`, label: c.label, agent: c.agent })),
      ],
      installed: existing && { version: existing.version, sha: existing.source.sha, source: moduleSourceText(existing.source), sameSource: sameSource(existing.source, pinned) },
      canInstall: state.canDecide,
    };
  },
});

type Consent = { approveReads?: boolean; drop?: string[] };
const consentArgs = { approveReads: v.optional(v.boolean()), drop: v.optional(v.array(v.string())) };

type Installed = { moduleId: string; version: string; slug: string; status: "installed" | "upgrading" };
async function installAt(ctx: ActionCtx, source: string, sha: string, manifestHash: string | null, consent: Consent, bases?: SourceBases): Promise<Installed> {
  const { state, checked, code, codeHash, previewHash, pinned } = await fetchModule(ctx, source, sha, bases);
  if (!state.canDecide) throw new ConvexError(AGENT_REFUSED);
  if (manifestHash !== null && previewHash !== manifestHash) throw new ConvexError("The module at this commit isn't the one you previewed. Preview it again.");
  const storageId = code === null ? undefined : await ctx.storage.store(new Blob([code], { type: "text/javascript" }));
  try {
    const status: "installed" | "upgrading" = await ctx.runMutation(internal.modules.storeModule, {
      moduleId: checked.manifest.id, source: pinned, version: checked.manifest.version, manifest: checked.text, manifestHash: checked.hash,
      ...(storageId ? { bundleHash: codeHash!, bundleStorageId: storageId } : {}), ...consent,
    });
    return { moduleId: checked.manifest.id, version: checked.manifest.version, slug: moduleSlug(checked.manifest.id), status };
  } catch (e) {
    if (storageId) await ctx.storage.delete(storageId);
    throw e;
  }
}

/**
 * Install the module a preview showed: fetched again at its pinned commit, refused if module.json changed. Over an
 * installed version it upgrades in place: `approveReads` approves the Canon fields it newly reads, and `drop` names
 * the collections it leaves out whose docs may go.
 */
export const install = action({
  args: { source: v.string(), sha: v.string(), manifestHash: v.string(), ...consentArgs },
  handler: async (ctx, args) => installAt(ctx, args.source, args.sha, args.manifestHash, { approveReads: args.approveReads, drop: args.drop }),
});

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;
/**
 * Local stack only: install from a GitHub fixture served on this machine (scripts/recipe-github-fixture.ts), the same
 * path as install with GitHub's API and raw bases pointed at it:
 *   convex run modules:installFromLocalBase '{"base": "http://127.0.0.1:4790", "source": "github:owner/repo/dir@v1.0.0"}'
 */
export const installFromLocalBase = internalAction({
  args: { base: v.string(), source: v.string(), ...consentArgs },
  handler: async (ctx, args) => {
    if (!isDevAuthBypassEnabled()) throw new ConvexError("Local installs are for a local stack");
    if (!LOOPBACK.test(args.base)) throw new ConvexError("Serve the fixture on 127.0.0.1");
    const bases = { api: `${args.base}/api`, raw: `${args.base}/raw` };
    const { pinned } = await fetchModule(ctx, args.source, null, bases);
    return installAt(ctx, args.source, pinned.sha, null, { approveReads: args.approveReads, drop: args.drop }, bases);
  },
});

const storeArgs = {
  moduleId: v.string(), source: pinnedSource, version: v.string(), manifest: v.string(), manifestHash: v.string(),
  bundleHash: v.optional(v.string()), bundleStorageId: v.optional(v.id("_storage")), ...consentArgs,
};
type ModuleInstall = {
  moduleId: string; source: ModuleSource; version: string; manifest: string; manifestHash: string;
  bundleHash?: string; bundleStorageId?: Id<"_storage">;
} & Consent;

/**
 * Store a checked module: a first install, or a version over the installed one (docs/modules.md, "Upgrades"). An
 * upgrade keeps the module's data. Its indexes keep their slots or take free ones; when a slot or a schema changes,
 * the new version waits as `pending` while upgradeStep rewrites every doc in batches, and serves once it is done.
 */
export const storeModule = internalMutation({
  args: storeArgs,
  handler: async (ctx, args): Promise<"installed" | "upgrading"> => {
    const user = await requireDecider(ctx);
    return applyModule(ctx, user.orgId, args, user._id);
  },
});

/** The shared installer for an admin's choice and Canon's consent-free default upgrades. */
export async function applyModule(ctx: MutationCtx, orgId: Id<"organizations">, args: ModuleInstall, installer?: Id<"users">): Promise<"installed" | "upgrading"> {
  return withModulePublication(ctx, async () => {
    const slug = moduleSlug(args.moduleId);
    const taken = await ctx.db.query("modulePackages").withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId).eq("slug", slug)).unique();
    if (taken && taken.moduleId !== args.moduleId) throw new ConvexError(`This workspace has a module named ${slug} already (${taken.moduleId}). Its id's name is its address, so only one can be installed.`);
    const next = JSON.parse(args.manifest) as ModuleManifest;
    await assertOwnedPackageChange(ctx, orgId, args.moduleId, { source: args.source, manifest: next });
    await assertCollectionLimits(ctx, orgId, args.moduleId, next);
    importsOf(next);
    checkFeeds(next);
    const row = await packageRow(ctx, orgId, args.moduleId);
    const fields = {
      slug, source: args.source, version: args.version, manifest: args.manifest, manifestHash: args.manifestHash,
      bundleHash: args.bundleHash, bundleStorageId: args.bundleStorageId, installedBy: installer, installedAt: Date.now(), status: "installed" as const,
    };
    if (!row) {
      await captureInstalledPackage(ctx, () => ctx.db.insert("modulePackages", { orgId, moduleId: args.moduleId, ...fields, epoch: 1, slots: defaultSlots(next) }));
      await ensureActivityBaselines(ctx, orgId, args.moduleId, next, null);
      await providedCollectionsReset(ctx, orgId, [next]);
      await startImports(ctx, orgId, args.moduleId, next);
      return "installed";
    }
    if (row.pending && !row.pending.error) throw new ConvexError(`${args.moduleId} is upgrading to v${row.pending.version}. Wait for it, or cancel it on the Customization page, first.`);
    if (row.status === "installed") {
      if (!sameSource(row.source, args.source)) throw new ConvexError(`${args.moduleId} is already installed from ${moduleSourceText(row.source)}. Uninstall it before installing it from another source.`);
      if (row.source.sha === args.source.sha) throw new ConvexError(`${args.moduleId} is already installed at this commit (v${row.version}).`);
      if (compareVersions(args.version, row.version) < 0) throw new ConvexError(`v${args.version} is older than the installed v${row.version}. Canon upgrades a module; it doesn't go back a version.`);
    }
    await assertSq1PackageUpgrade(ctx, orgId, args.moduleId);
    // Installed or not, the docs it kept are laid out by the version stored last: plan from that one.
    const from = manifestOf(row);
    const plan = planUpgrade(from, row.slots ?? defaultSlots(from), next, row.version);
    if (plan.problems.length) throw new ConvexError(`v${args.version} can't upgrade v${row.version} in place: ${plan.problems.join("; ")}.`);
    if (plan.newReads.length && !args.approveReads) throw new ConvexError(`v${args.version} reads more of your workspace than v${row.version}: ${plan.newReads.join(", ")}. Approve it on the install screen.`);
    for (const name of plan.dropped) {
      if (!args.drop?.includes(name) && (await hasDocs(ctx, orgId, args.moduleId, name))) throw new ConvexError(`v${args.version} removes ${name}, which has docs. Confirm on the install screen that they may be deleted.`);
    }
    // A stopped upgrade gives way to this one, a fixed version of it or a newer one. Its epoch is never reused: the
    // docs it migrated are marked with it.
    const source = moduleSource(row);
    await capturePackageState(ctx, source, async () => null);
    const stopped = row.pending;
    const epoch = Math.max(row.epoch ?? 1, stopped?.epoch ?? 0) + 1;
    if (stopped?.bundleStorageId && stopped.bundleStorageId !== row.bundleStorageId && stopped.bundleStorageId !== args.bundleStorageId) await ctx.storage.delete(stopped.bundleStorageId);
    if (!plan.work.length) {
      if (row.bundleStorageId && row.bundleStorageId !== args.bundleStorageId) await ctx.storage.delete(row.bundleStorageId);
      await capturePackageState(ctx, source, () => ctx.db.patch(row._id, { ...fields, epoch, slots: plan.slots, pending: undefined }));
      await providedCollectionsReset(ctx, orgId, [from, next]);
      await storePendingManifest(ctx, row, null);
      // A version that reports on other collections, or the same ones, sends their docs to the record service again,
      // and its upgrade job runs once.
      await servesNewVersion(ctx, orgId, args.moduleId, next, from);
      return "installed";
    }
    // The next manifest waits in a document of its own: with the serving one, it wouldn't fit in the row.
    await storePendingManifest(ctx, row, { manifest: args.manifest, manifestHash: args.manifestHash });
    await capturePackageState(ctx, source, () => ctx.db.patch(row._id, {
      ...(row.status === "installed" ? {} : { status: "installed" as const }),
      pending: {
        version: args.version, source: args.source, manifestHash: args.manifestHash, bundleHash: args.bundleHash, bundleStorageId: args.bundleStorageId,
        epoch, slots: plan.slots, work: plan.work, step: 0, done: 0, by: installer, at: Date.now(), ...(migrates(plan.work) ? { phase: "migrate" as const, staged: [] } : {}),
      },
    }));
    await ctx.scheduler.runAfter(0, internal.modules.upgradeStep, { orgId, moduleId: args.moduleId, epoch });
    return "upgrading";
  });
}

export const ensureShippedReports = mutation({
  args: { module: v.string() },
  handler: async (ctx, a) => {
    const scope = await scopeOrRefuse(ctx, a.module);
    const pkg = await installedModule(ctx, scope.orgId, scope.moduleId);
    if (!pkg || (scope.manifest.imports ?? []).some((name) => !pkg.imports?.[name]?.done)) return { created: 0 };
    return { created: await installShippedReports(ctx, scope.orgId, scope.manifest, (spec) => validateSavedReport(ctx, scope, spec)) };
  },
});

export const installShipped = internalMutation({
  args: { orgId: v.id("organizations"), moduleId: v.string() },
  handler: async (ctx, a): Promise<void> => {
    const pkg = await installedModule(ctx, a.orgId, a.moduleId);
    if (!pkg || (pkg.pending && !pkg.pending.error)) return;
    const m = manifestOf(pkg);
    if ((m.imports ?? []).some((name) => !pkg.imports?.[name]?.done)) return;
    const scope = await systemScope(ctx, a.orgId, a.moduleId, true);
    if (scope) await installShippedReports(ctx, a.orgId, m, async (spec) => {
      const object = recordObjectOf(m, spec.object);
      if (object) await checkSpec(ctx, a.orgId, { ...spec, object });
      else checkReport(spec, isCanonSource(spec.object) ? canonSourceFields(m, spec.object) : reportFields(m.collections[spec.object], m));
    });
  },
});

const importArgs = { orgId: v.id("organizations"), moduleId: v.string(), name: v.string(), cursor: v.union(v.string(), v.null()) };
type ImportBatchResult = { status: "idle" | "applied" } | { status: "waiting"; publicationId: Id<"moduleActivityPublications"> };

export const importBatch = internalMutation({
  args: importArgs,
  handler: async (ctx, a): Promise<ImportBatchResult> => {
    const pkg = await packageRow(ctx, a.orgId, a.moduleId);
    const state = pkg?.imports?.[a.name];
    if (!pkg || pkg.status !== "installed" || !state || state.done || state.error || state.cursor !== a.cursor) return { status: "idle" };
    if (pkg.pending && !pkg.pending.error && (cuttingOver(pkg) || holdsWrites(pkg.pending.work))) return { status: "idle" };
    const scope = await systemScope(ctx, a.orgId, a.moduleId, true);
    if (!scope) throw new ConvexError("The import's module is unavailable.");
    if (!importsOf(scope.manifest).some((entry) => entry.name === a.name)) return { status: "idle" };
    const publication = await retainedSourcePublication(ctx, pkg);
    if (publication) return { status: "waiting", publicationId: publication._id };
    const entry = MODULE_IMPORTS[a.name];
    const batch = "adopt" in entry
      ? { docs: [], ...await entry.adopt(ctx, a.orgId, state.cursor) }
      : await entry.batch({ db: ctx.db, auth: ctx.auth, storage: ctx.storage, runQuery: ctx.runQuery }, a.orgId, state.cursor, scope);
    if (batch.cursor !== null && batch.cursor === state.cursor) throw new ConvexError("The import did not advance its cursor.");
    await scope.importDocs(a.name, batch.docs);
    await ctx.db.patch(pkg._id, { imports: { ...pkg.imports, [a.name]: { cursor: batch.cursor, done: batch.cursor === null, ...("error" in batch && typeof batch.error === "string" && batch.error ? { error: batch.error } : {}) } } });
    if (batch.cursor === null) await ctx.scheduler.runAfter(0, internal.modules.installShipped, { orgId: a.orgId, moduleId: a.moduleId });
    if (batch.cursor !== null) await ctx.scheduler.runAfter(0, internal.modules.importStep, { ...a, cursor: batch.cursor });
    return { status: "applied" };
  },
});

export const resumeImports = internalMutation({
  args: { packageId: v.id("modulePackages"), publicationId: v.id("moduleActivityPublications") },
  handler: async (ctx, a): Promise<void> => {
    const pkg = await ctx.db.get(a.packageId);
    const publication = await ctx.db.get(a.publicationId);
    if (!pkg || pkg.status !== "installed" || pkg.activityPublication || !publication || publication.state !== "complete" || publication.retainsPackage
      || publication.packageId !== pkg._id || publication.orgId !== pkg.orgId || publication.moduleId !== pkg.moduleId) return;
    if (pkg.pending && !pkg.pending.error && (cuttingOver(pkg) || holdsWrites(pkg.pending.work))) return;
    const scope = await systemScope(ctx, pkg.orgId, pkg.moduleId, true);
    if (!scope || scope.epoch !== (pkg.epoch ?? 1) || !importsOf(scope.manifest).some(({ name }) => { const state = pkg.imports?.[name]; return state && !state.done && !state.error; })) return;
    await startImports(ctx, pkg.orgId, pkg.moduleId, scope.manifest);
  },
});

/** A child transaction lets a failed batch roll back while its parent records the error. */
export const importStep = internalMutation({
  args: importArgs,
  handler: async (ctx, a): Promise<void> => {
    try {
      await ctx.runMutation(internal.modules.importBatch, a);
    } catch (e) {
      const pkg = await packageRow(ctx, a.orgId, a.moduleId);
      const state = pkg?.imports?.[a.name];
      if (!pkg || !state || state.done || state.error || state.cursor !== a.cursor) return;
      const error = e instanceof ConvexError ? String(e.data) : e instanceof Error ? e.message : String(e);
      await ctx.db.patch(pkg._id, { imports: { ...pkg.imports, [a.name]: { ...state, error: error.slice(0, 600) || "The import failed." } } });
    }
  },
});

/**
 * One batch of a pending upgrade's backfill, then the next, until the new version serves or a doc stops it. A
 * migration's batch runs in the recipe runtime: upgradeMigrate, which hands back here.
 */
export const upgradeStep = internalMutation({
  args: { orgId: v.id("organizations"), moduleId: v.string(), epoch: v.number() },
  handler: async (ctx, args): Promise<"more" | "done" | "failed" | "migrate" | null> => {
    const pkg = await packageRow(ctx, args.orgId, args.moduleId);
    if (!pkg?.pending || pkg.pending.epoch !== args.epoch) return null;
    const out = await upgradeBatch(ctx, pkg, UPGRADE_BATCH);
    if (out === "more") await ctx.scheduler.runAfter(0, internal.modules.upgradeStep, args);
    if (out === "migrate") await ctx.scheduler.runAfter(0, internal.modules.upgradeMigrate, args);
    return out;
  },
});

const upgradeArgs = { orgId: v.id("organizations"), moduleId: v.string(), epoch: v.number() };

/** A migration's next batch and the bundle that migrates it: the pending version's. */
export const migrationRead = internalQuery({
  args: upgradeArgs,
  handler: async (ctx, a) => {
    const pkg = await packageRow(ctx, a.orgId, a.moduleId);
    if (!pkg?.pending || pkg.pending.epoch !== a.epoch) return null;
    const batch = await migrationBatch(ctx, pkg, MIGRATE_BATCH);
    const p = pkg.pending;
    return batch && { ...batch, bundle: p.bundleHash && p.bundleStorageId ? { hash: p.bundleHash, storageId: p.bundleStorageId as string } : null };
  },
});

/**
 * One batch of an upgrade's migration (docs/modules.md, "Upgrades and migrations"): its docs read as Canon, the
 * module's migration function run on them in the recipe runtime, in the workspace's system isolate, and its results
 * applied all or none. The installed version serves meanwhile, and its writes wait.
 */
export const upgradeMigrate = internalAction({
  args: upgradeArgs,
  handler: async (ctx, a): Promise<"more" | "failed" | "stale" | null> => {
    const b = await ctx.runQuery(internal.modules.migrationRead, a);
    if (!b) return null;
    const at = { ...a, step: b.step, cursor: b.cursor, keys: b.docs.map((d) => d.key) };
    let results: unknown = null, error: string | null = null;
    if (!b.bundle) error = `v${b.to} migrates ${b.collection} but has no server code`;
    else {
      try {
        const r = await runModuleCall(ctx, b.bundle, {
          isolate: `${a.orgId}:system`, call: b.call, ctx: { now: Date.now(), caller: { userId: "system", role: "system" }, args: { collection: b.collection, from: b.from, to: b.to } }, reads: { docs: b.docs },
        });
        if (r.ok) results = r.value;
        else error = `The migration ${b.call} of ${b.collection} failed on the batch from ${b.docs[0]?.key ?? "the start"} (${r.error.kind}): ${r.error.message}`;
      } catch (e) {
        error = `The migration ${b.call} of ${b.collection} couldn't run: ${e instanceof ConvexError ? String(e.data) : e instanceof Error ? e.message : String(e)}`;
      }
    }
    return ctx.runMutation(internal.modules.migrationApply, { ...at, results, error });
  },
});

/** A migration batch's results, or why it couldn't run; then the upgrade's next step. */
export const migrationApply = internalMutation({
  args: { ...upgradeArgs, step: v.number(), cursor: v.union(v.string(), v.null()), keys: v.array(v.string()), results: v.any(), error: v.union(v.string(), v.null()) },
  handler: async (ctx, a): Promise<"more" | "failed" | "stale"> => {
    const pkg = await packageRow(ctx, a.orgId, a.moduleId);
    if (!pkg?.pending) return "stale";
    const where = { epoch: a.epoch, step: a.step, cursor: a.cursor };
    if (a.error !== null) {
      await stopUpgrade(ctx, pkg, where, `${a.error.slice(0, 600)}. Ship a fixed version and upgrade to it, or cancel the upgrade.`);
      return "failed";
    }
    const out = await applyMigration(ctx, pkg, { ...where, keys: a.keys, batch: MIGRATE_BATCH }, a.results);
    if (out === "more") await ctx.scheduler.runAfter(0, internal.modules.upgradeStep, { orgId: a.orgId, moduleId: a.moduleId, epoch: a.epoch });
    return out;
  },
});

/** Stop a pending upgrade: the installed version keeps serving. Docs a drop already deleted stay deleted. */
export const cancelUpgrade = mutation({
  args: { moduleId: v.string() },
  handler: async (ctx, args) => withModulePublication(ctx, async () => {
    const user = await requireDecider(ctx);
    const row = await packageRow(ctx, user.orgId, args.moduleId);
    if (!row?.pending) throw new ConvexError(`${args.moduleId} isn't upgrading.`);
    const pending = row.pending;
    if (cuttingOver(row)) throw new ConvexError(`${args.moduleId} is finishing its upgrade to v${row.pending.version}: its migrated data is going in. It can't be cancelled now.`);
    const source = await continuationSource(ctx, row);
    await capturePackageState(ctx, source, async () => null);
    if (row.pending.bundleStorageId && row.pending.bundleStorageId !== row.bundleStorageId) await ctx.storage.delete(row.pending.bundleStorageId);
    // Docs it migrated carry its epoch: the next upgrade takes a later one.
    await capturePackageState(ctx, source, () => ctx.db.patch(row._id, { pending: undefined, ...(migrates(pending.work) ? { epoch: pending.epoch } : {}) }));
    await storePendingManifest(ctx, row, null);
    return null;
  }),
});

/** Turn an installed module on or off for the workspace: its nav entry and pages, for everyone its pages admit. */
export const setEnabled = mutation({
  args: { moduleId: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => setModuleEnabled(ctx, await requireDecider(ctx), args),
});

export async function setModuleEnabled(ctx: MutationCtx, user: Doc<"users">, args: { moduleId: string; enabled: boolean }): Promise<null> {
  return withModulePublication(ctx, async () => {
    if (!args.enabled) await assertOwnedPackageChange(ctx, user.orgId, args.moduleId);
    const pkg = await installedModule(ctx, user.orgId, args.moduleId);
    if (!pkg) throw new ConvexError(`${args.moduleId} isn't installed.`);
    // A module with a deal feed reads the ledger from the moment it is first on.
    if (args.enabled) await ensureCursors(ctx, user.orgId, pkg.moduleId, manifestOf(pkg), manifestOf(pkg));
    const row = await enablementRow(ctx, user.orgId, args.moduleId);
    const changed = row?.enabled !== args.enabled;
    const source = moduleSource(pkg, row?.enabled === true);
    if (changed) await capturePackageState(ctx, source, async () => null);
    if (!args.enabled && changed) await pauseSq1Package(ctx, user.orgId, pkg.moduleId, user._id);
    // Turned on, its reported docs go to the record service whole: writes while it was off weren't sent.
    if (args.enabled && !row?.enabled) await rebuildProjection(ctx, user.orgId, pkg.moduleId, manifestOf(pkg));
    const change = { enabled: args.enabled, by: user._id, at: Date.now() };
    if (row) { if (row.enabled !== args.enabled) await capturePackageState(ctx, source, () => ctx.db.patch(row._id, change)); }
    else await capturePackageState(ctx, source, () => ctx.db.insert("recipeEnablements", { orgId: user.orgId, point: MODULE_POINT, recipeId: args.moduleId, contributionKey: MODULE_CONTRIBUTION, ...change }));
    if (changed) await providedCollectionsReset(ctx, user.orgId, [manifestOf(pkg)]);
    return null;
  });
}

/** Remove an installed module. Refused while it is on. Its data stays, for a reinstall. */
export const uninstall = mutation({
  args: { moduleId: v.string() },
  handler: async (ctx, args) => withModulePublication(ctx, async () => {
    const user = await requireDecider(ctx);
    await assertOwnedPackageChange(ctx, user.orgId, args.moduleId);
    const row: Doc<"modulePackages"> | null = await installedModule(ctx, user.orgId, args.moduleId);
    if (!row) throw new ConvexError(`${args.moduleId} isn't installed.`);
    if (await isEnabled(ctx, user.orgId, row.moduleId)) throw new ConvexError(`${row.moduleId} is on. Turn it off first.`);
    if (row.pending) throw new ConvexError(`${row.moduleId} is upgrading to v${row.pending.version}. Cancel the upgrade first.`);
    const source = moduleSource(row);
    await capturePackageState(ctx, source, async () => null);
    await pauseSq1Package(ctx, user.orgId, row.moduleId, user._id);
    await capturePackageState(ctx, source, () => ctx.db.patch(row._id, { status: "uninstalled" }));
    await providedCollectionsReset(ctx, user.orgId, [manifestOf(row)]);
    return null;
  }),
});
