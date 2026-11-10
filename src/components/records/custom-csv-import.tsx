"use client";

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Upload } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { planCustomCsv } from "../../../convex/lib/objects/customCsv";
import { toast } from "@/lib/toast";
import { getErrorMessage } from "@/lib/utils";
import type { ObjectDescription } from "./fields";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
/** Rows per call (convex/objects.ts CREATE_MANY_MAX). */
const BATCH = 25;

/**
 * Import records of a custom object from a CSV: columns match fields by name, every row is checked as a form save is, and the
 * rows that fail are listed by row number. Rows go in calls of 25, one after another.
 */
export function CustomCsvImport({ desc, className = btn }: { desc: ObjectDescription; className?: string }) {
  const createMany = useMutation(api.objects.createMany);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);

  async function run(file: File) {
    setBusy(true);
    setFailed([]);
    try {
      const plan = planCustomCsv(desc.fields as never, await file.text());
      if (!plan.mapped.length) throw new Error(`No column matches a ${desc.label.toLowerCase()} field. Name the columns as the fields are named.`);
      let created = 0;
      const problems: string[] = [];
      for (let i = 0; i < plan.rows.length; i += BATCH) {
        const batch = plan.rows.slice(i, i + BATCH);
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
