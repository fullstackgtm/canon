"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction, useMutation } from "convex/react";
import { Download, Send } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ViewFilter } from "../../../modules/kernel/reportValidators";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";

const btn = "inline-flex items-center gap-1 border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";

/** Hands a CSV to the browser as a file. */
export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

type EditingAudience = { _id: Id<"audiences">; name: string };

/** The contacts list's outbound buttons: export what the filters match, save it as an audience, or save it back to the audience being edited. */
export function ContactAudienceActions({ filter, viewId, audience, onDoneEditing }: { filter: ViewFilter[]; viewId?: Id<"savedViews">; audience: EditingAudience | null; onDoneEditing: () => void }) {
  const exportCsv = useAction(api.audienceActions.exportViewCsv);
  const create = useMutation(api.audiences.create);
  const update = useMutation(api.audiences.update);
  const router = useRouter();
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <>
      <button
        type="button"
        disabled={busy}
        className={btn}
        onClick={() => void run(async () => {
          const { csv, count } = await exportCsv({ filter });
          downloadCsv("contacts.csv", csv);
          void toast.success(`Exported ${count} contacts`);
        })}
      >
        <Download className="h-3 w-3" /> Export CSV
      </button>
      {audience && (
        <>
          <button
            type="button"
            disabled={busy}
            className={cn(btn, "bg-primary text-primary-foreground hover:bg-primary/85")}
            onClick={() => void run(async () => {
              await update({ audienceId: audience._id, filter });
              void toast.success(`Updated ${audience.name}`);
              router.push(`/dashboard/audiences?audience=${audience._id}`);
            })}
          >
            <Send className="h-3 w-3" /> Update {audience.name}
          </button>
          <button type="button" onClick={onDoneEditing} className="text-xs text-muted-foreground hover:text-foreground">Stop editing</button>
        </>
      )}
      {audience ? null : name === null ? (
        <button type="button" className={btn} onClick={() => setName("")}><Send className="h-3 w-3" /> Save as audience</button>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await create({ name, filter, ...(viewId ? { viewId } : {}) });
              setName(null);
              void toast.success("Audience saved. Export or push it from Audiences.");
            });
          }}
        >
          <input autoFocus aria-label="Audience name" placeholder="Audience name" value={name} onChange={(e) => setName(e.target.value)} className="border border-border bg-background px-2 py-1 text-xs" />
          <button type="submit" disabled={busy || !name.trim()} className={btn}>Save</button>
          <button type="button" onClick={() => setName(null)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
          <Link href="/dashboard/audiences" className="text-xs text-muted-foreground hover:text-foreground">Audiences</Link>
        </form>
      )}
    </>
  );
}
