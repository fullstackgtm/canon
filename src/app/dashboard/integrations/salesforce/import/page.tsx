"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import { sfSync } from "@/components/salesforce-sync/data";
import type { ImportableObject, ImportOwner, RejectedRow } from "@/components/salesforce-sync/types";
import { Panel, formatTime } from "@/components/salesforce-sync/ui";
import { SelectField } from "@/components/ui/select";

/** Where each Salesforce object lands in Canon. Custom objects stay Salesforce-shaped records. */
const LANDS_IN: Record<string, string> = {
  Account: "Companies",
  Contact: "People",
  Lead: "People (with a company from the lead's domain)",
  Opportunity: "Deals, with a pipeline per sales process and their custom fields",
  OpportunityContactRole: "Roles on deals (comes with Opportunity)",
  OpportunityHistory: "Stage and field history in each deal's record history (comes with Opportunity)",
  Task: "Tasks and logged calls, on their people, companies and deals",
  Event: "Meetings, on their people, companies and deals",
  Note: "Notes (classic Salesforce notes)",
  ContentDocument: "Notes, and files as links to Salesforce (Canon stores no files yet)",
};
const WITH_OPPORTUNITIES = ["OpportunityContactRole", "OpportunityHistory"];
const landsIn = (apiName: string) => LANDS_IN[apiName] ?? (apiName.endsWith("__c") ? "Custom object records (read-only)" : "Records");

function downloadCsv(filename: string, header: string[], rows: Array<Array<string | number | undefined>>) {
  const esc = (v: string | number | undefined) => {
    const s = v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n") + "\n";
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function SalesforceImportPage() {
  const job = sfSync.useLatestImport();
  const objects = sfSync.useObjects();
  const rejected = sfSync.useRejected(job?._id ?? null);
  const startImport = sfSync.useStartImport();
  const previewImport = sfSync.usePreviewImport();
  const loadAllRejected = sfSync.useLoadAllRejected();
  const importMetadata = sfSync.useImportMetadata();
  const setObjectSyncEnabled = sfSync.useSetObjectSyncEnabled();
  const [busy, setBusy] = useState<string | null>(null);
  const [importable, setImportable] = useState<ImportableObject[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [failureFilter, setFailureFilter] = useState<string>("");
  const running = job?.status === "running" || job?.status === "queued";

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  function toggle(apiName: string, on: boolean) {
    const next = new Set(picked);
    if (on) next.add(apiName);
    else next.delete(apiName);
    // Contact roles and deal history are read with their opportunities.
    for (const dependent of WITH_OPPORTUNITIES) {
      if (apiName === "Opportunity" && !on) next.delete(dependent);
      if (apiName === dependent && on) next.add("Opportunity");
    }
    setPicked(next);
  }

  const owners = job?.owners ?? [];
  const unmapped = owners.filter((o) => !o.memberId);
  const visibleFailures = useMemo(() => (rejected ?? []).filter((r) => !failureFilter || r.object === failureFilter), [rejected, failureFilter]);
  const failureObjects = useMemo(() => [...new Set((rejected ?? []).map((r) => r.object))], [rejected]);

  return (
    <div>
      <Panel title="Bring a Salesforce org across" testId="sf-import-pick">
        <p className="mb-3 max-w-[70ch] text-sm text-muted-foreground">
          Pick what to import, then run it. Re-running updates what is already here and adds nothing twice. The import only reads Salesforce.
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              run("preview", async () => {
                const list = await previewImport();
                setImportable(list);
                setPicked(new Set(list.map((o) => o.apiName)));
              })
            }
          >
            {busy === "preview" ? "Counting…" : importable ? "Count again" : "Count records in Salesforce"}
          </Button>
          <Button
            disabled={busy !== null || running || (importable !== null && picked.size === 0)}
            onClick={() =>
              run("import", async () => {
                await startImport(importable ? { objects: importable.filter((o) => picked.has(o.apiName)).map((o) => o.apiName) } : {});
                toast.success("Import started");
              })
            }
          >
            {running ? "Import running…" : importable ? `Import ${picked.size} object${picked.size === 1 ? "" : "s"}` : "Import everything"}
          </Button>
        </div>
        {importable && (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 py-1" />
                <th>Salesforce object</th>
                <th>Lands in</th>
                <th className="text-right">Records</th>
              </tr>
            </thead>
            <tbody>
              {importable.map((o) => (
                <tr key={o.apiName} className="border-t border-border" data-testid={`sf-importable-${o.apiName}`}>
                  <td className="py-1.5">
                    <input type="checkbox" aria-label={`Import ${o.apiName}`} checked={picked.has(o.apiName)} onChange={(e) => toggle(o.apiName, e.target.checked)} />
                  </td>
                  <td className="font-mono text-xs">{o.apiName}</td>
                  <td>{landsIn(o.apiName)}</td>
                  <td className="text-right">{o.sfTotal.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Latest import" testId="sf-import-job">
        {job === undefined ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : job === null ? (
          <p className="text-sm text-muted-foreground">No import has run yet.</p>
        ) : (
          <>
            <p className="mb-3 text-sm">
              Status <strong data-testid="sf-import-status">{job.status}</strong> · started {formatTime(job.startedAt)}
              {job.finishedAt ? ` · finished ${formatTime(job.finishedAt)}` : ""}
            </p>
            {job.error && <p className="mb-3 text-sm text-destructive">{job.error}</p>}
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1">Object</th>
                  <th>Lands in</th>
                  <th>State</th>
                  <th className="text-right">In Salesforce</th>
                  <th className="text-right">Imported</th>
                  <th className="text-right" title="Deals that already existed, or companies and people merged into a matching record">Matched existing</th>
                  <th className="text-right">Failed</th>
                  <th className="w-32">Progress</th>
                </tr>
              </thead>
              <tbody>
                {job.objects.map((o) => {
                  const done = o.upserted + o.rejected;
                  const pct = o.state === "done" ? 100 : o.sfTotal > 0 ? Math.min(100, Math.round((done / o.sfTotal) * 100)) : 0;
                  return (
                    <tr key={o.apiName} className="border-t border-border align-top" data-testid={`sf-import-row-${o.apiName}`}>
                      <td className="py-1.5 font-mono text-xs">{o.apiName}</td>
                      <td>{landsIn(o.apiName)}</td>
                      <td>
                        {o.state}
                        {o.error && <span className="block text-xs text-destructive">{o.error}</span>}
                      </td>
                      <td className="text-right">{o.sfTotal.toLocaleString()}</td>
                      <td className="text-right">{o.upserted.toLocaleString()}</td>
                      <td className="text-right">{o.merged.toLocaleString()}</td>
                      <td className="text-right">
                        {o.rejected > 0 ? (
                          <button type="button" className="underline" onClick={() => setFailureFilter(o.apiName)}>
                            {o.rejected.toLocaleString()}
                          </button>
                        ) : (
                          0
                        )}
                      </td>
                      <td>
                        <div className="h-1.5 w-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${o.apiName} progress`}>
                          <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </Panel>

      {job && owners.length > 0 && (
        <Panel title="Record owners" testId="sf-import-owners">
          <p className="mb-3 text-sm">
            {owners.length - unmapped.length} of {owners.length} Salesforce owners matched a Canon member by email.
            {unmapped.length > 0 && " Records owned by the others keep their Salesforce owner and have no Canon owner until someone assigns one."}
          </p>
          {unmapped.length > 0 && (
            <>
              <Button variant="outline" className="mb-3" onClick={() => downloadUnmapped(unmapped)}>
                Download unmapped owners (CSV)
              </Button>
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1">Salesforce owner</th>
                    <th>Email</th>
                    <th className="text-right">Records</th>
                  </tr>
                </thead>
                <tbody>
                  {unmapped.map((o) => (
                    <tr key={o.sfUserId} className="border-t border-border" data-testid={`sf-unmapped-owner-${o.sfUserId}`}>
                      <td className="py-1.5">{o.name}</td>
                      <td>{o.email ?? "(no email)"}</td>
                      <td className="text-right">{o.records.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Panel>
      )}

      {job && (
        <Panel title="Failures" testId="sf-rejected">
          {rejected === undefined ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rejected.length === 0 ? (
            <p className="text-sm text-muted-foreground">No records failed.</p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <SelectField
                  aria-label="Filter failures by object"
                  value={failureFilter}
                  onValueChange={setFailureFilter}
                  options={[{ value: "", label: "All objects" }, ...failureObjects.map((o) => ({ value: o, label: o }))]}
                />
                <Button
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    run("failures", async () => {
                      const rows = await loadAllRejected(job._id);
                      downloadCsv(`salesforce-import-failures-${job._id}.csv`, ["object", "salesforce_id", "reason"], rows.map((r: RejectedRow) => [r.object, r.sfId, r.reason]));
                    })
                  }
                >
                  Download failures (CSV)
                </Button>
                {(job.rejectedCount ?? 0) > 1000 && (
                  <span className="text-xs text-muted-foreground">The report holds the first 1,000 of {job.rejectedCount?.toLocaleString()} failures.</span>
                )}
              </div>
              <ul className="space-y-1 text-sm">
                {visibleFailures.map((r, i) => (
                  <li key={`${r.sfId ?? r.index}-${i}`} className="flex gap-3">
                    <span className="font-mono text-xs text-muted-foreground">
                      {r.object} {r.sfId ?? `#${r.index}`}
                    </span>
                    <span>{r.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}

      <Panel title="Objects kept in sync" testId="sf-objects">
        <div className="mb-3 flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              run("metadata", async () => {
                const r = await importMetadata();
                toast.success(`Described ${r.objects} objects and ${r.fields} fields`);
              })
            }
          >
            Refresh metadata
          </Button>
        </div>
        {objects === undefined ? (
          <p className="text-sm text-muted-foreground">Loading objects…</p>
        ) : objects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No objects described yet. Refresh metadata to read your org.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1">Object</th>
                <th>Type</th>
                <th className="text-right">Records</th>
                <th className="text-right">Sync</th>
              </tr>
            </thead>
            <tbody>
              {objects.map((o) => (
                <tr key={o.apiName} className="border-t border-border" data-testid={`sf-object-${o.apiName}`}>
                  <td className="py-1.5">
                    {o.label} <span className="font-mono text-xs text-muted-foreground">{o.apiName}</span>
                  </td>
                  <td>{o.isCustom ? "Custom" : "Standard"}</td>
                  <td className="text-right">{o.recordCount?.toLocaleString() ?? "—"}</td>
                  <td className="text-right">
                    <input
                      type="checkbox"
                      aria-label={`Sync ${o.apiName}`}
                      checked={o.syncEnabled}
                      onChange={(e) =>
                        void setObjectSyncEnabled({ apiName: o.apiName, enabled: e.target.checked }).catch((err) =>
                          toast.error(getErrorMessage(err)),
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function downloadUnmapped(owners: ImportOwner[]) {
  downloadCsv("salesforce-unmapped-owners.csv", ["salesforce_user_id", "name", "email", "records"], owners.map((o) => [o.sfUserId, o.name, o.email, o.records]));
}
