"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SelectField } from "@/components/ui/select";
import { DropZone, Steps } from "@/components/records/csv-import";
import { getErrorMessage } from "@/lib/utils";
import { matchCsvColumns, readCsvFile, readCsvRows, unmatchedRequired, type CsvFile, type CsvMapping } from "@/lib/moduleCsvImport";
import type { CsvImportShape } from "../../../modules/kernel/csvImport";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const n = (x: number) => x.toLocaleString("en-US");
/** The problems the review step lists before "and N more". */
const PROBLEMS_SHOWN = 50;

type Progress = { done: number; total: number; error?: string; finished?: boolean };

/**
 * A module's CSV import (docs/modules.md, "CSV imports"): Canon's Upload → Match columns → Review → Import, the rows
 * sent to the import's call `batch` at a time. `run` runs the call with one batch of rows; each batch writes all or
 * nothing, and a batch that fails stops the import there.
 */
export function ModuleCsvImport({ shape, run, onClose, onImported }: {
  shape: CsvImportShape;
  run: (rows: Record<string, unknown>[]) => Promise<void>;
  onClose: () => void;
  onImported: (rows: number) => void;
}) {
  const [name, setName] = useState<string | null>(null);
  const [file, setFile] = useState<CsvFile | null>(null);
  const [mapping, setMapping] = useState<CsvMapping>({});
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const at = progress ? 4 : reviewing ? 3 : file ? 2 : 1;
  const missing = file ? unmatchedRequired(shape, mapping) : [];
  const read = file && reviewing ? readCsvRows(shape, file, mapping) : null;

  const take = (picked: File) => {
    setBusy(true); setError(null);
    picked.text().then((text) => {
      const got = readCsvFile(text);
      setName(picked.name); setFile(got); setMapping(matchCsvColumns(shape, got.header));
    }).catch((e) => setError(getErrorMessage(e))).finally(() => setBusy(false));
  };
  /** Imports from the row `from` on: 0 to start, or the first row of the batch that failed, to retry. */
  const start = async (from = 0) => {
    if (!read) return;
    const total = read.rows.length;
    setProgress({ done: from, total });
    for (let i = from; i < total; i += shape.batch) {
      try {
        await run(read.rows.slice(i, i + shape.batch));
      } catch (e) {
        setProgress({ done: i, total, error: `Rows from line ${read.lines[i]} weren't imported: ${getErrorMessage(e)}` });
        if (i > from) onImported(i - from);
        return;
      }
      setProgress({ done: Math.min(i + shape.batch, total), total });
    }
    setProgress({ done: total, total, finished: true });
    onImported(total - from);
  };
  const running = !!progress && !progress.finished && !progress.error;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !running) onClose(); }}>
      <DialogContent className="rounded-none sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{shape.label}</DialogTitle>
          <DialogDescription>Upload a CSV, match its columns, and review every row before anything is written.</DialogDescription>
        </DialogHeader>
        <Steps at={at} />
        <div className="grid max-h-[60vh] gap-3 overflow-y-auto text-sm">
          {at === 1 && <DropZone busy={busy} onFile={take} />}
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          {file && at < 4 && (
            <div className="flex items-center gap-2 border border-border px-2 py-1.5 text-xs">
              <FileText className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
              <span className="shrink-0 text-muted-foreground">{n(file.rows.length)} {file.rows.length === 1 ? "row" : "rows"} · {n(file.header.length)} columns</span>
              <button type="button" className="shrink-0 underline" onClick={() => { setFile(null); setReviewing(false); }}>Replace</button>
            </div>
          )}

          {at === 2 && file && (
            <>
              <table className="w-full text-xs">
                <thead className="text-left font-medium text-muted-foreground">
                  <tr><th className="py-1">Field</th><th className="py-1">Your column</th><th className="py-1">First value</th></tr>
                </thead>
                <tbody>
                  {shape.columns.map((c) => {
                    const i = mapping[c.field];
                    return (
                      <tr key={c.field} className="border-t border-border">
                        <td className="py-1 pr-2">{c.label}{c.required && <span className="ml-1 text-muted-foreground">(required)</span>}</td>
                        <td className="py-1 pr-2">
                          <SelectField aria-label={`Column for ${c.label}`} value={i === null || i === undefined ? "" : String(i)}
                            onValueChange={(v) => setMapping((cur) => ({ ...cur, [c.field]: v === "" ? null : Number(v) }))}
                            options={[{ value: "", label: c.required ? "Choose…" : "Don't import" }, ...file.header.map((h, k) => ({ value: String(k), label: h || `Column ${k + 1}` }))]} />
                        </td>
                        <td className="truncate py-1 text-muted-foreground">{i === null || i === undefined ? "" : file.rows[0]?.[i] ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {missing.length > 0 && <p role="alert" className="text-xs text-destructive">Match a column for {missing.map((c) => c.label).join(", ")}.</p>}
            </>
          )}

          {at === 3 && read && (
            <>
              <p>
                <span className="font-medium">{n(read.rows.length)} {read.rows.length === 1 ? "row" : "rows"} to import</span>
                {read.problems.length > 0 && <span className="text-muted-foreground"> · {n(read.problems.length)} skipped</span>}
              </p>
              {read.problems.length > 0 && (
                <ul className="grid gap-0.5 border border-border p-2 text-xs" aria-label="Rows that will be skipped">
                  {read.problems.slice(0, PROBLEMS_SHOWN).map((p) => <li key={p.line}>Line {p.line}: {p.message}</li>)}
                  {read.problems.length > PROBLEMS_SHOWN && <li className="text-muted-foreground">and {n(read.problems.length - PROBLEMS_SHOWN)} more</li>}
                </ul>
              )}
            </>
          )}

          {at === 4 && progress && (
            <div className="grid gap-2" aria-live="polite">
              <p>{progress.finished ? `Imported ${n(progress.total)} ${progress.total === 1 ? "row" : "rows"}.` : progress.error ? `Imported ${n(progress.done)} of ${n(progress.total)} rows.` : `Importing… ${n(progress.done)} of ${n(progress.total)} rows`}</p>
              <div className="h-1.5 w-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 100}%` }} /></div>
              {progress.error && <p role="alert" className="text-xs text-destructive">{progress.error}</p>}
            </div>
          )}
        </div>
        <DialogFooter>
          {at === 2 && <button type="button" className={btn} disabled={missing.length > 0} onClick={() => setReviewing(true)}>Review</button>}
          {at === 3 && <button type="button" className={btn} onClick={() => setReviewing(false)}>Back</button>}
          {at === 3 && read && <button type="button" className={btn} disabled={!read.rows.length} onClick={() => void start()}>Import {n(read.rows.length)} {read.rows.length === 1 ? "row" : "rows"}</button>}
          {progress?.error && read && <button type="button" className={btn} onClick={() => void start(progress.done)}>Retry from line {read.lines[progress.done]}</button>}
          {!running && <button type="button" className={btn} onClick={onClose}>{progress ? "Done" : "Cancel"}</button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
