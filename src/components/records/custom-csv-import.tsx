"use client";

import { useRef, useState } from "react";
import { useAction, useMutation, useQuery, type ReactAction } from "convex/react";
import { Upload } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { customCsvLookups, planCustomCsv, resolveCustomCsv, type CsvTargets } from "../../../convex/lib/objects/customCsv";
import { IN_VALUES_MAX, LIST_LIMIT_MAX } from "../../../convex/lib/objects/listSpec";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import type { ObjectDescription } from "./fields";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
/** Rows per call (convex/objects.ts CREATE_MANY_MAX). */
const BATCH = 25;
/** Ids or titles per lookup read. */
const LOOKUP_BATCH = Math.min(IN_VALUES_MAX, LIST_LIMIT_MAX);

type List = ReactAction<typeof api.objects.list>;

/** The records of `object` that a file's lookup cells name, as the importer sees them: by id, and by exact title. */
async function readTargets(list: List, object: string, want: { ids: Set<string>; titles: Set<string> }): Promise<CsvTargets> {
  const ids = new Set<string>();
  const titles = new Map<string, string[]>();
  const read = async (field: "id" | "recordTitle", values: string[]) => {
    for (let i = 0; i < values.length; i += LOOKUP_BATCH) {
      let cursor: string | undefined;
      do {
        const page = await list({ object: object as never, filter: [{ field, op: "in", value: values.slice(i, i + LOOKUP_BATCH) }], limit: LIST_LIMIT_MAX, ...(cursor ? { cursor } : {}) });
        for (const r of page.rows) {
          ids.add(r.id);
          if (field === "recordTitle") titles.set(r.title, [...new Set([...(titles.get(r.title) ?? []), r.id])]);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
  };
  await read("id", [...want.ids]);
  await read("recordTitle", [...want.titles]);
  return { ids, titles };
}

/**
 * Import records of a custom object from a CSV: columns match fields by name, owners and lookups resolve to the members and
 * records they name, every row is checked as a form save is, and the rows that fail are listed by row number. Rows go in
 * calls of 25, one after another.
 */
export function CustomCsvImport({ desc, className = btn }: { desc: ObjectDescription; className?: string }) {
  const createMany = useMutation(api.objects.createMany);
  const list = useAction(api.objects.list);
  const team = useQuery(api.users.list);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);

  async function run(file: File) {
    setBusy(true);
    setFailed([]);
    try {
      const plan = planCustomCsv(desc.fields as never, await file.text());
      if (!plan.mapped.length) throw new Error(`No column matches a ${desc.label.toLowerCase()} field. Name the columns as the fields are named.`);
      if (!team) throw new Error("The workspace's members are still loading; try again in a moment");
      const targets = new Map<string, CsvTargets>();
      for (const [object, want] of customCsvLookups(plan)) targets.set(object, await readTargets(list, object, want));
      const members = team.map((u) => ({ id: u._id, name: u.name, email: u.email, active: u.isActive !== false }));
      const resolved = resolveCustomCsv(plan, members, targets);
      let created = 0;
      const problems: string[] = resolved.problems.map((p) => `Row ${p.row}: ${p.message}`);
      for (let i = 0; i < resolved.rows.length; i += BATCH) {
        const batch = resolved.rows.slice(i, i + BATCH);
        const results = await createMany({ object: desc.apiName, rows: batch.map((r) => r.values) });
        results.forEach((r, j) => {
          if (r.status === "invalid") problems.push(`Row ${batch[j].row}: ${r.errors.map((e) => e.message).join("; ")}`);
          else created += 1;
        });
      }
      setFailed(problems);
      const ignored = plan.ignored.length ? ` Ignored columns: ${plan.ignored.join(", ")}.` : "";
      void toast[problems.length ? "info" : "success"](`Imported ${created} of ${plan.rows.length} ${desc.pluralLabel.toLowerCase()}.${ignored}`);
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <>
      <input ref={input} type="file" accept=".csv,text/csv" aria-label="CSV file" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(f); }} />
      <button type="button" disabled={busy} className={className} onClick={() => input.current?.click()}><Upload className="h-3 w-3" /> Import CSV</button>
      {failed.length > 0 && (
        <div role="alert" className="basis-full border border-border bg-card p-2 text-xs text-destructive">
          {failed.slice(0, 10).map((p) => <div key={p}>{p}</div>)}
          {failed.length > 10 && <div>and {failed.length - 10} more</div>}
        </div>
      )}
    </>
  );
}
