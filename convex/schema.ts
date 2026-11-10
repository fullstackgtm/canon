import { defineSchema, defineTable } from "convex/server";
import { sourceFactsFields, sourceMatch, sourceSeed } from "./lib/tam/marketSourcesValidator";
import { candidateFields, discoverySource, investigationStatus, planSource } from "./lib/tam/investigationValidator";
import { companyWebFactsFields } from "./lib/tam/companyWebFactsValidator";
import { keptPerson } from "./lib/tam/companyPeopleValidator";
import { briefValidator } from "./lib/onboardingBrief";
import { companyFindingValidator, teamShapeValidator, onboardingAnswersValidator, startingPlanValidator, researchEventValidator } from "./lib/startingPlan";
import { v } from "convex/values";
import { marketSegmentsValidator } from "./lib/segments/validator";
import { PAUSE_REASON_KEYS } from "./lib/agents/standing";
import * as objectValidators from "./lib/objects/validators";
import { deciderValidator } from "./lib/canon/decider";
import { filterValidator, runScopeValidator } from "./lib/scopeValidators";
import { outcomeFields, traceValidator } from "./lib/research/validators";
import * as observations from "./lib/signals/observations";
import { icpGateValidator, icpVersionWeightsValidator } from "./lib/scoreHistory";
import { icpGapCheckValidator, icpSpecValidator } from "./lib/icpSpec";
import { targetPlanFields } from "./lib/reports/validators";
import { FORECAST_CATEGORIES } from "./lib/pipelines";
import * as automation from "./lib/automations";
import { draftReviewValidator, dealRole, playChannel, playItemKind, playOrigin } from "./lib/plays/validators";
import { stateValidator, stateSummaryValidator } from "./lib/plays/state";
import { recordingPolicyFields } from "./lib/recordingPolicy";
import { provenanceValidator } from "../recipes/templates.ts";
import { sequenceLaunchFields, sequenceEnrollmentFields, outboxRequest } from "./lib/sequences/validators";
import { emailSendOutboxAttempt, mailboxMetadata, mailboxRefusal } from "./lib/outbound/mailboxTypes";

/** One column of a module index slot (moduleDocs): a declared index field's value. */
const moduleSlot = v.optional(v.union(v.string(), v.number(), v.boolean(), v.null()));
/** A module package's GitHub source, pinned to a commit. */
const moduleSource = v.union(
  v.object({ kind: v.literal("github-public"), owner: v.string(), repo: v.string(), path: v.optional(v.string()), ref: v.string(), sha: v.string() }),
  v.object({ kind: v.literal("github-app"), installationId: v.number(), owner: v.string(), repo: v.string(), path: v.optional(v.string()), ref: v.string(), sha: v.string() }),
  // A first-party example Canon ships (modules/examples/): its slug, its version and the hash of its files.
  v.object({ kind: v.literal("canon"), id: v.string(), ref: v.string(), sha: v.string() }),
);
/** Per collection, the moduleDocs slot (0 to 7) each named index fills (modules/kernel/upgrade.ts). */
const moduleSlots = v.record(v.string(), v.record(v.string(), v.number()));

export default defineSchema({
  // ── Identity & Multi-Tenancy ─────────────────────────────────

  organizations: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.string(),
    industry: v.optional(v.string()),
    fiscalYearStartMonth: v.number(),
    defaultCurrency: v.string(),
    // The places money shows with (0 to 4); absent: 2.
    currencyDecimals: v.optional(v.number()),
    timezone: v.string(),
    outboundEmailPolicy: v.optional(v.object({ postalAddress: v.string(), recipientWeeklyCap: v.number(), updatedAt: v.number(), updatedBy: v.id("users") })),
    signupInvestigation: v.optional(v.union(
      v.object({ state: v.literal("pending"), sessionId: v.id("researchSessions") }),
      v.object({ state: v.literal("skipped"), sessionId: v.id("researchSessions") }),
      v.object({ state: v.literal("started"), sessionId: v.id("researchSessions"), investigationId: v.id("tamInvestigations") }),
    )),
    startingPlan: v.optional(startingPlanValidator),
    onboardingCompletedAt: v.optional(v.number()),
    onboardingDismissedAt: v.optional(v.number()),
    // TAM explorer: annual $ per employee, sizing the "Opportunity" metric (employees x price).
    tamSeatPriceUsd: v.optional(v.number()),
    syncSchedule: v.optional(
      v.union(v.literal("daily"), v.literal("weekly"), v.literal("monthly")),
    ),
    hierarchySource: v.optional(
      v.union(
        v.literal("salesforce"),
        v.literal("hubspot"),
        v.literal("csv"),
        v.literal("manual"),
      ),
    ),
    hierarchySyncedAt: v.optional(v.number()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripeSubscriptionStatus: v.optional(v.string()),
    stripePriceId: v.optional(v.string()),
    stripeCurrentPeriodEnd: v.optional(v.number()),
    // The subscription ends at stripeCurrentPeriodEnd instead of renewing (canceled in the portal).
    stripeCancelAtPeriodEnd: v.optional(v.boolean()),
    // Prepaid credits (convex/credits.ts): the purchased balance in micro-credits, kept with every
    // creditLedger write, and the workspace's Metronome customer and contract (the billing record).
    // `creditUnit` marks a balance already converted from the old dollar unit (lib/creditPacks.ts).
    creditBalanceMicro: v.optional(v.number()),
    creditUnit: v.optional(v.literal("credits")),
    // The month's free allowance (FREE_CREDITS_PER_MONTH for the workspace), spent before purchased credits.
    freeCreditsMonth: v.optional(v.string()),
    freeCreditsUsedMicro: v.optional(v.number()),
    metronomeCustomerId: v.optional(v.string()),
    metronomeContractId: v.optional(v.string()),
    planTier: v.optional(
      v.union(
        v.literal("free"),
        v.literal("starter"),
        v.literal("growth"),
        v.literal("enterprise"),
      ),
    ),
    // Superseded by recipeEnablements (point "deal.page"); read only as enabledFor's fallback for a workspace with no
    // row there (lib/recipes.ts), and never written. Narrowed once the migration in docs/recipes.md has run.
    dealPageRecipe: v.optional(v.string()),
    // Maintained aggregates over the synced CRM mirror, refreshed at the end
    // of every sync. Dashboards/readiness read THESE instead of scanning the
    // row tables — counting 10k contacts in a query blows the 4096-read cap.
    // Money fields are cents. Approximate between syncs by design.
    crmCounts: v.optional(
      v.object({
        accounts: v.number(),
        contacts: v.number(),
        deals: v.number(),
        openDeals: v.number(),
        openPipeline: v.number(),
        wonRevenue: v.number(),
        unownedDeals: v.optional(v.number()),
        updatedAt: v.number(),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_clerkOrgId", ["clerkOrgId"])
    .index("by_slug", ["slug"])
    .index("by_stripeCustomerId", ["stripeCustomerId"]),

  // Each change to a workspace's settings for one recipe (docs/recipes.md, R2). Rows are never rewritten except
  // to supersede: the one `current` row per org and recipe is in force, and none means the recipe's defaults.
  recipeRevisions: defineTable({
    orgId: v.id("organizations"),
    recipeId: v.string(),
    revision: v.number(),
    // Only the keys that differ from the recipe's defaults. Each recipe declares its own settings, so the shape is
    // checked against that recipe's settingsSchema on write and again on read (lib/recipes.ts), not here.
    settings: v.any(),
    parent: v.union(v.number(), v.null()),
    // "mcp" is a user's agent over /mcp or the canon CLI (a Canon service JWT), named by its OAuth client.
    author: v.union(
      v.object({ kind: v.literal("user"), id: v.id("users") }),
      v.object({ kind: v.literal("agent"), id: v.id("agents") }),
      v.object({ kind: v.literal("mcp"), id: v.id("users"), client: v.string() }),
    ),
    note: v.optional(v.string()),
    status: v.union(v.literal("current"), v.literal("superseded"), v.literal("proposed"), v.literal("rejected")),
    // Set on a proposed revision (R4): its eval results when proposed, and the admin's decision. An approved one is
    // `superseded` and names the current revision it became.
    proposal: v.optional(v.object({
      evals: v.array(v.object({ name: v.string(), ok: v.boolean(), detail: v.union(v.string(), v.null()) })),
      decision: v.optional(v.union(
        v.object({ kind: v.literal("approved"), as: v.number(), by: v.id("users"), at: v.number() }),
        v.object({ kind: v.literal("rejected"), by: v.id("users"), at: v.number(), reason: v.optional(v.string()) }),
      )),
    })),
    createdAt: v.number(),
  })
    .index("by_orgId_and_recipeId_and_revision", ["orgId", "recipeId", "revision"])
    .index("by_orgId_and_recipeId_and_status", ["orgId", "recipeId", "status"]),

  // Each saved recipe.md of a workspace recipe (docs/recipes.md, "Customizing in the app"). Rows are never rewritten
  // except to supersede: one `current` row per org and recipe is the markdown its recipePackages row runs.
  recipeMarkdownRevisions: defineTable({
    orgId: v.id("organizations"),
    recipeId: v.string(),
    revision: v.number(),
    markdown: v.string(),
    markdownHash: v.string(),
    parent: v.union(v.number(), v.null()),
    author: v.object({ kind: v.literal("user"), id: v.id("users") }),
    note: v.optional(v.string()),
    // Against the parent's markdown, or against the recipe it copied for the first revision.
    diff: v.object({ added: v.number(), removed: v.number(), text: v.string() }),
    // On a revision that merged its upstream: that upstream recipe.md as copied, the base of the next merge.
    upstream: v.optional(v.object({ version: v.string(), markdown: v.string() })),
    // On a copy that kept its source's TypeScript: the bundle this revision runs, which a revert puts back (#499).
    // Absent on a copy on Canon's built-ins, whose bundle is rebuilt from the markdown, and on revisions from before.
    bundle: v.optional(v.object({ hash: v.string(), storageId: v.id("_storage") })),
    status: v.union(v.literal("current"), v.literal("superseded")),
    createdAt: v.number(),
  }).index("by_orgId_and_recipeId_and_revision", ["orgId", "recipeId", "revision"]),

  // A recipe a workspace installed from a package (docs/recipes.md, R5): its manifest, checked on install, and its
  // bundle in file storage, pinned to one commit. Its code runs only in the recipe runtime. One row per recipe id.
  recipePackages: defineTable({
    orgId: v.id("organizations"),
    recipeId: v.string(),
    // github-app (R5b) is a private repo read through the workspace's connection to Canon's GitHub App.
    source: v.union(
      v.object({ kind: v.literal("github-public"), owner: v.string(), repo: v.string(), path: v.optional(v.string()), ref: v.string(), sha: v.string() }),
      v.object({ kind: v.literal("github-app"), installationId: v.number(), owner: v.string(), repo: v.string(), path: v.optional(v.string()), ref: v.string(), sha: v.string() }),
      // A workspace's own copy, edited in the app (recipes/workspace.ts): the markdown in force pins it as a sha does.
      v.object({
        kind: v.literal("workspace"), markdownHash: v.string(), bundle: v.union(v.literal("builtins"), v.literal("kept")),
        forkedFrom: v.object({ id: v.string(), version: v.string(), markdownHash: v.string() }),
      }),
    ),
    version: v.string(),
    // The manifest read from the package's recipe.md (recipes/manifest.ts). Kept as text: its JSON may hold keys a Convex object can't.
    manifest: v.string(),
    bundleHash: v.string(),
    bundleStorageId: v.id("_storage"),
    installedBy: v.id("users"),
    installedAt: v.number(),
    status: v.union(v.literal("installed"), v.literal("uninstalled")),
  })
    .index("by_orgId_and_recipeId", ["orgId", "recipeId"])
    .index("by_orgId_and_status", ["orgId", "status"]),

  // Which recipe contributions a workspace has on, per contribution point (recipes/points.ts, docs/recipes.md
  // "Install and enable"). One row per org, point, recipe and contribution once anyone has turned it on; turning it
  // off keeps the row with enabled false. An exclusive point has at most one enabled row; none means its default.
  recipeEnablements: defineTable({
    orgId: v.id("organizations"),
    point: v.string(),
    recipeId: v.string(),
    // The contribution within the recipe at that point: `page` for a page, a field's slug for a field.
    contributionKey: v.string(),
    enabled: v.boolean(),
    // Absent: Canon set it, when the workspace was made.
    by: v.optional(v.id("users")),
    at: v.number(),
    // A template point's contribution once installed (docs/recipes.md, "Templates"): the version it came from, and
    // the row it made, absent for an offered cadence not made yet. Present means it is never installed again.
    installed: v.optional(v.object({ version: v.string(), at: v.number(), rowId: v.optional(v.string()) })),
  })
    .index("by_orgId_and_point_and_enabled", ["orgId", "point", "enabled"])
    .index("by_orgId_and_point_and_recipeId_and_contributionKey", ["orgId", "point", "recipeId", "contributionKey"]),

  // One row per instruction in customize mode (convex/pageCustomize.ts, edit): what was asked and pointed at, the
  // route it took (Jev's pick, the model, timings), and how it ended. A refusal records the rule that refused it, so
  // false refusals can be counted and turned into eval cases (scripts/page-customize-eval.mjs).
  pageEditAttempts: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    recipeId: v.string(),
    request: v.string(),
    pointed: v.optional(v.string()),
    target: v.optional(v.object({ component: v.string(), nth: v.optional(v.number()) })),
    outcome: v.union(v.literal("changed"), v.literal("unchanged"), v.literal("refused"), v.literal("error")),
    // Which check refused it: "jev:drawn", "guard:drawnRename", "ops", or "model" (the model said it can't).
    refusedBy: v.optional(v.string()),
    by: v.string(),
    route: v.string(),
    summary: v.string(),
    ms: v.number(),
    at: v.number(),
  })
    .index("by_orgId_and_at", ["orgId", "at"])
    .index("by_outcome_and_at", ["outcome", "at"]),

  // A workspace's connection to Canon's GitHub App on one GitHub account (docs/recipes.md, R5b), made by an admin or
  // manager whose own GitHub sign-in could reach the installation. No tokens: each read mints its own.
  githubRecipeConnections: defineTable({
    orgId: v.id("organizations"),
    installationId: v.number(),
    account: v.object({ login: v.string(), type: v.string() }),
    // The repos ("owner/name") the person who connected it could see with their own GitHub sign-in. An installation
    // can reach more repos than any one member may read, so Canon reads only these.
    repos: v.array(v.string()),
    connectedBy: v.id("users"),
    connectedAt: v.number(),
    status: v.union(v.literal("connected"), v.literal("disconnected")),
  })
    .index("by_orgId_and_installationId", ["orgId", "installationId"])
    .index("by_orgId_and_status", ["orgId", "status"]),

  // A one-time "Connect GitHub" request: the state GitHub hands back, stored as its SHA-256, tied to the person and
  // workspace that started it. Consumed by the setup return; expires after 10 minutes.
  githubRecipeSetupStates: defineTable({
    stateHash: v.string(),
    orgId: v.id("organizations"),
    userId: v.id("users"),
    expiresAt: v.number(),
  })
    .index("by_stateHash", ["stateHash"])
    .index("by_userId", ["userId"]),

  // ── Modules (docs/modules.md) ──
  // A module a workspace installed from a package: its module.json, checked on install and pinned to one commit.
  // Whether it is on is a recipeEnablements row at point "module". One row per module id; uninstalling keeps its data.
  moduleInterfaceOwners: defineTable({
    orgId: v.id("organizations"),
    moduleId: v.string(),
    packageId: v.id("modulePackages"),
    interfaces: v.array(v.string()),
    cutover: v.string(),
    fingerprint: v.string(),
    icps: v.number(),
    nodes: v.number(),
    at: v.number(),
  }).index("by_orgId_and_moduleId", ["orgId", "moduleId"]),
  modulePackages: defineTable({
    activityPublication: v.optional(v.id("moduleActivityPublications")),
    orgId: v.id("organizations"),
    moduleId: v.string(),
    // The URL segment under /dashboard/m/: the id's name, held once per workspace.
    slug: v.string(),
    source: moduleSource,
    version: v.string(),
    // module.json as fetched (modules/kernel/manifest.ts). Kept as text: its JSON may hold keys a Convex object can't.
    manifest: v.string(),
    manifestHash: v.string(),
    // A module with calls: its server bundle (the manifest's `server`) in file storage, by hash. Its code runs only
    // in the recipe runtime (docs/modules.md, "Server code").
    bundleHash: v.optional(v.string()),
    bundleStorageId: v.optional(v.id("_storage")),
    installedBy: v.optional(v.id("users")),
    installedAt: v.number(),
    status: v.union(v.literal("installed"), v.literal("uninstalled")),
    // Bumped by each version installed over the last (docs/modules.md, "Upgrades"); absent means 1. Proposals made
    // under one epoch don't apply under another. `slots`: where this version's indexes live; absent means the
    // collections' indexes in declaration order.
    epoch: v.optional(v.number()),
    // Derived report projection receipt; absent on installations predating the fenced sync protocol.
    projection: v.optional(v.object({ epoch: v.number(), generation: v.number(), collections: v.array(v.string()), completed: v.array(v.string()) })),
    slots: v.optional(moduleSlots),
    // Latest automatic default upgrade; visible once this version serves.
    autoUpgrade: v.optional(v.object({ version: v.string(), newReads: v.array(v.string()), at: v.number() })),
    imports: v.optional(v.record(v.string(), v.object({
      cursor: v.union(v.string(), v.null()), done: v.boolean(), error: v.optional(v.string()),
    }))),
    // A newer version installing: it serves once its backfill has rewritten (or deleted) every doc `work` names.
    // Until then the version above serves, and every write also fills the new version's slots.
    pending: v.optional(v.object({
      version: v.string(),
      source: moduleSource,
      // Its manifest is in moduleManifests (by this row and manifestHash), so each manifest has a Convex document of
      // its own; inline only on rows an earlier Canon stored.
      manifest: v.optional(v.string()),
      manifestHash: v.string(),
      bundleHash: v.optional(v.string()),
      bundleStorageId: v.optional(v.id("_storage")),
      epoch: v.number(),
      slots: moduleSlots,
      work: v.array(v.union(
        v.object({ collection: v.string(), mode: v.literal("rewrite"), owner: v.optional(v.boolean()) }),
        v.object({ collection: v.string(), mode: v.literal("drop") }),
        // The module's migration function `call` rewrites each doc (docs/modules.md, "Upgrades and migrations").
        v.object({ collection: v.string(), mode: v.literal("migrate"), call: v.string() }),
      )),
      // The backfill's place: the work item, the last key done in it, and how many docs it has done in all.
      step: v.number(),
      cursor: v.optional(v.string()),
      done: v.number(),
      error: v.optional(v.string()),
      // An upgrade with migrations: the module's writes wait while its docs migrate into `next` (moduleDocs); then
      // "cutover" swaps them in, the module closed for those seconds. `staged`: the collections holding `next` docs.
      phase: v.optional(v.union(v.literal("migrate"), v.literal("cutover"))),
      staged: v.optional(v.array(v.string())),
      by: v.optional(v.id("users")),
      at: v.number(),
    })),
  })
    .index("by_orgId_and_moduleId", ["orgId", "moduleId"])
    .index("by_orgId_and_slug", ["orgId", "slug"])
    .index("by_orgId_and_status", ["orgId", "status"])
    // The one-minute sweep's walk over every workspace's installed modules (convex/moduleJobs.ts).
    .index("by_status", ["status"]),

  moduleActivityHeads: defineTable({
    orgId: v.id("organizations"), version: v.literal(1), committedOrdinal: v.number(), publishedOrdinal: v.number(),
    appendedSeq: v.number(), readableSeq: v.number(), pending: v.boolean(),
  }).index("by_orgId", ["orgId"]).index("by_pending_orgId", ["pending", "orgId"]),
  moduleActivityPublications: defineTable({
    orgId: v.id("organizations"), packageId: v.id("modulePackages"), moduleId: v.string(), ordinal: v.number(),
    beforeDescriptor: v.id("moduleActivityDescriptors"), afterDescriptor: v.id("moduleActivityDescriptors"),
    state: v.union(v.literal("lifecycle"), v.literal("ready"), v.literal("publishing"), v.literal("failed"), v.literal("complete")),
    lifecycleEpoch: v.union(v.number(), v.null()), retainsPackage: v.boolean(), revision: v.number(), attempt: v.number(),
    retryAt: v.union(v.number(), v.null()), error: v.union(v.string(), v.null()),
    work: v.object({
      phase: v.union(v.literal("roots"), v.literal("old"), v.literal("new"), v.literal("diff"), v.literal("append"), v.literal("finish"), v.literal("gc")),
      collection: v.union(v.string(), v.null()), physicalCursor: v.union(v.string(), v.null()), evidenceCursor: v.union(v.string(), v.null()),
      side: v.union(v.literal("before"), v.literal("after"), v.null()), frame: v.number(), part: v.number(),
    }),
    startSeq: v.union(v.number(), v.null()), endSeq: v.union(v.number(), v.null()),
  }).index("by_orgId_ordinal", ["orgId", "ordinal"]).index("by_packageId_state", ["packageId", "state"]).index("by_state_retryAt", ["state", "retryAt"]),
  moduleActivityDescriptors: defineTable({
    orgId: v.id("organizations"), packageId: v.id("modulePackages"), digest: v.string(), codec: v.literal(1),
    epoch: v.number(), manifestHash: v.string(), bundleHash: v.union(v.string(), v.null()), bytes: v.number(), parts: v.number(),
  }).index("by_packageId_digest", ["packageId", "digest"]),
  moduleActivityChunks: defineTable({
    orgId: v.id("organizations"), ownerKind: v.union(v.literal("descriptor"), v.literal("evidence"), v.literal("journal")),
    ownerId: v.union(v.id("moduleActivityDescriptors"), v.id("moduleActivityEvidence"), v.id("moduleActivityJournal")),
    side: v.union(v.literal("descriptor"), v.literal("header"), v.literal("before"), v.literal("after")), part: v.number(), offset: v.number(), bytes: v.bytes(),
  }).index("by_ownerKind_ownerId_side_part", ["ownerKind", "ownerId", "side", "part"]),
  moduleActivityEvidence: defineTable({
    orgId: v.id("organizations"), publicationId: v.id("moduleActivityPublications"), kind: v.union(v.literal("row"), v.literal("root")),
    collection: v.string(), key: v.string(), incarnation: v.id("moduleDocs"), initial: v.union(v.literal("absent"), v.literal("present")),
    descriptorId: v.id("moduleActivityDescriptors"), digest: v.string(), bytes: v.number(), parts: v.number(),
  }).index("by_publicationId_kind_incarnation", ["publicationId", "kind", "incarnation"])
    .index("by_publicationId_kind_collection_key_incarnation", ["publicationId", "kind", "collection", "key", "incarnation"]),
  moduleActivityJournal: defineTable({
    orgId: v.id("organizations"), seq: v.number(), publicationId: v.id("moduleActivityPublications"), ordinal: v.number(),
    kind: v.union(v.literal("change"), v.literal("complete")), frame: v.number(), at: v.number(),
    beforeDescriptor: v.id("moduleActivityDescriptors"), afterDescriptor: v.id("moduleActivityDescriptors"),
    beforeDigest: v.union(v.string(), v.null()), afterDigest: v.union(v.string(), v.null()), beforeBytes: v.number(), afterBytes: v.number(),
    beforeParts: v.number(), afterParts: v.number(),
  }).index("by_orgId_seq", ["orgId", "seq"]).index("by_publicationId_frame", ["publicationId", "frame"]),
  moduleActivityCursors: defineTable({
    orgId: v.id("organizations"), moduleId: v.string(), packageId: v.id("modulePackages"), epoch: v.number(), watch: v.string(),
    declarationHash: v.string(), seq: v.number(), ordinal: v.number(), at: v.number(), error: v.union(v.string(), v.null()), nextLane: v.number(),
  }).index("by_orgId_moduleId_watch", ["orgId", "moduleId", "watch"]),

  // The manifest of a newer version an upgrade is installing (modulePackages.pending), in a document of its own: a
  // serving manifest and the next one would not both fit in one 1 MiB document at the stored cap
  // (modules/kernel/manifest.ts MODULE_STORED_MAX_BYTES). Gone once that version serves, or the upgrade is cancelled.
  moduleManifests: defineTable({
    orgId: v.id("organizations"),
    packageId: v.id("modulePackages"),
    manifestHash: v.string(),
    manifest: v.string(),
  }).index("by_packageId", ["packageId"]),

  // Every module's documents, in one table. scope.ts owns caller reads and semantic writes. Activity publication
  // reads pinned physical state (tests/moduleSurfaces.test.ts). A collection's declared indexes map, in order, to the slots s0..s7: each slot is
  // up to four columns holding the index's field values (a set collection's start with parentKey and gen).
  moduleDocs: defineTable({
    sourceCreatedAt: v.optional(v.number()),
    orgId: v.id("organizations"),
    moduleId: v.string(),
    collection: v.string(),
    key: v.string(),
    data: v.any(),
    version: v.number(),
    ownerUserId: v.optional(v.id("users")),
    // A set collection's doc: its parent's key, and the generation it belongs to. A parent's gen is its live one.
    parentKey: v.optional(v.string()),
    gen: v.optional(v.number()),
    // A parent's live generation per set collection, once a call's replaceSet published one (docs/modules.md, "Sets").
    gens: v.optional(v.record(v.string(), v.number())),
    // A pending upgrade's migration of this doc (docs/modules.md, "Upgrades and migrations"): its data in the new
    // version's shape, or `drop`. The installed version reads `data` until the upgrade's cutover swaps it in.
    next: v.optional(v.object({ epoch: v.number(), data: v.optional(v.any()), drop: v.optional(v.boolean()) })),
    s0a: moduleSlot, s0b: moduleSlot, s0c: moduleSlot, s0d: moduleSlot,
    s1a: moduleSlot, s1b: moduleSlot, s1c: moduleSlot, s1d: moduleSlot,
    s2a: moduleSlot, s2b: moduleSlot, s2c: moduleSlot, s2d: moduleSlot,
    s3a: moduleSlot, s3b: moduleSlot, s3c: moduleSlot, s3d: moduleSlot,
    s4a: moduleSlot, s4b: moduleSlot, s4c: moduleSlot, s4d: moduleSlot,
    s5a: moduleSlot, s5b: moduleSlot, s5c: moduleSlot, s5d: moduleSlot,
    s6a: moduleSlot, s6b: moduleSlot, s6c: moduleSlot, s6d: moduleSlot,
    s7a: moduleSlot, s7b: moduleSlot, s7c: moduleSlot, s7d: moduleSlot,
    updatedAt: v.number(),
  })
    .index("by_orgId_moduleId_collection_key", ["orgId", "moduleId", "collection", "key"])
    .index("by_orgId_moduleId_collection_parentKey_gen_key", ["orgId", "moduleId", "collection", "parentKey", "gen", "key"])
    .index("by_orgId_moduleId_collection_s0a_s0b_s0c_s0d", ["orgId", "moduleId", "collection", "s0a", "s0b", "s0c", "s0d"])
    .index("by_orgId_moduleId_collection_s1a_s1b_s1c_s1d", ["orgId", "moduleId", "collection", "s1a", "s1b", "s1c", "s1d"])
    .index("by_orgId_moduleId_collection_s2a_s2b_s2c_s2d", ["orgId", "moduleId", "collection", "s2a", "s2b", "s2c", "s2d"])
    .index("by_orgId_moduleId_collection_s3a_s3b_s3c_s3d", ["orgId", "moduleId", "collection", "s3a", "s3b", "s3c", "s3d"])
    .index("by_orgId_moduleId_collection_s4a_s4b_s4c_s4d", ["orgId", "moduleId", "collection", "s4a", "s4b", "s4c", "s4d"])
    .index("by_orgId_moduleId_collection_s5a_s5b_s5c_s5d", ["orgId", "moduleId", "collection", "s5a", "s5b", "s5c", "s5d"])
    .index("by_orgId_moduleId_collection_s6a_s6b_s6c_s6d", ["orgId", "moduleId", "collection", "s6a", "s6b", "s6c", "s6d"])
    .index("by_orgId_moduleId_collection_s7a_s7b_s7c_s7d", ["orgId", "moduleId", "collection", "s7a", "s7b", "s7c", "s7d"]),

  // The append-only audit of module writes: one row per op on a doc, by whom. Written only by moduleScope.
  moduleEvents: defineTable({
    orgId: v.id("organizations"),
    moduleId: v.string(),
    collection: v.string(),
    key: v.string(),
    // The op's name in the manifest, or the transition's as "<machine>.<transition>", and what it did. A "propose"
    // row is an agent's proposal, a patch plan a person decides; the transition or op it proposes adds its own row.
    verb: v.string(),
    // An "event" row is a line a call wrote on the doc's history (its note is `reason`); it changes nothing.
    kind: v.union(v.literal("create"), v.literal("update"), v.literal("delete"), v.literal("transition"), v.literal("propose"), v.literal("event")),
    // An agent is a person's agent over /mcp or the canon CLI, named by its OAuth client. "system" is Canon itself,
    // running a transition, op or call the manifest marks `system` (a job).
    actor: v.union(
      v.object({ kind: v.union(v.literal("user"), v.literal("agent")), userId: v.id("users"), client: v.optional(v.string()) }),
      v.object({ kind: v.literal("system") }),
      v.object({ kind: v.literal("visitor"), grant: v.string(), visitor: v.string(), verified: v.boolean(), email: v.optional(v.string()) }),
    ),
    fields: v.array(v.string()),
    fromVersion: v.optional(v.number()),
    toVersion: v.optional(v.number()),
    // A transition's states, the arguments and reason it ran with, the approved proposal it applies, and the
    // transition whose effect it was ("<machine>.<transition> <collection>/<key>").
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    args: v.optional(v.any()),
    reason: v.optional(v.string()),
    proposal: v.optional(v.id("patchPlans")),
    cause: v.optional(v.string()),
    // Where a person ran a transition that declares `evidence` (docs/modules.md, "Evidence"): their IP address and
    // browser, as Canon's web server saw the request and signed them. Never from module code.
    evidence: v.optional(v.object({ ip: v.optional(v.string()), userAgent: v.optional(v.string()) })),
    at: v.number(),
  }).index("by_orgId_moduleId_collection_key_at", ["orgId", "moduleId", "collection", "key", "at"]),

  moduleShareGrants: defineTable({
    orgId: v.id("organizations"), moduleId: v.string(), share: v.string(), policyHash: v.string(),
    collection: v.string(), key: v.string(), rootCreatedAt: v.number(), tokenHash: v.string(), publicId: v.string(),
    issuedTo: v.object({ name: v.optional(v.string()), email: v.optional(v.string()), contactId: v.optional(v.string()) }),
    identity: v.union(v.literal("link"), v.literal("email")), domains: v.optional(v.array(v.string())), emails: v.optional(v.array(v.string())),
    expiresAt: v.number(), revokedAt: v.optional(v.number()), issuedBy: v.id("users"), issuedAt: v.number(),
    opens: v.number(), lastOpenedAt: v.optional(v.number()), sessions: v.number(),
    expiryNoticeAt: v.optional(v.number()),
    attribution: v.optional(v.object({
      accountId: v.string(), domain: v.string(), source: v.object({ deal: v.union(v.string(), v.null()), company: v.union(v.string(), v.null()) }),
      deal: v.optional(v.object({ id: v.string(), streamId: v.string(), companyId: v.string() })),
      contact: v.optional(v.object({ id: v.string(), email: v.string() })),
    })),
  }).index("by_tokenHash", ["tokenHash"])
    .index("by_publicId", ["publicId"])
    .index("by_expiryNoticeAt", ["expiryNoticeAt"])
    .index("by_orgId_moduleId_collection_key", ["orgId", "moduleId", "collection", "key"]),

  moduleVisitors: defineTable({
    orgId: v.id("organizations"), grantId: v.id("moduleShareGrants"), sessionHash: v.string(),
    name: v.optional(v.string()), email: v.optional(v.string()), verified: v.boolean(), declared: v.boolean(),
    firstAt: v.number(), lastAt: v.number(),
  }).index("by_sessionHash", ["sessionHash"]).index("by_grantId", ["grantId"]),

  moduleVisitCodes: defineTable({
    orgId: v.id("organizations"), grantId: v.id("moduleShareGrants"), visitorId: v.id("moduleVisitors"),
    email: v.string(), salt: v.string(), codeHash: v.string(), expiresAt: v.number(), tries: v.number(),
    state: v.union(v.literal("issued"), v.literal("used")),
  }).index("by_visitorId", ["visitorId"]).index("by_expiresAt", ["expiresAt"]),

  moduleRateLimits: defineTable({
    key: v.string(), windowStart: v.number(), count: v.number(), expiresAt: v.number(),
    notice: v.optional(v.object({ cause: v.string(), ids: v.array(v.id("notifications")) })),
  }).index("by_key", ["key"]).index("by_expiresAt", ["expiresAt"]),

  // Files people upload to a module's file fields (docs/modules.md, "Files"), in Convex file storage. Read and
  // written only by convex/lib/modules/scope.ts. A doc's file field holds the row's id; only a reader of a doc that
  // holds it downloads it. `attachedTo` is the first doc it went into: until then only its uploader writes it.
  moduleFiles: defineTable({
    orgId: v.id("organizations"),
    moduleId: v.string(),
    // Unset while the row is an upload ticket (uploadUrl): the upload route stores the person's file and fills it.
    storageId: v.optional(v.id("_storage")),
    // A ticket's secret, which the upload route must be given; cleared once the file is recorded.
    secret: v.optional(v.string()),
    name: v.string(),
    type: v.string(),
    bytes: v.number(),
    uploadedBy: v.optional(v.id("users")),
    visitorUpload: v.optional(v.object({
      grantId: v.id("moduleShareGrants"), visitorId: v.id("moduleVisitors"), sessionHash: v.string(),
      policyHash: v.string(), rootCreatedAt: v.number(), generation: v.number(), target: v.string(), collection: v.string(),
      state: v.union(v.literal("reserved"), v.literal("stored"), v.literal("attached"), v.literal("released")),
      expiresAt: v.number(), digest: v.string(), label: v.string(), verified: v.boolean(),
      budgets: v.array(v.object({ key: v.string(), amount: v.number(), windowStart: v.number() })),
    })),
    attachedTo: v.optional(v.object({ collection: v.string(), key: v.string() })),
    at: v.number(),
  }).index("by_attached_and_at", ["attachedTo", "at"])
    .index("by_visitorUpload_state_expiresAt", ["visitorUpload.state", "visitorUpload.expiresAt"]),

  // A module's job keys that wait to run (docs/modules.md, "Jobs, watches and schedules"): one row per stale key,
  // deleted when a run applies. Read and written only by convex/lib/modules/jobs.ts and scope.ts. `dirtySeq` counts
  // the times it was dirtied: a run leased at one count applies only if it is still that count, else its result is
  // stale and the key runs again. `group` is the key without its `order` part (one group runs one key at a time,
  // lowest `order` first); `batch` the parts one call's keys share. A bulk move is job "#bulk" with its args in
  // `payload`. `attempts` and `lastError` count a key's failed runs; past its job's `attempts` it waits for a person.
  moduleJobs: defineTable({
    orgId: v.id("organizations"),
    moduleId: v.string(),
    job: v.string(),
    key: v.string(),
    group: v.string(),
    order: v.string(),
    batch: v.string(),
    dirtySeq: v.number(),
    leaseUntil: v.optional(v.number()),
    leaseSeq: v.optional(v.number()),
    leaseGeneration: v.optional(v.number()),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    payload: v.optional(v.any()),
    at: v.number(),
  })
    .index("by_orgId_moduleId_job_key", ["orgId", "moduleId", "job", "key"])
    .index("by_orgId_moduleId_job_group_order", ["orgId", "moduleId", "job", "group", "order"]),

  // An audience's people as a module froze them (convex/moduleSnapshots.ts, docs/modules.md "Audiences"): one row per
  // page of at most 500 ids, all pages of one snapshot sharing `snapshot`. Deleted 30 days after it was taken.
  moduleSnapshots: defineTable({
    orgId: v.id("organizations"),
    moduleId: v.string(),
    snapshot: v.string(),
    page: v.number(),
    audienceId: v.optional(v.string()),
    source: v.optional(v.string()),
    count: v.number(),
    ids: v.array(v.string()),
    createdAt: v.number(),
  }).index("by_orgId_moduleId_snapshot_page", ["orgId", "moduleId", "snapshot", "page"]),

  // Where a module's deal feed has read the records ledger to, per watch and ledger shard (the `seq` it read
  // through), as automationCursors does for rules; and, under `#`-names, a schedule's last run and the job runner's
  // last pass (`at`). Connector feeds use `#feed:<name>` and page backfills under `#feedfill:<name>`
  // with `cursor`; `#feedrate` counts deliveries in a minute. `error` is the last failed batch.
  moduleCursors: defineTable({
    orgId: v.id("organizations"),
    moduleId: v.string(),
    watch: v.string(),
    shard: v.number(),
    seq: v.number(),
    at: v.optional(v.number()),
    error: v.optional(v.string()),
    cursor: v.optional(v.string()),
    generation: v.optional(v.number()),
    linkId: v.optional(v.id("connectorLinks")),
    throughSeq: v.optional(v.number()),
  }).index("by_orgId_moduleId_watch_shard", ["orgId", "moduleId", "watch", "shard"]),

  // A module's hosted AI steps, one row per run (docs/modules.md, "Hosted AI steps"): its receipt. Who ran it, on
  // which model and whose bill, what it read (by id), how much it sent, the quotes it kept and those it dropped and why,
  // or why it failed. Read by convex/moduleAi.ts: a person's runs of a call today, against its `budget.perDay`.
  moduleAiRuns: defineTable({
    orgId: v.id("organizations"),
    moduleId: v.string(),
    call: v.string(),
    // The doc its answer fills.
    key: v.string(),
    userId: v.id("users"),
    // "running" from when it is reserved against the budget until it is done or failed.
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    // "chatgpt" (the person's plan), "canon" (Canon's model, on the workspace's credits) or "fake" (tests, local stacks).
    provider: v.string(),
    model: v.string(),
    promptVersion: v.string(),
    inputChars: v.number(),
    reads: v.array(v.object({ name: v.string(), ids: v.array(v.string()) })),
    kept: v.number(),
    dropped: v.array(v.object({ path: v.string(), quote: v.string(), why: v.string() })),
    creditsMicro: v.optional(v.number()),
    error: v.optional(v.string()),
    ms: v.number(),
    at: v.number(),
  })
    .index("by_orgId_userId_at", ["orgId", "userId", "at"])
    .index("by_orgId_moduleId_key_at", ["orgId", "moduleId", "key", "at"]),

  // A module's standing grant (convex/moduleGrants.ts, docs/modules.md "Standing grants"): an admin's approval, made in
  // advance, for one module to make one grantable proposal (modules/kernel/proposals.ts) without asking, until it
  // expires. `signature` is HMAC-SHA256 over the exact terms; one that doesn't verify, has expired or was revoked
  // approves nothing, and neither does one whose module is off or whose admin no longer is one. Revoked ones are kept.
  moduleGrants: defineTable({
    orgId: v.id("organizations"),
    moduleId: v.string(),
    operation: v.string(),
    maxPerDay: v.optional(v.number()),
    expiresAt: v.number(),
    signature: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    revokedBy: v.optional(v.id("users")),
  }).index("by_orgId_and_moduleId", ["orgId", "moduleId"]),

  // One proposal approved under a module's grant: the plan's hash and the digest binding it to the grant's signature,
  // which the apply checks again. `rows` feeds the daily cap.
  moduleGrantUses: defineTable({
    orgId: v.id("organizations"),
    grantId: v.id("moduleGrants"),
    patchPlanId: v.id("patchPlans"),
    planHash: v.string(),
    digest: v.string(),
    rows: v.number(),
    at: v.number(),
  })
    .index("by_grantId_and_at", ["grantId", "at"])
    .index("by_patchPlanId", ["patchPlanId"]),

  // In-app notifications to one member in one workspace (convex/notifications.ts): today a module's `notify`
  // (docs/modules.md, "Notifications"), with what caused it. `link` is a dashboard path; `readAt` once they saw it.
  notifications: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    source: v.object({ kind: v.literal("module"), moduleId: v.string(), collection: v.optional(v.string()), key: v.optional(v.string()) }),
    message: v.string(),
    // The line the bell shows above the message, and what kind of notice it is ("Dispute"): a module's `subject`, `badge`.
    subject: v.optional(v.string()),
    badge: v.optional(v.string()),
    link: v.optional(v.string()),
    at: v.number(),
    readAt: v.optional(v.number()),
  })
    .index("by_orgId_userId_at", ["orgId", "userId", "at"])
    .index("by_orgId_userId_readAt", ["orgId", "userId", "readAt"]),

  // How a member wants a module's emailed notices (docs/modules.md, "Outbound"): each one as it happens, one email a
  // day, or none. No row: each one as it happens.
  notificationEmail: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    moduleId: v.string(),
    mode: v.union(v.literal("instant"), v.literal("digest"), v.literal("off")),
    at: v.number(),
  }).index("by_orgId_and_userId_and_moduleId", ["orgId", "userId", "moduleId"]),

  // Every change to a workspace's prepaid credits, in USD millionths (signed).
  // `ref` makes each change happen once: a Checkout Session for a purchase,
  // a provider call for a spend.
  creditLedger: defineTable({
    orgId: v.id("organizations"),
    kind: v.union(v.literal("purchase"), v.literal("spend"), v.literal("refund"), v.literal("adjust")),
    amountMicro: v.number(),
    balanceAfterMicro: v.number(),
    ref: v.string(),
    note: v.optional(v.string()),
    at: v.number(),
    // A paid run's spend: held before each call (pending), settled to the metered charge after it,
    // then reported to Metronome (meteredAt).
    jobId: v.optional(v.id("backgroundJobs")),
    // An AI-field research run's spend (CR4), held per page of records like a paid run's calls.
    researchRunId: v.optional(v.id("researchRuns")),
    pending: v.optional(v.boolean()),
    meteredAt: v.optional(v.number()),
    // The part of a spend the month's free allowance paid (micro-credits); the rest came off the balance.
    freeMicro: v.optional(v.number()),
    // "credits" on rows in micro-credits; older rows are dollars in millionths (lib/creditPacks.ts).
    unit: v.optional(v.literal("credits")),
  })
    .index("by_ref", ["ref"])
    .index("by_orgId_and_at", ["orgId", "at"])
    .index("by_jobId_and_pending", ["jobId", "pending"])
    .index("by_jobId_and_meteredAt", ["jobId", "meteredAt"])
    .index("by_researchRunId_and_pending", ["researchRunId", "pending"])
    .index("by_researchRunId_and_meteredAt", ["researchRunId", "meteredAt"]),

  users: defineTable({
    clerkUserId: v.string(),
    orgId: v.id("organizations"),
    email: v.string(),
    name: v.string(),
    imageUrl: v.optional(v.string()),
    // admin, manager, rep, other, or a workspace's own role (orgRoles.key).
    role: v.string(),
    managerId: v.optional(v.id("users")),
    reportingChainIds: v.optional(v.array(v.id("users"))),
    hierarchyLevel: v.optional(v.number()),
    directReportCount: v.optional(v.number()),
    title: v.optional(v.string()),
    department: v.optional(v.string()),
    // The CRM owner id this user maps to (set by owner sync — including when
    // the owner matched an existing Clerk user by email). Owner-assignment
    // suggestions key on this.
    crmOwnerId: v.optional(v.string()),
    isActive: v.boolean(),
    isHidden: v.optional(v.boolean()),
    lastLoginAt: v.optional(v.number()),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    invitedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_clerkUserId", ["clerkUserId"])
    .index("by_orgId", ["orgId"])
    .index("by_orgId_email", ["orgId", "email"])
    .index("by_orgId_role", ["orgId", "role"])
    .index("by_managerId", ["managerId"]),

  localCredentials: defineTable({
    email: v.string(),
    userId: v.id("users"),
    passwordHash: v.string(),
  }).index("by_email", ["email"]),

  localSessions: defineTable({
    tokenHash: v.string(),
    userId: v.id("users"),
    expiresAt: v.number(),
  }).index("by_tokenHash", ["tokenHash"]),

  localInvites: defineTable({
    tokenHash: v.string(),
    userId: v.id("users"),
    expiresAt: v.number(),
  }).index("by_tokenHash", ["tokenHash"]).index("by_userId", ["userId"]),

  // Local stacks only: which seeded member the dev auth bypass (FSGTM_ENABLE_DEMO_DATA) signs an
  // unauthenticated caller in as. At most one row; read only while the bypass is on (convex/lib.ts, convex/devAuth.ts).
  devActAs: defineTable({
    clerkUserId: v.string(),
    updatedAt: v.number(),
  }),

  // One row per Clerk org membership, mirrored from organizationMembership.*
  // webhooks. `users.orgId` stays the user's HOME org — the fallback when the
  // session carries no active-org claim; switching into any OTHER org requires
  // an active row here (convex/lib.ts:scopeUserToActiveOrg). Role is
  // per-membership: the same user can be admin of one org and rep of another.
  orgMemberships: defineTable({
    userId: v.id("users"),
    orgId: v.id("organizations"),
    // admin, manager, rep, other, or a workspace's own role (orgRoles.key).
    role: v.string(),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_orgId", ["orgId"])
    .index("by_userId_orgId", ["userId", "orgId"]),

  // Teams (CP14): Settings, Teams creates them; `managerId` is the team lead.
  // A member can be on several teams. `team` visibility reads them.
  teamGroups: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    managerId: v.optional(v.id("users")),
    memberIds: v.array(v.id("users")),
    createdAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // Who sees and changes what (CP14, convex/lib/access.ts): one row per
  // configurable role and workspace. No row, or no rule for an object, keeps
  // full access; admins are never restricted.
  // A workspace's own role (lib/roles.ts): its name, the built-in role it counts as wherever Canon asks what kind of
  // member someone is, and the capabilities it holds (lib/capabilities.ts). Its record rules are a rolePermissions row.
  orgRoles: defineTable({
    orgId: v.id("organizations"),
    key: v.string(),
    name: v.string(),
    base: v.union(v.literal("manager"), v.literal("rep"), v.literal("other")),
    capabilities: v.array(v.string()),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }).index("by_orgId_and_key", ["orgId", "key"]),

  rolePermissions: defineTable({
    orgId: v.id("organizations"),
    role: v.string(),
    rules: v.array(v.object({
      object: v.string(),
      visibility: v.optional(v.union(v.literal("all"), v.literal("team"), v.literal("own"))),
      unowned: v.optional(v.boolean()),
      read: v.optional(v.boolean()),
      create: v.optional(v.boolean()),
      edit: v.optional(v.boolean()),
      delete: v.optional(v.boolean()),
      fields: v.optional(v.array(v.object({ apiName: v.string(), level: v.union(v.literal("hidden"), v.literal("readOnly")) }))),
    })),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }).index("by_orgId_and_role", ["orgId", "role"]),

  // An admin's "view as" preview (CP14): while it lasts, the admin's reads
  // resolve as `asUserId` would see them and every write is refused.
  accessPreviews: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    asUserId: v.id("users"),
    expiresAt: v.number(),
  }).index("by_userId_and_orgId", ["userId", "orgId"]),


  // ── CRM Integrations ─────────────────────────────────────────

  // Live progress of a free fill coverage check (convex/enrichFreeFill.ts), keyed by a client-made runKey.
  freeFillRuns: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    runKey: v.string(),
    stage: v.union(v.literal("counting"), v.literal("reading"), v.literal("matching"), v.literal("done"), v.literal("error")),
    read: v.number(),
    total: v.optional(v.number()),
    // The report so far (lib/enrich/freeFill.ts CoverageReport), merged chunk by chunk, and what the index lookups did.
    report: v.optional(v.any()),
    lookup: v.optional(v.any()),
    chunks: v.optional(v.number()),
    matchedChunks: v.optional(v.number()),
    readDone: v.optional(v.boolean()),
    capped: v.optional(v.boolean()),
    error: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_runKey", ["runKey"]),
  // The enrichment source a free fill coverage check matched to a HubSpot company, with that source's raw values
  // (convex/enrichmentMatches.ts). One per company, replaced by a newer match; field consolidation reads them as sources.
  enrichmentMatches: defineTable({
    orgId: v.id("organizations"),
    recordId: v.string(),
    source: v.union(v.literal("pdl"), v.literal("crustdata")),
    via: v.union(v.literal("domain"), v.literal("name"), v.literal("root"), v.literal("crustdata"), v.literal("lookup")),
    domain: v.string(),
    values: v.object({
      industry: v.optional(v.string()),
      numberofemployees: v.optional(v.number()),
      annualrevenue: v.optional(v.number()),
      city: v.optional(v.string()),
      state: v.optional(v.string()),
      country: v.optional(v.string()),
      linkedin_company_page: v.optional(v.string()),
      founded_year: v.optional(v.number()),
    }),
    matchedAt: v.number(),
  })
    .index("by_orgId_and_recordId", ["orgId", "recordId"])
    .index("by_orgId_and_matchedAt", ["orgId", "matchedAt"]),
  // A field consolidation (convex/fieldConsolidations.ts, docs/field-consolidation.md): one concept's columns across
  // the connected CRMs, the column chosen as standard, the value map (or scales) into it and the fill policy.
  fieldConsolidations: defineTable({
    orgId: v.id("organizations"),
    createdBy: v.id("users"),
    concept: v.string(),
    keywords: v.array(v.string()),
    // The integration page it was started from. Unset on older ones: the target column's system, or both pages.
    system: v.optional(v.union(v.literal("hubspot"), v.literal("salesforce"))),
    stage: v.union(v.literal("discovering"), v.literal("profiling"), v.literal("ready"), v.literal("error")),
    error: v.optional(v.string()),
    // lib/consolidate.ts Column[]: every column whose name or label matches the keywords (capped at discovery).
    columns: v.optional(v.any()),
    // lib/consolidate.ts DISCOVERY_VERSION when the columns were read; unset is 1.
    discoveryVersion: v.optional(v.number()),
    // Systems that were connected when columns were read, and any that could not be read.
    systems: v.optional(v.array(v.object({ system: v.string(), status: v.string(), detail: v.optional(v.string()) }))),
    // Set before destinations (docs/canon-fields-above-the-crm.md): the standard column and its counterpart. A field
    // without `destinations` reads them as its first two; `define` replaces them.
    target: v.optional(v.string()),
    mirror: v.optional(v.string()),
    // The field itself, above every CRM: a category with its own options or a quantity, on companies or people.
    kind: v.optional(v.union(v.literal("category"), v.literal("quantity"))),
    level: v.optional(v.union(v.literal("account"), v.literal("person"))),
    options: v.optional(v.array(v.object({ label: v.string(), value: v.string() }))),
    // The column its options were copied from, shown as their origin.
    optionsFrom: v.optional(v.string()),
    // The Canon attribute its values are saved in, set by the first preview that saves them: a standard one it takes
    // over (`industry`, `annualRevenue`) or its own `custom.<name>`.
    attribute: v.optional(v.string()),
    // The CRM columns it writes, in any connected CRM. `review`: a run writes them once approved; `shadow`: a run
    // shows the difference and writes nothing; `auto` waits for continuous updates.
    destinations: v.optional(v.array(v.object({
      column: v.string(),
      mode: v.union(v.literal("off"), v.literal("shadow"), v.literal("review"), v.literal("auto")),
    }))),
    sources: v.optional(v.array(v.string())),
    // Capped at lib/consolidate.ts MAX_MAP_ENTRIES.
    valueMap: v.optional(
      v.array(
        v.object({
          from: v.string(),
          to: v.union(v.string(), v.null()),
          origin: v.union(v.literal("auto"), v.literal("ai"), v.literal("user")),
          confidence: v.number(),
        }),
      ),
    ),
    // A quantity standard (a number column): each source column's scale into its units, when not ×1.
    scales: v.optional(v.array(v.object({ column: v.string(), factor: v.number(), origin: v.union(v.literal("auto"), v.literal("user")) }))),
    policy: v.optional(
      v.object({
        mode: v.union(v.literal("blanks"), v.literal("overwrite")),
        protectedValues: v.array(v.string()),
        minConfidence: v.number(),
        // A quantity standard only: how sources combine, and how close a current value must be to agree.
        combine: v.optional(v.union(v.literal("first"), v.literal("mean"), v.literal("median"), v.literal("min"), v.literal("max"))),
        tolerance: v.optional(v.number()),
      }),
    ),
    // The patch plans this consolidation created, newest first (capped).
    plans: v.optional(
      v.array(v.object({ patchPlanId: v.id("patchPlans"), provider: v.string(), operations: v.number(), kind: v.string(), createdAt: v.number() })),
    ),
    // The latest suggest, preview or plans run, shown on the page and in the background tray while it reads.
    job: v.optional(v.object({
      id: v.id("backgroundJobs"),
      task: v.union(v.literal("suggest"), v.literal("preview"), v.literal("plans"), v.literal("apply"), v.literal("undo")),
    })),
    // Bumped by every change to the target, sources, map or policy: a saved preview from an older version is stale.
    settingsVersion: v.optional(v.number()),
    // The latest preview run (fieldConsolidationRuns), saved so the page shows it again and applies it without a re-read.
    run: v.optional(v.id("fieldConsolidationRuns")),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),
  // One preview of a consolidation, then its apply and undo as one unit: a summary per CRM column (counts, biggest
  // changes, samples), the CSV in file storage, and its writes in fieldConsolidationWrites.
  fieldConsolidationRuns: defineTable({
    orgId: v.id("organizations"),
    consolidationId: v.id("fieldConsolidations"),
    createdBy: v.id("users"),
    settingsVersion: v.number(),
    status: v.union(
      v.literal("previewing"), v.literal("ready"), v.literal("applying"), v.literal("applied"),
      v.literal("undoing"), v.literal("undone"), v.literal("failed"),
    ),
    // What failed and in which phase; a failed apply or undo can resume.
    error: v.optional(v.string()),
    failedDuring: v.optional(v.union(v.literal("preview"), v.literal("apply"), v.literal("undo"))),
    // Per CRM column (fieldConsolidationActions Section without its rows).
    sections: v.optional(v.any()),
    writes: v.number(),
    csv: v.optional(v.id("_storage")),
    csvRows: v.optional(v.number()),
    // The preview's values saved into Canon (docs/canon-fields-above-the-crm.md): new or changed, the same as before, and
    // Canon records with no company or person in Canon yet.
    stored: v.optional(v.object({ written: v.number(), unchanged: v.number(), missing: v.number() })),
    // Outcomes of the apply, then of the undo.
    applied: v.optional(v.object({ applied: v.number(), conflict: v.number(), failed: v.number() })),
    undone: v.optional(v.object({ applied: v.number(), conflict: v.number(), failed: v.number() })),
    appliedBy: v.optional(v.id("users")),
    appliedAt: v.optional(v.number()),
    undoneBy: v.optional(v.id("users")),
    undoneAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_consolidationId_and_createdAt", ["consolidationId", "createdAt"]),
  // One proposed write of a run: the value the CRM held at preview (compare-and-set checks it before writing) and the
  // value to write. Undo writes `before` back, checking the record still holds `after`.
  fieldConsolidationWrites: defineTable({
    orgId: v.id("organizations"),
    runId: v.id("fieldConsolidationRuns"),
    provider: v.union(v.literal("hubspot"), v.literal("salesforce")),
    objectType: v.union(v.literal("account"), v.literal("contact")),
    recordId: v.string(),
    field: v.string(),
    before: v.union(v.string(), v.null()),
    after: v.string(),
    kind: v.union(v.literal("fill"), v.literal("change")),
    reason: v.string(),
    status: v.union(
      v.literal("pending"), v.literal("applied"), v.literal("conflict"), v.literal("failed"),
      v.literal("undone"), v.literal("undoConflict"), v.literal("undoFailed"),
      // Sent to the CRM by an apply (writing) or undo (unwriting) whose outcome isn't recorded yet.
      v.literal("writing"), v.literal("unwriting"),
    ),
    detail: v.optional(v.string()),
  }).index("by_runId_and_status", ["runId", "status"]),
  // One object's profile for a consolidation: fill, values and pairwise agreement (lib/consolidate.ts ObjectProfile).
  fieldConsolidationProfiles: defineTable({
    orgId: v.id("organizations"),
    consolidationId: v.id("fieldConsolidations"),
    object: v.string(),
    stage: v.union(v.literal("reading"), v.literal("done"), v.literal("error")),
    read: v.number(),
    profile: v.optional(v.any()),
    error: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_consolidationId_and_object", ["consolidationId", "object"]),
  // Account hierarchy manager (docs/account-hierarchy-manager.md): cleanup of duplicate companies and parent/child
  // structure, scanned from Canon's own records or a connected Salesforce: scans, cited research, proposals and a
  // person's per-item decisions. Approving a parent move on a Canon scan changes Canon's parent link; nothing else is
  // applied, and nothing writes to a CRM. Account ids in groups, research and decisions are the scan's provider's ids
  // (Canon record ids or Salesforce ids); a scan's rows never mix them.
  hierarchySettings: defineTable({
    orgId: v.id("organizations"),
    /** The workspace policy (engine/src/accountHierarchy/policy.ts), as entered. */
    policy: v.any(),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),
  hierarchyScans: defineTable({
    orgId: v.id("organizations"),
    provider: v.union(v.literal("salesforce"), v.literal("canon")),
    status: v.union(v.literal("reading"), v.literal("done"), v.literal("failed")),
    startedBy: v.id("users"),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    /** The read-only snapshot the scan took (canonical JSON), for research and proposals. */
    snapshot: v.optional(v.id("_storage")),
    accounts: v.optional(v.number()),
    groups: v.optional(v.number()),
    shellGroups: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index("by_orgId", ["orgId"]),
  hierarchyGroups: defineTable({
    orgId: v.id("organizations"),
    scanId: v.id("hierarchyScans"),
    /** Sort position from detection: groups with a bulk-created shell first, then by size. */
    rank: v.number(),
    groupKey: v.string(),
    size: v.number(),
    shellCount: v.number(),
    /** Capped for display; the snapshot holds the full group. */
    accounts: v.array(v.object({ id: v.string(), name: v.string(), parentId: v.optional(v.string()), shell: v.boolean() })),
    reasons: v.array(v.string()),
    /** The account most of the group sits under: the default top account for research. */
    suggestedRootId: v.string(),
  })
    .index("by_scanId_and_rank", ["scanId", "rank"]),
  hierarchyResearch: defineTable({
    orgId: v.id("organizations"),
    scanId: v.id("hierarchyScans"),
    groupId: v.id("hierarchyGroups"),
    groupName: v.string(),
    rootAccountId: v.string(),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    startedBy: v.id("users"),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    model: v.optional(v.string()),
    /** GroupResearch, the verification's checks as a list, and ProposalJson (engine/src/accountHierarchy). */
    research: v.optional(v.any()),
    verification: v.optional(v.any()),
    proposal: v.optional(v.any()),
    /** The text of every page the agent read: the evidence the verbatim check used. */
    pages: v.optional(v.id("_storage")),
    error: v.optional(v.string()),
  })
    .index("by_groupId", ["groupId"])
    .index("by_scanId", ["scanId"]),
  hierarchyDecisions: defineTable({
    orgId: v.id("organizations"),
    researchId: v.id("hierarchyResearch"),
    /** The proposal item's stable key (ah:merge:<id>, ah:parent:<id>:<to>, ah:fields:<id>:<values>). */
    itemKey: v.string(),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    decidedBy: v.id("users"),
    decidedAt: v.number(),
    /** An approved parent move on a Canon scan: when it changed Canon's parent link, in the decision's transaction. */
    appliedAt: v.optional(v.number()),
    /** An approved parent move that was refused (a cycle, a parent changed since the scan): the reason, kept for the page. */
    applyError: v.optional(v.string()),
  })
    .index("by_researchId_and_itemKey", ["researchId", "itemKey"])
    .index("by_orgId_and_itemKey", ["orgId", "itemKey"]),
  integrations: defineTable({
    orgId: v.id("organizations"),
    provider: v.union(
      v.literal("salesforce"),
      v.literal("hubspot"),
      v.literal("gong"),
      v.literal("chorus"),
      v.literal("fathom"),
      v.literal("avoma"),
      v.literal("granola"),
      v.literal("stripe"),
      v.literal("instantly"),
      v.literal("emailbison"),
      v.literal("smartlead"),
      v.literal("slack"),
      v.literal("explee"),
      v.literal("deepline"),
    ),
    accessToken: v.string(),
    refreshToken: v.string(),
    instanceUrl: v.optional(v.string()),
    displayName: v.optional(v.string()),
    externalOrgId: v.optional(v.string()),
    externalOrgDomain: v.optional(v.string()),
    tokenExpiresAt: v.optional(v.number()),
    scopes: v.optional(v.array(v.string())),
    // Salesforce connected with a key (lib/salesforceClientCredentials.ts): the app's My Domain, consumer key and
    // secret as encrypted JSON (encryptForStorage). Absent for an OAuth connection, which refreshes with refreshToken.
    clientCredentials: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
    lastSyncStatus: v.optional(
      v.union(
        v.literal("success"),
        v.literal("partial"),
        v.literal("error"),
        v.literal("in_progress"),
      ),
    ),
    lastSyncError: v.optional(v.string()),
    lastSyncDealCount: v.optional(v.number()),
    syncCursor: v.optional(v.string()),
    syncCursors: v.optional(
      v.object({
        accounts: v.optional(v.string()),
        contacts: v.optional(v.string()),
        deals: v.optional(v.string()),
        calls: v.optional(v.string()),
        // HubSpot sync (hubspotActions.ts): the next incremental sync reads records modified since `modifiedSince`;
        // `fullSyncAt` is when a sync last read every record; `mappingsKey` names the field mappings it read with.
        modifiedSince: v.optional(v.number()),
        fullSyncAt: v.optional(v.number()),
        mappingsKey: v.optional(v.string()),
        // When a sync started that has not yet succeeded: the next reads every record.
        openSince: v.optional(v.number()),
        // The portal's list cursor did not hold as a record id: a full sync reads each object in one cursor.
        oneCursor: v.optional(v.boolean()),
      }),
    ),
    fieldMappings: v.optional(v.any()),
    syncConfig: v.optional(v.any()),
    isActive: v.boolean(),
    connectedBy: v.optional(v.id("users")),
    connectedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_provider", ["orgId", "provider"])
    .index("by_provider", ["provider"]),

  // ── Connector feeds (shared gap P5, docs/connector-feeds.md) ──
  // A workspace's or a member's link to one connector in convex/lib/connectors (a signed webhook, a recorder, a
  // LinkedIn sender). `secret`: a signed webhook's signing secret, encrypted (encryptForStorage); no other connector
  // keeps one here yet. `lastError`: why the last item it sent was refused.
  connectorLinks: defineTable({
    orgId: v.id("organizations"),
    connector: v.string(),
    userId: v.optional(v.id("users")),
    label: v.optional(v.string()),
    status: v.union(v.literal("ok"), v.literal("expired"), v.literal("error"), v.literal("revoked")),
    secret: v.optional(v.string()),
    lastItemAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    lastErrorAt: v.optional(v.number()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
  })
    .index("by_orgId_and_connector_and_userId", ["orgId", "connector", "userId"]),

  connectorFeedGrants: defineTable({
    orgId: v.id("organizations"),
    linkId: v.id("connectorLinks"),
    moduleId: v.string(),
    granted: v.boolean(),
    revision: v.number(),
    changedBy: v.id("users"),
    changedAt: v.number(),
  }).index("by_orgId_and_linkId_and_moduleId", ["orgId", "linkId", "moduleId"]),

  // The latest state of each item of a feed (convex/lib/connectors/feeds.ts): one row per feed and item id, holding
  // only the feed's declared fields. `version` orders an item's updates: one older than the stored one is dropped.
  feedItems: defineTable({
    orgId: v.id("organizations"),
    feed: v.string(),
    itemId: v.string(),
    linkId: v.id("connectorLinks"),
    version: v.optional(v.number()),
    data: v.any(),
    deleted: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_orgId_and_feed_and_itemId", ["orgId", "feed", "itemId"])
    .index("by_orgId_and_feed_and_linkId_and_updatedAt", ["orgId", "feed", "linkId", "updatedAt"])
    .index("by_orgId_and_feed_and_updatedAt", ["orgId", "feed", "updatedAt"]),

  // Each change to a feed's items, in order: `seq` counts from 1 per workspace and feed, with no gaps, and is the
  // cursor a module reads the feed by. A replayed item that changes nothing writes no row.
  feedLog: defineTable({
    orgId: v.id("organizations"),
    feed: v.string(),
    seq: v.number(),
    itemId: v.string(),
    linkId: v.id("connectorLinks"),
    before: v.any(),
    after: v.any(),
    at: v.number(),
  })
    .index("by_orgId_and_feed_and_seq", ["orgId", "feed", "seq"])
    .index("by_linkId_and_at", ["linkId", "at"]),

  // ── Salesforce import + two-way sync (Phase 1b) ─────────────
  // Metadata: one row per described object / field (describe-driven, every
  // queryable object). Records themselves live in the record service.
  objectDefinitions: defineTable({
    orgId: v.id("organizations"),
    provider: v.literal("salesforce"),
    apiName: v.string(),
    label: v.string(),
    isCustom: v.boolean(),
    syncEnabled: v.boolean(),
    recordCount: v.optional(v.number()),
    describedAt: v.number(),
  })
    .index("by_orgId_and_provider_and_apiName", ["orgId", "provider", "apiName"]),

  fieldDefinitions: defineTable({
    orgId: v.id("organizations"),
    object: v.string(),
    apiName: v.string(),
    label: v.string(),
    type: v.string(), // Salesforce field type
    picklistValues: v.optional(v.array(v.string())),
    referenceTo: v.optional(v.array(v.string())),
    updateable: v.boolean(),
    syncAuthority: v.union(v.literal("fsgtm"), v.literal("salesforce"), v.literal("newest"), v.literal("review")),
    mappedTo: v.optional(v.string()),
  })
    .index("by_orgId_and_object_and_apiName", ["orgId", "object", "apiName"]),

  sfSyncState: defineTable({
    orgId: v.id("organizations"),
    readOnly: v.boolean(),
    mode: v.union(v.literal("cdc"), v.literal("poll")),
    inboundCursor: v.object({
      replayId: v.optional(v.string()),
      modstampByObject: v.record(v.string(), v.number()),
      // Keyset tiebreak for SystemModstamp polling.
      lastIdByObject: v.optional(v.record(v.string(), v.string())),
    }),
    outboxCursor: v.number(),
    lastInboundAt: v.optional(v.number()),
    lastOutboundAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    pollIntervalMs: v.number(),
    lastPollAt: v.optional(v.number()),
    lastTickAt: v.optional(v.number()),
    tickLeaseUntil: v.optional(v.number()),
    lastStats: v.optional(v.any()),
  })
    .index("by_orgId", ["orgId"]),

  sfConflicts: defineTable({
    orgId: v.id("organizations"),
    object: v.string(),
    recordId: v.string(),
    sfId: v.string(),
    field: v.string(),
    fsgtmValue: v.any(),
    sfValue: v.any(),
    fsgtmAt: v.number(),
    sfAt: v.number(),
    status: v.union(v.literal("open"), v.literal("resolved")),
    resolution: v.optional(v.union(v.literal("fsgtm"), v.literal("salesforce"), v.literal("custom"))),
    resolvedValue: v.optional(v.any()),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_orgId_and_status", ["orgId", "status"])
    .index("by_orgId_and_sfId_and_field", ["orgId", "sfId", "field"])
    .index("by_orgId_and_recordId_and_field_and_status", ["orgId", "recordId", "field", "status"]),

  integrationSyncRuns: defineTable({
    orgId: v.id("organizations"),
    integrationId: v.optional(v.id("integrations")),
    provider: v.union(
      v.literal("salesforce"),
      v.literal("hubspot"),
      v.literal("gong"),
      v.literal("chorus"),
      v.literal("fathom"),
      v.literal("avoma"),
      v.literal("granola"),
      v.literal("stripe"),
    ),
    trigger: v.union(
      v.literal("manual"),
      v.literal("scheduled"),
      v.literal("oauth"),
      v.literal("system"),
    ),
    status: v.union(
      v.literal("success"),
      v.literal("partial"),
      v.literal("error"),
      v.literal("in_progress"),
    ),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    counts: v.optional(v.any()),
    error: v.optional(v.string()),
    // Live heartbeat while the run executes (the shared progress vocabulary —
    // engine/src/progress.ts). Reactive queries turn this into
    // ProgressChip/StageTimeline for free; stale heartbeatAt = stalled run.
    progress: v.optional(
      v.object({
        stage: v.optional(v.string()),
        stageIndex: v.optional(v.number()),
        stageCount: v.optional(v.number()),
        itemsDone: v.optional(v.number()),
        itemsTotal: v.optional(v.number()),
        note: v.optional(v.string()),
        heartbeatAt: v.number(),
      }),
    ),
    // Per-object progress of a sync that writes several objects at once (hubspotActions.ts): records done of the
    // total, and the write rate (records a second, smoothed) the panel estimates the time left from.
    objects: v.optional(v.array(v.object({
      object: v.string(),
      done: v.number(),
      total: v.optional(v.number()),
      finished: v.boolean(),
      perSecond: v.optional(v.number()),
      updatedAt: v.number(),
    }))),
  })
    .index("by_orgId", ["orgId"])
    .index("by_integrationId", ["integrationId"])
    .index("by_orgId_provider_startedAt", ["orgId", "provider", "startedAt"])
    .index("by_status_and_provider_and_startedAt", ["status", "provider", "startedAt"]),

  // A whole-portal import from a CRM (CP12, convex/hubspotImport.ts): the phase and HubSpot cursor it has reached,
  // so a stopped run resumes there, with per-object results, failures, the owner report and the spot check.
  crmImports: defineTable({
    orgId: v.id("organizations"),
    provider: v.literal("hubspot"),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    startedBy: v.id("users"),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    heartbeatAt: v.number(),
    objects: v.array(v.string()),
    phase: v.string(),
    cursor: v.union(v.string(), v.null()),
    // While the run is at a stage whose phases run side by side (links, engagements): each phase's cursor and whether it finished.
    lanes: v.optional(v.array(v.object({ phase: v.string(), cursor: v.union(v.string(), v.null()), done: v.boolean() }))),
    // Bumped by a resume: a step scheduled under an older lease stops instead of running twice.
    lease: v.number(),
    results: v.array(v.object({ object: v.string(), read: v.number(), written: v.number(), failed: v.number() })),
    failures: v.array(v.object({ object: v.string(), id: v.string(), message: v.string() })),
    owners: v.array(v.object({
      crmOwnerId: v.string(), name: v.string(), email: v.union(v.string(), v.null()), archived: v.boolean(),
      userId: v.union(v.string(), v.null()), member: v.boolean(), records: v.number(),
    })),
    notices: v.array(v.object({ object: v.string(), message: v.string() })),
    // The portal's custom properties and the Canon custom field each became (CP12c).
    customFields: v.optional(v.array(v.object({
      object: v.union(v.literal("account"), v.literal("contact"), v.literal("deal")), property: v.string(), apiName: v.string(),
      type: v.string(), options: v.array(v.object({ hubspot: v.string(), canon: v.string() })),
    }))),
    error: v.optional(v.string()),
    spotCheck: v.optional(v.object({
      at: v.number(),
      objects: v.array(v.object({
        object: v.string(), sampled: v.number(), fields: v.number(),
        mismatches: v.array(v.object({ id: v.string(), name: v.string(), field: v.string(), hubspot: v.union(v.string(), v.null()), canon: v.union(v.string(), v.null()) })),
      })),
    })),
  }).index("by_orgId_startedAt", ["orgId", "startedAt"]),

  oauthStates: defineTable({
    state: v.string(),
    orgId: v.id("organizations"),
    userId: v.optional(v.id("users")),
    provider: v.string(),
    codeVerifier: v.optional(v.string()),
    cliAuthRequestId: v.optional(v.id("cliAuthRequests")),
    cliAuthDeviceCodeHash: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.optional(v.number()),
  })
    .index("by_state", ["state"])
    .index("by_expiresAt", ["expiresAt"]),

  // CLI broker auth: device-flow pairing requests and long-lived CLI tokens.
  cliAuthRequests: defineTable({
    deviceCodeHash: v.string(),
    userCode: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied"),
      v.literal("expired"),
      v.literal("claimed"),
    ),
    // Self-reported by the CLI (hostname/platform). Shown to the approver so
    // they can recognize a pairing request and refuse phishing attempts.
    requesterLabel: v.optional(v.string()),
    provider: v.optional(v.union(v.literal("hubspot"), v.literal("salesforce"))),
    orgId: v.optional(v.id("organizations")),
    userId: v.optional(v.id("users")),
    cliTokenId: v.optional(v.id("cliTokens")),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_deviceCodeHash", ["deviceCodeHash"])
    .index("by_userCode", ["userCode"])
    .index("by_expiresAt", ["expiresAt"]),

  cliTokens: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    tokenHash: v.string(),
    name: v.optional(v.string()),
    requesterLabel: v.optional(v.string()),
    lastUsedAt: v.optional(v.number()),
    // Broker tokens expire and must be re-paired; bounds the damage from a
    // leaked credentials file.
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_orgId", ["orgId"]),

  // Agents (MCP clients, the canon CLI, paired CLI tokens) that have reached
  // the hosted /mcp endpoint as a user. One row per user and OAuth client;
  // the dashboard stays locked behind agent onboarding until a user has one.
  agentConnections: defineTable({
    userId: v.id("users"),
    clientId: v.string(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
  }).index("by_userId_and_clientId", ["userId", "clientId"]),

  // Per-user "Sign in with ChatGPT" (Codex device-code OAuth). AI tasks a user
  // starts run on their own ChatGPT plan. One row per user: "pending" while the
  // device code awaits approval, then "connected". Tokens are encrypted at rest
  // (lib/tokenHelpers) and never leave the server.
  chatgptAuth: defineTable({
    userId: v.id("users"),
    status: v.union(v.literal("pending"), v.literal("connected"), v.literal("error")),
    // Pending device flow (deviceAuthId encrypted: with the user code it is
    // enough to claim the login).
    deviceAuthId: v.optional(v.string()),
    userCode: v.optional(v.string()),
    verificationUrl: v.optional(v.string()),
    pollIntervalMs: v.optional(v.number()),
    deviceExpiresAt: v.optional(v.number()),
    // Connected session (all three tokens encrypted).
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    idToken: v.optional(v.string()),
    accessTokenExpiresAt: v.optional(v.number()),
    accountId: v.optional(v.string()),
    email: v.optional(v.string()),
    planType: v.optional(v.string()),
    connectedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_userId", ["userId"]),

  // Durable acquisition traversal checkpoints shared by paired CLIs. The
  // opaque key binds provider/list/filter/ICP identity; no prospect PII or
  // provider credential is stored here. userId/cliTokenId are attribution,
  // while orgId is the authorization boundary.
  acquisitionCheckpoints: defineTable({
    orgId: v.id("organizations"),
    key: v.string(),
    checkpoint: v.any(),
    version: v.number(),
    updatedAt: v.number(),
    updatedByUserId: v.id("users"),
    updatedByCliTokenId: v.id("cliTokens"),
  }).index("by_org_key", ["orgId", "key"]),

  // Canonical, portable artifacts mirrored by paired CLIs. These are records
  // for later analysis and hosted visibility, never an execution cache.
  cliArtifacts: defineTable({
    orgId: v.id("organizations"),
    kind: v.union(v.literal("icp"), v.literal("signal_run"), v.literal("lead_run")),
    key: v.string(),
    label: v.string(),
    domain: v.optional(v.string()),
    document: v.any(),
    sourceVersion: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    updatedByUserId: v.id("users"),
    updatedByCliTokenId: v.optional(v.id("cliTokens")),
    currentRevision: v.optional(v.number()),
    documentSha256: v.optional(v.string()),
    origin: v.optional(v.union(v.literal("cli"), v.literal("hosted"))),
    publishedAt: v.optional(v.number()),
  })
    .index("by_org_kind_key", ["orgId", "kind", "key"])
    .index("by_org_kind_updatedAt", ["orgId", "kind", "updatedAt"]),

  // Immutable publication history. Draft autosaves live in their own table so
  // high-churn editing never rewrites or bloats the canonical artifact row.
  cliArtifactRevisions: defineTable({
    orgId: v.id("organizations"),
    artifactId: v.id("cliArtifacts"),
    revision: v.number(),
    document: v.any(),
    documentSha256: v.string(),
    origin: v.union(v.literal("cli"), v.literal("hosted")),
    changeSummary: v.optional(v.string()),
    parentRevision: v.optional(v.number()),
    restoredFromRevision: v.optional(v.number()),
    createdAt: v.number(),
    createdByUserId: v.id("users"),
    createdByCliTokenId: v.optional(v.id("cliTokens")),
  })
    .index("by_artifactId_and_revision", ["artifactId", "revision"])
    .index("by_orgId_and_artifactId_and_createdAt", ["orgId", "artifactId", "createdAt"]),

  cliArtifactDrafts: defineTable({
    orgId: v.id("organizations"),
    artifactId: v.id("cliArtifacts"),
    baseRevision: v.number(),
    document: v.any(),
    documentSha256: v.string(),
    changeSummary: v.optional(v.string()),
    updatedAt: v.number(),
    updatedByUserId: v.id("users"),
  }).index("by_orgId_and_artifactId", ["orgId", "artifactId"]),

  // ── Agent self-registration (Tier 1: public read-only) ──────
  //
  // Self-registered agents get `fsgtm_agent_` tokens scoped to the public
  // read endpoints only. They are NEVER attached to an organization and can
  // never reach tenant CRM data — org access requires the human-approved
  // cliAuth pairing above. Raw tokens and raw IPs are never stored: rows hold
  // a SHA-256 token hash (cliAuth idiom) and a salted SHA-256 IP hash.
  agentRegistrations: defineTable({
    name: v.string(),
    operatorContact: v.string(),
    platform: v.optional(v.string()),
    tokenHash: v.string(),
    scopes: v.array(v.string()),
    registrationIpHash: v.string(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.number(),
    // auth.md claim ceremony: hash of the one-time claim_token returned at
    // registration (same SHA-256-at-rest idiom as tokenHash), and — once a
    // signed-in user claims the registration — the ownership binding.
    // Claiming NEVER changes tokenHash or scopes: it records ownership, it
    // does not upgrade access.
    claimTokenHash: v.optional(v.string()),
    claimedByUserId: v.optional(v.id("users")),
    claimedByOrgId: v.optional(v.id("organizations")),
    claimedAt: v.optional(v.number()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_operatorContact", ["operatorContact"])
    .index("by_ipHash_createdAt", ["registrationIpHash", "createdAt"])
    .index("by_claimTokenHash", ["claimTokenHash"])
    .index("by_claimedByUserId", ["claimedByUserId"]),

  crmAccounts: defineTable({
    orgId: v.id("organizations"),
    crmId: v.string(),
    provider: v.string(),
    name: v.string(),
    domain: v.optional(v.string()),
    industry: v.optional(v.string()),
    employeeCount: v.optional(v.number()),
    annualRevenue: v.optional(v.number()),
    ownerId: v.optional(v.id("users")),
    crmOwnerId: v.optional(v.string()),
    address: v.optional(v.any()),
    rawData: v.optional(v.any()),
    lastSyncAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_crmId", ["orgId", "crmId"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["orgId"] }),

  crmContacts: defineTable({
    orgId: v.id("organizations"),
    crmId: v.string(),
    provider: v.string(),
    accountId: v.optional(v.id("crmAccounts")),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    title: v.optional(v.string()),
    ownerId: v.optional(v.id("users")),
    crmOwnerId: v.optional(v.string()),
    rawData: v.optional(v.any()),
    lastSyncAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_crmId", ["orgId", "crmId"])
    .index("by_accountId", ["accountId"]),

  // ── Deals ────────────────────────────────────────────────────

  deals: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    // Optional: amountless CRM deals sync into the mirror; the audit's
    // missing-deal-amount rule flags them and proposes the fix as a patch
    // plan. Revenue rollups treat missing amounts as 0.
    amount: v.optional(v.number()),
    currency: v.string(),
    closeDate: v.string(),
    dealType: v.union(
      v.literal("new_business"),
      v.literal("expansion"),
      v.literal("renewal"),
      v.literal("one_time"),
    ),
    revenueType: v.union(v.literal("one_time"), v.literal("recurring")),
    contractLengthMonths: v.optional(v.number()),
    mrr: v.optional(v.number()),
    arr: v.optional(v.number()),
    // Optional: ownerless CRM deals sync into the mirror (the audit flags
    // them; the deal.assign_owners plan proposes owners). crmOwnerId keeps the
    // raw CRM owner id when it maps to no synced user.
    primaryRepId: v.optional(v.id("users")),
    crmOwnerId: v.optional(v.string()),
    splitAllocations: v.optional(
      v.array(
        v.object({
          userId: v.id("users"),
          percentage: v.number(),
          kind: v.optional(v.union(v.literal("revenue"), v.literal("overlay"))),
        }),
      ),
    ),
    stage: v.optional(v.string()),
    forecastCategory: v.optional(
      v.union(
        v.literal("omit"),
        v.literal("pipeline"),
        v.literal("best_case"),
        v.literal("commit"),
        v.literal("closed_won"),
        v.literal("closed_lost"),
      ),
    ),
    probability: v.optional(v.number()),
    accountId: v.optional(v.id("crmAccounts")),
    // The register company (`acc_…`), projected from the deal's `companyId` field.
    companyId: v.optional(v.string()),
    crmId: v.optional(v.string()),
    crmProvider: v.optional(v.string()),
    crmUrl: v.optional(v.string()),
    // How Canon created the deal: by a person, an agent or a rule (`manual`), or a CSV import (`csv`). A deal a CRM sync
    // created has `crmProvider` instead. Absent on deals created before it was recorded until deals:backfillOrigin runs.
    origin: v.optional(v.union(v.literal("manual"), v.literal("csv"))),
    products: v.optional(v.array(v.string())),
    lineItemProducts: v.optional(v.array(v.string())),
    competitorMentioned: v.optional(v.array(v.string())),
    rawData: v.optional(v.any()),
    nextStep: v.optional(v.string()),
    isClosed: v.boolean(),
    isWon: v.boolean(),
    closedAt: v.optional(v.number()),
    lastSyncAt: v.optional(v.number()),
    // A fingerprint of the values the CRM sync last wrote: a sync with the same values skips the deal (lib/syncUnchanged.ts).
    syncHash: v.optional(v.string()),
    // When the deal was archived (its stream's lifecycle is deleted, lib/canon/dealLedger.ts writeDealLifecycle): readers of
    // this table leave it out. Absent on a live deal.
    archivedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    // Live deals (not archived) of a workspace, newest first with order("desc"): what the pipeline, reports and audits read.
    .index("by_orgId_archivedAt", ["orgId", "archivedAt"])
    .index("by_orgId_closeDate", ["orgId", "closeDate"])
    // Deals changed since a time, oldest first: a module read plan's deals.updatedSince.
    .index("by_orgId_updatedAt", ["orgId", "updatedAt"])
    .index("by_primaryRepId", ["primaryRepId"])
    // Deal visibility (CP14): a workspace's deals by owner, including those with none.
    .index("by_orgId_and_primaryRepId", ["orgId", "primaryRepId"])
    .index("by_orgId_crmId", ["orgId", "crmId"])
    .index("by_accountId", ["accountId"])
    .index("by_orgId_companyId", ["orgId", "companyId"])
    .index("by_orgId_name", ["orgId", "name"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["orgId"] }),

  // A deal's buying committee (docs/account-plays.md): one row per person in a
  // slot. Roles live on the deal; the account page rolls them up across deals.
  // Superseded by `deal_contact` edges (CP3b, convex/dealCommittee.ts): read
  // only for a deal with no edges yet, never written. Dropped once
  // dealCommittee:migrateDealContacts has run on every deployment. The
  // contact's name and title are a snapshot from when the slot was set.
  dealContacts: defineTable({
    orgId: v.id("organizations"),
    dealId: v.id("deals"),
    contactId: v.string(),
    contactName: v.string(),
    title: v.optional(v.string()),
    slot: v.union(
      v.literal("executive"), v.literal("n1"), v.literal("champion"), v.literal("user"),
      v.literal("procurement"), v.literal("security"), v.literal("signer"),
    ),
    // Canon's reason when the person was picked by Canon and accepted.
    reason: v.optional(v.string()),
    setBy: v.id("users"),
    updatedAt: v.number(),
  })
    .index("by_dealId", ["dealId"])
    .index("by_dealId_and_contactId", ["dealId", "contactId"]),

  // A deal's play (docs/deal-plays.md): one per deal, holding the brief, the
  // decision window and the research run's state. Its evidence, map notes and
  // plan steps are child tables. Roles stay on `deal_contact` edges.
  dealChats: defineTable({
    orgId: v.id("organizations"), streamId: v.string(), ownerId: v.id("users"),
    title: v.string(), sharedWith: v.array(v.id("users")), createdAt: v.number(), updatedAt: v.number(),
    pending: v.optional(v.string()), pendingAt: v.optional(v.number()),
  }).index("by_orgId_streamId", ["orgId", "streamId"]),

  dealChatMessages: defineTable({
    chatId: v.id("dealChats"), role: v.union(v.literal("user"), v.literal("assistant")), content: v.string(),
    sources: v.array(v.object({ object: v.string(), id: v.string(), title: v.string(), href: v.string() })),
    createdAt: v.number(),
  }).index("by_chatId", ["chatId"]),

  dealPlays: defineTable({
    orgId: v.id("organizations"),
    dealId: v.id("deals"),
    // The deal's canonEntities stream id, which its record page and /mcp name it by.
    streamId: v.string(),
    // What the seller offers this account and the angle: the research run reads it.
    context: v.optional(v.string()),
    whyNow: v.optional(v.string()),
    alphaHypothesis: v.optional(v.string()),
    alphaPitch: v.optional(v.string()),
    // Whether a person last wrote the brief; research only fills a brief no person wrote.
    briefBy: v.optional(playOrigin),
    windowLabel: v.optional(v.string()),
    windowClosesOn: v.optional(v.string()),
    state: v.optional(stateValidator),
    stateSummary: v.optional(stateSummaryValidator),
    stateRun: v.optional(v.object({
      status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
      startedAt: v.number(), startedBy: v.id("users"), finishedAt: v.optional(v.number()), error: v.optional(v.string()),
    })),
    stateInputHash: v.optional(v.string()),
    stateDueAt: v.optional(v.number()),
    research: v.optional(v.object({
      status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
      startedAt: v.number(),
      startedBy: v.id("users"),
      finishedAt: v.optional(v.number()),
      error: v.optional(v.string()),
      searches: v.optional(v.number()),
      pages: v.optional(v.number()),
      kept: v.optional(v.number()),
      dropped: v.optional(v.number()),
    })),
    // The last research run's answers to the deal's prep questions (docs/deal-prep-loop.md PL1): `answer` only with a
    // quote found in a page it read; an open question goes into the call scripts.
    answers: v.optional(v.array(v.object({ question: v.string(), answer: v.optional(v.string()), quote: v.optional(v.string()), sourceUrl: v.optional(v.string()) }))),
    // The play's LinkedIn cadence per sender (DP3): invite, then the step's own draft as `{{custom.play_message}}`.
    linkedin: v.optional(v.array(v.object({ senderAccountId: v.id("linkedinAccounts"), cadenceId: v.id("linkedinCadences") }))),
    // The keeper's last daily check (dealPlayKeeper.ts): health, the flags it raised, and when it last told Slack.
    keeperCheckedAt: v.optional(v.number()),
    keeper: v.optional(v.object({
      lastTouch: v.optional(v.object({ at: v.number(), channel: playChannel })),
      health: v.union(v.literal("on_track"), v.literal("needs_attention"), v.literal("at_risk")),
      flagKeys: v.array(v.string()),
      // Urgent flags Slack has been told about and that are still raised: a flag is posted once.
      notifiedKeys: v.optional(v.array(v.string())),
      // Counts for the plays list (lib/plays/model.ts summaryOf).
      summary: v.optional(v.object({ people: v.number(), engaged: v.number(), repliesOwed: v.number(), coreFilled: v.number(), openSteps: v.number(), nextDue: v.optional(v.string()) })),
      drafted: v.number(),
      notifiedAt: v.optional(v.number()),
      error: v.optional(v.string()),
    })),
    // The last research of the people at the account (lib/plays/peopleResearch.ts): one run per contact field, then
    // the deal's reading of their answers. The keeper starts it weekly; a person can start it any time.
    peopleResearch: v.optional(v.object({
      status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
      startedAt: v.number(),
      startedBy: v.id("users"),
      contactIds: v.array(v.string()),
      runIds: v.array(v.id("researchRuns")),
      finishedAt: v.optional(v.number()),
      note: v.optional(v.string()),
    })),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId_and_streamId", ["orgId", "streamId"])
    .index("by_keeperCheckedAt", ["keeperCheckedAt"])
    // The background activity tray's newest account and people research (activity.ts background).
    .index("by_orgId_and_researchStartedAt", ["orgId", "research.startedAt"])
    .index("by_orgId_and_peopleResearchStartedAt", ["orgId", "peopleResearch.startedAt"]),

  dealProspectRankings: defineTable({
    orgId: v.id("organizations"),
    streamId: v.string(),
    input: v.string(),
    model: v.string(),
    keys: v.array(v.string()),
  }).index("by_orgId_and_streamId", ["orgId", "streamId"]),

  dealPlayItems: defineTable({
    orgId: v.id("organizations"),
    playId: v.id("dealPlays"),
    kind: playItemKind,
    text: v.string(),
    quote: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    evidence: v.union(v.literal("verified"), v.literal("unverified"), v.literal("none")),
    occurredOn: v.optional(v.string()),
    // A person a page names who isn't in Canon yet: adding them makes the contact and puts them on the deal.
    person: v.optional(v.object({ name: v.string(), title: v.optional(v.string()), role: v.optional(dealRole) })),
    origin: playOrigin,
    dismissed: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_playId", ["playId"]),

  // Per person on the play: where they sit and how to approach them. Persona and angle are hypotheses.
  dealPlayPeople: defineTable({
    orgId: v.id("organizations"),
    playId: v.id("dealPlays"),
    contactId: v.string(),
    reportsTo: v.optional(v.string()),
    persona: v.optional(v.string()),
    angle: v.optional(v.string()),
    confidence: v.optional(v.union(v.literal("high"), v.literal("medium"), v.literal("low"))),
    // A role research suggests for a company person not yet on the deal; adding them is the person's call.
    suggestedRole: v.optional(dealRole),
    // People research's reading of this person (lib/plays/peopleResearch.ts): Jev's innovation or stability call, and
    // the new capability the seller's product could give them, a hypothesis written from their researched answers.
    center: v.optional(v.union(v.literal("innovation"), v.literal("stability"))),
    centerConfidence: v.optional(v.number()),
    capability: v.optional(v.string()),
    insightAt: v.optional(v.number()),
    origin: playOrigin,
    updatedAt: v.number(),
  })
    .index("by_playId_and_contactId", ["playId", "contactId"]),

  dealPlaySteps: defineTable({
    orgId: v.id("organizations"),
    playId: v.id("dealPlays"),
    title: v.string(),
    channel: playChannel,
    // Who the step is for: a person, or a role resolved to whoever holds it when read.
    contactId: v.optional(v.string()),
    role: v.optional(dealRole),
    ownerUserId: v.optional(v.id("users")),
    dueOn: v.optional(v.string()),
    state: v.union(v.literal("planned"), v.literal("done"), v.literal("skipped")),
    doneAt: v.optional(v.number()),
    // The message for this touch: the keeper drafts it on the owner's ChatGPT plan; a person edits and sends it.
    // `contactId` is who it was written for: a draft for someone else than the step now targets is not shown or sent.
    // `review` is the model's read of a keeper draft (docs/deal-prep-loop.md); a person's edit drops it.
    draft: v.optional(v.object({
      subject: v.optional(v.string()), body: v.string(), contactId: v.optional(v.string()), by: v.union(v.literal("keeper"), v.literal("user")), at: v.number(),
      review: v.optional(draftReviewValidator),
    })),
    // When a LinkedIn step was handed to its sender's cadence worker; the first LinkedIn touch then completes it.
    queuedAt: v.optional(v.number()),
    origin: playOrigin,
    createdAt: v.number(),
  })
    .index("by_playId", ["playId"]),

  dealOverrides: defineTable({
    dealId: v.id("deals"),
    orgId: v.id("organizations"),
    userId: v.id("users"),
    overrideType: v.union(
      v.literal("amount"),
      v.literal("rate"),
      v.literal("bonus"),
      v.literal("exclude"),
    ),
    value: v.number(),
    reason: v.optional(v.string()),
    approvedBy: v.optional(v.id("users")),
    createdAt: v.number(),
  })
    .index("by_dealId", ["dealId"])
    .index("by_orgId", ["orgId"]),

  // ── Commission Plans ─────────────────────────────────────────

  commissionPlans: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    effectiveStart: v.string(),
    effectiveEnd: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("archived"),
    ),
    version: v.number(),
    quotaAmount: v.optional(v.number()),
    quotaDistribution: v.optional(
      v.union(
        v.literal("same_for_all"),
        v.literal("per_rep"),
        v.literal("per_period"),
        v.literal("per_rep_per_period"),
      ),
    ),
    quotaPeriod: v.union(
      v.literal("monthly"),
      v.literal("quarterly"),
      v.literal("annual"),
    ),
    hiddenFromReps: v.optional(v.boolean()),
    isRollup: v.optional(v.boolean()),
    rollupIncludeOwnDeals: v.optional(v.boolean()),
    isTemplate: v.boolean(),
    templateCategory: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_status", ["orgId", "status"])
    .index("by_isTemplate", ["isTemplate"]),

  planRules: defineTable({
    planId: v.id("commissionPlans"),
    orgId: v.id("organizations"),
    orderIndex: v.number(),
    name: v.string(),
    description: v.optional(v.string()),
    isEnabled: v.boolean(),
    type: v.union(
      v.literal("flat_rate"),
      v.literal("tiered_rate"),
      v.literal("accelerator"),
      v.literal("decelerator"),
      v.literal("milestone"),
      v.literal("spif"),
      v.literal("split"),
      v.literal("clawback"),
      v.literal("cap"),
      v.literal("draw"),
      v.literal("modifier"),
      v.literal("team_bonus"),
      v.literal("overlay"),
    ),
    config: v.any(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_planId", ["planId"])
    .index("by_orgId", ["orgId"]),

  planAssignments: defineTable({
    planId: v.id("commissionPlans"),
    userId: v.id("users"),
    orgId: v.id("organizations"),
    effectiveStart: v.string(),
    effectiveEnd: v.optional(v.string()),
    quotaOverride: v.optional(v.number()),
    ruleOverrides: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_planId", ["planId"])
    .index("by_orgId", ["orgId"])
    .index("by_orgId_userId", ["orgId", "userId"]),

  planRuleExclusions: defineTable({
    ruleId: v.id("planRules"),
    userId: v.id("users"),
    planId: v.id("commissionPlans"),
    orgId: v.id("organizations"),
    createdAt: v.number(),
  })
    .index("by_ruleId", ["ruleId"])
    .index("by_planId", ["planId"]),

  // ── Commission Calculations ──────────────────────────────────

  payPeriods: defineTable({
    orgId: v.id("organizations"),
    label: v.string(),
    startDate: v.string(),
    endDate: v.string(),
    periodType: v.union(
      v.literal("monthly"),
      v.literal("quarterly"),
      v.literal("annual"),
    ),
    isClosed: v.boolean(),
    closedAt: v.optional(v.number()),
    closedBy: v.optional(v.id("users")),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_startDate", ["orgId", "startDate"]),

  commissionLineItems: defineTable({
    orgId: v.id("organizations"),
    statementId: v.optional(v.id("statements")),
    dealId: v.id("deals"),
    userId: v.id("users"),
    planId: v.id("commissionPlans"),
    ruleId: v.id("planRules"),
    periodStart: v.string(),
    periodEnd: v.string(),
    dealAmount: v.number(),
    commissionAmount: v.number(),
    rate: v.number(),
    ruleType: v.string(),
    ruleName: v.string(),
    splitPercentage: v.optional(v.number()),
    notes: v.optional(v.string()),
    isOverridden: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_userId", ["userId"])
    .index("by_dealId", ["dealId"])
    .index("by_statementId", ["statementId"])
    .index("by_orgId_planId_periodStart", ["orgId", "planId", "periodStart"])
    .index("by_userId_periodStart", ["userId", "periodStart"]),

  statements: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    planId: v.optional(v.id("commissionPlans")),
    payPeriodId: v.id("payPeriods"),
    periodLabel: v.string(),
    totalCommission: v.number(),
    totalDeals: v.number(),
    quotaAmount: v.optional(v.number()),
    attainment: v.optional(v.number()),
    status: v.union(
      v.literal("draft"),
      v.literal("pending_approval"),
      v.literal("approved"),
      v.literal("paid"),
      v.literal("disputed"),
    ),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    paidAt: v.optional(v.number()),
    disputeReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_userId", ["userId"])
    .index("by_planId", ["planId"])
    .index("by_planId_payPeriodId", ["planId", "payPeriodId"])
    .index("by_payPeriodId", ["payPeriodId"])
    .index("by_orgId_status", ["orgId", "status"]),

  // ── Quota Tracking ───────────────────────────────────────────

  quotaProgress: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    periodStart: v.string(),
    periodEnd: v.string(),
    quotaAmount: v.number(),
    attainedAmount: v.number(),
    attainmentPct: v.number(),
    dealCount: v.number(),
    lastCalculatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_userId", ["userId"])
    .index("by_userId_periodStart", ["userId", "periodStart"]),

  // ── Territory Planning ───────────────────────────────────────

  territories: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    parentId: v.optional(v.id("territories")),
    type: v.union(
      v.literal("geographic"),
      v.literal("named_account"),
      v.literal("segment"),
      v.literal("vertical"),
      v.literal("custom"),
    ),
    criteria: v.optional(v.any()),
    metadata: v.optional(v.any()),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_parentId", ["parentId"]),

  territoryAssignments: defineTable({
    territoryId: v.id("territories"),
    userId: v.id("users"),
    orgId: v.id("organizations"),
    role: v.union(
      v.literal("primary"),
      v.literal("overlay"),
      v.literal("backup"),
    ),
    effectiveStart: v.string(),
    effectiveEnd: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_territoryId", ["territoryId"])
    .index("by_userId", ["userId"])
    .index("by_orgId", ["orgId"]),

  territoryRules: defineTable({
    territoryId: v.id("territories"),
    orgId: v.id("organizations"),
    field: v.string(),
    operator: v.string(),
    value: v.any(),
    createdAt: v.number(),
  })
    .index("by_territoryId", ["territoryId"])
    .index("by_orgId", ["orgId"]),

  // ── Quota Planning ───────────────────────────────────────────

  quotaPlans: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    fiscalYear: v.string(),
    totalTarget: v.number(),
    methodology: v.union(
      v.literal("top_down"),
      v.literal("bottom_up"),
      v.literal("hybrid"),
    ),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("archived"),
    ),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_status", ["orgId", "status"]),

  quotaPlanTargets: defineTable({
    quotaPlanId: v.id("quotaPlans"),
    orgId: v.id("organizations"),
    territoryId: v.optional(v.id("territories")),
    userId: v.optional(v.id("users")),
    targetAmount: v.number(),
    period: v.string(),
    createdAt: v.number(),
  })
    .index("by_quotaPlanId", ["quotaPlanId"])
    .index("by_orgId", ["orgId"]),

  // Targets (Reports pacing): one bookings plan per workspace and year, entered
  // top down (lib/reports/targets.ts, fields in lib/reports/validators.ts).
  targetPlans: defineTable({
    orgId: v.id("organizations"),
    ...targetPlanFields,
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  }).index("by_orgId_and_year", ["orgId", "year"]),

  // ── Capacity Modeling ────────────────────────────────────────

  capacityModels: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    fiscalYear: v.string(),
    assumptions: v.any(),
    results: v.optional(v.any()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"]),

  planningScenarios: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    fiscalYear: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("archived"),
    ),
    inputs: v.any(),
    results: v.any(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_status", ["orgId", "status"]),

  // ── Pipeline & Forecasting ───────────────────────────────────

  pipelineStageConfigs: defineTable({
    orgId: v.id("organizations"),
    stageName: v.string(),
    orderIndex: v.number(),
    defaultProbability: v.number(),
    forecastCategory: v.union(
      v.literal("omit"),
      v.literal("pipeline"),
      v.literal("best_case"),
      v.literal("commit"),
      v.literal("closed_won"),
      v.literal("closed_lost"),
    ),
    isActive: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"]),

  // Deal pipelines (convex/lib/pipelines.ts): an ordered claim on the org's
  // deal stage options. The oldest is the default. None stored: one virtual default.
  dealPipelines: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    stages: v.array(v.object({
      value: v.string(),
      probability: v.number(),
      forecastCategory: v.union(...FORECAST_CATEGORIES.map((c) => v.literal(c))),
    })),
    recipe: v.optional(provenanceValidator),
    createdAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // ── Approval Workflows ───────────────────────────────────────

  approvalWorkflows: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    entityType: v.string(),
    steps: v.array(
      v.object({
        stepIndex: v.number(),
        approverRole: v.string(),
        approverId: v.optional(v.id("users")),
      }),
    ),
    isActive: v.boolean(),
    createdAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // ── Call Intelligence ────────────────────────────────────────

  callRecordings: defineTable({
    orgId: v.id("organizations"),
    // Which extractor produced the current insights (e.g.
    // "anthropic:claude-…" from the chunked LLM pipeline; unset = heuristics).
    analysisModel: v.optional(v.string()),
    provider: v.union(
      v.literal("gong"),
      v.literal("chorus"),
      v.literal("fathom"),
      v.literal("avoma"),
      v.literal("granola"),
      v.literal("salesforce"),
      v.literal("hubspot"),
      v.literal("csv"),
      v.literal("manual"),
      v.literal("custom"),
      v.literal("telnyx"),
    ),
    externalCallId: v.optional(v.string()),
    title: v.string(),
    callDate: v.optional(v.string()),
    durationSeconds: v.optional(v.number()),
    ownerId: v.optional(v.id("users")),
    dealId: v.optional(v.id("deals")),
    accountId: v.optional(v.id("crmAccounts")),
    contactIds: v.optional(v.array(v.id("crmContacts"))),
    participants: v.optional(v.array(v.any())),
    recordingUrl: v.optional(v.string()),
    transcriptText: v.optional(v.string()),
    transcriptStatus: v.union(
      v.literal("pending"),
      v.literal("uploaded"),
      v.literal("parsed"),
      v.literal("analyzed"),
      v.literal("error"),
    ),
    insightStatus: v.union(
      v.literal("pending"),
      // Heuristic insights are in place; the chunked LLM pass is scheduled
      // and will replace them.
      v.literal("refining"),
      v.literal("analyzed"),
      v.literal("error"),
    ),
    sourceMetadata: v.optional(v.any()),
    createdBy: v.optional(v.id("users")),
    parsedAt: v.optional(v.number()),
    analyzedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_callDate", ["orgId", "callDate"])
    .index("by_orgId_provider", ["orgId", "provider"])
    .index("by_orgId_externalCallId", ["orgId", "externalCallId"])
    .index("by_dealId", ["dealId"])
    .index("by_accountId", ["accountId"]),

  callTranscriptSegments: defineTable({
    orgId: v.id("organizations"),
    callId: v.id("callRecordings"),
    segmentIndex: v.number(),
    speaker: v.optional(v.string()),
    speakerRole: v.union(
      v.literal("rep"),
      v.literal("customer"),
      v.literal("unknown"),
    ),
    text: v.string(),
    startSeconds: v.optional(v.number()),
    endSeconds: v.optional(v.number()),
    startChar: v.optional(v.number()),
    endChar: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_callId", ["callId"])
    .index("by_callId_segmentIndex", ["callId", "segmentIndex"]),

  callInsights: defineTable({
    orgId: v.id("organizations"),
    callId: v.id("callRecordings"),
    segmentId: v.optional(v.id("callTranscriptSegments")),
    type: v.union(
      v.literal("pain_point"),
      v.literal("objection"),
      v.literal("competitor_mention"),
      v.literal("next_step"),
      v.literal("feature_request"),
      v.literal("pricing"),
      v.literal("decision_criteria"),
      v.literal("risk"),
      v.literal("coaching_moment"),
    ),
    title: v.string(),
    text: v.string(),
    evidence: v.string(),
    speaker: v.optional(v.string()),
    confidence: v.number(),
    importance: v.number(),
    startChar: v.optional(v.number()),
    endChar: v.optional(v.number()),
    crmImpact: v.optional(v.any()),
    status: v.union(
      v.literal("open"),
      v.literal("reviewed"),
      v.literal("dismissed"),
      v.literal("synced"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_callId", ["callId"])
    .index("by_orgId_type", ["orgId", "type"])
    .index("by_orgId_status", ["orgId", "status"]),

  callInsightTags: defineTable({
    orgId: v.id("organizations"),
    label: v.string(),
    type: v.string(),
    prompt: v.string(),
    enabled: v.boolean(),
    sortOrder: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_enabled", ["orgId", "enabled"]),

  // Companies, people and deals a meeting or a conversation suggests adding (convex/callSuggestions.ts):
  // nothing is created until the person whose meeting it was says so.
  callSuggestions: defineTable({
    orgId: v.id("organizations"),
    /** The meeting that suggested it. Absent when an email or LinkedIn conversation did. */
    callId: v.optional(v.id("callRecordings")),
    /** The email or LinkedIn conversation that suggested it (docs/conversation-intake.md, convex/conversationExtract.ts). */
    conversationId: v.optional(v.id("conversations")),
    /** The person whose meeting it was: they review it. */
    userId: v.id("users"),
    kind: v.union(v.literal("account"), v.literal("contact"), v.literal("deal")),
    /** A domain, an email, or the call (a deal): one open suggestion per key in a workspace. */
    key: v.string(),
    status: v.union(v.literal("pending"), v.literal("created"), v.literal("dismissed")),
    values: v.object({
      name: v.optional(v.string()),
      domain: v.optional(v.string()),
      email: v.optional(v.string()),
      title: v.optional(v.string()),
      amount: v.optional(v.number()),
      closeDate: v.optional(v.string()),
      nextStep: v.optional(v.string()),
      linkedinUrl: v.optional(v.string()),
      /** A person's employer as research found it (their `domain` is its domain). */
      companyName: v.optional(v.string()),
    }),
    evidence: v.optional(v.string()),
    /** Who a person on personal email is, from public sources (lib/calls/whoIs.ts): found with its quote, or not. */
    research: v.optional(v.object({
      status: v.union(v.literal("found"), v.literal("not_found")),
      at: v.number(),
      quote: v.optional(v.string()),
      sourceUrl: v.optional(v.string()),
    })),
    /** What accepting it made or matched: a register id, or a deal's stream. */
    recordId: v.optional(v.string()),
    /** A deal's missing company or person (convex/dealGaps.ts): the deal's stream it is for. */
    dealId: v.optional(v.string()),
    /** The CRM record a deal's proposal links when it already exists (register id). */
    matchId: v.optional(v.string()),
    /** Where a deal's proposal came from: the CRM, a conversation or meeting (callId or conversationId), or a search. */
    via: v.optional(v.union(v.literal("crm"), v.literal("email"), v.literal("linkedin"), v.literal("call"), v.literal("search"))),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_orgId_and_userId_and_status", ["orgId", "userId", "status"])
    .index("by_orgId_and_dealId_and_status", ["orgId", "dealId", "status"])
    .index("by_orgId_and_kind_and_key", ["orgId", "kind", "key"])
    .index("by_callId", ["callId"])
    .index("by_conversationId", ["conversationId"]),

  // ── Patch Plans / Approvals ─────────────────────────────────

  patchPlans: defineTable({
    orgId: v.id("organizations"),
    createdBy: v.id("users"),
    verb: v.union(v.literal("set"), v.literal("do"), v.literal("parse")),
    operation: v.string(),
    args: v.any(),
    reason: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("pending_approval"),
      v.literal("approved"),
      v.literal("applied"),
      v.literal("rejected"),
      v.literal("cancelled"),
      v.literal("failed"),
    ),
    riskLevel: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    approvalRequirement: v.union(v.literal("not_required"), v.literal("required")),
    createdAt: v.number(),
    updatedAt: v.number(),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    appliedBy: v.optional(v.id("users")),
    appliedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    // Package PatchPlan JSON used by package applyPatchPlan. Bounded/capped to
    // the persisted review rows; clients get a stripped public projection.
    document: v.optional(v.any()),
    truncatedOperations: v.optional(v.boolean()),
    totalOperationCount: v.optional(v.number()),
    storedOperationCount: v.optional(v.number()),
    // Bounded package PatchPlanRun summary returned by applyPatchPlan.
    runRecord: v.optional(v.any()),
    // Values selected during review for requires_human_* placeholders.
    valueOverrides: v.optional(v.any()),
    // Immutable mirror metadata for plans created by a paired OSS CLI.
    source: v.optional(v.union(v.literal("hosted"), v.literal("cli"))),
    externalPlanId: v.optional(v.string()),
    documentSha256: v.optional(v.string()),
    externalRevision: v.optional(v.number()),
    cliTokenId: v.optional(v.id("cliTokens")),
    executionAuthority: v.optional(v.union(v.literal("hosted"), v.literal("cli"))),
    approvedOperationIds: v.optional(v.array(v.string())),
    // Execution is capability-based. Either replica may claim an approved
    // plan; the durable claim prevents two online replicas from writing at
    // the same time. Claims clear on completion/failure or an explicit,
    // audited recovery; provider idempotency remains the offline safety net.
    applyClaim: v.optional(v.object({
      id: v.string(),
      replica: v.union(v.literal("hosted"), v.literal("cli")),
      claimedAt: v.number(),
      expiresAt: v.number(),
      cliTokenId: v.optional(v.id("cliTokens")),
    })),
    lastExecutionReplica: v.optional(v.union(v.literal("hosted"), v.literal("cli"))),
    // The verified agent that proposed this batch (convex/agents.ts). Only a
    // server-minted attribution sets it; createdBy stays the accountable human.
    agentId: v.optional(v.id("agents")),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_status", ["orgId", "status"])
    .index("by_orgId_operation", ["orgId", "operation"])
    .index("by_orgId_externalPlanId", ["orgId", "externalPlanId"])
    .index("by_agentId_and_createdAt", ["agentId", "createdAt"]),

  patchOperations: defineTable({
    orgId: v.id("organizations"),
    patchPlanId: v.id("patchPlans"),
    objectType: v.string(),
    objectId: v.optional(v.string()),
    fieldOrAction: v.string(),
    beforeValue: v.any(),
    afterValue: v.any(),
    reason: v.optional(v.string()),
    sourceRuleOrPolicy: v.optional(v.string()),
    riskLevel: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
    approvalRequirement: v.union(v.literal("not_required"), v.literal("required")),
    rollback: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("applied"), v.literal("failed"), v.literal("skipped"), v.literal("conflict")),
    error: v.optional(v.string()),
    // Package PatchPlan operation id. Approved rows select these ids at apply
    // time; arbitrary document operations are never auto-approved.
    packageOpId: v.optional(v.string()),
    // Deterministic package suggestion for requires_human_* placeholders.
    suggestion: v.optional(v.any()),
    // Per-op connector outcome written back at apply time (e.g. the created
    // CRM record id, or the resolve-first skip detail).
    providerData: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_patchPlanId", ["patchPlanId"]),

  approvalRequests: defineTable({
    orgId: v.id("organizations"),
    patchPlanId: v.id("patchPlans"),
    requestedBy: v.id("users"),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected"), v.literal("cancelled")),
    reason: v.optional(v.string()),
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_patchPlanId", ["patchPlanId"])
    .index("by_orgId_status", ["orgId", "status"]),

  operationAuditLog: defineTable({
    orgId: v.id("organizations"),
    userId: v.optional(v.id("users")),
    patchPlanId: v.optional(v.id("patchPlans")),
    verb: v.string(),
    operation: v.string(),
    status: v.union(v.literal("previewed"), v.literal("approved"), v.literal("applied"), v.literal("rejected"), v.literal("failed"), v.literal("approval_revoked")),
    details: v.any(),
    createdAt: v.number(),
    // The agent this row concerns: its plan's agent, or the agent a lifecycle change (owner, pause) acted on.
    agentId: v.optional(v.id("agents")),
  })
    .index("by_orgId", ["orgId"])
    .index("by_patchPlanId", ["patchPlanId"])
    .index("by_agentId_and_createdAt", ["agentId", "createdAt"]),

  // ── GTM Planning (Phase 2) ───────────────────────────────────

  gtmPlans: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    fiscalYear: v.string(),
    quarter: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("archived"),
    ),
    objectives: v.optional(v.array(v.any())),
    keyResults: v.optional(v.array(v.any())),
    initiatives: v.optional(v.array(v.any())),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_status", ["orgId", "status"]),

  // ── Budget Management (Phase 2) ──────────────────────────────

  budgets: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    fiscalYear: v.string(),
    department: v.union(
      v.literal("sales"),
      v.literal("marketing"),
      v.literal("revops"),
      v.literal("cs"),
      v.literal("other"),
    ),
    totalBudget: v.number(),
    allocations: v.optional(v.array(v.any())),
    status: v.union(
      v.literal("draft"),
      v.literal("approved"),
      v.literal("active"),
    ),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"]),

  budgetLineItems: defineTable({
    budgetId: v.id("budgets"),
    orgId: v.id("organizations"),
    category: v.string(),
    subcategory: v.optional(v.string()),
    plannedAmount: v.number(),
    actualAmount: v.number(),
    period: v.string(),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_budgetId", ["budgetId"])
    .index("by_orgId", ["orgId"]),

  // ── Headcount Planning (Phase 2) ─────────────────────────────

  headcountReqs: defineTable({
    orgId: v.id("organizations"),
    title: v.string(),
    department: v.string(),
    role: v.string(),
    hiringManagerId: v.optional(v.id("users")),
    targetStartDate: v.optional(v.string()),
    status: v.union(
      v.literal("planned"),
      v.literal("approved"),
      v.literal("open"),
      v.literal("interviewing"),
      v.literal("offer"),
      v.literal("filled"),
      v.literal("cancelled"),
    ),
    ote: v.optional(v.number()),
    baseSalary: v.optional(v.number()),
    rampMonths: v.optional(v.number()),
    territoryId: v.optional(v.id("territories")),
    notes: v.optional(v.string()),
    filledByUserId: v.optional(v.id("users")),
    filledAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_status", ["orgId", "status"]),

  // ── ICP Scoring (Phase 2) ────────────────────────────────────

  icpProfiles: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    attributes: v.array(
      v.object({
        field: v.string(),
        operator: v.string(),
        value: v.any(),
        weight: v.number(),
      }),
    ),
    isDefault: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  icpScores: defineTable({
    orgId: v.id("organizations"),
    accountId: v.id("crmAccounts"),
    profileId: v.id("icpProfiles"),
    score: v.number(),
    breakdown: v.optional(v.any()),
    calculatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_accountId", ["accountId"])
    // One-read existing-score lookup for the batched scorer (account × profile).
    .index("by_accountId_profileId", ["accountId", "profileId"])
    .index("by_orgId_score", ["orgId", "score"]),

  // Each ICP weight set the workspace scored with, immutable (docs/signal-ledger.md, SL4). The record
  // service holds only the active one, to score in SQL; this keeps every version for fit as of a date.
  icpVersions: defineTable({
    orgId: v.id("organizations"),
    version: v.number(),
    acceptedAt: v.number(),
    weights: icpVersionWeightsValidator,
    // Saved ICPs as gates (record service 1.14.0): with them, fit is each account's rank inside the ICPs it passes.
    gates: v.optional(v.array(icpGateValidator)),
  }).index("by_orgId_and_version", ["orgId", "version"]),

  fitReconciliations: defineTable({
    orgId: v.id("organizations"),
    revision: v.number(),
    acknowledgedRevision: v.number(),
    acknowledgedVersion: v.optional(v.number()),
    generation: v.number(),
    queued: v.boolean(),
    pending: v.optional(v.object({ revision: v.number(), version: v.number() })),
    fallbackWeights: v.optional(icpVersionWeightsValidator),
  }).index("by_orgId", ["orgId"]),

  // Saved ICPs (convex/icps.ts): several per workspace, each a market, a persona and exclusions. The
  // active ones together set fit scoring (an icpVersions row each time it changes); the default one
  // starts the Add records form.
  icps: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    spec: icpSpecValidator,
    active: v.boolean(),
    isDefault: v.boolean(),
    source: v.union(v.literal("manual"), v.literal("research"), v.literal("website"), v.literal("recipe")),
    recipe: v.optional(provenanceValidator),
    sourceDomain: v.optional(v.string()),
    // What the seller believes about this buyer's problem, in a sentence or two (docs/deal-prep-loop.md). Deal drafts for
    // an account in this ICP open from it; without one they make no claim of their own.
    pointOfView: v.optional(v.string()),
    // The one free thing a first touch to this buyer may offer (a sample, a check, a worked example). Drafts never
    // offer anything else, so they can't promise what the seller doesn't have.
    offer: v.optional(v.string()),
    // The last outside-TAM check (icpFills.ts): the ICP's market vs the TAM's share of it, and the fill it
    // started, if any. `key` is the criteria checked (lib/icpGap.ts gapKey), so the same ones aren't refilled.
    gapCheck: v.optional(icpGapCheckValidator),    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // Segments and personas under a saved ICP (convex/icpTree.ts, docs/icp-tree.md). A segment narrows its parent's
  // accounts, a persona is the people to reach at them. Each stores its query line (lib/icpQuery.ts); they are counted,
  // not scored: fit and icpIds stay the ICP's own.
  icpNodes: defineTable({
    orgId: v.id("organizations"),
    icpId: v.id("icps"),
    // The segment it sits under; none when it sits directly under the ICP. Personas have no children.
    parentId: v.optional(v.id("icpNodes")),
    kind: v.union(v.literal("segment"), v.literal("persona")),
    name: v.string(),
    query: v.string(),
    // A persona's part in the deal, in the seller's words ("Champion", "Economic buyer").
    role: v.optional(v.string()),
    pointOfView: v.optional(v.string()),
    offer: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]).index("by_icpId", ["icpId"]),

  // ── Performance Scorecards (Phase 2) ─────────────────────────

  scorecardConfigs: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    role: v.string(),
    metrics: v.array(
      v.object({
        name: v.string(),
        source: v.string(),
        weight: v.number(),
        target: v.number(),
      }),
    ),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  scorecardResults: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    configId: v.id("scorecardConfigs"),
    period: v.string(),
    scores: v.any(),
    overallScore: v.number(),
    rank: v.optional(v.number()),
    calculatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_userId", ["userId"])
    .index("by_configId_period", ["configId", "period"]),

  // ── Account Research & Enrichment (Phase 3) ──────────────────

  accountEnrichments: defineTable({
    orgId: v.id("organizations"),
    accountId: v.id("crmAccounts"),
    source: v.union(
      v.literal("manual"),
      v.literal("ai"),
      v.literal("api"),
    ),
    firmographics: v.optional(
      v.object({
        founded: v.optional(v.string()),
        headquarters: v.optional(v.string()),
        employeeRange: v.optional(v.string()),
        revenueRange: v.optional(v.string()),
        fundingStage: v.optional(v.string()),
        totalFunding: v.optional(v.number()),
      }),
    ),
    techStack: v.optional(v.array(v.string())),
    signals: v.optional(
      v.array(
        v.object({
          type: v.string(),
          title: v.string(),
          summary: v.optional(v.string()),
          url: v.optional(v.string()),
          detectedAt: v.number(),
        }),
      ),
    ),
    lastEnrichedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_accountId", ["accountId"]),

  // ── Competitive Intelligence (Phase 3) ───────────────────────

  competitors: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    website: v.optional(v.string()),
    description: v.optional(v.string()),
    strengths: v.optional(v.array(v.string())),
    weaknesses: v.optional(v.array(v.string())),
    positioning: v.optional(v.string()),
    pricingNotes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["orgId"] }),

  battlecards: defineTable({
    orgId: v.id("organizations"),
    competitorId: v.id("competitors"),
    title: v.string(),
    category: v.union(
      v.literal("overview"),
      v.literal("objection_handling"),
      v.literal("feature_comparison"),
      v.literal("pricing"),
      v.literal("talk_track"),
      v.literal("landmine"),
    ),
    content: v.string(),
    isActive: v.boolean(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_competitorId", ["competitorId"])
    .index("by_orgId", ["orgId"]),

  winLossRecords: defineTable({
    orgId: v.id("organizations"),
    dealId: v.id("deals"),
    outcome: v.union(v.literal("won"), v.literal("lost")),
    competitorId: v.optional(v.id("competitors")),
    primaryReason: v.optional(v.string()),
    reasons: v.optional(v.array(v.string())),
    notes: v.optional(v.string()),
    recordedBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_competitorId", ["competitorId"])
    .index("by_dealId", ["dealId"]),

  // ── Lead Scoring & Routing (Phase 3) ─────────────────────────

  leadScoringModels: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    rules: v.array(
      v.object({
        field: v.string(),
        operator: v.string(),
        value: v.any(),
        points: v.number(),
      }),
    ),
    thresholds: v.object({
      hot: v.number(),
      warm: v.number(),
      cold: v.number(),
    }),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  leadScores: defineTable({
    orgId: v.id("organizations"),
    contactId: v.id("crmContacts"),
    modelId: v.id("leadScoringModels"),
    score: v.number(),
    grade: v.union(
      v.literal("hot"),
      v.literal("warm"),
      v.literal("cold"),
    ),
    breakdown: v.optional(v.any()),
    calculatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_contactId", ["contactId"])
    // One-read existing-score lookup for the batched scorer (contact × model).
    .index("by_contactId_modelId", ["contactId", "modelId"])
    .index("by_orgId_grade", ["orgId", "grade"]),

  routingRules: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    method: v.union(
      v.literal("round_robin"),
      v.literal("weighted"),
      v.literal("territory_based"),
      v.literal("skill_based"),
    ),
    assignees: v.array(
      v.object({
        userId: v.id("users"),
        weight: v.optional(v.number()),
      }),
    ),
    criteria: v.optional(v.any()),
    slaMinutes: v.optional(v.number()),
    isActive: v.boolean(),
    lastAssignedIndex: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // ── ABM / Target Accounts (Phase 3) ──────────────────────────

  abmLists: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    tier: v.union(
      v.literal("tier_1"),
      v.literal("tier_2"),
      v.literal("tier_3"),
    ),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("archived"),
    ),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_tier", ["orgId", "tier"]),

  abmListAccounts: defineTable({
    listId: v.id("abmLists"),
    orgId: v.id("organizations"),
    accountId: v.id("crmAccounts"),
    engagementScore: v.optional(v.number()),
    ownerId: v.optional(v.id("users")),
    status: v.union(
      v.literal("target"),
      v.literal("engaged"),
      v.literal("opportunity"),
      v.literal("customer"),
      v.literal("churned"),
    ),
    notes: v.optional(v.string()),
    addedAt: v.number(),
  })
    .index("by_listId", ["listId"])
    .index("by_accountId", ["accountId"])
    .index("by_orgId", ["orgId"]),

  abmPlays: defineTable({
    orgId: v.id("organizations"),
    listId: v.id("abmLists"),
    name: v.string(),
    description: v.optional(v.string()),
    steps: v.array(
      v.object({
        order: v.number(),
        channel: v.string(),
        action: v.string(),
        owner: v.optional(v.string()),
        daysAfterStart: v.number(),
      }),
    ),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_listId", ["listId"])
    .index("by_orgId", ["orgId"]),

  // ── Marketing Attribution (Phase 3) ──────────────────────────

  campaigns: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    channel: v.union(
      v.literal("paid_search"),
      v.literal("paid_social"),
      v.literal("organic_search"),
      v.literal("organic_social"),
      v.literal("email"),
      v.literal("events"),
      v.literal("webinar"),
      v.literal("referral"),
      v.literal("direct"),
      v.literal("content"),
      v.literal("partner"),
      v.literal("other"),
    ),
    status: v.union(
      v.literal("planned"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("completed"),
    ),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    budget: v.optional(v.number()),
    spend: v.optional(v.number()),
    crmCampaignId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_channel", ["orgId", "channel"]),

  touchpoints: defineTable({
    orgId: v.id("organizations"),
    campaignId: v.id("campaigns"),
    contactId: v.optional(v.id("crmContacts")),
    accountId: v.optional(v.id("crmAccounts")),
    dealId: v.optional(v.id("deals")),
    touchType: v.union(
      v.literal("first_touch"),
      v.literal("lead_creation"),
      v.literal("opportunity_creation"),
      v.literal("mid_funnel"),
      v.literal("closed_won"),
    ),
    channel: v.string(),
    occurredAt: v.number(),
    revenue: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_campaignId", ["campaignId"])
    .index("by_dealId", ["dealId"]),

  // ── Sales Playbooks (Phase 3) ────────────────────────────────

  playbooks: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    stage: v.optional(v.string()),
    dealType: v.optional(v.string()),
    isActive: v.boolean(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"]),

  playbookSections: defineTable({
    playbookId: v.id("playbooks"),
    orgId: v.id("organizations"),
    title: v.string(),
    type: v.union(
      v.literal("talk_track"),
      v.literal("objection_handling"),
      v.literal("discovery_questions"),
      v.literal("demo_script"),
      v.literal("email_template"),
      v.literal("checklist"),
      v.literal("reference"),
    ),
    content: v.string(),
    orderIndex: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_playbookId", ["playbookId"])
    .index("by_orgId", ["orgId"]),

  // ── Customer Health & Expansion (Phase 4) ────────────────────

  customerHealthConfigs: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    signals: v.array(
      v.object({
        name: v.string(),
        source: v.string(),
        weight: v.number(),
        goodThreshold: v.number(),
        badThreshold: v.number(),
      }),
    ),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  customerHealthScores: defineTable({
    orgId: v.id("organizations"),
    accountId: v.id("crmAccounts"),
    configId: v.id("customerHealthConfigs"),
    overallScore: v.number(),
    health: v.union(
      v.literal("healthy"),
      v.literal("at_risk"),
      v.literal("churning"),
    ),
    signalBreakdown: v.optional(v.any()),
    arrAmount: v.optional(v.number()),
    renewalDate: v.optional(v.string()),
    expansionPotential: v.optional(
      v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    ),
    lastCalculatedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_accountId", ["accountId"])
    .index("by_orgId_health", ["orgId", "health"]),

  // ── Onboarding & Ramp (Phase 4) ─────────────────────────────

  onboardingPlans: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    role: v.string(),
    rampMonths: v.number(),
    rampQuotaCurve: v.array(
      v.object({
        month: v.number(),
        quotaPct: v.number(),
      }),
    ),
    milestones: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        description: v.optional(v.string()),
        targetDays: v.number(),
        category: v.union(
          v.literal("training"),
          v.literal("certification"),
          v.literal("activity"),
          v.literal("revenue"),
          v.literal("other"),
        ),
      }),
    ),
    isActive: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  onboardingProgress: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    planId: v.id("onboardingPlans"),
    startDate: v.string(),
    mentorId: v.optional(v.id("users")),
    completedMilestones: v.array(
      v.object({
        milestoneId: v.string(),
        completedAt: v.number(),
      }),
    ),
    firstDealAt: v.optional(v.number()),
    currentMonth: v.number(),
    status: v.union(
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("extended"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_userId", ["userId"])
    .index("by_planId", ["planId"]),

  // ── Activity Analytics (Phase 4) ─────────────────────────────

  activityMetrics: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    period: v.string(),
    calls: v.number(),
    emails: v.number(),
    meetings: v.number(),
    demos: v.optional(v.number()),
    proposals: v.optional(v.number()),
    callsToMeeting: v.optional(v.number()),
    meetingToDemo: v.optional(v.number()),
    demoToProposal: v.optional(v.number()),
    proposalToClose: v.optional(v.number()),
    lastSyncAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_userId", ["userId"])
    .index("by_userId_period", ["userId", "period"]),

  activityBenchmarks: defineTable({
    orgId: v.id("organizations"),
    role: v.string(),
    period: v.string(),
    avgCalls: v.number(),
    avgEmails: v.number(),
    avgMeetings: v.number(),
    avgDemos: v.optional(v.number()),
    topPerformerCalls: v.optional(v.number()),
    topPerformerEmails: v.optional(v.number()),
    topPerformerMeetings: v.optional(v.number()),
    calculatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_role", ["orgId", "role"]),

  // ── Partner & Channel (Phase 4) ──────────────────────────────

  partners: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    type: v.union(
      v.literal("referral"),
      v.literal("reseller"),
      v.literal("technology"),
      v.literal("consulting"),
      v.literal("other"),
    ),
    contactName: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    website: v.optional(v.string()),
    tier: v.optional(
      v.union(v.literal("gold"), v.literal("silver"), v.literal("bronze")),
    ),
    commissionRate: v.optional(v.number()),
    status: v.union(
      v.literal("active"),
      v.literal("inactive"),
      v.literal("pending"),
    ),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_type", ["orgId", "type"]),

  partnerDeals: defineTable({
    orgId: v.id("organizations"),
    partnerId: v.id("partners"),
    dealId: v.optional(v.id("deals")),
    dealName: v.string(),
    amount: v.number(),
    stage: v.union(
      v.literal("registered"),
      v.literal("qualified"),
      v.literal("proposed"),
      v.literal("closed_won"),
      v.literal("closed_lost"),
    ),
    attribution: v.union(
      v.literal("sourced"),
      v.literal("influenced"),
      v.literal("co_sold"),
    ),
    partnerCommission: v.optional(v.number()),
    registeredAt: v.number(),
    closedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_partnerId", ["partnerId"]),

  // ── Compensation Benchmarking (Phase 4) ──────────────────────

  compBenchmarks: defineTable({
    orgId: v.id("organizations"),
    role: v.string(),
    level: v.union(
      v.literal("entry"),
      v.literal("mid"),
      v.literal("senior"),
      v.literal("lead"),
      v.literal("director"),
      v.literal("vp"),
    ),
    region: v.optional(v.string()),
    baseLow: v.number(),
    baseMid: v.number(),
    baseHigh: v.number(),
    oteLow: v.number(),
    oteMid: v.number(),
    oteHigh: v.number(),
    variablePct: v.number(),
    source: v.optional(v.string()),
    asOfDate: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_role", ["orgId", "role"]),

  compPlanAnalysis: defineTable({
    orgId: v.id("organizations"),
    planId: v.id("commissionPlans"),
    benchmarkId: v.optional(v.id("compBenchmarks")),
    competitivenessScore: v.number(),
    totalCostPerRep: v.number(),
    projectedPayout: v.number(),
    notes: v.optional(v.string()),
    calculatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_planId", ["planId"]),

  // ── CLI run observability ────────────────────────────────────
  // The CLI is the product surface; when a user has paired it (`login --via`),
  // each command optionally reports a run record here via the broker token, and
  // the dashboard renders these as a Modal-style run timeline. Counts/events are
  // free-form so new CLI verbs need no schema change.
  cliRuns: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    cliTokenId: v.id("cliTokens"),
    command: v.string(), // e.g. "enrich acquire", "audit", "apply"
    // Client-generated stable id: makes reporting idempotent (live retries and
    // `backfill runs` replays never duplicate a run).
    clientRunId: v.optional(v.string()),
    // "in_progress" = a paired CLI is live-streaming this run's heartbeats
    // (same clientRunId upserts as the final report).
    status: v.union(
      v.literal("success"),
      v.literal("partial"),
      v.literal("error"),
      v.literal("in_progress"),
    ),
    profile: v.optional(v.string()),
    cliVersion: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.number(),
    durationMs: v.number(),
    counts: v.optional(v.any()), // headline metrics: findings/created/skipped/applied/spendUsd…
    // Per-row audit detail: IDs + issue type only (no field values). Lets the
    // dashboard render a navigable findings table without copying CRM data.
    findings: v.optional(
      v.array(
        v.object({
          objectType: v.string(),
          objectId: v.string(),
          severity: v.string(),
          ruleId: v.string(),
          field: v.optional(v.string()),
          operation: v.optional(v.string()),
        }),
      ),
    ),
    // Source-CRM record-URL base (e.g. HubSpot portal record URL) for deep-links.
    crm: v.optional(v.object({ provider: v.string(), recordUrlBase: v.string() })),
    events: v.optional(
      v.array(v.object({ ts: v.number(), type: v.string(), detail: v.optional(v.string()) })),
    ),
    error: v.optional(v.string()),
    progress: v.optional(
      v.object({
        stage: v.optional(v.string()),
        stageIndex: v.optional(v.number()),
        stageCount: v.optional(v.number()),
        itemsDone: v.optional(v.number()),
        itemsTotal: v.optional(v.number()),
        note: v.optional(v.string()),
        heartbeatAt: v.number(),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_orgId_createdAt", ["orgId", "createdAt"])
    .index("by_orgId_status", ["orgId", "status"])
    .index("by_orgId_clientRunId", ["orgId", "clientRunId"]),

  // ── CRM health readings ──────────────────────────────────────
  // Periodic captures of the package's deterministic hygiene score, computed
  // in-app over synced rows (see convex/healthSnapshots.ts). One row per
  // capture; powers the Home health trend without requiring CLI runs.
  healthSnapshots: defineTable({
    orgId: v.id("organizations"),
    at: v.number(),
    score: v.number(),
    findings: v.number(),
    weightedFindings: v.number(),
    records: v.object({
      accounts: v.number(),
      contacts: v.number(),
      deals: v.number(),
      total: v.number(),
    }),
    severityCounts: v.object({
      info: v.number(),
      warning: v.number(),
      critical: v.number(),
    }),
    byObjectType: v.record(
      v.string(),
      v.object({
        records: v.number(),
        findings: v.number(),
        weightedFindings: v.number(),
        score: v.number(),
      }),
    ),
    byRule: v.record(v.string(), v.number()),
    // What triggered this reading: "sync" | "manual".
    source: v.string(),
  }).index("by_orgId_at", ["orgId", "at"]),

  crmOpportunities: defineTable({
    orgId: v.id("organizations"),
    integrationId: v.optional(v.id("integrations")),
    provider: v.string(),
    snapshotAt: v.number(),
    rule: v.string(),
    severity: v.union(v.literal("info"), v.literal("warning"), v.literal("critical")),
    objectType: v.string(),
    objectId: v.string(),
    objectLabel: v.string(),
    summary: v.string(),
    status: v.union(v.literal("open"), v.literal("planned"), v.literal("resolved"), v.literal("dismissed")),
    planId: v.optional(v.id("patchPlans")),
    truncated: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index("by_orgId_rule", ["orgId", "rule"])
    .index("by_orgId_status", ["orgId", "status"])
    .index("by_orgId_rule_status", ["orgId", "rule", "status"])
    .index("by_orgId_rule_objectId", ["orgId", "rule", "objectId"])
    .index("by_orgId_snapshotAt", ["orgId", "snapshotAt"]),

  // ── Market Map (hosted MVP of the CLI `market` layer) ────────
  // Same package engines (captureMarket / classifyMarket / computeFrontStates
  // / assessAxes) and the same verbatim-evidence gate as the CLI; storage is
  // these tables behind the package's MarketStore seam. See
  // convex/marketActions.ts for the coverage boundary vs the CLI.

  // The category config: the hosted equivalent of market.config.json.
  // Competitor and claim lists are operator-curated and small (≤ ~15
  // competitors, ≤ ~16 claims by construction), so inline arrays are safe.
  marketMaps: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    category: v.string(), // package MarketConfig.category
    // Competitor registry. The competitor's domain doubles as the package
    // vendor id in captures/classifications.
    competitors: v.array(
      v.object({
        name: v.string(),
        domain: v.string(),
        // Extra pages beyond https://<domain>/ (pricing, product pages).
        urls: v.optional(v.array(v.string())),
      }),
    ),
    anchorDomain: v.optional(v.string()),
    // Claim taxonomy (package MarketClaim[]). Empty until the first classify
    // run auto-proposes one from captured pages (marketTaxonomy engine).
    claims: v.optional(
      v.array(
        v.object({
          id: v.string(),
          capability: v.string(),
          icp: v.string(),
          pricingStructure: v.string(),
          definition: v.string(),
          terms: v.optional(v.array(v.string())),
        }),
      ),
    ),
    surfaceRule: v.optional(v.string()),
    // Strategic axes (package MarketAxis[]) — optional config, like the CLI.
    axes: v.optional(
      v.array(
        v.object({
          id: v.string(),
          label: v.string(),
          negativePole: v.string(),
          positivePole: v.string(),
          rubric: v.string(),
          status: v.optional(v.string()),
          claimScores: v.record(v.string(), v.union(v.number(), v.null())),
        }),
      ),
    ),
    primaryAxes: v.optional(v.array(v.string())),
    // Denormalized recency (patched by the run actions) so list/detail queries
    // never scan child tables to find "the latest run".
    lastCaptureAt: v.optional(v.number()),
    lastCaptureRunLabel: v.optional(v.string()),
    lastClassifyAt: v.optional(v.number()),
    lastClassifyRunLabel: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // One row per captured page per capture run — the CLI's manifest entry and
  // content-addressed text file combined. `content` (the extracted readable
  // text) is CAPPED at 50_000 chars (`contentTruncated` marks the cut), so a
  // row stays ≈50KB — far under the 1MiB/doc limit, and a 20-row page read is
  // ≈1MiB. The classifier and the evidence verifier both read THIS text, so a
  // truncated capture stays internally consistent: quotes are verified against
  // exactly what the model saw.
  marketCaptures: defineTable({
    orgId: v.id("organizations"),
    mapId: v.id("marketMaps"),
    runLabel: v.string(),
    competitorDomain: v.string(), // == package vendorId
    kind: v.union(v.literal("home"), v.literal("pricing"), v.literal("product")),
    url: v.string(),
    capturedAt: v.number(),
    httpStatus: v.union(v.number(), v.null()),
    // sha256 of the FULL extracted text (change detector + evidence chain);
    // null when the fetch failed or the page had no readable text.
    captureHash: v.union(v.string(), v.null()),
    textChars: v.number(),
    content: v.optional(v.string()),
    contentTruncated: v.optional(v.boolean()),
  })
    .index("by_mapId", ["mapId"])
    .index("by_mapId_runLabel", ["mapId", "runLabel"]),

  // One row per competitor per classify run — the CLI's append-only
  // ObservationSet split by vendor so rows stay small (≤ ~16 claims × ≤300-char
  // quotes ≈ 20KB worst case). Evidence quotes are VERBATIM spans; `verified`
  // is set only after verifyEvidenceSpans passes against the stored captures
  // (in the ConvexMarketStore append path) — an unverified quote is never
  // persisted as verified.
  marketClassifications: defineTable({
    orgId: v.id("organizations"),
    mapId: v.id("marketMaps"),
    runLabel: v.string(),
    runAt: v.number(),
    extractor: v.string(), // "llm:<provider>:<model>"
    model: v.string(),
    competitorDomain: v.string(),
    classifiedAt: v.number(),
    readings: v.array(
      v.object({
        claimId: v.string(),
        intensity: v.union(
          v.literal("loud"),
          v.literal("quiet"),
          v.literal("absent"),
          v.literal("unobservable"),
        ),
        confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
        reason: v.string(),
        evidence: v.array(
          v.object({
            quote: v.string(),
            url: v.string(),
            captureHash: v.string(),
            verified: v.boolean(),
          }),
        ),
      }),
    ),
  })
    .index("by_mapId", ["mapId"])
    .index("by_mapId_runLabel", ["mapId", "runLabel"]),

  // Run tracking + live progress heartbeat for market capture/classify.
  // integrationSyncRuns-shaped (its provider enum doesn't fit a market run,
  // hence a dedicated table) with the SAME `progress` object so the shared
  // ProgressChip/StageTimeline components render it unchanged. A classify run
  // also persists its derived views (fronts / drift / axes): the CLI
  // recomputes these on demand, but the default Convex runtime can't import
  // the node-tainted package module, so the hosted app snapshots them per run
  // in the Node action instead (see convex/marketActions.ts).
  marketRuns: defineTable({
    orgId: v.id("organizations"),
    mapId: v.id("marketMaps"),
    kind: v.union(v.literal("capture"), v.literal("classify")),
    runLabel: v.string(),
    status: v.union(v.literal("in_progress"), v.literal("success"), v.literal("error")),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    counts: v.optional(v.any()),
    error: v.optional(v.string()),
    progress: v.optional(
      v.object({
        stage: v.optional(v.string()),
        stageIndex: v.optional(v.number()),
        stageCount: v.optional(v.number()),
        itemsDone: v.optional(v.number()),
        itemsTotal: v.optional(v.number()),
        note: v.optional(v.string()),
        heartbeatAt: v.number(),
      }),
    ),
    // Derived views for classify runs (package ClaimFront[] / FrontDrift[]).
    fronts: v.optional(
      v.array(
        v.object({
          claimId: v.string(),
          state: v.string(),
          loudVendorIds: v.array(v.string()),
          quietVendorIds: v.array(v.string()),
        }),
      ),
    ),
    frontDrift: v.optional(
      v.array(v.object({ claimId: v.string(), before: v.string(), after: v.string() })),
    ),
    // Package AxesReport (pc1/pc2 loadings + vendor scores + pairings) —
    // free-form like integrationSyncRuns.counts; small by construction.
    axes: v.optional(v.any()),
  })
    .index("by_mapId", ["mapId"])
    .index("by_orgId", ["orgId"]),

  // ── Domain-first onboarding (WS3) ───────────────────────────

  // Anonymous homepage research session: domain -> ICP -> PDL TAM preview.
  // `tam` (up to TAM_IMPORT_LIMIT AccountInputs) is never returned by the
  // public `get` query; it is copied into the workspace on claim.
  researchSessions: defineTable({
    token: v.string(),
    domain: v.string(),
    status: v.union(
      v.literal("deriving"),
      v.literal("building_tam"),
      v.literal("sampling_contacts"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    companyFinding: v.optional(companyFindingValidator),
    companySummaryEdit: v.optional(v.string()),
    brief: v.optional(briefValidator),
    briefSourceId: v.optional(v.id("researchSessions")),
    briefStatus: v.optional(v.union(v.literal("pending"), v.literal("ready"), v.literal("unavailable"))),
    waitlistedAt: v.optional(v.number()),
    invitedEmail: v.optional(v.string()),
    teamShape: v.optional(teamShapeValidator),
    onboardingAnswers: v.optional(onboardingAnswersValidator),
    startingPlan: v.optional(startingPlanValidator),
    planConfirmedAt: v.optional(v.number()),
    feedback: v.optional(v.array(v.object({
      step: v.union(v.literal("offer"), v.literal("buyers"), v.literal("market"), v.literal("team"), v.literal("plan")),
      vote: v.union(v.literal("up"), v.literal("down")),
      at: v.number(),
    }))),
    events: v.optional(v.array(researchEventValidator)),
    icp: v.optional(v.any()),
    icpSource: v.optional(v.union(v.literal("llm"), v.literal("heuristic"))),
    icpNote: v.optional(v.string()),
    filter: v.optional(v.any()),
    tamTotal: v.optional(v.number()),
    segments: v.optional(
      v.array(v.object({ id: v.string(), name: v.string(), count: v.number() })),
    ),
    preview: v.optional(v.array(v.any())),
    tam: v.optional(v.array(v.any())),
    // Buyer and adjacent segments from the Jev classifier (convex/lib/segments).
    marketSegments: v.optional(marketSegmentsValidator),
    error: v.optional(v.string()),
    ipHash: v.optional(v.string()),
    cachedFromToken: v.optional(v.string()),
    claimedByOrgId: v.optional(v.id("organizations")),
    claimedByUserId: v.optional(v.id("users")),
    claimedAt: v.optional(v.number()),
    preparationKey: v.optional(v.string()),
    preparationExpiresAt: v.optional(v.number()),
    preparationStatus: v.optional(v.union(v.literal("ready"), v.literal("failed"))),
    preparedAccounts: v.optional(v.number()),
    preparationError: v.optional(v.string()),
    // Ordered once when a finding becomes available; updates never replay completion.
    completedCards: v.optional(v.array(v.string())),
    importStatus: v.optional(
      v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("failed")),
    ),
    importError: v.optional(v.string()),
    importedAccounts: v.optional(v.number()),
    contactsSampledAt: v.optional(v.number()),
    contactsSampled: v.optional(v.number()),
    contactsNote: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_domain", ["domain", "createdAt"])
    .index("by_claimedByOrgId", ["claimedByOrgId"]),

  researchWaitlist: defineTable({
    sessionId: v.id("researchSessions"),
    email: v.string(),
    role: v.optional(v.string()),
    teamSize: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_sessionId", ["sessionId"]).index("by_email", ["email"]),

  // Research that stopped instead of guessing: signup research (sessionId) or a
  // workspace deriving an ICP from a website (orgId). `message` is what the user
  // saw; `detail` is the underlying error.
  researchFailures: defineTable({
    domain: v.string(),
    stage: v.string(),
    message: v.string(),
    detail: v.string(),
    sessionId: v.optional(v.id("researchSessions")),
    orgId: v.optional(v.id("organizations")),
    createdAt: v.number(),
  }).index("by_domain", ["domain", "createdAt"]),

  // ── TAM explorer (Accounts) ─────────────────────────────────
  // AI segments: Jev questions whose answers land on accounts as traits in the
  // record service (`traits[key]`), so the treemap can group and filter by them.
  // `kind: "choice"` with `builtin: "jtbd"` is the jobs-to-be-done level.
  tamSegments: defineTable({
    orgId: v.id("organizations"),
    key: v.string(),
    kind: v.union(v.literal("noul"), v.literal("choice")),
    label: v.string(),
    // Noul: the yes/no criterion. Choice: the instruction the options answer.
    criterion: v.string(),
    options: v.optional(
      v.array(v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()) })),
    ),
    builtin: v.optional(v.literal("jtbd")),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_orgId_and_key", ["orgId", "key"]),

  // Market sizes (docs/tam-and-icps.md): the shared prospect index grouped by one dimension under a filter.
  // Global, not per workspace: company counts hold no customer data, so every customer reuses them.
  // `key` is the canonical request (marketSize.ts cacheKey); stale rows are served while they refresh.
  marketFacets: defineTable({
    key: v.string(),
    groupBy: v.string(),
    groups: v.array(v.object({ key: v.string(), count: v.number() })),
    total: v.number(),
    truncated: v.boolean(),
    source: v.literal("pdl"),
    fetchedAt: v.number(),
  }).index("by_key", ["key"]),

  // Background scoring runs over one drill-down scope. Capped per run;
  // already-scored accounts are skipped, so a re-run only pays for new ones.
  tamJobs: defineTable({
    orgId: v.id("organizations"),
    kind: v.union(v.literal("segment"), v.literal("revenue")),
    segmentKey: v.optional(v.string()),
    // `scope` replaces the untyped `filter`; runJob reads `filter` only for jobs started before it existed.
    filter: v.any(),
    scope: v.optional(filterValidator),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    cursor: v.optional(v.string()),
    // Accounts in scope, accounts this run will score (<= cap), and progress.
    inScope: v.number(),
    planned: v.number(),
    done: v.number(),
    skipped: v.number(),
    errors: v.number(),
    crmMatched: v.optional(v.number()),
    tokens: v.number(),
    error: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId_and_createdAt", ["orgId", "createdAt"]),

  // Recommended AI segments (convex/lib/tam/segmentSuggestions.ts): an LLM
  // proposes traits, Jev measures how each splits a sample of the scope.
  // `suggestions` is bounded (MAX_SUGGESTIONS).
  tamSuggestionRuns: defineTable({
    orgId: v.id("organizations"),
    filter: v.any(),
    status: v.union(
      v.literal("proposing"),
      v.literal("measuring"),
      v.literal("done"),
      v.literal("failed"),
    ),
    suggestions: v.array(
      v.object({
        label: v.string(),
        kind: v.union(v.literal("noul"), v.literal("choice")),
        criterion: v.string(),
        options: v.optional(
          v.array(v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()) })),
        ),
        rationale: v.string(),
        basis: v.array(v.string()),
        // Jev buckets on the sample: yes/no/unsure, or option keys.
        counts: v.optional(v.record(v.string(), v.number())),
        score: v.optional(v.number()),
        verdict: v.optional(v.string()),
        added: v.optional(v.boolean()),
      }),
    ),
    sampleSize: v.optional(v.number()),
    model: v.optional(v.string()),
    note: v.optional(v.string()),
    error: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId_and_createdAt", ["orgId", "createdAt"]),

  // Challenge my ICP: an LLM proposes adjacent markets outside the current TAM.
  // A claim keeps `quote`/`sourceUrl` only when the quote was found verbatim in a
  // page the agent read; claims without one are hypotheses. `state` is the
  // feedback loop: accepted and dismissed markets are not proposed again.
  // `proposals` is bounded (MAX_PROPOSALS).
  icpChallengeRuns: defineTable({
    orgId: v.id("organizations"),
    status: v.union(v.literal("proposing"), v.literal("done"), v.literal("failed")),
    proposals: v.array(
      v.object({
        name: v.string(),
        rationale: v.string(),
        industries: v.array(v.string()),
        employeeMin: v.optional(v.number()),
        employeeMax: v.optional(v.number()),
        countries: v.array(v.string()),
        risks: v.array(v.string()),
        claims: v.array(v.object({ text: v.string(), quote: v.optional(v.string()), sourceUrl: v.optional(v.string()) })),
        // Free Leadsforge search: distinct accounts found (capped at `capped`).
        size: v.optional(v.object({ accounts: v.number(), capped: v.boolean() })),
        state: v.union(v.literal("open"), v.literal("accepted"), v.literal("dismissed")),
        dismissReason: v.optional(v.string()),
      }),
    ),
    model: v.optional(v.string()),
    error: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId_and_createdAt", ["orgId", "createdAt"]),

  // Homepage text cache for Jev evidence. Public pages, shared across orgs.
  tamSiteTexts: defineTable({
    domain: v.string(),
    text: v.string(),
    fetchedAt: v.number(),
  }).index("by_domain", ["domain"]),

  // Public website facts, shared across orgs. Each extraction bounds its arrays.
  companyWebFacts: defineTable(companyWebFactsFields).index("by_domain", ["domain"]),

  emailDomainPatterns: defineTable({ domain: v.string(), pattern: v.string(), verifiedAt: v.number() }).index("by_domain", ["domain"]),
  companyPeopleRuns: defineTable({
    orgId: v.id("organizations"), userId: v.id("users"), accountId: v.string(), domain: v.string(), jobId: v.id("backgroundJobs"),
    icpId: v.optional(v.string()), status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed")),
    people: v.array(keptPerson), notes: v.array(v.string()), sourceCounts: v.record(v.string(), v.number()), spentCredits: v.number(),
    createdAt: v.number(), completedAt: v.optional(v.number()),
  }).index("by_orgId_and_accountId", ["orgId", "accountId"]),

  marketSources: defineTable({ ...sourceFactsFields, seedHits: v.number(), firstSeenAt: v.number(), lastSeenAt: v.number() })
    .index("by_key", ["key"]).index("by_seedHits", ["seedHits"]),
  marketSourceSearches: defineTable({
    orgId: v.id("organizations"), startedBy: v.id("users"), startedAt: v.number(), investigationId: v.optional(v.id("tamInvestigations")),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("refused"), v.literal("failed")), reason: v.optional(v.string()),
    seeds: v.array(sourceSeed), results: v.array(sourceMatch), calls: v.number(), costMicro: v.number(),
  }).index("by_orgId_and_startedAt", ["orgId", "startedAt"]),
  marketSourceMemberships: defineTable({ orgId: v.id("organizations"), sourceKey: v.string(), seedDomain: v.string() })
    .index("by_sourceKey_and_seedDomain", ["sourceKey", "seedDomain"])
    .index("by_orgId", ["orgId"]),

  tamInvestigations: defineTable({
    orgId: v.id("organizations"), jobId: v.id("backgroundJobs"), icpId: v.string(), trigger: v.union(v.literal("manual"), v.literal("signup")), status: investigationStatus,
    freeOnly: v.optional(v.boolean()), searchId: v.optional(v.id("marketSourceSearches")),
    plan: v.object({ sources: v.array(planSource) }), estimateCredits: v.number(), capCredits: v.number(), spentCredits: v.number(),
    counts: v.object({ found: v.number(), duplicates: v.number(), rejected: v.number(), kept: v.number() }),
    events: v.array(v.object({ at: v.number(), stage: v.string(), message: v.string() })),
    progress: v.object({ phase: v.union(v.literal("source"), v.literal("dedupe"), v.literal("websites")), step: v.number(), sourceIndex: v.number(), page: v.number(), cursor: v.optional(v.string()) }),
    reservation: v.optional(v.object({ ref: v.string(), remaining: v.number() })),
    createdBy: v.id("users"), createdAt: v.number(), updatedAt: v.number(),
  }).index("by_orgId_and_createdAt", ["orgId", "createdAt"]).index("by_jobId", ["jobId"]),
  tamCandidates: defineTable({
    investigationId: v.id("tamInvestigations"), orgId: v.id("organizations"), ...candidateFields,
    state: v.union(v.literal("found"), v.literal("duplicate"), v.literal("rejected"), v.literal("kept")), reason: v.optional(v.string()),
  }).index("by_investigationId_and_state", ["investigationId", "state"])
    .index("by_investigationId_and_keys_domain", ["investigationId", "keys.domain"])
    .index("by_investigationId_and_keys_linkedin", ["investigationId", "keys.linkedin"])
    .index("by_investigationId_and_keys_nameAddress", ["investigationId", "keys.nameAddress"])
    .index("by_investigationId_and_keys_placeId", ["investigationId", "keys.placeId"])
    .index("by_investigationId_and_keys_registryId", ["investigationId", "keys.registryId"])
    .index("by_orgId_and_keys_domain_and_state", ["orgId", "keys.domain", "state"]),

  webPeopleSuppressions: defineTable({
    domain: v.string(),
    nameKey: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  }).index("by_domain_and_nameKey", ["domain", "nameKey"]),
  companyWebFactReads: defineTable({
    domain: v.string(),
    startedAt: v.number(),
  }).index("by_domain", ["domain"]),

  // ── Research agents (AI fields) ─────────────────────────────
  // An org-owned agent identity (docs/org-agents.md): one accountable owner.
  // Whether it may act is derived from the owner at act time
  // (convex/lib/agents/standing.ts); `pause` latches a stop until a person
  // clears it. Agents are archived, never deleted: facts and plans point at them.
  agents: defineTable({
    orgId: v.id("organizations"),
    // Unique per org and immutable.
    slug: v.string(),
    label: v.string(),
    kind: v.union(v.literal("hosted"), v.literal("external")),
    ownerUserId: v.id("users"),
    // Its namespace in fact sourceRefs. Immutable and never reused. A field's
    // agent uses `research:<fieldSlug>`, the pre-agent actor string, so
    // existing sourceRefs (the proposal dedupe key) stay byte-identical.
    ledgerKey: v.string(),
    // `by` absent means the system paused it (its owner stopped being eligible).
    pause: v.optional(v.object({
      reason: v.union(...PAUSE_REASON_KEYS.map((k) => v.literal(k))),
      at: v.number(),
      by: v.optional(v.id("users")),
    })),
    archivedAt: v.optional(v.number()),
    // An event agent (convex/agentTurns.ts): the AI fields a turn answers, and its budget
    // (lib/agents/webhook.ts AgentBudget). Absent on an AI field's own agent.
    fieldSlugs: v.optional(v.array(v.string())),
    budget: v.optional(v.object({
      turnsPerDay: v.number(), maxRounds: v.number(), maxTokens: v.number(), maxSeconds: v.number(),
    })),
    // An event agent's routing (lib/agents/routing.ts): when a finished turn's answers meet `rule`
    // (absent: every finished turn), the event's contact, if the workspace has one with that email,
    // is added to `audienceId`. An internal list; pushing the audience out stays manual.
    route: v.optional(v.object({
      audienceId: v.id("audiences"),
      rule: v.optional(v.object({ fieldSlug: v.string(), op: v.union(v.literal("equals"), v.literal("contains")), value: v.string() })),
    })),
    // A CRM event that also wakes the agent; `toStage` limits it to deals entering that stage.
    crmTrigger: v.optional(v.object({ event: v.literal("deal.stage_changed"), toStage: v.optional(v.string()) })),
    // Slack message when a turn ends (lib/agents/slack.ts); absent: off. The org's webhook is an `integrations` row.
    slack: v.optional(v.object({ mode: v.union(v.literal("all"), v.literal("qualified"), v.literal("failures")) })),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId_and_slug", ["orgId", "slug"])
    .index("by_orgId_and_ledgerKey", ["orgId", "ledgerKey"])
    .index("by_ownerUserId", ["ownerUserId"]),

  // An event agent's webhook signing secret, encrypted at rest (lib/tokenHelpers). Only the
  // webhook route decrypts it; people see it once, when they rotate it.
  agentWebhooks: defineTable({
    orgId: v.id("organizations"),
    agentId: v.id("agents"),
    secret: v.string(),
    rotatedBy: v.id("users"),
    rotatedAt: v.number(),
  }).index("by_agentId", ["agentId"]),

  // A record webhook (CP16b): an admin's URL that is told when a record changes. `secret` is encrypted
  // at rest like agentWebhooks'. `cursors` is the last ledger `seq` this endpoint has been given per
  // shard ("0".."15"): fan-out enqueues deliveries and advances it in one transaction, so no entry is
  // enqueued twice or missed. An empty `objects` means every object.
  recordWebhookEndpoints: defineTable({
    orgId: v.id("organizations"),
    url: v.string(),
    description: v.optional(v.string()),
    objects: v.array(v.string()),
    events: v.array(v.string()),
    secret: v.string(),
    enabled: v.boolean(),
    cursors: v.record(v.string(), v.number()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_enabled", ["enabled"]),

  // One event for one endpoint: the exact body sent, its state and its retries. `status` pending means
  // still to send (at `nextAttemptAt`, which is also a running attempt's lease). A finished row's
  // `nextAttemptAt` is when it finished, for the purge.
  recordWebhookDeliveries: defineTable({
    orgId: v.id("organizations"),
    endpointId: v.id("recordWebhookEndpoints"),
    shard: v.number(),
    seq: v.number(),
    event: v.string(),
    object: v.string(),
    payload: v.string(),
    status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed")),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    lastStatusCode: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_endpointId_and_createdAt", ["endpointId", "createdAt"])
    .index("by_status_and_nextAttemptAt", ["status", "nextAttemptAt"]),

  // An automation rule (CP17, convex/automations.ts): when a record of `object` changes as `trigger`
  // says and passes `conditions` (the list views' filters), run `actions` in order, as `createdBy`.
  // It acts on entries after `startSeqs` (per shard, the ledger heads when it was created or resumed)
  // observed since `activeSince`. `rotation` is each round-robin action's next index, by action index.
  automationRules: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    object: v.string(),
    trigger: automation.triggerValidator,
    conditions: v.array(automation.conditionValidator),
    actions: v.array(automation.actionValidator),
    status: v.union(v.literal("active"), v.literal("paused")),
    pausedReason: v.optional(v.string()),
    createdBy: v.id("users"),
    activeSince: v.number(),
    startSeqs: v.record(v.string(), v.number()),
    rotation: v.optional(v.record(v.string(), v.number())),
    // A scheduled rule (trigger kind "schedule"): when its next slot is due, and the slot being
    // worked through (`cursor`: where the list of matching records continues; `count`: runs made).
    // The sweep starts a due slot and resends one whose lease ran out.
    nextSlotAt: v.optional(v.number()),
    slotRun: v.optional(v.object({ slot: v.number(), cursor: v.union(v.string(), v.null()), count: v.number(), done: v.boolean(), leaseUntil: v.number(), note: v.optional(v.string()) })),
    recipe: v.optional(provenanceValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId_and_status", ["orgId", "status"])
    .index("by_status", ["status"])
    .index("by_status_and_nextSlotAt", ["status", "nextSlotAt"]),

  // Where an org's rules have read the ledger to: the last `seq` per shard ("0".."15"). The fan-out
  // creates runs and moves it in one transaction, so an entry starts each rule at most once.
  automationCursors: defineTable({
    orgId: v.id("organizations"),
    cursors: v.record(v.string(), v.number()),
  }).index("by_orgId", ["orgId"]),

  // One trigger of one rule (its ledger entry is `shard`.`seq`): whether the record met the
  // conditions, and each action's outcome. `status` pending or running means steps remain;
  // `leaseUntil` is when a running executor is presumed dead and the sweep sends it again.
  automationRuns: defineTable({
    orgId: v.id("organizations"),
    ruleId: v.id("automationRules"),
    shard: v.number(),
    seq: v.number(),
    streamId: v.id("canonEntities"),
    object: v.string(),
    title: v.string(),
    event: v.string(),
    change: v.optional(v.object({ field: v.string(), from: objectValidators.fieldValue, to: objectValidators.fieldValue })),
    matched: v.boolean(),
    status: v.union(v.literal("skipped"), v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("failed")),
    reason: v.optional(v.string()),
    depth: v.number(),
    /** When the triggering change was saved (its entry's observedAt): the run log shows how long the actions took to land. */
    triggeredAt: v.optional(v.number()),
    steps: v.array(automation.stepValidator),
    /** The rule's actions when it was triggered: a later edit of the rule does not change what this run does. */
    actions: v.optional(v.array(automation.actionValidator)),
    /** A scheduled rule's run: the slot it belongs to (then `shard` is -1 and `seq` the slot). One run per (rule, slot, record). */
    slot: v.optional(v.number()),
    leaseUntil: v.number(),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_ruleId_and_createdAt", ["ruleId", "createdAt"])
    .index("by_ruleId_and_slot_and_streamId", ["ruleId", "slot", "streamId"])
    .index("by_status_and_leaseUntil", ["status", "leaseUntil"]),

  // One wake-up of an agent (docs/org-agents.md "Turn engine"): its trigger, whether it ran
  // or why it was skipped, the account it resolved, what it proposed and what it spent.
  // `admitted` turns count against the agent's turns-per-day budget.
  agentTurns: defineTable({
    orgId: v.id("organizations"),
    agentId: v.id("agents"),
    trigger: v.union(v.literal("webhook"), v.literal("test"), v.literal("crm_event")),
    // Idempotency: the sender's event id or the body's hash (one turn per key).
    eventKey: v.string(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("skipped"), v.literal("failed")),
    admitted: v.boolean(),
    skip: v.optional(v.object({ reason: v.string(), message: v.string() })),
    payload: v.string(),
    subject: v.object({ domain: v.optional(v.string()), email: v.optional(v.string()) }),
    account: v.optional(v.object({ recordId: v.string(), entityId: v.id("canonEntities"), name: v.string(), domain: v.string() })),
    // One per AI field asked (bounded by the agent's fieldSlugs).
    outputs: v.array(v.object({
      fieldSlug: v.string(),
      label: v.string(),
      status: v.string(),
      value: v.optional(v.union(v.string(), v.number(), v.boolean())),
      factId: v.optional(v.id("facts")),
      reason: v.optional(v.string()),
      // The standing grant that approved this answer (agentGrants), when one did.
      grantId: v.optional(v.id("agentGrants")),
    })),
    patchPlanId: v.optional(v.id("patchPlans")),
    spend: v.object({ modelCalls: v.number(), tokens: v.number(), pagesRead: v.number(), ms: v.number() }),
    budgetHit: v.optional(v.union(v.literal("tokens"), v.literal("time"))),
    error: v.optional(v.string()),
    // A test run's starter; webhook turns have none.
    triggeredBy: v.optional(v.id("users")),
    // One turn runs at a time per agent: a queued turn waits until it is dispatched.
    dispatchedAt: v.optional(v.number()),
    // What the agent's route did with the event's contact after the turn (lib/agents/routing.ts).
    routing: v.optional(v.object({
      status: v.string(), message: v.string(), audienceId: v.optional(v.id("audiences")), contactId: v.optional(v.string()),
    })),
    // Best-effort Slack delivery (convex/agentSlack.ts); never holds the webhook URL.
    slack: v.optional(v.object({
      status: v.union(v.literal("sending"), v.literal("sent"), v.literal("failed")),
      httpStatus: v.optional(v.number()), error: v.optional(v.string()), at: v.number(),
    })),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_agentId_and_eventKey", ["agentId", "eventKey"])
    .index("by_agentId_and_status_and_createdAt", ["agentId", "status", "createdAt"])
    .index("by_agentId_and_createdAt", ["agentId", "createdAt"])
    .index("by_agentId_and_admitted_and_createdAt", ["agentId", "admitted", "createdAt"]),

  // A standing write grant (lib/agents/grants.ts): an admin's advance approval for one agent to
  // set one AI field. `signature` is HMAC-SHA256 over the exact terms; a grant that doesn't
  // verify, has expired or was revoked approves nothing. Revoked grants are kept for the record.
  agentGrants: defineTable({
    orgId: v.id("organizations"),
    agentId: v.id("agents"),
    operation: v.literal("set_field"),
    entityType: v.union(v.literal("account"), v.literal("contact")),
    attribute: v.string(),
    allowedValues: v.optional(v.array(v.string())),
    maxPerDay: v.optional(v.number()),
    expiresAt: v.number(),
    signature: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    revokedBy: v.optional(v.id("users")),
  }).index("by_agentId", ["agentId"]),

  // One proposal batch approved under a grant: the plan's hash and the digest binding it to the
  // grant's signature. Its facts are decided `grant:<grantId>`; `factCount` feeds the daily cap.
  agentGrantApprovals: defineTable({
    orgId: v.id("organizations"),
    grantId: v.id("agentGrants"),
    agentId: v.id("agents"),
    patchPlanId: v.id("patchPlans"),
    turnId: v.optional(v.id("agentTurns")),
    planHash: v.string(),
    digest: v.string(),
    factCount: v.number(),
    at: v.number(),
  })
    .index("by_grantId_and_at", ["grantId", "at"])
    .index("by_patchPlanId", ["patchPlanId"]),

  // An org-defined question about accounts. A run reads each account's site,
  // and every answer becomes a proposed fact on `custom.<slug>` with a quote
  // that appears word for word in a saved page (convex/lib/research).
  researchAgents: defineTable({
    orgId: v.id("organizations"),
    slug: v.string(),
    label: v.string(),
    // Account: the question is answered from the company's site. Contact: per person, from the company's
    // site and the person's profile page. A contact run's scope (ids or a resolved view filter) is in `researchRuns.filter`.
    entityType: v.union(v.literal("account"), v.literal("contact")),
    kind: v.union(v.literal("classify"), v.literal("qa")),
    question: v.string(),
    options: v.optional(
      v.array(v.object({ key: v.string(), label: v.string(), description: v.optional(v.string()) })),
    ),
    answerType: v.optional(v.union(v.literal("text"), v.literal("number"), v.literal("boolean"))),
    // A judgment no page states outright (lib/research/agentLoop.ts AgentSpec.judgment): answered as a cited inference.
    judgment: v.optional(v.boolean()),
    // Mirrors this field's canonAutoAcceptRules row (agent_run source); unset = review every answer.
    autoAcceptMinConfidence: v.optional(v.number()),
    // The agent that runs this field. Linked lazily (convex/agents.ts:ensureFieldAgent); required after backfill.
    agentId: v.optional(v.id("agents")),
    // Scheduled refresh (convex/researchAgents.ts:startDueRefreshes): absent = off. A due field re-asks
    // answers older than the cadence on the agent owner's ChatGPT plan. `refreshHold` says why the last due
    // check did not run (agent paused, owner not connected); the next check clears it.
    refreshCadence: v.optional(v.union(v.literal("weekly"), v.literal("monthly"))),
    refreshNextAt: v.optional(v.number()),
    refreshHold: v.optional(v.object({ message: v.string(), at: v.number() })),
    // When the question last changed (a recipe setting edit). Facts and attempts from before it answered the old
    // question: they are not shown and do not stop a run from asking again.
    questionSince: v.optional(v.number()),
    // The recipe field it was made from (recipes/fields.ts): its recipe, the version, and its slug as the key. Absent
    // for a field someone made, and for a people field made before fields were a recipe point until a recipe adopts it.
    recipe: v.optional(provenanceValidator),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId_and_slug", ["orgId", "slug"])
    .index("by_refreshNextAt", ["refreshNextAt"]),

  // Bounded, demo-only comparison journal. The chosen runtime stores Pi state in DO SQLite.
  piPrototypeLeases: defineTable({
    key: v.string(), holder: v.string(), epoch: v.number(), expiresAt: v.number(), seq: v.number(), nextId: v.number(),
  }).index("by_key", ["key"]),

  piPrototypeCommits: defineTable({
    key: v.string(), seq: v.number(), writes: v.string(),
  }).index("by_key_and_seq", ["key", "seq"]),

  piResearchSteps: defineTable({
    runId: v.id("researchRuns"),
    index: v.number(),
    record: v.optional(v.object({ recordId: v.string(), entityId: v.id("canonEntities"), label: v.string(), subjectJson: v.string(), specJson: v.string() })),
    nextCursor: v.union(v.string(), v.null()),
    skipped: v.number(),
    finished: v.boolean(),
    createdAt: v.number(),
    landed: v.optional(v.object({ finished: v.boolean(), completed: v.number() })),
  }).index("by_runId_and_index", ["runId", "index"]),

  piResearchEffects: defineTable({
    stepId: v.id("piResearchSteps"),
    key: v.string(),
    operation: v.union(v.literal("read"), v.literal("search"), v.literal("model")),
    request: v.string(),
    response: v.optional(v.string()),
    model: v.optional(v.string()),
  }).index("by_stepId_and_key", ["stepId", "key"]),

  // One manual run of an agent over a TAM scope. Capped; re-run to continue
  // (accounts that already have a fact for the field are skipped).
  researchRuns: defineTable({
    orgId: v.id("organizations"),
    agentId: v.id("researchAgents"),
    // `scope` replaces the untyped `filter`, read through runScopeOf until old runs are backfilled. A refresh has neither.
    filter: v.any(),
    scope: v.optional(runScopeValidator),
    runtime: v.optional(v.literal("pi")),
    piStep: v.optional(v.number()),
    piFixture: v.optional(v.literal("account-text")),
    piFixtureOrigin: v.optional(v.string()),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed"), v.literal("cancelled")),
    inScope: v.number(),
    planned: v.number(),
    done: v.number(),
    skipped: v.number(),
    answered: v.number(),
    unknown: v.number(),
    noEvidence: v.number(),
    // Records with no quoted answer whose answer Jev inferred from what was read (classify and yes/no fields).
    inferred: v.optional(v.number()),
    errors: v.number(),
    pagesRead: v.number(),
    llmCalls: v.number(),
    // Superseded by researchTraces; old runs still carry it. Narrow away once none is read.
    misses: v.optional(v.array(v.object({ domain: v.string(), status: v.string(), reason: v.string() }))),
    // Why the run watch (lib/research/watch.ts) stopped this run early; its status is then "cancelled".
    // Also why it stopped at its credit cap ("cap", status "done") or for the workspace's balance ("credits").
    watch: v.optional(v.object({ rule: v.union(v.literal("failing"), v.literal("no_answers"), v.literal("cap"), v.literal("credits")), message: v.string() })),
    // Credits (CR4, docs/credits.md): the most this run may spend, set when it starts (absent: a scheduled
    // refresh, bounded by the balance alone), and what its pages have spent, in micro-credits.
    capMicro: v.optional(v.number()),
    spentMicro: v.optional(v.number()),
    // Started without a ChatGPT plan: it runs on Canon's research model (lib/canonModel.ts) and spends credits.
    onCredits: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    error: v.optional(v.string()),
    // A scheduled refresh (createdBy is the agent's owner, who pays): it re-asks answers last observed
    // before `staleBefore` instead of walking a TAM scope.
    // A probe (lib/research/probe.ts) researches `sample`: a random PROBE_SIZE of the records a run of
    // its scope would touch, each with its outcome once researched.
    trigger: v.optional(v.union(v.literal("refresh"), v.literal("probe"))),
    staleBefore: v.optional(v.number()),
    sample: v.optional(v.array(v.object({
      recordId: v.string(),
      entityId: v.id("canonEntities"),
      label: v.string(),
      ...outcomeFields,
      status: v.optional(outcomeFields.status),
    }))),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orgId_and_createdAt", ["orgId", "createdAt"])
    .index("by_agentId_and_createdAt", ["agentId", "createdAt"]),

  // Every page a research run read: the evidence its quotes are checked
  // against. A new row only when the text changed.
  researchPages: defineTable({
    orgId: v.id("organizations"),
    url: v.string(),
    text: v.string(),
    fetchedAt: v.number(),
  }).index("by_orgId_and_url", ["orgId", "url"]),

  // How a run researched each record, in order: the pages it read, its searches and the model's
  // choices, with what it came to (lib/research/agentLoop.ts TraceStep). Kept for a timed-out record too.
  researchTraces: defineTable({
    orgId: v.id("organizations"),
    runId: v.id("researchRuns"),
    ...traceValidator.fields,
    at: v.number(),
  }).index("by_runId", ["runId"]),

  // Accounts a field researched without an answer, so later runs move on to others.
  researchAttempts: defineTable({
    orgId: v.id("organizations"),
    agentId: v.id("researchAgents"),
    entityId: v.id("canonEntities"),
    attemptedAt: v.number(),
  }).index("by_agentId_and_entityId", ["agentId", "entityId"]),

  // Scheduled signal checks (convex/signals.ts): one row per org. `nextRunAt` is set only while the daily
  // check is on (the cron's index); `run` is the current or last run, so an admin can see where it stands.
  signalWatch: defineTable({
    orgId: v.id("organizations"),
    nextRunAt: v.optional(v.number()),
    run: v.optional(v.object({
      status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
      trigger: v.union(v.literal("schedule"), v.literal("manual")),
      checked: v.number(),
      withBoard: v.number(),
      newSignals: v.number(),
      cursor: v.optional(v.string()),
      error: v.optional(v.string()),
      startedAt: v.number(),
      updatedAt: v.number(),
    })),
  })
    .index("by_orgId", ["orgId"])
    .index("by_nextRunAt", ["nextRunAt"]),

  // The public job board found for an account's domain, or the fact that none was (`source` absent),
  // so later runs do not probe again until the miss is old.
  signalBoards: defineTable({
    orgId: v.id("organizations"),
    domain: v.string(),
    source: v.optional(v.union(v.literal("greenhouse"), v.literal("lever"), v.literal("ashby"))),
    token: v.optional(v.string()),
    checkedAt: v.number(),
  }).index("by_orgId_and_domain", ["orgId", "domain"]),

  // One detected change at one account (engine/src/signals.ts shape): `quote` is verbatim source text and
  // `sourceUrl` points at it. `source` is the job board, or "website" for the site, blog and social buckets.
  // Keyed by (org, domain, trigger) so a re-run updates instead of duplicating.
  accountSignals: defineTable({
    orgId: v.id("organizations"),
    domain: v.string(),
    bucket: v.union(v.literal("job"), v.literal("site"), v.literal("blog"), v.literal("social")),
    trigger: v.string(),
    quote: v.string(),
    sourceUrl: v.string(),
    source: v.string(),
    reposted: v.optional(v.boolean()),
    // When it happened (a role's posting date) if the source says; else when Canon first saw it.
    observedAt: v.number(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
  }).index("by_orgId_and_domain_and_trigger", ["orgId", "domain", "trigger"]),

  // Dated facts Canon saw and could not fetch again (docs/signal-ledger.md), never rewritten or deleted
  // except by erasing a contact, which replaces its bodies in place.
  // A sibling of ledgerEntries: it asserts no field value. `seq` is gap-free per (org, shard), the shard
  // being a hash of the subject, for the record service's projector.
  observations: defineTable({
    orgId: v.id("organizations"),
    subject: observations.subjectValidator,
    observedAt: v.number(),
    occurredAt: v.optional(v.number()),
    source: objectValidators.entrySource,
    body: observations.observationBodyValidator,
    shard: v.number(),
    seq: v.number(),
  })
    .index("by_orgId_subjectDomain_observedAt", ["orgId", "subject.domain", "observedAt"])
    .index("by_orgId_subjectDomain_bodyKey", ["orgId", "subject.domain", "body.key"])
    .index("by_orgId_subjectContactId_bodyKey", ["orgId", "subject.contactId", "body.key"])
    // A person's log by time: a module's touch read (observations.forPeople) keeps the newest when one is long.
    .index("by_orgId_subjectContactId_observedAt", ["orgId", "subject.contactId", "observedAt"])
    .index("by_orgId_shard_seq", ["orgId", "shard", "seq"]),

  // The last observation `seq` issued per (org, shard), bumped in the appending transaction.
  observationHeads: defineTable({
    orgId: v.id("organizations"),
    shard: v.number(),
    seq: v.number(),
  }).index("by_orgId_shard", ["orgId", "shard"]),

  // ── CanonCRM fact ledger (docs/canoncrm-spec.md, P0: opportunities) ──
  // Append-only facts; canonical values are resolved by policy into
  // canonFieldState and projected onto the existing `deals` rows.
  facts: defineTable({
    orgId: v.id("organizations"),
    entityType: v.union(v.literal("opportunity"), v.literal("account"), v.literal("contact")),
    entityId: v.id("canonEntities"),
    attribute: v.string(),
    value: objectValidators.factValue,
    sourceKind: v.union(
      v.literal("user"), v.literal("salesforce"), v.literal("hubspot"), v.literal("import"),
      v.literal("call"), v.literal("email"), v.literal("linkedin"), v.literal("enrichment"), v.literal("pipeline"), v.literal("agent_run"), v.literal("canon_field"),
    ),
    sourceRef: v.string(),
    actor: v.object({ kind: v.union(v.literal("integration"), v.literal("agent"), v.literal("user")), id: v.string() }),
    evidence: v.optional(v.string()),
    confidence: v.number(),
    // Transaction time (when Canon learned it) and valid time (when it was true).
    observedAt: v.number(),
    validFrom: v.optional(v.number()),
    validTo: v.optional(v.number()),
    lastConfirmedAt: v.number(),
    status: v.union(v.literal("proposed"), v.literal("accepted"), v.literal("rejected"), v.literal("superseded")),
    // `decider` replaces the prefixed `decidedBy` string; writers set both until old rows are backfilled.
    decidedBy: v.optional(v.string()),
    decider: v.optional(deciderValidator),
    decidedAt: v.optional(v.number()),
    patchPlanId: v.optional(v.id("patchPlans")),
    // P1 write gate: the independent check of a proposed fact against its
    // evidence (Jev), which an auto-accept rule requires. `kind` "read": an AI
    // field's inferred answer, scored by Jev's own read of the record instead.
    verification: v.optional(v.object({ score: v.number(), model: v.string(), checkedAt: v.number(), kind: v.optional(v.union(v.literal("evidence"), v.literal("read"))) })),
    // A deal proposal's copy in the deal's object-layer ledger stream.
    ledgerFactId: v.optional(v.string()),
  })
    .index("by_entity_attribute_observedAt", ["entityId", "attribute", "observedAt"])
    .index("by_orgId_status", ["orgId", "status"])
    .index("by_orgId_sourceRef_observedAt", ["orgId", "sourceRef", "observedAt"])
    .index("by_patchPlanId", ["patchPlanId"])
    .index("by_orgId", ["orgId"])
    // A research field's answers across accounts.
    .index("by_orgId_attribute_observedAt", ["orgId", "attribute", "observedAt"]),

  // P1 write gate: org overrides of the default source field ownership
  // (convex/lib/canon/gate.ts). One row per (sourceKind, attribute) cell.
  canonFieldOwnership: defineTable({
    orgId: v.id("organizations"),
    sourceKind: v.union(
      v.literal("user"), v.literal("salesforce"), v.literal("hubspot"), v.literal("import"),
      v.literal("call"), v.literal("email"), v.literal("linkedin"), v.literal("enrichment"), v.literal("pipeline"), v.literal("agent_run"), v.literal("canon_field"),
    ),
    // Absent means a deal field (rules predate accounts and contacts).
    entityType: v.optional(v.union(v.literal("opportunity"), v.literal("account"), v.literal("contact"))),
    attribute: v.string(),
    allowed: v.boolean(),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"]),

  // P1 write gate: per (sourceKind, attribute) auto-accept above a verified
  // confidence. None by default.
  canonAutoAcceptRules: defineTable({
    orgId: v.id("organizations"),
    sourceKind: v.union(
      v.literal("user"), v.literal("salesforce"), v.literal("hubspot"), v.literal("import"),
      v.literal("call"), v.literal("email"), v.literal("linkedin"), v.literal("enrichment"), v.literal("pipeline"), v.literal("agent_run"), v.literal("canon_field"),
    ),
    // Absent means a deal field (rules predate accounts and contacts).
    entityType: v.optional(v.union(v.literal("opportunity"), v.literal("account"), v.literal("contact"))),
    attribute: v.string(),
    minConfidence: v.number(),
    enabled: v.boolean(),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  })
    .index("by_orgId", ["orgId"]),

  // Stable identity independent of providers; merges set mergedInto (reversible).
  // Accounts and contacts are linked by domain / email / CRM / record-service
  // ids in canonExternalIds; `recordAccounts`/`recordContacts` are TAM rows in
  // the record service, so their display name is kept in `label`.
  canonEntities: defineTable({
    orgId: v.id("organizations"),
    // Object-layer records (convex/objects.ts) use their registry object name
    // and project to `recordRows`, with projectionId the entity's own id.
    entityType: v.union(
      v.literal("opportunity"), v.literal("account"), v.literal("contact"),
      v.literal("lead"), v.literal("task"), v.literal("note"), v.literal("call"), v.literal("meeting"), v.literal("product"),
      // An edge stream (CP3, lib/objects/associations.ts).
      v.literal("association"),
      // An org's own object (CP7d): its apiName, `custom_<slug>`.
      v.string(),
    ),
    projectionTable: v.union(
      v.literal("deals"), v.literal("crmAccounts"), v.literal("crmContacts"),
      v.literal("recordAccounts"), v.literal("recordContacts"), v.literal("recordRows"),
    ),
    projectionId: v.string(),
    label: v.optional(v.string()),
    mergedInto: v.optional(v.id("canonEntities")),
    createdAt: v.number(),
  })
    .index("by_orgId_projectionId", ["orgId", "projectionId"])
    .index("by_orgId", ["orgId"]),

  // Provider ids for an entity (a table, not an array, so lookups are indexed).
  canonExternalIds: defineTable({
    orgId: v.id("organizations"),
    entityId: v.id("canonEntities"),
    provider: v.string(),
    externalId: v.string(),
  })
    .index("by_orgId_provider_externalId", ["orgId", "provider", "externalId"])
    .index("by_entityId", ["entityId"])
    .index("by_orgId", ["orgId"]),

  // A merge of duplicate companies or people (CP15a, lib/canon/partyMerge.ts): its survivor, the records
  // merged into it, and what undoing it needs. The ledger entries are the record; this is their undo.
  recordMerges: defineTable({
    orgId: v.id("organizations"),
    /** Names the merge in the entries it wrote (`absorb`, `revert`) and in the picked values' source. */
    mergeId: v.string(),
    object: v.union(v.literal("account"), v.literal("contact")),
    survivorStream: v.id("canonEntities"),
    survivorId: v.string(),
    losers: v.array(v.object({ stream: v.id("canonEntities"), recordId: v.string(), title: v.string() })),
    /** MergeUndo as JSON: bounded by MERGE_RECORDS_MAX records and MERGE_EDGES_MAX edges. */
    undo: v.string(),
    mergedBy: v.id("users"),
    mergedAt: v.number(),
    undoneBy: v.optional(v.id("users")),
    undoneAt: v.optional(v.number()),
  })
    .index("by_orgId_and_mergeId", ["orgId", "mergeId"])
    .index("by_orgId_and_survivorStream", ["orgId", "survivorStream"]),

  // A pair of companies or people someone marked "not duplicates" (CP15b): the duplicates view never offers
  // the pair again. `a` and `b` are record ids with a < b, so a pair has one row whichever order it was seen in.
  duplicateDismissals: defineTable({
    orgId: v.id("organizations"),
    object: v.union(v.literal("account"), v.literal("contact")),
    a: v.string(),
    b: v.string(),
    dismissedBy: v.id("users"),
    dismissedAt: v.number(),
  })
    .index("by_orgId_object_pair", ["orgId", "object", "a", "b"]),

  // Resolved state per (entity, attribute): the projection's receipts.
  canonFieldState: defineTable({
    orgId: v.id("organizations"),
    entityId: v.id("canonEntities"),
    attribute: v.string(),
    value: objectValidators.factValue,
    factId: v.union(v.id("facts"), v.null()),
    sourceKind: v.union(v.string(), v.null()),
    state: v.union(v.literal("resolved"), v.literal("contested"), v.literal("empty")),
    contestedBy: v.optional(v.array(v.id("facts"))),
    updatedAt: v.number(),
  })
    .index("by_entityId_attribute", ["entityId", "attribute"])
    .index("by_orgId_state", ["orgId", "state"])
    .index("by_orgId", ["orgId"]),

  // Shadow outbound projection (P0): what Canon would push to a connected CRM
  // when its canonical value differs from the provider's. Nothing is sent.
  // A CRM sync's `facts` mirror writes for companies, people and deals, queued off the sync's transactions
  // (convex/canon.ts drainPartyMirror): the stream is written at once, `facts` and `canonFieldState` follow.
  partyMirrorQueue: defineTable({
    orgId: v.id("organizations"),
    streamId: v.id("canonEntities"),
    // lib/canon/streamLedger.ts MirrorJob.
    job: v.any(),
    // Failed runs so far; it goes to partyMirrorFailures after a few.
    attempts: v.optional(v.number()),
  })
    .index("by_orgId", ["orgId"])
    .index("by_streamId", ["streamId"]),

  // Party mirror jobs that kept failing, kept for a repair instead of dropped.
  partyMirrorFailures: defineTable({
    orgId: v.id("organizations"),
    streamId: v.id("canonEntities"),
    job: v.any(),
    error: v.string(),
    attempts: v.number(),
    failedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // An org whose party mirror queue has a drain scheduled, so each sync transaction schedules at most one.
  partyMirrorDrains: defineTable({
    orgId: v.id("organizations"),
    scheduledAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  canonOutboundShadow: defineTable({
    orgId: v.id("organizations"),
    entityId: v.id("canonEntities"),
    provider: v.string(),
    attribute: v.string(),
    providerValue: objectValidators.factValue,
    canonicalValue: objectValidators.factValue,
    factId: v.union(v.id("facts"), v.null()),
    updatedAt: v.number(),
  })
    .index("by_entityId_provider_attribute", ["entityId", "provider", "attribute"])
    .index("by_orgId", ["orgId"]),

  // Object layer (docs/cp0-object-layer.md). An org's extension of a standard
  // object: its custom fields and its own picklist options (e.g. deal stages).
  objectDefs: defineTable({
    orgId: v.id("organizations"),
    apiName: v.string(),
    registryVersion: v.number(),
    // Set on the row of an object the org defined itself (CP7d): apiName is then `custom_<slug>`.
    object: v.optional(objectValidators.customObjectMeta),
    customFields: v.array(objectValidators.customField),
    picklistOptions: v.optional(v.record(v.string(), v.array(objectValidators.picklistOption))),
    // A standard object's own name in the org (People called Contacts).
    labels: v.optional(objectValidators.objectLabels),
    updatedAt: v.number(),
  }).index("by_orgId_apiName", ["orgId", "apiName"]),

  // The ledger: one entry per changeset, the only state that cannot be
  // recomputed. `seq` is gap-free per (org, shard) and is the projector's
  // cursor. Two indexes only: each index costs write throughput.
  ledgerEntries: defineTable({
    orgId: v.id("organizations"),
    streamId: v.id("canonEntities"),
    object: v.string(),
    shard: v.number(),
    seq: v.number(),
    version: v.number(),
    observedAt: v.number(),
    source: objectValidators.entrySource,
    actor: objectValidators.entryActor,
    body: objectValidators.entryBody,
    redactedAt: v.optional(v.number()),
  })
    .index("by_streamId_version", ["streamId", "version"])
    .index("by_orgId_shard_seq", ["orgId", "shard", "seq"])
    // One object's history across the org, oldest first: stage history reads every deal entry (convex/stageHistory.ts).
    .index("by_orgId_object_observedAt", ["orgId", "object", "observedAt"]),

  // The last `seq` issued per (org, shard). Saves bump it in the same
  // transaction, so concurrent saves on one shard serialize.
  ledgerShardHeads: defineTable({
    orgId: v.id("organizations"),
    shard: v.number(),
    seq: v.number(),
  }).index("by_orgId_shard", ["orgId", "shard"]),

  // Each deal as it stood over time (P1a, convex/dealHistory.ts): one row per ledger version, folded from the deal's
  // stream in shard order, valid from `validFrom` until `validTo` (MAX_TIME while current). Disposable: it can be
  // rebuilt from the ledger. Module reads `deals.asOf` and `deals.changesBetween` read it.
  dealVersions: defineTable({
    orgId: v.id("organizations"),
    dealId: v.string(),
    version: v.number(),
    validFrom: v.number(),
    validTo: v.number(),
    fields: v.object({
      name: v.union(v.string(), v.null()), amount: v.union(v.number(), v.null()), currency: v.union(v.string(), v.null()),
      closeDate: v.union(v.string(), v.null()), stage: v.union(v.string(), v.null()), forecastCategory: v.union(v.string(), v.null()),
      probability: v.union(v.number(), v.null()), isClosed: v.boolean(), isWon: v.boolean(), ownerId: v.union(v.string(), v.null()),
      companyId: v.union(v.string(), v.null()), dealType: v.union(v.string(), v.null()), archived: v.boolean(),
    }),
  })
    .index("by_orgId_validTo", ["orgId", "validTo"])
    .index("by_dealId_validFrom", ["dealId", "validFrom"]),

  // How far dealVersions has folded each (org, shard) of the ledger, and when it first caught up (`builtAt`, shard -1).
  dealVersionCursors: defineTable({
    orgId: v.id("organizations"),
    shard: v.number(),
    seq: v.number(),
    builtAt: v.optional(v.number()),
  }).index("by_orgId_shard", ["orgId", "shard"]),

  // A record's hot row: its fold state and projection, written with its
  // ledger entry. Disposable: it can be rebuilt from the stream.
  recordRows: defineTable({
    orgId: v.id("organizations"),
    streamId: v.id("canonEntities"),
    object: v.string(),
    version: v.number(),
    registryVersion: v.number(),
    title: v.string(),
    values: v.record(v.string(), objectValidators.fieldValue),
    meta: v.record(v.string(), objectValidators.fieldMeta),
    lifecycle: objectValidators.lifecycle,
    fields: v.record(v.string(), objectValidators.fieldFold),
    watermarks: v.optional(v.array(objectValidators.watermark)),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastReadAt: v.number(),
    parentStreamId: v.optional(v.id("canonEntities")),
  }).index("by_orgId_streamId", ["orgId", "streamId"])
    .index("by_orgId_object_parentStreamId_lifecycleStatus", ["orgId", "object", "parentStreamId", "lifecycle.status"]),

  // One row per edge stream (CP3, lib/objects/associations.ts): the edge as its
  // stream projects it, written with each of its entries, so a record's edges are
  // one index range. Disposable like recordRows: it can be rebuilt from the streams.
  // Ends are register ids for accounts and contacts.
  associations: defineTable({
    orgId: v.id("organizations"),
    association: v.string(),
    fromId: v.string(),
    toId: v.string(),
    streamId: v.id("canonEntities"),
    label: v.union(v.string(), v.null()),
    primary: v.boolean(),
    // Canon's reason, when a person accepted its suggestion (a deal's Executive or N-1).
    reason: v.optional(v.union(v.string(), v.null())),
    active: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_orgId_association_fromId_toId", ["orgId", "association", "fromId", "toId"])
    .index("by_orgId_association_toId", ["orgId", "association", "toId"])
    .index("by_streamId", ["streamId"]),

  // Proposals awaiting review, kept in step with the ledger by each save.
  proposalQueue: defineTable({
    orgId: v.id("organizations"),
    streamId: v.id("canonEntities"),
    object: v.string(),
    fieldId: v.string(),
    factId: v.string(),
    observedAt: v.number(),
  })
    .index("by_orgId_observedAt", ["orgId", "observedAt"])
    .index("by_orgId_factId", ["orgId", "factId"]),

  // A list view's saved filters, sort, columns and layout for one object.
  // Private to its creator unless `shared`, which shows it to the whole org.
  savedViews: defineTable({
    orgId: v.id("organizations"),
    object: v.string(),
    name: v.string(),
    createdBy: v.id("users"),
    shared: v.boolean(),
    spec: objectValidators.viewSpec,
    updatedAt: v.number(),
  })
    .index("by_orgId_object_createdBy", ["orgId", "object", "createdBy"])
    .index("by_orgId_object_shared", ["orgId", "object", "shared"]),

  // A saved report (CP9): one object's filters, group keys, measures and chart.
  // Private to its creator unless `shared`, like a saved view.
  reports: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    createdBy: v.id("users"),
    shared: v.boolean(),
    spec: objectValidators.reportSpec,
    updatedAt: v.number(),
    /** Canon's own report, by its canon-base template key (recipes/canon-base/recipe.md). */
    builtIn: v.optional(v.string()),
    recipe: v.optional(provenanceValidator),
    /**
     * A module's report (docs/modules.md, "Reports and charts"): saved from the report component `report` of module
     * `moduleId`, over its spec's collection (`spec.object`). Only that module's page lists and runs it.
     */
    module: v.optional(v.object({ moduleId: v.string(), report: v.string() })),
  })
    .index("by_orgId_createdBy", ["orgId", "createdBy"])
    .index("by_orgId_shared", ["orgId", "shared"])
    .index("by_orgId_builtIn", ["orgId", "builtIn"]),

  // A dashboard (CP9): saved reports' charts in a grid, in order. A wide tile
  // spans the grid's two columns. Private to its creator unless `shared`.
  dashboards: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    createdBy: v.id("users"),
    shared: v.boolean(),
    tiles: v.array(v.object({ reportId: v.id("reports"), wide: v.boolean() })),
    updatedAt: v.number(),
    module: v.optional(v.string()),
    builtIn: v.optional(v.string()),
    recipe: v.optional(provenanceValidator),
  })
    .index("by_orgId_createdBy", ["orgId", "createdBy"])
    .index("by_orgId_shared", ["orgId", "shared"])
    .index("by_orgId_builtIn", ["orgId", "builtIn"])
    .index("by_orgId_module_createdBy", ["orgId", "module", "createdBy"])
    .index("by_orgId_module_shared", ["orgId", "module", "shared"]),

  // A named set of contacts for outbound (GT6): the filter of a contact view,
  // frozen when the audience was saved. Who it reached lives in audienceMembers.
  // It is its creator's until shared (docs/audiences-and-icps.md); absent `shared`
  // (audiences from before) reads as shared.
  audiences: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    filter: v.array(objectValidators.listFilter),
    viewId: v.optional(v.id("savedViews")),
    createdBy: v.id("users"),
    shared: v.optional(v.boolean()),
    createdAt: v.number(),
    lastSentAt: v.optional(v.number()),
    summary: v.optional(v.object({
      total: v.number(),
      withEmail: v.number(),
      customVariables: v.array(v.string()),
      computedAt: v.number(),
    })),
  })
    .index("by_orgId", ["orgId"])
    .index("by_orgId_and_createdBy", ["orgId", "createdBy"])
    .index("by_orgId_and_shared", ["orgId", "shared"]),

  // The membership snapshot taken at each export or push: one row per contact,
  // the target it went to ("csv" or "<sequencer>:<campaign id>", e.g. "instantly:<id>") and what happened.
  // Re-push skips emails already "sent" to the same target.
  audienceMembers: defineTable({
    orgId: v.id("organizations"),
    audienceId: v.id("audiences"),
    contactId: v.string(),
    email: v.optional(v.string()),
    target: v.string(),
    outcome: v.union(v.literal("sent"), v.literal("exported"), v.literal("skipped")),
    reason: v.optional(v.string()),
    at: v.number(),
    by: v.id("users"),
  })
    .index("by_audienceId_at", ["audienceId", "at"])
    .index("by_audienceId_target_outcome_email", ["audienceId", "target", "outcome", "email"]),

  // One row per export or push run, its counts kept as the member rows are written, so the
  // history stays whole however many contacts a run holds.
  audienceRuns: defineTable({
    orgId: v.id("organizations"),
    audienceId: v.id("audiences"),
    target: v.string(),
    at: v.number(),
    sent: v.number(),
    exported: v.number(),
    skipped: v.number(),
  })
    .index("by_audienceId_at_target", ["audienceId", "at", "target"]),

  // Contacts added to an audience one at a time, outside its filter: today by an event agent's
  // route (convex/agentTurns.ts). An audience is its filter's contacts plus these.
  audienceAdditions: defineTable({
    orgId: v.id("organizations"),
    audienceId: v.id("audiences"),
    contactId: v.string(),
    email: v.optional(v.string()),
    agentId: v.id("agents"),
    turnId: v.id("agentTurns"),
    at: v.number(),
  }).index("by_audienceId_and_contactId", ["audienceId", "contactId"]),

  // A user's LinkedIn account, connected through Unipile for invite and message
  // cadences (docs/linkedin-cadences.md). Canon keeps only Unipile's account id,
  // never a LinkedIn cookie or password. The limits module
  // (convex/lib/linkedin/limits.ts) turns these settings into today's caps.
  linkedinAccounts: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    unipileAccountId: v.string(),
    status: v.union(v.literal("ok"), v.literal("credentials"), v.literal("paused"), v.literal("disconnected")),
    statusReason: v.optional(v.string()),
    profileName: v.optional(v.string()),
    publicIdentifier: v.optional(v.string()),
    tier: v.union(v.literal("free"), v.literal("premium"), v.literal("sales_navigator")),
    connectionCount: v.optional(v.number()),
    timezone: v.string(),
    window: v.object({ days: v.array(v.number()), startMinute: v.number(), endMinute: v.number() }),
    overrides: v.object({
      invitesPerDay: v.optional(v.number()),
      invitesPerWeek: v.optional(v.number()),
      messagesPerDay: v.optional(v.number()),
      lookupsPerDay: v.optional(v.number()),
    }),
    salesNavHighVolume: v.optional(v.boolean()),
    // Warm-up step, 0 to RAMP_STEPS; advanced weekly while acceptance holds.
    rampStep: v.number(),
    rampAdvancedAt: v.number(),
    riskAcceptedAt: v.number(),
    riskTextVersion: v.string(),
    connectedAt: v.number(),
    updatedAt: v.number(),
    // Worker state (convex/linkedinWorker.ts): one run chain per sender holds the
    // lease; a hold stops sending until it passes (LinkedIn pushed back).
    leaseUntil: v.optional(v.number()),
    holdUntil: v.optional(v.number()),
    holdReason: v.optional(v.string()),
    inviteHoldUntil: v.optional(v.number()),
    // When the next invite may go: the day's invites are spread across the sending window.
    nextInviteAt: v.optional(v.number()),
    lastSyncAt: v.optional(v.number()),
    // Conversation intake (docs/conversation-intake.md, CI1): the owner's "Read my messages" consent and
    // the read's progress. A pass reads chats active since `ingestSince`, a page at a time from
    // `ingestBackfillCursor`; the first pass is the 90-day backfill, later ones the daily reconcile.
    ingest: v.optional(v.boolean()),
    ingestConsentAt: v.optional(v.number()),
    ingestTextVersion: v.optional(v.string()),
    ingestSince: v.optional(v.number()),
    ingestBackfillCursor: v.optional(v.string()),
    ingestBackfilledAt: v.optional(v.number()),
    ingestSyncedAt: v.optional(v.number()),
    ingestLeaseUntil: v.optional(v.number()),
    // The background tray's job for the 90-day backfill (backgroundJobs, kind "conversation_intake").
    ingestJobId: v.optional(v.id("backgroundJobs")),
    // Where a pass stopped inside the chats page at `ingestBackfillCursor`: `next` chats on it are done, and
    // `chat` is one whose messages are read in part, from `chat.cursor` (issue #920).
    ingestBackfillResume: v.optional(v.object({
      next: v.number(),
      chat: v.optional(v.object({ id: v.string(), providerId: v.string(), cursor: v.string() })),
    })),
  })
    .index("by_orgId", ["orgId"])
    .index("by_userId", ["userId"])
    .index("by_unipileAccountId", ["unipileAccountId"])
    .index("by_status", ["status"]),

  // A LinkedIn cadence: one invite, then up to five messages, sent from one
  // connected account (docs/linkedin-cadences.md, convex/lib/linkedin/cadence.ts).
  linkedinCadences: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    senderAccountId: v.id("linkedinAccounts"),
    steps: v.array(
      v.union(
        v.object({ kind: v.literal("invite"), note: v.optional(v.string()) }),
        v.object({ kind: v.literal("message"), body: v.string(), delayDays: v.number() }),
      ),
    ),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("archived")),
    // Skip people with no posts or comments in this many days (lib/linkedin/activity.ts). Unset: 90. 0: no check.
    activeWithinDays: v.optional(v.number()),
    recipe: v.optional(provenanceValidator),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // One contact in one cadence. `nextAt` is when the worker next acts: the
  // invite for "queued", the withdraw deadline for "invited", the next message
  // for "connected". `vars` holds only the merge fields the cadence uses.
  linkedinEnrollments: defineTable({
    orgId: v.id("organizations"),
    cadenceId: v.id("linkedinCadences"),
    senderAccountId: v.id("linkedinAccounts"),
    contactId: v.string(),
    contactName: v.string(),
    linkedinUrl: v.string(),
    publicIdentifier: v.string(),
    providerId: v.optional(v.string()),
    vars: v.record(v.string(), v.string()),
    state: v.union(
      v.literal("queued"), v.literal("invited"), v.literal("connected"), v.literal("replied"),
      v.literal("done"), v.literal("withdrawn"), v.literal("stopped"), v.literal("failed"),
    ),
    stepIndex: v.number(),
    nextAt: v.number(),
    invitationId: v.optional(v.string()),
    invitedAt: v.optional(v.number()),
    connectedAt: v.optional(v.number()),
    // When LinkedIn says the invite was accepted. `connectedAt` is when the sync noticed.
    acceptedAt: v.optional(v.number()),
    chatId: v.optional(v.string()),
    lastSentAt: v.optional(v.number()),
    attempts: v.optional(v.number()),
    reason: v.optional(v.string()),
    enrolledBy: v.id("users"),
    enrolledAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_senderAccountId_and_state_and_nextAt", ["senderAccountId", "state", "nextAt"])
    .index("by_senderAccountId_and_providerId", ["senderAccountId", "providerId"])
    .index("by_senderAccountId_and_publicIdentifier", ["senderAccountId", "publicIdentifier"])
    .index("by_orgId_and_contactId", ["orgId", "contactId"])
    .index("by_cadenceId_and_enrolledAt", ["cadenceId", "enrolledAt"]),

  // A person's latest LinkedIn post or comment, as one org's sender saw it before an invite
  // (lib/linkedin/activity.ts). Kept per org and reused for 30 days; never shared across orgs.
  linkedinActivity: defineTable({
    orgId: v.id("organizations"),
    providerId: v.string(),
    publicIdentifier: v.string(),
    lastActiveAt: v.optional(v.number()),
    checkedAt: v.number(),
  })
    .index("by_orgId_and_providerId", ["orgId", "providerId"])
    .index("by_orgId_and_publicIdentifier", ["orgId", "publicIdentifier"]),

  // Every call a sender made to LinkedIn, and every invite seen accepted:
  // caps, acceptance and the contact's LinkedIn timeline are counted from here.
  linkedinSends: defineTable({
    orgId: v.id("organizations"),
    accountId: v.id("linkedinAccounts"),
    enrollmentId: v.optional(v.id("linkedinEnrollments")),
    kind: v.union(
      v.literal("lookup"), v.literal("invite"), v.literal("message"), v.literal("withdraw"),
      v.literal("sync"), v.literal("accepted"),
    ),
    ok: v.boolean(),
    error: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_accountId_and_kind_and_at", ["accountId", "kind", "at"])
    .index("by_enrollmentId_and_at", ["enrollmentId", "at"]),

  // A rep's 1:1 conversation with someone outside the team, read from a linked account whose owner turned
  // intake on (docs/conversation-intake.md). `accountRef` is the linkedinAccounts or emailAccounts id.
  // An unmatched counterpart leaves `contactIds` empty and keeps who they are for a suggested contact (CI3).
  // A contact's conversations are found through conversationContacts (convex/conversationView.ts); its timeline
  // observations carry `linkedin:msg:<id>`, `email:msg:<id>` and `email:received:<id>` keys (an email's id is its Message-ID).
  conversations: defineTable({
    orgId: v.id("organizations"),
    ownerUserId: v.id("users"),
    channel: v.union(v.literal("email"), v.literal("linkedin")),
    accountRef: v.string(),
    externalThreadId: v.string(),
    counterpart: v.object({
      providerId: v.optional(v.string()),
      name: v.optional(v.string()),
      publicIdentifier: v.optional(v.string()),
      profileUrl: v.optional(v.string()),
      email: v.optional(v.string()),
      // An email counterpart's company domain; none for free-mail addresses (CI2).
      domain: v.optional(v.string()),
    }),
    // An email thread's subject and everyone outside the team on it (CI2), the unmatched kept for suggestions.
    subject: v.optional(v.string()),
    participants: v.optional(v.array(v.object({ email: v.string(), name: v.optional(v.string()) }))),
    contactIds: v.array(v.string()),
    lastMessageAt: v.number(),
    // Extraction (convex/conversationExtract.ts) runs once the thread has been quiet until `extractDueAt`.
    extractDueAt: v.optional(v.number()),
    /** When the last pass read the thread: messages stored after it are new to the next pass. */
    extractedAt: v.optional(v.number()),
    /** The proposals the last pass that proposed something made. */
    patchPlanId: v.optional(v.id("patchPlans")),
    /** Why the last pass read nothing (intake off, no ChatGPT plan, ...); cleared by a pass that read. */
    extractSkipped: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_accountRef_and_externalThreadId", ["accountRef", "externalThreadId"])
    // An account's conversations, most recently active first (convex/conversationsApi.ts list).
    .index("by_accountRef_and_lastMessageAt", ["accountRef", "lastMessageAt"])
    .index("by_extractDueAt", ["extractDueAt"]),

  // One message of a conversation, verbatim (capped at 50k characters). Read only through
  // lib/conversations/store.ts readableTexts, which shows the text to its owner and to roles that read their activity.
  // Each linked account keeps its own copy: an email two teammates' inboxes received is stored once per inbox.
  conversationMessages: defineTable({
    orgId: v.id("organizations"),
    conversationId: v.id("conversations"),
    externalMessageId: v.string(),
    direction: v.union(v.literal("in"), v.literal("out")),
    at: v.number(),
    from: v.string(),
    text: v.string(),
    // An email's recipients (To and Cc, comma-separated) and subject, and whether Canon sent it (CI2).
    to: v.optional(v.string()),
    subject: v.optional(v.string()),
    viaCanon: v.optional(v.boolean()),
  })
    .index("by_orgId_and_externalMessageId", ["orgId", "externalMessageId"])
    .index("by_conversationId_and_at", ["conversationId", "at"]),

  // Each contact a conversation is matched to, one row each (a conversation's `contactIds`, indexable): how a
  // person's, company's or deal's page finds its conversations (convex/conversationView.ts). Written with
  // `contactIds` (lib/conversations/store.ts linkContacts) and erased with the conversation.
  conversationContacts: defineTable({
    orgId: v.id("organizations"),
    contactId: v.string(),
    conversationId: v.id("conversations"),
  })
    .index("by_orgId_and_contactId", ["orgId", "contactId"])
    .index("by_conversationId_and_contactId", ["conversationId", "contactId"]),

  // A Gmail account a user linked through Unipile's hosted login (docs/gmail-sending.md).
  // Canon stores only Unipile's account id; only the owner sends from it.
  emailAccounts: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    unipileAccountId: v.string(),
    provider: v.literal("google"),
    address: v.string(),
    displayName: v.optional(v.string()),
    status: v.union(v.literal("ok"), v.literal("credentials"), v.literal("paused"), v.literal("disconnected")),
    statusReason: v.optional(v.string()),
    connectedAt: v.number(),
    updatedAt: v.number(),
    // Conversation intake (docs/conversation-intake.md, CI2), as on linkedinAccounts: the owner's "Read my
    // messages" consent and the read's progress through Unipile's mail list since `ingestSince`.
    ingest: v.optional(v.boolean()),
    ingestConsentAt: v.optional(v.number()),
    ingestTextVersion: v.optional(v.string()),
    ingestSince: v.optional(v.number()),
    ingestBackfillCursor: v.optional(v.string()),
    ingestBackfilledAt: v.optional(v.number()),
    ingestSyncedAt: v.optional(v.number()),
    ingestLeaseUntil: v.optional(v.number()),
    ingestJobId: v.optional(v.id("backgroundJobs")),
  })
    .index("by_orgId", ["orgId"])
    .index("by_userId", ["userId"])
    .index("by_unipileAccountId", ["unipileAccountId"])
    .index("by_status", ["status"]),

  // Every email sent from a linked account. A row is claimed ("sending") before the
  // call, so the daily cap holds under concurrent sends; the exact text is on the
  // contact's `email` observation.
  emailSends: defineTable({
    orgId: v.id("organizations"),
    accountId: v.id("emailAccounts"),
    userId: v.id("users"),
    contactId: v.string(),
    to: v.string(),
    subject: v.string(),
    state: v.union(v.literal("sending"), v.literal("sent"), v.literal("failed"), v.literal("unknown")),

    outboxAttempt: v.optional(emailSendOutboxAttempt),
    receiptRevision: v.optional(v.number()),
    error: v.optional(v.string()),
    providerId: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_accountId_and_at", ["accountId", "at"])
    .index("by_orgId_and_contactId", ["orgId", "contactId"]),

  sequenceRecipientChecks: defineTable({
    orgId: v.id("organizations"), sequenceKey: v.string(), contactId: v.string(), checkedAt: v.number(),
    fullName: v.string(), address: v.string(), emailStatus: v.string(),
    companyId: v.string(), companyName: v.string(), companyDomain: v.string(), companyOwnerId: v.optional(v.string()),
  }).index("by_orgId_and_sequenceKey_and_contactId", ["orgId", "sequenceKey", "contactId"]),

  sequenceLaunches: defineTable(sequenceLaunchFields)
    .index("by_orgId_and_moduleId_and_moduleSequenceKey", ["orgId", "moduleId", "moduleSequenceKey"])
    .index("by_orgId_and_moduleId", ["orgId", "moduleId"]),

  sequenceEnrollments: defineTable(sequenceEnrollmentFields)
    .index("by_orgId_and_moduleId_and_moduleEnrollmentKey", ["orgId", "moduleId", "moduleEnrollmentKey"])
    .index("by_orgId_and_identityKey", ["orgId", "identityKey"])
    .index("by_orgId_and_contactId_and_state", ["orgId", "contactId", "state"])
    .index("by_launchId_and_state", ["launchId", "state"]),

  outboxRequests: defineTable(outboxRequest)
    .index("by_enrollmentId_and_stepKey_and_occurrence", ["enrollmentId", "stepKey", "occurrence"])
    .index("by_launchId_and_state", ["launchId", "state"])
    .index("by_orgId_moduleId_projection_collection_projection_key", ["orgId", "moduleId", "projection.collection", "projection.key"])
    .index("by_outboundMessageId", ["outboundMessageId"]),

  mailboxSendGrants: defineTable({
    version: v.literal(1),
    orgId: v.id("organizations"),
    moduleId: v.string(),
    ownerId: v.id("users"),
    senderId: v.id("emailAccounts"),
    mailboxLinkHash: v.string(),
    template: v.union(
      v.object({ kind: v.literal("manifest"), name: v.string(), hash: v.string() }),
      v.object({ kind: v.literal("sq1.template-set.v1"), launchId: v.id("sequenceLaunches"), hash: v.string() }),
    ),
    maxPerDay: v.number(),
    expiresAt: v.number(),
    createdAt: v.number(),
    signature: v.string(),
    revokedAt: v.optional(v.number()),
    revokedBy: v.optional(v.id("users")),
  })
    .index("by_orgId_and_ownerId", ["orgId", "ownerId"])
    .index("by_orgId_and_ownerId_and_moduleId", ["orgId", "ownerId", "moduleId"]),

  // Independent suppression causes. Lifted rows are retained so legacy backfill cannot restore a lifted DNC.
  suppressions: defineTable({
    orgId: v.id("organizations"),
    kind: v.union(v.literal("email"), v.literal("domain"), v.literal("phone"), v.literal("linkedin")),
    value: v.string(),
    source: v.union(v.literal("unsubscribe"), v.literal("reply"), v.literal("bounce"), v.literal("manual"), v.literal("dnc")),
    state: v.union(v.literal("active"), v.literal("lifted")),
    reason: v.optional(v.string()), contactId: v.optional(v.string()),
    addedBy: v.optional(v.id("users")), addedAt: v.number(), updatedAt: v.number(),
    recipientProof: v.optional(v.object({ kind: v.literal("rfc8058"), tokenDigest: v.string(), issuedAt: v.number(), expiresAt: v.number() })),
    liftedBy: v.optional(v.id("users")), liftedAt: v.optional(v.number()),
    legacyId: v.optional(v.id("dialerDoNotCall")),
  })
    .index("by_orgId_and_kind_and_value_and_source", ["orgId", "kind", "value", "source"])
    .index("by_orgId_and_source_and_state", ["orgId", "source", "state"])
    .index("by_orgId_and_updatedAt", ["orgId", "updatedAt"]),

  suppressionEvents: defineTable({
    orgId: v.id("organizations"), suppressionId: v.id("suppressions"), actor: v.optional(v.id("users")),
    recipientProof: v.optional(v.object({ kind: v.literal("rfc8058"), tokenDigest: v.string(), issuedAt: v.number(), expiresAt: v.number() })),
    state: v.union(v.literal("active"), v.literal("lifted")), at: v.number(), reason: v.optional(v.string()),
  }).index("by_orgId_and_at", ["orgId", "at"]),

  suppressionMigrations: defineTable({
    orgId: v.id("organizations"), cursor: v.union(v.string(), v.null()), complete: v.boolean(), migrated: v.number(), updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // The outbox (docs/modules.md, "Outbound"): every message Canon sends for a module, or for itself (a workspace
  // email), one row per recipient. The send gate (lib/outbound/gate.ts) decides a row in the transaction that asks for
  // it and again when the dispatcher claims it; `idempotencyKey` makes a rerun find its row and write nothing.
  outboundMessages: defineTable({
    orgId: v.id("organizations"),
    // The module that sends it; absent for Canon's own workspace email.
    module: v.optional(v.string()),
    // What asked for it: the moduleEvents row of the op or transition, `call:<name>:<key>`, or Canon's own reason.
    cause: v.string(),
    // The doc that caused it, as "<collection>/<key>".
    about: v.optional(v.string()),
    template: v.optional(v.string()),
    channel: v.union(v.literal("email"), v.literal("slack"), v.literal("webhook")),
    kind: v.union(v.literal("notice"), v.literal("personal"), v.literal("automated")),
    // The member who caused it, whose row it is: the outbox shows it to them and their managers.
    fromUserId: v.optional(v.id("users")),
    to: v.union(
      v.object({ member: v.id("users") }),
      v.object({ address: v.string() }),
      v.object({ slack: v.string() }),
      v.object({ event: v.string(), endpoint: v.optional(v.id("outboundTargets")) }),
    ),
    // The recipient as one value, which rate limits count by: `slack:cs-alerts`, `webhook:<id>`, `member:<id>`.
    target: v.string(),
    rendered: v.object({ subject: v.optional(v.string()), text: v.string() }),

    mailbox: v.optional(mailboxMetadata),
    mailboxRefusal: v.optional(mailboxRefusal),
    mailboxEffectKey: v.optional(v.string()),
    state: v.union(
      v.literal("awaiting_approval"), v.literal("queued"), v.literal("held"), v.literal("sending"), v.literal("sent"),
      v.literal("failed"), v.literal("unknown"), v.literal("suppressed"), v.literal("refused"), v.literal("cancelled"),
    ),
    // The gate's words for a row it held, refused or holds for a person.
    reason: v.optional(v.string()),
    notBefore: v.number(),
    idempotencyKey: v.string(),
    approval: v.optional(v.literal("person")),
    sendNow: v.optional(v.literal(true)),
    // A notification's digest group, also kept for instant delivery so a later preference change can hold it.
    digest: v.optional(v.string()),
    attempts: v.optional(v.number()),
    claimedAt: v.optional(v.number()),
    providerId: v.optional(v.string()),
    error: v.optional(v.string()),
    decidedBy: v.optional(v.id("users")),
    at: v.number(),
  })
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_mailboxEffectKey", ["mailboxEffectKey"])
    .index("by_orgId_and_module_and_cause", ["orgId", "module", "cause"])
    .index("by_state_and_notBefore", ["state", "notBefore"])
    .index("by_orgId_and_at", ["orgId", "at"])
    .index("by_orgId_and_module_and_at", ["orgId", "module", "at"])
    .index("by_orgId_and_module_and_about_and_at", ["orgId", "module", "about", "at"])
    .index("by_orgId_and_target_and_claimedAt", ["orgId", "target", "claimedAt"])
    .index("by_orgId_and_module_and_claimedAt", ["orgId", "module", "claimedAt"])
    .index("by_digest", ["digest"]),

  // Where a workspace's module sends go, set by an admin in Settings > Outbound: a Slack channel name modules post to
  // (an incoming-webhook URL), or a webhook endpoint and the module events it receives. `url` and `secret` are
  // encrypted; neither is returned to a client, and the secret is shown once, when the endpoint is made.
  outboundTargets: defineTable({
    orgId: v.id("organizations"),
    channel: v.union(v.literal("slack"), v.literal("webhook")),
    // A Slack channel's name as modules know it (cs-alerts), or a webhook endpoint's label.
    name: v.string(),
    events: v.optional(v.array(v.string())),
    url: v.string(),
    secret: v.optional(v.string()),
    // What the list shows of the URL: its host and the end of its path.
    hint: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_orgId_and_channel_and_name", ["orgId", "channel", "name"]),

  // A module channel an admin turned on (docs/modules.md, "Outbound"): no row, the module sends nothing on it.
  outboundChannels: defineTable({
    orgId: v.id("organizations"),
    moduleId: v.string(),
    channel: v.union(v.literal("email"), v.literal("slack"), v.literal("webhook")),
    enabledBy: v.id("users"),
    enabledAt: v.number(),
  }).index("by_orgId_and_moduleId_and_channel", ["orgId", "moduleId", "channel"]),

  // A Telnyx number the workspace dials from (docs/dialer.md). A live dialing
  // session holds it, so two reps never call out from one number at once.
  dialerNumbers: defineTable({
    orgId: v.id("organizations"),
    number: v.string(),
    label: v.optional(v.string()),
    heldBySessionId: v.optional(v.id("dialerSessions")),
    addedBy: v.id("users"),
    addedAt: v.number(),
  })
    .index("by_orgId", ["orgId"])
    .index("by_number", ["number"]),

  // One rep's dialing session: a single call to the rep's own phone (the agent
  // leg) that every contact call bridges onto (lib/dialer/bridge.ts).
  dialerSessions: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    numberId: v.id("dialerNumbers"),
    from: v.string(),
    agentPhone: v.string(),
    status: v.union(v.literal("calling_agent"), v.literal("ready"), v.literal("ended"), v.literal("failed")),
    agentLegId: v.optional(v.string()),
    currentCallId: v.optional(v.id("dialerCalls")),
    error: v.optional(v.string()),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    expiresAt: v.number(),
    // Power dialing (docs/dialer.md, D3): the audience the session's queue was loaded from.
    queueAudienceId: v.optional(v.id("audiences")),
    queueName: v.optional(v.string()),
    // Where the rep hears the call: their phone (agentPhone is a number) or this browser (a SIP URI). Unset is phone.
    audio: v.optional(v.union(v.literal("phone"), v.literal("browser"))),
    // Parallel lines: the contact calls racing for the rep, until one reaches a person (at most MAX_LINES).
    race: v.optional(v.array(v.id("dialerCalls"))),
    // The call that last held the rep: the one whose outcome they confirm next.
    lastCallId: v.optional(v.id("dialerCalls")),
  })
    .index("by_userId_and_startedAt", ["userId", "startedAt"])
    .index("by_agentLegId", ["agentLegId"])
    .index("by_status_and_expiresAt", ["status", "expiresAt"]),

  // One contact dialled in a session. The recording is copied into Canon's
  // storage; the transcript goes to call intelligence (`callRecordingId`).
  dialerCalls: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    sessionId: v.id("dialerSessions"),
    contactId: v.string(),
    accountId: v.optional(v.string()),
    contactName: v.string(),
    to: v.string(),
    from: v.string(),
    legId: v.optional(v.string()),
    state: v.union(v.literal("dialing"), v.literal("ringing"), v.literal("answered"), v.literal("ended"), v.literal("failed")),
    machine: v.optional(v.boolean()),
    startedAt: v.number(),
    answeredAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    durationSeconds: v.optional(v.number()),
    hangupCause: v.optional(v.string()),
    error: v.optional(v.string()),
    outcome: v.optional(v.union(v.literal("connected"), v.literal("no_answer"), v.literal("left_voicemail"), v.literal("busy"), v.literal("wrong_number"))),
    notes: v.optional(v.string()),
    // The rep picked the outcome; until then it's the one the hangup implied.
    confirmed: v.optional(v.boolean()),
    activityStreamId: v.optional(v.id("canonEntities")),
    recordingId: v.optional(v.string()),
    recordingStorageId: v.optional(v.id("_storage")),
    transcriptStatus: v.union(v.literal("none"), v.literal("pending"), v.literal("ready"), v.literal("failed")),
    callRecordingId: v.optional(v.id("callRecordings")),
    queueItemId: v.optional(v.id("dialerQueueItems")),
    // Voicemail detection (docs/dialer.md): copied from the rep's dialer settings when the call is placed.
    detectMachine: v.optional(v.boolean()),
    voicemail: v.optional(v.string()),
    voicemailStarted: v.optional(v.boolean()),
    voicemailLeft: v.optional(v.boolean()),
    // A person answered after another line had the rep: they heard who called and were hung up.
    abandoned: v.optional(v.boolean()),
    // Compliance (docs/dialer.md): whether this call was recorded (unset is recorded), and the
    // audience a queue call came from, the "campaign" the 3% abandonment cap is measured on.
    record: v.optional(v.boolean()),
    recordingStarted: v.optional(v.boolean()),
    audienceId: v.optional(v.id("audiences")),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_legId", ["legId"])
    .index("by_orgId_and_contactId", ["orgId", "contactId"])
    .index("by_userId_and_startedAt", ["userId", "startedAt"])
    .index("by_audienceId_and_startedAt", ["audienceId", "startedAt"]),

  recordingPolicy: defineTable({
    orgId: v.id("organizations"),
    ...recordingPolicyFields,
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // The workspace's dialer policy (docs/dialer.md, compliance). No row: calls are recorded, with the notice.
  dialerSettings: defineTable({
    orgId: v.id("organizations"),
    record: v.boolean(),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  }).index("by_orgId", ["orgId"]),

  // Numbers the workspace never calls: a contact asked not to be called, or an admin added them.
  dialerDoNotCall: defineTable({
    orgId: v.id("organizations"),
    number: v.string(),
    contactId: v.optional(v.string()),
    reason: v.optional(v.string()),
    addedBy: v.id("users"),
    addedAt: v.number(),
  }).index("by_orgId_and_number", ["orgId", "number"]),

  // A rep's Telnyx telephony credential for browser audio (docs/dialer.md, D2). Canon keeps the id and
  // SIP username only; the browser signs in with a short-lived token, never a password.
  dialerCredentials: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    telnyxCredentialId: v.string(),
    sipUsername: v.string(),
    createdAt: v.number(),
  }).index("by_userId_and_orgId", ["userId", "orgId"]),

  // A rep's dialer settings: whether to detect voicemail, and the message to leave after the beep.
  dialerProfiles: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    detectVoicemail: v.boolean(),
    voicemailMessage: v.optional(v.string()),
    // How many queued contacts to dial at once (1 to MAX_LINES; unset is 1).
    parallelLines: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_userId_and_orgId", ["userId", "orgId"]),

  // A session's power-dialing queue: contacts from an audience, worked in order.
  dialerQueueItems: defineTable({
    orgId: v.id("organizations"),
    sessionId: v.id("dialerSessions"),
    position: v.number(),
    contactId: v.string(),
    contactName: v.string(),
    company: v.optional(v.string()),
    phone: v.string(),
    status: v.union(v.literal("pending"), v.literal("dialing"), v.literal("done"), v.literal("skipped")),
    callId: v.optional(v.id("dialerCalls")),
  })
    .index("by_sessionId_and_position", ["sessionId", "position"])
    .index("by_sessionId_and_status_and_position", ["sessionId", "status", "position"]),

  // Long-running work shown in the background activity tray: CRM population
  // ("contact_sweep", its original name), an inbox's or LinkedIn account's
  // 90-day read ("conversation_intake") and Granola catching up on older
  // meetings ("meeting_import"). Live CRM syncs and CLI runs come from their
  // own tables.
  backgroundJobs: defineTable({
    orgId: v.id("organizations"),
    kind: v.union(v.literal("contact_sweep"), v.literal("conversation_intake"), v.literal("meeting_import"), v.literal("deal_gaps"), v.literal("field_consolidation")),
    // Shown only to this member (reading their own messages); unset is the whole workspace's.
    userId: v.optional(v.id("users")),
    title: v.string(),
    detail: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
    href: v.string(),
    phases: v.array(v.object({
      key: v.string(),
      label: v.string(),
      status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
      count: v.optional(v.number()),
      // A bar: units done of units known so far (e.g. one provider's calls), and why it waits.
      done: v.optional(v.number()),
      total: v.optional(v.number()),
      note: v.optional(v.string()),
    })),
    startedAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    // Running totals for jobs whose parts finish in parallel (e.g. sweep batches).
    counters: v.optional(v.record(v.string(), v.number())),
  }).index("by_orgId_and_startedAt", ["orgId", "startedAt"]),

  // Which workspace uploaded a CSV for import (csvImports.ts): a file is read only by its own org.
  csvUploads: defineTable({
    orgId: v.id("organizations"),
    storageId: v.id("_storage"),
  }).index("by_storageId", ["storageId"]),

  // On-demand work-email lookups per workspace per UTC day (cost guard for
  // records.findEmail; each found email is one paid treg/Hunter lookup).
  emailLookups: defineTable({
    orgId: v.string(),
    day: v.string(),
    count: v.number(),
  }).index("by_orgId_and_day", ["orgId", "day"]),

  // Append-only ledger of metered third-party calls we pay for per workspace
  // (treg.to today). The base for usage billing: included allowance, then
  // overage at cost plus margin. `callId` joins treg's usage/by-tag ledger.
  providerCalls: defineTable({
    orgId: v.string(),
    // deepline: the workspace's own Deepline account, filed at costMicro 0 (Deepline bills the workspace).
    // scrapingbee: Canon's own account; onboarding research files it under orgId `research:<sessionId>`.
    provider: v.union(v.literal("treg"), v.literal("deepline"), v.literal("scrapingbee"), v.literal("openrouter")),
    endpoint: v.string(),
    feature: v.string(),
    callId: v.optional(v.string()),
    costMicro: v.number(),
    outcome: v.union(v.literal("hit"), v.literal("miss")),
    at: v.number(),
  }).index("by_orgId_and_at", ["orgId", "at"]),

  // Free-provider pauses shared by every population job: treg's free
  // allowances are per vendor account, not per workspace, so a capacity
  // refusal or rate limit pauses that provider for everyone until it resets.
  providerPacing: defineTable({
    provider: v.string(),
    pausedUntil: v.number(),
    /** Consecutive pause episodes without a success; the guessed wait doubles with each. */
    strikes: v.number(),
    /** Rate-limited providers: when the next call may start (pacing.nextSlot). */
    nextSlotAt: v.optional(v.number()),
    /** Daily-capped providers: the UTC day counted, and calls so far that day. */
    day: v.optional(v.string()),
    dayCount: v.optional(v.number()),
    reason: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_provider", ["provider"]),

  // Capped test runs of paid people searches (convex/providerTests.ts): a
  // sample scored against the acceptable-record bar, paid from CanonCRM's
  // monthly per-workspace allowance. Nothing from a test is written to the CRM.
  providerTests: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    provider: v.string(),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    market: v.object({ industries: v.array(v.string()), employeeBands: v.array(v.string()), countries: v.array(v.string()) }),
    persona: v.object({ levels: v.array(v.string()), departments: v.array(v.string()), titles: v.array(v.string()), countries: v.optional(v.array(v.string())) }),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    returned: v.optional(v.number()),
    acceptable: v.optional(v.number()),
    /** Acceptable rows whose title matches the persona. */
    onTarget: v.optional(v.number()),
    /** Acceptable rows whose company is already an account in the CRM. */
    known: v.optional(v.number()),
    /** People the provider's search has in all (null when it can't say): sizes a full run's estimate. */
    available: v.optional(v.number()),
    /** What treg metered, in USD millionths. */
    costMicro: v.optional(v.number()),
    sample: v.optional(v.array(v.object({
      name: v.string(),
      title: v.optional(v.string()),
      company: v.optional(v.string()),
      domain: v.optional(v.string()),
      linkedinUrl: v.optional(v.string()),
      acceptable: v.boolean(),
    }))),
    error: v.optional(v.string()),
  }).index("by_orgId_and_startedAt", ["orgId", "startedAt"]),

  // Real company names by domain, shared by every workspace: a company
  // resolved once (Crustdata, CompanyEnrich, or a source that named it) is
  // never looked up again, and one no resolver could name is skipped for a
  // while. Names only; no other firmographics.
  companyNames: defineTable({
    domain: v.string(),
    /** Absent when every resolver missed: the domain is not looked up again until the miss expires. */
    name: v.optional(v.string()),
    linkedinUrl: v.optional(v.string()),
    source: v.string(),
    updatedAt: v.number(),
  }).index("by_domain", ["domain"]),

  // Population tasks (and name-worker lineages) whose completion a job has
  // counted: a task that ran twice (a retry after a partial failure) is
  // counted once, so the job's pending total stays exact.
  populateDone: defineTable({
    jobId: v.id("backgroundJobs"),
    taskId: v.string(),
  }).index("by_jobId_and_taskId", ["jobId", "taskId"]),

  // A population job's queue of accounts whose name was guessed from the
  // domain, drained by one name worker per job (populateActions.runNames). A
  // company seen on many search pages is queued, and looked up, once.
  populateNames: defineTable({
    jobId: v.id("backgroundJobs"),
    domain: v.string(),
    resolved: v.boolean(),
    /** Resolvers that already missed this domain; it is cached as a miss only when all have. */
    tried: v.optional(v.array(v.string())),
  })
    .index("by_jobId_and_domain", ["jobId", "domain"])
    .index("by_jobId_and_resolved", ["jobId", "resolved"]),

  // A Market or Companies fill held for review (convex/staging.ts): nothing
  // reaches the CRM until a manager approves a selection of it.
  stagedRuns: defineTable({
    jobId: v.id("backgroundJobs"),
    orgId: v.id("organizations"),
    title: v.string(),
    state: v.union(
      v.literal("collecting"), v.literal("ready"), v.literal("approving"), v.literal("approved"),
      v.literal("discarding"), v.literal("discarded"),
    ),
    createdAt: v.number(),
    /** Unapproved records are dropped after this. */
    expiresAt: v.number(),
    /** The approval's own tray job and what it added. */
    approval: v.optional(v.object({
      jobId: v.id("backgroundJobs"),
      selection: v.any(),
      accounts: v.number(),
      contacts: v.number(),
      byUserId: v.id("users"),
    })),
  })
    .index("by_jobId", ["jobId"])
    .index("by_orgId_and_createdAt", ["orgId", "createdAt"])
    .index("by_state_and_expiresAt", ["state", "expiresAt"]),

  // One staged account or contact. `key` is its identity within the run
  // (domain, or lib/staging.ts contactKey); the dimension fields are its cell.
  stagedRecords: defineTable({
    jobId: v.id("backgroundJobs"),
    kind: v.union(v.literal("account"), v.literal("contact")),
    key: v.string(),
    source: v.string(),
    discoverySources: v.optional(v.array(discoverySource)),
    region: v.string(),
    industry: v.string(),
    sizeBand: v.string(),
    existing: v.boolean(),
    seniority: v.optional(v.string()),
    department: v.optional(v.string()),
    // account
    domain: v.optional(v.string()),
    name: v.optional(v.string()),
    /** The name was guessed from the domain; the name worker may replace it. */
    nameGuessed: v.optional(v.boolean()),
    employees: v.optional(v.number()),
    country: v.optional(v.string()),
    segmentIds: v.optional(v.array(v.string())),
    // contact
    accountDomain: v.optional(v.string()),
    fullName: v.optional(v.string()),
    title: v.optional(v.string()),
    email: v.optional(v.string()),
    // both
    linkedinUrl: v.optional(v.string()),
    /** Its stagedCells key, so a selection's sample reads only the cells it keeps (absent on runs staged before it existed). */
    cell: v.optional(v.string()),
  })
    .index("by_jobId_and_kind_and_key", ["jobId", "kind", "key"])
    .index("by_jobId_and_cell", ["jobId", "cell"])
    .index("by_jobId_and_accountDomain", ["jobId", "accountDomain"]),

  // A staged run's count of records per combination of dimensions (lib/staging.ts cellKey).
  stagedCells: defineTable({
    jobId: v.id("backgroundJobs"),
    cell: v.string(),
    count: v.number(),
  }).index("by_jobId_and_cell", ["jobId", "cell"]),

  // Fixed-window counters for anonymous research starts (ip / domain / global).
  researchRateLimits: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),

  // Native onboarding checklist flags (distinct from the rep-ramp
  // `onboardingProgress` table above).
  orgOnboardingSteps: defineTable({
    orgId: v.id("organizations"),
    stepId: v.string(),
    doneAt: v.number(),
  }).index("by_orgId_stepId", ["orgId", "stepId"]),

  // Dev/test stand-in for the WS1 record service, used only while
  // RECORD_SERVICE_URL is unset. `ws` is the Convex orgId string.
  fakeRecordAccounts: defineTable({
    ws: v.string(),
    recordId: v.string(),
    row: v.any(),
  }).index("by_ws_recordId", ["ws", "recordId"]),
  fakeRecordContacts: defineTable({
    ws: v.string(),
    recordId: v.string(),
    accountId: v.string(),
    row: v.any(),
  })
    .index("by_ws_recordId", ["ws", "recordId"])
    .index("by_ws_accountId", ["ws", "accountId"]),
  fakeRecordHistory: defineTable({
    ws: v.string(),
    recordId: v.string(),
    entry: v.any(),
  }).index("by_ws_recordId", ["ws", "recordId"]),
  fakeRecordKeys: defineTable({
    ws: v.string(),
    key: v.string(),
    response: v.any(),
  }).index("by_ws_key", ["ws", "key"]),

  // Phase 1b Salesforce Bulk import jobs. Table owned by workstream A
  // (shared contract); added here by B so B's functions typecheck before A
  // merges. `locator`/`chunksDone`/`seen`/`error` per object and
  // `requestedObjects`/`rejectedCount`/`error` on the job are B's extensions.
  sfImportJobs: defineTable({
    orgId: v.id("organizations"),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed")),
    objects: v.array(
      v.object({
        apiName: v.string(),
        sfTotal: v.number(),
        upserted: v.number(),
        merged: v.number(),
        rejected: v.number(),
        bulkJobId: v.optional(v.string()),
        state: v.union(v.literal("pending"), v.literal("running"), v.literal("done"), v.literal("failed")),
        locator: v.optional(v.string()),
        chunksDone: v.optional(v.number()),
        seen: v.optional(v.number()),
        error: v.optional(v.string()),
      }),
    ),
    requestedObjects: v.optional(v.array(v.string())),
    rejectedSample: v.array(v.object({ object: v.string(), sfId: v.optional(v.string()), reason: v.string() })),
    rejectedCount: v.optional(v.number()),
    // CP11: each Salesforce owner the imported records held, with the member
    // their email matched (none: unmapped, the report the import screen offers).
    owners: v.optional(v.array(v.object({
      sfUserId: v.string(),
      name: v.string(),
      email: v.optional(v.string()),
      memberId: v.optional(v.id("users")),
      records: v.number(),
    }))),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_orgId_and_startedAt", ["orgId", "startedAt"]),

  // CP11: the Canon record each imported Salesforce record became (a register
  // id for accounts, contacts and leads; a deal's stream id for opportunities),
  // so later objects (deals, contact roles, activities) find their targets.
  sfImportIds: defineTable({
    orgId: v.id("organizations"),
    sfId: v.string(),
    object: v.string(),
    canonId: v.string(),
  }).index("by_orgId_and_sfId", ["orgId", "sfId"]),
});
