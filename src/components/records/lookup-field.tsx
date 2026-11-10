"use client";

import { useEffect, useRef, useState } from "react";
import { RecordLink } from "./record-context";
export { recordHref } from "./record-target";
import { useAction } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { SearchHit } from "../../../convex/lib/objects/listSpec";
import type { CellValue, FieldDescription } from "./fields";

export type ListedObject = FunctionArgs<typeof api.objects.list>["object"];
export type PickedRecord = { id: string; title: string };

const SEARCH_DEBOUNCE_MS = 150;
const linkBtn = "text-xs text-muted-foreground underline hover:text-foreground";


/** Records of one object whose title matches what is typed; a reply to an older query never replaces a newer one. */
export function RecordPicker({ object, label, autoFocus, onPick, onCancel }: {
  object: ListedObject;
  label: string;
  autoFocus?: boolean;
  onPick: (picked: PickedRecord) => void;
  onCancel?: () => void;
}) {
  const search = useAction(api.objects.search);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const latest = useRef(0);
  useEffect(() => {
    const seq = ++latest.current;
    const term = q.trim();
    const settle = (next: SearchHit[]) => { if (seq === latest.current) setHits(next); };
    if (!term) {
      settle([]);
      return;
    }
    const timer = setTimeout(() => {
      search({ q: term, objects: [object], limit: 8, perObject: 8 }).then((r) => settle(r.hits), () => settle([]));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, object, search]);

  return (
    <div className="relative">
      <input
        aria-label={label}
        placeholder={label}
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel?.();
          if (e.key === "Enter") {
            e.preventDefault();
            if (hits[0]) onPick({ id: hits[0].id, title: hits[0].title });
          }
        }}
        className="w-full border border-border bg-background px-2 py-1 text-sm"
      />
      {hits.length > 0 && (
        <ul role="listbox" aria-label={label} className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto border border-border bg-popover text-sm shadow-md">
          {hits.map((h) => (
            <li key={h.id} role="option" aria-selected={false}>
              <button type="button" onClick={() => onPick({ id: h.id, title: h.title })} className="flex w-full items-baseline justify-between gap-2 px-2 py-1.5 text-left hover:bg-muted">
                <span>{h.title || h.id}</span>
                {typeof h.detail?.domain === "string" && <span className="text-xs text-muted-foreground">{h.detail.domain}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A lookup's target as a link, named by its title once read. An account opens on the Accounts page. */
export function LookupLink({ object, id, title: known, className = "px-2 py-1 text-sm underline" }: { object: ListedObject; id: string; title?: string; className?: string }) {
  const list = useAction(api.objects.list);
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (known) return;
    let live = true;
    void (async () => {
      // A record made a moment ago (a lead's converted deal) reaches the list once the projector has applied it: ask again, briefly.
      for (let attempt = 0; attempt < 8 && live; attempt++) {
        const row = (await list({ object, filter: [{ field: "id", op: "eq", value: id }], limit: 1 }).catch(() => null))?.rows[0];
        if (row) {
          if (live) setTitle(row.title ?? "");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    })();
    return () => { live = false; };
  }, [list, object, id, known]);
  return <RecordLink object={object} id={id} className={className}>{known || title || id}</RecordLink>;
}

/** Titles of the records that `fields` (lookups) point at in `rows`, one list call per target object. */
export function useLookupTitles(fields: readonly FieldDescription[], rows: ReadonlyArray<{ values: Record<string, unknown> }> | undefined | null): Record<string, string> {
  const list = useAction(api.objects.list);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const wanted = new Map<string, Set<string>>();
  for (const f of fields) {
    if (!("lookupTo" in f)) continue;
    for (const row of rows ?? []) {
      const id = row.values[f.fieldId];
      if (typeof id === "string" && id) wanted.set(f.lookupTo, (wanted.get(f.lookupTo) ?? new Set()).add(id));
    }
  }
  const key = JSON.stringify([...wanted].map(([object, ids]) => [object, [...ids].sort()]).sort());
  useEffect(() => {
    let live = true;
    for (const [object, ids] of JSON.parse(key) as Array<[ListedObject, string[]]>) {
      list({ object, filter: [{ field: "id", op: "in", value: ids.slice(0, 200) }], limit: Math.min(ids.length, 200) })
        .then((page) => { if (live) setTitles((cur) => ({ ...cur, ...Object.fromEntries(page.rows.map((r) => [r.id, r.title])) })); })
        .catch(() => undefined);
    }
    return () => { live = false; };
  }, [list, key]);
  return titles;
}

/** A lookup in a form (a new record, a bulk edit): search the target object and pick one, as a record page does; the value is its id. */
export function LookupInput({ field, value, onChange }: { field: FieldDescription; value: CellValue | undefined; onChange: (next: string | null) => void }) {
  const [picked, setPicked] = useState<PickedRecord | null>(null);
  if (!("lookupTo" in field)) return null;
  const object = field.lookupTo as ListedObject;
  const id = typeof value === "string" && value ? value : null;
  if (!id) return <RecordPicker object={object} label={`Search ${field.label.toLowerCase()}`} onPick={(p) => { setPicked(p); onChange(p.id); }} />;
  return (
    <div className="flex items-center gap-3">
      <LookupLink object={object} id={id} title={picked?.id === id ? picked.title : undefined} />
      <button type="button" onClick={() => onChange(null)} className={linkBtn}>Change</button>
    </div>
  );
}

/** A lookup on a record page: its target as a link, changed by searching the target object, or cleared. */
export function LookupField({ field, value, version, readOnly, onSave }: {
  field: FieldDescription;
  value: CellValue | undefined;
  version: number;
  readOnly: boolean;
  onSave: (next: string | null, expectedVersion: number) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  if (!("lookupTo" in field)) return null;
  const object = field.lookupTo as ListedObject;
  const id = typeof value === "string" && value ? value : null;

  async function save(next: string | null) {
    setSaving(true);
    const ok = await onSave(next, version).finally(() => setSaving(false));
    if (ok) setEditing(false);
  }

  if (editing && !readOnly) {
    return (
      <div data-field-editor className="contents" onKeyDown={(event) => { if (event.key === "Escape") setEditing(false); }}>
        <RecordPicker object={object} label={`Search ${field.label.toLowerCase()}`} autoFocus onCancel={() => setEditing(false)} onPick={(p) => void save(p.id)} />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3">
      {id ? <LookupLink object={object} id={id} /> : <span className="px-2 py-1 text-sm text-muted-foreground">—</span>}
      {!readOnly && (
        <>
          <button type="button" disabled={saving} onClick={() => setEditing(true)} className={linkBtn}>{id ? "Change" : "Set"}</button>
          {id && <button type="button" disabled={saving} onClick={() => void save(null)} className={linkBtn}>Clear</button>}
        </>
      )}
    </div>
  );
}
