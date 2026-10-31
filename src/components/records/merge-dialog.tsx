"use client";

import { useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { GitMerge, Search } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { MergePreview } from "../../../convex/recordMerges";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { formatValue, type CellValue, type FieldDescription, type TeamMember } from "./fields";

type PartyObject = "account" | "contact";

const SOURCE_LABEL: Record<string, string> = {
  user: "a person", salesforce: "Salesforce", hubspot: "HubSpot", import: "an import", call: "a call", email: "an email", linkedin: "a LinkedIn message", enrichment: "enrichment", pipeline: "a pipeline", agent_run: "an agent",
};

const btn = "inline-flex items-center gap-1 border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50";

const nouns = (object: PartyObject, n: number) => (object === "account" ? (n === 1 ? "company" : "companies") : n === 1 ? "person" : "people");

/**
 * Merge 2 to 9 companies or people (CP15a, convex/recordMerges.ts): every field of every record side by side.
 * The person picks the record that survives and, per field, the value it keeps; the default is the most
 * recent value, never an agent's over a person's, a CRM's or an import's. A domain or email stays the survivor's.
 */
export function MergeDialog({ object, ids, onClose, onMerged }: { object: PartyObject; ids: readonly string[]; onClose: () => void; onMerged: (survivorId: string) => void }) {
  const preview = useAction(api.recordMerges.preview);
  const merge = useAction(api.recordMerges.merge);
  const desc = useQuery(api.objects.describe, { object });
  const team = useQuery(api.users.list) as TeamMember[] | undefined;
  const [data, setData] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [survivor, setSurvivor] = useState(ids[0]);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    preview({ object, ids: [...ids] })
      .then((p) => {
        if (!current) return;
        setData(p);
        setPicks(p.picks);
      })
      .catch((cause) => current && setError(getErrorMessage(cause)));
    return () => {
      current = false;
    };
  }, [preview, object, ids]);

  const fieldOf = useMemo(() => new Map(((desc?.fields ?? []) as FieldDescription[]).map((f) => [f.apiName, f])), [desc]);
  const shown = (apiName: string, value: CellValue) => {
    const f = fieldOf.get(apiName);
    return (f ? formatValue(f, value, team) : value === null ? "" : String(value)) || "—";
  };

  async function confirm() {
    if (!data) return;
    setBusy(true);
    try {
      // Only the fields whose kept value is another record's: the rest are the survivor's already.
      const chosen = Object.fromEntries(data.fields.filter((f) => !f.fixed && picks[f.apiName] && picks[f.apiName] !== survivor).map((f) => [f.apiName, picks[f.apiName]]));
      const out = await merge({ object, survivorId: survivor, loserIds: ids.filter((id) => id !== survivor), picks: chosen });
      void toast.success(`Merged ${ids.length} ${nouns(object, ids.length)}. Undo it from the record's history.`);
      onMerged(out.survivorId);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Merge {ids.length} {nouns(object, ids.length)}</DialogTitle>
          <DialogDescription>
            Pick the record that stays and, for each field, the value it keeps. The others are merged into it: their
            {object === "account" ? " people, deals" : " companies"} and activities move to it, and their {object === "account" ? "domains" : "emails"}{" "}point to it.
            You can undo this from the record&apos;s history.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Reading the records…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" aria-label="Values to keep">
              <thead>
                <tr>
                  <th className="w-40 border-b border-border p-2 text-left text-xs font-medium text-muted-foreground">Keep</th>
                  {data.records.map((r) => (
                    <th key={r.id} className={cn("border-b border-border p-2 text-left", survivor === r.id && "bg-primary/5")}>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input type="radio" name="survivor" checked={survivor === r.id} onChange={() => setSurvivor(r.id)} aria-label={`Keep ${r.title}`} />
                        <span className="font-medium">{r.title}</span>
                      </label>
                      {survivor === r.id && <span className="mt-0.5 block text-xs font-medium text-primary">Stays</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.fields.map((f) => {
                  const empty = data.records.every((r) => r.cells[f.apiName]?.value == null || r.cells[f.apiName]?.value === "");
                  if (empty) return null;
                  return (
                    <tr key={f.apiName} className="border-b border-border last:border-b-0">
                      <th scope="row" className="p-2 text-left align-top text-xs font-medium text-muted-foreground">
                        {f.label}
                        {f.fixed && <span className="mt-0.5 block normal-case tracking-normal text-[10px]">Stays the kept record&apos;s; the others point to it</span>}
                      </th>
                      {data.records.map((r) => {
                        const cell = r.cells[f.apiName];
                        const picked = f.fixed ? r.id === survivor : (picks[f.apiName] ?? survivor) === r.id;
                        const value = (cell?.value ?? null) as CellValue;
                        return (
                          <td key={r.id} className={cn("p-2 align-top", picked && "bg-primary/5")}>
                            <label className={cn("flex items-start gap-2", !f.fixed && "cursor-pointer")}>
                              {!f.fixed && (
                                <input
                                  type="radio" name={`pick-${f.apiName}`} checked={picked} onChange={() => setPicks((p) => ({ ...p, [f.apiName]: r.id }))}
                                  aria-label={`${f.label} from ${r.title}`} className="mt-1"
                                />
                              )}
                              <span>
                                <span className={cn("block break-words", !picked && "text-muted-foreground")}>{shown(f.apiName, value)}</span>
                                {cell?.sourceKind && value !== null && (
                                  <span className="block text-[10px] text-muted-foreground">from {SOURCE_LABEL[cell.sourceKind] ?? cell.sourceKind}{cell.at ? ` · ${new Date(cell.at).toLocaleDateString()}` : ""}</span>
                                )}
                              </span>
                            </label>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <button type="button" onClick={onClose} disabled={busy} className={btn}>Cancel</button>
          <button type="button" onClick={() => void confirm()} disabled={busy || !data} className={cn(btn, "border-primary bg-primary text-primary-foreground hover:bg-primary/90")}>
            <GitMerge className="h-3 w-3" /> {busy ? "Merging…" : `Merge into ${data?.records.find((r) => r.id === survivor)?.title ?? "the kept record"}`}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Merge with…" on a record page: find the duplicates of this record, then open the merge dialog with them. */
export function MergeWith({ object, id, title, onMerged, label = "Merge with…", disabled }: { object: PartyObject; id: string; title: string; onMerged: (survivorId: string) => void; label?: string; disabled?: boolean }) {
  const list = useAction(api.objects.list);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(title);
  const [found, setFound] = useState<Array<{ id: string; title: string; hint: string }>>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (!open || q.trim().length < 2) return;
    let current = true;
    const field = object === "account" ? "name" : "fullName";
    const timer = setTimeout(() => {
      list({ object, filter: [{ field, op: "contains", value: q.trim() }], limit: 10 })
        .then((page) => current && setFound(page.rows.filter((r) => r.id !== id).map((r) => ({
          id: r.id, title: r.title || r.id, hint: String(r.values[object === "account" ? "domain" : "email"] ?? ""),
        }))))
        .catch(() => current && setFound([]));
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, q, list, object, id]);

  if (merging) return <MergeDialog object={object} ids={[id, ...chosen]} onClose={() => setMerging(false)} onMerged={(s) => { setMerging(false); setOpen(false); onMerged(s); }} />;
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => { setOpen(true); setChosen([]); }} className={btn}><GitMerge className="h-3 w-3" /> {label}</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Merge {title} with…</DialogTitle>
            <DialogDescription>Find the duplicates of this {nouns(object, 1)}. Pick up to 8.</DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 border border-border px-2 py-1">
            <Search className="h-3 w-3 text-muted-foreground" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name" className="w-full bg-transparent text-sm outline-none" aria-label="Search by name" />
          </label>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {(q.trim().length >= 2 ? found : []).map((r) => (
              <li key={r.id}>
                <label className="flex cursor-pointer items-center gap-2 px-1 py-1 text-sm hover:bg-muted">
                  <input
                    type="checkbox" checked={chosen.includes(r.id)} disabled={!chosen.includes(r.id) && chosen.length >= 8}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, r.id] : c.filter((x) => x !== r.id)))}
                  />
                  <span>{r.title}</span>
                  {r.hint && <span className="text-xs text-muted-foreground">{r.hint}</span>}
                </label>
              </li>
            ))}
            {q.trim().length >= 2 && !found.length && <li className="text-sm text-muted-foreground">No other {nouns(object, 2)} match.</li>}
          </ul>
          <DialogFooter>
            <button type="button" disabled={!chosen.length} onClick={() => setMerging(true)} className={btn}>Compare {chosen.length + 1}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
