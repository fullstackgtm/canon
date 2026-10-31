"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";

type ImportObject = "companies" | "contacts" | "deals" | "links" | "engagements" | "custom" | "history";

const CHOICES: ReadonlyArray<{ object: ImportObject; label: string; detail: string; count?: "companies" | "contacts" | "deals" }> = [
  { object: "companies", label: "Companies", detail: "with their owners", count: "companies" },
  { object: "contacts", label: "People", detail: "with lifecycle stage, lead status and owner", count: "contacts" },
  { object: "deals", label: "Deals", detail: "with HubSpot's pipelines and stages, owners and created dates", count: "deals" },
  { object: "links", label: "Links", detail: "every company a person is at (and the primary one), parent companies, people on deals in their roles" },
  {
    object: "engagements", label: "Activities",
    detail: "calls, meetings, notes (with attachment links) and tasks on the timelines of the records they are about, with their dates and owners; emails logged on their people's timelines. Needs the sales-email-read and files scopes for emails and attachments; without them those are skipped and the screen says so.",
  },
  { object: "custom", label: "Custom properties", detail: "your portal's own company, person and deal properties, as custom fields of the same type with their values" },
  { object: "history", label: "Field history", detail: "past values of lifecycle stage, deal stage, amount and owner, dated, in each record's history" },
];

/** The steps a run goes through, as the screen names them (lib/hubspotImport.ts PHASES). */
const STEPS: ReadonlyArray<{ phase: string; label: string }> = [
  { phase: "owners", label: "Owners" },
  { phase: "pipelines", label: "Pipelines" },
  { phase: "properties", label: "Custom fields" },
  { phase: "companies", label: "Companies" },
  { phase: "contacts", label: "People" },
  { phase: "deals", label: "Deals" },
  { phase: "parents", label: "Parent companies" },
  { phase: "contactCompanies", label: "People at companies" },
  { phase: "dealContacts", label: "People on deals" },
  { phase: "calls", label: "Calls" },
  { phase: "meetings", label: "Meetings" },
  { phase: "notes", label: "Notes" },
  { phase: "tasks", label: "Tasks" },
  { phase: "emails", label: "Emails" },
];

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="mb-6 border border-border bg-card p-5">
      <h3 className="mb-3 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

const n = (x: number) => x.toLocaleString("en-US");

/**
 * The HubSpot section of the CRM import screen: pick what to bring across, run it, watch each step, then read the
 * per-object results, failures, owners nobody in the workspace matches, and a 50-record spot check. Written so a
 * Salesforce section (CP11) can sit beside it on the same screen.
 */
export function HubspotImport() {
  const state = useQuery(api.hubspotImport.latest, {});
  const start = useMutation(api.hubspotImport.start);
  const resume = useMutation(api.hubspotImport.resume);
  const portalCounts = useAction(api.hubspotImportActions.portalCounts);
  const spotCheck = useAction(api.hubspotImportActions.spotCheck);
  const [picked, setPicked] = useState<ImportObject[]>(["companies", "contacts", "deals", "links", "engagements", "custom", "history"]);
  const [counts, setCounts] = useState<Record<string, number | null> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const connected = state?.connected === true;

  useEffect(() => {
    if (!connected) return;
    portalCounts({}).then(setCounts).catch((error) => { console.warn("HubSpot counts unavailable", getErrorMessage(error)); setCounts(null); });
  }, [connected, portalCounts]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (state === undefined) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (state === null) return null;
  if (!connected) {
    return (
      <Section title="HubSpot" testId="hubspot-import">
        <p className="text-sm text-muted-foreground">
          <Link className="underline" href="/dashboard/integrations/hubspot">Connect HubSpot</Link> first. The import only reads your portal; it never writes to HubSpot.
        </p>
      </Section>
    );
  }

  const run = state.run;
  const running = run?.status === "running" && !run.stale;
  const stopped = run !== null && (run.status === "failed" || run.stale);
  const steps = run ? STEPS.filter((s) => s.phase === "owners" || stepNeeded(s.phase, run.objects as ImportObject[])) : [];
  const at = run ? steps.findIndex((s) => s.phase === run.phase) : -1;
  const records = run ? run.results.filter((r) => ["companies", "contacts", "deals"].includes(r.object)).reduce((sum, r) => sum + r.written, 0) : 0;
  const seconds = run ? ((run.finishedAt ?? run.heartbeatAt) - run.startedAt) / 1000 : 0;
  const unmatched = run?.owners.filter((o) => !o.member) ?? [];

  return (
    <div data-testid="hubspot-import">
      <Section title={`Bring ${state.displayName ?? "HubSpot"} across`}>
        <p className="mb-4 text-sm text-muted-foreground">
          Reads your whole portal and writes it into Canon. Running it again updates what changed and never duplicates a record. Nothing is written to HubSpot.
        </p>
        <div className="mb-4 space-y-2">
          {CHOICES.map((c) => (
            <label key={c.object} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                data-testid={`hubspot-import-pick-${c.object}`}
                checked={picked.includes(c.object)}
                disabled={running}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.object] : p.filter((x) => x !== c.object)))}
              />
              <span>
                <span className="font-medium">{c.label}</span>
                {c.count && counts?.[c.count] != null ? <span className="text-muted-foreground"> · {n(counts[c.count]!)} in HubSpot</span> : null}
                <span className="block text-xs text-muted-foreground">{c.detail}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="hubspot-import-start"
            disabled={!state.canImport || busy !== null || running || picked.length === 0}
            onClick={() => act("start", () => start({ objects: picked }))}
          >
            {running ? "Import running…" : run ? "Run the import again" : "Start the import"}
          </Button>
          {stopped && run ? (
            <Button variant="outline" disabled={busy !== null} onClick={() => act("resume", () => resume({ runId: run._id as Id<"crmImports"> }))}>
              Resume from {STEPS.find((s) => s.phase === run.phase)?.label ?? run.phase}
            </Button>
          ) : null}
        </div>
        {!state.canImport ? <p className="mt-2 text-xs text-muted-foreground">Only admins and managers can run an import.</p> : null}
      </Section>

      {run ? (
        <Section title="Progress" testId="hubspot-import-progress">
          <ol className="mb-4 grid grid-cols-2 gap-1 text-sm sm:grid-cols-4">
            {steps.map((s, i) => {
              const done = run.status === "completed" || i < at;
              const current = run.status !== "completed" && i === at;
              return (
                <li key={s.phase} className={cn("flex items-center gap-2", done ? "text-foreground" : current ? "font-medium" : "text-muted-foreground")}>
                  <span className={cn("inline-block h-2 w-2 rounded-full", done ? "bg-emerald-500" : current ? (stopped ? "bg-red-500" : "animate-pulse bg-amber-500") : "bg-muted")} />
                  {s.label}
                </li>
              );
            })}
          </ol>
          <p className="mb-3 text-sm" data-testid="hubspot-import-status">
            {run.status === "completed"
              ? `Done: ${n(records)} records in ${seconds.toFixed(1)} s (${n(Math.round(records / Math.max(seconds, 0.001)))} a second).`
              : stopped
                ? `Stopped${run.error ? `: ${run.error}` : " (no progress for 10 minutes)"}. Resume carries on from where it was.`
                : "Running…"}
          </p>
          <table className="w-full text-sm" data-testid="hubspot-import-results">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="py-1">Object</th><th className="text-right">Read</th><th className="text-right">Written</th><th className="text-right">Failed</th></tr>
            </thead>
            <tbody>
              {run.results.map((r) => (
                <tr key={r.object} className="border-t border-border">
                  <td className="py-1.5 capitalize">{r.object}</td>
                  <td className="text-right">{n(r.read)}</td>
                  <td className="text-right">{n(r.written)}</td>
                  <td className={cn("text-right", r.failed > 0 && "text-red-600")}>{n(r.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {run.notices.length ? (
            <ul className="mt-3 space-y-1 text-sm text-amber-700 dark:text-amber-400" data-testid="hubspot-import-notices">
              {run.notices.map((x) => <li key={`${x.object}:${x.message}`}><span className="capitalize">{x.object}</span>: {x.message}</li>)}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {run && run.owners.length ? (
        <Section title="Owners" testId="hubspot-import-owners">
          <p className="mb-3 text-sm text-muted-foreground">
            {unmatched.length
              ? `${unmatched.length} of ${run.owners.length} HubSpot owners match no one in this workspace by email. A placeholder for each holds their records (a deactivated owner's have no owner); reassign those records to a member in Canon.`
              : `All ${run.owners.length} HubSpot owners match a member by email.`}
          </p>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="py-1">HubSpot owner</th><th>Email</th><th>In Canon</th><th className="text-right">Records</th></tr>
            </thead>
            <tbody>
              {run.owners.map((o) => (
                <tr key={o.crmOwnerId} className="border-t border-border" data-testid={`hubspot-owner-${o.crmOwnerId}`}>
                  <td className="py-1.5">{o.name}{o.archived ? <span className="text-muted-foreground"> (deactivated)</span> : null}</td>
                  <td>{o.email ?? "—"}</td>
                  <td className={cn(!o.member && "text-amber-700 dark:text-amber-400")}>{o.member ? "Member" : o.archived ? "Not mapped: deactivated in HubSpot" : "Not mapped: no member has this email"}</td>
                  <td className="text-right">{o.member ? "—" : n(o.records)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}

      {run && run.failures.length ? (
        <Section title="Failures" testId="hubspot-import-failures">
          <ul className="space-y-1 text-sm">
            {run.failures.map((f, i) => <li key={i}><span className="capitalize">{f.object}</span> · HubSpot {f.id}: {f.message}</li>)}
          </ul>
        </Section>
      ) : null}

      {run?.status === "completed" ? (
        <Section title="Spot check" testId="hubspot-import-spot-check">
          <p className="mb-3 text-sm text-muted-foreground">Reads 50 records of each object from HubSpot again and compares them field by field with what Canon now holds.</p>
          <Button variant="outline" data-testid="hubspot-spot-check-run" disabled={busy !== null} onClick={() => act("spot", () => spotCheck({ runId: run._id as Id<"crmImports"> }))}>
            {busy === "spot" ? "Checking…" : run.spotCheck ? "Check again" : "Run the spot check"}
          </Button>
          {run.spotCheck ? (
            <div className="mt-4">
              <table className="w-full text-sm" data-testid="hubspot-spot-check-table">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="py-1">Object</th><th className="text-right">Records</th><th className="text-right">Fields compared</th><th className="text-right">Mismatches</th></tr>
                </thead>
                <tbody>
                  {run.spotCheck.objects.map((o) => (
                    <tr key={o.object} className="border-t border-border">
                      <td className="py-1.5 capitalize">{o.object}</td>
                      <td className="text-right">{n(o.sampled)}</td>
                      <td className="text-right">{n(o.fields)}</td>
                      <td className={cn("text-right", o.mismatches.length ? "text-red-600" : "text-emerald-600")}>{n(o.mismatches.length)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {run.spotCheck.objects.some((o) => o.mismatches.length) ? (
                <ul className="mt-3 space-y-1 text-sm">
                  {run.spotCheck.objects.flatMap((o) => o.mismatches.map((m, i) => (
                    <li key={`${o.object}${i}`}>{m.name} · {m.field}: HubSpot {m.hubspot ?? "empty"}, Canon {m.canon ?? "empty"}</li>
                  )))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

const STEP_OBJECT: Readonly<Record<string, ImportObject>> = {
  pipelines: "deals", properties: "custom", companies: "companies", contacts: "contacts", deals: "deals", parents: "links", contactCompanies: "links", dealContacts: "links",
  calls: "engagements", meetings: "engagements", notes: "engagements", tasks: "engagements", emails: "engagements",
};
const stepNeeded = (phase: string, objects: readonly ImportObject[]) => objects.includes(STEP_OBJECT[phase]);
