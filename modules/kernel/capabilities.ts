/**
 * What a role may do beyond its record rules: one entry per capability, with the built-in roles that hold it. Admins
 * hold every capability. A workspace's own roles pick from the grantable ones; an `adminOnly` capability is never
 * granted to anyone else. A module's op, transition or action names one of these as the capability it needs
 * (manifest.ts). Canon decides whether a member holds one in convex/lib/capabilities.ts `can`.
 *
 * Pure: no imports but types.
 */
import type { Role } from "./manifest.ts";

export type CapabilitySpec = { label: string; roles: readonly Exclude<Role, "admin">[]; adminOnly?: true };

export const CAPABILITIES = {
  "strategy.edit": { label: "Edit ICPs, segments, ABM lists, scoring, signals, research, markets and TAM fills", roles: ["manager"] },
  "integrations.manage": { label: "Connect, sync and disconnect integrations and sequencers", roles: ["manager"] },
  "targets.set": { label: "Set the workspace's targets", roles: ["manager"] },
  "pipelines.edit": { label: "Edit deal pipelines and their stages", roles: ["manager"] },
  "agents.run": { label: "Start agent turns", roles: ["manager"] },
  "recipes.decide": { label: "Install, turn on and change the workspace's customizations and their settings", roles: ["manager"] },
  "usage.view": { label: "See the workspace's metered usage", roles: ["manager"] },
  "imports.run": { label: "Import records and approve staged ones", roles: ["manager"] },
  "facts.review": { label: "Accept or reject proposed facts", roles: ["manager"] },
  "cleanup.run": { label: "Approve and apply patch plans and merge records", roles: ["manager"] },
  "team.edit": { label: "Edit team members' names, titles and managers", roles: ["manager"] },
  "deals.write": { label: "Create, edit and archive deals", roles: ["manager"] },
  "workspace.edit": { label: "Change workspace settings and the dialer's numbers and do-not-call list", roles: ["manager"] },
  "tokens.manage": { label: "Pair the CLI and manage API tokens", roles: ["manager"] },
  "audiences.manageAll": { label: "See and change every member's audiences", roles: ["manager"] },
  "shared.moderate": { label: "Change or remove what other members created: reports, dashboards, views and linked accounts", roles: [] },
  "dataModel.edit": { label: "Change the data model: objects, fields and their names", roles: [], adminOnly: true },
  "automations.manage": { label: "Manage automation rules", roles: [], adminOnly: true },
  "recording.manage": { label: "Manage the workspace recording policy", roles: [], adminOnly: true },
  "webhooks.manage": { label: "Manage webhooks", roles: [], adminOnly: true },
  "outbound.manage": { label: "Turn on what modules send, and map Slack channels and webhook endpoints", roles: [], adminOnly: true },
  "billing.manage": { label: "Manage billing", roles: [], adminOnly: true },
  "grants.manage": { label: "Manage agents' standing grants", roles: [], adminOnly: true },
  "writeGate.edit": { label: "Change the write gate: which values are accepted without review", roles: [], adminOnly: true },
  "members.manage": { label: "Change members' roles and deactivate them", roles: [], adminOnly: true },
  "patchPlans.recover": { label: "Recover a patch plan stuck mid-apply", roles: [], adminOnly: true },
  "agents.manageAll": { label: "Pause, reassign and manage every member's agents", roles: [], adminOnly: true },
  "sending.limits": { label: "Raise sending limits above Canon's recommendation", roles: [], adminOnly: true },
  "suppressions.manage": { label: "Add and lift workspace suppression rules", roles: [], adminOnly: true },
  "permissions.manage": { label: "Change roles, permissions and teams, and preview as a member", roles: [], adminOnly: true },
  "workspace.transfer": { label: "Export the whole workspace to an archive", roles: [], adminOnly: true },
} as const satisfies Record<string, CapabilitySpec>;

export type Capability = keyof typeof CAPABILITIES;
