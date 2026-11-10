"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Combine, Loader2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { COLUMN_OBJECTS } from "../../../convex/lib/consolidate";
import { EmptyState, LoadingRows } from "@/components/dashboard";
import { Panel } from "@/components/salesforce-sync/ui";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";
import { STATUS_LABEL, fieldsHref, pct, primary, statusText } from "./shared";

export type FieldStandardRow = FunctionReturnType<typeof api.fieldConsolidations.list>[number];

const TONE: Partial<Record<FieldStandardRow["status"]["state"], string>> = {
  readyToApply: "border-primary/50 bg-primary/10 text-primary",
  applied: "border-border bg-muted text-foreground",
  stopped: "border-destructive/40 bg-destructive/10 text-destructive",
  chooseStandard: "border-warning/40 bg-warning/15 text-warning",
};

/**
 * The workspace's Canon fields: each concept that lives in several columns across the connected CRMs (industry is the
 * usual one), the columns it writes, how full the first is and where its latest run stands. Starting one only reads
 * the connected CRMs.
 */
export function FieldStandardsList({ note }: { note?: (row: FieldStandardRow) => ReactNode }) {
  const list = useQuery(api.fieldConsolidations.list, {});
  const create = useMutation(api.fieldConsolidations.create);
  const router = useRouter();
  const [concept, setConcept] = useState("industry");
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const id = await create({ concept });
      router.push(fieldsHref(id));
    } catch (error) {
      toast.error(getErrorMessage(error));
      setBusy(false);
    }
  }

  return (
    <Panel title="Canon fields">
      <p className="mb-3 max-w-[72ch] text-sm text-muted-foreground">
        One concept, such as industry, often lives in several columns across HubSpot and Salesforce. A Canon field finds every column that holds it, keeps
        one value per company or person from the sources you trust, and writes it to the CRM columns you choose, in runs you preview and can undo.
      </p>
      {list === undefined ? (
        <LoadingRows count={3} />
      ) : list.length === 0 ? (
        <EmptyState icon={Combine} title="No Canon fields yet" description="Start with a concept below. Industry is a good first one." />
      ) : (
        <ul className="mb-4 divide-y divide-border border border-border">
          {list.map((row) => (
            <li key={row._id}>
              <Link
                href={fieldsHref(row._id)}
                className="grid grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-3 py-2.5 text-sm hover:bg-muted/50"
              >
                <span className="font-medium capitalize">{row.concept}</span>
                <span className="min-w-0 text-xs text-muted-foreground">
                  {row.destinations.length ? (
                    <>
                      Writes{" "}
                      {row.destinations.map((d, i) => (
                        <span key={`${d.object}.${d.name}`}>
                          {i > 0 && ", "}
                          <span className="text-foreground">{d.label}</span> ({COLUMN_OBJECTS[d.object].label})
                        </span>
                      ))}
                      {row.fill && ` · ${pct(row.fill.filled, row.fill.read)}% filled`}
                    </>
                  ) : (
                    "No destinations yet"
                  )}
                  {statusText(row.status).replace("…", "") !== STATUS_LABEL[row.status.state] && (
                    <span className="block truncate">{statusText(row.status, " · ")}</span>
                  )}
                  {note?.(row)}
                </span>
                <span className={cn("border px-2 py-0.5 text-xs font-medium", TONE[row.status.state] ?? "border-border text-muted-foreground")}>
                  {row.status.state === "readyToApply" && !row.status.writes ? "Nothing to apply" : STATUS_LABEL[row.status.state]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex max-w-xl flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (concept.trim()) void start();
        }}
      >
        <label className="grid flex-1 gap-1 text-xs text-muted-foreground">
          Concept
          <input
            value={concept}
            onChange={(event) => setConcept(event.target.value)}
            placeholder="industry"
            className="h-9 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
          />
        </label>
        <button type="submit" disabled={busy || !concept.trim()} className={primary}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Combine className="h-4 w-4" />}
          Find its columns
        </button>
      </form>
    </Panel>
  );
}
