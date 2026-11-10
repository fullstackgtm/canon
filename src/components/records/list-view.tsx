"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PEOPLE_FILTER_PARAM, MODULE_RETURN_PARAM, jsonQueryValue, moduleFilterHref, resolveAllowedFilterForm, parsePeopleFilter, peopleFilterContext } from "@/lib/people-list";
import type { ViewFilter } from "../../../convex/lib/objects/validators";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Archive, ArrowDown, ArrowUp, Columns3, GitMerge, KanbanSquare, Rows3, Undo2, UserCheck } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { indexObjectDef, type ObjectDef } from "../../../convex/lib/objects/registry";
import { FILTERS_MAX, listColumns, type ListRow, type ListSort } from "../../../convex/lib/objects/listSpec";
import { BULK_MAX, collapseDayFilters, dayColumnsOf, expandDayFilters, runBulk } from "../../../convex/lib/objects/views";
import { EmptyState, LoadingRows, ViewFrame, ReadFailure, SelectionBar } from "@/components/dashboard";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUrlState } from "@/lib/url-state";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { FieldInput, formatValue, isEditable, optionChips, type CellValue, type FieldDescription, type ObjectDescription, type TeamMember } from "./fields";
import { FilterBar, isComplete } from "./filter-bar";
import { BoardView, type BoardSaves } from "./board-view";
import { AiCell, useContactAiFields, useContactAnswers } from "@/components/research/ai-cell";
import { ContactAudienceActions } from "./audience-actions";
import { CsvImport } from "./csv-import";
import { CustomCsvImport } from "./custom-csv-import";
import { ExportView } from "./list-export";
import { useObjectList, type ListedObject, type Save } from "./use-object-list";
import { DealCreateDialog } from "./deal-create";
import { useLookupTitles } from "./lookup-field";
import { RecordLink, RecordQuickView, useRecordInspection, useRecordsSaved } from "./record-context";
import { recordHref } from "./record-target";
export { recordHref } from "./record-target";
import { ConvertLeadDialog } from "./convert-lead";
import { MergeDialog } from "./merge-dialog";
import { SelectField } from "@/components/ui/select";

/** Records one merge takes (convex/lib/canon/partyMerge.ts MERGE_RECORDS_MAX). */
const MERGE_MAX = 9;

const DEFAULT_COLUMN_COUNT = 6;

type WritableObject = "lead" | "task" | "note" | "call" | "meeting" | "product" | "deal";
type Spec = { filter: ViewFilter[]; sort?: ListSort; columns: string[]; layout: "table" | "board"; groupBy?: string };
type SaveResult = { status: string; shard?: number; seq?: number; errors?: Array<{ field: string; message: string }> };

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";


function defaultSpec(desc: ObjectDescription): Spec {
  const fields = desc.fields.filter((f) => !f.system && !f.hidden && f.type !== "formula" && f.fieldId !== desc.titleFieldId).slice(0, DEFAULT_COLUMN_COUNT - 1);
  // Converted leads leave the default view; the Open, Converted and All switch changes that.
  return { filter: desc.apiName === "lead" ? [OPEN_LEADS] : [], columns: [...fields.map((f) => f.apiName), "updatedAt"], layout: "table" };
}

const OPEN_LEADS: ViewFilter = { field: "convertedAt", op: "empty" };
const CONVERTED_LEADS: ViewFilter = { field: "convertedAt", op: "notEmpty" };
/** Which of a lead list's three views a filter list is: Open, Converted, or All (no filter on `convertedAt`). */
const leadView = (filter: readonly ViewFilter[]): "open" | "converted" | "all" =>
  filter.some((f) => f.field === "convertedAt" && f.op === "empty") ? "open" : filter.some((f) => f.field === "convertedAt" && f.op === "notEmpty") ? "converted" : "all";

export const saveOf = (r: SaveResult): Save[] => (typeof r.shard === "number" && typeof r.seq === "number" ? [{ shard: r.shard, seq: r.seq }] : []);

/** A save that didn't land, as a sentence; null when it did (or changed nothing). */
export function saveProblem(r: SaveResult): string | null {
  switch (r.status) {
    case "applied":
    case "proposed":
    case "unchanged":
      return null;
    case "conflict":
      return "Someone else changed this record; reload and try again.";
    case "invalid":
      return r.errors?.map((e) => e.message).join("; ") || "Invalid value";
    default:
      return r.status;
  }
}

function CreateDialog({ desc, team, open, onClose, onCreated }: {
  desc: ObjectDescription;
  team?: readonly TeamMember[];
  open: boolean;
  onClose: () => void;
  onCreated: (streamId: string, save: Save[]) => void;
}) {
  const write = useMutation(api.objects.write);
  const [values, setValues] = useState<Record<string, CellValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const fields = desc.fields.filter((f) => isEditable(f) && !desc.readOnlyFields.includes(f.apiName));

  async function submit() {
    setBusy(true);
    try {
      const sent = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== ""));
      const r = await write({ object: desc.apiName as WritableObject, values: sent as never });
      if (r.status === "invalid") {
        setErrors(Object.fromEntries(r.errors.map((e) => [e.field, e.message])));
        return;
      }
      setValues({});
      setErrors({});
      onCreated(r.streamId, saveOf(r));
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New {desc.label.toLowerCase()}</DialogTitle>
          <DialogDescription>Fields marked * are required.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-3"
        >
          {fields.map((f) => (
            <label key={f.fieldId} className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{f.label}{f.required ? " *" : ""}</span>
              <FieldInput field={f} value={values[f.apiName] ?? null} team={team} onChange={(next) => setValues((cur) => ({ ...cur, [f.apiName]: next }))} />
              {errors[f.apiName] && <span className="text-xs text-destructive">{errors[f.apiName]}</span>}
            </label>
          ))}
          <DialogFooter>
            <button type="button" onClick={onClose} className={btn}>Cancel</button>
            <button type="submit" disabled={busy} className={cn(btn, "bg-primary text-primary-foreground hover:bg-primary/85")}>{busy ? "Saving…" : "Create"}</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BulkEdit({ fields, team, busy, onApply }: {
  fields: readonly FieldDescription[];
  team?: readonly TeamMember[];
  busy: boolean;
  onApply: (apiName: string, value: CellValue) => void;
}) {
  const [apiName, setApiName] = useState(fields[0]?.apiName ?? "");
  const [value, setValue] = useState<CellValue>(null);
  const field = fields.find((f) => f.apiName === apiName);
  if (!field) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-muted-foreground">Set</span>
      <SelectField aria-label="Bulk edit field" value={apiName} onValueChange={(v) => { setApiName(v); setValue(null); }}
        options={fields.map((f) => ({ value: f.apiName, label: f.label }))} />
      <span className="text-xs font-medium text-muted-foreground">to</span>
      <div className="w-56"><FieldInput key={apiName} field={field} value={value} team={team} onChange={setValue} /></div>
      <button type="button" disabled={busy} onClick={() => onApply(apiName, value)} className={btn}>Apply</button>
    </div>
  );
}

function ColumnChooser({ columns, choices, onChange }: {
  columns: string[];
  choices: Array<{ name: string; label: string }>;
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" className={btn} aria-expanded={open} onClick={() => setOpen(!open)}><Columns3 className="h-3 w-3" /> Columns</button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-80 w-60 overflow-y-auto border border-border bg-popover p-2 shadow-md">
          {choices.map((c) => {
            const i = columns.indexOf(c.name);
            return (
              <div key={c.name} className="flex items-center justify-between gap-2 py-0.5 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={i >= 0} onChange={() => onChange(i >= 0 ? columns.filter((x) => x !== c.name) : [...columns, c.name])} />
                  {c.label}
                </label>
                {i >= 0 && (
                  <span className="flex gap-1">
                    <button type="button" aria-label={`Move ${c.label} left`} disabled={i === 0} onClick={() => onChange(columns.map((x, j) => (j === i - 1 ? c.name : j === i ? columns[i - 1] : x)))} className="text-xs text-muted-foreground disabled:opacity-30">←</button>
                    <button type="button" aria-label={`Move ${c.label} right`} disabled={i === columns.length - 1} onClick={() => onChange(columns.map((x, j) => (j === i + 1 ? c.name : j === i ? columns[i + 1] : x)))} className="text-xs text-muted-foreground disabled:opacity-30">→</button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ObjectListView({ object }: { object: string }) {
  const desc = useQuery(api.objects.describe, { object });
  if (desc === undefined) return <div className="p-4 sm:p-8"><LoadingRows /></div>;
  if (desc === null) return <div className="p-4 text-sm sm:p-8 text-muted-foreground">There is no object called {object}.</div>;
  if (!desc.pages) return <div className="p-4 text-sm sm:p-8 text-muted-foreground">{desc.pluralLabel} have their own page for now.</div>;
  return <Loaded desc={desc} />;
}

function Loaded({ desc }: { desc: ObjectDescription }) {
  const object = desc.apiName as ListedObject;
  const def = useMemo(() => indexObjectDef(desc as unknown as ObjectDef), [desc]);
  const columns = useMemo(() => {
    const all = new Map(listColumns(def));
    // The register keeps no creation time (its `createdAt` reads as last modified): don't offer it.
    if (desc.register) all.delete("createdAt");
    return all;
  }, [def, desc.register]);
  const team = useQuery(api.users.list) as TeamMember[] | undefined;
  const views = useQuery(api.savedViews.list, { object });
  const createView = useMutation(api.savedViews.create);
  const updateView = useMutation(api.savedViews.update);
  const removeView = useMutation(api.savedViews.remove);
  const bulk = useMutation(api.objects.bulk);
  const write = useMutation(api.objects.write);
  // Accounts and contacts (the register) are keyed by record id: their bulk changes and edits go through these actions.
  const bulkRegister = useAction(api.records.bulkRegister);
  const editRegister = useAction(api.records.edit);
  const [url, setUrl] = useUrlState({ view: "", bin: "", layout: "", pipeline: "", audience: "", filter: "", returnTo: "" });
  const search = useSearchParams();
  const returnPresent = search.has(MODULE_RETURN_PARAM);
  const listModules = useQuery(api.modules.contributions, object === "contact" ? { page: "people" } : "skip");
  const context = object === "contact" ? peopleFilterContext({ ...url, filterPresent: search.has(PEOPLE_FILTER_PARAM), returnPresent }) : { kind: "core" as const };
  const incoming = useMemo(() => {
    if (context.kind === "core") return null;
    try {
      const value = jsonQueryValue({ [PEOPLE_FILTER_PARAM]: url.filter }, PEOPLE_FILTER_PARAM);
      return { filter: parsePeopleFilter(value, def, new Set(columns.keys())), problem: null };
    } catch (e) { return { filter: null, problem: getErrorMessage(e) }; }
  }, [context.kind, url.filter, def, columns]);
  const moduleReturn = useMemo(() => {
    if (context.kind === "core" || !returnPresent) return null;
    if (listModules === undefined) return { target: null, problem: null };
    try { return { target: resolveAllowedFilterForm(url.returnTo, listModules), problem: null }; }
    catch (e) { return { target: null, problem: getErrorMessage(e) }; }
  }, [context.kind, returnPresent, url.returnTo, listModules]);
  const incomingKey = context.kind === "filter" ? JSON.stringify([url.filter, returnPresent, url.returnTo]) : "";
  const [loadedFilterKey, setLoadedFilterKey] = useState("");
  const contextProblem = incoming?.problem ?? moduleReturn?.problem ?? null;
  const contextPending = context.kind === "filter" && (returnPresent && listModules === undefined);
  const inspection = useRecordInspection();
  const pipelines = useQuery(api.pipelines.list, object === "deal" ? {} : "skip");
  const bin = url.bin === "1";
  const [spec, setSpec] = useState<Spec>(() => defaultSpec(desc));
  const stageTotals = useQuery(api.pipelines.totals, object === "deal" && spec.layout === "board" ? {} : "skip");
  const [dirty, setDirty] = useState(false);
  // Counts specs loaded from outside the filter bar, so its typed drafts reset then and only then.
  const [specLoads, setSpecLoads] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [convertingId, setConvertingId] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ name: string; shared: boolean } | null>(null);
  // A destructive button asks once more before it acts.
  const [confirming, setConfirming] = useState<"view" | "records" | null>(null);
  const [boardSaves, setBoardSaves] = useState<BoardSaves>({ n: 0, saves: [] });
  const activeView = useMemo(() => views?.find((v) => v._id === url.view) ?? null, [views, url.view]);

  // Opening a saved view loads its spec; edits after that mark it dirty until saved.
  useEffect(() => {
    if ((object === "contact" && url.audience) || context.kind === "filter") return;
    if (activeView) setSpec(activeView.spec as Spec);
    else if (!url.view) setSpec({ ...defaultSpec(desc), ...(url.layout === "board" ? { layout: "board" as const } : {}) });
    setSpecLoads((n) => n + 1);
    setDirty(false);
    setSelected(new Set());
  }, [activeView, url.view, url.audience, url.layout, context.kind, desc, object]);

  // Editing an audience (?audience=<id>, from Audiences): its filter loads into the list, and the audience buttons save it back.
  const audience = useQuery(api.audiences.byId, object === "contact" && url.audience ? { audienceId: url.audience as Id<"audiences"> } : "skip") ?? null;
  useEffect(() => {
    if (!audience) return;
    setSpec((cur) => ({ ...cur, filter: collapseDayFilters(audience.filter, dayColumnsOf(def)) }));
    setSpecLoads((n) => n + 1);
    setSelected(new Set());
  }, [audience?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!incoming) { setLoadedFilterKey(""); return; }
    const loaded = incoming.filter;
    if (!loaded || contextProblem || contextPending) return;
    setSpec((cur) => ({ ...cur, layout: "table", filter: collapseDayFilters(loaded, dayColumnsOf(def)) }));
    setSpecLoads((n) => n + 1);
    setSelected(new Set());
    setDirty(false);
    setLoadedFilterKey(incomingKey);
  }, [incoming, incomingKey, contextProblem, contextPending, def]);

  const deleting = useRef<string | null>(null);
  // The selected view was deleted or unshared (here or elsewhere): fall back to the default list, and say so.
  useEffect(() => {
    if (views && url.view && !activeView) {
      if (url.view !== deleting.current) void toast.info("That saved view is no longer available");
      setUrl({ view: "" });
    }
  }, [views, url.view, activeView, setUrl]);

  const edit = (patch: Partial<Spec>) => {
    setSpec((cur) => ({ ...cur, ...patch }));
    setDirty(true);
    // A selection belongs to the rows it was made on; new filters mean new rows.
    if (patch.filter || patch.sort || patch.layout) setSelected(new Set());
  };

  // A filter on a field that is gone (archived since the view was saved) is left out, not sent.
  const filter = useMemo(() => spec.filter.filter((f) => isComplete(f) && columns.has(f.field)), [spec.filter, columns]);
  // What the list request carries: day-picked timestamp filters widened to whole days.
  const dayColumns = useMemo(() => dayColumnsOf(def), [def]);
  const listFilter = useMemo(() => expandDayFilters(filter, dayColumns), [filter, dayColumns]);
  const handoffProblem = useMemo(() => {
    try { parsePeopleFilter(listFilter, def, new Set(columns.keys())); return null; }
    catch (e) { return getErrorMessage(e); }
  }, [listFilter, def, columns]);
  const picklists = desc.fields.filter((f) => f.type === "picklist");
  const bulkable = desc.writable;
  const groupBy = spec.layout === "board" ? picklists.find((f) => f.apiName === spec.groupBy) ?? picklists[0] : undefined;
  const board = Boolean(groupBy) && !bin;
  // A deal board grouped by stage shows one pipeline: its stages in order, and "No stage" on the default.
  const pipeline = groupBy?.apiName === "stage" ? pipelines?.find((p) => (p.id ?? "") === url.pipeline) ?? pipelines?.[0] : undefined;
  const pipelineColumns = pipeline && [
    ...pipeline.stages.map((s) => ({ value: s.value, label: s.active ? s.label : `${s.label} (inactive)`, accepts: s.active })),
    ...(pipeline.isDefault ? [{ value: "", label: "No stage", accepts: true }] : []),
  ];
  // A request takes FILTERS_MAX filters; a day filter can take two, and a board column adds one.
  const filterRoom = FILTERS_MAX - listFilter.length - (spec.layout === "board" ? 1 : 0);
  const contextWaiting = context.kind === "filter" && (contextProblem !== null || handoffProblem !== null || contextPending || loadedFilterKey !== incomingKey);
  const listQuery = board || contextWaiting ? null : { object, filter: listFilter, ...(spec.sort && columns.has(spec.sort.field) ? { sort: spec.sort } : {}), ...(bin ? { deleted: true } : {}) };
  // What decides membership and order, as use-object-list watches it.
  const watch = useMemo(() => {
    const names = [...filter.map((f) => f.field), spec.sort?.field ?? "updatedAt"];
    return [...new Set(names.flatMap((n) => {
      const col = columns.get(n);
      if (!col) return [];
      if (col.fieldId) return [col.fieldId as string];
      return col.column === "updated_at" ? ["$updatedAt"] : col.column === "created_at" ? ["$createdAt"] : col.column === "title" ? ["$title"] : [];
    }))];
  }, [filter, spec.sort, columns]);
  const { rows, total, hasMore, loadMore, loadingMore, reload, error } = useObjectList(listQuery, { watch });
  const onCreated = (saves: Save[]) => {
    setCreating(false);
    void toast.success(`Created ${desc.label.toLowerCase()}`);
    if (board) setBoardSaves((cur) => ({ n: cur.n + 1, saves }));
    else void reload(saves);
  };
  // Contact AI fields are display-only columns: the register's rows carry no custom values, so a cell reads the
  // answer (quote and source on hover). They never reach the list request, so they can't be filtered or sorted by.
  const contactAiFields = useContactAiFields();
  const aiByColumn = useMemo(() => new Map(object === "contact" ? contactAiFields.map((f) => [`custom.${f.slug}`, f]) : []), [object, contactAiFields]);

  const fieldByName = (name: string) => desc.fields.find((f) => f.apiName === name);
  const labelOf = (name: string) => (aiByColumn.has(name) ? aiByColumn.get(name)!.label : name === "recordTitle" ? desc.fields.find((f) => f.fieldId === desc.titleFieldId)?.label ?? "Name" : fieldByName(name)?.label ?? (name === "createdAt" ? "Created" : name === "updatedAt" ? "Last modified" : name));
  const shownColumns = spec.columns.filter((c) => (columns.has(c) || aiByColumn.has(c)) && c !== "recordTitle" && c !== "id");
  // Hidden fields stay off the chooser (a view that already shows one keeps it); an AI field is offered once.
  const columnChoices = [...new Set([...columns.keys(), ...aiByColumn.keys()])].filter((c) => c !== "id" && c !== "recordTitle" && (!fieldByName(c)?.hidden || shownColumns.includes(c))).map((name) => ({ name, label: labelOf(name) }));
  const shownAiFields = shownColumns.flatMap((c) => aiByColumn.get(c) ?? []);
  const aiAnswers = useContactAnswers(rows?.map((r) => r.id), shownAiFields);
  const editable = desc.fields.filter((f) => isEditable(f) && !desc.readOnlyFields.includes(f.apiName));

  const lookupTitles = useLookupTitles(desc.fields.filter((f) => f.type === "lookup" && shownColumns.includes(f.apiName)), rows);
  const chipsOf = (row: ListRow, name: string) => {
    const f = fieldByName(name);
    return f ? optionChips(f, row.values[f.fieldId] as CellValue) : null;
  };
  const cell = (row: ListRow, name: string): string => {
    if (name === "createdAt") return new Date(row.createdAt).toLocaleString();
    if (name === "updatedAt") return new Date(row.updatedAt).toLocaleString();
    const f = fieldByName(name);
    const value = f ? row.values[f.fieldId] : null;
    if (f?.type === "lookup" && typeof value === "string") return lookupTitles[value] ?? value;
    return f ? formatValue(f, value as CellValue, team) : "";
  };

  const toggleSort = (name: string) => {
    const col = columns.get(name);
    if (!col || col.kind === "multi") return;
    const next: ListSort = spec.sort?.field === name && spec.sort.dir === "asc" ? { field: name, dir: "desc" } : { field: name, dir: "asc" };
    edit({ sort: next });
  };

  const runOnSelection = useCallback(async (op: "update" | "delete" | "restore", values?: Record<string, CellValue>) => {
    // Only rows on screen: a selection never reaches records the current filters hide.
    const onScreen = new Set((rows ?? []).map((r) => r.id));
    const ids = [...selected].filter((id) => onScreen.has(id));
    if (!ids.length) return;
    setBusy(true);
    try {
      // One key per action, so a retried batch replays its edits instead of repeating them.
      const batchKey = crypto.randomUUID();
      const out = desc.register
        ? await runBulk(ids, BULK_MAX, (batch) => bulkRegister({ object: object as "account" | "contact", op, ids: batch, batchKey, ...(values ? { values: values as Record<string, string | number | null> } : {}) }))
        : await runBulk(ids, BULK_MAX, (batch) => bulk({ object: desc.apiName as WritableObject, op, streamIds: batch as Id<"canonEntities">[], ...(values ? { values: values as never } : {}) }));
      const saves: Save[] = [];
      const problems: string[] = [];
      for (const r of out.results.values()) {
        saves.push(...saveOf(r));
        const p = saveProblem(r);
        if (p) problems.push(p);
      }
      const failed = out.failed.size + problems.length;
      const ok = ids.length - failed;
      const verb = op === "update" ? "Updated" : op === "delete" ? "Archived" : "Restored";
      if (failed) void toast.error(`${verb} ${ok} of ${ids.length}. ${[...new Set([...problems, ...out.failed.values()])].slice(0, 3).join(" ")}`);
      else void toast.success(`${verb} ${ok} ${ok === 1 ? desc.label.toLowerCase() : desc.pluralLabel.toLowerCase()}`);
      // Keep the ones that failed selected, so a retry is one click.
      setSelected(new Set([...out.failed.keys(), ...[...out.results].filter(([, r]) => saveProblem(r)).map(([id]) => id)]));
      await reload(saves);
    } finally {
      setBusy(false);
    }
  }, [selected, rows, bulk, bulkRegister, object, desc, reload]);

  async function moveCard(row: ListRow, value: string | null) {
    if (!groupBy) return;
    try {
      if (desc.register) {
        // records.edit returns once the row shows the move, so the columns reload straight away.
        await editRegister({ object: object as "account" | "contact", id: row.id, patch: { [groupBy.apiName]: value }, idempotencyKey: crypto.randomUUID() });
        setBoardSaves((cur) => ({ n: cur.n + 1, saves: [] }));
        return;
      }
      const r = await write({ object: desc.apiName as WritableObject, streamId: row.id as Id<"canonEntities">, values: { [groupBy.apiName]: value }, expectedVersion: row.version });
      const problem = saveProblem(r);
      if (problem) void toast.error(problem);
      setBoardSaves((cur) => ({ n: cur.n + 1, saves: saveOf(r) }));
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    }
  }

  async function saveView(asNew: boolean) {
    if (contextWaiting) { void toast.error("Wait for a valid filter before saving a view."); return; }
    try {
      if (activeView && !asNew) {
        await updateView({ viewId: activeView._id, spec: { ...spec, filter } });
        setDirty(false);
        void toast.success(`Saved ${activeView.name}`);
        return;
      }
      const name = naming?.name.trim();
      if (!name) return;
      const id = await createView({ object, name, shared: naming!.shared, spec: { ...spec, filter } });
      setNaming(null);
      setUrl({ view: id });
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    }
  }

  async function deleteView() {
    if (!activeView) return;
    if (confirming !== "view") {
      setConfirming("view");
      return;
    }
    setConfirming(null);
    // Leave the view first, so its disappearing from the list is not reported as someone else's doing.
    const viewId = activeView._id;
    deleting.current = viewId;
    setUrl({ view: "" });
    try {
      await removeView({ viewId });
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    }
  }

  const allSelected = rows !== null && rows.length > 0 && rows.every((r) => selected.has(r.id));
  const hrefOf = (row: ListRow) => recordHref(desc.apiName, row.id);
  useRecordsSaved((saves) => { if (board) setBoardSaves((current) => ({ n: current.n + 1, saves })); });

  return (
    <ViewFrame
      title={bin ? `Archived ${desc.pluralLabel.toLowerCase()}` : desc.pluralLabel}
      description={bin ? "Archived records are hidden from lists, search, reports and agents until restored." : undefined}
      actions={[
        { id: `${object}-refresh`, label: "Refresh", onClick: () => board ? setBoardSaves((current) => ({ n: current.n + 1, saves: [] })) : void reload() },
        ...(desc.canCreate && !bin ? [{ id: `${object}-new`, label: `New ${desc.label.toLowerCase()}`, onClick: () => setCreating(true), primary: true }] : []),
      ]}
      secondaryActions={<>
        {listQuery && <ExportView desc={desc} query={listQuery} columns={shownColumns.filter((c) => !aiByColumn.has(c))} team={team} className="view-action" />}
        {(object === "account" || object === "contact" || (object === "deal" && desc.canCreate)) && !bin && <CsvImport object={object} label={desc.pluralLabel.toLowerCase()} className="view-action" />}
        {(["task", "note", "call", "meeting"].includes(object)) && desc.canCreate && !bin && <CsvImport object="activity" kind={object} label="activities" className="view-action" />}
        {(object === "lead" || object === "product") && desc.canCreate && !bin && <CsvImport object={object} label={desc.pluralLabel.toLowerCase()} className="view-action" />}
        {desc.kind === "custom" && desc.canCreate && !bin && <CustomCsvImport desc={desc} className="view-action" />}
      </>}
      filterReset={{ onClick: () => edit({ filter: [] }), disabled: !spec.filter.length }}
      controls={<div><div className="mb-3 flex flex-wrap items-center gap-2">
        <SelectField aria-label="Saved view" value={url.view} onValueChange={(view) => setUrl({ view, filter: "", returnTo: "" })}
          options={[
            { value: "", label: `All ${desc.pluralLabel.toLowerCase()}` },
            ...(views ?? []).map((v) => ({ value: v._id, label: `${v.name}${v.shared ? " (shared)" : ""}` })),
          ]} />
        {activeView?.mine && dirty && <button type="button" disabled={contextWaiting} onClick={() => void saveView(false)} className={btn}>Save view</button>}
        {naming ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveView(true);
            }}
          >
            <input
              autoFocus
              aria-label="View name"
              placeholder="View name"
              value={naming.name}
              onChange={(e) => setNaming({ ...naming, name: e.target.value })}
              className="border border-border bg-background px-2 py-1 text-xs"
            />
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={naming.shared} onChange={(e) => setNaming({ ...naming, shared: e.target.checked })} /> Share with team
            </label>
            <button type="submit" disabled={contextWaiting || !naming.name.trim()} className={btn}>Save</button>
            <button type="button" onClick={() => setNaming(null)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
          </form>
        ) : (
          <button type="button" disabled={contextWaiting} onClick={() => setNaming({ name: "", shared: false })} className={btn}>Save as new view</button>
        )}
        {activeView?.mine && (
          <button type="button" onClick={() => void deleteView()} onBlur={() => setConfirming(null)} className={btn}>
            {confirming === "view" ? `Confirm delete ${activeView.name}` : "Delete view"}
          </button>
        )}
        <span className="mx-1 h-4 w-px bg-border" />
        {object === "lead" && !bin && (
          <div role="radiogroup" aria-label="Lead status view" className="flex border border-border">
            {([["open", "Open"], ["converted", "Converted"], ["all", "All"]] as const).map(([key, text]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={leadView(spec.filter) === key}
                onClick={() => edit({ filter: [...spec.filter.filter((f) => f.field !== "convertedAt"), ...(key === "open" ? [OPEN_LEADS] : key === "converted" ? [CONVERTED_LEADS] : [])] })}
                className={cn("px-2 py-1 text-xs", leadView(spec.filter) === key && "bg-primary text-primary-foreground")}
              >
                {text}
              </button>
            ))}
          </div>
        )}
        <div role="radiogroup" aria-label="Layout" className="flex border border-border">
          <button type="button" role="radio" aria-checked={!board} onClick={() => edit({ layout: "table" })} className={cn("flex items-center gap-1 px-2 py-1 text-xs", !board && "bg-primary text-primary-foreground")}><Rows3 className="h-3 w-3" /> Table</button>
          <button
            type="button"
            role="radio"
            aria-checked={board}
            disabled={!picklists.length || bin || listFilter.length >= FILTERS_MAX}
            onClick={() => edit({ layout: "board", groupBy: groupBy?.apiName ?? picklists[0]?.apiName })}
            className={cn("flex items-center gap-1 px-2 py-1 text-xs disabled:opacity-40", board && "bg-primary text-primary-foreground")}
          >
            <KanbanSquare className="h-3 w-3" /> Board
          </button>
        </div>
        {board && picklists.length > 1 && (
          <SelectField aria-label="Group board by" value={groupBy?.apiName ?? ""} onValueChange={(v) => edit({ groupBy: v })}
            options={picklists.map((f) => ({ value: f.apiName, label: f.label }))} />
        )}
        {board && pipeline && pipelines && pipelines.length > 1 && (
          <SelectField aria-label="Pipeline" value={pipeline.id ?? ""} onValueChange={(v) => setUrl({ pipeline: v })}
            options={pipelines.map((p) => ({ value: p.id ?? "", label: p.name }))} />
        )}
        {!board && <ColumnChooser columns={shownColumns} choices={columnChoices} onChange={(next) => edit({ columns: next })} />}
        {object === "contact" && !bin && (context.kind === "core" || (!returnPresent && !contextWaiting)) && <ContactAudienceActions filter={listFilter} viewId={activeView?._id} audience={audience?.canEdit === false ? null : audience} onDoneEditing={() => setUrl({ audience: "", filter: "", returnTo: "" })} />}
        {object === "contact" && !bin && !contextWaiting && !handoffProblem && listModules?.some((m) => m.listActions?.length) && (
          <details className="relative">
            <summary className={cn(btn, "cursor-pointer")}>Modules</summary>
            <div className="absolute right-0 z-20 mt-1 min-w-52 border border-border bg-popover p-2 shadow-md">
              {listModules.filter((m) => m.listActions?.length).map((m) => <div key={m.module} className="py-1"><p className="px-2 text-xs font-medium text-muted-foreground">{m.title}</p>{m.listActions?.map((action) => <Link key={action.id} className="block px-2 py-1 text-sm hover:bg-muted" href={moduleFilterHref(m.module, action, listFilter)}>{action.label}</Link>)}</div>)}
            </div>
          </details>
        )}
        {moduleReturn?.target && !contextWaiting && !handoffProblem && <Link className={btn} href={moduleFilterHref(moduleReturn.target.module, moduleReturn.target.form, listFilter)}>Back to {moduleReturn.target.title}</Link>}
        {desc.canDelete && <button type="button" onClick={() => { setSelected(new Set()); setUrl({ bin: bin ? "" : "1" }); }} className={btn}>
          {bin ? <><Undo2 className="h-3 w-3" /> Back to list</> : <><Archive className="h-3 w-3" /> Archived</>}
        </button>}
      </div>

      <div>
        {contextProblem && <p role="alert" className="mb-2 text-sm text-destructive">Could not open this filter. {contextProblem}</p>}
        {context.kind === "filter" && handoffProblem && !contextProblem && <p role="alert" className="mb-2 text-sm text-destructive">{handoffProblem}</p>}
        <FilterBar filters={spec.filter} columns={columns} dayColumns={dayColumns} canAdd={filterRoom >= 2} resetKey={specLoads} fields={desc.fields} team={team} onChange={(next) => edit({ filter: next })} />
      </div></div>}
    >

      {contextWaiting ? <div className="p-4 text-sm text-muted-foreground">{contextProblem || handoffProblem ? "No People request was made. Reopen the filter from its module." : "Loading filter…"}</div> : board && groupBy ? (
        <BoardView
          object={object}
          groupBy={groupBy}
          filter={listFilter}
          sort={spec.sort}
          watch={watch}
          onStale={() => setBoardSaves((cur) => ({ n: cur.n + 1, saves: [] }))}
          cardFields={desc.fields.filter((f) => shownColumns.includes(f.apiName) && f.fieldId !== groupBy.fieldId).slice(0, 3)}
          team={team}
          // A grouping field the edit endpoint does not take makes a read-only board.
          writable={desc.writable && !desc.readOnlyFields.includes(groupBy.apiName)}
          hrefOf={hrefOf}
          onMove={(row, value) => void moveCard(row, value)}
          saves={boardSaves}
          columns={pipelineColumns}
          // Org-wide totals: only while no filter narrows the columns.
          totals={pipeline && !listFilter.length && stageTotals && !stageTotals.partial ? new Map(stageTotals.stages.map((t) => [t.stage, t])) : undefined}
        />
      ) : (
        <>
          {bulkable && selected.size > 0 && (
            <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
              {bin ? (
                <button type="button" disabled={busy} onClick={() => void runOnSelection("restore")} className={btn}><Undo2 className="h-3 w-3" /> Restore</button>
              ) : (
                <>
                  <BulkEdit fields={editable} team={team} busy={busy} onApply={(apiName, value) => void runOnSelection("update", { [apiName]: value })} />
                  {desc.canDelete && <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (confirming !== "records") return setConfirming("records");
                      setConfirming(null);
                      void runOnSelection("delete");
                    }}
                    onBlur={() => setConfirming(null)}
                    className={cn(btn, confirming === "records" && "border-destructive text-destructive")}
                  >
                    <Archive className="h-3 w-3" /> {confirming === "records" ? `Confirm archive ${selected.size}` : "Archive"}
                  </button>}
                  {desc.register && desc.canDelete && selected.size >= 2 && selected.size <= MERGE_MAX && (
                    <button type="button" disabled={busy} onClick={() => setMerging(true)} className={btn}><GitMerge className="h-3 w-3" /> Merge</button>
                  )}
                </>
              )}
            </SelectionBar>
          )}
          {error && <ReadFailure message={error} retry={() => void reload()} retained={rows !== null} />}
          {rows === null ? (
            error ? null : <LoadingRows />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={bin ? Archive : Rows3}
              title={bin ? "Nothing is archived" : filter.length ? "No records match these filters" : `No ${desc.pluralLabel.toLowerCase()} yet`}
              description={bin ? "Records you delete show up here." : filter.length ? "Change or remove a filter." : desc.canCreate ? `Create the first ${desc.label.toLowerCase()}.` : "Records appear here as they are created."}
            />
          ) : (
            <>
              <div className="mb-2 text-xs font-medium text-muted-foreground">{rows.length} of {total}</div>
              <div className="overflow-x-auto border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                    <tr>
                      {bulkable && (
                        <th className="w-8 px-3 py-2">
                          <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} />
                        </th>
                      )}
                      {["recordTitle", ...shownColumns].map((name) => {
                        const sortable = columns.has(name) && columns.get(name)?.kind !== "multi";
                        const dir = spec.sort?.field === name ? spec.sort.dir : null;
                        return (
                          <th key={name} className="whitespace-nowrap px-3 py-2" title={aiByColumn.get(name)?.question} aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}>
                            {sortable ? (
                              <button type="button" onClick={() => toggleSort(name)} className="inline-flex items-center gap-1 hover:text-foreground">
                                {labelOf(name)}
                                {dir === "asc" && <ArrowUp className="h-3 w-3" />}
                                {dir === "desc" && <ArrowDown className="h-3 w-3" />}
                              </button>
                            ) : labelOf(name)}
                          </th>
                        );
                      })}
                      {object === "lead" && !bin && <th className="px-3 py-2" />}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} className={cn("border-t border-border", selected.has(row.id) && "bg-primary/5")}>
                        {bulkable && (
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              aria-label={`Select ${row.title}`}
                              checked={selected.has(row.id)}
                              onChange={() => setSelected((cur) => {
                                const next = new Set(cur);
                                if (next.has(row.id)) next.delete(row.id);
                                else next.add(row.id);
                                return next;
                              })}
                            />
                          </td>
                        )}
                        <td className="max-w-xs px-3 py-2 record-name">
                          <div className="flex min-w-0 items-center gap-1">
                            <RecordLink object={object} id={row.id} className="min-w-0 truncate hover:underline">
                              {row.title || "Untitled"}
                            </RecordLink>
                            <RecordQuickView object={object} id={row.id} label={row.title || "Untitled"} />
                          </div>
                        </td>
                        {shownColumns.map((name) => {
                          const ai = aiByColumn.get(name);
                          return (
                            <td key={name} className="max-w-xs truncate px-3 py-2">
                              {ai ? <AiCell field={ai} answer={aiAnswers?.[row.id]?.[ai.slug]} /> : chipsOf(row, name) ?? (cell(row, name) || <span className="text-muted-foreground">—</span>)}
                            </td>
                          );
                        })}
                        {object === "lead" && !bin && (
                          <td className="whitespace-nowrap px-3 py-2 text-right">
                            {row.values.convertedAt ? (
                              <span className="text-xs font-medium text-muted-foreground">Converted</span>
                            ) : (
                              <button type="button" onClick={() => setConvertingId(row.id)} className={btn}><UserCheck className="h-3 w-3" /> Convert</button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {hasMore && (
                <button type="button" disabled={loadingMore} onClick={() => void loadMore()} className={cn(btn, "mt-4 px-4 py-2")}>
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              )}
            </>
          )}
        </>
      )}

      {desc.canCreate && (desc.apiName === "deal" ? (
        <DealCreateDialog desc={desc} open={creating} onClose={() => setCreating(false)} onCreated={(created) => onCreated(saveOf(created.result))} />
      ) : (
        <CreateDialog desc={desc} team={team} open={creating} onClose={() => setCreating(false)} onCreated={(_id, saves) => onCreated(saves)} />
      ))}
      {object === "lead" && convertingId && (
        <ConvertLeadDialog leadId={convertingId} open onClose={() => setConvertingId(null)} onConverted={() => void reload()} />
      )}
      {merging && desc.register && (
        <MergeDialog
          object={object as "account" | "contact"}
          // In the order they are listed, so the first one on screen is the default survivor.
          ids={(rows ?? []).map((r) => r.id).filter((id) => selected.has(id))}
          onClose={() => setMerging(false)}
          onMerged={(survivorId) => {
            setMerging(false);
            setSelected(new Set());
            void reload([]);
            inspection?.open({ object, id: survivorId });
          }}
        />
      )}

    </ViewFrame>
  );
}
