"use client";

import { useState } from "react";
import Link from "next/link";
import { useAction, useQuery } from "convex/react";
import { Archive } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { BULK_MAX, runBulk } from "../../../convex/lib/objects/views";
import { toast } from "@/lib/toast";
import { cn, getErrorMessage } from "@/lib/utils";

type RegisterObject = "account" | "contact";

const btn = "inline-flex items-center gap-1 border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50";
const noun = (object: RegisterObject, n: number) => (object === "account" ? (n === 1 ? "company" : "companies") : n === 1 ? "person" : "people");

/** Whether the caller may archive and restore records of `object` (admins and managers, as the generic list offers). */
export function useCanArchive(object: RegisterObject): boolean {
  return useQuery(api.objects.describe, { object })?.canDelete === true;
}

/**
 * Archive the selected companies or people: they leave lists, search, reports and agents, and come back from the
 * Archived view (the generic list's archive, /dashboard/records/<object>?bin=1) or the toast's Undo. A second click
 * confirms, as the generic list's bulk archive does.
 */
export function ArchiveSelected({ object, ids, onDone }: { object: RegisterObject; ids: readonly string[]; onDone: () => void }) {
  const bulk = useAction(api.records.bulkRegister);
  const canArchive = useCanArchive(object);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!canArchive || !ids.length) return null;

  async function run(op: "delete" | "restore", targets: readonly string[]) {
    setBusy(true);
    try {
      const batchKey = crypto.randomUUID();
      const out = await runBulk([...targets], BULK_MAX, (batch) => bulk({ object, op, ids: batch, batchKey }));
      const problems = [...out.failed.values(), ...[...out.results.values()].flatMap((r) => r.errors?.map((e) => e.message) ?? [])];
      const done = [...out.results].filter(([, r]) => !r.errors?.length).map(([id]) => id);
      const verb = op === "delete" ? "Archived" : "Restored";
      if (problems.length) void toast.error(`${verb} ${done.length} of ${targets.length}. ${[...new Set(problems)].slice(0, 3).join(" ")}`);
      else if (op === "delete") void toast.success(`Archived ${done.length} ${noun(object, done.length)}`, { action: { label: "Undo", onClick: () => void run("restore", done) } });
      else void toast.success(`Restored ${done.length} ${noun(object, done.length)}`);
      onDone();
    } catch (cause) {
      void toast.error(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (!confirming) return setConfirming(true);
        setConfirming(false);
        void run("delete", ids);
      }}
      onBlur={() => setConfirming(false)}
      className={cn(btn, confirming && "border-destructive text-destructive")}
    >
      <Archive className="h-3 w-3" /> {confirming ? `Confirm archive ${ids.length}` : `Archive ${ids.length}`}
    </button>
  );
}

/** A link to the archived companies or people, where each can be restored. */
export function ArchivedLink({ object }: { object: RegisterObject }) {
  if (!useCanArchive(object)) return null;
  return (
    <Link href={`/dashboard/records/${object}?bin=1`} className="view-action">
      <Archive className="h-3 w-3" /> Archived
    </Link>
  );
}
