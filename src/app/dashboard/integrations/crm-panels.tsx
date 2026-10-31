"use client";

import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ExternalLink, KeyRound, Loader2, RefreshCw, Square, Unplug } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { DataTable, EmptyState, LoadingRows, ProgressChip, StageTimeline } from "@/components/dashboard";
import { Panel } from "@/components/salesforce-sync/ui";
import { CRM_SYNC_STAGES } from "../../../../engine/src/progress";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { formatRelativeTime, statusMeta } from "./call-provider-card";
import { SelectField } from "@/components/ui/select";

export type CrmProvider = "hubspot" | "salesforce";

const NAME: Record<CrmProvider, string> = { hubspot: "HubSpot", salesforce: "Salesforce" };
const primary =
  "inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";
const secondary =
  "inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50";

/** The provider's connection and sync runs, from the one integrations query. */
export function useCrm(provider: CrmProvider) {
  const workspace = useQuery(api.integrations.context);
  const connection = workspace === undefined ? undefined : (workspace[provider] ?? null);
  const runs = workspace?.syncRuns.filter((run) => run.provider === provider);
  return { connection, runs, inFlight: runs?.find((run) => run.status === "in_progress") };
}

/** Last sync, live progress, Sync now and (for HubSpot) Disconnect. */
export function CrmSyncPanel({ provider, canDisconnect = false }: { provider: CrmProvider; canDisconnect?: boolean }) {
  const { connection, inFlight } = useCrm(provider);
  const syncHubspot = useAction(api.hubspotActions.syncAll);
  const syncSalesforce = useAction(api.salesforceActions.syncAll);
  const disconnectHubspot = useAction(api.hubspot.disconnectWithRevocation);
  const stopSync = useMutation(api.integrations.stopSync);
  const [busy, setBusy] = useState<"sync" | "stop" | "disconnect" | null>(null);

  if (!connection?.isActive) return null;
  const status = statusMeta(connection.lastSyncStatus);
  const StatusIcon = status.icon;

  async function sync() {
    setBusy("sync");
    try {
      const result = provider === "hubspot" ? await syncHubspot({}) : await syncSalesforce({});
      toast.success(
        provider === "hubspot"
          ? `HubSpot synced: ${result.accounts} companies, ${result.contacts} contacts, ${result.deals} deals.`
          : `Salesforce synced: ${result.accounts} accounts, ${result.contacts} contacts, ${result.deals} opportunities.`,
      );
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    setBusy("stop");
    try {
      await stopSync({ provider });
      toast.success(`${NAME[provider]} sync stopped`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm(`Disconnect ${NAME[provider]}? Sync stops until you reconnect.`)) return;
    setBusy("disconnect");
    try {
      await disconnectHubspot({});
      toast.success(`${NAME[provider]} disconnected`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel title="Sync" testId={`${provider}-sync`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Account</dt>
            <dd className="font-medium">{connection.displayName ?? NAME[provider]}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Status</dt>
            <dd className="inline-flex items-center gap-1.5 font-medium">
              <StatusIcon className={cn("h-3.5 w-3.5", connection.lastSyncStatus === "in_progress" && "animate-spin")} />
              {status.label}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Last sync</dt>
            <dd className="font-medium">{formatRelativeTime(connection.lastSyncAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Deals updated</dt>
            <dd className="font-medium tabular-nums">{connection.lastSyncDealCount ?? 0}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void sync()} disabled={busy !== null || connection.lastSyncStatus === "in_progress"} className={primary}>
            {busy === "sync" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync now
          </button>
          {connection.lastSyncStatus === "in_progress" && (
            <button onClick={() => void stop()} disabled={busy === "stop" || busy === "disconnect"} className={secondary}>
              {busy === "stop" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
              Stop sync
            </button>
          )}
          {canDisconnect && (
            <button onClick={() => void disconnect()} disabled={busy !== null} className={secondary}>
              {busy === "disconnect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
              Disconnect
            </button>
          )}
        </div>
      </div>
      {connection.lastSyncError && (
        <div className="mt-4 border border-warning/40 bg-warning/15 p-3 text-sm text-warning">{connection.lastSyncError}</div>
      )}
      {inFlight && (
        <div className="mt-4 border border-border/70 bg-background/40 px-3 py-2">
          <ProgressChip status={inFlight.status} progress={inFlight.progress} startedAt={inFlight.startedAt} />
          <StageTimeline stages={CRM_SYNC_STAGES} progress={inFlight.progress} className="mt-2" />
        </div>
      )}
    </Panel>
  );
}

/** HubSpot isn't connected yet: OAuth, or a private-app token. */
export function HubspotConnectPanel() {
  const getAuthUrl = useAction(api.hubspotActions.getAuthUrl);
  const connectWithToken = useAction(api.hubspotActions.connectWithToken);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"oauth" | "token" | null>(null);

  async function run(kind: "oauth" | "token", work: () => Promise<void>) {
    setBusy(kind);
    try {
      await work();
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel title="Connect" testId="hubspot-connect">
      <button
        onClick={() => void run("oauth", async () => {
          const result = await getAuthUrl({});
          window.open(result.authUrl, "_blank");
        })}
        disabled={busy !== null}
        className={primary}
      >
        {busy === "oauth" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
        Connect HubSpot
      </button>
      <form
        className="mt-4 space-y-2 border-t border-border/70 pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!token.trim()) return;
          void run("token", async () => {
            await connectWithToken({ token: token.trim() });
            setToken("");
            toast.success("HubSpot connected. Initial sync has started.");
          });
        }}
      >
        <p className="text-xs text-muted-foreground">
          Or connect with a HubSpot private-app token (CRM read scopes; for the full import, also sales-email-read and files):
        </p>
        <div className="flex max-w-xl gap-2">
          <input
            type="password"
            autoComplete="off"
            aria-label="HubSpot private-app token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="pat-na2-..."
            className="h-10 flex-1 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-primary"
          />
          <button type="submit" disabled={busy !== null || !token.trim()} className={secondary}>
            {busy === "token" ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Connect
          </button>
        </div>
      </form>
    </Panel>
  );
}

/** Sync schedule and provider field mappings. */
export function CrmSettingsPanel({ provider }: { provider: CrmProvider }) {
  const { connection } = useCrm(provider);
  const updateSettings = useMutation(api.integrations.updateSettings);
  const [schedule, setSchedule] = useState("manual");
  const [mappings, setMappings] = useState("{}");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!connection) return;
    setSchedule(connection.syncConfig?.schedule ?? "manual");
    setMappings(JSON.stringify(connection.fieldMappings ?? {}, null, 2));
  }, [connection]);

  if (!connection?.isActive) return null;

  async function save() {
    setSaving(true);
    try {
      await updateSettings({
        provider,
        schedule: schedule as "manual" | "daily" | "weekly" | "monthly",
        fieldMappings: mappings.trim() ? JSON.parse(mappings) : {},
      });
      toast.success(`${NAME[provider]} settings saved`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel title="Sync settings" testId={`${provider}-settings`}>
      <form className="grid max-w-2xl gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Schedule
          <SelectField
            size="default"
            aria-label="Sync schedule"
            value={schedule}
            onValueChange={setSchedule}
            className="w-48"
            options={[
              { value: "manual", label: "Manual" },
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
            ]}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Field mappings (JSON)
          <textarea
            value={mappings}
            onChange={(event) => setMappings(event.target.value)}
            rows={7}
            className="rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground"
          />
        </label>
        <div>
          <button type="submit" disabled={saving} className={primary}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save settings
          </button>
        </div>
      </form>
    </Panel>
  );
}

/** This provider's sync history. */
export function CrmSyncRunsPanel({ provider }: { provider: CrmProvider }) {
  const { runs } = useCrm(provider);
  return (
    <Panel title="Recent sync runs" testId={`${provider}-runs`}>
      {runs === undefined ? (
        <LoadingRows count={3} />
      ) : runs.length === 0 ? (
        <EmptyState icon={RefreshCw} title="No sync runs yet" description={`Run a sync to see what ${NAME[provider]} sent: counts, timing and errors.`} />
      ) : (
        <DataTable
          columns={[
            {
              key: "trigger",
              header: "Trigger",
              searchValue: (run) => run.trigger,
              sortValue: (run) => run.trigger,
              render: (run) => <span className="capitalize">{run.trigger}</span>,
            },
            {
              key: "status",
              header: "Status",
              sortValue: (run) => run.status,
              render: (run) => {
                const meta = statusMeta(run.status);
                const Icon = meta.icon;
                return (
                  <div className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium", meta.className)}>
                    <Icon className={cn("h-3.5 w-3.5", run.status === "in_progress" && "animate-spin")} />
                    {meta.label}
                  </div>
                );
              },
            },
            { key: "startedAt", header: "Started", sortValue: (run) => run.startedAt, render: (run) => formatRelativeTime(run.startedAt) },
            {
              key: "finishedAt",
              header: "Finished",
              sortValue: (run) => run.finishedAt ?? 0,
              render: (run) => (run.finishedAt ? formatRelativeTime(run.finishedAt) : <span className="text-muted-foreground">In progress</span>),
            },
            {
              key: "deals",
              header: "Deals",
              sortValue: (run) => Number(run.counts?.deals ?? 0),
              render: (run) => Number(run.counts?.deals ?? 0),
              className: "text-right tabular-nums",
            },
            {
              key: "accounts",
              header: "Accounts",
              sortValue: (run) => Number(run.counts?.accounts ?? 0),
              render: (run) => Number(run.counts?.accounts ?? 0),
              className: "text-right tabular-nums",
            },
            {
              key: "error",
              header: "Error",
              searchValue: (run) => run.error ?? "",
              render: (run) => <span className="line-clamp-2 text-xs text-muted-foreground">{run.error ?? "None"}</span>,
            },
          ]}
          data={runs}
          rowKey={(run) => run._id}
          searchPlaceholder="Search sync runs..."
          initialSort={{ key: "startedAt", direction: "desc" }}
        />
      )}
    </Panel>
  );
}
