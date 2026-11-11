"use client";

import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { CapabilityRow, ProviderId, ProviderRow } from "../../../../convex/lib/providers/registry";
import type { ProviderCost, ProviderLimit } from "../../../../modules/kernel/providers";
import { LoadingRows } from "@/components/dashboard";
import { DeeplineControls } from "../integrations/deepline-card";

const section = "space-y-3 border border-border bg-card p-4";

/** The form an admin sets a provider's workspace key with. Each stores the key sealed and never shows it again. */
const KEY_FORMS: Partial<Record<ProviderId, () => ReactNode>> = { deepline: () => <DeeplineControls /> };

export function costLabel(cost: ProviderCost, provider: string): string {
  if (cost === "free") return "Free";
  if (cost === "own_account") return `Billed by your ${provider} account`;
  return `${cost.credits} credit${cost.credits === 1 ? "" : "s"} per ${cost.per === "hit" ? "call that finds something" : "call"}`;
}

export function limitsLabel(limits: readonly ProviderLimit[]): string | null {
  if (!limits.length) return null;
  return limits.map((l) => `${l.max.toLocaleString("en-US")} ${l.counts === "hits" ? "hits" : "calls"} a ${l.per}`).join(", ");
}

function keySource(p: ProviderRow): string {
  const names = p.keys.map((k) => k.name).join(" and ");
  return p.source === "workspace" ? `This workspace's own key (${names})` : `The deployment's ${names}`;
}

export function ProvidersTab() {
  const settings = useQuery(api.providers.settings);
  if (settings === undefined) return <LoadingRows count={3} height="h-24" />;
  if (settings === null) return <p className="text-sm text-muted-foreground">Sign in to see this workspace's providers.</p>;
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-muted-foreground">
        A capability runs on this workspace&apos;s own key first, then on the deployment&apos;s. Keys show by name only.
      </p>
      {settings.capabilities.map((c) => <Capability key={c.capability} row={c} canManage={settings.canManage} />)}
    </div>
  );
}

function Capability({ row, canManage }: { row: CapabilityRow; canManage: boolean }) {
  const serving = row.providers.find((p) => p.serving);
  return (
    <section className={section} aria-label={row.label} data-testid={`capability-${row.capability}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">{row.label}</h2>
        <span className={`text-xs ${serving ? "text-foreground" : "text-muted-foreground"}`}>{serving ? `${serving.label} · ${costLabel(serving.cost, serving.label)}` : "Bring your own key"}</span>
      </div>
      {!serving && row.reason && <p className="text-xs text-muted-foreground">{row.reason}</p>}
      <ul className="divide-y divide-border border-t border-border">
        {row.providers.map((p) => {
          const form = KEY_FORMS[p.id];
          const limits = limitsLabel(p.limits);
          return (
            <li key={p.id} className="space-y-1 py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{p.label}</span>
                <span className="text-xs text-muted-foreground">{p.serving ? "Serving" : p.ready ? "Ready, runs if the first misses" : p.source === "workspace" ? "No key yet" : "Not set on this deployment"}</span>
              </div>
              <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Key</dt><dd>{keySource(p)}</dd>
                <dt className="text-muted-foreground">Cost</dt><dd>{costLabel(p.cost, p.label)}</dd>
                {limits && <><dt className="text-muted-foreground">Limits</dt><dd>{limits}</dd></>}
                {p.consent.map((consent) => <span key={consent.terms} className="contents"><dt className="text-muted-foreground">Consent</dt><dd>{consent.terms}</dd></span>)}
              </dl>
              {p.source === "workspace" && form && (canManage ? <div className="pt-2">{form()}</div> : <p className="text-xs text-muted-foreground">An admin or manager sets this key.</p>)}
              {p.source === "deployment" && !p.ready && <p className="text-xs text-muted-foreground">Whoever runs this deployment sets {p.keys.filter((k) => !k.set).map((k) => k.name).join(" and ")} in its environment.</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
