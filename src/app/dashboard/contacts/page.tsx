"use client";

import { IntegrationGate } from "@/components/integration-gate";

import { useObjectLabels } from "@/components/records/object-labels";
import { CallSuggestions } from "@/components/crm/call-suggestions";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Users } from "lucide-react";
import { api } from "../../../../convex/_generated/api";
import type { ContactRow } from "../../../../convex/lib/recordContract";
import { EmptyState, LoadingRows, ViewFrame, ReadFailure, SelectionBar } from "@/components/dashboard";
import { useUrlState } from "@/lib/url-state";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import type { RevealOutcome } from "@/lib/bulkReveal";
import { AiCell, useContactAiFields, useContactAnswers } from "@/components/research/ai-cell";
import { ContactResearchMenu } from "@/components/research/research-menu";
import { AiFieldDialog } from "@/components/research/ai-field-dialog";
import { contactTableRows, contactQuickTestIds, type ContactTableControls } from "@/lib/contact-table";
import { BulkRevealDialog } from "./bulk-reveal-dialog";
import { ArchiveSelected, ArchivedLink } from "@/components/records/archive-records";
import { AddRecordsDialog, useFillTick } from "@/components/crm/add-records-dialog";
import { CsvImport } from "@/components/records/csv-import";
import { RecordLink, RecordQuickView, useRecordsSaved } from "@/components/records/record-context";
import { refreshLimit, refreshRows } from "@/components/records/live-rows";
import { SelectField } from "@/components/ui/select";

export default function ContactsPage() {
  return (
    <Suspense fallback={<div className="p-4 sm:p-8"><LoadingRows /></div>}>
      <ContactsView />
    </Suspense>
  );
}

function ContactsView() {
  const plural = useObjectLabels()("contact")!.pluralLabel;
  const [state, setState] = useUrlState({ q: "" });
  const listContacts = useAction(api.records.listContacts);
  const findEmail = useAction(api.records.findEmail);
  const [finding, setFinding] = useState<Record<string, boolean>>({});
  const allowance = useQuery(api.usage.emailAllowance);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [fieldOpen, setFieldOpen] = useState(false);
  const [controls, setControls] = useState<ContactTableControls>({ sort: "", descending: false, field: "", query: "", missing: false });

  // One lookup, shared by the row button and the bulk run: updates the row and returns what happened.
  async function lookUp(c: { id: string; accountId: string }): Promise<RevealOutcome> {
    const r = await findEmail({ accountId: c.accountId, contactId: c.id });
    if (r.status !== "limit_reached") {
      setRows((current) => (current ?? []).map((row) => (row.id === c.id
        ? { ...row, email: r.email ?? row.email, emailStatus: r.status === "not_found" ? "not_found" : r.email ? "found" : row.emailStatus }
        : row)));
    }
    return r;
  }

  async function revealEmail(c: ContactRow) {
    setFinding((f) => ({ ...f, [c.id]: true }));
    try {
      const r = await lookUp(c);
      if (r.status === "not_found") toast.error(`No work email found for ${c.fullName}.`);
      if (r.status === "limit_reached") toast.error(r.message ?? "Email lookup limit reached.");
    } catch (cause) {
      toast.error(getErrorMessage(cause));
    } finally {
      setFinding((f) => ({ ...f, [c.id]: false }));
    }
  }
  const session = useQuery(api.researchSessions.forMyOrg);
  const [rows, setRows] = useState<ContactRow[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [total, setTotal] = useState(0);
  const [read, setRead] = useState<{ kind: "loading" } | { kind: "ready" } | { kind: "failed"; message: string }>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [qDraft, setQDraft] = useState(state.q ?? "");
  const requestId = useRef(0);
  const cancelRequests = useCallback(() => { requestId.current++; }, []);
  const fillTick = useFillTick();
  const [added, setAdded] = useState(0);
  const [adding, setAdding] = useState(false);
  const aiFields = useContactAiFields();
  const answers = useContactAnswers(rows?.map((row) => row.id), aiFields);
  const visibleRows = contactTableRows(rows ?? [], names, aiFields, answers, controls);
  const selectedRows = visibleRows.filter((row) => selected.has(row.id));
  const columns = [
    { key: "fullName", label: "Name" }, { key: "title", label: "Title" },
    { key: "account", label: "Account" }, { key: "email", label: "Email" },
    ...aiFields.map((field) => ({ key: `ai:${field.slug}`, label: field.label })),
  ];
  const toggle = (id: string) => setSelected((cur) => {
    const next = new Set(cur);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  // A search loads the first page; anything else that adds contacts refreshes the loaded rows in place.
  const loaded = useRef<ContactRow[] | null>(null);
  loaded.current = rows;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  // The search the loaded rows answer: a refresh merges only into rows of the same search.
  const loadedFor = useRef<string | null>(null);
  const load = useCallback(async (refresh: boolean) => {
    const id = ++requestId.current;
    const inPlace = refresh && loadedFor.current === state.q;
    setRead({ kind: "loading" });
    try {
      const page = await listContacts({ q: state.q || undefined, limit: inPlace ? refreshLimit(loaded.current?.length ?? 0) : 50 });
      if (id !== requestId.current) return;
      loadedFor.current = state.q;
      const next = inPlace
        ? refreshRows(loaded.current, page.rows, { current: cursorRef.current, fresh: page.nextCursor })
        : { rows: page.rows, cursor: page.nextCursor };
      setRows(next.rows);
      setNames((current) => (inPlace ? { ...current, ...page.accountNames } : page.accountNames));
      setTotal(page.total);
      setCursor(next.cursor);
      setRead({ kind: "ready" });
    } catch (cause) {
      if (id === requestId.current) setRead({ kind: "failed", message: getErrorMessage(cause) });
    }
  }, [listContacts, state.q]);

  useEffect(() => {
    void load(false);
    return cancelRequests;
  }, [load, cancelRequests]);
  useRecordsSaved(() => void load(true));

  // Population progress: its count, and its note (which also changes when the
  // job finishes, e.g. after company names were resolved). The first value of
  // each signal is not a change.
  const progress = session === undefined || fillTick === undefined
    ? undefined
    : JSON.stringify([fillTick, session?.contactsSampled, session?.contactsNote, added]);
  const seenProgress = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (progress === undefined || progress === seenProgress.current) return;
    const first = seenProgress.current === undefined;
    seenProgress.current = progress;
    if (!first) void load(true);
  }, [progress, load]);

  useEffect(() => {
    const handle = setTimeout(() => {
      if ((state.q ?? "") !== qDraft) setState({ q: qDraft });
    }, 300);
    return () => clearTimeout(handle);
  }, [qDraft, state.q, setState]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    const id = requestId.current;
    setLoadingMore(true);
    try {
      const page = await listContacts({ q: state.q || undefined, limit: 50, cursor });
      if (id !== requestId.current) return;
      setRows((current) => [...(current ?? []), ...page.rows]);
      setNames((current) => ({ ...current, ...page.accountNames }));
      setCursor(page.nextCursor);
    } catch (cause) {
      if (id === requestId.current) setRead({ kind: "failed", message: getErrorMessage(cause) });
    } finally { setLoadingMore(false); }
  }

  return (
    <ViewFrame title={plural} actions={[
      { id: "people-refresh", label: "Refresh", onClick: () => void load(true), disabled: read.kind === "loading" },
      { id: "people-ai-field", label: "Add AI column / tag", onClick: () => setFieldOpen(true) },
      { id: "people-add", label: "Add records", onClick: () => setAdding(true), primary: true },
    ]} secondaryActions={<CsvImport object="contact" label={plural.toLowerCase()} className="view-action" />} filterReset={{ onClick: () => { setQDraft(""); setState({ q: "" }); setControls({ sort: "", descending: false, field: "", query: "", missing: false }); }, disabled: !state.q && !controls.field && !controls.sort }} controls={<div><input
        aria-label="Search contacts"
        value={qDraft}
        onChange={(event) => setQDraft(event.target.value)}
        placeholder="Search name, title or email"
        className="mb-4 w-full max-w-md border border-border bg-background px-2 py-1.5 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label>Sort loaded contacts
          <SelectField aria-label="Sort loaded contacts" value={controls.sort} onValueChange={(sort) => setControls({ ...controls, sort })} className="ml-2"
            options={[{ value: "", label: "Default order" }, ...columns.map((column) => ({ value: column.key, label: column.label }))]} />
        </label>
        <button disabled={!controls.sort} onClick={() => setControls({ ...controls, descending: !controls.descending })} className="border border-border px-2 py-1.5 disabled:opacity-50">{controls.descending ? "Descending" : "Ascending"}</button>
        <SelectField aria-label="Filter loaded contacts by" value={controls.field} onValueChange={(field) => setControls({ ...controls, field, query: "", missing: false })}
          options={[{ value: "", label: "No column filter" }, ...columns.map((column) => ({ value: column.key, label: column.label }))]} />
        {controls.field && <>
          <input aria-label="Column contains" placeholder="Contains…" value={controls.query} disabled={controls.missing} onChange={(e) => setControls({ ...controls, query: e.target.value })} className="border border-border bg-background px-2 py-1.5 disabled:opacity-50" />
          <label className="flex items-center gap-1"><input type="checkbox" checked={controls.missing} onChange={(e) => setControls({ ...controls, missing: e.target.checked })} />No value</label>
        </>}
        <span className="ml-auto"><ArchivedLink object="contact" /></span>
      </div></div>}>
      <CallSuggestions kind="contact" className="mb-4" />
      <AddRecordsDialog open={adding} onOpenChange={setAdding} object="contact" onAdded={() => setAdded((n) => n + 1)} />

      {fieldOpen && <AiFieldDialog open={fieldOpen} onOpenChange={setFieldOpen} defaultEntityType="contact" />}
      {read.kind === "loading" && <p role="status" className="mb-2 text-xs text-muted-foreground">{rows ? "Updating people…" : "Loading people…"}</p>}
      {read.kind === "failed" && <ReadFailure message={read.message} retry={() => void load(true)} retained={rows !== null} />}
      {rows === null || (aiFields.length > 0 && answers === undefined) ? (
        read.kind === "failed" ? null : <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState icon={Users} title={state.q ? "No people match" : "No people yet"} description={state.q ? "Change your search or clear it to see everyone." : "Add people or find buyers at your accounts."} />
      ) : (
        <>
          <SelectionBar count={selectedRows.length} summary={`${visibleRows.length} shown · ${rows.length} loaded of ${total} people`} onClear={() => setSelected(new Set())}>
            {selectedRows.length > 0 && (
              <IntegrationGate feature="treg"><button onClick={() => setBulkOpen(true)} className="border border-border px-2 py-0.5 text-foreground hover:bg-muted">
                Find emails ({selectedRows.length})
              </button></IntegrationGate>
            )}
            {visibleRows.length > 0 && <ContactResearchMenu selectedIds={contactQuickTestIds(visibleRows)} quickTest />}
            <ContactResearchMenu selectedIds={selectedRows.map((row) => row.id)} />
            <ArchiveSelected object="contact" ids={selectedRows.map((row) => row.id)} onDone={() => { setSelected(new Set()); void load(false); }} />
          </SelectionBar>
          <div className="overflow-x-auto border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all visible contacts"
                      checked={visibleRows.length > 0 && selectedRows.length === visibleRows.length}
                      onChange={(event) => setSelected(event.target.checked ? new Set(visibleRows.map((row) => row.id)) : new Set())}
                    />
                  </th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Title</th>
                  <th className="px-3 py-2">Account</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">LinkedIn</th>
                  {aiFields.map((f) => <th key={f.slug} className="whitespace-nowrap px-3 py-2" title={f.question}>{f.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {visibleRows.length === 0 && <tr><td colSpan={6 + aiFields.length} className="px-3 py-6 text-muted-foreground">No loaded contacts match this filter. Clear the column filter or load more contacts.</td></tr>}
                {visibleRows.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-3 py-2">
                      <input type="checkbox" aria-label={`Select ${c.fullName}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                    </td>
                    <td className="px-3 py-2 record-name">
                      <div className="flex min-w-0 items-center gap-1">
                        <RecordLink object="contact" id={c.id} className="min-w-0 hover:underline">{c.fullName}</RecordLink>
                        <RecordQuickView object="contact" id={c.id} label={c.fullName} />
                      </div>
                    </td>
                    <td className="px-3 py-2">{c.title ?? "—"}</td>
                    <td className="px-3 py-2">
                      {c.accountId ? (
                        <RecordLink className="hover:underline" object="account" id={c.accountId}>
                          {names[c.accountId] ?? c.accountId}
                        </RecordLink>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {c.email ? (
                        c.email
                      ) : c.emailStatus === "not_found" ? (
                        <span className="text-muted-foreground">not found</span>
                      ) : (
                        <IntegrationGate feature="treg"><button
                          onClick={() => revealEmail(c)}
                          disabled={finding[c.id]}
                          className="border border-border px-2 py-0.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                        >
                          {finding[c.id] ? "Finding…" : "Find email"}
                        </button></IntegrationGate>
                      )}
                    </td>
                    <td className="px-3 py-2">{c.linkedinUrl ? <a className="underline" href={c.linkedinUrl} target="_blank" rel="noreferrer">profile</a> : "—"}</td>
                    {aiFields.map((f) => <td key={f.slug} className="px-3 py-2"><AiCell field={f} answer={answers?.[c.id]?.[f.slug]} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor && (
            <button disabled={loadingMore} onClick={loadMore} className="mt-4 border border-border px-4 py-2 text-xs font-medium hover:bg-muted">
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
      {bulkOpen && (
        <BulkRevealDialog
          targets={selectedRows}
          allowance={allowance}
          onClose={() => { setBulkOpen(false); setSelected(new Set()); }}
          find={lookUp}
        />
      )}
    </ViewFrame>
  );
}
