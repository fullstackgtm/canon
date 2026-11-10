"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SF_SYNC_FAKE } from "./data";

const BASE = "/dashboard/integrations/salesforce";
export const SF_SYNC_TABS = [
  { href: BASE, label: "Connection" },
  { href: `${BASE}/import`, label: "Import" },
];

export function SyncNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Salesforce sync sections" className="flex flex-wrap gap-1 border-b border-border">
      {SF_SYNC_TABS.map((tab, i) => {
        const active = pathname === tab.href || (i > 0 && pathname.startsWith(`${tab.href}/`));
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

export function formatTime(ms?: number) {
  return ms ? new Date(ms).toLocaleString() : "—";
}

export function formatValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "(empty)";
  return typeof value === "string" ? value : JSON.stringify(value);
}
