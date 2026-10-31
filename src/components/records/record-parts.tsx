"use client";

/** The pieces every record page shares: its frame, its field groups and its history. */
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useAction, usePaginatedQuery, useQuery } from "convex/react";
import { ArrowLeft, ArrowUpRight, Undo2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { formatValue, type CellValue, type FieldDescription, type TeamMember } from "./fields";
import { recordHref, recordListOf } from "./record-target";
import type { Save } from "./use-object-list";
import { useLookupTitles } from "./lookup-field";

export const SOURCE_LABEL: Record<string, string> = {
  salesforce: "Salesforce", hubspot: "HubSpot", import: "an import", call: "a call", email: "an email", linkedin: "a LinkedIn message", enrichment: "enrichment", pipeline: "a pipeline", agent_run: "an agent",
};

export const btn = "inline-flex items-center gap-1 border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50";

type HistoryEntry = {
  version: number;
  observedAt: number;
  source: { kind: string; ref: string };
  actor: { kind: string; id?: string };
  body:
    | { kind: "assert"; status: string; assertions: Array<{ fieldId: string; value: CellValue; validFrom?: number }> }
    | { kind: "decide"; decisions: Array<{ fact: { fieldId: string; value: CellValue }; status: string }> }
    /** `absorb` (a merge's survivor) carries `mergeId` and the records it took in. */
    | { kind: "lifecycle"; op: string; into?: string; mergeId?: string; from?: MergedFrom[] }
    | { kind: "confirm"; fieldIds: string[] }
    | { kind: "revert"; mergeId: string; fields: Array<{ fieldId: string }> };
};

/** A record a merge took in, as the survivor's `absorb` entry keeps it (convex/lib/objects/fold.ts MergedRecord). */
type MergedFrom = { streamId: string; recordId: string; title: string; values: Array<{ fieldId: string; value: CellValue; sourceKind: string | null }> };

/** The field values an entry asserts or decides, for reading lookup titles. */
function entryValues(entry: HistoryEntry): Array<{ values: Record<string, CellValue> }> {
  const b = entry.body;
  switch (b.kind) {
    case "assert":
      return b.assertions.map((a) => ({ values: { [a.fieldId]: a.value } }));
    case "decide":
      return b.decisions.map((d) => ({ values: { [d.fact.fieldId]: d.fact.value } }));
    case "lifecycle":
      return (b.from ?? []).map((r) => ({ values: Object.fromEntries(r.values.map((x) => [x.fieldId, x.value])) }));
    case "confirm":
    case "revert":
      return [];
  }
}

function describeEntry(entry: HistoryEntry, fields: readonly FieldDescription[], titles: Readonly<Record<string, string>>, team?: readonly TeamMember[]): string[] {
  const field = (id: string) => fields.find((f) => f.fieldId === id);
  const shown = (id: string, value: CellValue) => {
    const f = field(id);
    // A lookup shows its target's title once read; a deleted or unread target shows its id.
    const title = f && "lookupTo" in f && typeof value === "string" ? titles[value] || undefined : undefined;
    const text = title ?? (f ? formatValue(f, value, team) : String(value));
    return `${f?.label ?? id} → ${text || "empty"}`;
  };
  const b = entry.body;
  switch (b.kind) {
    case "assert":
      return b.assertions.map((a) => (b.status === "proposed" ? `Proposed ${shown(a.fieldId, a.value)}` : shown(a.fieldId, a.value)));
    case "decide":
      return b.decisions.map((d) => `${d.status === "accepted" ? "Accepted" : "Rejected"} ${shown(d.fact.fieldId, d.fact.value)}`);
    case "lifecycle":
      if (b.op === "absorb") {
        // What each merged record said, with where it came from: the values the merge did not keep stay readable here.
        return (b.from ?? []).flatMap((r) => [
          `Merged in ${r.title || r.recordId}`,
          ...r.values.map((x) => `  ${shown(x.fieldId, x.value)}${x.sourceKind ? ` (from ${SOURCE_LABEL[x.sourceKind] ?? (x.sourceKind === "user" ? "a person" : x.sourceKind)})` : ""}`),
        ]);
      }
      return [{ create: "Created", delete: "Archived", restore: "Restored", erase: "Erased", merge: "Merged into another record" }[b.op] ?? b.op];
    case "confirm":
      return [`Confirmed ${b.fieldIds.map((id) => field(id)?.label ?? id).join(", ")}`];
    case "revert":
      return [`Undid a merge${b.fields.length ? `: ${b.fields.map((f) => field(f.fieldId)?.label ?? f.fieldId).join(", ")} back as before` : ""}`];
  }
}

/** Undo on a merge's history entry, while the merge stands and the person may undo it. */
function UndoMerge({ mergeId, onUndone }: { mergeId: string; onUndone?: () => void }) {
  const merge = useQuery(api.recordMerges.get, { mergeId });
  const undo = useAction(api.recordMerges.undo);
  const [busy, setBusy] = useState(false);
  if (!merge) return null;
  if (merge.undoneAt) return <div className="text-xs text-muted-foreground">Undone {new Date(merge.undoneAt).toLocaleString()}</div>;
  if (!merge.mayUndo) return null;
  return (
    <button
      type="button" disabled={busy} className={cn(btn, "mt-1")}
      onClick={async () => {
        setBusy(true);
        try {
          const out = await undo({ mergeId });
          void toast.success(out.kept.length ? `Merge undone. Kept the later change to ${out.kept.join(", ")}.` : "Merge undone");
          onUndone?.();
        } catch (cause) {
          void toast.error(getErrorMessage(cause));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Undo2 className="h-3 w-3" /> {busy ? "Undoing…" : "Undo merge"}
    </button>
  );
}

/** A CRM's past value (an import's field history) held from a time well before it was recorded: that time. */
function validAsOf(e: HistoryEntry): string {
  const at = e.body.kind === "assert" ? e.body.assertions[0]?.validFrom : undefined;
  if (at === undefined || e.observedAt - at < 24 * 60 * 60 * 1000) return "";
  return ` · ${e.source.ref.startsWith("hubspot-history:") ? "in HubSpot " : ""}as of ${new Date(at).toLocaleDateString()}`;
}

type HistoryPages = { results: HistoryEntry[]; status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"; loadMore: (n: number) => void };

/**
 * A record's history, page by page: the live query, or for a company or person
 * whose object the caller sees only some of, the action twin that admits it
 * (CP14; objects.historyScoped). `refresh` reads the twin's first page again.
 */
function useHistory(streamId: Id<"canonEntities">, scoped: boolean, refresh: unknown): HistoryPages {
  const live = usePaginatedQuery(api.objects.history, scoped ? "skip" : { streamId }, { initialNumItems: 25 });
  const read = useAction(api.objects.historyScoped);
  const [state, setState] = useState<{ streamId: string; page: HistoryEntry[]; cursor: string; done: boolean; loading: boolean }>();
  useEffect(() => {
    if (!scoped) return;
    let on = true;
    read({ streamId, paginationOpts: { numItems: 25, cursor: null } })
      .then((r) => { if (on) setState({ streamId, page: r.page as HistoryEntry[], cursor: r.continueCursor, done: r.isDone, loading: false }); })
      .catch((cause: unknown) => console.warn("History:", cause));
    return () => { on = false; };
  }, [scoped, streamId, read, refresh]);
  if (!scoped) return { results: live.results as HistoryEntry[], status: live.status, loadMore: live.loadMore };
  const mine = state?.streamId === streamId ? state : undefined;
  return {
    results: mine?.page ?? [],
    status: !mine ? "LoadingFirstPage" : mine.loading ? "LoadingMore" : mine.done ? "Exhausted" : "CanLoadMore",
    loadMore: (n) => {
      if (!mine || mine.done || mine.loading) return;
      setState({ ...mine, loading: true });
      read({ streamId, paginationOpts: { numItems: n, cursor: mine.cursor } })
        .then((r) => setState((cur) => (cur?.streamId === streamId ? { ...cur, page: [...cur.page, ...(r.page as HistoryEntry[])], cursor: r.continueCursor, done: r.isDone, loading: false } : cur)))
        .catch((cause: unknown) => console.warn("History:", cause));
    },
  };
}

export function History({ streamId, fields, team, onUndone, scoped = false, refresh, title = "History" }: { streamId: Id<"canonEntities">; fields: readonly FieldDescription[]; team?: readonly TeamMember[]; onUndone?: () => void; scoped?: boolean; refresh?: unknown; title?: string }) {
  const { results, status, loadMore } = useHistory(streamId, scoped, refresh);
  const entries = results as HistoryEntry[];
  const titles = useLookupTitles(fields, entries.flatMap(entryValues));
  const rules = useQuery(api.automations.labels);
  // An automation rule's write (convex/automations.ts): its source ref names the rule; the actor is the admin it runs as.
  const ruleOf = (e: HistoryEntry) => /^automation:([^:]+):/.exec(e.source.ref)?.[1];
  const who = (e: HistoryEntry) => (ruleOf(e) ? `Rule "${rules?.find((r) => r.id === ruleOf(e))?.name ?? "deleted rule"}"${e.actor.kind === "user" ? `, as ${team?.find((u) => u._id === e.actor.id)?.name ?? "its creator"}` : ""}`
    : e.actor.kind === "user" ? team?.find((u) => u._id === e.actor.id)?.name ?? "A teammate"
    : e.actor.kind === "rule" ? "An auto-accept rule"
    : e.source.ref.startsWith("grant:") ? "An agent's standing grant" : e.source.kind);
  return (
    <section className="border border-border bg-card p-4">
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h2>
      {results.length === 0 && status !== "LoadingFirstPage" ? (
        <p className="text-sm text-muted-foreground">No changes yet.</p>
      ) : (
        <ol className="space-y-2 text-sm">
          {entries.map((e) => (
            <li key={e.version} className="border-b border-border pb-2 last:border-b-0">
              {describeEntry(e, fields, titles, team).map((line, i) => <div key={i} className={line.startsWith("  ") ? "pl-4 text-xs text-muted-foreground" : undefined}>{line.trim()}</div>)}
              {e.body.kind === "lifecycle" && e.body.op === "absorb" && e.body.mergeId && <UndoMerge mergeId={e.body.mergeId} onUndone={onUndone} />}
              <div className="text-xs text-muted-foreground">{who(e)}{e.actor.kind === "user" && e.source.kind !== "user" ? ` via ${SOURCE_LABEL[e.source.kind] ?? e.source.kind}` : ""} · {new Date(e.observedAt).toLocaleString()}{validAsOf(e)} · v{e.version}</div>
            </li>
          ))}
        </ol>
      )}
      {status === "CanLoadMore" && <button type="button" onClick={() => loadMore(25)} className={cn(btn, "mt-3")}>Older changes</button>}
    </section>
  );
}

/** A record's fields in titled groups, each a card; a collapsed group starts folded. */
export function FieldGroups({ groups, field }: { groups: ReadonlyArray<{ title: string; collapsed: boolean; fields: readonly FieldDescription[] }>; field: (f: FieldDescription) => ReactNode }) {
  const heading = "text-xs font-medium text-muted-foreground";
  return groups.map(({ title, collapsed, fields }) => {
    const rows = <dl className={collapsed ? "mt-2" : undefined}>{fields.map(field)}</dl>;
    return collapsed ? (
      <details key={title} className="border border-border bg-card p-4"><summary className={cn(heading, "cursor-pointer")}>{title}</summary>{rows}</details>
    ) : (
      <section key={title} className="border border-border bg-card p-4"><h2 className={cn(heading, "mb-2")}>{title}</h2>{rows}</section>
    );
  });
}

/** A record shown in a dialog over a list, which reloads on each save it reports. */
export type InDialog = { onSaved: (saves: Save[]) => void };

export function Frame({ object, id, plural, inDialog, children }: { object: string; id: string; plural: string; inDialog?: InDialog; children: ReactNode }) {
  const link = "mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground";
  if (inDialog) {
    return <div className="record-frame"><Link href={recordHref(object, id)} className="record-full-page">Open full page <ArrowUpRight className="h-3 w-3" /></Link>{children}</div>;
  }
  const back = recordListOf(object, plural);
  return (
    <div className="record-frame record-full-frame">
      <Link href={back.href} className={link}><ArrowLeft className="h-3 w-3" /> {back.label}</Link>
      {children}
    </div>
  );
}

