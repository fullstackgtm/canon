"use client";

import { IntegrationGate, IntegrationReport } from "@/components/integration-gate";
import { INTEGRATION_FEATURES } from "./catalog";
import { Suspense, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { toast } from "@/lib/toast";
import { ViewFrame } from "@/components/dashboard";
import { cn } from "@/lib/utils";
import { INTEGRATION_GROUPS, INTEGRATIONS, isIntegrationKey, type IntegrationKey } from "./catalog";
import { FirstSyncModal } from "./first-sync-modal";
import { IntegrationMark, StatusDot, statusTextClass, useIntegrationStatuses } from "./integration-ui";
import { IntegrationRail } from "./integration-rail";

const OAUTH_ERRORS: Record<string, string> = {
  invalid_callback: "CRM returned an invalid callback",
  invalid_state: "CRM connection expired. Try connecting again.",
  oauth_not_configured: "CRM OAuth is not configured",
  token_exchange_failed: "CRM token exchange failed",
  incomplete_token_response: "CRM returned an incomplete token response",
};

/** OAuth and hosted-login returns land here: toast the result and select the integration it was for. */
function useReturnParams(select: (key: IntegrationKey) => void) {
  const searchParams = useSearchParams();
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    const message = searchParams.get("message");
    if (connected === "hubspot" || connected === "salesforce") {
      toast.success(`${connected === "hubspot" ? "HubSpot" : "Salesforce"} connected. Initial sync has started.`);
      select(connected);
    }
    if (error) {
      if (error === "hubspot_oauth_failed") toast.error(message || "HubSpot authorization failed");
      else if (error === "salesforce_oauth_failed") toast.error(message || "Salesforce authorization failed");
      else toast.error(OAUTH_ERRORS[error] ?? message ?? error);
      if (error.startsWith("hubspot")) select("hubspot");
      if (error.startsWith("salesforce")) select("salesforce");
    }
    const gmail = searchParams.get("gmail");
    if (gmail === "connected") void toast.success("Mailbox linked. It shows here once Google or Microsoft confirms.");
    if (gmail === "failed") void toast.error("The mailbox wasn't linked. Try again.");
    if (gmail) select("gmail");
    const linkedin = searchParams.get("linkedin");
    if (linkedin === "connected") void toast.success("LinkedIn connected.");
    if (linkedin === "failed") void toast.error("LinkedIn wasn't connected. Try again.");
    if (linkedin) select("linkedin");
    // Only the first render's params are returns; later changes are our own selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function IntegrationsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const statuses = useIntegrationStatuses();

  const select = (key: IntegrationKey) => router.replace(`${pathname}?selected=${key}`, { scroll: false });
  useReturnParams(select);

  const requested = searchParams.get("selected");
  // With nothing chosen, open on whatever needs attention, else the first connected CRM, else HubSpot.
  const selected: IntegrationKey = isIntegrationKey(requested)
    ? requested
    : (INTEGRATIONS.find((item) => statuses[item.key].tone === "error" || statuses[item.key].tone === "attention")?.key ??
      INTEGRATIONS.find((item) => statuses[item.key].tone === "connected")?.key ??
      "hubspot");

  const connectedCount = INTEGRATIONS.filter((item) => ["connected", "syncing"].includes(statuses[item.key].tone)).length;
  const attentionCount = INTEGRATIONS.filter((item) => ["attention", "error"].includes(statuses[item.key].tone)).length;

  return (
    <ViewFrame
      title="Integrations"
      description={`${connectedCount} connected${attentionCount ? ` · ${attentionCount} need${attentionCount === 1 ? "s" : ""} attention` : ""}`}
    >
      <FirstSyncModal />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <nav className="overflow-hidden border border-border bg-card" aria-label="Integrations">
          <div aria-hidden className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-border px-4 py-2 text-xs text-muted-foreground">
            <span>Integration</span>
            <span className="pr-7">Status</span>
          </div>
          {INTEGRATION_GROUPS.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="eyebrow border-b border-border bg-muted/40 px-4 py-1.5 text-muted-foreground">{group.title}</h3>
              {group.items.map((item) => {
                const status = statuses[item.key];
                const active = item.key === selected;
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    data-testid={`integration-row-${item.key}`}
                    onClick={() => select(item.key)}
                    onDoubleClick={() => item.href && router.push(item.href)}
                    className={cn(
                      "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/50",
                      active && "bg-muted/70 shadow-[inset_2px_0_0_var(--primary)]",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <IntegrationMark integration={item.key} />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{item.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{status.detail ?? item.summary}</span>
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      {status.tone === "loading" ? (
                        <span className="h-3 w-20 animate-pulse bg-muted" />
                      ) : (
                        <span className={cn("flex items-center gap-2 whitespace-nowrap text-xs", statusTextClass(status.tone))}>
                          <StatusDot tone={status.tone} />
                          {status.label}
                        </span>
                      )}
                      <ChevronRight className={cn("h-4 w-4 text-muted-foreground/60", active && "text-foreground")} />
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </nav>

        {INTEGRATION_FEATURES[selected] ? <IntegrationGate feature={INTEGRATION_FEATURES[selected]} note><IntegrationRail integration={selected} status={statuses[selected]} /></IntegrationGate> : <IntegrationRail integration={selected} status={statuses[selected]} />}
      </div>
      <IntegrationReport />
    </ViewFrame>
  );
}

export default function IntegrationsPage() {
  return (
    <Suspense fallback={<ViewFrame title="Integrations"><p className="text-sm text-muted-foreground">Loading integrations...</p></ViewFrame>}>
      <IntegrationsContent />
    </Suspense>
  );
}
