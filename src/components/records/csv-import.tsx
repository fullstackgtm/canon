"use client";

import { useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Check, FileText, Upload } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { SelectField } from "@/components/ui/select";
import { parseCsv } from "../../../convex/lib/objects/csvImport";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";
const n = (x: number) => x.toLocaleString("en-US");
/** The rows whose values the mapping step shows beside each column. */
const SAMPLE_ROWS = 5;

type Preview = FunctionReturnType<typeof api.csvImports.preview>;

const MATCH_RULES: Record<string, string> = {
  account: "Companies match by domain.",
  contact: "People match by email. A Companies column (separated by ;) links a person to several companies, the first primary.",
  deal: "Deals match by name and company. A Contacts column (email:role, separated by ;) puts people on the deal; an Owner column (a member's email or name) sets who owns it. Amounts read as written: 48000, $48,000 or 48k (k, m and b).",
  activity: "Each row lands on the timelines of the company (domain or name), person (email) and deal (name or id) it names, with its own Date and Owner (member email or name).",
};
const RECORD_RULE = "Each row adds a record. Importing the same file again changes nothing.";
/** The columns an import of the object asks the file to map. A deal's stage sets its pipeline; its amount and close date make the pipeline's totals. */
const REQUIRED: Record<string, readonly string[]> = { deal: ["name", "amount", "closeDate", "stage"] };
/** What a deal row whose Owner names no member does: the importer owns it, the owner is added first, or it is skipped. */
type UnknownOwners = "mine" | "add" | "skip";

/** A file of the shape an import reads, to start from: its header and one row. */
const SAMPLES: Record<string, string> = {
  account: "Name,Domain,Industry,Employees\nAcme,acme.com,Software,120\n",
  contact: "Full name,Email,Title,Company\nJane Doe,jane@acme.com,VP Sales,acme.com\n",
  deal: "Deal name,Amount,Close date,Stage,Company,Owner,Contacts\nAcme expansion,25000,2026-12-15,Discovery,acme.com,rep@yourcompany.com,jane@acme.com:champion\n",
};
const sampleHref = (object: string) => `data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLES[object] ?? "")}`;

/** The dialog's steps, in order; the step it shows is derived from what it holds (no file, mapping, review, started). */
const STEPS = ["Upload", "Match columns", "Review", "Import"] as const;
/** The review step's choice that adds an unknown stage to the pipeline rather than mapping it to one. */
const ADD_STAGE = "__add_stage__";

/**
 * Import from a CSV: map the columns, see what each row will do, then run it in the background. `object` is a company,
 * person, deal, `activity` (a file of notes, tasks, calls and meetings; `kind` is the type of a row with no Type
 * cell), or any other object such as a lead or product.
 */
export function CsvImport({ object, label, kind, className = btn }: { object: string; label: string; kind?: string; className?: string }) {
  const upload = useMutation(api.csvImports.generateUploadUrl);
  const createMember = useMutation(api.users.createMember);
  const claim = useMutation(api.csvImports.claimUpload);
  const preview = useAction(api.csvImports.preview);
  const start = useAction(api.csvImports.start);
  // Once started, the dialog follows the import to its end and says what it did.
  const [jobId, setJobId] = useState<Id<"backgroundJobs"> | null>(null);
  const job = useQuery(api.csvImports.job, jobId ? { jobId } : "skip");
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<{ name: string; storageId: Id<"_storage"> } | null>(null);
  const [result, setResult] = useState<Preview | null>(null);
  // The first values of each column, read from the file here, so a mapping can be checked against what it holds.
  const [samples, setSamples] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [createCompanies, setCreateCompanies] = useState(false);
  const [allowUntargeted, setAllowUntargeted] = useState(false);
  const [unknownOwners, setUnknownOwners] = useState<UnknownOwners>("mine");
  const [previewed, setPreviewed] = useState({ create: false, untargeted: false, skip: false });
  const skipUnknownOwners = unknownOwners === "skip";
  const [busy, setBusy] = useState(false);
  /** Mapping and review are separate steps once a file is read; a started import is the last step. */
  const [step, setStep] = useState<"map" | "review">("map");
  const at = jobId ? 4 : !file || !result ? 1 : step === "map" ? 2 : 3;
  // Deal stages no pipeline has: the review step maps each to a stage (stageMap, by lower-cased cell) or adds it.
  const pipelines = useQuery(api.pipelines.list, object === "deal" ? {} : "skip");
  const savePipeline = useMutation(api.pipelines.save);
  const [stageMap, setStageMap] = useState<Record<string, string>>({});
  const [stageChoice, setStageChoice] = useState<Record<string, string>>({});
  const stale = result !== null && (mapping.some((m, i) => m !== result.mapping[i]) || createCompanies !== previewed.create || allowUntargeted !== previewed.untargeted || skipUnknownOwners !== previewed.skip);
  const missing = (REQUIRED[object] ?? []).filter((f) => !mapping.includes(f)).map((f) => result?.fields.find((x) => x.apiName === f)?.label ?? f);
  // The first rows as the mapping reads them: one column per mapped field.
  const mapped = mapping.flatMap((m, i) => (m ? [{ i, label: result?.fields.find((f) => f.apiName === m)?.label ?? m }] : []));
  const isActivity = object === "activity";
  const companyMapped = !isActivity && (mapping.includes("company") || mapping.includes("companies"));

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  const choose = (picked: File) => run(async () => {
    const res = await fetch(await upload(), { method: "POST", headers: { "Content-Type": picked.type || "text/csv" }, body: picked });
    const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await picked.arrayBuffer()));
    await claim({ storageId, sha256: btoa(String.fromCharCode(...digest)) });
    const next = await preview({ object, storageId, createCompanies, allowUntargeted, skipUnknownOwners, ...(kind ? { kind } : {}) });
    // The head of the file is enough for its first rows; a cut last line is never one of them.
    setSamples(parseCsv((await picked.slice(0, 65536).text())).slice(1, 1 + SAMPLE_ROWS));
    setFile({ name: picked.name, storageId });
    setResult(next);
    setPreviewed({ create: createCompanies, untargeted: allowUntargeted, skip: skipUnknownOwners });
    setMapping([...next.mapping]);
    setStep("map");
  });

  const close = () => {
    setOpen(false);
    setFile(null);
    setResult(null);
    setSamples([]);
    setCreateCompanies(false);
    setAllowUntargeted(false);
    setUnknownOwners("mine");
    setJobId(null);
    setStep("map");
    setStageMap({});
    setStageChoice({});
  };

  /** Back to the drop zone with nothing read, to pick another file. */
  const replace = () => {
    setFile(null);
    setResult(null);
    setSamples([]);
    setMapping([]);
    setStep("map");
    setStageMap({});
    setStageChoice({});
  };

  const refresh = async (stages: Record<string, string> = stageMap) => {
    if (!file) return;
    const next = await preview({ object, storageId: file.storageId, mapping, createCompanies, allowUntargeted, skipUnknownOwners, stageMap: stages, ...(kind ? { kind } : {}) });
    setResult(next);
    setPreviewed({ create: createCompanies, untargeted: allowUntargeted, skip: skipUnknownOwners });
  };

  // The pipeline new stages go into: the default one, as a deal with no Pipeline cell imports into it.
  const target = pipelines?.find((p) => p.isDefault) ?? pipelines?.[0];
  const stageOptions = (target?.stages ?? []).filter((st) => st.active).map((st) => ({ value: st.label, label: st.label }));
  const applyStages = () => void run(async () => {
    const chosen = Object.entries(stageChoice).filter(([, v]) => v);
    const added = chosen.filter(([, v]) => v === ADD_STAGE).map(([k]) => k);
    if (added.length && target) {
      // New stages go before the first closed one, so they read as open stages of the pipeline.
      const stages: { value: string | null; label: string; probability: number; forecastCategory: (typeof target.stages)[number]["forecastCategory"] }[] = target.stages.map((st) => ({ value: st.value, label: st.label, probability: st.probability, forecastCategory: st.forecastCategory }));
      const closedAt = stages.findIndex((st) => st.forecastCategory === "closed_won" || st.forecastCategory === "closed_lost");
      const at = closedAt < 0 ? stages.length : closedAt;
      const probability = at > 0 ? stages[at - 1].probability : 10;
      stages.splice(at, 0, ...added.map((label) => ({ value: null, label, probability, forecastCategory: "pipeline" as const })));
      try {
        await savePipeline({ pipelineId: target.id === null ? "default" : (target.id as Id<"dealPipelines">), name: target.name, stages });
      } catch (cause) {
        throw new Error(`${getErrorMessage(cause)}. Map the stage to one you have instead.`);
      }
      void toast.success(`Added ${added.join(", ")} to ${target.name}`);
    }
    const next = { ...stageMap, ...Object.fromEntries(chosen.filter(([, v]) => v !== ADD_STAGE).map(([k, v]) => [k.toLowerCase(), v])) };
    setStageMap(next);
    setStageChoice({});
    await refresh(next);
  });
  const rows = result ? result.counts.create + result.counts.update + result.counts.skip + result.counts.error : 0;
  // With "add as team members", the preview's "no member has … you will own the deal" warnings no longer hold: those
  // owners become members before the rows are written, as the Owner line says.
  // Only an owner named by email can be added as a member; one named by a name no member has stays a warning.
  const ownerWarning = (m: string) => /^No active member is \S+@\S+;/.test(m);
  const problems = result ? result.problems.filter((p) => !(unknownOwners === "add" && p.kind === "warn" && ownerWarning(p.message)) && !(p.kind === "error" && p.message.startsWith("No stage named "))) : [];
  const done = job?.status === "completed";
  const pct = job?.total ? Math.min(100, Math.round(((job.done ?? 0) / job.total) * 100)) : null;

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}><Upload className="h-3 w-3" /> Import CSV</button>
      <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle>Import {label}</DialogTitle>
            <DialogDescription>{MATCH_RULES[object] ?? RECORD_RULE} Empty cells never clear a value.</DialogDescription>
          </DialogHeader>
          <Steps at={at} />

          {at === 1 && (
            <div className="space-y-2">
              <DropZone busy={busy} onFile={(picked) => void choose(picked)} />
              {SAMPLES[object] && <a className="text-xs underline" href={sampleHref(object)} download={`${object}-sample.csv`}>Download a sample CSV</a>}
            </div>
          )}

          {(at === 2 || at === 3) && file && result && (
            <div className="flex items-center gap-2 border border-border px-3 py-2 text-xs">
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{file.name}</span>
              <span className="shrink-0 text-muted-foreground">{n(rows)} {rows === 1 ? "row" : "rows"} · {n(result.header.length)} columns</span>
              <button type="button" className="shrink-0 underline" disabled={busy} onClick={replace}>Replace</button>
            </div>
          )}

          {at === 2 && result && (
            <>
              <table className="w-full text-xs">
                <thead className="text-left text-xs font-medium text-muted-foreground">
                  <tr><th className="py-1">Column</th><th className="py-1">First values</th><th className="py-1">Field</th></tr>
                </thead>
                <tbody>
                  {result.header.map((h, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="py-1 pr-2">{h || `Column ${i + 1}`}</td>
                      <td className="max-w-48 truncate py-1 pr-2 font-mono text-muted-foreground" title={samples.map((r) => r[i] ?? "").join("\n")}>
                        {samples.map((r) => r[i] ?? "").filter(Boolean).join(" · ") || "Empty"}
                      </td>
                      <td className="py-1">
                        <SelectField
                          aria-label={`Field for ${h}`}
                          value={mapping[i] ?? ""}
                          onValueChange={(v) => setMapping((cur) => cur.map((m, j) => (j === i ? v || null : m)))}
                          options={[{ value: "", label: "Skip" }, ...result.fields.map((f) => ({ value: f.apiName, label: f.label }))]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {missing.length > 0 && (
                <p role="alert" className="border-l-2 border-destructive bg-destructive/5 px-2 py-1 text-xs">
                  Missing required mappings: {missing.join(", ")}. Map them so new deals carry them; rows that match an existing deal by name still update it.
                </p>
              )}
              {mapped.length > 0 && samples.length > 0 && (
                <div className="min-w-0 max-w-full overflow-x-auto border border-border">
                  <table className="w-full text-xs" aria-label="First rows">
                    <caption className="px-2 py-1 text-left text-muted-foreground">The first {samples.length} {samples.length === 1 ? "row" : "rows"}, as mapped</caption>
                    <thead className="bg-muted/50 text-left text-muted-foreground"><tr>{mapped.map((c) => <th key={c.i} className="whitespace-nowrap px-2 py-1 font-medium">{c.label}</th>)}</tr></thead>
                    <tbody>
                      {samples.map((r, j) => (
                        <tr key={j} className="border-t border-border">{mapped.map((c) => <td key={c.i} className="max-w-40 truncate px-2 py-1 font-mono">{r[c.i] || <span className="text-muted-foreground">—</span>}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {companyMapped && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={createCompanies} onChange={(e) => setCreateCompanies(e.target.checked)} />
                  Create companies that match none
                </label>
              )}
              {object === "deal" && mapping.includes("owner") && (result.owners.unknown.length > 0 || unknownOwners !== "mine") && (
                <fieldset className="grid gap-1 text-xs">
                  <legend className="mb-1 font-medium">Owners no member has{result.owners.unknown.length ? `: ${result.owners.unknown.slice(0, 3).join(", ")}${result.owners.unknown.length > 3 ? ` and ${n(result.owners.unknown.length - 3)} more` : ""}` : ""}</legend>
                  {([["mine", "Import their deals, owned by you"], ["add", "Add as team members (no login), then import"], ["skip", "Skip their deals"]] as const).map(([v, text]) => (
                    <label key={v} className="flex items-center gap-2">
                      <input type="radio" name="unknown-owners" checked={unknownOwners === v} onChange={() => setUnknownOwners(v)} />{text}
                    </label>
                  ))}
                </fieldset>
              )}
              {isActivity && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={allowUntargeted} onChange={(e) => setAllowUntargeted(e.target.checked)} />
                  Import rows that match no company, person or deal (they will not appear on a timeline)
                </label>
              )}
            </>
          )}

          {at === 3 && result && (
            <div className="flex flex-col gap-2">
              {object === "deal" && result.unknownStages.length > 0 && (
                <div className="space-y-2 border border-border p-3 text-xs">
                  <p className="font-medium">Stages your pipeline doesn't have</p>
                  <p className="text-muted-foreground">Rows with these stages can't import yet. Map each one to a stage you have, or add it to {target?.name ?? "your pipeline"}.</p>
                  {result.unknownStages.map((u) => (
                    <div key={u.value} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-28 font-medium">{u.value}</span>
                      <span className="text-muted-foreground">{n(u.rows)} {u.rows === 1 ? "row" : "rows"}</span>
                      <SelectField
                        aria-label={`Stage for ${u.value}`}
                        value={stageChoice[u.value] ?? ""}
                        onValueChange={(v) => setStageChoice((c) => ({ ...c, [u.value]: v }))}
                        options={[{ value: "", label: "Choose…" }, { value: ADD_STAGE, label: `Add "${u.value}" as a new stage` }, ...stageOptions.map((o) => ({ value: o.value, label: `Map to ${o.label}` }))]}
                      />
                    </div>
                  ))}
                  <button type="button" className={btn} disabled={busy || !Object.values(stageChoice).some(Boolean)} onClick={applyStages}>{busy ? "Updating…" : "Apply"}</button>
                </div>
              )}
              <div className="grid grid-cols-4 gap-2 font-mono text-xs">
                {(["create", "update", "skip", "error"] as const).map((k) => (
                  <div key={k} className={cn("border border-border px-2 py-1", k === "error" && result.counts.error > 0 && "border-destructive text-destructive")}>
                    <div className="text-xs font-medium text-muted-foreground">{{ create: "Create", update: "Update", skip: "Skip", error: "Fail" }[k]}</div>
                    <div className="text-base">{n(result.counts[k])}</div>
                  </div>
                ))}
              </div>
              {companyMapped && (
                <p className="font-mono text-xs text-muted-foreground">
                  Company: {n(result.companies.linked)} linked · {n(result.companies.created)} new · {n(result.companies.unmatched + result.companies.ambiguous)} unmatched
                </p>
              )}
              {mapping.includes("owner") && (
                <p className={cn("font-mono text-xs text-muted-foreground", result.owners.unknown.length > 0 && unknownOwners !== "add" && "text-destructive")}>
                  Owner: {n(result.owners.matched)} matched{result.owners.unknown.length > 0 ? ` · no member has ${result.owners.unknown.slice(0, 5).join(", ")}${result.owners.unknown.length > 5 ? ` and ${n(result.owners.unknown.length - 5)} more` : ""}${unknownOwners === "add" ? " (added as team members when you import)" : ""}` : ""}
                </p>
              )}
              {isActivity && (
                <p className="font-mono text-xs text-muted-foreground">
                  Targets: {n(result.targets.matched)} matched · {n(result.targets.unmatched)} unmatched
                </p>
              )}
              {problems.length > 0 && (
                <ul className="max-h-48 overflow-y-auto border border-border text-xs">
                  {problems.map((p, i) => (
                    <li key={i} className="border-t border-border px-2 py-1 first:border-t-0">
                      <span className="font-mono">Row {p.row}</span> <span className={p.kind === "error" ? "text-destructive" : "text-muted-foreground"}>{p.kind === "warn" ? "Imports without this link: " : ""}{p.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {at === 4 && (
            <div role="status" className="space-y-3 text-sm">
              {job === undefined || job === null || job.status === "pending" || job.status === "processing" ? (
                <>
                  <p>Importing{job?.total ? ` ${n(job.done ?? 0)} of ${n(job.total)} rows` : ""}… You can close this; progress stays in the activity tray.</p>
                  <div className="h-1.5 bg-muted" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
                    <div className={cn("h-full bg-primary transition-[width]", pct === null && "w-1/3 animate-pulse")} style={pct === null ? undefined : { width: `${pct}%` }} />
                  </div>
                </>
              ) : job.status === "failed" ? (
                <p className="text-destructive">The import stopped: {job.error ?? job.detail}</p>
              ) : (
                <>
                  <p className="flex items-center gap-2 font-medium"><Check className="size-4 text-primary" aria-hidden /> Import done</p>
                  <p className="font-mono text-xs text-muted-foreground">{job.detail}</p>
                </>
              )}
            </div>
          )}

          <DialogFooter>
            {at === 4 ? (
              <>
                <button type="button" onClick={close} className={btn}>{done ? "Done" : "Close"}</button>
              </>
            ) : (
              <>
                {at === 3 ? <button type="button" disabled={busy} onClick={() => setStep("map")} className={btn}>Back</button> : <button type="button" onClick={close} className={btn}>Cancel</button>}
                {at === 2 && (
                  <button
                    type="button"
                    disabled={busy}
                    className={cn(btn, "bg-primary text-primary-foreground hover:bg-primary/85")}
                    onClick={() => void run(async () => {
                      if (stale) await refresh();
                      setStep("review");
                    })}
                  >
                    {busy ? "Checking rows…" : "Next: review"}
                  </button>
                )}
                {at === 3 && result && (
                  <button
                    type="button"
                    disabled={busy || result.counts.create + result.counts.update === 0}
                    className={cn(btn, "bg-primary text-primary-foreground hover:bg-primary/85")}
                    onClick={() => void run(async () => {
                      // Each unknown owner becomes a member with no login, named from their email, so their deals import as theirs.
                      if (unknownOwners === "add") {
                        const all = result.owners.unknown.filter((owner) => owner.includes("@"));
                        for (const email of all) {
                          const name = email.split("@")[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
                          await createMember({ name: name || email, email });
                        }
                        if (all.length) void toast.success(`Added ${n(all.length)} team ${all.length === 1 ? "member" : "members"} with no login`);
                      }
                      const started = await start({ object, storageId: file!.storageId, mapping, createCompanies, allowUntargeted, skipUnknownOwners, stageMap, ...(kind ? { kind } : {}) });
                      setJobId(started.jobId);
                    })}
                  >
                    {busy ? "Working…" : `Import ${n(result.counts.create + result.counts.update)} ${result.counts.create + result.counts.update === 1 ? "row" : "rows"}`}
                  </button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Where the dialog is: done steps checked, the current one filled, the rest outlined. */
export function Steps({ at, labels = STEPS }: { at: number; labels?: readonly string[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-label="Import steps">
      {labels.map((label, i) => {
        const k = i + 1;
        return (
          <li key={label} aria-current={k === at ? "step" : undefined} className={cn("flex items-center gap-1.5", k === at ? "font-medium text-foreground" : k < at ? "text-foreground/70" : "text-muted-foreground")}>
            <span className={cn("inline-flex size-5 items-center justify-center rounded-full border text-[11px]", k === at ? "border-primary bg-primary text-primary-foreground" : k < at ? "border-primary text-primary" : "border-border")}>
              {k < at ? <Check className="size-3" aria-hidden /> : k}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

/** The file step: drop a CSV on it or click (or press Enter) to browse. Anything that isn't a CSV is refused here. */
export function DropZone({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const take = (picked: File | null | undefined) => {
    if (!picked) return;
    if (!/\.csv$/i.test(picked.name) && picked.type !== "text/csv") {
      void toast.error(`${picked.name} isn't a CSV file. Save it as .csv and try again.`);
      return;
    }
    onFile(picked);
  };
  const browse = () => { if (!busy) input.current?.click(); };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={busy}
      aria-label="Drop a CSV file here, or press Enter to choose one"
      onClick={browse}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); browse(); } }}
      onDragOver={(e) => { e.preventDefault(); if (!busy) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) take(e.dataTransfer.files?.[0]); }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed px-6 py-10 text-center text-sm outline-none transition-colors focus-visible:border-primary",
        over ? "border-primary bg-primary/5" : "border-border hover:border-foreground/30",
        busy && "cursor-wait opacity-70",
      )}
    >
      <Upload className="size-5 text-muted-foreground" aria-hidden />
      <span className="font-medium">{busy ? "Reading your file…" : over ? "Drop to upload" : "Drop a CSV here, or click to browse"}</span>
      <span className="text-xs text-muted-foreground">CSV files only. You'll match columns and review every row before anything is written.</span>
      <input ref={input} type="file" accept=".csv,text/csv" aria-label="CSV file" className="sr-only" tabIndex={-1} disabled={busy}
        onChange={(e) => { take(e.target.files?.[0]); e.target.value = ""; }} />
    </div>
  );
}
