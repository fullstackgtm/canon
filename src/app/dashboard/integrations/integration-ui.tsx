"use client";

import { integrationNeeds } from "../../../../convex/lib/integrationsAvailable.ts";
import { INTEGRATION_FEATURES } from "./catalog";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { cn } from "@/lib/utils";
import { ViewFrame } from "@/components/dashboard";
import { formatRelativeTime } from "./call-provider-card";
import { integrationDef, type IntegrationKey } from "./catalog";

export type Tone = "connected" | "syncing" | "attention" | "error" | "off" | "unavailable" | "loading";

export type IntegrationStatus = {
  tone: Tone;
  /** Right-aligned status text in the table. */
  label: string;
  /** The connected account, number count and so on, under the name. */
  detail?: string;
};

/** Where an integration's reading stands, the same words on every page: off, reading the backlog, on, or stopped and waiting. */
export type ReadState = "off" | "reading" | "on" | "stopped";

export const readStateOf = (intake: { on: boolean; backfilledAt: number | null; progress: { failed: boolean } | null }): ReadState =>
  !intake.on ? "off" : intake.progress?.failed ? "stopped" : intake.backfilledAt ? "on" : "reading";

/** Granola's reading, from api.granola.status: on while connected, reading while it imports a backlog. */
export const granolaReadState = (s: { catchingUp: boolean; rescoping: boolean; lastSyncStatus: string | null }): ReadState =>
  s.catchingUp || s.rescoping ? "reading" : s.lastSyncStatus === "error" ? "stopped" : "on";

/** The table's line for reading, alike for Gmail, LinkedIn and Granola: "Read my messages: on". */
export function readingLabel(what: "messages" | "meetings", reads: readonly ReadState[]) {
  const on = reads.filter((r) => r !== "off").length;
  const state = reads.includes("reading") ? "reading…" : reads.includes("stopped") ? "stopped" : on === 0 ? "off" : on === reads.length ? "on" : `on for ${on} of ${reads.length}`;
  return `Read my ${what}: ${state}`;
}

const LOADING: IntegrationStatus = { tone: "loading", label: "" };
const UNAVAILABLE: IntegrationStatus = { tone: "unavailable", label: "Not set up here" };

function crmStatus(
  connection:
    | { isActive?: boolean; displayName?: string; lastSyncAt?: number; lastSyncStatus?: string }
    | null
    | undefined,
): IntegrationStatus {
  if (connection === undefined) return LOADING;
  if (!connection?.isActive) return { tone: "off", label: "Not connected" };
  const detail = connection.displayName;
  if (connection.lastSyncStatus === "in_progress") return { tone: "syncing", label: "Syncing", detail };
  if (connection.lastSyncStatus === "error") return { tone: "error", label: "Sync failed", detail };
  if (connection.lastSyncStatus === "partial") return { tone: "attention", label: "Partial sync", detail };
  return {
    tone: "connected",
    label: connection.lastSyncAt ? `Synced ${formatRelativeTime(connection.lastSyncAt)}` : "Connected",
    detail,
  };
}

function sequencerStatus(s: { connected: boolean; instanceUrl: string | null } | undefined): IntegrationStatus {
  if (s === undefined) return LOADING;
  return s.connected ? { tone: "connected", label: "Connected", ...(s.instanceUrl ? { detail: s.instanceUrl.replace(/^https:\/\//, "") } : {}) } : { tone: "off", label: "Not connected" };
}

/** One status per integration, from the same queries each integration's controls use. */
export function useIntegrationStatuses(): Record<IntegrationKey, IntegrationStatus> {
  const available = useQuery(api.integrationsAvailable.status);
  const workspace = useQuery(api.integrations.context);
  const gmail = useQuery(api.emailAccounts.mine);
  const explee = useQuery(api.explee.status);
  const sequencers = useQuery(api.audiences.sequencerStatus);
  const deepline = useQuery(api.deepline.status);
  const linkedin = useQuery(api.linkedin.mine);
  const dialer = useQuery(api.dialer.overview);
  const slack = useQuery(api.agentSlack.status);
  const granola = useQuery(api.granola.status);
  const chatgpt = useQuery(api.chatgptAuth.status);

  const linkedinAccount = linkedin?.account;
  const linkedinDetail = linkedinAccount ? [linkedinAccount.profileName, readingLabel("messages", [readStateOf(linkedinAccount.intake)])].filter(Boolean).join(" · ") : undefined;
  const gmailNeedsSignIn = gmail?.accounts.filter((account) => account.status !== "ok").length ?? 0;

  const statuses: Record<IntegrationKey, IntegrationStatus> = {
    hubspot: crmStatus(workspace === undefined ? undefined : workspace.hubspot ?? null),
    salesforce: crmStatus(workspace === undefined ? undefined : workspace.salesforce ?? null),
    avoma: crmStatus(workspace === undefined ? undefined : workspace.callProviders?.find((connection) => connection?.provider === "avoma") ?? null),
    gmail:
      gmail === undefined ? LOADING
      : !gmail?.configured ? UNAVAILABLE
      : gmail.accounts.length === 0 ? { tone: "off", label: "Not linked" }
      : {
          tone: gmailNeedsSignIn ? "attention" : "connected",
          label: gmailNeedsSignIn ? "Needs sign-in" : `${gmail.accounts.length} linked`,
          detail: `${gmail.accounts.map((account) => account.address).join(", ")} · ${readingLabel("messages", gmail.accounts.map((account) => readStateOf(account.intake)))}`,
        },
    explee:
      explee === undefined ? LOADING
      : !explee.connected ? { tone: "off", label: "Not connected" }
      : {
          tone: explee.lastSyncStatus === "error" ? "error" : "connected",
          label: explee.lastSyncStatus === "error" ? "Check failed" : `Checked ${formatRelativeTime(explee.lastSyncAt ?? undefined)}`,
          detail: `${explee.imported.toLocaleString("en-US")} hot ${explee.imported === 1 ? "lead" : "leads"} imported`,
        },
    instantly: sequencerStatus(sequencers?.instantly),
    emailbison: sequencerStatus(sequencers?.emailbison),
    smartlead: sequencerStatus(sequencers?.smartlead),
    deepline:
      deepline === undefined ? LOADING
      : deepline.connected ? { tone: "connected", label: "Connected" }
      : { tone: "off", label: "Not connected" },
    linkedin:
      linkedin === undefined ? LOADING
      : linkedin && !linkedin.configured ? UNAVAILABLE
      : !linkedinAccount ? { tone: "off", label: "Not connected" }
      : linkedinAccount.status === "credentials" ? { tone: "attention", label: "Needs login", detail: linkedinDetail }
      : linkedinAccount.status === "paused" ? { tone: "attention", label: "Paused", detail: linkedinDetail }
      : { tone: "connected", label: "Connected", detail: linkedinDetail },
    dialer:
      dialer === undefined ? LOADING
      : !dialer?.configured ? UNAVAILABLE
      : dialer.numbers.length === 0 ? { tone: "off", label: "No numbers" }
      : {
          tone: "connected",
          label: `${dialer.numbers.length} number${dialer.numbers.length === 1 ? "" : "s"}`,
          detail: dialer.numbers.map((n) => n.number).join(", "),
        },
    granola:
      granola === undefined ? LOADING
      : !granola.connected ? { tone: "off", label: "Not connected" }
      : {
          tone: granola.lastSyncStatus === "error" ? "error" : granola.lastSyncStatus === "partial" ? "attention" : "connected",
          label: granola.lastSyncStatus === "error" ? "Check failed" : `Checked ${formatRelativeTime(granola.lastSyncAt ?? undefined)}`,
          detail: readingLabel("meetings", [granolaReadState(granola)]),
        },
    chatgpt:
      chatgpt === undefined ? LOADING
      : chatgpt === null || chatgpt.status === "signed-out" ? { tone: "off", label: "Not connected" }
      : chatgpt.status === "pending" ? { tone: "attention", label: "Waiting for approval" }
      : chatgpt.status === "error" ? { tone: "error", label: "Sign-in failed" }
      : { tone: "connected", label: "Connected", detail: chatgpt.email ?? undefined },
    slack:
      slack === undefined ? LOADING
      : slack.connected ? { tone: "connected", label: "Connected" }
      : { tone: "off", label: "Not connected" },
  };
  for (const [key, feature] of Object.entries(INTEGRATION_FEATURES)) {
    if (!available) statuses[key as IntegrationKey] = LOADING;
    else if (!available[feature]) statuses[key as IntegrationKey] = { tone: "unavailable", label: "Off", detail: integrationNeeds(feature) };
  }
  return statuses;
}

const TONE_LABEL: Record<Tone, string> = {
  connected: "Connected",
  syncing: "Syncing",
  attention: "Needs attention",
  error: "Failing",
  off: "Not connected",
  unavailable: "Unavailable",
  loading: "Loading",
};

export function StatusDot({ tone }: { tone: Tone }) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "inline-block size-2 shrink-0 rounded-full",
          tone === "connected" && "bg-primary",
          tone === "syncing" && "animate-pulse bg-primary",
          tone === "attention" && "bg-warning",
          tone === "error" && "bg-destructive",
          (tone === "off" || tone === "loading") && "border border-muted-foreground/50",
          tone === "unavailable" && "bg-muted-foreground/30",
        )}
      />
      <span className="sr-only">{TONE_LABEL[tone]}</span>
    </>
  );
}

export function statusTextClass(tone: Tone) {
  return cn(
    tone === "attention" && "text-warning",
    tone === "error" && "text-destructive",
    tone === "syncing" && "text-primary",
    !["attention", "error", "syncing"].includes(tone) && "text-muted-foreground",
  );
}

/** The provider's logo on a white tile (logos are drawn for light backgrounds), or its two-letter mark if the logo fails. */
export function IntegrationMark({ integration, size = "md" }: { integration: IntegrationKey; size?: "md" | "lg" }) {
  const def = integrationDef(integration);
  const [failed, setFailed] = useState(false);
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center border border-border font-mono font-semibold text-foreground",
        failed ? "bg-muted" : "bg-white p-1",
        size === "md" ? "size-8 text-[11px]" : "size-11 p-1.5 text-sm",
      )}
    >
      {failed ? (
        def.mark
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- tiny static logos; next/image would need SVGs allowed
        <img src={def.logo} alt="" className="size-full object-contain" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

/** An integration's own page: the shared view header (name, what it does, status), back to the table and any section tabs below it. */
export function IntegrationPage({ integration, tabs, children }: { integration: IntegrationKey; tabs?: ReactNode; children: ReactNode }) {
  const def = integrationDef(integration);
  const status = useIntegrationStatuses()[integration];
  return (
    <ViewFrame
      title={def.name}
      description={def.description}
      secondaryActions={status.tone !== "loading" && (
        <span className={cn("inline-flex items-center gap-2 text-sm", statusTextClass(status.tone))} data-testid="integration-status">
          <StatusDot tone={status.tone} />
          {status.label}
        </span>
      )}
      controls={
        <div className="grid gap-3">
          <div className="flex items-center gap-3">
            <Link
              href={`/dashboard/integrations?selected=${integration}`}
              className="eyebrow inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Integrations
            </Link>
            <IntegrationMark integration={integration} />
          </div>
          {tabs}
        </div>
      }
    >
      {children}
    </ViewFrame>
  );
}

/** Sections of an integration's page, in the same style as the Salesforce sync tabs. */
export function IntegrationTabs({ tabs, label }: { tabs: { href: string; label: string }[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 border-b border-border">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-xs font-medium",
              active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
