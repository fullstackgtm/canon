"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { ArrowRight } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { RAMP_STEPS } from "../../../../convex/lib/linkedin/limits";
import { cn } from "@/lib/utils";
import { formatRelativeTime, statusMeta } from "./call-provider-card";
import { integrationDef, type IntegrationKey } from "./catalog";
import { IntegrationMark, StatusDot, statusTextClass, type IntegrationStatus } from "./integration-ui";
import { useCrm } from "./crm-panels";
import { DeeplineControls } from "./deepline-card";
import { SequencerControls } from "./sequencer-card";
import { SlackControls } from "./slack-card";

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words text-right font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border px-5 py-4">
      <h3 className="eyebrow mb-3 text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function CrmDetail({ provider }: { provider: "hubspot" | "salesforce" }) {
  const { connection, runs } = useCrm(provider);
  if (!connection?.isActive) return null;
  return (
    <>
      <RailSection title="Connection">
        <Facts
          rows={[
            ...(connection.displayName ? [["Account", connection.displayName] as [string, ReactNode]] : []),
            ["Last sync", formatRelativeTime(connection.lastSyncAt)],
            ["Deals updated", connection.lastSyncDealCount ?? 0],
            ["Schedule", <span key="s" className="capitalize">{connection.syncConfig?.schedule ?? "manual"}</span>],
          ]}
        />
        {connection.lastSyncError && <p className="mt-3 text-xs text-warning">{connection.lastSyncError}</p>}
      </RailSection>
      {runs && runs.length > 0 && (
        <RailSection title="Recent syncs">
          <ul className="space-y-1.5 text-sm">
            {runs.slice(0, 4).map((run) => (
              <li key={run._id} className="flex justify-between gap-3">
                <span>{statusMeta(run.status).label} <span className="text-muted-foreground">· {run.trigger}</span></span>
                <span className="text-xs text-muted-foreground">{formatRelativeTime(run.startedAt)}</span>
              </li>
            ))}
          </ul>
        </RailSection>
      )}
    </>
  );
}

function GmailDetail() {
  const mine = useQuery(api.emailAccounts.mine);
  if (!mine?.accounts.length) return null;
  return (
    <RailSection title="Linked accounts">
      <ul className="space-y-2 text-sm">
        {mine.accounts.map((account) => (
          <li key={account._id}>
            <div className="font-medium">{account.address}</div>
            <div className="text-xs text-muted-foreground">
              {account.sentLastDay} of {mine.dailyCap} sent in the last 24 hours
              {account.status !== "ok" && <span className="text-warning"> · {account.statusReason ?? "Needs sign-in"}</span>}
            </div>
          </li>
        ))}
      </ul>
    </RailSection>
  );
}

const TIERS = { free: "Free", premium: "Premium", sales_navigator: "Sales Navigator" } as const;

function LinkedinDetail() {
  const mine = useQuery(api.linkedin.mine);
  const account = mine?.account;
  if (!account) return null;
  return (
    <RailSection title="Account">
      <Facts
        rows={[
          ["Profile", account.profileName ?? "Your account"],
          ["Plan", TIERS[account.tier]],
          ["Warm-up", account.rampStep >= RAMP_STEPS ? "Done" : `Week ${account.rampStep + 1} of ${RAMP_STEPS}`],
          ["Invites today", `${account.usage.invitesToday} / ${account.today.invitesPerDay}`],
        ]}
      />
      {account.statusReason && <p className="mt-3 text-xs text-warning">{account.statusReason}</p>}
      <Link href="/dashboard/linkedin" className="mt-3 inline-block text-xs underline underline-offset-2">Cadences and sending hours</Link>
    </RailSection>
  );
}

function DialerDetail() {
  const overview = useQuery(api.dialer.overview);
  if (!overview?.configured) return null;
  return (
    <RailSection title="Numbers">
      {overview.numbers.length ? (
        <ul className="space-y-1.5 text-sm">
          {overview.numbers.map((n) => (
            <li key={n._id} className="flex justify-between gap-3">
              <span className="font-medium">{n.number}{n.label && <span className="font-normal text-muted-foreground"> · {n.label}</span>}</span>
              <span className="text-xs text-muted-foreground">{n.free ? "Free" : "On a call"}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No numbers yet.</p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">Recording {overview.record ? "on" : "off"}{overview.simulated ? " · simulated on this stack" : ""}</p>
    </RailSection>
  );
}

function ExpleeDetail() {
  const status = useQuery(api.explee.status);
  if (!status?.connected) return null;
  return (
    <RailSection title="Hot leads">
      <Facts
        rows={[
          ["Imported", status.imported.toLocaleString("en-US")],
          ["Last checked", formatRelativeTime(status.lastSyncAt ?? undefined)],
        ]}
      />
      {status.lastSyncStatus === "error" && status.lastSyncError && <p className="mt-3 text-xs text-destructive">{status.lastSyncError}</p>}
      {status.recent.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {status.recent.slice(0, 4).map((r) => (
            <li key={r.contactId} className="flex justify-between gap-3">
              <Link href={`/dashboard/records/contact/${encodeURIComponent(r.contactId)}`} className="truncate hover:underline">
                {r.name} <span className="text-muted-foreground">· {r.company}</span>
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(r.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}

function GranolaDetail() {
  const status = useQuery(api.granola.status);
  if (!status?.connected) return null;
  return (
    <RailSection title="Meetings">
      <Facts rows={[["Last checked", formatRelativeTime(status.lastSyncAt ?? undefined)]]} />
      {status.lastSyncStatus !== "success" && status.lastSyncError && <p className="mt-3 text-xs text-destructive">{status.lastSyncError}</p>}
      {status.recent.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-sm">
          {status.recent.slice(0, 4).map((m) => (
            <li key={m.id} className="flex justify-between gap-3">
              <span className="truncate">{m.title} <span className="text-muted-foreground">· {m.deal ? m.deal.name : m.logged ? "no open deal" : "no matching contact"}</span></span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatRelativeTime(m.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </RailSection>
  );
}

function ChatgptDetail() {
  const status = useQuery(api.chatgptAuth.status);
  if (status?.status !== "connected") return null;
  return (
    <RailSection title="Account">
      <Facts
        rows={[
          ["Signed in as", status.email ?? "Your account"],
          ...(status.planType ? [["Plan", <span key="p" className="capitalize">{status.planType}</span>] as [string, ReactNode]] : []),
          ["Connected", formatRelativeTime(status.connectedAt ?? undefined)],
        ]}
      />
    </RailSection>
  );
}

function Detail({ integration }: { integration: IntegrationKey }) {
  switch (integration) {
    case "hubspot":
    case "salesforce":
      return <CrmDetail provider={integration} />;
    case "gmail":
      return <GmailDetail />;
    case "linkedin":
      return <LinkedinDetail />;
    case "dialer":
      return <DialerDetail />;
    case "explee":
      return <ExpleeDetail />;
    case "granola":
      return <GranolaDetail />;
    case "instantly":
    case "emailbison":
    case "smartlead":
      return <RailSection title="Settings"><SequencerControls key={integration} provider={integration} /></RailSection>;
    case "deepline":
      return <RailSection title="Settings"><DeeplineControls /></RailSection>;
    case "chatgpt":
      return <ChatgptDetail />;
    case "slack":
      return <RailSection title="Settings"><SlackControls /></RailSection>;
  }
}

/** The right rail: what the selected integration does, how it's doing, and the way in. */
export function IntegrationRail({ integration, status }: { integration: IntegrationKey; status: IntegrationStatus }) {
  const def = integrationDef(integration);
  const actionLabel = status.tone === "off" ? `Set up ${def.name}` : `Open ${def.name}`;
  return (
    <aside aria-label={`${def.name} details`} className="border border-border bg-card lg:sticky lg:top-8" data-testid="integration-rail">
      <div className="px-5 py-5">
        <div className="flex items-start gap-3">
          <IntegrationMark integration={integration} size="lg" />
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{def.name}</h2>
            {status.tone !== "loading" && (
              <p className={cn("mt-0.5 inline-flex items-center gap-2 text-sm", statusTextClass(status.tone))}>
                <StatusDot tone={status.tone} /> {status.label}
              </p>
            )}
          </div>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">{def.description}</p>
        {def.href && status.tone !== "unavailable" && (
          <Link
            href={def.href}
            data-testid={`integration-open-${integration}`}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85"
          >
            {actionLabel} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
        {status.tone === "unavailable" && (
          <p className="mt-4 text-xs text-muted-foreground">{def.name} isn&apos;t set up on this deployment yet.</p>
        )}
      </div>
      <Detail integration={integration} />
    </aside>
  );
}
