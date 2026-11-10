"use client";

import {
  AlertCircle,
  CheckCircle2,
  Clock,
  KeyRound,
  Loader2,
  RefreshCw,
  Unplug,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ProgressChip, type LiveProgress } from "@/components/dashboard/progress-chip";

export function formatRelativeTime(ts?: number) {
  if (!ts) return "Never";
  const minutes = Math.floor((Date.now() - ts) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function statusMeta(status?: string) {
  if (status === "success") {
    return {
      icon: CheckCircle2,
      label: "Healthy",
      className: "text-primary bg-primary/15 border-primary/40",
    };
  }
  if (status === "partial") {
    return {
      icon: AlertCircle,
      label: "Partial sync",
      className: "text-warning bg-warning/15 border-warning/40",
    };
  }
  if (status === "error") {
    return {
      icon: AlertCircle,
      label: "Needs attention",
      className: "text-destructive bg-destructive/15 border-destructive/40",
    };
  }
  if (status === "in_progress") {
    return {
      icon: Loader2,
      label: "Syncing",
      className: "text-muted-foreground bg-muted border-border",
    };
  }
  return {
    icon: Clock,
    label: "Connected",
    className: "text-muted-foreground bg-muted border-border",
  };
}

export type CallProviderKey = "granola" | "gong" | "chorus" | "fathom" | "avoma";

export type CallProviderConfig = {
  key: CallProviderKey;
  label: string;
  tagline: string;
  initials: string;
  /** Only Gong uses a key + secret pair; the rest are single-key. */
  requiresApiSecret: boolean;
  apiKeyPlaceholder: string;
  apiSecretPlaceholder?: string;
  /** Server-side defaults, surfaced as placeholders in the Advanced disclosure. */
  defaultInstanceUrl: string;
  defaultCallsPath: string;
};

export const CALL_PROVIDERS: CallProviderConfig[] = [
  {
    key: "avoma",
    label: "Avoma",
    initials: "AV",
    tagline: "Import the last 30 days of call transcripts, speakers and recordings.",
    requiresApiSecret: false,
    apiKeyPlaceholder: "Workspace API key",
    defaultInstanceUrl: "https://api.avoma.com/v1",
    defaultCallsPath: "/meetings/",
  },
  {
    key: "granola",
    label: "Granola",
    initials: "GR",
    tagline: "AI meeting notes — syncs meeting transcripts into Call Intelligence.",
    requiresApiSecret: false,
    apiKeyPlaceholder: "grn_...",
    defaultInstanceUrl: "https://public-api.granola.ai",
    defaultCallsPath: "/v1/notes",
  },
  {
    key: "gong",
    label: "Gong",
    initials: "GG",
    tagline: "Import sales call transcripts and recordings into Call Intelligence.",
    requiresApiSecret: true,
    apiKeyPlaceholder: "Access key",
    apiSecretPlaceholder: "Access key secret",
    defaultInstanceUrl: "https://api.gong.io",
    defaultCallsPath: "/v2/calls/transcripts",
  },
  {
    key: "chorus",
    label: "Chorus",
    initials: "CH",
    tagline: "Sync conversation transcripts, participants, and call metadata.",
    requiresApiSecret: false,
    apiKeyPlaceholder: "API key",
    defaultInstanceUrl: "https://api.chorus.ai",
    defaultCallsPath: "/v1/calls/transcripts",
  },
  {
    key: "fathom",
    label: "Fathom",
    initials: "FH",
    tagline: "Bring meeting transcripts and summaries into GTM call insights.",
    requiresApiSecret: false,
    apiKeyPlaceholder: "API key",
    defaultInstanceUrl: "https://api.fathom.video",
    defaultCallsPath: "/external/v1/calls",
  },
];

export type CallProviderFormState = {
  apiKey: string;
  apiSecret: string;
  instanceUrl: string;
  callsPath: string;
};

export function emptyCallProviderForm(): CallProviderFormState {
  return { apiKey: "", apiSecret: "", instanceUrl: "", callsPath: "" };
}

export type CallProviderConnection = {
  provider: string;
  isActive?: boolean;
  lastSyncAt?: number;
  lastSyncStatus?: string;
  lastSyncError?: string;
  lastSyncDealCount?: number;
};

/** The provider's in-flight sync run, when one is running (live heartbeat). */
export type CallProviderActiveRun = {
  status: string;
  startedAt: number;
  progress?: LiveProgress | null;
};

const inputClassName =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-primary";

export function CallProviderCard({
  config,
  connection,
  activeRun,
  loading,
  form,
  busy,
  onFormChange,
  onConnect,
  onSync,
  onDisconnect,
}: {
  config: CallProviderConfig;
  connection: CallProviderConnection | undefined;
  activeRun?: CallProviderActiveRun;
  loading: boolean;
  form: CallProviderFormState;
  busy: string | null;
  onFormChange: (field: keyof CallProviderFormState, value: string) => void;
  onConnect: () => void;
  onSync: () => void;
  onDisconnect: () => void;
}) {
  const connectionStatus = statusMeta(connection?.lastSyncStatus);
  const StatusIcon = connectionStatus.icon;
  const isConnected = Boolean(connection?.isActive);
  const isConnecting = busy === `${config.key}:connect`;
  const isSyncing = busy === `${config.key}:sync`;
  const isDisconnecting = busy === `${config.key}:disconnect`;

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-xs font-bold text-foreground">
            {config.initials}
          </div>
          <div>
            <h3 className="font-semibold">{config.label}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{config.tagline}</p>
          </div>
        </div>
        {isConnected && (
          <div
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              connectionStatus.className,
            )}
          >
            <StatusIcon
              className={cn(
                "h-3.5 w-3.5",
                connection?.lastSyncStatus === "in_progress" && "animate-spin",
              )}
            />
            {connectionStatus.label}
          </div>
        )}
      </div>

      {loading ? (
        <div className="mt-5 h-28 animate-pulse rounded-md border border-border bg-muted" />
      ) : isConnected ? (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="border-b border-border/70 py-3">
              <div className="text-xs text-muted-foreground">Last sync</div>
              <div className="mt-1 font-medium">
                {formatRelativeTime(connection?.lastSyncAt)}
              </div>
            </div>
            <div className="border-b border-border/70 py-3">
              <div className="text-xs text-muted-foreground">Calls imported</div>
              <div className="mt-1 font-medium">
                {connection?.lastSyncDealCount ?? 0}
              </div>
            </div>
          </div>
          {connection?.lastSyncError && (
            <div className="rounded-md border border-warning/40 bg-warning/15 p-3 text-sm text-warning">
              {connection.lastSyncError}
            </div>
          )}
          {activeRun && (
            <ProgressChip
              status={activeRun.status}
              progress={activeRun.progress}
              startedAt={activeRun.startedAt}
            />
          )}
          <div className="flex flex-wrap gap-3">
            <button
              onClick={onSync}
              disabled={isSyncing || connection?.lastSyncStatus === "in_progress"}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Sync calls
            </button>
            <button
              onClick={onDisconnect}
              disabled={isDisconnecting}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
            >
              {isDisconnecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Unplug className="h-4 w-4" />
              )}
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          <input
            type="password"
            value={form.apiKey}
            onChange={(event) => onFormChange("apiKey", event.target.value)}
            placeholder={config.apiKeyPlaceholder}
            className={inputClassName}
          />
          {config.requiresApiSecret && (
            <input
              type="password"
              value={form.apiSecret}
              onChange={(event) => onFormChange("apiSecret", event.target.value)}
              placeholder={config.apiSecretPlaceholder ?? "API secret"}
              className={inputClassName}
            />
          )}
          <details className="rounded-lg border border-border/70">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs text-muted-foreground">
              Advanced
            </summary>
            <div className="space-y-3 px-3 pb-3">
              <label className="grid gap-1.5 text-xs text-muted-foreground">
                Base API URL
                <input
                  value={form.instanceUrl}
                  onChange={(event) => onFormChange("instanceUrl", event.target.value)}
                  placeholder={config.defaultInstanceUrl}
                  className={inputClassName}
                />
              </label>
              <label className="grid gap-1.5 text-xs text-muted-foreground">
                Calls/transcripts path
                <input
                  value={form.callsPath}
                  onChange={(event) => onFormChange("callsPath", event.target.value)}
                  placeholder={config.defaultCallsPath}
                  className={inputClassName}
                />
              </label>
            </div>
          </details>
          <button
            onClick={onConnect}
            disabled={isConnecting || !form.apiKey.trim()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {isConnecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            Connect {config.label}
          </button>
        </div>
      )}
    </div>
  );
}
