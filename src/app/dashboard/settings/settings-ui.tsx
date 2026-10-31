"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { useMailboxGrantsAvailable, useOutboundAvailable } from "@/hooks/use-outbound-available";
import { ArrowLeft } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { ViewFrame } from "@/components/dashboard";
import { settingsDef, type SettingsKey } from "./catalog";
import { fiscalQuarterLabel, fiscalYearLabel } from "./workspace-form";
import { money } from "@/components/reports/pacing-chart";
import { fiscalYearName } from "../../../../convex/lib/reports/pacing";

const num = (n: number) => Math.round(n).toLocaleString("en-US");
const plural = (n: number, one: string) => `${num(n)} ${one}${n === 1 ? "" : "s"}`;

export type SettingsFact = [label: string, value: ReactNode];

export type SettingsSummary = {
  /** Right-aligned value in the table; undefined while loading. */
  value?: string;
  /** Facts for the rail. */
  facts: SettingsFact[];
};

/** Who's looking: admins see every area, admins and managers edit the workspace. */
export function useSettingsAccess() {
  const org = useQuery(api.organizations.context)?.organization;
  const role = org?.currentUserRole;
  return { loading: org === undefined, isAdmin: role === "admin", canEdit: role === "admin" || role === "manager" };
}

/** One line per area for the table, and the facts its rail shows. */
export function useSettingsSummaries(): Record<SettingsKey, SettingsSummary> {
  const outboundAvailable = useOutboundAvailable();
  const mailboxGrantsAvailable = useMailboxGrantsAvailable();
  const org = useQuery(api.organizations.context)?.organization;
  const users = useQuery(api.users.context)?.users;
  const permissions = useQuery(api.permissions.settings);
  const credits = useQuery(api.credits.summary);
  const recording = useQuery(api.recordingPolicy.get);
  const webhooks = useQuery(api.recordWebhooks.list);
  const feeds = useQuery(api.connectors.health);
  const outbound = useQuery(api.outbound.settings, outboundAvailable ? {} : "skip");
  const pipelines = useQuery(api.pipelines.list);
  const tokens = useQuery(api.cliAuth.list);
  const targets = useQuery(api.targets.get, {});
  const liveTokens = (tokens ?? []).filter((t) => !t.revokedAt && !t.expired);

  const members = users?.filter((u) => u.isActive && !u.isHidden);
  const customized = permissions?.roles.filter((r) => r.rules.length > 0) ?? [];
  const endpoints = webhooks?.endpoints ?? [];
  const failing = endpoints.filter((e) => e.enabled && e.lastDelivery?.status === "failed").length;

  return {
    workspace: org
      ? {
          value: `${fiscalYearLabel(org.fiscalYearStartMonth)} ${fiscalQuarterLabel(org.fiscalYearStartMonth)} · ${org.defaultCurrency}`,
          facts: [
            ["Name", org.name],
            ["Fiscal year", `${fiscalYearLabel(org.fiscalYearStartMonth)} ${fiscalQuarterLabel(org.fiscalYearStartMonth)}`],
            ["Currency", org.defaultCurrency],
            ["Timezone", org.timezone.replace(/_/g, " ")],
            ["CRM cadence", <span key="c" className="capitalize">{org.syncSchedule ?? "daily"}</span>],
          ],
        }
      : { facts: [] },
    targets: targets
      ? {
          value: targets.plan ? `${fiscalYearName(targets.year, targets.fyStart)} target ${money(targets.plan.total)}` : `No targets for ${fiscalYearName(targets.year, targets.fyStart)}`,
          facts: targets.plan
            ? [["Year total", money(targets.plan.total)], ["Pipeline coverage", `${targets.plan.coverage}x`], ["Set by", targets.canEdit ? "You can change it" : "Admins and managers"]]
            : [["Set by", targets.canEdit ? "You can set it" : "Admins and managers"]],
        }
      : { facts: [] },
    team: members
      ? {
          value: plural(members.length, "member") + (permissions ? ` · ${plural(permissions.teams.length, "team")}` : ""),
          facts: [
            ["Members", num(members.length)],
            ["Admins", num(members.filter((m) => m.role === "admin").length)],
            ["Managers", num(members.filter((m) => m.role === "manager").length)],
            ["Reps", num(members.filter((m) => m.role === "rep").length)],
            ...(permissions ? [["Teams", num(permissions.teams.length)] as SettingsFact] : []),
          ],
        }
      : { facts: [] },
    permissions: permissions
      ? {
          value: customized.length ? `${plural(customized.length, "role")} narrowed` : "Everyone sees everything",
          facts: permissions.roles.map((r): SettingsFact => [
            r.role === "other" ? "Other roles" : `${r.role[0].toUpperCase()}${r.role.slice(1)}s`,
            r.rules.length ? `${plural(r.rules.length, "object")} narrowed` : "Full access",
          ]),
        }
      : { value: permissions === null ? "" : undefined, facts: [] },
    billing: credits
      ? {
          value: `${num(credits.spendable)} credits`,
          facts: [
            ["Credits to spend", num(credits.spendable)],
            ["Free left this month", `${num(credits.free.left)} of ${num(credits.free.allowance)}`],
            ["Bought", num(credits.balance)],
          ],
        }
      : { value: credits === null ? "" : undefined, facts: [] },
    pipelines: pipelines
      ? {
          value: `${plural(pipelines.length, "pipeline")} · ${plural(pipelines.reduce((n, p) => n + p.stages.filter((st) => st.active).length, 0), "stage")}`,
          facts: pipelines.map((p): SettingsFact => [p.name, plural(p.stages.filter((st) => st.active).length, "stage")]),
        }
      : { value: pipelines === null ? "" : undefined, facts: [] },
    api: tokens
      ? {
          value: liveTokens.length ? plural(liveTokens.length, "paired CLI") : "None paired",
          facts: [["Paired", num(liveTokens.length)], ["Revoked or expired", num(tokens.length - liveTokens.length)]],
        }
      : { facts: [] },
    recording: recording
      ? {
          value: `${recording.consent === "explicit" ? "Explicit consent" : "Notice"} · ${recording.retentionDays} days`,
          facts: [["Consent", recording.consent === "explicit" ? "Explicit" : "Notice"], ["Internal meetings", recording.internalRecording ? "On" : "Off"], ["Retention", `${recording.retentionDays} days`], ["Region", recording.region.toUpperCase()], ["Dialer recording", recording.callRecording ? "On" : "Off"]],
        }
      : { value: recording === null ? "" : undefined, facts: [] },
    webhooks: webhooks
      ? {
          value: endpoints.length ? plural(endpoints.length, "endpoint") + (failing ? ` · ${num(failing)} failing` : "") : "None yet",
          facts: [
            ["Endpoints", num(endpoints.length)],
            ["Enabled", num(endpoints.filter((e) => e.enabled).length)],
            ...(failing ? [["Last delivery failed", num(failing)] as SettingsFact] : []),
          ],
        }
      : { value: webhooks === null ? "" : undefined, facts: [] },
    feeds: feeds
      ? feeds.canManage === false
        ? { value: plural(feeds.personal?.length ?? 0, "personal link"), facts: [["Your connected accounts", num(feeds.personal?.length ?? 0)]] }
        : {
          value: feeds.links.length ? plural(feeds.links.length, "link") + (feeds.links.some((l) => l.status !== "ok") ? ` · ${num(feeds.links.filter((l) => l.status !== "ok").length)} need attention` : "") : "None yet",
          facts: [
            ["Links", num(feeds.links.length)],
            ["Items in the last day", num(feeds.links.reduce((n, l) => n + l.items24h, 0))],
          ],
        }
      : { value: feeds === null ? "" : undefined, facts: [] },
    outbound: outbound
      ? {
          value: `${plural(outbound.modules.reduce((n, m) => n + m.channels.filter((c) => c.on).length, 0), "channel")} on${outbound.local ? " · local sink" : ""}`,
          facts: [
            ["Slack channels mapped", num(outbound.slack.length)],
            ["Webhook endpoints", num(outbound.webhooks.length)],
            ["Failed recently", num(outbound.rows.filter((r) => r.state === "failed" || r.state === "unknown").length)],
          ],
        }
      : outbound === null && mailboxGrantsAvailable ? { value: "My mailbox grants", facts: [["Mailbox consent", "Only you manage grants for your mailbox"]] }
        : { value: !outboundAvailable || outbound === null ? "" : undefined, facts: [] },
  };
}

/** The top of a settings area's own page: back to the table, its name and what it covers. */
export function SettingsPage({ area, children }: { area: SettingsKey; children: ReactNode }) {
  const def = settingsDef(area);
  return (
    <ViewFrame
      title={def.name}
      description={def.description}
      controls={
        <Link href={`/dashboard/settings?selected=${area}`} className="eyebrow inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Settings
        </Link>
      }
    >
      {children}
    </ViewFrame>
  );
}
