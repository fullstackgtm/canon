"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { ExternalLink, History, KeyRound, Loader2, RefreshCw, Square, Unplug } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import { DataTable, EmptyState, LoadingRows, ProgressChip, StageTimeline } from "@/components/dashboard";
import { Panel } from "@/components/salesforce-sync/ui";
import { CRM_SYNC_STAGES } from "../../../../engine/src/progress";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { formatRelativeTime, statusMeta } from "./call-provider-card";
import { SelectField } from "@/components/ui/select";
import { chipProgress, OBJECT_LABEL, SyncObjectBars } from "./sync-object-bars";
import { useIntegrationAvailable } from "@/components/integration-gate";

export type CrmProvider = "hubspot" | "salesforce";

const NAME: Record<CrmProvider, string> = { hubspot: "HubSpot", salesforce: "Salesforce" };
const primary =
  "inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";
const secondary =
  "inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50";
type Schedule = "manual" | "hourly" | "daily" | "weekly" | "monthly";
const SCHEDULES: Array<{ value: Schedule; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

/** The provider's connection and sync runs, from the one integrations query. */
export function useCrm(provider: CrmProvider) {
  const workspace = useQuery(api.integrations.context);
  const connection = workspace === undefined ? undefined : (workspace[provider] ?? null);
  const runs = workspace?.syncRuns.filter((run) => run.provider === provider);
  return { connection, runs, inFlight: runs?.find((run) => run.status === "in_progress") };
}

/** Last sync, schedule, live progress, Sync now and (for HubSpot) Full resync and Disconnect. */
export function CrmSyncPanel({ provider, canDisconnect = false }: { provider: CrmProvider; canDisconnect?: boolean }) {
  const { connection, inFlight } = useCrm(provider);
  const syncHubspot = useAction(api.hubspotActions.syncAll);
  const syncSalesforce = useAction(api.salesforceActions.syncAll);
  const disconnectHubspot = useAction(api.hubspot.disconnectWithRevocation);
  const stopSync = useMutation(api.integrations.stopSync);
  const updateSettings = useMutation(api.integrations.updateSettings);
  const [busy, setBusy] = useState<"sync" | "full" | "stop" | "disconnect" | "schedule" | null>(null);

  if (!connection?.isActive) return null;
  const status = statusMeta(connection.lastSyncStatus);
  const StatusIcon = status.icon;
  const schedule: Schedule = connection.syncConfig?.schedule ?? "manual";
  // Monthly is no longer offered; a connection still on it keeps showing it until changed.
  const scheduleOptions = SCHEDULES.some((option) => option.value === schedule) ? SCHEDULES : [...SCHEDULES, { value: schedule, label: "Monthly" }];

  async function sync(full = false) {
    if (full && !window.confirm(`Run a full resync? It reads every ${NAME[provider]} record again rather than only those changed since the last sync, so it takes longer.`)) return;
    setBusy(full ? "full" : "sync");
    try {
      if (provider === "hubspot") {
        const result = await syncHubspot(full ? { full: true } : {});
        const changed = result.mode === "incremental" ? " changed" : "";
        // A large sync goes on in steps after this call returns; the panel shows its progress.
        if (result.continuing) toast.info("HubSpot sync is still running in the background. Its progress shows here until it finishes.");
        else toast.success(`HubSpot synced${changed}: ${result.accounts} companies, ${result.contacts} contacts, ${result.deals} deals.`);
      } else {
        const result = await syncSalesforce({});
        const changed = result.mode === "incremental" ? " changed" : "";
        if (result.continuing) toast.info("Salesforce sync is still running in the background. Its progress shows here until it finishes.");
        else toast.success(`Salesforce synced${changed}: ${result.accounts} accounts, ${result.contacts} contacts, ${result.deals} opportunities.`);
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function saveSchedule(next: string) {
    setBusy("schedule");
    try {
      await updateSettings({ provider, schedule: next as Schedule });
      toast.success(`${NAME[provider]} sync schedule set to ${next}`);
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
        <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-5">
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
            <dt className="text-xs text-muted-foreground">{OBJECT_LABEL[provider].deals} updated</dt>
            <dd className="font-medium tabular-nums">{connection.lastSyncDealCount ?? 0}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Schedule</dt>
            <dd>
              <SelectField
                aria-label="Sync schedule"
                value={schedule}
                onValueChange={(next) => void saveSchedule(next)}
                disabled={busy === "schedule"}
                className="w-32"
                options={scheduleOptions}
              />
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void sync()} disabled={busy !== null || connection.lastSyncStatus === "in_progress"} className={primary}>
            {busy === "sync" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync now
          </button>
          {provider === "hubspot" && (
            <button onClick={() => void sync(true)} disabled={busy !== null || connection.lastSyncStatus === "in_progress"} className={secondary}>
              {busy === "full" ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
              Full resync
            </button>
          )}
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
          <ProgressChip status={inFlight.status} progress={chipProgress(inFlight.progress, inFlight.objects, provider)} startedAt={inFlight.startedAt} />
          {inFlight.objects?.length
            ? <SyncObjectBars objects={inFlight.objects} provider={provider} className="mt-3" />
            : <StageTimeline stages={CRM_SYNC_STAGES} progress={inFlight.progress} className="mt-2" />}
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

/** Salesforce isn't connected yet: the workspace's own app key (client-credentials flow), or OAuth when this deployment has an app. */
export function SalesforceConnectPanel() {
  const oauthAvailable = useIntegrationAvailable("salesforce");
  const getAuthUrl = useAction(api.salesforceActions.getAuthUrl);
  const connectWithKey = useAction(api.salesforceActions.connectWithClientCredentials);
  const [domainUrl, setDomainUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState<"oauth" | "key" | null>(null);
  const ready = domainUrl.trim() && clientId.trim() && clientSecret.trim();
  const input = "h-10 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-primary";

  async function run(kind: "oauth" | "key", work: () => Promise<void>) {
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
    <Panel title="Connect" testId="sf-connect">
      {oauthAvailable && (
        <button
          onClick={() => void run("oauth", async () => {
            const { authUrl } = await getAuthUrl({});
            window.open(authUrl, "_blank");
          })}
          disabled={busy !== null}
          className={cn(primary, "mb-4")}
        >
          {busy === "oauth" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
          Connect Salesforce
        </button>
      )}
      <form
        className={cn("grid max-w-xl gap-2", oauthAvailable && "border-t border-border/70 pt-4")}
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          void run("key", async () => {
            await connectWithKey({ domainUrl: domainUrl.trim(), clientId: clientId.trim(), clientSecret: clientSecret.trim() });
            setClientSecret("");
            toast.success("Salesforce connected. Initial sync has started.");
          });
        }}
      >
        <p className="text-xs text-muted-foreground">
          {`${oauthAvailable ? "Or connect" : "Connect"} with your own Salesforce app: in Setup, create an External Client App with ` +
            "OAuth, the api scope and Client Credentials Flow enabled, and a run-as user with API access. Paste your My Domain " +
            "URL and the app's consumer key and secret."}
        </p>
        <input
          aria-label="Salesforce My Domain URL"
          autoComplete="off"
          value={domainUrl}
          onChange={(event) => setDomainUrl(event.target.value)}
          placeholder="https://acme.my.salesforce.com"
          className={input}
        />
        <input
          aria-label="Salesforce consumer key"
          autoComplete="off"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          placeholder="Consumer key"
          className={cn(input, "font-mono")}
        />
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            aria-label="Salesforce consumer secret"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            placeholder="Consumer secret"
            className={cn(input, "flex-1 font-mono")}
          />
          <button type="submit" disabled={busy !== null || !ready} className={secondary}>
            {busy === "key" ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Connect
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
              header: OBJECT_LABEL[provider].deals,
              sortValue: (run) => runCount(run, "deals") ?? 0,
              render: (run) => runCount(run, "deals") ?? <span className="text-muted-foreground">—</span>,
              className: "text-right tabular-nums",
            },
            {
              key: "accounts",
              header: OBJECT_LABEL[provider].accounts,
              sortValue: (run) => runCount(run, "accounts") ?? 0,
              render: (run) => runCount(run, "accounts") ?? <span className="text-muted-foreground">—</span>,
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

/**
 * A run's count of one object: its final count once it finished, else the records its per-object progress has done
 * so far (a running or stopped sync, as its bars show them); undefined when the run says neither.
 */
function runCount(run: { counts?: unknown; objects?: Array<{ object: string; done: number }> }, object: "accounts" | "deals"): number | undefined {
  const counts = run.counts as Record<string, unknown> | undefined;
  if (counts && counts[object] !== undefined) return Number(counts[object]);
  return run.objects?.find((o) => o.object === object)?.done;
}
