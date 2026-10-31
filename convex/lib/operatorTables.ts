import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Application-owned, non-tenant operator authority and BugDrop intake state
 * (docs/operator-tools.md). None of these rows belong to an organization: the
 * operator is the CanonCRM team, proven by GitHub, not a CRM customer.
 */
export const operatorTables = {
  /** Latest collector snapshot per operator dashboard (development only, see lib/operatorDashboards.ts). */
  operatorDashboardSnapshots: defineTable({
    dashboard: v.union(v.literal("deploys"), v.literal("edits")),
    /** Display model as compact JSON text, at most OPERATOR_DASHBOARD_MAX_PAYLOAD_BYTES. */
    payload: v.string(),
    capturedAt: v.string(),
    receivedAt: v.number(),
  }).index("by_dashboard", ["dashboard"]),

  operatorPrincipals: defineTable({
    principalKey: v.string(),
    githubUserId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_principalKey", ["principalKey"]),

  operatorIdentityLinks: defineTable({
    principalId: v.id("operatorPrincipals"),
    clerkIssuer: v.string(),
    clerkSubject: v.string(),
    proofProvider: v.literal("github_oauth"),
    proofGithubUserId: v.string(),
    proofVerifiedAt: v.number(),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
    revokedReason: v.optional(v.string()),
    revokedByLinkId: v.optional(v.id("operatorIdentityLinks")),
  })
    .index("by_clerkIssuer_and_clerkSubject", ["clerkIssuer", "clerkSubject"])
    .index("by_principalId", ["principalId"]),

  operatorAuditEvents: defineTable({
    principalId: v.optional(v.id("operatorPrincipals")),
    linkId: v.optional(v.id("operatorIdentityLinks")),
    actorIssuer: v.optional(v.string()),
    actorSubject: v.optional(v.string()),
    action: v.union(
      v.literal("github_app_registered"),
      v.literal("identity_linked"),
      v.literal("identity_proof_refreshed"),
      v.literal("identity_revoked"),
      v.literal("bugdrop_token_issued"),
      v.literal("bugdrop_issue_accepted"),
      v.literal("bugdrop_issue_stamped"),
      v.literal("smithers_run_launched"),
      v.literal("smithers_launch_failed"),
      v.literal("bugdrop_pull_request_linked"),
      v.literal("bugdrop_issue_restarted"),
      v.literal("bugdrop_issue_dismissed"),
    ),
    detail: v.string(),
    createdAt: v.number(),
  }).index("by_principalId", ["principalId"]),

  // One-time states for the GitHub user OAuth proof and the App Manifest flow.
  operatorOAuthStates: defineTable({
    kind: v.union(v.literal("oauth"), v.literal("manifest")),
    stateHash: v.string(),
    clerkIssuer: v.string(),
    clerkSubject: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    .index("by_stateHash", ["stateHash"])
    .index("by_expiresAt", ["expiresAt"]),

  // The manifest-generated GitHub App. Secrets are AES-GCM encrypted at rest.
  operatorGithubApps: defineTable({
    configKey: v.string(),
    appId: v.string(),
    slug: v.string(),
    ownerGithubId: v.string(),
    ownerLogin: v.string(),
    clientId: v.string(),
    encryptedClientSecret: v.string(),
    encryptedPrivateKey: v.string(),
    encryptedWebhookSecret: v.string(),
    // Discovered from GitHub and cached so the webhook route can validate
    // deliveries without a GitHub round trip.
    installationId: v.optional(v.string()),
    bugDropAppLogin: v.optional(v.string()),
    bugDropAppUserId: v.optional(v.string()),
    // Rotating older page for missed-webhook Issue discovery (page 1 is always read).
    discoveryPage: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_configKey", ["configKey"]),

  operatorWebhookDeliveries: defineTable({
    deliveryId: v.string(),
    event: v.string(),
    issueNodeId: v.optional(v.string()),
    accepted: v.boolean(),
    reason: v.string(),
    receivedAt: v.number(),
  }).index("by_deliveryId", ["deliveryId"]),

  operatorBugIntakes: defineTable({
    source: v.literal("bugdrop"),
    repository: v.string(),
    repositoryNodeId: v.string(),
    issueNodeId: v.string(),
    issueNumber: v.number(),
    issueUrl: v.string(),
    title: v.string(),
    submittedPageUrl: v.optional(v.string()),
    issueAuthorId: v.string(),
    issueAuthorLogin: v.string(),
    sourceDeliveryId: v.string(),
    bodySha256: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("failed"),
      v.literal("launched"),
      v.literal("dismissed"),
    ),
    attempts: v.number(),
    restartSequence: v.number(),
    nextAttemptAt: v.optional(v.number()),
    leaseId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    provenanceSignature: v.optional(v.string()),
    stampedAt: v.optional(v.number()),
    gatewayRunId: v.optional(v.string()),
    launchedAt: v.optional(v.number()),
    // The reviewable PR the worker opened, linked by its run id or a closing
    // reference. Display only: PR bodies are collaborator-writable.
    pullRequestNumber: v.optional(v.number()),
    pullRequestUrl: v.optional(v.string()),
    pullRequestState: v.optional(v.union(v.literal("open"), v.literal("merged"), v.literal("closed"))),
    pullRequestDraft: v.optional(v.boolean()),
    // GitHub's updated_at for the stored PR state; older events are ignored.
    pullRequestUpdatedAt: v.optional(v.number()),
    // PRs a restart detached; never re-attached by reference alone.
    detachedPullRequestNumbers: v.optional(v.array(v.number())),
    // When the reconcile cron last examined this row; oldest-checked go first.
    reconciledAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_issueNodeId", ["issueNodeId"])
    .index("by_issueNumber", ["issueNumber"])
    .index("by_gatewayRunId", ["gatewayRunId"])
    .index("by_repository_and_pullRequestNumber", ["repository", "pullRequestNumber"])
    .index("by_status_and_nextAttemptAt", ["status", "nextAttemptAt"])
    .index("by_status_and_leaseExpiresAt", ["status", "leaseExpiresAt"])
    .index("by_status_and_pullRequestState_and_updatedAt", ["status", "pullRequestState", "updatedAt"])
    .index("by_status_and_pullRequestState_and_reconciledAt", ["status", "pullRequestState", "reconciledAt"]),
};
