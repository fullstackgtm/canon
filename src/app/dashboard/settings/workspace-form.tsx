"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Building2,
  CalendarRange,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { api } from "../../../../convex/_generated/api";
import { LoadingRows, StatusBadge } from "@/components/dashboard";
import { cn } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";
import { fiscalMonth } from "../../../../convex/lib/reports/pacing";
import { formatMoney, moneyDecimals } from "../../../../modules/kernel/text";

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD"];
/** Every IANA zone the browser knows, grouped by region (America, Europe, ...), with the saved one kept if it isn't listed. */
function timezoneOptions(current: string) {
  const zones: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const all = zones.includes(current) || !current ? zones : [current, ...zones];
  const region = (zone: string) => (zone.includes("/") ? zone.slice(0, zone.indexOf("/")) : "Other");
  return [...all]
    .sort((a, b) => region(a).localeCompare(region(b)) || a.localeCompare(b))
    .map((zone) => ({ value: zone, label: zone.replace(/_/g, " ").replace(/\//g, " / "), group: region(zone) }));
}
const HIERARCHY_SOURCES = ["hubspot", "salesforce", "csv", "manual"] as const;
const SYNC_SCHEDULES = ["daily", "weekly", "monthly"] as const;

type HierarchySource = (typeof HIERARCHY_SOURCES)[number];
type SyncSchedule = (typeof SYNC_SCHEDULES)[number];

export function titleCase(value?: string) {
  if (!value) return "Not set";
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatRelativeTime(timestamp?: number) {
  if (!timestamp) return "Never";
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const today = () => new Date().toISOString().slice(0, 10);

export function fiscalYearLabel(startMonth: number) {
  return `FY${String(fiscalMonth(today(), startMonth).fy).slice(-2)}`;
}

export function fiscalQuarterLabel(startMonth: number) {
  return `Q${Math.floor(fiscalMonth(today(), startMonth).m / 3) + 1}`;
}

function connectionStatus(connection: { isActive: boolean; lastSyncStatus?: string } | null | undefined) {
  if (connection === undefined) return "loading";
  if (!connection?.isActive) return "inactive";
  return connection.lastSyncStatus ?? "active";
}

/** Settings, Workspace: the organization's operating defaults (fiscal calendar, currency, timezone, CRM cadence). */
export function WorkspaceForm() {
  const organizationWorkspace = useQuery(api.organizations.context);
  const integrationWorkspace = useQuery(api.integrations.context);
  const org = organizationWorkspace?.organization;
  const hubspot = integrationWorkspace?.hubspot;
  const salesforce = integrationWorkspace?.salesforce;
  const updateSettings = useMutation(api.organizations.updateSettings);

  // The saved values, and the form's: null until the workspace has loaded, so nothing can be saved from defaults.
  const saved = useMemo(() => (org ? {
    name: org.name,
    industry: org.industry ?? "",
    fiscalYearStartMonth: org.fiscalYearStartMonth || 1,
    defaultCurrency: org.defaultCurrency,
    currencyDecimals: moneyDecimals(org.currencyDecimals),
    timezone: org.timezone,
    syncSchedule: (org.syncSchedule ?? "daily") as SyncSchedule,
    hierarchySource: (org.hierarchySource ?? "hubspot") as HierarchySource,
  } : null), [org]);
  type Draft = NonNullable<typeof saved>;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(saved), [saved]);
  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
  const dirty = Boolean(draft && saved && (Object.keys(draft) as Array<keyof Draft>).some((k) => draft[k] !== saved[k]));
  const { name, industry, fiscalYearStartMonth, defaultCurrency, currencyDecimals, timezone, syncSchedule, hierarchySource } = draft ?? saved ?? {
    name: "", industry: "", fiscalYearStartMonth: 1, defaultCurrency: "USD", currencyDecimals: 2, timezone: "", syncSchedule: "daily" as SyncSchedule, hierarchySource: "hubspot" as HierarchySource,
  };
  const timezones = useMemo(() => timezoneOptions(timezone), [timezone]);

  const fiscalPreview = useMemo(
    () => ({
      year: fiscalYearLabel(fiscalYearStartMonth),
      quarter: fiscalQuarterLabel(fiscalYearStartMonth),
      start: MONTHS[fiscalYearStartMonth - 1],
    }),
    [fiscalYearStartMonth],
  );

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!org || !draft || !dirty) return;

    setSaving(true);
    try {
      await updateSettings(draft);
      toast.success("Settings saved");
    } catch (error: any) {
      toast.error(error?.data ?? error?.message ?? "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  if (org === undefined) return <LoadingRows count={4} height="h-24" />;

  if (org === null) {
    return (
        <section className="rounded-xl border border-border bg-card p-8 text-center">
          <ShieldCheck className="mx-auto h-10 w-10 text-muted-foreground opacity-40" />
          <h2 className="mt-3 text-lg font-semibold">No organization context</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with an organization to edit operating defaults.
          </p>
        </section>
    );
  }

  const hubspotStatus = connectionStatus(hubspot);
  const salesforceStatus = connectionStatus(salesforce);
  const canEdit = org.currentUserRole === "admin" || org.currentUserRole === "manager";

  return (
    <div>
      <form onSubmit={handleSave} className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_380px]">
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Organization Defaults</h2>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Organization name
              <input
                value={name}
                onChange={(event) => set("name")(event.target.value)}
                disabled={!canEdit}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Industry
              <input
                value={industry}
                onChange={(event) => set("industry")(event.target.value)}
                disabled={!canEdit}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Fiscal year starts
              <SelectField
                size="default"
                value={String(fiscalYearStartMonth)}
                onValueChange={(v) => set("fiscalYearStartMonth")(Number(v))}
                disabled={!canEdit}
                className="w-full font-normal"
                options={MONTHS.map((month, index) => ({ value: String(index + 1), label: month }))}
              />
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Currency
              <SelectField
                size="default"
                value={defaultCurrency}
                onValueChange={set("defaultCurrency")}
                disabled={!canEdit}
                className="w-full font-normal"
                options={CURRENCIES.map((currency) => ({ value: currency, label: currency }))}
              />
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Currency decimal places
              <SelectField
                size="default"
                value={String(currencyDecimals)}
                onValueChange={(v) => set("currencyDecimals")(Number(v))}
                disabled={!canEdit}
                className="w-full font-normal"
                options={[0, 1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
              />
              <span className="text-xs font-normal text-muted-foreground">Money shows as {formatMoney(123456789, defaultCurrency, currencyDecimals)}</span>
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Timezone
              <SelectField
                size="default"
                value={timezone}
                onValueChange={set("timezone")}
                disabled={!canEdit}
                className="w-full font-normal"
                options={timezones}
              />
            </label>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">CRM Defaults</h2>
          </div>

          <div className="mt-5 grid gap-4">
            <label className="grid gap-1.5 text-sm font-medium">
              Hierarchy source
              <SelectField
                size="default"
                value={hierarchySource}
                onValueChange={(v) => set("hierarchySource")(v as HierarchySource)}
                disabled={!canEdit}
                className="w-full font-normal"
                options={HIERARCHY_SOURCES.map((source) => ({ value: source, label: titleCase(source) }))}
              />
            </label>

            <label className="grid gap-1.5 text-sm font-medium">
              Default sync cadence
              <SelectField
                size="default"
                value={syncSchedule}
                onValueChange={(v) => set("syncSchedule")(v as SyncSchedule)}
                disabled={!canEdit}
                className="w-full font-normal"
                options={SYNC_SCHEDULES.map((schedule) => ({ value: schedule, label: titleCase(schedule) }))}
              />
            </label>

            <div className="border-t border-border/70 pt-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">HubSpot</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Synced {formatRelativeTime(hubspot?.lastSyncAt)}
                  </div>
                </div>
                <StatusBadge status={hubspotStatus} />
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Salesforce</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Synced {formatRelativeTime(salesforce?.lastSyncAt)}
                  </div>
                </div>
                <StatusBadge status={salesforceStatus} />
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-6 xl:col-span-2">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="border-t border-border/70 pt-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CalendarRange className="h-4 w-4 text-muted-foreground" />
                Fiscal calendar
              </div>
              <div className="mt-3 text-2xl font-bold">
                {fiscalPreview.year} {fiscalPreview.quarter}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Starts in {fiscalPreview.start}
              </p>
            </div>

            <div className="border-t border-border/70 pt-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <RefreshCw className="h-4 w-4 text-muted-foreground" />
                CRM cadence
              </div>
              <div className="mt-3 text-2xl font-bold">{titleCase(syncSchedule)}</div>
              <p className="mt-1 text-xs text-muted-foreground">
                Source: {titleCase(hierarchySource)}
              </p>
            </div>

            <div className="border-t border-border/70 pt-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Last hierarchy sync
              </div>
              <div className="mt-3 text-2xl font-bold">
                {formatRelativeTime(org.hierarchySyncedAt)}
              </div>
            </div>
          </div>

          <div className="mt-6 flex items-center justify-between gap-4 border-t border-border pt-5">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              <span>Defaults apply across revenue reporting, health checks, and CRM sync.</span>
            </div>
            <button
              type="submit"
              disabled={!canEdit || saving || !draft || !dirty}
              title={!draft ? "Loading the workspace's settings" : !dirty ? "Nothing changed" : undefined}
              className={cn(
                "inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save settings
            </button>
          </div>
        </section>
      </form>
    </div>
  );
}
