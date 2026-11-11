"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";
import type { TurnOn, TurnOnCall } from "../../../../../convex/lib/workspaceArchive/actors";
import { ViewFrame } from "@/components/dashboard";
import { getErrorMessage } from "@/lib/utils";
import { toast } from "@/lib/toast";

type Item = { mechanism: string; does: string; table: string; id: string; name: string; arrived: string; turnOn: TurnOn };

/**
 * After an import, everything it brought switched off and still off (convex/workspaceImport.ts arrivals, built from
 * the census in convex/lib/workspaceArchive/actors.ts). Each row turns on through the thing's own switch: the same
 * mutation its own page calls, or a link to that page where the switch needs a choice or runs on a person's plan.
 */
export default function ArrivedOffPage() {
  const data = useQuery(api.workspaceImport.arrivals);
  const calls: Record<TurnOnCall, (args: never) => Promise<unknown>> = {
    "automations.setStatus": useMutation(api.automations.setStatus),
    "leadScoring.updateRoutingRule": useMutation(api.leadScoring.updateRoutingRule),
    "agents.setPaused": useMutation(api.agents.setPaused),
  };
  const [busy, setBusy] = useState<string | null>(null);
  const turnOn = (item: Item, t: Extract<TurnOn, { kind: "call" }>) => {
    setBusy(item.id);
    calls[t.call](t.args as never)
      .then(() => toast.success(`${item.name} is on`))
      .catch((cause) => toast.error(getErrorMessage(cause)))
      .finally(() => setBusy(null));
  };
  const groups = new Map<string, Item[]>();
  for (const item of (data?.items ?? []) as Item[]) groups.set(item.does, [...(groups.get(item.does) ?? []), item]);
  return (
    <ViewFrame
      title="Arrived off"
      description="What the workspace import brought switched off and is still off. Nothing here sends, calls or acts until you turn it on, and each turns on through its own switch, so it runs on what happens from then on."
      controls={
        <Link href="/dashboard/settings/workspace" className="eyebrow inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Workspace
        </Link>
      }
    >
      {data === undefined ? null : data === null ? (
        <p className="text-sm text-muted-foreground">Only an admin sees what an import brought.</p>
      ) : !data.importedAt ? (
        <p className="text-sm text-muted-foreground">This workspace hasn&apos;t taken an import.</p>
      ) : !data.items.length ? (
        <p className="text-sm text-muted-foreground">Everything the import brought switched off is on again, or was history.</p>
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">
            Imported {new Date(data.importedAt).toLocaleString()}. {data.items.length} {data.items.length === 1 ? "thing is" : "things are"} off.
          </p>
          {[...groups].map(([does, items]) => (
            <section key={does} aria-label={does} className="space-y-2">
              <h2 className="text-sm font-medium">{does[0].toUpperCase() + does.slice(1)}</h2>
              <ul className="divide-y divide-border border border-border">
                {items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{item.name}</p>
                      <p className="text-xs text-muted-foreground">{item.arrived[0].toUpperCase() + item.arrived.slice(1)}.</p>
                    </div>
                    {item.turnOn.kind === "call" ? (
                      <button type="button" className="inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                        disabled={busy !== null} onClick={() => turnOn(item, item.turnOn as Extract<TurnOn, { kind: "call" }>)}>
                        Turn on
                      </button>
                    ) : (
                      <Link href={item.turnOn.href} className="text-xs font-medium text-primary hover:underline">{item.turnOn.label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </ViewFrame>
  );
}
