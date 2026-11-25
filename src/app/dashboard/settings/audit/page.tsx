"use client";

import { useEffect, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../../../convex/_generated/api";
import { SelectField } from "@/components/ui/select";
import { LoadingRows } from "@/components/dashboard";
import { SettingsPage } from "../settings-ui";

const input = "border border-border bg-background px-2 py-1 text-sm";
const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";

function AuditList() {
  const settings = useQuery(api.permissions.settings);
  const [actorId, setActorId] = useState("");
  const [operation, setOperation] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const convex = useConvex();
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [snapshot, setSnapshot] = useState<{ page: FunctionReturnType<typeof api.adminAudit.list>; settings: typeof settings } | null>(null);
  const page = snapshot?.settings === settings ? snapshot?.page : null;
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const reset = () => { setCursors([null]); setSnapshot(null); setError(""); setRefresh(n => n + 1); };
  const cursor = cursors[cursors.length - 1];
  const invalid = !!start && !!end && start > end;
  // Audit pages are snapshots: a live insert cannot move a row across an already loaded cursor boundary.
  useEffect(() => {
    let cancelled = false;
    if (settings && !invalid) void convex.query(api.adminAudit.list, {
      paginationOpts: { cursor, numItems: 25 },
      ...(actorId ? { actorId } : {}), ...(operation ? { operation } : {}),
      ...(start ? { start: new Date(`${start}T00:00:00`).getTime() } : {}),
      ...(end ? { end: new Date(`${end}T23:59:59.999`).getTime() } : {}),
    }).then(result => { if (!cancelled) { setSnapshot({ page: result, settings }); setError(""); } }, () => { if (!cancelled) setError("Could not read the audit log. Check your admin access and try Refresh."); });
    return () => { cancelled = true; };
  }, [convex, settings, invalid, cursor, actorId, operation, start, end, refresh]);
  const results = page?.page ?? [];
  if (settings === undefined) return <LoadingRows count={4} height="h-10" />;
  if (!settings) return <p className="text-sm text-muted-foreground">Only admins can read the audit log.</p>;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-xs">Actor<SelectField aria-label="Actor" value={actorId} onValueChange={value => { setActorId(value); reset(); }} options={[{ value: "", label: "All actors" }, ...settings.members.map(m => ({ value: m.id, label: m.name }))]} /></label>
      <label className="grid gap-1 text-xs">Operation (exact)<input className={input} value={operation} onChange={e => { setOperation(e.target.value); reset(); }} placeholder="e.g. stop_sync" /></label>
      <label className="grid gap-1 text-xs">From<input type="date" className={input} value={start} onChange={e => { setStart(e.target.value); reset(); }} /></label>
      <label className="grid gap-1 text-xs">Through<input type="date" className={input} value={end} onChange={e => { setEnd(e.target.value); reset(); }} /></label>
      <button className={btn} onClick={() => { setActorId(""); setOperation(""); setStart(""); setEnd(""); reset(); }}>Clear filters</button>
      <button className={btn} onClick={reset}>Refresh</button>
    </div>
    <p className="text-xs text-muted-foreground">Operations, module writes and data-model changes, newest first. Payloads, reasons and summaries are omitted. Refresh to see new events. Agent activity is included under its member.</p>
    {invalid ? <p role="alert">The end date must follow the start date.</p> : <>
      {error ? <p role="alert">{error}</p> : !page ? <LoadingRows count={4} height="h-10" /> : <>
        {!results.length && <p className="py-8 text-sm text-muted-foreground">No audit entries in the loaded pages match these filters.</p>}
        {!!results.length && <div className="overflow-x-auto border border-border bg-card"><table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground"><tr>{["When", "Who", "What", "Target", "Details"].map(t => <th className="px-3 py-2" key={t}>{t}</th>)}</tr></thead>
          <tbody>{results.map(row => <tr className="border-b border-border last:border-0" key={row.id}>
            <td className="whitespace-nowrap px-3 py-2 tabular-nums">{new Date(row.at).toLocaleString()}</td><td className="px-3 py-2">{row.actor}</td>
            <td className="px-3 py-2">{row.operation}<span className="block text-xs text-muted-foreground">{row.source}</span></td><td className="break-all px-3 py-2">{row.target}</td>
            <td className="px-3 py-2"><details><summary className="cursor-pointer text-primary">Recorded fields</summary><pre className="max-w-sm overflow-auto py-2 text-xs">{JSON.stringify({ id: row.id, source: row.source, at: row.at, ...row.fields }, null, 2)}</pre></details></td>
          </tr>)}</tbody>
        </table></div>}
        <div className="flex gap-2">
          <button className={btn} disabled={cursors.length === 1} onClick={() => { setSnapshot(null); setCursors(c => c.slice(0, -1)); }}>Previous</button>
          <button className={btn} disabled={page.isDone} onClick={() => { setSnapshot(null); setCursors(c => [...c, page.continueCursor]); }}>Next page</button>
        </div>
      </>}
    </>}
  </div>;
}

export default function AuditSettingsPage() {
  return <SettingsPage area="audit"><AuditList /></SettingsPage>;
}
