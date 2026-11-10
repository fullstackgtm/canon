import type { IntegrationFeature } from "../../../../convex/lib/integrationsAvailable.ts";

/** Every integration on the Integrations page, grouped the way the table shows them. */

export type IntegrationKey =
  | "hubspot"
  | "salesforce"
  | "gmail"
  | "explee"
  | "deepline"
  | "instantly"
  | "emailbison"
  | "smartlead"
  | "linkedin"
  | "dialer"
  | "granola"
  | "avoma"
  | "slack"
  | "chatgpt";

export type IntegrationDef = {
  key: IntegrationKey;
  name: string;
  /** The provider's logo, under public/. */
  logo: string;
  /** Two-letter mark shown if the logo fails to load. */
  mark: string;
  /** One line for the table row. */
  summary: string;
  /** What it does, for the rail and the integration's own page. */
  description: string;
  /** The integration's own page. Without one, its controls live in the rail. */
  href?: string;
};

export const INTEGRATION_GROUPS: { title: string; items: IntegrationDef[] }[] = [
  {
    title: "CRM",
    items: [
      {
        key: "hubspot",
        name: "HubSpot",
        logo: "/integrations/hubspot.svg",
        mark: "HS",
        summary: "Companies, contacts, deals and owners",
        description:
          "Sync companies, contacts, deals and owners from HubSpot, or import the whole portal once. Canon only reads from HubSpot.",
        href: "/dashboard/integrations/hubspot",
      },
      {
        key: "salesforce",
        name: "Salesforce",
        logo: "/integrations/salesforce.svg",
        mark: "SF",
        summary: "Accounts, contacts and opportunities, read-only",
        description:
          "Import Salesforce and keep CanonCRM in sync with it. The sync never writes to Salesforce; Canon fields manage what is written back.",
        href: "/dashboard/integrations/salesforce",
      },
    ],
  },
  {
    title: "AI",
    items: [
      {
        key: "chatgpt",
        name: "ChatGPT",
        logo: "/integrations/openai.svg",
        mark: "AI",
        summary: "Run your AI tasks on your own ChatGPT plan",
        description:
          "Connect your ChatGPT account and the AI tasks you start (Ask Canon, research, call insights, market classification and your agents' turns) run on your ChatGPT plan instead of a workspace API key. Your session is encrypted on the server and never sent to the browser.",
        href: "/dashboard/integrations/chatgpt",
      },
    ],
  },
  {
    title: "Email",
    items: [
      {
        key: "gmail",
        name: "Gmail",
        logo: "/integrations/gmail.svg",
        mark: "GM",
        summary: "Send email to contacts from your own address",
        description:
          "Send email to your contacts from your own Gmail address. Each email you send shows on the contact's timeline.",
        href: "/dashboard/integrations/gmail",
      },
      {
        key: "explee",
        name: "Explee",
        logo: "/integrations/explee.png",
        mark: "EX",
        summary: "Hot leads from your cold email",
        description:
          "Explee sends your cold email. Every 10 minutes, each new hot lead (someone who replied with real interest) is added as a contact, with their reply on the contact's timeline.",
        href: "/dashboard/integrations/explee",
      },
      {
        key: "instantly",
        name: "Instantly",
        logo: "/integrations/instantly.png",
        mark: "IN",
        summary: "Push audiences to Instantly campaigns",
        description:
          "Push audiences of contacts to an Instantly campaign. Use an API key with lead-create access (Instantly, Settings, Integrations).",
      },
      {
        key: "emailbison",
        name: "EmailBison",
        mark: "EB",
        logo: "/integrations/emailbison.png",
        summary: "Push audiences to EmailBison campaigns",
        description:
          "Push audiences of contacts to an EmailBison campaign. Enter your EmailBison address and an API token (EmailBison, Settings, API). Contacts without a first name are skipped: EmailBison requires one.",
      },
      {
        key: "smartlead",
        name: "Smartlead",
        mark: "SM",
        logo: "/integrations/smartlead.png",
        summary: "Push audiences to Smartlead campaigns",
        description:
          "Push audiences of contacts to a Smartlead campaign. Use your API key (Smartlead, Settings, API key).",
      },
    ],
  },
  {
    title: "Enrichment",
    items: [
      {
        key: "deepline",
        name: "Deepline",
        mark: "DP",
        logo: "/integrations/deepline.svg",
        summary: "Find emails with your own Deepline account",
        description:
          "Connect your Deepline account and Find email runs Deepline's email waterfall first, then Canon's own sources if it finds nothing. Deepline bills your Deepline account directly; Canon charges no credits for it.",
      },
    ],
  },
  {
    title: "LinkedIn & calls",
    items: [
      {
        key: "linkedin",
        name: "LinkedIn",
        logo: "/integrations/linkedin.svg",
        mark: "LI",
        summary: "Invites and messages from your own account",
        description:
          "Send connection invites and follow-up messages from your own LinkedIn account, within limits that keep it clean.",
        href: "/dashboard/integrations/linkedin",
      },
      {
        key: "dialer",
        name: "Dialer",
        logo: "/integrations/telnyx.png",
        mark: "DL",
        summary: "Call contacts through Telnyx numbers",
        description:
          "Call contacts from their page. Canon rings your own phone, then connects each contact you dial onto that call. Calls are recorded, transcribed and logged on the contact, and their transcripts feed call insights.",
        href: "/dashboard/integrations/dialer",
      },
      {
        key: "granola",
        name: "Granola",
        logo: "/integrations/granola.png",
        mark: "GR",
        summary: "Meetings logged on their people, company and deal",
        description:
          "Every 15 minutes, each new Granola meeting is logged on the people, company and open deal it was with, with Granola's summary, and its transcript goes to call insights.",
        href: "/dashboard/integrations/granola",
      },
      {
        key: "avoma",
        name: "Avoma",
        logo: "/integrations/avoma.svg",
        mark: "AV",
        summary: "Call transcripts with buyer and rep speakers",
        description:
          "Connect your workspace API key and sync the last 30 days of Avoma calls into Call Intelligence, with transcripts, participants and speaker sides for deal state.",
        href: "/dashboard/integrations/avoma",
      },
    ],
  },
  {
    title: "Notifications",
    items: [
      {
        key: "slack",
        name: "Slack",
        logo: "/integrations/slack.svg",
        mark: "SL",
        summary: "Post to a channel when an agent's turn ends",
        description:
          "Post a message to one channel when an agent's turn ends. Create an incoming webhook in Slack (Apps, Incoming Webhooks) and paste its URL. Each agent chooses whether to notify.",
      },
    ],
  },
];

export const INTEGRATIONS: IntegrationDef[] = INTEGRATION_GROUPS.flatMap((group) => group.items);

export function integrationDef(key: IntegrationKey): IntegrationDef {
  return INTEGRATIONS.find((item) => item.key === key)!;
}

export function isIntegrationKey(value: string | null | undefined): value is IntegrationKey {
  return INTEGRATIONS.some((item) => item.key === value);
}

export const INTEGRATION_FEATURES: Partial<Record<IntegrationKey, IntegrationFeature>> = {
  chatgpt: "chatgpt", gmail: "unipile", linkedin: "unipile", dialer: "dialer",
};
