"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { sfSync, SF_SYNC_FAKE } from "./data";

const BASE = "/dashboard/integrations/salesforce";
export const SF_SYNC_TABS = [
  { href: BASE, label: "Connection" },
  { href: `${BASE}/import`, label: "Import" },
  { href: `${BASE}/fields`, label: "Field authority" },
  { href: `${BASE}/conflicts`, label: "Conflicts" },
];

export function SyncNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Salesforce sync sections" className="flex flex-wrap gap-1 border-b border-border">
      {SF_SYNC_TABS.map((tab) => {
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
      {SF_SYNC_FAKE && (
        <span className="ml-auto self-center rounded bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
          Fake data
        </span>
      )}
    </nav>
  );
}

export function Panel({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="mb-6 border border-border bg-card p-5">
      <h3 className="mb-3 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function ReadOnlyToggle() {
  const state = sfSync.useSyncState();
  const setReadOnly = sfSync.useSetReadOnly();
  if (state === undefined) return <p className="text-sm text-muted-foreground">Loading sync state…</p>;
  if (state === null) return <p className="text-sm text-muted-foreground">Sync has not been initialised for this workspace.</p>;
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium" id="sf-readonly-label">
          Read-only mode
        </p>
        <p className="max-w-[60ch] text-xs text-muted-foreground">
          When on, inbound changes from Salesforce keep arriving but nothing is written back to Salesforce.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <span data-testid="sf-readonly-status" className="text-xs font-medium">
          {state.readOnly ? "On" : "Off"}
        </span>
        <Switch
          aria-labelledby="sf-readonly-label"
          checked={state.readOnly}
          onCheckedChange={(checked) => void setReadOnly({ readOnly: checked })}
        />
      </div>
    </div>
  );
}

export function ReadOnlyBanner() {
  const state = sfSync.useSyncState();
  if (!state?.readOnly) return null;
  return (
    <div role="status" data-testid="sf-readonly-banner" className="mb-4 border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
      Read-only mode is on. Outbound writes to Salesforce are paused.
    </div>
  );
}

export function formatTime(ms?: number) {
  return ms ? new Date(ms).toLocaleString() : "—";
}

export function formatValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "(empty)";
  return typeof value === "string" ? value : JSON.stringify(value);
}
