"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { StatusBadge } from "@/components/dashboard";
import { SelectField } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import type { Rule } from "./automations";

type Catalog = NonNullable<FunctionReturnType<typeof api.signalWatches.catalog>>;
type Watching = NonNullable<Catalog["templates"][number]["watching"]>;

const btn = "border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40";
const MANUAL = "";

/**
 * Signals (docs/signal-automations.md, S4): the starter questions Canon asks each account weekly, with a switch per
 * signal, the accounts it watches, and its rule's last run. A watch is an AI field plus a rule, so the rule also
 * appears in the list below, and the answers on Accounts.
 */
export function Signals({ rules, onSelect }: { rules: readonly Rule[]; onSelect: (id: string) => void }) {
  const data = useQuery(api.signalWatches.catalog);
  const icps = useQuery(api.icps.list);
  const watch = useMutation(api.signalWatches.watch);
  const setScope = useMutation(api.signalWatches.setScope);
  const setStatus = useMutation(api.automations.setStatus);
  const [busy, setBusy] = useState<string | null>(null);
  /** The scope picked for a signal not watched yet, used when it is watched. */
  const [pending, setPending] = useState<Record<string, string>>({});
  if (!data) return null;
  const scopes = [
    { value: MANUAL, label: "Accounts I run it on" },
    ...(icps?.icps ?? []).map((i) => ({ value: String(i._id), label: `ICP: ${i.name}` })),
  ];
  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    try {
      await fn();
      void toast.success(done);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }
  const scopeValue = (w: Watching | null) => (w?.scope && "icpId" in w.scope && typeof w.scope.icpId === "string" ? w.scope.icpId : MANUAL);
  const rows = [
    ...[...data.templates].sort((a, b) => Number(b.suggested) - Number(a.suggested)).map((t) => ({ id: t.key, label: t.label, question: t.question, suggested: t.suggested, jobs: t.source === "job_boards", watching: t.watching })),
    ...data.custom.map((c) => ({ id: c.slug, label: c.label, question: c.question, suggested: false, jobs: false, watching: c as Watching })),
  ];

  return (
    <section id="signals" className="space-y-3 border border-border bg-card p-4" aria-label="Signals" data-testid="automation-signals">
      <div>
        <h2 className="font-medium">Signals</h2>
        <p className="text-sm text-muted-foreground">
          Canon asks each watched account a yes-or-no question every week, from public pages with quotes, on the field owner&apos;s ChatGPT plan (signals marked “from job boards” read the daily job-board check instead, with no AI).
          When an answer turns yes, the account&apos;s owner gets a task. New rules start paused: turn one on when its first answers look right.
        </p>
      </div>
      <ul className="divide-y divide-border border border-border" aria-label="Signal watches">
        {rows.map((row) => {
          const w = row.watching;
          const rule = w?.ruleId ? rules.find((r) => r.id === w.ruleId) : undefined;
          const scope = w ? scopeValue(w) : pending[row.id] ?? MANUAL;
          const starter = data.templates.some((t) => t.key === row.id);
          return (
            <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 p-3" data-testid="signal-row">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {row.label}
                  {row.suggested && !w && <span className="border border-border px-1 text-xs font-normal text-muted-foreground">Suggested</span>}
                  {row.jobs && <span className="border border-border px-1 text-xs font-normal text-muted-foreground">From job boards, no AI</span>}
                  {rule && <StatusBadge status={rule.status} label={rule.status === "active" ? "Tasks on" : "Tasks paused"} />}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{row.question}</p>
                {rule && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {rule.lastRun ? `Last fired ${new Date(rule.lastRun.at).toLocaleString()}` : "Not fired yet"}
                    {" · "}
                    <button type="button" className="underline" onClick={() => onSelect(rule.id)}>Rule and runs</button>
                    {" · "}
                    <Link className="underline" href="/dashboard/fields">Answers</Link>
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(w || data.canInstall) && (
                  <SelectField
                    aria-label={`Accounts for ${row.label}`}
                    value={scope}
                    disabled={busy !== null || (!!w && !data.canInstall)}
                    onValueChange={(value) => {
                      if (!w) return setPending((p) => ({ ...p, [row.id]: value }));
                      void run(row.id, () => setScope({ slug: w.slug, filter: value ? { icpId: value } : null }), value ? "It asks those accounts within the hour" : "It asks only the accounts you run it on");
                    }}
                    options={scopes}
                  />
                )}
                {!w && data.canInstall && (
                  <button type="button" className={btn} disabled={busy !== null}
                    onClick={() => void run(row.id, () => watch({ ...(starter ? { key: row.id } : { label: row.label, question: row.question }), ...(scope ? { filter: { icpId: scope } } : {}) }), "Watching. Its rule starts paused.")}>
                    Watch
                  </button>
                )}
                {rule && (
                  <button type="button" className={btn} disabled={busy !== null}
                    onClick={() => void run(row.id, () => setStatus({ id: rule.id as Id<"automationRules">, status: rule.status === "active" ? "paused" : "active" }), rule.status === "active" ? "Tasks paused" : "Tasks on")}>
                    {rule.status === "active" ? "Pause tasks" : "Turn on tasks"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {!data.canInstall && <p className="text-xs text-muted-foreground">An admin who can edit strategy and automations turns signals on.</p>}
    </section>
  );
}
