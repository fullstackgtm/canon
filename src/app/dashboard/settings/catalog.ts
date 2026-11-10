/** Every area on the Settings page, grouped the way the table shows them. */

export type SettingsKey = "workspace" | "targets" | "team" | "permissions" | "pipelines" | "billing" | "api" | "webhooks" | "feeds" | "outbound" | "recording";

export type SettingsDef = {
  key: SettingsKey;
  name: string;
  /** One line for the table row. */
  summary: string;
  /** What it covers, for the rail and the area's own page. */
  description: string;
  /** The area's own page. */
  href: string;
  /** Who sees the area: everyone, or admins only. */
  adminOnly?: boolean;
};

export const SETTINGS_GROUPS: { title: string; items: SettingsDef[] }[] = [
  {
    title: "Workspace",
    items: [
      {
        key: "workspace",
        name: "Workspace",
        summary: "Name, fiscal year, currency and timezone",
        description:
          "The workspace's operating defaults: its name, when the fiscal year starts, its currency and timezone, and how often CRM hierarchy syncs. Revenue reporting, health checks and CRM sync all use them.",
        href: "/dashboard/settings/workspace",
      },
      {
        key: "targets",
        name: "Targets",
        summary: "The year's bookings target, split into teams, reps and months",
        description:
          "One bookings target per fiscal year, set top down and split into teams, reps and months, with a pipeline coverage target. Everyone reads it; admins and managers set it. Reports pacing, Forecast and planning modules read it.",
        href: "/dashboard/settings/targets",
      },
      {
        key: "team",
        name: "Team",
        summary: "Members, roles, managers and teams",
        description:
          "Everyone in the workspace, their role and manager, and the teams they're on. Teams decide what \"their teams' records\" means in Permissions.",
        href: "/dashboard/settings/team",
      },
      {
        key: "recording",
        name: "Recording",
        summary: "Consent, exclusions, retention and dialer call recording",
        description:
          "Prepare consent, exclusions, retention and region for future meeting recording. Control Dialer call recording today.",
        href: "/dashboard/settings/recording",
        adminOnly: true,
      },
      {
        key: "permissions",
        name: "Permissions",
        summary: "Who sees and changes which records",
        description:
          "For each role, which records of each object its members see and change, and which fields they can't. View the app as any member to check.",
        href: "/dashboard/settings/permissions",
        adminOnly: true,
      },
      {
        key: "pipelines",
        name: "Pipelines",
        summary: "Deal pipelines, their stages and probabilities",
        description:
          "Each deal pipeline's stages in order, with the probability and forecast category a deal takes at each. They live on Customization with the rest of the data model.",
        href: "/dashboard/customization/pipelines",
      },
    ],
  },
  {
    title: "Account",
    items: [
      {
        key: "billing",
        name: "Billing & usage",
        summary: "Credits, invoices and what the workspace used",
        description:
          "The workspace's credits, buying more, invoices and saved cards in Stripe, and what was spent this month: credits by day, paid email hits and provider spend.",
        href: "/dashboard/settings/billing",
      },
    ],
  },
  {
    title: "Developers",
    items: [
      {
        key: "api",
        name: "API access",
        summary: "Paired CLIs and agents, and revoking them",
        description:
          "Agents and the canon CLI reach the workspace with a token per paired machine, each revocable. Pair a new one from the CLI with canon login.",
        href: "/dashboard/cli-auth",
        adminOnly: true,
      },
      {
        key: "webhooks",
        name: "Webhooks",
        summary: "Send record changes to your own endpoints",
        description:
          "Canon posts a signed request to each endpoint when a record it watches is created, changed or deleted. Check each endpoint's recent deliveries here.",
        href: "/dashboard/settings/webhooks",
        adminOnly: true,
      },
      {
        key: "feeds",
        name: "Feeds",
        summary: "Your module read access and connector feeds",
        description:
          "Choose which modules can read your connected accounts. Integration managers also see workspace feed health and manage signed webhooks.",
        href: "/dashboard/settings/feeds",
      },
      {
        key: "outbound",
        name: "Outbound",
        summary: "My mailbox grants and workspace outbound settings",
        description:
          "Review and revoke consent for templates sent from your own mailbox. Admins also manage module channels, Slack mappings, webhook endpoints, messages and workspace do-not-contact rules.",
        href: "/dashboard/settings/outbound",
      },
    ],
  },
];

export const SETTINGS: SettingsDef[] = SETTINGS_GROUPS.flatMap((group) => group.items);

export function settingsDef(key: SettingsKey): SettingsDef {
  return SETTINGS.find((item) => item.key === key)!;
}

export function isSettingsKey(value: string | null | undefined): value is SettingsKey {
  return SETTINGS.some((item) => item.key === value);
}

/**
 * Where an old `/dashboard/settings?tab=` link now goes. Stripe returns and
 * links in sent emails still carry the old form.
 */
export function legacyTabHref(tab: string | null, search: URLSearchParams): string | null {
  switch (tab) {
    case "workspace":
      return "/dashboard/settings/workspace";
    case "team":
    case "teams":
      return "/dashboard/settings/team";
    case "permissions":
      return "/dashboard/settings/permissions";
    case "billing":
    case "usage":
      return search.get("credits") === "success" ? "/dashboard/settings/billing?credits=success" : "/dashboard/settings/billing";
    case "webhooks":
      return "/dashboard/settings/webhooks";
    case "ai":
      return "/dashboard/integrations?selected=chatgpt";
    case "pipelines":
      return "/dashboard/customization/pipelines";
    case "data-model":
    case "dataModel":
      return "/dashboard/customization/data-model";
    case "automations":
      return "/dashboard/agents#automations";
    default:
      return null;
  }
}
